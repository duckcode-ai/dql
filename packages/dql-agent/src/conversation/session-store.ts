/**
 * Server-side conversation session store: threads + ordered turns, persisted in
 * `.dql/cache/agent-conversations.sqlite` so multi-turn context survives page
 * refreshes and process restarts.
 *
 * This is the SESSION layer — auto-captured, compactable, per-thread. It is
 * strictly separate from the governed durable memory (`MemoryStore`): raw chat
 * is never a correctness signal and never enters `agent_memory` except through
 * an explicit promotion action. Modeled on `memory/sqlite-memory.ts`
 * (better-sqlite3, WAL, FTS5 porter).
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { sanitizeFtsQuery } from '../memory/fts-query.js';
import type { AgentDqlArtifactReference } from '../answer-loop.js';
import type { CascadeAnswerResult } from '../cascade/cascade.js';

const require = createRequire(import.meta.url);
let databaseCtor: typeof Database | null = null;

function loadDatabase(): typeof Database {
  databaseCtor ??= require('better-sqlite3') as typeof Database;
  return databaseCtor;
}

/** Caps applied at write time so stored turns stay bounded (mirrors the in-request caps). */
const MAX_SAMPLE_ROWS = 8;
const MAX_COLUMNS = 24;
const MAX_DIMENSION_KEYS = 8;
const MAX_DIMENSION_VALUES = 24;
const MAX_ANSWER_TEXT = 4000;
const MAX_SUMMARY = 1200;
const MAX_DQL_SOURCE = 3000;

export interface ConversationThread {
  id: string;
  surface: string;
  title?: string;
  notebookPath?: string;
  /** Opaque working-state JSON — owned/typed by conversation/working-state.ts. */
  workingState: Record<string, unknown>;
  rollingSummary?: string;
  /** Highest turn seq already folded into rollingSummary (compaction cursor). */
  summaryTurnSeq: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationTurnResult {
  columns?: string[];
  rowsSample?: unknown[][];
  dimensionValues?: Record<string, string[]>;
  measureColumns?: string[];
  rowCount?: number;
}

export interface ConversationTurnInput {
  question: string;
  answerSummary?: string;
  answerText?: string;
  route?: string;
  trustLabel?: string;
  certification?: string;
  sourceCertifiedBlock?: string;
  contextPackId?: string;
  sql?: string;
  dqlArtifact?: AgentDqlArtifactReference;
  cascade?: CascadeAnswerResult;
  result?: ConversationTurnResult;
  /** The turn's answer contract / requested shape, for working-state reduction. */
  contract?: Record<string, unknown>;
}

export interface ConversationTurn extends ConversationTurnInput {
  id: string;
  threadId: string;
  seq: number;
  createdAt: string;
}

export interface ConversationTurnSearchOptions {
  query: string;
  threadId?: string;
  limit?: number;
}

export function defaultConversationPath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'cache', 'agent-conversations.sqlite');
}

