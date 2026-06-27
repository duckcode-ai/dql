/**
 * Freshness-aware trust — read dbt run artifacts (READ-ONLY) and fold data
 * health into the effective trust of certified blocks.
 *
 * "Certified" means the *logic* was reviewed. It says nothing about whether the
 * *data* behind a block is fresh: an upstream dbt model may have failed its last
 * run, or be past its freshness window. This module reads dbt's own artifacts —
 * `run_results.json` (last-run status/time per model) and, when present, the
 * source-freshness output — and derives a {@link DbtDataState} per dbt node. It
 * then rolls those up to each certified block's transitive dbt upstreams so a
 * surface can render "Certified · stale data" / "Certified · upstream failed".
 *
 * We never run dbt or query the warehouse — we only parse files dbt produced.
 * Everything degrades to `unknown` (which surfaces as the plain "Certified"
 * label) when an artifact is missing or unparseable, so this is fully additive.
 *
 * Kept in a dedicated module so `manifest/builder.ts` only needs a couple of
 * call sites, keeping its diff minimal and merge-clean with the sibling
 * `outputContract`/`drift` change.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  DbtDataState,
  DbtRunState,
  ManifestBlock,
  ManifestSource,
} from './types.js';

/** Worst-first ordering used when rolling many upstream states into one. */
const STATE_SEVERITY: Record<DbtDataState, number> = {
  failed: 3,
  stale: 2,
  unknown: 1,
  fresh: 0,
};

/** Return the worse (higher-severity) of two data states. */
export function worseDataState(a: DbtDataState, b: DbtDataState): DbtDataState {
  return STATE_SEVERITY[a] >= STATE_SEVERITY[b] ? a : b;
}

/**
 * Parsed run-state keyed by dbt `unique_id`, plus the artifact path that was
 * read (for provenance). Empty `byUniqueId` means no artifact was found.
 */
export interface DbtRunStateIndex {
  byUniqueId: Map<string, DbtRunState>;
  runResultsPath?: string;
}

/**
 * Resolve and read dbt's `run_results.json` (and source-freshness output, when
 * a separate `sources.json` sits beside it) from the directory holding the dbt
 * `manifest.json`. Returns an empty index — never throws — when nothing is
 * found or the file cannot be parsed.
 *
 * dbt writes both `manifest.json` and `run_results.json` into the same
 * `target/` directory, so we look beside `manifestPath`.
 */
export function loadDbtRunState(manifestPath: string): DbtRunStateIndex {
  const targetDir = dirname(manifestPath);
  const byUniqueId = new Map<string, DbtRunState>();

  const runResultsPath = join(targetDir, 'run_results.json');
  let foundPath: string | undefined;
  if (existsSync(runResultsPath)) {
    try {
      const raw = JSON.parse(readFileSync(runResultsPath, 'utf-8'));
      const generatedAt: string | undefined = raw?.metadata?.generated_at;
      const results: any[] = Array.isArray(raw?.results) ? raw.results : [];
      for (const result of results) {
        const uniqueId: string | undefined = result?.unique_id;
        if (!uniqueId) continue;
        byUniqueId.set(uniqueId, runStateFromRunResult(result, generatedAt));
      }
      if (results.length > 0) foundPath = runResultsPath;
    } catch {
      // Unparseable artifact — degrade silently to "unknown" everywhere.
    }
  }

  // Optional source-freshness output. dbt's `source freshness` command writes a
  // `sources.json` beside the manifest; fold any stale/error verdicts in. This
  // overrides/augments run-result state for source nodes only.
  const sourcesPath = join(targetDir, 'sources.json');
  if (existsSync(sourcesPath)) {
    try {
      const raw = JSON.parse(readFileSync(sourcesPath, 'utf-8'));
      const results: any[] = Array.isArray(raw?.results) ? raw.results : [];
      for (const result of results) {
        const uniqueId: string | undefined = result?.unique_id;
        if (!uniqueId) continue;
        const freshness = freshnessFromSourceResult(result);
        if (!freshness) continue;
        const existing = byUniqueId.get(uniqueId);
        byUniqueId.set(uniqueId, {
          dataState: existing
            ? worseDataState(existing.dataState, freshness.dataState)
            : freshness.dataState,
          lastRunStatus: existing?.lastRunStatus,
          lastRunCompletedAt: existing?.lastRunCompletedAt,
          freshnessStatus: freshness.freshnessStatus,
          maxLoadedAt: freshness.maxLoadedAt,
        });
      }
      if (results.length > 0) foundPath = foundPath ?? sourcesPath;
    } catch {
      // Ignore — freshness is best-effort.
    }
  }

  return { byUniqueId, runResultsPath: foundPath };
}

