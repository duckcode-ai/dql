import type { DashboardDocumentResponse, DashboardRunResponse } from '../../api/client';

/**
 * One trust vocabulary for App readers (RFC 0008 step 6). Every data tile
 * shows exactly one of four states, worked out from the governed run
 * evidence the server returned, never from the tile's own claims alone:
 *
 * - certified: a certified source ran exactly as reviewed
 * - governed:  a governed semantic query (metrics and dimensions from the
 *              model), not individually certified
 * - review:    not certified yet, adapted, out of date, or AI-generated
 * - blocked:   governance or the source stopped this tile from showing data
 *
 * Pure: no React, no I/O.
 */
export type ReaderTrustState = 'certified' | 'governed' | 'review' | 'blocked';

export interface ReaderTrust {
  state: ReaderTrustState;
  label: string;
  /** One sentence a reader can act on. */
  detail: string;
}

type LayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type RunTile = DashboardRunResponse['tiles'][number];

export const READER_TRUST_LABELS: Record<ReaderTrustState, string> = {
  certified: 'Certified',
  governed: 'Governed',
  review: 'Needs review',
  blocked: 'Blocked',
};

const trust = (state: ReaderTrustState, detail: string): ReaderTrust => ({ state, label: READER_TRUST_LABELS[state], detail });

/** Text and heading tiles carry no data, so they carry no trust label. */
export function isDataTileForTrust(item: LayoutItem, tile?: RunTile): boolean {
  if (item.text || tile?.tileType === 'text') return false;
  return Boolean(tile || item.block || item.semantic || item.query || item.aiPin || item.draftAnalysis);
}

export function readerTileTrust(item: LayoutItem, tile?: RunTile): ReaderTrust | null {
  if (!isDataTileForTrust(item, tile)) return null;
  if (!tile) return null;
  if (tile.status === 'unauthorized') return trust('blocked', 'You do not have access to this data.');
  if (tile.status === 'unresolved') return trust('blocked', 'This tile’s source could not be found in the project.');
  if (tile.status === 'error') return trust('blocked', 'This tile could not run with the current source and filters.');
  if (tile.status === 'stale') return trust('review', 'This result is out of date; refresh the page.');
  if (tile.repair) return trust('review', 'This tile was repaired automatically and needs a person to check it.');

  if (tile.aiPin || item.aiPin) {
    const pin = tile.aiPin;
    return pin?.certification === 'certified' || pin?.reviewStatus === 'certified'
      ? trust('certified', 'An AI answer that a person reviewed and certified.')
      : trust('review', 'An AI answer that nobody has reviewed yet.');
  }

  const dataset = tile.dataset;
  if (dataset) {
    const outcome = dataset.validation?.outcome;
    if (outcome === 'rejected') return trust('blocked', 'The Dataset contract rejected this query.');
    if (dataset.trust === 'certified' && outcome !== 'needs_review') {
      return outcome === 'adapted'
        ? trust('certified', 'Certified Dataset; the query was adapted within its contract.')
        : trust('certified', 'Runs on a certified Dataset, within its contract.');
    }
    return trust('review', outcome === 'needs_review'
      ? 'The query goes beyond what the Dataset certifies.'
      : 'The Dataset is not certified yet.');
  }

  const artifactTrust = tile.artifact?.trustState;
  const serverTrust = (tile as { trustState?: string }).trustState;
  if (tile.certificationStatus === 'certified' || artifactTrust === 'certified' || serverTrust === 'certified') {
    return trust('certified', 'Runs a certified block exactly as it was reviewed.');
  }
  if (tile.tileType === 'semantic' || item.semantic || tile.artifact?.sourceKind === 'semantic_query') {
    return trust('governed', 'Metrics and dimensions come from the governed semantic model.');
  }
  return trust('review', 'This source is not certified yet; check it before relying on it.');
}

