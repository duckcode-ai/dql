/**
 * SQLite index for scoped correction hints.
 *
 * Git is the source of truth (`.dql/hints/*.hint.yaml`); this is a rebuildable
 * FTS5 index living in the SAME file as the KG (`.dql/cache/agent-kg.sqlite`),
 * extending the existing store rather than introducing a second cache file.
 * Approved-only is enforced at the retrieval boundary (`searchApprovedHints`).
 */

import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import {
  hintAppliesToScope,
  type Hint,
  type HintScope,
  type HintStatus,
  type QuestionScope,
  type ScopedHintMatch,
} from './types.js';
import {
  defaultEmbeddingProvider,
  hybridRank,
  type EmbeddingProvider,
} from '../embeddings/provider.js';
import { sanitizeFtsQuery } from '../memory/fts-query.js';

const require = createRequire(import.meta.url);
let databaseCtor: typeof Database | null = null;

function loadDatabase(): typeof Database {
  databaseCtor ??= require('better-sqlite3') as typeof Database;
  return databaseCtor;
}

export interface SearchApprovedHintsOptions {
  questionScope: QuestionScope;
  limit?: number;
  /** Hybrid-rank knobs (Part B). alpha=0 keeps pure FTS5 (the safe default). */
  alpha?: number;
  embeddingProvider?: EmbeddingProvider;
}