/** Map one `run_results.json` entry to a {@link DbtRunState}. */
function runStateFromRunResult(result: any, generatedAt?: string): DbtRunState {
  const status: string | undefined = result?.status;
  // Prefer the precise per-node execute completion time from `timing`; fall back
  // to the artifact's `generated_at` so we always carry *some* "as of" time.
  const timing: any[] = Array.isArray(result?.timing) ? result.timing : [];
  const executeCompletedAt: string | undefined = timing.find((t) => t?.name === 'execute')?.completed_at;
  return {
    dataState: dataStateFromRunStatus(status),
    lastRunStatus: status,
    lastRunCompletedAt: executeCompletedAt ?? generatedAt,
  };
}

/**
 * dbt run statuses: model runs report `success` | `error` | `skipped`; tests
 * report `pass` | `fail` | `warn` | `error`. A failed or skipped upstream means
 * the data may be missing or wrong → `failed`. Success → `fresh`. Anything
 * unrecognized → `unknown` (no opinion).
 */
function dataStateFromRunStatus(status: string | undefined): DbtDataState {
  switch (status) {
    case 'success':
    case 'pass':
      return 'fresh';
    case 'error':
    case 'fail':
    case 'skipped':
    case 'runtime error':
      return 'failed';
    default:
      return 'unknown';
  }
}

/** Map one source-freshness result to a freshness state. */
function freshnessFromSourceResult(result: any):
  | { dataState: DbtDataState; freshnessStatus?: string; maxLoadedAt?: string }
  | undefined {
  const status: string | undefined = result?.status ?? result?.criteria?.status;
  const maxLoadedAt: string | undefined =
    result?.max_loaded_at ?? result?.criteria?.max_loaded_at;
  switch (status) {
    case 'pass':
      return { dataState: 'fresh', freshnessStatus: status, maxLoadedAt };
    case 'warn':
    case 'error':
      // A freshness warn/error means the data is past its window: stale, not a
      // hard run failure.
      return { dataState: 'stale', freshnessStatus: status, maxLoadedAt };
    case 'runtime error':
      return { dataState: 'failed', freshnessStatus: status, maxLoadedAt };
    default:
      return status ? { dataState: 'unknown', freshnessStatus: status, maxLoadedAt } : undefined;
  }
}

/**
 * Compute each certified block's effective `dataState` from the health of its
 * transitive dbt upstreams, mutating blocks additively in place.
 *
 * Resolution: a block's `tableDependencies` name dbt models/sources; we resolve
 * each to a `sources[...]` entry that carries a `dbtModel.uniqueId`, then walk
 * upstream through the dbt DAG (`edges`: source → target uniqueId) collecting
 * every reachable node's run state. The block's `dataState` is the worst state
 * among them. Blocks with no resolvable dbt upstream are left untouched.
 *
 * Only acts when a run-results artifact was actually read — without it every
 * node is `unknown` and we leave blocks alone so nothing regresses to a noisy
 * "· data freshness unknown" qualifier.
 */
