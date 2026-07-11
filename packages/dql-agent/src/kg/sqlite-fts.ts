/**
 * SQLite + FTS5 backing store for the knowledge graph.
 *
 * Schema (created on demand):
 *   kg_nodes       — structured columns + JSON blobs for tags/examples
 *   kg_nodes_fts   — virtual FTS5 table over name/description/llm_context/tags
 *   kg_edges       — adjacency list (src, dst, kind)
 *   kg_feedback    — feedback events for self-learning ranking
 *   kg_meta        — last-build timestamp + manifest fingerprint
 */

import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { buildFtsMatch } from '../memory/fts-query.js';
import type {
  KGNode,
  KGEdge,
  KGSearchHit,
  KGSearchOptions,
  KGFeedbackRow,
} from './types.js';

const require = createRequire(import.meta.url);
let databaseCtor: typeof Database | null = null;

function loadDatabase(): typeof Database {
  databaseCtor ??= require('better-sqlite3') as typeof Database;
  return databaseCtor;
}

export class KGStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const Database = loadDatabase();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kg_nodes (
        node_id      TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        name         TEXT NOT NULL,
        domain       TEXT,
        status       TEXT,
        owner        TEXT,
        description  TEXT,
        llm_context  TEXT,
        tags_json    TEXT NOT NULL DEFAULT '[]',
        examples_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        source_path  TEXT,
        git_sha      TEXT NOT NULL DEFAULT '',
        updated_at   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kg_nodes_kind   ON kg_nodes(kind);
      CREATE INDEX IF NOT EXISTS idx_kg_nodes_domain ON kg_nodes(domain);

      CREATE VIRTUAL TABLE IF NOT EXISTS kg_nodes_fts USING fts5(
        node_id UNINDEXED,
        name,
        description,
        llm_context,
        tags,
        kind,
        domain,
        tokenize = 'porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS kg_edges (
        src    TEXT NOT NULL,
        dst    TEXT NOT NULL,
        kind   TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        PRIMARY KEY (src, dst, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_kg_edges_src ON kg_edges(src);
      CREATE INDEX IF NOT EXISTS idx_kg_edges_dst ON kg_edges(dst);

      CREATE TABLE IF NOT EXISTS kg_feedback (
        id          TEXT PRIMARY KEY,
        ts          TEXT NOT NULL,
        user        TEXT NOT NULL,
        question    TEXT NOT NULL,
        answer_kind TEXT NOT NULL,
        block_id    TEXT,
        rating      TEXT NOT NULL CHECK (rating IN ('up', 'down')),
        comment     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_kg_feedback_user  ON kg_feedback(user);
      CREATE INDEX IF NOT EXISTS idx_kg_feedback_block ON kg_feedback(block_id);

      CREATE TABLE IF NOT EXISTS kg_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.ensureColumn('kg_nodes', 'metadata_json', `TEXT NOT NULL DEFAULT '{}'`);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some((row) => row.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  /**
   * Wholesale rebuild — clears every node/edge then inserts the supplied
   * arrays inside one transaction. Feedback rows are preserved across
   * rebuilds because they're index inputs.
   */
  rebuild(nodes: KGNode[], edges: KGEdge[], options: { fingerprint?: string } = {}): void {
    const insertNode = this.db.prepare(`
      INSERT INTO kg_nodes (
        node_id, kind, name, domain, status, owner, description, llm_context,
        tags_json, examples_json, metadata_json, source_path, git_sha, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO kg_nodes_fts (node_id, name, description, llm_context, tags, kind, domain)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEdge = this.db.prepare(`
      INSERT OR IGNORE INTO kg_edges (src, dst, kind, weight) VALUES (?, ?, ?, ?)
    `);
    const now = new Date().toISOString();

    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM kg_edges').run();
      this.db.prepare('DELETE FROM kg_nodes_fts').run();
      this.db.prepare('DELETE FROM kg_nodes').run();
      for (const n of nodes) {
        insertNode.run(
          n.nodeId, n.kind, n.name,
          n.domain ?? null, n.status ?? null, n.owner ?? null,
          n.description ?? null, n.llmContext ?? null,
          JSON.stringify(n.tags ?? []),
          JSON.stringify(n.examples ?? []),
          JSON.stringify(nodeMetadata(n)),
          n.sourcePath ?? null, n.gitSha ?? '', now,
        );
        insertFts.run(
          n.nodeId,
          n.name,
          n.description ?? '',
          n.llmContext ?? '',
          (n.tags ?? []).join(' '),
          n.kind,
          n.domain ?? '',
        );
      }
      for (const e of edges) {
        insertEdge.run(e.src, e.dst, e.kind, e.weight ?? 1.0);
      }
      this.db.prepare(`INSERT OR REPLACE INTO kg_meta (key, value) VALUES ('built_at', ?)`).run(now);
      this.db.prepare(`INSERT OR REPLACE INTO kg_meta (key, value) VALUES ('node_count', ?)`).run(String(nodes.length));
      this.db.prepare(`INSERT OR REPLACE INTO kg_meta (key, value) VALUES ('edge_count', ?)`).run(String(edges.length));
      if (options.fingerprint) {
        this.db.prepare(`INSERT OR REPLACE INTO kg_meta (key, value) VALUES ('fingerprint', ?)`).run(options.fingerprint);
      } else {
        this.db.prepare(`DELETE FROM kg_meta WHERE key = 'fingerprint'`).run();
      }
    });
    txn();
  }

  search(options: KGSearchOptions): KGSearchHit[] {
    const { query, kinds, domain, limit = 20 } = options;
    if (!query.trim()) return [];

    const match = buildFtsMatch(query, { prefix: true });
    if (!match.or) return [];

    const filters: string[] = [];
    if (kinds && kinds.length > 0) {
      filters.push(`f.kind IN (${kinds.map(() => '?').join(', ')})`);
    }
    if (domain) {
      filters.push(`f.domain = ?`);
    }
    const extraParams: unknown[] = [...(kinds && kinds.length > 0 ? kinds : []), ...(domain ? [domain] : [])];
    const whereExtra = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';

    // Fetch a wider window than `limit` so the feedback multiplier (W4.1) can
    // reorder within it — a downvoted block can drop below a just-missed peer.
    const fetchLimit = Math.min(limit * 3, limit + 50);
    type Row = {
      node_id: string; kind: string; name: string; domain: string | null;
      status: string | null; owner: string | null; description: string | null;
      llm_context: string | null; tags_json: string; examples_json: string;
      metadata_json?: string | null; source_path: string | null; git_sha: string; rank: number; snip: string;
    };
    const runMatch = (matchExpr: string): Row[] => this.db.prepare(`
      SELECT n.*,
             bm25(kg_nodes_fts) AS rank,
             snippet(kg_nodes_fts, -1, '<mark>', '</mark>', '…', 12) AS snip
      FROM kg_nodes_fts AS f
      JOIN kg_nodes AS n ON n.node_id = f.node_id
      WHERE kg_nodes_fts MATCH ?${whereExtra}
      ORDER BY rank
      LIMIT ?
    `).all(matchExpr, ...extraParams, fetchLimit) as Row[];

    // Precision-first, recall-preserving UNION: nodes where all terms co-occur
    // (AND) lead — a "region tax by product" block surfaces ahead of every node
    // that merely mentions "product" — then OR-of-terms matches fill the window so
    // single-term context nodes still appear. Dedup by node_id.
    const andRows = match.and ? runMatch(match.and) : [];
    const seenIds = new Set(andRows.map((row) => row.node_id));
    const orRows = runMatch(match.or).filter((row) => !seenIds.has(row.node_id));
    const rows = [...andRows, ...orRows].slice(0, fetchLimit);

    // W4.1 — feedback-aware ranking. A bounded ±15% multiplier from per-block
    // up/down votes reorders retrieval candidates: downvoted blocks demote, upvoted
    // ones rise. It is pre-cascade (the certified-first cascade still runs downstream)
    // and bounded, so it never overrides a strong BM25 or certification signal. With
    // no feedback, every multiplier is 1 → order is byte-identical to BM25.
    const blockNames = rows
      .filter((r) => r.node_id.startsWith('block:'))
      .map((r) => r.node_id.slice('block:'.length));
    const multipliers = this.feedbackMultipliers(blockNames);

    return rows.map((r) => ({
      node: rowToNode(r),
      score: (r.rank ? 1 / (1 + Math.max(0, r.rank)) : 0)
        * (r.node_id.startsWith('block:') ? (multipliers.get(r.node_id.slice('block:'.length)) ?? 1) : 1),
      snippet: r.snip ?? undefined,
    }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Bounded ±15% feedback multiplier per block from up/down votes (W4.1). A
   * saturating tanh keeps a handful of votes from dominating BM25: net 0 → 1.0,
   * strongly downvoted → 0.85, strongly upvoted → 1.15. Blocks with no feedback
   * are absent from the map (caller defaults to 1.0).
   */
  feedbackMultipliers(blockIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    const strip = (id: string) => (id.startsWith('block:') ? id.slice('block:'.length) : id);
    const names = [...new Set(blockIds.map(strip))].filter(Boolean);
    if (names.length === 0) return out;
    // Feedback may store the bare block name OR the `block:`-prefixed node id
    // (callers differ); match both and normalize the result key to the bare name.
    const candidates = [...names, ...names.map((name) => `block:${name}`)];
    const placeholders = candidates.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT block_id,
        SUM(CASE WHEN rating = 'up' THEN 1 ELSE 0 END) AS up,
        SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END) AS down
      FROM kg_feedback WHERE block_id IN (${placeholders}) GROUP BY block_id
    `).all(...candidates) as Array<{ block_id: string; up: number | null; down: number | null }>;
    const netByName = new Map<string, number>();
    for (const row of rows) {
      const name = strip(row.block_id);
      netByName.set(name, (netByName.get(name) ?? 0) + ((row.up ?? 0) - (row.down ?? 0)));
    }
    for (const [name, net] of netByName) out.set(name, 1 + 0.15 * Math.tanh(net / 3));
    return out;
  }

  getNode(nodeId: string): KGNode | null {
    const row = this.db.prepare('SELECT * FROM kg_nodes WHERE node_id = ?').get(nodeId) as
      | { node_id: string; kind: string; name: string; domain: string | null;
          status: string | null; owner: string | null; description: string | null;
          llm_context: string | null; tags_json: string; examples_json: string; metadata_json?: string | null;
          source_path: string | null; git_sha: string }
      | undefined;
    return row ? rowToNode(row) : null;
  }

  getNodesByKind(kind: string, limit = 100): KGNode[] {
    const rows = this.db.prepare(
      'SELECT * FROM kg_nodes WHERE kind = ? ORDER BY name LIMIT ?',
    ).all(kind, limit) as Array<{
      node_id: string; kind: string; name: string; domain: string | null;
      status: string | null; owner: string | null; description: string | null;
      llm_context: string | null; tags_json: string; examples_json: string; metadata_json?: string | null;
      source_path: string | null; git_sha: string;
    }>;
    return rows.map((r) => rowToNode(r));
  }

  /**
   * Adjacent nodes to `nodeId` over `kg_edges` (both directions by default). This is
   * the traversal API the cross-domain reasoning tool uses to relate entities/models
   * across domains — the lineage graph existed but had no agent-facing traversal.
   */
  neighbors(
    nodeId: string,
    options: { edgeKinds?: KGEdge['kind'][]; direction?: 'out' | 'in' | 'both'; limit?: number } = {},
  ): Array<{ node: KGNode; edge: KGEdge; direction: 'out' | 'in' }> {
    const { edgeKinds, direction = 'both', limit = 50 } = options;
    const kindFilter = edgeKinds && edgeKinds.length > 0
      ? ` AND kind IN (${edgeKinds.map(() => '?').join(', ')})`
      : '';
    type Neighbor = { node: KGNode; edge: KGEdge; direction: 'out' | 'in' };
    const collect = (dir: 'out' | 'in'): Neighbor[] => {
      const column = dir === 'out' ? 'src' : 'dst';
      const rows = this.db.prepare(
        `SELECT src, dst, kind, weight FROM kg_edges WHERE ${column} = ?${kindFilter} LIMIT ?`,
      ).all(nodeId, ...(edgeKinds ?? []), limit) as Array<{ src: string; dst: string; kind: string; weight: number }>;
      const out: Neighbor[] = [];
      for (const r of rows) {
        const node = this.getNode(dir === 'out' ? r.dst : r.src);
        if (node) out.push({ node, edge: { src: r.src, dst: r.dst, kind: r.kind as KGEdge['kind'], weight: r.weight }, direction: dir });
      }
      return out;
    };
    const outEdges = direction === 'in' ? [] : collect('out');
    const inEdges = direction === 'out' ? [] : collect('in');
    // Interleave so a hub node's inbound (cross-domain bridge) edges are never starved
    // by a large outbound fan-out when the combined result is capped at `limit`.
    const merged: Neighbor[] = [];
    for (let i = 0; i < Math.max(outEdges.length, inEdges.length); i += 1) {
      if (i < outEdges.length) merged.push(outEdges[i]);
      if (i < inEdges.length) merged.push(inEdges[i]);
    }
    return merged.slice(0, limit);
  }

  /**
   * Shortest edge path between two nodes (bounded BFS over `kg_edges`, undirected).
   * Returns the node-id path or null if none within `maxDepth`. Used to discover a
   * cross-domain join route (e.g. revenue → orders → customers → support tickets).
   */
  findJoinPath(fromNodeId: string, toNodeId: string, maxDepth = 4): string[] | null {
    if (fromNodeId === toNodeId) return [fromNodeId];
    const visited = new Set<string>([fromNodeId]);
    let frontier: Array<{ id: string; path: string[] }> = [{ id: fromNodeId, path: [fromNodeId] }];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next: Array<{ id: string; path: string[] }> = [];
      for (const { id, path } of frontier) {
        const rows = this.db.prepare(
          'SELECT dst AS other FROM kg_edges WHERE src = ? UNION SELECT src AS other FROM kg_edges WHERE dst = ?',
        ).all(id, id) as Array<{ other: string }>;
        for (const { other } of rows) {
          if (other === toNodeId) return [...path, other];
          if (!visited.has(other)) {
            visited.add(other);
            next.push({ id: other, path: [...path, other] });
          }
        }
      }
      frontier = next;
    }
    return null;
  }

  recordFeedback(row: KGFeedbackRow): void {
    this.db.prepare(`
      INSERT INTO kg_feedback (id, ts, user, question, answer_kind, block_id, rating, comment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.ts, row.user, row.question, row.answerKind,
      row.blockId ?? null, row.rating, row.comment ?? null,
    );
  }

  blockFeedbackScore(blockId: string): { up: number; down: number } {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN rating = 'up' THEN 1 ELSE 0 END) AS up,
        SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END) AS down
      FROM kg_feedback WHERE block_id = ?
    `).get(blockId) as { up: number | null; down: number | null } | undefined;
    return {
      up: row?.up ?? 0,
      down: row?.down ?? 0,
    };
  }

  /** Surface high-confidence uncertified answers ready for promotion. */
  promotionCandidates(minUps = 5): Array<{ question: string; blockId: string; ups: number }> {
    const rows = this.db.prepare(`
      SELECT block_id, question, COUNT(*) AS ups
      FROM kg_feedback
      WHERE answer_kind = 'uncertified' AND rating = 'up' AND block_id IS NOT NULL
      GROUP BY block_id, question
      HAVING ups >= ?
        AND NOT EXISTS (
          SELECT 1 FROM kg_feedback f2
          WHERE f2.block_id = kg_feedback.block_id
            AND f2.answer_kind = 'uncertified'
            AND f2.rating = 'down'
        )
      ORDER BY ups DESC
      LIMIT 50
    `).all(minUps) as Array<{ block_id: string; question: string; ups: number }>;
    return rows.map((r) => ({ blockId: r.block_id, question: r.question, ups: r.ups }));
  }

  /** Blocks with >= minDownvotes down-votes, for failure analysis (W4.2). */
  downvotedBlocks(minDownvotes = 2): Array<{ blockId: string; question: string; downs: number }> {
    const rows = this.db.prepare(`
      SELECT block_id, question, COUNT(*) AS downs
      FROM kg_feedback
      WHERE rating = 'down' AND block_id IS NOT NULL
      GROUP BY block_id
      HAVING downs >= ?
      ORDER BY downs DESC
      LIMIT 50
    `).all(minDownvotes) as Array<{ block_id: string; question: string; downs: number }>;
    return rows.map((r) => ({ blockId: r.block_id, question: r.question, downs: r.downs }));
  }

  meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kg_meta WHERE key = ?').get(key) as
      | { value: string } | undefined;
    return row?.value ?? null;
  }

  close(): void {
    this.db.close();
  }
}

function rowToNode(row: {
  node_id: string;
  kind: string;
  name: string;
  domain: string | null;
  status: string | null;
  owner: string | null;
  description: string | null;
  llm_context: string | null;
  tags_json: string;
  examples_json: string;
  metadata_json?: string | null;
  source_path: string | null;
  git_sha: string;
}): KGNode {
  const metadata = safeJSON(row.metadata_json, {} as Partial<KGNode>);
  return {
    nodeId: row.node_id,
    kind: row.kind as KGNode['kind'],
    name: row.name,
    domain: row.domain ?? undefined,
    status: row.status ?? undefined,
    owner: row.owner ?? undefined,
    description: row.description ?? undefined,
    llmContext: row.llm_context ?? undefined,
    tags: safeJSON(row.tags_json, [] as string[]),
    examples: safeJSON(row.examples_json, [] as KGNode['examples'] extends infer T ? T : never) as KGNode['examples'],
    sql: metadata.sql,
    sourcePath: row.source_path ?? undefined,
    gitSha: row.git_sha ?? undefined,
    sourceTier: metadata.sourceTier,
    certification: metadata.certification,
    provenance: metadata.provenance,
    freshness: metadata.freshness,
    businessOutcome: metadata.businessOutcome,
    businessOwner: metadata.businessOwner,
    decisionUse: metadata.decisionUse,
    reviewCadence: metadata.reviewCadence,
    pattern: metadata.pattern,
    grain: metadata.grain,
    entities: metadata.entities,
    declaredOutputs: metadata.declaredOutputs,
    outputs: metadata.outputs,
    outputContract: metadata.outputContract,
    dimensions: metadata.dimensions,
    allowedFilters: metadata.allowedFilters,
    parameterPolicy: metadata.parameterPolicy,
    parameters: metadata.parameters,
    filterBindings: metadata.filterBindings,
    sourceSystems: metadata.sourceSystems,
    replacementFor: metadata.replacementFor,
    sqlFingerprints: metadata.sqlFingerprints,
    businessFingerprint: metadata.businessFingerprint,
    datalexContract: metadata.datalexContract,
    boundedContext: metadata.boundedContext,
    primaryTerms: metadata.primaryTerms,
    businessRules: metadata.businessRules,
    caveats: metadata.caveats,
    dataState: metadata.dataState,
    dataStateDetail: metadata.dataStateDetail,
  };
}

function nodeMetadata(node: KGNode): Partial<KGNode> {
  const metadata: Partial<KGNode> = {};
  for (const key of [
    'sourceTier',
    'certification',
    'provenance',
    'sql',
    'freshness',
    'businessOutcome',
    'businessOwner',
    'decisionUse',
    'reviewCadence',
    'pattern',
    'grain',
    'entities',
    'declaredOutputs',
    'outputs',
    'outputContract',
    'dimensions',
    'allowedFilters',
    'parameterPolicy',
    'parameters',
    'filterBindings',
    'sourceSystems',
    'replacementFor',
    'sqlFingerprints',
    'businessFingerprint',
    'datalexContract',
    'boundedContext',
    'primaryTerms',
    'businessRules',
    'caveats',
    'dataState',
    'dataStateDetail',
  ] as const) {
    const value = node[key];
    if (value !== undefined) {
      (metadata as Record<string, unknown>)[key] = value;
    }
  }
  return metadata;
}

function safeJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
