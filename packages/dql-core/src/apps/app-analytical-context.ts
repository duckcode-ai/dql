import type { TileFilterOperator, TileQuery } from './tile-query.js';

/**
 * Server-derived context for one answer about one settled Dataset chart.
 *
 * This is deliberately a typed evidence envelope, rather than a browser
 * “selected chart” payload. The runtime owns all identity, query, filter,
 * result, target, and persona fields; consumers may render it but cannot use
 * it to author or execute SQL.
 */
export interface AppAnalyticalContextV1 {
  version: 1;
  appId: string;
  dashboardId: string;
  tileId: string;
  runId: string;
  /** Interaction evidence is answerable but never a whole-App publication receipt. */
  evidenceScope: 'full_dashboard' | 'interaction' | 'incomplete';
  snapshotId: string;
  dashboardFingerprint: string;
  source: {
    sourceId: string;
    sourceRevision: string;
    contractFingerprint: string;
    lifecycle: string;
    trust: string;
    targetFingerprint?: string;
    /** Presentation-only labels resolved by the server with the source card. */
    label?: string;
    path?: string;
  };
  /** Saved author intent. The runtime validates this again before answering. */
  authoredQuery: TileQuery;
  authoredQueryFingerprint: string;
  /** The query after a bounded hierarchy interaction, when present. */
  interactionQueryFingerprint?: string;
  executionQueryFingerprint: string;
  filterFingerprint: string;
  parameterFingerprint: string;
  interactionFingerprint: string;
  executionFingerprint: string;
  resultFingerprint: string;
  schemaFingerprint: string;
  personaPolicyFingerprint: string;
  /** Only filters that actually reached this tile. Explicit exclusions remain visible. */
  effectiveFilters: Record<string, unknown>;
  appliedFilters: Array<{
    field: string;
    op: TileFilterOperator;
    values: unknown[];
    placement: 'where' | 'having';
  }>;
  unboundFilters: Array<{ filterId?: string; code?: string; message?: string }>;
  result: {
    columns: string[];
    rows: Array<Record<string, unknown>>;
    rowCount: number;
    columnsMeta?: Array<Record<string, unknown>>;
  };
}
