/**
 * Project-local metadata catalog for OSS agentic analytics.
 *
 * Git/DQL/dbt files remain the source of truth. This SQLite database is a
 * rebuildable local catalog at `.dql/cache/metadata.sqlite` used by agents,
 * MCP tools, app builder, and notebook/block AI to retrieve one consistent
 * context pack before answering.
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  buildManifest,
  loadProjectConfig,
  resolveDbtManifestPath,
  resolveSemanticLayerWithDiagnostics,
  type DQLManifest,
  type ManifestDiagnostic,
  type SemanticLayer,
} from '@duckcodeailabs/dql-core';
import { buildKGFromManifest, buildKGFromSemanticLayer } from '../kg/build.js';
import type { KGEdge, KGNode } from '../kg/types.js';

const require = createRequire(import.meta.url);
let databaseCtor: typeof Database | null = null;

function loadDatabase(): typeof Database {
  databaseCtor ??= require('better-sqlite3') as typeof Database;
  return databaseCtor;
}

export type MetadataTrustLabel = 'certified' | 'mixed' | 'draft' | 'unknown';

export interface MetadataObject {
  objectKey: string;
  objectType: string;
  name: string;
  fullName?: string;
  domain?: string;
  owner?: string;
  status?: string;
  description?: string;
  sourcePath?: string;
  sourceSystem?: string;
  payload?: Record<string, unknown>;
  updatedAt?: string;
  score?: number;
  snippet?: string;
}

export interface MetadataEdge {
  edgeType: string;
  fromKey: string;
  toKey: string;
  confidence?: number;
  payload?: Record<string, unknown>;
}

export interface MetadataDiagnostic {
  kind: string;
  severity: 'error' | 'warning';
  message: string;
  objectKey?: string;
  filePath?: string;
}

export interface MetadataSnapshot {
  projectRoot: string;
  manifest: DQLManifest;
  objects: MetadataObject[];
  edges: MetadataEdge[];
  diagnostics: MetadataDiagnostic[];
  fingerprint: string;
  generatedAt: string;
}

export interface EnsureMetadataCatalogOptions {
  manifest?: DQLManifest;
  semanticLayer?: SemanticLayer | null;
  force?: boolean;
}

export interface EnsureMetadataCatalogResult {
  path: string;
  refreshed: boolean;
  objectCount: number;
  edgeCount: number;
  diagnostics: MetadataDiagnostic[];
  fingerprint: string;
}

export interface BuildLocalContextPackRequest {
  question: string;
  focusObjectKey?: string;
  mode?: 'question' | 'build' | 'debug' | 'certify' | 'impact' | 'explain';
  limit?: number;
  objectTypes?: string[];
  intent?: MetadataAgentIntent;
  surface?: 'cli' | 'notebook' | 'block' | 'app' | 'research' | 'mcp' | string;
  followUp?: MetadataFollowUpContext | unknown;
  selectedContext?: unknown;
  runtimeSchemaSnapshot?: RuntimeSchemaSnapshot;
  strictness?: 'safe' | 'balanced' | 'exploratory';
}

export interface MetadataFollowUpContext {
  kind: 'generic' | 'drilldown';
  sourceBlockName?: string;
  sourceQuestion?: string;
  sourceAnswer?: string;
  filters?: string[];
  dimensions?: string[];
}

export type MetadataAgentIntent =
  | 'exact_certified_lookup'
  | 'definition_lookup'
  | 'ad_hoc_ranking'
  | 'driver_breakdown'
  | 'diagnose_change'
  | 'segment_compare'
  | 'entity_drilldown'
  | 'anomaly_investigation'
  | 'trust_gap_review'
  | 'clarify';

export type MetadataAnswerRoute = 'certified' | 'generated_sql' | 'research' | 'clarify';

export type MetadataEvidenceRole =
  | 'exact_certified_answer'
  | 'certified_context'
  | 'semantic_metric'
  | 'business_context'
  | 'dbt_model'
  | 'warehouse_schema'
  | 'runtime_schema'
  | 'value_match'
  | 'prior_query_run'
  | 'selected_context'
  | 'skill_guidance'
  | 'other';

export interface RuntimeSchemaColumn {
  name: string;
  type?: string;
  description?: string;
  sampleValues?: string[];
}

export interface RuntimeSchemaTable {
  relation: string;
  schema?: string;
  name?: string;
  description?: string;
  columns: RuntimeSchemaColumn[];
  source?: string;
}

export interface RuntimeSchemaSnapshot {
  source?: string;
  capturedAt?: string;
  tables: RuntimeSchemaTable[];
}

export interface MetadataMissingContext {
  kind: 'metric' | 'table' | 'baseline' | 'dimension' | 'filter' | 'semantic' | 'value' | 'metadata';
  message: string;
  severity: 'warning' | 'blocking';
}

export interface MetadataAllowedSqlRelation {
  relation: string;
  name: string;
  objectKey?: string;
  source: string;
  columns: RuntimeSchemaColumn[];
}

export interface MetadataAllowedSqlContext {
  relations: MetadataAllowedSqlRelation[];
  sourceBlockSql: Array<{
    objectKey: string;
    name: string;
    status?: string;
    sql: string;
  }>;
}

export interface MetadataRouteDecision {
  route: MetadataAnswerRoute;
  intent: MetadataAgentIntent;
  reason: string;
  trustLabel: MetadataTrustLabel;
  reviewStatus: 'certified' | 'draft_ready' | 'needs_review' | 'none';
  exactObjectKey?: string;
  selectedEvidence: Array<{
    objectKey: string;
    objectType: string;
    name: string;
    role: MetadataEvidenceRole;
    reason: string;
  }>;
  missingContext: MetadataMissingContext[];
  followUps: string[];
}

export interface PlanAgentAnswerResult {
  contextPackId: string;
  contextPack: LocalContextPack;
  routeDecision: MetadataRouteDecision;
  evidenceRoles: LocalContextPack['evidenceRoles'];
  allowedSqlContext: MetadataAllowedSqlContext;
  missingContext: MetadataMissingContext[];
  warnings: string[];
  freshness: LocalContextPack['freshness'];
}

export interface LocalContextPack {
  id: string;
  question: string;
  followUp?: MetadataFollowUpContext;
  focusObjectKey: string | null;
  mode: 'question' | 'build' | 'debug' | 'certify' | 'impact' | 'explain';
  trustLabel: MetadataTrustLabel;
  objects: MetadataObject[];
  edges: MetadataEdge[];
  queryRuns: QueryRunSummary[];
  citations: Array<{
    objectKey: string;
    objectType: string;
    name: string;
    reason: string;
  }>;
  evidenceSummaries: Array<{
    title: string;
    detail: string;
    objectKey?: string;
    objectType?: string;
    reason: string;
  }>;
  warnings: string[];
  routeDecision: MetadataRouteDecision;
  evidenceRoles: Array<{
    objectKey: string;
    objectType: string;
    name: string;
    role: MetadataEvidenceRole;
    reason: string;
  }>;
  allowedSqlContext: MetadataAllowedSqlContext;
  missingContext: MetadataMissingContext[];
  conflicts: MetadataCandidateConflict[];
  retrievalDiagnostics: {
    strategy: 'sqlite_fts';
    selectedObjects: number;
    selectedEvidence: Array<{
      objectKey: string;
      objectType: string;
      name: string;
      reason: string;
      rank: number;
      score: number;
      priorityTier: string;
    }>;
    topRejected: Array<{
      objectKey: string;
      objectType: string;
      name: string;
      reason: string;
      score: number;
      rejectedRank: number;
    }>;
    candidateConflicts: MetadataCandidateConflict[];
  };
  freshness: {
    catalogPath: string;
    builtAt: string | null;
    fingerprint: string | null;
  };
}

export interface QueryRunSummary {
  id: string;
  objectKey?: string;
  source: 'sql_cell' | 'dql_block_cell' | 'semantic_metric_cell' | 'certified_block' | 'app_widget' | 'ai_draft' | string;
  status: string;
  rowCount?: number;
  durationMs?: number;
  errorCode?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
}

export interface MetadataCandidateConflict {
  objectType: string;
  objectKeys: string[];
  reason: string;
  prompt: string;
  candidates: Array<{
    objectKey: string;
    objectType: string;
    name: string;
    domain: string | null;
    status: string | null;
    rank: number;
    score: number;
    reason: string;
  }>;
}

interface RankedMetadataObject {
  row: MetadataObject;
  rank: number;
  score: number;
  reason: string;
  priorityTier: string;
}

const OBJECT_PRIORITY: Record<string, number> = {
  dql_block: 1,
  semantic_metric: 2,
  dql_term: 3,
  business_view: 4,
  semantic_dimension: 5,
  semantic_measure: 6,
  semantic_entity: 7,
  semantic_model: 8,
  dbt_model: 9,
  dbt_source: 10,
  dbt_column: 11,
  warehouse_table: 12,
  notebook: 13,
  dashboard: 14,
  app: 15,
  domain: 16,
};

export function defaultMetadataPath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'cache', 'metadata.sqlite');
}

export function openMetadataCatalog(projectRoot: string, dbPath = defaultMetadataPath(projectRoot)): MetadataCatalog {
  return new MetadataCatalog(dbPath);
}

export async function ensureMetadataCatalogFresh(
  projectRoot: string,
  options: EnsureMetadataCatalogOptions = {},
): Promise<EnsureMetadataCatalogResult> {
  const semanticLayer = options.semanticLayer !== undefined
    ? options.semanticLayer ?? undefined
    : loadAgentSemanticLayer(projectRoot);
  const manifest = options.manifest ?? loadAgentManifest(projectRoot);
  const snapshot = buildMetadataSnapshot(projectRoot, manifest, semanticLayer);
  const catalog = openMetadataCatalog(projectRoot);
  try {
    const existing = catalog.state('fingerprint');
    if (!options.force && existing === snapshot.fingerprint) {
      return {
        path: defaultMetadataPath(projectRoot),
        refreshed: false,
        objectCount: catalog.objectCount(),
        edgeCount: catalog.edgeCount(),
        diagnostics: catalog.diagnostics(),
        fingerprint: snapshot.fingerprint,
      };
    }
    catalog.rebuild(snapshot);
    return {
      path: defaultMetadataPath(projectRoot),
      refreshed: true,
      objectCount: snapshot.objects.length,
      edgeCount: snapshot.edges.length,
      diagnostics: snapshot.diagnostics,
      fingerprint: snapshot.fingerprint,
    };
  } finally {
    catalog.close();
  }
}

export function upsertMetadataSnapshot(projectRoot: string, snapshot: MetadataSnapshot): EnsureMetadataCatalogResult {
  const catalog = openMetadataCatalog(projectRoot);
  try {
    catalog.rebuild(snapshot);
    return {
      path: defaultMetadataPath(projectRoot),
      refreshed: true,
      objectCount: snapshot.objects.length,
      edgeCount: snapshot.edges.length,
      diagnostics: snapshot.diagnostics,
      fingerprint: snapshot.fingerprint,
    };
  } finally {
    catalog.close();
  }
}

export async function buildLocalContextPack(
  projectRoot: string,
  request: BuildLocalContextPackRequest,
): Promise<LocalContextPack> {
  await ensureMetadataCatalogFresh(projectRoot);
  const catalog = openMetadataCatalog(projectRoot);
  try {
    const mode = request.mode ?? 'question';
    const followUp = normalizeFollowUpContext(request.followUp);
    const runtimeSnapshot = request.runtimeSchemaSnapshot ?? catalog.latestRuntimeSchemaSnapshot();
    const runtimeObjects = runtimeSnapshot ? runtimeSchemaObjects(runtimeSnapshot) : [];
    const selectedObjects = selectedContextObjects(request.selectedContext);
    const followUpObjects = followUpContextObjects(followUp);
    const followUpSourceObjects = catalog.getObjectsByKeys(followUpSourceObjectKeys(followUp));
    const searchQuery = buildFollowUpSearchQuery(request.question, followUp);
    const searchRows = catalog.searchObjects({
      query: searchQuery,
      objectTypes: request.objectTypes,
      limit: Math.max(request.limit ?? 80, 20),
    });
    const exact = request.focusObjectKey ? catalog.getObject(request.focusObjectKey) : null;
    const ranked = rankMetadataObjects({
      rows: mergeObjects(exact
        ? [exact, ...followUpSourceObjects, ...followUpObjects, ...searchRows, ...runtimeObjects, ...selectedObjects]
        : [...followUpSourceObjects, ...followUpObjects, ...searchRows, ...runtimeObjects, ...selectedObjects]),
      question: searchQuery,
      limit: request.limit ?? 80,
    });
    const selected = mergeObjects([...followUpSourceObjects, ...followUpObjects, ...ranked.selected]);
    const focusObjectKey = request.focusObjectKey ?? selected[0]?.objectKey ?? null;
    const edgeWalk = catalog.edgesForKeys(selected.map((row) => row.objectKey), 3);
    const edgeObjectKeys = Array.from(new Set(edgeWalk.flatMap((edge) => [edge.fromKey, edge.toKey])));
    const graphObjects = catalog.getObjectsByKeys(edgeObjectKeys);
    const objects = rankMetadataObjects({
      rows: mergeObjects([...followUpSourceObjects, ...followUpObjects, ...selected, ...graphObjects, ...runtimeObjects, ...selectedObjects]),
      question: searchQuery,
      limit: request.limit ?? 120,
    }).selected;
    const objectKeys = objects.map((row) => row.objectKey);
    const queryRuns = catalog.queryRunsForObjectKeys(objectKeys, 20);
    const diagnostics = catalog.diagnostics();
    const warnings = buildWarnings(diagnostics, objects);
    const trustLabel = deriveTrust(objects);
    const citations = buildCitations(objects, edgeWalk);
    const evidenceSummaries = buildEvidenceSummaries(objects, edgeWalk, queryRuns, diagnostics);
    const allowedSqlContext = buildAllowedSqlContext(objects, edgeWalk);
    const evidenceRoles = buildEvidenceRoles(objects, queryRuns);
    const reranked = rankMetadataObjects({
      rows: mergeObjects([...searchRows, ...objects]),
      question: searchQuery,
      limit: request.limit ?? 120,
    });
    const conflicts = buildCandidateConflicts(reranked.ranked);
    const routeDecision = planContextPackRoute({
      request,
      objects,
      allowedSqlContext,
      evidenceRoles,
      diagnostics,
      trustLabel,
    });
    const payload: LocalContextPack = {
      id: '',
      question: request.question,
      followUp: followUp ?? undefined,
      focusObjectKey,
      mode,
      trustLabel,
      objects,
      edges: edgeWalk,
      queryRuns,
      citations,
      evidenceSummaries,
      warnings,
      routeDecision,
      evidenceRoles,
      allowedSqlContext,
      missingContext: routeDecision.missingContext,
      conflicts,
      retrievalDiagnostics: {
        strategy: 'sqlite_fts',
        selectedObjects: objects.length,
        selectedEvidence: reranked.ranked.slice(0, 20).map((item) => ({
          objectKey: item.row.objectKey,
          objectType: item.row.objectType,
          name: item.row.name,
          reason: item.reason,
          rank: item.rank,
          score: item.score,
          priorityTier: item.priorityTier,
        })),
        topRejected: reranked.rejected,
        candidateConflicts: conflicts,
      },
      freshness: {
        catalogPath: defaultMetadataPath(projectRoot),
        builtAt: catalog.state('built_at'),
        fingerprint: catalog.state('fingerprint'),
      },
    };
    const packPayload = { ...payload };
    delete (packPayload as Partial<LocalContextPack>).id;
    const id = catalog.insertContextPack(packPayload);
    return { ...payload, id };
  } finally {
    catalog.close();
  }
}

export async function planAgentAnswer(
  projectRoot: string,
  request: BuildLocalContextPackRequest,
): Promise<PlanAgentAnswerResult> {
  const contextPack = await buildLocalContextPack(projectRoot, request);
  return {
    contextPackId: contextPack.id,
    contextPack,
    routeDecision: contextPack.routeDecision,
    evidenceRoles: contextPack.evidenceRoles,
    allowedSqlContext: contextPack.allowedSqlContext,
    missingContext: contextPack.missingContext,
    warnings: contextPack.warnings,
    freshness: contextPack.freshness,
  };
}

export function recordQueryRun(projectRoot: string, run: Omit<QueryRunSummary, 'id'> & { id?: string }): QueryRunSummary {
  const catalog = openMetadataCatalog(projectRoot);
  try {
    return catalog.recordQueryRun(run);
  } finally {
    catalog.close();
  }
}

export function recordRuntimeSchemaSnapshot(projectRoot: string, snapshot: RuntimeSchemaSnapshot): RuntimeSchemaSnapshot {
  const catalog = openMetadataCatalog(projectRoot);
  try {
    return catalog.recordRuntimeSchemaSnapshot(snapshot);
  } finally {
    catalog.close();
  }
}

export function buildMetadataSnapshot(
  projectRoot: string,
  manifest: DQLManifest,
  semanticLayer?: SemanticLayer,
): MetadataSnapshot {
  const manifestGraph = buildKGFromManifest(manifest);
  const semanticGraph = buildKGFromSemanticLayer(semanticLayer);
  const objects = new Map<string, MetadataObject>();
  const edges = new Map<string, MetadataEdge>();
  const diagnostics: MetadataDiagnostic[] = [
    ...(manifest.diagnostics ?? []).map(manifestDiagnosticToMetadataDiagnostic),
  ];

  for (const node of [...manifestGraph.nodes, ...semanticGraph.nodes]) {
    const object = objectFromKGNode(node);
    const existing = objects.get(object.objectKey);
    if (existing) {
      diagnostics.push({
        kind: 'metadata',
        severity: 'warning',
        objectKey: object.objectKey,
        message: `duplicate metadata object key "${object.objectKey}" from ${existing.sourcePath ?? existing.sourceSystem ?? 'unknown'} and ${object.sourcePath ?? object.sourceSystem ?? 'unknown'}`,
      });
      objects.set(object.objectKey, mergeObject(existing, object));
    } else {
      objects.set(object.objectKey, object);
    }
  }

  addManifestBlockDetails(manifest, objects);
  addDbtDagObjects(manifest, objects, edges, diagnostics);
  addBlockDependencyEdges(manifest, edges);

  const nodeKeyMap = new Map<string, string>();
  for (const node of [...manifestGraph.nodes, ...semanticGraph.nodes]) {
    nodeKeyMap.set(node.nodeId, objectKeyFromKGNode(node));
  }
  for (const edge of [...manifestGraph.edges, ...semanticGraph.edges]) {
    const fromKey = nodeKeyMap.get(edge.src) ?? edge.src;
    const toKey = nodeKeyMap.get(edge.dst) ?? edge.dst;
    const normalized = normalizeEdge(edge, fromKey, toKey);
    const key = `${normalized.edgeType}\u0000${normalized.fromKey}\u0000${normalized.toKey}`;
    if (!edges.has(key)) edges.set(key, normalized);
  }

  addProjectDiagnostics(manifest, semanticLayer, diagnostics);

  const snapshot = {
    projectRoot,
    manifest,
    objects: Array.from(objects.values()).sort((a, b) => a.objectKey.localeCompare(b.objectKey)),
    edges: Array.from(edges.values()).sort((a, b) => `${a.edgeType}|${a.fromKey}|${a.toKey}`.localeCompare(`${b.edgeType}|${b.fromKey}|${b.toKey}`)),
    diagnostics,
    generatedAt: new Date().toISOString(),
    fingerprint: '',
  };
  snapshot.fingerprint = fingerprintSnapshot(snapshot);
  return snapshot;
}

export class MetadataCatalog {
  private readonly db: Database.Database;

  constructor(private readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const Database = loadDatabase();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata_objects (
        object_key    TEXT PRIMARY KEY,
        object_type   TEXT NOT NULL,
        name          TEXT NOT NULL,
        full_name     TEXT,
        domain        TEXT,
        owner         TEXT,
        status        TEXT,
        description   TEXT,
        source_path   TEXT,
        source_system TEXT,
        payload_json  TEXT NOT NULL DEFAULT '{}',
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metadata_objects_type ON metadata_objects(object_type);
      CREATE INDEX IF NOT EXISTS idx_metadata_objects_domain ON metadata_objects(domain);
      CREATE INDEX IF NOT EXISTS idx_metadata_objects_status ON metadata_objects(status);

      CREATE VIRTUAL TABLE IF NOT EXISTS metadata_fts USING fts5(
        object_key UNINDEXED,
        name,
        full_name,
        description,
        domain,
        owner,
        payload,
        tokenize = 'porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS metadata_edges (
        edge_type    TEXT NOT NULL,
        from_key     TEXT NOT NULL,
        to_key       TEXT NOT NULL,
        confidence   REAL NOT NULL DEFAULT 1.0,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at   TEXT NOT NULL,
        PRIMARY KEY (edge_type, from_key, to_key)
      );
      CREATE INDEX IF NOT EXISTS idx_metadata_edges_from ON metadata_edges(from_key, edge_type);
      CREATE INDEX IF NOT EXISTS idx_metadata_edges_to ON metadata_edges(to_key, edge_type);

      CREATE TABLE IF NOT EXISTS context_packs (
        id               TEXT PRIMARY KEY,
        question         TEXT NOT NULL,
        focus_object_key TEXT,
        mode             TEXT NOT NULL,
        trust_label      TEXT NOT NULL,
        payload_json     TEXT NOT NULL DEFAULT '{}',
        created_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_context_packs_created ON context_packs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_context_packs_focus ON context_packs(focus_object_key);

      CREATE TABLE IF NOT EXISTS query_runs (
        id           TEXT PRIMARY KEY,
        object_key   TEXT,
        source       TEXT NOT NULL,
        status       TEXT NOT NULL,
        row_count    INTEGER,
        duration_ms  INTEGER,
        error_code   TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_query_runs_object ON query_runs(object_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_query_runs_created ON query_runs(created_at DESC);

      CREATE TABLE IF NOT EXISTS runtime_schema_snapshots (
        id           TEXT PRIMARY KEY,
        source       TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        captured_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_schema_snapshots_captured ON runtime_schema_snapshots(captured_at DESC);

      CREATE TABLE IF NOT EXISTS metadata_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metadata_diagnostics (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        severity   TEXT NOT NULL CHECK (severity IN ('error', 'warning')),
        message    TEXT NOT NULL,
        object_key TEXT,
        file_path  TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metadata_diagnostics_severity ON metadata_diagnostics(severity);
    `);
  }

  rebuild(snapshot: MetadataSnapshot): void {
    const now = new Date().toISOString();
    const insertObject = this.db.prepare(`
      INSERT INTO metadata_objects (
        object_key, object_type, name, full_name, domain, owner, status,
        description, source_path, source_system, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO metadata_fts (object_key, name, full_name, description, domain, owner, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEdge = this.db.prepare(`
      INSERT OR IGNORE INTO metadata_edges (
        edge_type, from_key, to_key, confidence, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertDiagnostic = this.db.prepare(`
      INSERT INTO metadata_diagnostics (
        id, kind, severity, message, object_key, file_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const setState = this.db.prepare(`
      INSERT OR REPLACE INTO metadata_state (key, value) VALUES (?, ?)
    `);

    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM metadata_edges').run();
      this.db.prepare('DELETE FROM metadata_fts').run();
      this.db.prepare('DELETE FROM metadata_objects').run();
      this.db.prepare('DELETE FROM metadata_diagnostics').run();

      for (const object of snapshot.objects) {
        const payload = object.payload ?? {};
        insertObject.run(
          object.objectKey,
          object.objectType,
          object.name,
          object.fullName ?? null,
          object.domain ?? null,
          object.owner ?? null,
          object.status ?? null,
          object.description ?? null,
          object.sourcePath ?? null,
          object.sourceSystem ?? null,
          JSON.stringify(payload),
          object.updatedAt ?? now,
        );
        insertFts.run(
          object.objectKey,
          object.name,
          object.fullName ?? '',
          object.description ?? '',
          object.domain ?? '',
          object.owner ?? '',
          JSON.stringify(payload),
        );
      }

      for (const edge of snapshot.edges) {
        insertEdge.run(
          edge.edgeType,
          edge.fromKey,
          edge.toKey,
          edge.confidence ?? 1,
          JSON.stringify(edge.payload ?? {}),
          now,
        );
      }

      for (const diagnostic of snapshot.diagnostics) {
        insertDiagnostic.run(
          diagnosticId(diagnostic),
          diagnostic.kind,
          diagnostic.severity,
          diagnostic.message,
          diagnostic.objectKey ?? null,
          diagnostic.filePath ?? null,
          now,
        );
      }

      setState.run('built_at', now);
      setState.run('fingerprint', snapshot.fingerprint);
      setState.run('project_root', snapshot.projectRoot);
      setState.run('object_count', String(snapshot.objects.length));
      setState.run('edge_count', String(snapshot.edges.length));
      setState.run('diagnostics_json', JSON.stringify(snapshot.diagnostics));
      setState.run('manifest_generated_at', snapshot.manifest.generatedAt);
    });
    txn();
  }

  searchObjects(options: {
    query: string;
    objectTypes?: string[];
    domain?: string;
    limit?: number;
  }): MetadataObject[] {
    const { query, objectTypes, domain, limit = 40 } = options;
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return this.listObjects({ objectTypes, domain, limit });

    const filters: string[] = [];
    const params: unknown[] = [sanitized];
    if (objectTypes && objectTypes.length > 0) {
      filters.push(`o.object_type IN (${objectTypes.map(() => '?').join(', ')})`);
      params.push(...objectTypes);
    }
    if (domain) {
      filters.push('o.domain = ?');
      params.push(domain);
    }
    const whereExtra = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT o.*,
             bm25(metadata_fts) AS rank,
             snippet(metadata_fts, -1, '<mark>', '</mark>', '...', 12) AS snip
      FROM metadata_fts
      JOIN metadata_objects AS o ON o.object_key = metadata_fts.object_key
      WHERE metadata_fts MATCH ?${whereExtra}
      ORDER BY rank
      LIMIT ?
    `).all(...params, limit) as MetadataObjectRow[];

    return rows.map((row) => ({
      ...rowToObject(row),
      score: row.rank ? 1 / (1 + Math.max(0, row.rank)) : 1,
      snippet: row.snip ?? undefined,
    }));
  }

  listObjects(options: {
    objectTypes?: string[];
    domain?: string;
    limit?: number;
  } = {}): MetadataObject[] {
    const filters: string[] = [];
    const params: unknown[] = [];
    if (options.objectTypes && options.objectTypes.length > 0) {
      filters.push(`object_type IN (${options.objectTypes.map(() => '?').join(', ')})`);
      params.push(...options.objectTypes);
    }
    if (options.domain) {
      filters.push('domain = ?');
      params.push(options.domain);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT * FROM metadata_objects
      ${where}
      ORDER BY updated_at DESC, name
      LIMIT ?
    `).all(...params, options.limit ?? 100) as MetadataObjectRow[];
    return rows.map(rowToObject);
  }

  getObject(objectKey: string): MetadataObject | null {
    const row = this.db.prepare('SELECT * FROM metadata_objects WHERE object_key = ?').get(objectKey) as MetadataObjectRow | undefined;
    return row ? rowToObject(row) : null;
  }

  getObjectsByKeys(keys: string[]): MetadataObject[] {
    const unique = Array.from(new Set(keys.filter(Boolean)));
    if (unique.length === 0) return [];
    const rows: MetadataObject[] = [];
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100);
      const fetched = this.db.prepare(`
        SELECT * FROM metadata_objects
        WHERE object_key IN (${chunk.map(() => '?').join(', ')})
        ORDER BY name
      `).all(...chunk) as MetadataObjectRow[];
      rows.push(...fetched.map(rowToObject));
    }
    return rows;
  }

  edgesForKeys(keys: string[], hops = 1): MetadataEdge[] {
    let frontier = new Set(keys.filter(Boolean));
    const seenKeys = new Set(frontier);
    const edges = new Map<string, MetadataEdge>();
    for (let hop = 0; hop < hops && frontier.size > 0; hop += 1) {
      const current = Array.from(frontier).slice(0, 100);
      frontier = new Set();
      const rows = this.db.prepare(`
        SELECT * FROM metadata_edges
        WHERE from_key IN (${current.map(() => '?').join(', ')})
           OR to_key IN (${current.map(() => '?').join(', ')})
        LIMIT 500
      `).all(...current, ...current) as MetadataEdgeRow[];
      for (const row of rows) {
        const edge = rowToEdge(row);
        const edgeKey = `${edge.edgeType}\u0000${edge.fromKey}\u0000${edge.toKey}`;
        if (!edges.has(edgeKey)) edges.set(edgeKey, edge);
        for (const key of [edge.fromKey, edge.toKey]) {
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            frontier.add(key);
          }
        }
      }
    }
    return Array.from(edges.values());
  }

  insertContextPack(pack: Omit<LocalContextPack, 'id'>): string {
    const id = `ctx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO context_packs (
        id, question, focus_object_key, mode, trust_label, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      pack.question,
      pack.focusObjectKey,
      pack.mode,
      pack.trustLabel,
      JSON.stringify(pack),
      now,
    );
    return id;
  }

  recordQueryRun(run: Omit<QueryRunSummary, 'id'> & { id?: string }): QueryRunSummary {
    const id = run.id ?? `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = run.createdAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT OR REPLACE INTO query_runs (
        id, object_key, source, status, row_count, duration_ms, error_code, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      run.objectKey ?? null,
      run.source,
      run.status,
      run.rowCount ?? null,
      run.durationMs ?? null,
      run.errorCode ?? null,
      JSON.stringify(run.payload ?? {}),
      createdAt,
    );
    return { ...run, id, createdAt };
  }

  queryRunsForObjectKeys(keys: string[], limit = 20): QueryRunSummary[] {
    const unique = Array.from(new Set(keys.filter(Boolean)));
    if (unique.length === 0) return [];
    const rows = this.db.prepare(`
      SELECT * FROM query_runs
      WHERE object_key IN (${unique.slice(0, 80).map(() => '?').join(', ')})
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...unique.slice(0, 80), limit) as QueryRunRow[];
    return rows.map(rowToQueryRun);
  }

  recordRuntimeSchemaSnapshot(snapshot: RuntimeSchemaSnapshot): RuntimeSchemaSnapshot {
    const capturedAt = snapshot.capturedAt ?? new Date().toISOString();
    const cleanSnapshot: RuntimeSchemaSnapshot = {
      source: snapshot.source,
      capturedAt,
      tables: normalizeRuntimeSchemaTables(snapshot.tables).slice(0, 500),
    };
    const id = `schema_${Date.parse(capturedAt) || Date.now()}`;
    this.db.prepare(`
      INSERT OR REPLACE INTO runtime_schema_snapshots (
        id, source, payload_json, captured_at
      ) VALUES (?, ?, ?, ?)
    `).run(
      id,
      cleanSnapshot.source ?? null,
      JSON.stringify(cleanSnapshot),
      capturedAt,
    );
    return cleanSnapshot;
  }

  latestRuntimeSchemaSnapshot(): RuntimeSchemaSnapshot | null {
    const row = this.db.prepare(`
      SELECT payload_json
      FROM runtime_schema_snapshots
      ORDER BY captured_at DESC
      LIMIT 1
    `).get() as { payload_json: string } | undefined;
    return row ? safeRuntimeSchemaSnapshot(safeJson(row.payload_json, null)) : null;
  }

  getContextPack(id: string): LocalContextPack | null {
    const row = this.db.prepare('SELECT payload_json FROM context_packs WHERE id = ?').get(id) as { payload_json: string } | undefined;
    if (!row) return null;
    const payload = safeJson<Omit<LocalContextPack, 'id'> | null>(row.payload_json, null);
    return payload ? { ...payload, id } : null;
  }

  objectCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM metadata_objects').get() as { n: number };
    return row.n;
  }

  edgeCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM metadata_edges').get() as { n: number };
    return row.n;
  }

  diagnostics(): MetadataDiagnostic[] {
    const rows = this.db.prepare(`
      SELECT kind, severity, message, object_key, file_path
      FROM metadata_diagnostics
      ORDER BY severity, kind, message
    `).all() as Array<{
      kind: string;
      severity: 'error' | 'warning';
      message: string;
      object_key: string | null;
      file_path: string | null;
    }>;
    return rows.map((row) => ({
      kind: row.kind,
      severity: row.severity,
      message: row.message,
      objectKey: row.object_key ?? undefined,
      filePath: row.file_path ?? undefined,
    }));
  }

  state(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM metadata_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  close(): void {
    this.db.close();
  }
}

interface MetadataObjectRow {
  object_key: string;
  object_type: string;
  name: string;
  full_name: string | null;
  domain: string | null;
  owner: string | null;
  status: string | null;
  description: string | null;
  source_path: string | null;
  source_system: string | null;
  payload_json: string;
  updated_at: string;
  rank?: number;
  snip?: string | null;
}

interface MetadataEdgeRow {
  edge_type: string;
  from_key: string;
  to_key: string;
  confidence: number;
  payload_json: string;
}

interface QueryRunRow {
  id: string;
  object_key: string | null;
  source: string;
  status: string;
  row_count: number | null;
  duration_ms: number | null;
  error_code: string | null;
  payload_json: string;
  created_at: string;
}

function loadAgentManifest(projectRoot: string): DQLManifest {
  return buildManifest({
    projectRoot,
    dbtManifestPath: resolveDbtManifestPath(projectRoot) ?? undefined,
  });
}

function loadAgentSemanticLayer(projectRoot: string): SemanticLayer | undefined {
  try {
    const config = loadProjectConfig(projectRoot);
    const semanticConfig = config.semanticLayer?.provider
      ? (config.semanticLayer as Parameters<typeof resolveSemanticLayerWithDiagnostics>[0])
      : config.semanticLayer?.path
        ? { provider: 'dql' as const, path: config.semanticLayer.path }
        : undefined;
    const configured = resolveSemanticLayerWithDiagnostics(semanticConfig, projectRoot).layer;
    if (configured) return configured;

    if (config.dbt?.projectDir) {
      return resolveSemanticLayerWithDiagnostics({
        provider: 'dbt',
        projectPath: config.dbt.projectDir,
      }, projectRoot).layer ?? undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function manifestDiagnosticToMetadataDiagnostic(diagnostic: ManifestDiagnostic): MetadataDiagnostic {
  return {
    kind: diagnostic.kind,
    severity: diagnostic.severity,
    message: diagnostic.message,
    filePath: diagnostic.filePath,
  };
}

function objectFromKGNode(node: KGNode): MetadataObject {
  const payload: Record<string, unknown> = {
    kgNodeId: node.nodeId,
    tags: node.tags ?? [],
    examples: node.examples ?? [],
    sourceTier: node.sourceTier,
    certification: node.certification,
    provenance: node.provenance,
    freshness: node.freshness,
    businessOutcome: node.businessOutcome,
    businessOwner: node.businessOwner,
    decisionUse: node.decisionUse,
    reviewCadence: node.reviewCadence,
    businessRules: node.businessRules ?? [],
    caveats: node.caveats ?? [],
    llmContext: node.llmContext,
    referencedBy: node.referencedBy ?? [],
  };
  return {
    objectKey: objectKeyFromKGNode(node),
    objectType: objectTypeFromKGNode(node),
    name: node.name,
    fullName: node.name,
    domain: node.domain,
    owner: node.owner,
    status: node.status ?? node.certification,
    description: node.description ?? node.llmContext,
    sourcePath: node.sourcePath,
    sourceSystem: node.provenance ?? node.sourceTier,
    payload: compactObject(payload),
  };
}

function objectKeyFromKGNode(node: KGNode): string {
  switch (node.kind) {
    case 'block': return `dql:block:${node.name}`;
    case 'term': return `dql:term:${node.name}`;
    case 'business_view': return `dql:business_view:${node.name}`;
    case 'metric': return `semantic:metric:${node.name}`;
    case 'dimension': return `semantic:dimension:${node.name}`;
    case 'measure': return `semantic:measure:${node.name}`;
    case 'entity': return `semantic:entity:${node.name}`;
    case 'semantic_model': return `semantic:model:${node.name}`;
    case 'saved_query': return `semantic:saved_query:${node.name}`;
    case 'dbt_model': return `dbt:model:${node.name}`;
    case 'dbt_source':
      return node.sourceTier === 'dbt_manifest'
        ? `dbt:source:${node.name}`
        : `warehouse:table:${node.name}`;
    case 'notebook': return `notebook:${node.name}`;
    case 'dashboard': return `dashboard:${node.name}`;
    case 'app': return `app:${node.name}`;
    case 'domain': return `domain:${node.name}`;
    default: return `${node.kind}:${node.name}`;
  }
}

function objectTypeFromKGNode(node: KGNode): string {
  switch (node.kind) {
    case 'block': return 'dql_block';
    case 'term': return 'dql_term';
    case 'business_view': return 'business_view';
    case 'metric': return 'semantic_metric';
    case 'dimension': return 'semantic_dimension';
    case 'measure': return 'semantic_measure';
    case 'entity': return 'semantic_entity';
    case 'semantic_model': return 'semantic_model';
    case 'saved_query': return 'semantic_saved_query';
    case 'dbt_model': return 'dbt_model';
    case 'dbt_source': return node.sourceTier === 'dbt_manifest' ? 'dbt_source' : 'warehouse_table';
    case 'notebook': return 'notebook';
    case 'dashboard': return 'dashboard';
    case 'app': return 'app';
    case 'domain': return 'domain';
    default: return node.kind;
  }
}

function normalizeEdge(edge: KGEdge, fromKey: string, toKey: string): MetadataEdge {
  return {
    edgeType: edge.kind,
    fromKey,
    toKey,
    confidence: edge.weight ?? 1,
    payload: { kgSource: edge.src, kgTarget: edge.dst },
  };
}

function addDbtDagObjects(
  manifest: DQLManifest,
  objects: Map<string, MetadataObject>,
  edges: Map<string, MetadataEdge>,
  diagnostics: MetadataDiagnostic[],
): void {
  const models = manifest.dbtImport?.dbtDag?.models ?? [];
  for (const model of models) {
    const objectType = model.type === 'source' ? 'dbt_source' : 'dbt_model';
    const objectKey = `dbt:${model.type}:${model.name}`;
    const relation = [model.database, model.schema, model.name].filter(Boolean).join('.');
    const object: MetadataObject = {
      objectKey,
      objectType,
      name: model.name,
      fullName: relation || model.name,
      description: model.description,
      status: 'dbt_imported',
      sourceSystem: 'dbt manifest.json',
      payload: compactObject({
        uniqueId: model.uniqueId,
        relation,
        database: model.database,
        schema: model.schema,
        materialized: model.materialized,
        dependsOn: model.dependsOn,
        columns: model.columns ?? [],
      }),
    };
    objects.set(objectKey, mergeObject(objects.get(objectKey), object));
    for (const column of model.columns ?? []) {
      const columnKey = `dbt:column:${model.name}.${column.name}`;
      objects.set(columnKey, mergeObject(objects.get(columnKey), {
        objectKey: columnKey,
        objectType: 'dbt_column',
        name: column.name,
        fullName: `${model.name}.${column.name}`,
        description: column.description,
        status: 'dbt_imported',
        sourceSystem: 'dbt manifest.json',
        payload: compactObject({
          model: model.name,
          uniqueId: model.uniqueId,
          type: column.type,
          relation,
        }),
      }));
      const edge = {
        edgeType: 'contains',
        fromKey: objectKey,
        toKey: columnKey,
        confidence: 1,
        payload: { source: 'dbt manifest column' },
      };
      edges.set(`${edge.edgeType}\u0000${edge.fromKey}\u0000${edge.toKey}`, edge);
    }
    for (const dep of model.dependsOn ?? []) {
      const edge = {
        edgeType: 'depends_on',
        fromKey: objectKey,
        toKey: dbtDependencyKey(dep),
        confidence: 1,
        payload: { source: 'dbt manifest depends_on', uniqueId: dep },
      };
      edges.set(`${edge.edgeType}\u0000${edge.fromKey}\u0000${edge.toKey}`, edge);
    }
  }

  if (manifest.dbtImport && (manifest.dbtImport.totalDbtModels ?? 0) > 0 && manifest.dbtImport.modelsImported === 0) {
    diagnostics.push({
      kind: 'dbt',
      severity: 'warning',
      message: `dbt manifest loaded from ${manifest.dbtImport.manifestPath}, but 0 of ${manifest.dbtImport.totalDbtModels} models matched DQL table references. Check database/schema aliases or dbtImport anchors.`,
    });
  }
}

function addManifestBlockDetails(manifest: DQLManifest, objects: Map<string, MetadataObject>): void {
  for (const block of Object.values(manifest.blocks ?? {})) {
    const objectKey = `dql:block:${block.name}`;
    const existing = objects.get(objectKey);
    if (!existing) continue;
    objects.set(objectKey, mergeObject(existing, {
      ...existing,
      payload: compactObject({
        ...(existing.payload ?? {}),
        sql: block.sql,
        tableDependencies: block.tableDependencies,
        rawTableRefs: block.rawTableRefs,
        refDependencies: block.refDependencies,
        metricRefs: block.metricRefs,
        dimensionRefs: block.dimensionRefs,
        chartType: block.chartType,
        blockType: block.blockType,
        tests: block.tests,
        draftMetadata: block.draftMetadata,
      }),
    }));
  }
}

function addBlockDependencyEdges(manifest: DQLManifest, edges: Map<string, MetadataEdge>): void {
  const dbtLookup = buildDbtModelLookup(manifest);
  for (const block of Object.values(manifest.blocks ?? {})) {
    const blockKey = `dql:block:${block.name}`;
    for (const table of block.tableDependencies ?? []) {
      const tableKey = `warehouse:table:${table}`;
      putEdge(edges, {
        edgeType: 'uses_table',
        fromKey: blockKey,
        toKey: tableKey,
        confidence: 1,
        payload: { source: 'dql block table dependency', tableReference: table },
      });

      const dbtKey = resolveDbtModelKeyForTable(table, dbtLookup);
      if (!dbtKey) continue;
      putEdge(edges, {
        edgeType: 'uses_dbt_model',
        fromKey: blockKey,
        toKey: dbtKey,
        confidence: 0.86,
        payload: { source: 'dql table dependency matched to dbt model', tableReference: table },
      });
      putEdge(edges, {
        edgeType: 'maps_to_dbt_model',
        fromKey: tableKey,
        toKey: dbtKey,
        confidence: 0.86,
        payload: { source: 'warehouse table name matched to dbt model', tableReference: table },
      });
    }
  }
}

function putEdge(edges: Map<string, MetadataEdge>, edge: MetadataEdge): void {
  edges.set(`${edge.edgeType}\u0000${edge.fromKey}\u0000${edge.toKey}`, edge);
}

function buildDbtModelLookup(manifest: DQLManifest): Map<string, Set<string>> {
  const lookup = new Map<string, Set<string>>();
  const add = (key: string, objectKey: string) => {
    const normalized = key.toLowerCase();
    const existing = lookup.get(normalized);
    if (existing) existing.add(objectKey);
    else lookup.set(normalized, new Set([objectKey]));
  };
  for (const model of manifest.dbtImport?.dbtDag?.models ?? []) {
    if (model.type !== 'model') continue;
    const objectKey = `dbt:model:${model.name}`;
    for (const key of dbtModelLookupKeys(model.name, model.schema, model.database)) {
      add(key, objectKey);
    }
  }
  return lookup;
}

function resolveDbtModelKeyForTable(tableRef: string, lookup: Map<string, Set<string>>): string | undefined {
  for (const key of tableReferenceLookupKeys(tableRef)) {
    const matches = lookup.get(key);
    if (matches?.size === 1) return [...matches][0];
  }
  return undefined;
}

function dbtModelLookupKeys(name: string, schema?: string, database?: string): string[] {
  const aliases = new Set([name.toLowerCase()]);
  const stripped = stripCommonDbtPrefix(name);
  if (stripped) aliases.add(stripped);
  const keys = new Set<string>();
  for (const alias of aliases) {
    keys.add(alias);
    if (schema) keys.add(`${schema}.${alias}`.toLowerCase());
    if (schema && database) keys.add(`${database}.${schema}.${alias}`.toLowerCase());
  }
  return [...keys];
}

function tableReferenceLookupKeys(tableRef: string): string[] {
  const normalized = tableRef.replace(/["`]/g, '').toLowerCase();
  const parts = normalized.split('.').filter(Boolean);
  const keys = new Set<string>([normalized]);
  if (parts.length >= 2) keys.add(parts.slice(-2).join('.'));
  const last = parts.at(-1);
  if (last) keys.add(last);
  return [...keys];
}

function stripCommonDbtPrefix(name: string): string | undefined {
  const match = /^(?:src|stg|int|dim|fct)_(.+)$/i.exec(name);
  return match?.[1]?.toLowerCase();
}

function dbtDependencyKey(uniqueId: string): string {
  const parts = uniqueId.split('.');
  const kind = parts[0] === 'source' ? 'source' : 'model';
  const name = parts.at(-1) ?? uniqueId;
  return `dbt:${kind}:${name}`;
}

function addProjectDiagnostics(
  manifest: DQLManifest,
  semanticLayer: SemanticLayer | undefined,
  diagnostics: MetadataDiagnostic[],
): void {
  const semanticCount =
    Object.keys(manifest.metrics ?? {}).length +
    Object.keys(manifest.dimensions ?? {}).length +
    (semanticLayer?.listMetrics().length ?? 0) +
    (semanticLayer?.listDimensions().length ?? 0) +
    (semanticLayer?.listSemanticModels().length ?? 0);
  if (semanticCount === 0) {
    diagnostics.push({
      kind: 'semantic',
      severity: 'warning',
      message: 'No semantic metrics or dimensions were found. Agents can use DQL/dbt/warehouse metadata, but semantic metric answers require metric definitions.',
    });
  }
}

function planContextPackRoute(input: {
  request: BuildLocalContextPackRequest;
  objects: MetadataObject[];
  allowedSqlContext: MetadataAllowedSqlContext;
  evidenceRoles: LocalContextPack['evidenceRoles'];
  diagnostics: MetadataDiagnostic[];
  trustLabel: MetadataTrustLabel;
}): MetadataRouteDecision {
  const intent = input.request.intent ?? classifyMetadataIntent(input.request.question, input.request.followUp);
  const exact = findExactCertifiedObject(input.request.question, intent, input.objects);
  const exactExampleMatch = exact ? hasExactExampleQuestion(input.request.question, exact) : false;
  const missingContext = buildMissingContext(input.request, intent, input.objects, input.allowedSqlContext);
  const selectedEvidence = input.evidenceRoles.slice(0, 16);

  if (exact && (
    intent === 'exact_certified_lookup'
    || intent === 'definition_lookup'
    || exactExampleMatch
    || (intent === 'ad_hoc_ranking' && objectNameInQuestion(input.request.question, exact))
  )) {
    return {
      route: 'certified',
      intent,
      reason: `Certified ${exact.objectType.replace(/_/g, ' ')} "${exact.name}" exactly matches the requested artifact, definition, or direct KPI grain.`,
      trustLabel: 'certified',
      reviewStatus: 'certified',
      exactObjectKey: exact.objectKey,
      selectedEvidence,
      missingContext: [],
      followUps: buildMetadataFollowUps(intent, input.allowedSqlContext),
    };
  }

  if (intent === 'trust_gap_review') {
    if (input.objects.length === 0) {
      return clarifyDecision(intent, input.trustLabel, selectedEvidence, [{
        kind: 'metadata',
        severity: 'blocking',
        message: 'No local metadata matched this trust question. Re-run dql compile or connect the relevant DQL/dbt project before reviewing trust.',
      }]);
    }
    return {
      route: 'research',
      intent,
      reason: 'Trust questions need a certification, lineage, owner, caveat, and diagnostic review rather than a metric SQL preview.',
      trustLabel: input.trustLabel,
      reviewStatus: 'needs_review',
      selectedEvidence,
      missingContext,
      followUps: buildMetadataFollowUps(intent, input.allowedSqlContext),
    };
  }

  if (intent === 'clarify' || missingContext.some((item) => item.severity === 'blocking')) {
    return clarifyDecision(intent, input.trustLabel, selectedEvidence, missingContext);
  }

  const canGenerate =
    input.allowedSqlContext.relations.length > 0 ||
    input.allowedSqlContext.sourceBlockSql.length > 0 ||
    input.objects.some((object) => object.objectType.startsWith('semantic_'));

  if (canGenerate && isGeneratedMetadataIntent(intent)) {
    return {
      route: 'generated_sql',
      intent,
      reason: 'The question asks for a different grain, ranking, breakdown, comparison, entity drilldown, or diagnostic analysis, so certified artifacts are context only.',
      trustLabel: input.trustLabel === 'certified' ? 'mixed' : input.trustLabel,
      reviewStatus: 'draft_ready',
      selectedEvidence,
      missingContext,
      followUps: buildMetadataFollowUps(intent, input.allowedSqlContext),
    };
  }

  if (exact) {
    return {
      route: 'certified',
      intent: 'exact_certified_lookup',
      reason: `Certified artifact "${exact.name}" is the closest safe direct answer.`,
      trustLabel: 'certified',
      reviewStatus: 'certified',
      exactObjectKey: exact.objectKey,
      selectedEvidence,
      missingContext: [],
      followUps: buildMetadataFollowUps('exact_certified_lookup', input.allowedSqlContext),
    };
  }

  return clarifyDecision(intent, input.trustLabel, selectedEvidence, missingContext.length > 0 ? missingContext : [{
    kind: 'metadata',
    severity: 'blocking',
    message: 'The local metadata matched some context, but not enough to choose a safe metric, table, or grain.',
  }]);
}

function clarifyDecision(
  intent: MetadataAgentIntent,
  trustLabel: MetadataTrustLabel,
  selectedEvidence: MetadataRouteDecision['selectedEvidence'],
  missingContext: MetadataMissingContext[],
): MetadataRouteDecision {
  return {
    route: 'clarify',
    intent,
    reason: 'DQL needs one more business or metadata detail before it can safely generate SQL.',
    trustLabel,
    reviewStatus: 'none',
    selectedEvidence,
    missingContext: missingContext.length > 0 ? missingContext : [{
      kind: 'metadata',
      severity: 'blocking',
      message: 'No certified block, semantic metric, dbt model, or runtime schema matched strongly enough to answer safely.',
    }],
    followUps: [
      'Which metric should define the answer?',
      'Which table or certified block should be used as the source?',
      'What filter or time period should apply?',
    ],
  };
}

function classifyMetadataIntent(question: string, followUp?: unknown): MetadataAgentIntent {
  const follow = followUp && typeof followUp === 'object' ? followUp as Record<string, unknown> : null;
  if (follow?.kind === 'drilldown') return 'entity_drilldown';
  const lower = question.toLowerCase();
  if (/\b(trust|rely|certif|lineage|owner|caveat|gap|governance)\b/.test(lower)) return 'trust_gap_review';
  if (/\b(define|definition|meaning of|what is|what are|what does .+ mean)\b/.test(lower)) return 'definition_lookup';
  if (/\b(anomal|exception|outlier|spike|dip)\b/.test(lower)) return 'anomaly_investigation';
  if (/\b(compare|versus|vs\.?|segment|cohort)\b/.test(lower)) return 'segment_compare';
  if (/\b(why|changed?|change|drop|dropped|decline|declined|increase|increased|decrease|decreased|delta|variance|what happened)\b/.test(lower)) return 'diagnose_change';
  if (/\b(driver|drivers|drove|break\s*down|breakdown|contribute|contribution|top movers?)\b/.test(lower)) return 'driver_breakdown';
  if (isEntityQuestion(question)) return 'entity_drilldown';
  if (/\b(top|bottom|best|worst|highest|lowest|least|fewest|minimum|min|maximum|max|rank|ranking|most)\b/.test(lower)) return 'ad_hoc_ranking';
  if (/\b(block|certified|saved|existing|approved|governed)\b/.test(lower)) return 'exact_certified_lookup';
  if (isDirectKpiValueQuestion(question)) return 'exact_certified_lookup';
  if (/\b(show|list|find|which|who|how many|how much|metric|kpi|dashboard|performance|revenue|sales|points|goals|orders|customers|users)\b/.test(lower)) return 'ad_hoc_ranking';
  return 'clarify';
}

function isGeneratedMetadataIntent(intent: MetadataAgentIntent): boolean {
  return intent === 'ad_hoc_ranking'
    || intent === 'driver_breakdown'
    || intent === 'diagnose_change'
    || intent === 'segment_compare'
    || intent === 'entity_drilldown'
    || intent === 'anomaly_investigation';
}

function findExactCertifiedObject(question: string, intent: MetadataAgentIntent, objects: MetadataObject[]): MetadataObject | undefined {
  const candidates = objects.filter((object) => isCertifiedMetadataObject(object));
  if (intent === 'definition_lookup') {
    return candidates.find((object) => object.objectType === 'dql_term' || object.objectType === 'business_view')
      ?? candidates.find((object) => object.objectType === 'dql_block' && objectNameInQuestion(question, object));
  }
  const namedExact = candidates.find((object) =>
    object.objectType === 'dql_block' &&
    objectNameInQuestion(question, object) &&
    hasCompatibleMetadataRankingDirection(question, object)
  );
  if (namedExact) return namedExact;
  const exampleExact = candidates.find((object) =>
    object.objectType === 'dql_block' &&
    hasExactExampleQuestion(question, object) &&
    hasCompatibleMetadataRankingDirection(question, object)
  );
  if (exampleExact) return exampleExact;
  if (isGeneratedMetadataIntent(intent)) return undefined;
  return candidates.find((object) =>
    object.objectType === 'dql_block' &&
    objectNameInQuestion(question, object) &&
    hasCompatibleMetadataRankingDirection(question, object),
  ) ?? candidates.find((object) =>
    object.objectType === 'dql_block' &&
    hasMeaningfulObjectOverlap(question, object) &&
    hasCompatibleMetadataRankingDirection(question, object) &&
    !looksLikeDifferentGrainQuestion(question),
  );
}

function isCertifiedMetadataObject(object: MetadataObject): boolean {
  return object.status === 'certified' || object.status === 'approved' || object.payload?.certification === 'certified';
}

function objectNameInQuestion(question: string, object: MetadataObject): boolean {
  const q = normalizeSearchText(question);
  const name = normalizeSearchText(object.name);
  const fullName = normalizeSearchText(object.fullName ?? '');
  return Boolean(name && q.includes(name)) || Boolean(fullName && q.includes(fullName));
}

function hasExactExampleQuestion(question: string, object: MetadataObject): boolean {
  const q = normalizeSearchText(question);
  if (!q) return false;
  const examples = Array.isArray(object.payload?.examples) ? object.payload.examples : [];
  return examples.some((example) =>
    example &&
    typeof example === 'object' &&
    normalizeSearchText(String((example as { question?: unknown }).question ?? '')) === q,
  );
}

function hasMeaningfulObjectOverlap(question: string, object: MetadataObject): boolean {
  const terms = new Set(tokenize(question));
  if (terms.size === 0) return false;
  const haystack = tokenize([
    object.name,
    object.fullName ?? '',
    object.domain ?? '',
    object.description ?? '',
    JSON.stringify(object.payload ?? {}),
  ].join(' '));
  return haystack.some((term) => terms.has(term));
}

function looksLikeDifferentGrainQuestion(question: string): boolean {
  return /\b(for|where|only|specific|single|individual|named|called|by|break\s*down|breakdown|drill|compare|versus|vs\.?|segment|least|lowest|fewest|bottom|why|changed?|driver|anomal|exception)\b/i.test(question);
}

function isDirectKpiValueQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  if (/\b(by|break\s*down|breakdown|drill|compare|versus|vs\.?|segment|cohort|top|bottom|best|worst|highest|lowest|least|fewest|rank|ranking|most|why|changed?|driver|anomal|exception)\b/.test(lower)) {
    return false;
  }
  if (isEntityQuestion(question)) return false;
  const asksForValue = /\b(what\s+(?:is|was|were|are)|how\s+(?:much|many)|show|report|calculate|give\s+me|tell\s+me)\b/.test(lower);
  const metricLanguage = /\b(revenue|sales|arr|mrr|bookings|orders|customers|users|churn|retention|conversion|rate|count|total|points|goals|kpi|metric)\b/.test(lower);
  return asksForValue && metricLanguage;
}

function hasCompatibleMetadataRankingDirection(question: string, object: MetadataObject): boolean {
  const questionDirection = rankingDirection(question);
  if (!questionDirection) return true;
  const objectDirection = rankingDirection([
    object.name,
    object.description ?? '',
    JSON.stringify(object.payload ?? {}),
  ].join(' '));
  if (!objectDirection) return true;
  return questionDirection === objectDirection;
}

function rankingDirection(text: string): 'top' | 'bottom' | undefined {
  const lower = text.toLowerCase();
  const bottom = /\b(bottom|least|fewest|lowest|minimum|min|smallest|worst|underperform(?:ing|ed|er|ers)?)\b/.test(lower);
  const top = /\b(top|most|highest|maximum|max|greatest|best|leader|leaders|leading)\b/.test(lower);
  if (bottom && !top) return 'bottom';
  if (top && !bottom) return 'top';
  return undefined;
}

function buildMissingContext(
  request: BuildLocalContextPackRequest,
  intent: MetadataAgentIntent,
  objects: MetadataObject[],
  allowedSqlContext: MetadataAllowedSqlContext,
): MetadataMissingContext[] {
  const missing: MetadataMissingContext[] = [];
  const hasSqlContext = allowedSqlContext.relations.length > 0 || allowedSqlContext.sourceBlockSql.length > 0;
  if (isGeneratedMetadataIntent(intent) && !hasSqlContext && !objects.some((object) => object.objectType.startsWith('semantic_'))) {
    missing.push({
      kind: 'table',
      severity: 'blocking',
      message: 'No dbt model, warehouse/runtime table, semantic metric, or certified block SQL was available for this generated answer.',
    });
  }
  if (intent === 'diagnose_change' && !hasComparableBaselineContext(request, objects, allowedSqlContext)) {
    missing.push({
      kind: 'baseline',
      severity: 'blocking',
      message: 'No comparable time/baseline field or selected tile history was found, so DQL needs the baseline period before explaining what changed.',
    });
  }
  if ((intent === 'definition_lookup' || intent === 'trust_gap_review') && objects.length === 0) {
    missing.push({
      kind: 'metadata',
      severity: 'blocking',
      message: 'No certified term, business view, block, dashboard, app, or lineage metadata matched this question.',
    });
  }
  return missing;
}

function hasComparableBaselineContext(
  request: BuildLocalContextPackRequest,
  objects: MetadataObject[],
  allowedSqlContext: MetadataAllowedSqlContext,
): boolean {
  if (request.focusObjectKey) {
    const focus = objects.find((object) => object.objectKey === request.focusObjectKey);
    if (focus) {
      const dependencyKeys = new Set([
        ...metadataStringArray(focus.payload?.tableDependencies),
        ...metadataStringArray(focus.payload?.rawTableRefs),
      ].flatMap((relation) => relationLookupKeysForCatalog(relation)));
      const focusedRelations = dependencyKeys.size > 0
        ? allowedSqlContext.relations.filter((relation) => relationLookupKeysForCatalog(relation.relation).some((key) => dependencyKeys.has(key)))
        : [];
      const focusTextHasBaseline = /\b(date|time|day|week|month|quarter|year|season|period|baseline|history|snapshot)\b/i.test([
        focus.name,
        focus.description ?? '',
        String(focus.payload?.sql ?? ''),
      ].join(' '));
      return focusTextHasBaseline || focusedRelations.some((relation) => relation.columns.some((column) => isTimeLikeColumn(column.name)));
    }
  }
  if (allowedSqlContext.relations.some((relation) => relation.columns.some((column) => isTimeLikeColumn(column.name)))) return true;
  const rows = selectedRows(request.selectedContext);
  if (rows.length < 2) return false;
  const columns = new Set(rows.flatMap((row) => Object.keys(row)));
  for (const column of columns) {
    if (!isTimeLikeColumn(column)) continue;
    const values = new Set(rows.map((row) => row[column]).filter((value) => value !== null && value !== undefined).map(String));
    if (values.size >= 2) return true;
  }
  return false;
}

function relationLookupKeysForCatalog(relation: string): string[] {
  const normalized = normalizeRelationKey(relation);
  const parts = normalized.split('.').filter(Boolean);
  const keys = new Set<string>();
  if (normalized) keys.add(normalized);
  if (parts.length >= 2) keys.add(parts.slice(-2).join('.'));
  if (parts.length >= 1) keys.add(parts[parts.length - 1]!);
  return Array.from(keys);
}

function isTimeLikeColumn(name: string): boolean {
  return /\b(date|time|day|week|month|quarter|year|season|period|created_at|updated_at)\b/i.test(name);
}

function selectedRows(value: unknown): Array<Record<string, unknown>> {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const selected = root?.selectedBlock && typeof root.selectedBlock === 'object' ? root.selectedBlock as Record<string, unknown> : root;
  const candidates = [
    selected?.resultSample,
    selected?.rows,
    selected?.sampleRows,
    root?.resultSample,
    root?.rows,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    return candidate.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
  }
  return [];
}

function buildMetadataFollowUps(intent: MetadataAgentIntent, allowedSqlContext: MetadataAllowedSqlContext): string[] {
  if (intent === 'clarify') return ['Pick the metric', 'Pick the source table', 'Pick the time window'];
  if (intent === 'trust_gap_review') return ['Show lineage', 'List caveats', 'Create a certified replacement block'];
  const relation = allowedSqlContext.relations[0];
  const dimension = relation?.columns.find((column) => /(segment|type|name|team|player|customer|product|region)/i.test(column.name))?.name ?? 'segment';
  return [
    `Break down by ${dimension}`,
    'Show the trend over time',
    'Save as a draft block for review',
  ];
}

function buildEvidenceRoles(objects: MetadataObject[], queryRuns: QueryRunSummary[]): LocalContextPack['evidenceRoles'] {
  const roles = objects.slice(0, 40).map((object) => ({
    objectKey: object.objectKey,
    objectType: object.objectType,
    name: object.name,
    role: evidenceRoleForObject(object),
    reason: evidenceReasonForObject(object),
  }));
  for (const run of queryRuns.slice(0, 8)) {
    if (!run.objectKey) continue;
    roles.push({
      objectKey: run.objectKey,
      objectType: 'query_run',
      name: run.payload?.question && typeof run.payload.question === 'string' ? run.payload.question : run.id,
      role: 'prior_query_run',
      reason: `Prior query run status: ${run.status}`,
    });
  }
  return roles;
}

function evidenceRoleForObject(object: MetadataObject): MetadataEvidenceRole {
  if (object.objectType === 'dql_block' && isCertifiedMetadataObject(object)) return 'certified_context';
  if (object.objectType === 'semantic_metric') return 'semantic_metric';
  if (object.objectType === 'dql_term' || object.objectType === 'business_view') return 'business_context';
  if (object.objectType === 'dbt_model' || object.objectType === 'dbt_source' || object.objectType === 'dbt_column') return 'dbt_model';
  if (object.objectType === 'warehouse_table') return 'warehouse_schema';
  if (object.objectType === 'runtime_table' || object.objectType === 'runtime_column') return 'runtime_schema';
  if (object.objectType === 'selected_context') return 'selected_context';
  if (object.objectType === 'skill') return 'skill_guidance';
  return 'other';
}

function evidenceReasonForObject(object: MetadataObject): string {
  if (object.objectType === 'dql_block' && isCertifiedMetadataObject(object)) return 'Certified block can be exact answer only when grain matches; otherwise it is context.';
  if (object.objectType.startsWith('semantic_')) return 'Semantic definition can ground metric and dimension meaning.';
  if (object.objectType.startsWith('dbt_')) return 'dbt metadata supplies physical model and column context.';
  if (object.objectType === 'runtime_table' || object.objectType === 'runtime_column') return 'Runtime schema supplies executable table and column context.';
  return reasonForObject(object);
}

function buildAllowedSqlContext(objects: MetadataObject[], edges: MetadataEdge[]): MetadataAllowedSqlContext {
  const byRelation = new Map<string, MetadataAllowedSqlRelation>();
  const objectsByKey = new Map(objects.map((object) => [object.objectKey, object]));
  const addRelation = (relation: MetadataAllowedSqlRelation) => {
    const key = normalizeRelationKey(relation.relation);
    if (!key) return;
    const existing = byRelation.get(key);
    if (!existing) {
      byRelation.set(key, { ...relation, columns: dedupeRuntimeColumns(relation.columns).slice(0, 120) });
      return;
    }
    byRelation.set(key, {
      ...existing,
      objectKey: existing.objectKey ?? relation.objectKey,
      source: existing.source === relation.source ? existing.source : 'local metadata catalog',
      columns: dedupeRuntimeColumns([...existing.columns, ...relation.columns]).slice(0, 120),
    });
  };

  for (const object of objects) {
    if (object.objectType === 'warehouse_table' && !warehouseTableHasTrustedReference(object, objectsByKey)) {
      continue;
    }
    const relation = metadataRelationFromObject(object);
    if (relation) addRelation(relation);
    if (object.objectType === 'dql_block' && !isCertifiedMetadataObject(object)) {
      continue;
    }
    for (const table of metadataStringArray(object.payload?.tableDependencies)) {
      addRelation({
        relation: table,
        name: table.split('.').at(-1) ?? table,
        objectKey: object.objectKey,
        source: 'certified block dependency',
        columns: [],
      });
    }
    for (const table of metadataStringArray(object.payload?.rawTableRefs)) {
      addRelation({
        relation: table,
        name: table.split('.').at(-1) ?? table,
        objectKey: object.objectKey,
        source: 'certified block SQL reference',
        columns: [],
      });
    }
  }

  for (const edge of edges) {
    if (edge.edgeType !== 'maps_to_dbt_model' && edge.edgeType !== 'uses_dbt_model') continue;
    const from = objectsByKey.get(edge.fromKey);
    const to = objectsByKey.get(edge.toKey);
    const fromRelation = from ? metadataRelationFromObject(from) : null;
    const toRelation = to ? metadataRelationFromObject(to) : null;
    if (fromRelation && toRelation) addRelation({ ...fromRelation, columns: toRelation.columns, source: 'dbt mapped warehouse table' });
  }

  return {
    relations: Array.from(byRelation.values()).sort((a, b) => a.relation.localeCompare(b.relation)),
    sourceBlockSql: objects
      .filter((object) =>
        object.objectType === 'dql_block' &&
        isCertifiedMetadataObject(object) &&
        typeof object.payload?.sql === 'string' &&
        object.payload.sql.trim())
      .slice(0, 8)
      .map((object) => ({
        objectKey: object.objectKey,
        name: object.name,
        status: object.status,
        sql: String(object.payload?.sql ?? ''),
      })),
  };
}

function warehouseTableHasTrustedReference(
  object: MetadataObject,
  objectsByKey: Map<string, MetadataObject>,
): boolean {
  const refs = metadataStringArray(object.payload?.referencedBy);
  if (refs.length === 0) return true;
  if (refs.some((ref) => !ref.startsWith('block:'))) return true;
  return refs.some((ref) => {
    const blockName = ref.slice('block:'.length);
    const block = objectsByKey.get(`dql:block:${blockName}`);
    return block ? isCertifiedMetadataObject(block) : false;
  });
}

function metadataRelationFromObject(object: MetadataObject): MetadataAllowedSqlRelation | null {
  if (object.objectType === 'dbt_column' || object.objectType === 'runtime_column') {
    const relation = metadataPayloadString(object, 'relation');
    if (!relation) return null;
    return {
      relation,
      name: relation.split('.').at(-1) ?? relation,
      objectKey: object.objectKey,
      source: object.objectType === 'runtime_column' ? 'runtime schema snapshot' : 'dbt manifest',
      columns: [{
        name: object.name,
        type: metadataPayloadString(object, 'type') ?? metadataPayloadString(object, 'data_type'),
        description: object.description,
        sampleValues: metadataStringArray(object.payload?.sampleValues),
      }],
    };
  }
  if (!['dbt_model', 'dbt_source', 'warehouse_table', 'runtime_table'].includes(object.objectType)) return null;
  const relation = metadataPayloadString(object, 'relation') ?? object.fullName ?? object.name;
  return {
    relation,
    name: relation.split('.').at(-1) ?? object.name,
    objectKey: object.objectKey,
    source: object.objectType === 'runtime_table' ? 'runtime schema snapshot' : object.sourceSystem ?? 'local metadata catalog',
    columns: metadataRuntimeColumns(object.payload?.columns),
  };
}

function runtimeSchemaObjects(snapshot: RuntimeSchemaSnapshot): MetadataObject[] {
  const capturedAt = snapshot.capturedAt ?? new Date().toISOString();
  return normalizeRuntimeSchemaTables(snapshot.tables).flatMap((table) => {
    const relation = table.relation;
    const tableKey = `runtime:table:${relation}`;
    const tableObject: MetadataObject = {
      objectKey: tableKey,
      objectType: 'runtime_table',
      name: table.name ?? relation.split('.').at(-1) ?? relation,
      fullName: relation,
      description: table.description,
      status: 'runtime_observed',
      sourceSystem: snapshot.source ?? table.source ?? 'runtime schema snapshot',
      payload: compactObject({
        relation,
        schema: table.schema,
        columns: table.columns,
      }),
      updatedAt: capturedAt,
    };
    const columns = table.columns.map((column) => ({
      objectKey: `runtime:column:${relation}.${column.name}`,
      objectType: 'runtime_column',
      name: column.name,
      fullName: `${relation}.${column.name}`,
      description: column.description,
      status: 'runtime_observed',
      sourceSystem: snapshot.source ?? table.source ?? 'runtime schema snapshot',
      payload: compactObject({
        relation,
        type: column.type,
        sampleValues: column.sampleValues,
      }),
      updatedAt: capturedAt,
    }));
    return [tableObject, ...columns];
  });
}

function selectedContextObjects(value: unknown): MetadataObject[] {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!root) return [];
  const selected = root.selectedBlock && typeof root.selectedBlock === 'object' ? root.selectedBlock as Record<string, unknown> : root;
  const title = stringValue(selected.title) ?? stringValue(root.dashboardTitle) ?? stringValue(root.title) ?? 'Selected app context';
  const objectKey = `selected:context:${sha256(stableStringify(selected)).slice(0, 16)}`;
  return [{
    objectKey,
    objectType: 'selected_context',
    name: title,
    description: stringValue(selected.description) ?? stringValue(root.question),
    status: stringValue(selected.certificationStatus) ?? stringValue(selected.reviewStatus),
    sourceSystem: 'selected app/notebook context',
    payload: compactObject({
      tileId: selected.tileId,
      blockId: selected.blockId,
      blockPath: selected.blockPath,
      dashboardTitle: root.dashboardTitle,
      rowCount: selected.rowCount,
      columns: selected.columns,
      rows: selectedRows(root).slice(0, 20),
    }),
  }];
}

function normalizeFollowUpContext(value: unknown): MetadataFollowUpContext | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind === 'drilldown' ? 'drilldown' : record.kind === 'generic' ? 'generic' : null;
  if (!kind) return null;
  return {
    kind,
    sourceBlockName: stringValue(record.sourceBlockName),
    sourceQuestion: stringValue(record.sourceQuestion),
    sourceAnswer: stringValue(record.sourceAnswer),
    filters: metadataStringArray(record.filters),
    dimensions: metadataStringArray(record.dimensions),
  };
}

function followUpSourceObjectKeys(followUp: MetadataFollowUpContext | null): string[] {
  if (!followUp?.sourceBlockName) return [];
  return [`dql:block:${followUp.sourceBlockName}`];
}

function followUpContextObjects(followUp: MetadataFollowUpContext | null): MetadataObject[] {
  if (!followUp) return [];
  const text = [
    followUp.kind,
    followUp.sourceBlockName ?? '',
    followUp.sourceQuestion ?? '',
    followUp.sourceAnswer ?? '',
    ...(followUp.filters ?? []),
    ...(followUp.dimensions ?? []),
  ].join(' ');
  return [{
    objectKey: `selected:followup:${sha256(stableStringify(followUp)).slice(0, 16)}`,
    objectType: 'selected_context',
    name: followUp.kind === 'drilldown' ? 'Follow-up drilldown request' : 'Follow-up request',
    description: text.trim() || undefined,
    status: 'transient_context',
    sourceSystem: 'agent follow-up context',
    payload: compactObject({
      kind: followUp.kind,
      sourceBlockName: followUp.sourceBlockName,
      sourceQuestion: followUp.sourceQuestion,
      sourceAnswer: followUp.sourceAnswer,
      filters: followUp.filters,
      dimensions: followUp.dimensions,
    }),
  }];
}

function buildFollowUpSearchQuery(question: string, followUp: MetadataFollowUpContext | null): string {
  if (!followUp) return question;
  return [
    question,
    followUp.sourceBlockName ?? '',
    followUp.sourceQuestion ?? '',
    ...(followUp.filters ?? []),
    ...(followUp.dimensions ?? []),
  ].filter(Boolean).join(' ');
}

function normalizeRuntimeSchemaTables(tables: RuntimeSchemaTable[]): RuntimeSchemaTable[] {
  const byRelation = new Map<string, RuntimeSchemaTable>();
  for (const table of tables ?? []) {
    if (!table?.relation) continue;
    const relation = table.relation.trim();
    if (!relation) continue;
    const key = normalizeRelationKey(relation);
    const current = byRelation.get(key);
    const normalized: RuntimeSchemaTable = {
      relation,
      schema: table.schema,
      name: table.name ?? relation.split('.').at(-1) ?? relation,
      description: table.description,
      source: table.source,
      columns: dedupeRuntimeColumns(table.columns ?? []).slice(0, 160),
    };
    if (!current) byRelation.set(key, normalized);
    else byRelation.set(key, {
      ...current,
      description: current.description ?? normalized.description,
      columns: dedupeRuntimeColumns([...current.columns, ...normalized.columns]).slice(0, 160),
    });
  }
  return Array.from(byRelation.values());
}

function safeRuntimeSchemaSnapshot(value: unknown): RuntimeSchemaSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.tables)) return null;
  return {
    source: stringValue(record.source),
    capturedAt: stringValue(record.capturedAt),
    tables: normalizeRuntimeSchemaTables(record.tables as RuntimeSchemaTable[]),
  };
}

function metadataRuntimeColumns(value: unknown): RuntimeSchemaColumn[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const name = stringValue(record.name) ?? stringValue(record.column_name);
    if (!name) return [];
    return [{
      name,
      type: stringValue(record.type) ?? stringValue(record.data_type),
      description: stringValue(record.description),
      sampleValues: metadataStringArray(record.sampleValues),
    }];
  });
}

function dedupeRuntimeColumns(columns: RuntimeSchemaColumn[]): RuntimeSchemaColumn[] {
  const byName = new Map<string, RuntimeSchemaColumn>();
  for (const column of columns) {
    if (!column?.name) continue;
    const key = column.name.toLowerCase();
    const existing = byName.get(key);
    byName.set(key, existing ? {
      ...existing,
      type: existing.type ?? column.type,
      description: existing.description ?? column.description,
      sampleValues: Array.from(new Set([...(existing.sampleValues ?? []), ...(column.sampleValues ?? [])])).slice(0, 8),
    } : {
      ...column,
      sampleValues: column.sampleValues?.slice(0, 8),
    });
  }
  return Array.from(byName.values());
}

function metadataStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

function metadataPayloadString(object: MetadataObject, key: string): string | undefined {
  return stringValue(object.payload?.[key]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeRelationKey(relation: string): string {
  return relation.replace(/["`]/g, '').trim().toLowerCase();
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isEntityQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  if (/\b(for|where|only|specific|single|individual|named|called)\b.+\b(account|accounts|customer|customers|player|players|product|products|sku|user|users|team|teams)\b/i.test(lower)) return true;
  if (/\b(account|customer|player|product|sku|user|team)\s+(?:id|name|email)\b/i.test(lower)) return true;
  return /[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}/.test(question)
    && /\b(revenue|sales|order|orders|spend|value|churn|usage|activity|performance|performed|metric|kpi|points|goals|assists|scoring)\b/i.test(lower);
}

function mergeObject(a: MetadataObject | undefined, b: MetadataObject): MetadataObject {
  if (!a) return b;
  return {
    ...a,
    ...b,
    description: b.description || a.description,
    payload: compactObject({ ...(a.payload ?? {}), ...(b.payload ?? {}) }),
  };
}

function fingerprintSnapshot(snapshot: Omit<MetadataSnapshot, 'fingerprint'>): string {
  return sha256(stableStringify({
    projectRoot: snapshot.projectRoot,
    manifest: sanitizeManifestForFingerprint(snapshot.manifest),
    objects: snapshot.objects.map((object) => ({
      ...object,
      score: undefined,
      snippet: undefined,
    })),
    edges: snapshot.edges,
    diagnostics: snapshot.diagnostics,
  }));
}

function sanitizeManifestForFingerprint(manifest: DQLManifest): Record<string, unknown> {
  return {
    ...manifest,
    generatedAt: undefined,
    dbtImport: manifest.dbtImport
      ? { ...manifest.dbtImport, importedAt: undefined }
      : undefined,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function diagnosticId(diagnostic: MetadataDiagnostic): string {
  return sha256(stableStringify(diagnostic)).slice(0, 24);
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  if (Array.isArray(value)) {
    const out = `[${value.map((item) => stableStringify(item, seen)).join(',')}]`;
    seen.delete(value);
    return out;
  }
  const record = value as Record<string, unknown>;
  const out = `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return out;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw) && raw.length === 0) continue;
    if (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0) continue;
    out[key] = raw;
  }
  return out;
}

function rowToObject(row: MetadataObjectRow): MetadataObject {
  return {
    objectKey: row.object_key,
    objectType: row.object_type,
    name: row.name,
    fullName: row.full_name ?? undefined,
    domain: row.domain ?? undefined,
    owner: row.owner ?? undefined,
    status: row.status ?? undefined,
    description: row.description ?? undefined,
    sourcePath: row.source_path ?? undefined,
    sourceSystem: row.source_system ?? undefined,
    payload: safeJson(row.payload_json, {}),
    updatedAt: row.updated_at,
  };
}

function rowToEdge(row: MetadataEdgeRow): MetadataEdge {
  return {
    edgeType: row.edge_type,
    fromKey: row.from_key,
    toKey: row.to_key,
    confidence: row.confidence,
    payload: safeJson(row.payload_json, {}),
  };
}

function rowToQueryRun(row: QueryRunRow): QueryRunSummary {
  return {
    id: row.id,
    objectKey: row.object_key ?? undefined,
    source: row.source,
    status: row.status,
    rowCount: row.row_count ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    errorCode: row.error_code ?? undefined,
    payload: safeJson(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rankMetadataObjects(args: {
  rows: MetadataObject[];
  question: string;
  limit: number;
}): {
  selected: MetadataObject[];
  ranked: RankedMetadataObject[];
  rejected: LocalContextPack['retrievalDiagnostics']['topRejected'];
} {
  const terms = tokenize(args.question).slice(0, 12);
  const ranked = mergeObjects(args.rows)
    .map((row) => {
      const score = scoreMetadataObject(row, terms);
      return {
        row,
        rank: 0,
        score,
        reason: selectionReason(row, score),
        priorityTier: priorityTier(row),
      };
    })
    .sort((a, b) => b.score - a.score || objectPriority(a.row) - objectPriority(b.row) || a.row.name.localeCompare(b.row.name))
    .map((item, index) => ({ ...item, rank: index + 1 }));
  const cutoff = ranked[Math.max(0, args.limit - 1)];
  return {
    selected: ranked.slice(0, args.limit).map((item) => item.row),
    ranked,
    rejected: ranked.slice(args.limit).slice(0, 24).map((item) => ({
      objectKey: item.row.objectKey,
      objectType: item.row.objectType,
      name: item.row.name,
      reason: cutoff
        ? `Lower retrieval score than selected context window (cutoff ${cutoff.score.toFixed(1)}); ${item.reason}`
        : item.reason,
      score: item.score,
      rejectedRank: item.rank,
    })),
  };
}

function scoreMetadataObject(row: MetadataObject, terms: string[]): number {
  let score = row.score ? row.score * 10 : 0;
  score += Math.max(0, 44 - objectPriority(row) * 2);
  if (row.status === 'certified') score += 36;
  if (row.status === 'approved') score += 24;
  if (row.status === 'draft') score -= 8;
  if (row.objectType === 'dql_block' && row.status !== 'certified') score -= 16;
  if (row.objectType === 'semantic_metric') score += 10;
  if (row.objectType === 'dbt_model' || row.objectType === 'dbt_column') score += 4;
  score += scoreText([
    row.objectType,
    row.objectKey,
    row.name,
    row.fullName ?? '',
    row.domain ?? '',
    row.owner ?? '',
    row.description ?? '',
    JSON.stringify(row.payload ?? {}),
  ].join(' '), terms) * 8;
  return Number(score.toFixed(3));
}

function objectPriority(row: MetadataObject): number {
  return OBJECT_PRIORITY[row.objectType] ?? 99;
}

function priorityTier(row: MetadataObject): string {
  if (row.objectType === 'dql_block' && row.status === 'certified') return 'certified_block';
  if (row.objectType === 'semantic_metric') return 'semantic_metric';
  if (row.objectType === 'dql_term' || row.objectType === 'business_view') return 'business_context';
  if (row.objectType.startsWith('dbt_') || row.objectType === 'warehouse_table') return 'dbt_warehouse_context';
  if (row.objectType === 'notebook') return 'notebook_evidence';
  if (row.objectType === 'app' || row.objectType === 'dashboard') return 'consumption_evidence';
  return 'metadata';
}

function selectionReason(row: MetadataObject, score: number): string {
  const reasons = [reasonForObject(row), `priority tier: ${priorityTier(row)}`];
  if (row.status === 'certified') reasons.push('certified status');
  reasons.push(`score ${score.toFixed(1)}`);
  return reasons.join('; ');
}

function reasonForObject(row: MetadataObject): string {
  if (row.objectType === 'dql_block' && row.status === 'certified') return 'Certified reusable answer candidate';
  if (row.objectType === 'semantic_metric') return 'Semantic metric matched the question';
  if (row.objectType === 'dql_term' || row.objectType === 'business_view') return 'DQL business context';
  if (row.objectType.startsWith('dbt_') || row.objectType === 'warehouse_table') return 'dbt or warehouse metadata supplies physical context';
  if (row.objectType === 'app' || row.objectType === 'dashboard') return 'Published consumption context';
  return 'Relevant project metadata';
}

function mergeObjects(rows: MetadataObject[]): MetadataObject[] {
  const byKey = new Map<string, MetadataObject>();
  for (const row of rows) {
    const existing = byKey.get(row.objectKey);
    byKey.set(row.objectKey, existing ? mergeObject(existing, row) : row);
  }
  return Array.from(byKey.values());
}

function deriveTrust(objects: MetadataObject[]): MetadataTrustLabel {
  if (objects.length === 0) return 'unknown';
  const statuses = objects.map((row) => row.status ?? '');
  if (statuses.length > 0 && statuses.every((status) => status === 'certified')) return 'certified';
  if (statuses.some((status) => status === 'certified') && statuses.some((status) => status && status !== 'certified')) return 'mixed';
  if (statuses.some((status) => status === 'draft' || status === 'ai_generated' || status === 'analyst_review_required')) return 'draft';
  return statuses.some((status) => status === 'certified') ? 'mixed' : 'unknown';
}

function buildCitations(objects: MetadataObject[], edges: MetadataEdge[]): LocalContextPack['citations'] {
  const citations = objects.slice(0, 24).map((row) => ({
    objectKey: row.objectKey,
    objectType: row.objectType,
    name: row.name,
    reason: row.objectType === 'dql_block' && row.status === 'certified'
      ? 'Certified block candidate'
      : reasonForObject(row),
  }));
  for (const edge of edges.slice(0, 8)) {
    citations.push({
      objectKey: edge.fromKey,
      objectType: 'metadata_edge',
      name: `${edge.fromKey} -> ${edge.toKey}`,
      reason: `${edge.edgeType} relationship evidence`,
    });
  }
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.objectType}|${citation.objectKey}|${citation.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 32);
}

function buildEvidenceSummaries(
  objects: MetadataObject[],
  edges: MetadataEdge[],
  queryRuns: QueryRunSummary[],
  diagnostics: MetadataDiagnostic[],
): LocalContextPack['evidenceSummaries'] {
  const summaries: LocalContextPack['evidenceSummaries'] = objects.slice(0, 10).map((row) => ({
    title: row.name || row.objectKey,
    detail: row.objectType.replace(/_/g, ' '),
    objectKey: row.objectKey,
    objectType: row.objectType,
    reason: reasonForObject(row),
  }));
  if (edges.length > 0) {
    summaries.push({
      title: `${edges.length} metadata relationship${edges.length === 1 ? '' : 's'}`,
      detail: 'Object relationships were used to connect business, semantic, and physical context.',
      reason: 'Graph evidence',
    });
  }
  if (queryRuns.length > 0) {
    summaries.push({
      title: 'Recent execution history',
      detail: `Latest run status: ${queryRuns[0]?.status ?? 'unknown'}.`,
      reason: 'Runtime evidence',
    });
  }
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  if (warnings || errors) {
    summaries.push({
      title: 'Metadata diagnostics',
      detail: `${errors} error(s), ${warnings} warning(s).`,
      reason: 'Freshness and completeness checks',
    });
  }
  return summaries.slice(0, 16);
}

function buildWarnings(diagnostics: MetadataDiagnostic[], objects: MetadataObject[]): string[] {
  const warnings = diagnostics
    .filter((diagnostic) => diagnostic.severity === 'warning')
    .map((diagnostic) => diagnostic.message)
    .slice(0, 12);
  if (!objects.some((object) => object.objectType === 'semantic_metric')) {
    warnings.push('No semantic metric was selected for this context pack.');
  }
  return Array.from(new Set(warnings));
}

function buildCandidateConflicts(ranked: RankedMetadataObject[]): MetadataCandidateConflict[] {
  const conflicts: MetadataCandidateConflict[] = [];
  for (const type of ['dql_block', 'semantic_metric', 'dql_term', 'business_view']) {
    const candidates = ranked
      .filter((item) => item.row.objectType === type && isGovernedCandidate(item.row))
      .slice(0, 4);
    if (candidates.length < 2) continue;
    const delta = candidates[0]!.score - candidates[1]!.score;
    if (delta <= 12) {
      const details = candidates.map((item) => ({
        objectKey: item.row.objectKey,
        objectType: item.row.objectType,
        name: item.row.name,
        domain: item.row.domain ?? null,
        status: item.row.status ?? null,
        rank: item.rank,
        score: item.score,
        reason: item.reason,
      }));
      conflicts.push({
        objectType: type,
        objectKeys: candidates.map((item) => item.row.objectKey),
        reason: `Multiple high-scoring governed ${type.replace(/_/g, ' ')} candidates may need disambiguation.`,
        prompt: `Which ${type.replace(/_/g, ' ')} should I use: ${details.map((item) => item.name).join(', ')}?`,
        candidates: details,
      });
    }
  }
  return conflicts;
}

function isGovernedCandidate(row: MetadataObject): boolean {
  return row.status === 'certified' || row.status === 'approved';
}

function tokenize(text: string): string[] {
  return Array.from(new Set(text.toLowerCase().replace(/[^a-z0-9_ ]+/g, ' ').split(/\s+/).filter((term) => term.length >= 3))).slice(0, 24);
}

function scoreText(value: string, terms: string[]): number {
  const lower = value.toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
}

const STOP_WORDS = new Set([
  'a', 'about', 'after', 'all', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by',
  'can', 'could', 'did', 'do', 'does', 'down', 'for', 'from', 'give', 'had', 'has',
  'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'me', 'most', 'my', 'of',
  'on', 'or', 'please', 'query', 'show', 'sql', 'than', 'that', 'the', 'their',
  'them', 'this', 'to', 'up', 'using', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'with', 'would', 'you', 'your',
]);

function sanitizeFtsQuery(raw: string): string {
  return raw
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term.toLowerCase()))
    .slice(0, 48)
    .map((term) => `"${term}"`)
    .join(' OR ');
}
