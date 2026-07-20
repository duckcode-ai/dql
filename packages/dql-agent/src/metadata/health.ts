/**
 * Cheap, read-only health probes over the rebuildable metadata stores.
 * Everything here degrades to "unknown" instead of throwing — health surfaces
 * (doctor, /api/health) must never break because a cache file is missing,
 * locked, or from an older index version.
 */
import Database from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';

export interface MetadataCatalogHealth {
  exists: boolean;
  fileBytes?: number;
  objectCount?: number;
  edgeCount?: number;
  builtAt?: string;
  indexVersion?: string;
  contextPackCount?: number;
  contextPackBytes?: number;
  diagnosticsCount?: number;
}

export function readMetadataCatalogHealth(metadataPath: string): MetadataCatalogHealth {
  if (!existsSync(metadataPath)) return { exists: false };
  const health: MetadataCatalogHealth = { exists: true };
  try {
    health.fileBytes = statSync(metadataPath).size;
  } catch { /* size is advisory */ }
  let db: Database.Database | undefined;
  try {
    db = new Database(metadataPath, { readonly: true });
    const state = new Map(
      (db.prepare('SELECT key, value FROM metadata_state').all() as Array<{ key: string; value: string }>)
        .map((row) => [row.key, row.value]),
    );
    const asCount = (value: string | undefined) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    health.objectCount = asCount(state.get('object_count'));
    health.edgeCount = asCount(state.get('edge_count'));
    health.builtAt = state.get('built_at');
    health.indexVersion = state.get('index_version');
    const packs = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload_json)), 0) AS bytes FROM context_packs').get() as { n: number; bytes: number };
    health.contextPackCount = packs.n;
    health.contextPackBytes = packs.bytes;
    const diagnostics = db.prepare('SELECT COUNT(*) AS n FROM metadata_diagnostics').get() as { n: number };
    health.diagnosticsCount = diagnostics.n;
  } catch {
    // Older schema or a locked file: report what we have.
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
  return health;
}

export interface AgentRunStoreHealth {
  exists: boolean;
  fileBytes?: number;
  runCount?: number;
}

export function readAgentRunStoreHealth(runStorePath: string): AgentRunStoreHealth {
  if (!existsSync(runStorePath)) return { exists: false };
  const health: AgentRunStoreHealth = { exists: true };
  try {
    health.fileBytes = statSync(runStorePath).size;
  } catch { /* advisory */ }
  let db: Database.Database | undefined;
  try {
    db = new Database(runStorePath, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as { n: number };
    health.runCount = row.n;
  } catch {
    // Legacy or foreign file at this path — size alone still helps.
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
  return health;
}