export class HintStore {
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
      CREATE TABLE IF NOT EXISTS agent_hints (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        guidance      TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'candidate',
        metric        TEXT,
        dbt_model     TEXT,
        domain        TEXT,
        dialect       TEXT,
        term          TEXT,
        block         TEXT,
        trace_id      TEXT,
        corrected_sql TEXT,
        tags_json     TEXT NOT NULL DEFAULT '[]',
        author        TEXT,
        reviewer      TEXT,
        supersedes    TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        source_path   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_hints_status ON agent_hints(status);
      CREATE INDEX IF NOT EXISTS idx_agent_hints_metric ON agent_hints(metric);
      CREATE INDEX IF NOT EXISTS idx_agent_hints_domain ON agent_hints(domain);
      CREATE INDEX IF NOT EXISTS idx_agent_hints_model  ON agent_hints(dbt_model);

      CREATE VIRTUAL TABLE IF NOT EXISTS agent_hints_fts USING fts5(
        id UNINDEXED,
        title,
        guidance,
        tags,
        scope,
        tokenize = 'porter unicode61'
      );
    `);
  }

  /** Replace the whole index from the Git-authoritative hint set. */
  rebuild(hints: Hint[]): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO agent_hints (
        id, title, guidance, status, metric, dbt_model, domain, dialect, term, block,
        trace_id, corrected_sql, tags_json, author, reviewer, supersedes,
        created_at, updated_at, source_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO agent_hints_fts (id, title, guidance, tags, scope)
      VALUES (?, ?, ?, ?, ?)
    `);
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM agent_hints_fts').run();
      this.db.prepare('DELETE FROM agent_hints').run();
      for (const hint of hints) {
        this.insertRow(hint, insert, insertFts);
      }
    });
    txn();
  }

  /** Upsert a single hint (keeps Git + SQLite in sync after a record/approve). */
  upsert(hint: Hint): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO agent_hints (
        id, title, guidance, status, metric, dbt_model, domain, dialect, term, block,
        trace_id, corrected_sql, tags_json, author, reviewer, supersedes,
        created_at, updated_at, source_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO agent_hints_fts (id, title, guidance, tags, scope)
      VALUES (?, ?, ?, ?, ?)
    `);
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM agent_hints_fts WHERE id = ?').run(hint.id);
      this.insertRow(hint, insert, insertFts);
    });
    txn();
  }

  private insertRow(
    hint: Hint,
    insert: Database.Statement,
    insertFts: Database.Statement,
  ): void {
    insert.run(
      hint.id,
      hint.title,
      hint.guidance,
      hint.status,
      hint.scope.metric ?? null,
      hint.scope.dbtModel ?? null,
      hint.scope.domain ?? null,
      hint.scope.dialect ?? null,
      hint.scope.term ?? null,
      hint.scope.block ?? null,
      hint.traceId ?? null,
      hint.correctedSql ?? null,
      JSON.stringify(hint.tags ?? []),
      hint.author ?? null,
      hint.reviewer ?? null,
      hint.supersedes ?? null,
      hint.createdAt,
      hint.updatedAt,
      (hint as Hint & { sourcePath?: string }).sourcePath ?? null,
    );
    insertFts.run(
      hint.id,
      hint.title,
      hint.guidance,
      (hint.tags ?? []).join(' '),
      scopeText(hint.scope),
    );
  }

  get(id: string): Hint | null {
    const row = this.db.prepare('SELECT * FROM agent_hints WHERE id = ?').get(id) as HintRow | undefined;
    return row ? rowToHint(row) : null;
  }

  list(status?: HintStatus): Hint[] {
    const rows = (status
      ? this.db.prepare('SELECT * FROM agent_hints WHERE status = ? ORDER BY updated_at DESC').all(status)
      : this.db.prepare('SELECT * FROM agent_hints ORDER BY updated_at DESC').all()) as HintRow[];
    return rows.map(rowToHint);
  }

  /**
   * Retrieve APPROVED hints that apply to a question's scope. This is the only
   * retrieval entry point used outside review/dev mode — draft/candidate hints
   * are never returned here.
   */
  async searchApprovedHints(options: SearchApprovedHintsOptions): Promise<ScopedHintMatch[]> {
    const { questionScope, limit = 6 } = options;
    const sanitized = sanitizeFtsQuery(questionScope.text);

    // FTS narrows the candidate set when there is searchable text; otherwise fall
    // back to all approved hints (scope filter still applies as a hard gate).
    const ftsRows = sanitized
      ? (this.db.prepare(`
          SELECT h.*, bm25(agent_hints_fts) AS rank
          FROM agent_hints_fts AS f
          JOIN agent_hints AS h ON h.id = f.id
          WHERE agent_hints_fts MATCH ?
            AND h.status = 'approved'
          ORDER BY rank
          LIMIT ?
        `).all(sanitized, Math.max(limit * 4, 24)) as Array<HintRow & { rank: number }>)
      : (this.db.prepare(`
          SELECT h.*, 0 AS rank
          FROM agent_hints AS h
          WHERE h.status = 'approved'
          ORDER BY updated_at DESC
          LIMIT ?
        `).all(Math.max(limit * 4, 24)) as Array<HintRow & { rank: number }>);

    // Hard scope gate: drop any hint whose scope does not apply to the question.
    const scoped = ftsRows
      .map((row) => {
        const hint = rowToHint(row);
        const verdict = hintAppliesToScope(hint.scope, questionScope);
        const ftsScore = row.rank ? 1 / (1 + Math.max(0, row.rank)) : 0.01;
        return { hint, verdict, ftsScore };
      })
      .filter((entry) => entry.verdict.applies);

    if (scoped.length === 0) return [];

    // Hybrid rank (Part B). alpha defaults to 0 → pure FTS5 ordering.
    const ranked = await hybridRank(
      questionScope.text,
      scoped.map((entry) => ({
        item: entry,
        text: `${entry.hint.title} ${entry.hint.guidance} ${(entry.hint.tags ?? []).join(' ')}`,
        ftsScore: entry.ftsScore,
      })),
      {
        alpha: options.alpha ?? 0,
        provider: options.embeddingProvider ?? defaultEmbeddingProvider(),
      },
    );

    return ranked.slice(0, limit).map((entry) => ({
      hint: entry.item.hint,
      score: entry.score,
      scopeReason: entry.item.verdict.reason,
      snippet: undefined,
    }));
  }

  /** Approved hints whose scopes overlap (surfaced as conflicts for review). */
  conflictingApprovedHints(): Array<[Hint, Hint]> {
    const approved = this.list('approved');
    const pairs: Array<[Hint, Hint]> = [];
    for (let i = 0; i < approved.length; i += 1) {
      for (let j = i + 1; j < approved.length; j += 1) {
        const a = approved[i];
        const b = approved[j];
        if (a.supersedes === b.id || b.supersedes === a.id) continue;
        if (scopesShareConstraint(a.scope, b.scope)) pairs.push([a, b]);
      }
    }
    return pairs;
  }

  close(): void {
    this.db.close();
  }
}

function scopesShareConstraint(a: HintScope, b: HintScope): boolean {
  const fields: Array<keyof HintScope> = ['metric', 'dbtModel', 'domain', 'dialect', 'term', 'block'];
  let shared = false;
  for (const field of fields) {
    const av = a[field];
    const bv = b[field];
    if (av && bv) {
      if (av.trim().toLowerCase() !== bv.trim().toLowerCase()) return false;
      shared = true;
    }
  }
  return shared;
}

function scopeText(scope: HintScope): string {
  return [scope.metric, scope.dbtModel, scope.domain, scope.dialect, scope.term, scope.block]
    .filter(Boolean)
    .join(' ');
}

type HintRow = {
  id: string;
  title: string;
  guidance: string;
  status: string;
  metric: string | null;
  dbt_model: string | null;
  domain: string | null;
  dialect: string | null;
  term: string | null;
  block: string | null;
  trace_id: string | null;
  corrected_sql: string | null;
  tags_json: string;
  author: string | null;
  reviewer: string | null;
  supersedes: string | null;
  created_at: string;
  updated_at: string;
  source_path: string | null;
};

function rowToHint(row: HintRow): Hint {
  return {
    id: row.id,
    title: row.title,
    guidance: row.guidance,
    status: row.status as HintStatus,
    scope: {
      metric: row.metric ?? undefined,
      dbtModel: row.dbt_model ?? undefined,
      domain: row.domain ?? undefined,
      dialect: row.dialect ?? undefined,
      term: row.term ?? undefined,
      block: row.block ?? undefined,
    },
    traceId: row.trace_id ?? undefined,
    correctedSql: row.corrected_sql ?? undefined,
    tags: safeJSON(row.tags_json, [] as string[]),
    author: row.author ?? undefined,
    reviewer: row.reviewer ?? undefined,
    supersedes: row.supersedes ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

