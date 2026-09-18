import { createHash } from 'node:crypto';

import type { DatasetTileProvenanceV1, TileQuery } from '@duckcodeailabs/dql-core';

export type DatasetTilePromotionRefusalCode =
  | 'comparison_not_representable_as_single_block'
  | 'dataset_tile_not_settled'
  | 'dataset_tile_sql_unavailable'
  | 'dataset_tile_not_single_statement'
  | 'dataset_tile_dynamic_binding_not_representable';

export type DatasetTilePromotionPlan =
  | {
    ok: true;
    source: string;
    provenance: DatasetTileProvenanceV1;
    /** Replacement remains an explicit separate action and may be unavailable. */
    replacementEligible: boolean;
    replacementMessage?: string;
  }
  | { ok: false; code: DatasetTilePromotionRefusalCode; message: string };

export interface DatasetTilePromotionInput {
  appId: string;
  pageId: string;
  tileId: string;
  name: string;
  domain: string;
  description?: string;
  datasetId: string;
  sourceRevision: string;
  contractFingerprint: string;
  query: TileQuery;
  queryFingerprint: string;
  filterFingerprint: string;
  parameterFingerprint: string;
  interactionFingerprint: string;
  snapshotFingerprint: string;
  targetFingerprint: string;
  personaPolicyFingerprint: string;
  receiptId: string;
  sql: string;
  schemaFingerprint: string;
  resultFingerprint: string;
  /** Server-derived from the settled tile result, never inferred from rows. */
  complete?: boolean;
  /** A cache-delivery receipt cannot become reusable-block or equivalence authority. */
  cacheDelivery?: boolean;
  /** Server-derived, never a browser assertion. */
  futureBindingsRepresentable: boolean;
  now?: () => Date;
}

/**
 * Produce one review-draft block body from an already settled physical Dataset
 * result. This is deliberately a planner only: callers still reload all
 * current App/source/receipt authority and use the existing atomic writer.
 */
export function planDatasetTilePromotion(input: DatasetTilePromotionInput): DatasetTilePromotionPlan {
  if (input.query.comparison) {
    return refusal('comparison_not_representable_as_single_block', 'This comparison uses multiple executions and result graph arithmetic, so it cannot be saved as one reusable SQL block. The Dataset tile remains runnable.');
  }
  if (input.cacheDelivery) {
    return refusal('dataset_tile_not_settled', 'Cached delivery is not fresh execution authority. Refresh this tile before saving it as a reusable block.');
  }
  if (input.complete !== true) {
    return refusal('dataset_tile_not_settled', 'This Dataset result is not a complete current tile result. Run a complete current tile before saving it as a reusable block.');
  }
  const required = [
    input.appId, input.pageId, input.tileId, input.name, input.domain, input.datasetId,
    input.sourceRevision, input.contractFingerprint, input.queryFingerprint, input.filterFingerprint,
    input.parameterFingerprint, input.interactionFingerprint, input.snapshotFingerprint,
    input.targetFingerprint, input.personaPolicyFingerprint, input.receiptId, input.schemaFingerprint,
    input.resultFingerprint,
  ];
  if (required.some((value) => !value.trim())) {
    return refusal('dataset_tile_not_settled', 'This tile has no complete current App Dataset receipt. Run the current tile again before saving it.');
  }
  const sql = input.sql.trim();
  if (!sql) return refusal('dataset_tile_sql_unavailable', 'This Dataset execution did not return one reusable physical SQL statement.');
  if (!isOneSqlStatement(sql)) {
    return refusal('dataset_tile_not_single_statement', 'This Dataset execution requires more than one SQL statement or unsupported dynamic SQL, so DQL will not save it as a reusable block.');
  }
  if (sql.includes('"""')) {
    return refusal('dataset_tile_sql_unavailable', 'The executed SQL cannot be represented safely in a DQL block body.');
  }
  const provenance: DatasetTileProvenanceV1 = {
    version: 1,
    kind: 'dataset_tile_provenance',
    appId: input.appId,
    pageId: input.pageId,
    tileId: input.tileId,
    datasetId: input.datasetId,
    sourceRevision: input.sourceRevision,
    contractFingerprint: input.contractFingerprint,
    query: input.query,
    queryFingerprint: input.queryFingerprint,
    filterFingerprint: input.filterFingerprint,
    parameterFingerprint: input.parameterFingerprint,
    interactionFingerprint: input.interactionFingerprint,
    snapshotFingerprint: input.snapshotFingerprint,
    targetFingerprint: input.targetFingerprint,
    personaPolicyFingerprint: input.personaPolicyFingerprint,
    receiptId: input.receiptId,
    sqlFingerprint: fingerprint(sql),
    schemaFingerprint: input.schemaFingerprint,
    resultFingerprint: input.resultFingerprint,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  const source = [
    `block ${JSON.stringify(input.name.trim())} {`,
    `  domain = ${JSON.stringify(input.domain.trim())}`,
    '  type = "custom"',
    '  status = "draft"',
    ...(input.description?.trim() ? [`  description = ${JSON.stringify(input.description.trim())}`] : []),
    `  dataset_tile_provenance = ${JSON.stringify(JSON.stringify(provenance))}`,
    '  query = """',
    ...sql.split('\n').map((line) => `    ${line}`),
    '  """',
    '}',
    '',
  ].join('\n');
  return {
    ok: true,
    source,
    provenance,
    replacementEligible: input.futureBindingsRepresentable,
    ...(input.futureBindingsRepresentable
      ? {}
      : { replacementMessage: 'Saved as a fixed-value review draft. Replacement is unavailable because this tile has bindings or interactions that the current block contract cannot represent.' }),
  };
}

function refusal(code: DatasetTilePromotionRefusalCode, message: string): DatasetTilePromotionPlan {
  return { ok: false, code, message };
}

/** Reject a second executable statement without attempting to parse user SQL. */
function isOneSqlStatement(sql: string): boolean {
  let quote: "'" | '"' | '`' | undefined;
  let lineComment = false;
  let blockComment = false;
  let semicolonAt = -1;
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (current === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (current === quote && sql[index - 1] !== '\\') quote = undefined;
      continue;
    }
    if (current === '-' && next === '-') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === "'" || current === '"' || current === '`') {
      quote = current;
      continue;
    }
    if (current === ';') {
      if (semicolonAt >= 0) return false;
      semicolonAt = index;
    }
  }
  return !quote && !blockComment && (semicolonAt < 0 || sql.slice(semicolonAt + 1).trim() === '');
}

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