export function applyBlockDataState(
  blocks: Record<string, ManifestBlock>,
  sources: Record<string, ManifestSource>,
  dbtDag: { models: Array<{ uniqueId: string }>; edges: Array<{ source: string; target: string }> } | undefined,
  runState: DbtRunStateIndex,
): void {
  if (runState.byUniqueId.size === 0) return;

  // uniqueId -> upstream uniqueIds (reverse of edges' source→target direction;
  // an edge {source, target} means target depends on source).
  const upstream = new Map<string, string[]>();
  for (const edge of dbtDag?.edges ?? []) {
    const list = upstream.get(edge.target) ?? [];
    list.push(edge.source);
    upstream.set(edge.target, list);
  }

  // table name -> dbt uniqueId, via the sources map. Block table refs may be
  // schema-qualified (`dev.customers`) while the dbt-model source is named bare
  // (`customers`), so index every alias: the source name plus the model's
  // bare / schema-qualified / db-qualified names derived from its dbt metadata.
  const tableToUniqueId = new Map<string, string>();
  const addTableKey = (key: string | undefined, uid: string) => {
    if (!key) return;
    const k = key.toLowerCase();
    if (!tableToUniqueId.has(k)) tableToUniqueId.set(k, uid);
  };
  for (const source of Object.values(sources)) {
    const dm = source.dbtModel;
    if (!dm?.uniqueId) continue;
    addTableKey(source.name, dm.uniqueId);
    const bare = dm.uniqueId.split('.').pop();
    addTableKey(bare, dm.uniqueId);
    if (dm.schema && bare) addTableKey(`${dm.schema}.${bare}`, dm.uniqueId);
    if (dm.database && dm.schema && bare) addTableKey(`${dm.database}.${dm.schema}.${bare}`, dm.uniqueId);
  }

  // A node's own state, or `undefined` when dbt produced no run/freshness result
  // for it (e.g. raw sources never "run"). Unstated nodes are NEUTRAL — being in
  // a block's lineage must not drag it to "unknown" just because a source has no
  // run record.
  const stateFor = (uid: string): DbtDataState | undefined =>
    runState.byUniqueId.get(uid)?.dataState;

  // Memoised worst KNOWN state over the transitive upstream closure of a node.
  const closureCache = new Map<string, DbtDataState | undefined>();
  const worstUpstream = (uid: string, seen = new Set<string>()): DbtDataState | undefined => {
    if (closureCache.has(uid)) return closureCache.get(uid);
    if (seen.has(uid)) return stateFor(uid);
    seen.add(uid);
    let worst = stateFor(uid);
    for (const up of upstream.get(uid) ?? []) {
      const s = worstUpstream(up, seen);
      if (s !== undefined) worst = worst === undefined ? s : worseDataState(worst, s);
    }
    closureCache.set(uid, worst);
    return worst;
  };

  for (const block of Object.values(blocks)) {
    const upstreamUids: string[] = [];
    for (const table of block.tableDependencies ?? []) {
      const lower = table.toLowerCase();
      const uid = tableToUniqueId.get(lower) ?? tableToUniqueId.get(lower.split('.').pop() ?? lower);
      if (uid) upstreamUids.push(uid);
    }
    if (upstreamUids.length === 0) continue;

    let worst: DbtDataState | undefined;
    let worstUid: string | undefined;
    for (const uid of upstreamUids) {
      const state = worstUpstream(uid);
      if (state === undefined) continue;
      if (worst === undefined || STATE_SEVERITY[state] > STATE_SEVERITY[worst]) {
        worst = state;
        worstUid = uid;
      }
    }
    if (worst === undefined) continue;

    block.dataState = worst;
    block.dataStateDetail = describeBlockDataState(worst, worstUid, runState);
  }
}

function describeBlockDataState(
  state: DbtDataState,
  worstUid: string | undefined,
  runState: DbtRunStateIndex,
): string | undefined {
  if (state === 'fresh') return 'All upstream dbt models are fresh (last run succeeded).';
  const node = worstUid ? runState.byUniqueId.get(worstUid) : undefined;
  const shortName = worstUid?.split('.').pop();
  switch (state) {
    case 'failed':
      return `Upstream dbt model${shortName ? ` "${shortName}"` : ''} last run failed${node?.lastRunStatus ? ` (status: ${node.lastRunStatus})` : ''}.`;
    case 'stale':
      return `Upstream data${shortName ? ` from "${shortName}"` : ''} is past its freshness window${node?.freshnessStatus ? ` (freshness: ${node.freshnessStatus})` : ''}.`;
    default:
      return undefined;
  }
}
