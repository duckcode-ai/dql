/**
 * Retrieval-health status (P0 architecture-review follow-through).
 *
 * The agent stack fails soft everywhere — value grounding silently disables
 * itself without an allowlist, embeddings silently fall back to hashed tokens,
 * caches grow without GC. Failing soft is right for availability and wrong for
 * diagnosability: "why is the agent dumb today" should be one glance, not a
 * debugging session. This module assembles a cheap, read-only report for
 * `dql doctor` and `/api/health`. It never throws and never blocks.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultAgentRunSqlitePath,
  defaultMetadataPath,
  envEmbeddingProvider,
  readAgentRunStoreHealth,
  readMetadataCatalogHealth,
  type AgentRunStoreHealth,
  type MetadataCatalogHealth,
} from '@duckcodeailabs/dql-agent';

export interface DqlRetrievalHealthStatus {
  valueGrounding: {
    mode: 'safe_automatic' | 'disabled';
    searchSafeColumns: number;
    /** Present when disabled: what to configure to turn it on. */
    reason?: string;
  };
  embeddings: {
    providerId: string;
    semantic: boolean;
  };
  catalog: MetadataCatalogHealth;
  runStore: AgentRunStoreHealth & { legacyJsonBytes?: number };
  snapshots: { count: number; totalBytes: number };
  warnings: string[];
}

export function resolveRetrievalHealthStatus(input: {
  projectRoot: string;
  valueGroundingMode: 'safe_automatic' | 'disabled';
  searchSafeColumnCount: number;
}): DqlRetrievalHealthStatus {
  const warnings: string[] = [];

  const valueGrounding: DqlRetrievalHealthStatus['valueGrounding'] = {
    mode: input.valueGroundingMode,
    searchSafeColumns: input.searchSafeColumnCount,
    ...(input.valueGroundingMode === 'disabled'
      ? { reason: 'Set agent.runtimeValueGrounding.mode to "safe_automatic" with an explicit searchSafeColumns allowlist (schema.table.column, no wildcards) in dql.config.json.' }
      : {}),
  };
  if (input.valueGroundingMode === 'disabled') {
    warnings.push('Runtime value grounding is DISABLED: member values (e.g. a customer name) cannot be probed against real column values, so typed filters lean on prior results only.');
  }

  let providerId = 'hashed-token-v1';
  try {
    providerId = envEmbeddingProvider().id;
  } catch { /* keep the deterministic default */ }
  const semantic = !providerId.startsWith('hashed-token');
  if (!semantic) {
    warnings.push('Embeddings are the deterministic hashed fallback: paraphrase matching is lexical-only. Run a local Ollama embedding model or set an OpenAI key for semantic recall.');
  }

  const catalog = readMetadataCatalogHealth(defaultMetadataPath(input.projectRoot));
  if (!catalog.exists) {
    warnings.push('Metadata catalog is missing — run dql compile (or ask once) to build the agent index.');
  } else if ((catalog.contextPackBytes ?? 0) > 100 * 1024 * 1024) {
    warnings.push(`Cached context packs occupy ${formatBytes(catalog.contextPackBytes ?? 0)} — consider clearing .dql/cache/metadata.sqlite (it rebuilds automatically).`);
  }

  const runStorePath = defaultAgentRunSqlitePath(input.projectRoot);
  const runStore: DqlRetrievalHealthStatus['runStore'] = readAgentRunStoreHealth(runStorePath);
  const legacyJson = join(input.projectRoot, '.dql', 'local', 'agent-runs.json');
  if (existsSync(legacyJson)) {
    try {
      runStore.legacyJsonBytes = statSync(legacyJson).size;
    } catch { /* advisory */ }
    warnings.push('Legacy agent-runs.json still present — it migrates to SQLite on the next server start.');
  }

  const snapshots = snapshotStoreStats(join(input.projectRoot, '.dql', 'cache', 'snapshots'));
  if (snapshots.totalBytes > 500 * 1024 * 1024) {
    warnings.push(`Immutable metadata snapshots occupy ${formatBytes(snapshots.totalBytes)} (${snapshots.count} files) — old snapshots are never garbage-collected yet; safe to delete .dql/cache/snapshots.`);
  }

  return { valueGrounding, embeddings: { providerId, semantic }, catalog, runStore, snapshots, warnings };
}

function snapshotStoreStats(dir: string): { count: number; totalBytes: number } {
  try {
    if (!existsSync(dir)) return { count: 0, totalBytes: 0 };
    let count = 0;
    let totalBytes = 0;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.sqlite')) continue;
      count += 1;
      try {
        totalBytes += statSync(join(dir, entry)).size;
      } catch { /* advisory */ }
    }
    return { count, totalBytes };
  } catch {
    return { count: 0, totalBytes: 0 };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