export class ConversationStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const Database = loadDatabase();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_threads (
        id                 TEXT PRIMARY KEY,
        surface            TEXT NOT NULL DEFAULT 'notebook',
        title              TEXT,
        notebook_path      TEXT,
        working_state_json TEXT NOT NULL DEFAULT '{}',
        rolling_summary    TEXT,
        summary_turn_seq   INTEGER NOT NULL DEFAULT 0,
        archived           INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_threads_updated
        ON conversation_threads(archived, updated_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_turns (
        id                     TEXT PRIMARY KEY,
        thread_id              TEXT NOT NULL,
        seq                    INTEGER NOT NULL,
        question               TEXT NOT NULL,
        answer_summary         TEXT,
        answer_text            TEXT,
        route                  TEXT,
        trust_label            TEXT,
        certification          TEXT,
        source_certified_block TEXT,
        context_pack_id        TEXT,
        sql                    TEXT,
        dql_artifact_json      TEXT NOT NULL DEFAULT '{}',
        cascade_json           TEXT NOT NULL DEFAULT '{}',
        result_json            TEXT NOT NULL DEFAULT '{}',
        contract_json          TEXT NOT NULL DEFAULT '{}',
        created_at             TEXT NOT NULL,
        UNIQUE (thread_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_turns_thread
        ON conversation_turns(thread_id, seq DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_turns_fts USING fts5(
        id UNINDEXED,
        thread_id UNINDEXED,
        question,
        answer_summary,
        tags,
        tokenize = 'porter unicode61'
      );
    `);
    this.ensureColumn('conversation_turns', 'dql_artifact_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('conversation_turns', 'cascade_json', "TEXT NOT NULL DEFAULT '{}'");
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((item) => item.name === column)) return;
    this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
  }

  createThread(input: { surface?: string; title?: string; notebookPath?: string } = {}): ConversationThread {
    const now = new Date().toISOString();
    const id = `thr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const thread: ConversationThread = {
      id,
      surface: input.surface?.trim() || 'notebook',
      title: input.title?.trim() || undefined,
      notebookPath: input.notebookPath?.trim() || undefined,
      workingState: {},
      rollingSummary: undefined,
      summaryTurnSeq: 0,
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO conversation_threads (
        id, surface, title, notebook_path, working_state_json, rolling_summary,
        summary_turn_seq, archived, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '{}', NULL, 0, 0, ?, ?)
    `).run(thread.id, thread.surface, thread.title ?? null, thread.notebookPath ?? null, now, now);
    return thread;
  }

  getThread(id: string): ConversationThread | null {
    const row = this.db.prepare('SELECT * FROM conversation_threads WHERE id = ?').get(id) as ThreadRow | undefined;
    return row ? rowToThread(row) : null;
  }

  listThreads(options: { limit?: number; includeArchived?: boolean } = {}): ConversationThread[] {
    const rows = options.includeArchived
      ? this.db.prepare('SELECT * FROM conversation_threads ORDER BY updated_at DESC LIMIT ?')
          .all(options.limit ?? 50)
      : this.db.prepare('SELECT * FROM conversation_threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?')
          .all(options.limit ?? 50);
    return (rows as ThreadRow[]).map(rowToThread);
  }

  archiveThread(id: string): void {
    this.db.prepare('UPDATE conversation_threads SET archived = 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  /**
   * Append a turn to a thread (assigns the next seq, dual-writes the FTS index,
   * bumps the thread, and sets the thread title from the first question).
   */
  appendTurn(threadId: string, input: ConversationTurnInput): ConversationTurn {
    const now = new Date().toISOString();
    const id = `trn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const result = capTurnResult(input.result);
    const dqlArtifact = capDqlArtifact(input.dqlArtifact);
    const turn: ConversationTurn = {
      ...input,
      answerText: input.answerText?.slice(0, MAX_ANSWER_TEXT),
      answerSummary: input.answerSummary?.slice(0, MAX_SUMMARY),
      dqlArtifact,
      result,
      id,
      threadId,
      seq: 0,
      createdAt: now,
    };
    const txn = this.db.transaction(() => {
      const seqRow = this.db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM conversation_turns WHERE thread_id = ?'
      ).get(threadId) as { next: number };
      turn.seq = seqRow.next;
      this.db.prepare(`
        INSERT INTO conversation_turns (
          id, thread_id, seq, question, answer_summary, answer_text, route,
          trust_label, certification, source_certified_block, context_pack_id,
          sql, dql_artifact_json, cascade_json, result_json, contract_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        turn.id,
        threadId,
        turn.seq,
        turn.question,
        turn.answerSummary ?? null,
        turn.answerText ?? null,
        turn.route ?? null,
        turn.trustLabel ?? null,
        turn.certification ?? null,
        turn.sourceCertifiedBlock ?? null,
        turn.contextPackId ?? null,
        turn.sql ?? null,
        JSON.stringify(turn.dqlArtifact ?? {}),
        JSON.stringify(turn.cascade ?? {}),
        JSON.stringify(turn.result ?? {}),
        JSON.stringify(turn.contract ?? {}),
        now,
      );
      const tags = [
        turn.sourceCertifiedBlock ?? '',
        turn.route ?? '',
        turn.cascade?.terminalLane ?? '',
        turn.cascade?.routeTier ?? '',
        turn.dqlArtifact?.name ?? '',
        turn.dqlArtifact?.kind ?? '',
        ...(turn.dqlArtifact?.metrics ?? []),
        ...(turn.dqlArtifact?.dimensions ?? []),
        ...(turn.result?.columns ?? []),
        ...Object.keys(turn.result?.dimensionValues ?? {}),
      ].filter(Boolean).join(' ');
      this.db.prepare(`
        INSERT INTO conversation_turns_fts (id, thread_id, question, answer_summary, tags)
        VALUES (?, ?, ?, ?, ?)
      `).run(turn.id, threadId, turn.question, turn.answerSummary ?? '', tags);
      this.db.prepare(`
        UPDATE conversation_threads
        SET updated_at = ?, title = COALESCE(title, ?)
        WHERE id = ?
      `).run(now, turn.question.slice(0, 120), threadId);
    });
    txn();
    return turn;
  }

  recentTurns(threadId: string, limit = 4): ConversationTurn[] {
    const rows = this.db.prepare(`
      SELECT * FROM conversation_turns WHERE thread_id = ? ORDER BY seq DESC LIMIT ?
    `).all(threadId, limit) as TurnRow[];
    return rows.map(rowToTurn).reverse();
  }

  /** Turns older than the compaction cursor and outside the recent window (for rolling summary). */
  turnsForCompaction(threadId: string, afterSeq: number, beforeSeq: number): ConversationTurn[] {
    const rows = this.db.prepare(`
      SELECT * FROM conversation_turns
      WHERE thread_id = ? AND seq > ? AND seq < ?
      ORDER BY seq ASC
    `).all(threadId, afterSeq, beforeSeq) as TurnRow[];
    return rows.map(rowToTurn);
  }

  updateThreadState(
    threadId: string,
    input: { workingState?: Record<string, unknown>; rollingSummary?: string; summaryTurnSeq?: number },
  ): void {
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [new Date().toISOString()];
    if (input.workingState !== undefined) {
      sets.push('working_state_json = ?');
      params.push(JSON.stringify(input.workingState));
    }
    if (input.rollingSummary !== undefined) {
      sets.push('rolling_summary = ?');
      params.push(input.rollingSummary || null);
    }
    if (input.summaryTurnSeq !== undefined) {
      sets.push('summary_turn_seq = ?');
      params.push(input.summaryTurnSeq);
    }
    params.push(threadId);
    this.db.prepare(`UPDATE conversation_threads SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /** FTS keyword search over turns; hybrid embedding re-ranking layers on top (P5). */
  searchTurns(options: ConversationTurnSearchOptions): ConversationTurn[] {
    const query = sanitizeFtsQuery(options.query);
    if (!query) return [];
    const params: unknown[] = [query];
    let threadFilter = '';
    if (options.threadId) {
      threadFilter = 'AND t.thread_id = ?';
      params.push(options.threadId);
    }
    const rows = this.db.prepare(`
      SELECT t.*, bm25(conversation_turns_fts) AS rank
      FROM conversation_turns_fts AS f
      JOIN conversation_turns AS t ON t.id = f.id
      WHERE conversation_turns_fts MATCH ?
        ${threadFilter}
      ORDER BY rank
      LIMIT ?
    `).all(...params, options.limit ?? 6) as TurnRow[];
    return rows.map(rowToTurn);
  }

  /** Housekeeping: hard-delete archived threads (and their turns) older than the cutoff. */
  pruneThreads(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    let pruned = 0;
    const txn = this.db.transaction(() => {
      const stale = this.db.prepare(
        'SELECT id FROM conversation_threads WHERE archived = 1 AND updated_at < ?'
      ).all(cutoff) as Array<{ id: string }>;
      for (const { id } of stale) {
        this.db.prepare('DELETE FROM conversation_turns_fts WHERE thread_id = ?').run(id);
        this.db.prepare('DELETE FROM conversation_turns WHERE thread_id = ?').run(id);
        this.db.prepare('DELETE FROM conversation_threads WHERE id = ?').run(id);
        pruned += 1;
      }
    });
    txn();
    return pruned;
  }

  close(): void {
    this.db.close();
  }
}

function capTurnResult(result: ConversationTurnResult | undefined): ConversationTurnResult | undefined {
  if (!result) return undefined;
  const columns = result.columns?.slice(0, MAX_COLUMNS);
  const rowsSample = result.rowsSample?.slice(0, MAX_SAMPLE_ROWS)
    .map((row) => Array.isArray(row) ? row.slice(0, MAX_COLUMNS) : row);
  const dimensionValues = result.dimensionValues
    ? Object.fromEntries(
        Object.entries(result.dimensionValues)
          .slice(0, MAX_DIMENSION_KEYS)
          .map(([key, values]) => [key, values.slice(0, MAX_DIMENSION_VALUES)]),
      )
    : undefined;
  return {
    columns,
    rowsSample,
    dimensionValues,
    measureColumns: result.measureColumns?.slice(0, MAX_COLUMNS),
    rowCount: result.rowCount,
  };
}

function capDqlArtifact(artifact: AgentDqlArtifactReference | undefined): AgentDqlArtifactReference | undefined {
  if (!artifact?.source?.trim()) return undefined;
  return {
    kind: artifact.kind,
    source: artifact.source.slice(0, MAX_DQL_SOURCE),
    name: artifact.name?.slice(0, 180),
    sourcePath: artifact.sourcePath?.slice(0, 400),
    metrics: artifact.metrics?.slice(0, MAX_COLUMNS),
    dimensions: artifact.dimensions?.slice(0, MAX_COLUMNS),
    filters: artifact.filters?.slice(0, MAX_DIMENSION_KEYS).map((filter) => ({
      dimension: filter.dimension.slice(0, 180),
      operator: filter.operator.slice(0, 80),
      values: filter.values.slice(0, MAX_DIMENSION_VALUES).map((value) => value.slice(0, 240)),
    })),
    timeDimension: artifact.timeDimension
      ? {
          name: artifact.timeDimension.name.slice(0, 180),
          granularity: artifact.timeDimension.granularity.slice(0, 80),
        }
      : undefined,
  };
}

type ThreadRow = {
  id: string;
  surface: string;
  title: string | null;
  notebook_path: string | null;
  working_state_json: string;
  rolling_summary: string | null;
  summary_turn_seq: number;
  archived: number;
  created_at: string;
  updated_at: string;
};

type TurnRow = {
  id: string;
  thread_id: string;
  seq: number;
  question: string;
  answer_summary: string | null;
  answer_text: string | null;
  route: string | null;
  trust_label: string | null;
  certification: string | null;
  source_certified_block: string | null;
  context_pack_id: string | null;
  sql: string | null;
  dql_artifact_json: string;
  cascade_json: string;
  result_json: string;
  contract_json: string;
  created_at: string;
};

function rowToThread(row: ThreadRow): ConversationThread {
  return {
    id: row.id,
    surface: row.surface,
    title: row.title ?? undefined,
    notebookPath: row.notebook_path ?? undefined,
    workingState: safeJSON(row.working_state_json, {} as Record<string, unknown>),
    rollingSummary: row.rolling_summary ?? undefined,
    summaryTurnSeq: row.summary_turn_seq,
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTurn(row: TurnRow): ConversationTurn {
  const result = safeJSON(row.result_json, {} as ConversationTurnResult);
  const dqlArtifact = safeJSON(row.dql_artifact_json, {} as AgentDqlArtifactReference);
  const cascade = safeJSON(row.cascade_json, {} as CascadeAnswerResult);
  const contract = safeJSON(row.contract_json, {} as Record<string, unknown>);
  return {
    id: row.id,
    threadId: row.thread_id,
    seq: row.seq,
    question: row.question,
    answerSummary: row.answer_summary ?? undefined,
    answerText: row.answer_text ?? undefined,
    route: row.route ?? undefined,
    trustLabel: row.trust_label ?? undefined,
    certification: row.certification ?? undefined,
    sourceCertifiedBlock: row.source_certified_block ?? undefined,
    contextPackId: row.context_pack_id ?? undefined,
    sql: row.sql ?? undefined,
    dqlArtifact: Object.keys(dqlArtifact).length > 0 ? capDqlArtifact(dqlArtifact) : undefined,
    cascade: Object.keys(cascade).length > 0 ? cascade : undefined,
    result: Object.keys(result).length > 0 ? result : undefined,
    contract: Object.keys(contract).length > 0 ? contract : undefined,
    createdAt: row.created_at,
  };
}

function safeJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
