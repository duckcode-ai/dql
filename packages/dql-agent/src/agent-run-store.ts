/**
 * SQLite-backed agent-run persistence (P0, REL-002 follow-through).
 *
 * The legacy FileAgentRunStore kept every run in ONE pretty-printed JSON file
 * and rewrote the whole file on every save — with ~1 MB per run (full events,
 * evidence, and result payloads) a real project reached 123 MB and each answer
 * paid two full-file rewrites. This store keeps one row per run, enforces
 * retention on write, and compacts old runs' event streams so the recent runs
 * a user actually reopens stay complete while history stops growing unbounded.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentRun, AgentRunStore } from './agent-run-engine.js';

export interface SqliteAgentRunStoreOptions {
  /** Path of the .sqlite file (created on first use). */
  path: string;
  /** Legacy agent-runs.json to import once and rename to *.migrated. */
  legacyJsonPath?: string;
  /** Maximum retained runs (oldest pruned on write). Env DQL_AGENT_RUN_RETENTION overrides. */
  maxRuns?: number;
  /** Newest N runs keep their full event stream; older runs are compacted. */
  fullPayloadRuns?: number;
}

const DEFAULT_MAX_RUNS = 300;
const DEFAULT_FULL_PAYLOAD_RUNS = 50;

export function resolveAgentRunRetention(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.DQL_AGENT_RUN_RETENTION);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MAX_RUNS;
  return Math.max(20, Math.min(5_000, Math.floor(configured)));
}

export class SqliteAgentRunStore implements AgentRunStore {
  private readonly db: Database.Database;
  private readonly maxRuns: number;
  private readonly fullPayloadRuns: number;

  constructor(options: SqliteAgentRunStoreOptions) {
    mkdirSync(dirname(options.path), { recursive: true });
    this.db = new Database(options.path);
    this.db.pragma('journal_mode = WAL');
    this.maxRuns = options.maxRuns ?? resolveAgentRunRetention();
    this.fullPayloadRuns = Math.max(1, options.fullPayloadRuns ?? DEFAULT_FULL_PAYLOAD_RUNS);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        route TEXT NOT NULL,
        status TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        compacted INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC);
    `);
    if (options.legacyJsonPath) this.migrateLegacyJson(options.legacyJsonPath);
  }

  save(run: AgentRun): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_runs (id, question, route, status, started_at, completed_at, compacted, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        question = excluded.question,
        route = excluded.route,
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        compacted = 0,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      run.id,
      run.question,
      run.route,
      (run as { status?: string }).status ?? null,
      run.startedAt,
      (run as { completedAt?: string }).completedAt ?? null,
      JSON.stringify(run),
      now,
    );
    this.enforceRetention();
    this.compactOldRuns();
  }

  get(id: string): AgentRun | undefined {
    const row = this.db.prepare('SELECT payload_json FROM agent_runs WHERE id = ?').get(id) as { payload_json: string } | undefined;
    return row ? parseRun(row.payload_json) : undefined;
  }

  list(): AgentRun[] {
    const rows = this.db.prepare('SELECT payload_json FROM agent_runs ORDER BY started_at DESC').all() as Array<{ payload_json: string }>;
    return rows.flatMap((row) => {
      const run = parseRun(row.payload_json);
      return run ? [run] : [];
    });
  }

  close(): void {
    this.db.close();
  }

  private enforceRetention(): void {
    this.db.prepare(`
      DELETE FROM agent_runs WHERE id NOT IN (
        SELECT id FROM agent_runs ORDER BY started_at DESC LIMIT ?
      )
    `).run(this.maxRuns);
  }

  /**
   * Strip the verbose event stream (progress narration) from runs that fell out
   * of the recent window. Artifacts, evaluations, and answers stay intact so
   * old runs still render their results — they just lose the step-by-step log.
   */
  private compactOldRuns(): void {
    const stale = this.db.prepare(`
      SELECT id, payload_json FROM agent_runs
      WHERE compacted = 0 AND id NOT IN (
        SELECT id FROM agent_runs ORDER BY started_at DESC LIMIT ?
      )
    `).all(this.fullPayloadRuns) as Array<{ id: string; payload_json: string }>;
    if (stale.length === 0) return;
    const update = this.db.prepare('UPDATE agent_runs SET payload_json = ?, compacted = 1 WHERE id = ?');
    for (const row of stale) {
      const run = parseRun(row.payload_json);
      if (!run) {
        update.run(row.payload_json, row.id);
        continue;
      }
      update.run(JSON.stringify({ ...run, events: [] }), row.id);
    }
  }

  /** One-time import of the legacy JSON store; the file is renamed to *.migrated as a backup. */
  private migrateLegacyJson(legacyJsonPath: string): void {
    if (!existsSync(legacyJsonPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(legacyJsonPath, 'utf-8')) as { runs?: unknown };
      const runs = Array.isArray(parsed.runs) ? parsed.runs.filter(isAgentRunRecord) : [];
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO agent_runs (id, question, route, status, started_at, completed_at, compacted, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      `);
      const now = new Date().toISOString();
      const importAll = this.db.transaction((records: AgentRun[]) => {
        for (const run of records) {
          insert.run(
            run.id,
            run.question,
            run.route,
            (run as { status?: string }).status ?? null,
            run.startedAt,
            (run as { completedAt?: string }).completedAt ?? null,
            JSON.stringify(run),
            now,
          );
        }
      });
      importAll(runs);
      this.enforceRetention();
      this.compactOldRuns();
    } catch {
      // A corrupt legacy file must not block the new store; keep it for forensics.
    }
    try {
      renameSync(legacyJsonPath, `${legacyJsonPath}.migrated`);
    } catch {
      // Rename is best-effort (e.g. another process holds the file on Windows).
    }
  }
}

export function defaultAgentRunSqlitePath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'local', 'agent-runs.sqlite');
}

function parseRun(payload: string): AgentRun | undefined {
  try {
    const value = JSON.parse(payload) as unknown;
    return isAgentRunRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isAgentRunRecord(value: unknown): value is AgentRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.question === 'string'
    && typeof record.route === 'string'
    && Array.isArray(record.events)
    && Array.isArray(record.artifacts)
    && Array.isArray(record.evaluations);
}