/** Counts for the Trust Lens legend, in a fixed order. */
export function readerTrustCounts(trusts: Array<ReaderTrust | null>): Array<{ state: ReaderTrustState; label: string; count: number }> {
  const order: ReaderTrustState[] = ['certified', 'governed', 'review', 'blocked'];
  return order
    .map((state) => ({ state, label: READER_TRUST_LABELS[state], count: trusts.filter((entry) => entry?.state === state).length }))
    .filter((entry) => entry.count > 0);
}

/** "just now", "5 min ago", "3 h ago", or a date. */
export function relativeAge(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(thenMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * How fresh a tile's numbers are. A cached Dataset result says when it was
 * cached; anything else ran when this page run settled.
 */
export function readerTileFreshness(tile: RunTile | undefined, ranAtMs: number | undefined, nowMs: number): string | null {
  const cachedAt = tile?.dataset?.cacheDelivery?.cachedAt;
  const cachedMs = cachedAt ? Date.parse(cachedAt) : NaN;
  if (Number.isFinite(cachedMs)) return `Cached ${relativeAge(cachedMs, nowMs)}`;
  if (tile?.status === 'ok' && ranAtMs !== undefined) return `Updated ${relativeAge(ranAtMs, nowMs)}`;
  return null;
}

export interface ReceiptRow {
  label: string;
  value: string;
  /** Fingerprints and ids are shown in a monospace face and can be copied. */
  code?: boolean;
}

const short = (value: string | undefined | null) => (value ? (value.length > 16 ? `${value.slice(0, 12)}…` : value) : undefined);

/**
 * The receipt behind a tile's numbers: where they came from, which filters
 * applied, when they ran, and the fingerprints that let anyone check the
 * result was not changed. Only rows with evidence are returned.
 */
export function readerTileReceipt(
  item: LayoutItem,
  tile: RunTile | undefined,
  run: Pick<DashboardRunResponse, 'runId' | 'snapshotId' | 'filterFingerprint'> | null,
  ranAtMs: number | undefined,
): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  const push = (label: string, value: string | undefined | null, code = false) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') rows.push({ label, value: String(value), ...(code ? { code } : {}) });
  };
  const source = tile?.artifact?.name ?? tile?.citation?.name ?? tile?.blockPath ?? item.block?.blockId ?? tile?.dataset?.sourceId;
  push('Source', source);
  push('Source file', tile?.artifact?.sourcePath ?? tile?.citation?.path ?? tile?.blockPath);
  push('Owner', item.owner);
  const applied = tile?.filters?.applied ?? [];
  push('Filters', applied.length
    ? applied.map((filter) => `${filter.field ?? filter.filter ?? 'filter'} ${filter.op && filter.op !== '=' && filter.op !== 'in' ? `${filter.op} ` : ''}${formatFilterValue(filter.values)}`).join(' · ')
    : 'None applied');
  const rowCount = tile?.result?.rowCount ?? tile?.result?.rows?.length;
  push('Rows', rowCount !== undefined ? rowCount.toLocaleString() : undefined);
  push('Ran', ranAtMs !== undefined ? new Date(ranAtMs).toLocaleString() : undefined);
  push('Cached at', tile?.dataset?.cacheDelivery?.cachedAt ? new Date(tile.dataset.cacheDelivery.cachedAt).toLocaleString() : undefined);
  push('Result fingerprint', short(tile?.result?.resultFingerprint ?? tile?.dataset?.executionProvenance?.resultFingerprint ?? (tile as { resultFingerprint?: string } | undefined)?.resultFingerprint), true);
  push('SQL fingerprint', short(tile?.dataset?.executionProvenance?.executedSqlFingerprint ?? (tile as { compiledSqlFingerprint?: string } | undefined)?.compiledSqlFingerprint), true);
  push('Snapshot', short(run?.snapshotId), true);
  push('Run', short(run?.runId), true);
  return rows;
}

function formatFilterValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? 'any');
}
