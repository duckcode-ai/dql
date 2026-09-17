import { normalizeTileQuery, type TileQuery } from '../apps/tile-query.js';

/**
 * Durable, review-draft lineage for a reusable block saved from one settled
 * App Dataset tile. It stores governed identities and content fingerprints,
 * never result rows, SQL text, raw persona data, or an execution receipt.
 */
export interface DatasetTileProvenanceV1 {
  version: 1;
  kind: 'dataset_tile_provenance';
  appId: string;
  pageId: string;
  tileId: string;
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
  sqlFingerprint: string;
  schemaFingerprint: string;
  resultFingerprint: string;
  createdAt: string;
}

/**
 * Lineage preserved when a user explicitly converts one legacy semantic tile
 * to a field-query Dataset tile. The original payload stays JSON-safe so a
 * human can review what was mapped; it is not executable authority.
 */
export interface SemanticTileConversionProvenanceV1 {
  version: 1;
  kind: 'semantic_tile_conversion_provenance';
  legacyIdentityFingerprint: string;
  legacyTileFingerprint: string;
  legacyPayload: Record<string, unknown>;
  datasetId: string;
  sourceRevision: string;
  contractFingerprint: string;
  queryFingerprint: string;
  equivalenceProofFingerprint: string;
  convertedAt: string;
}

/** Metadata-only result of an M4 fresh same-read-scope comparison. */
export interface EquivalenceProofV1 {
  version: 1;
  kind: 'dataset_equivalence_proof';
  datasetReceiptFingerprint: string;
  candidateReceiptFingerprint: string;
  schemaFingerprint: string;
  resultFingerprint: string;
  executionIdentityFingerprint: string;
  ordering: 'ordered' | 'multiset';
  rowCount: number;
  provedAt: string;
}

/**
 * Cache delivery is intentionally distinct from a fresh execution receipt.
 * It retains the original execution receipt id and exposes cache freshness,
 * but cannot authorize a current read-scope, proof, or publication claim.
 */
export interface DatasetCacheDeliveryReceiptV1 {
  version: 1;
  kind: 'dataset_cache_delivery';
  cacheKey: string;
  originalReceiptId: string;
  sourceRevision: string;
  contractFingerprint: string;
  targetFingerprint: string;
  cachedAt: string;
  expiresAt: string;
}

export function normalizeDatasetTileProvenance(value: unknown): DatasetTileProvenanceV1 | undefined {
  const record = objectRecord(value);
  const query = normalizeTileQuery(record?.query);
  if (!record || record.version !== 1 || record.kind !== 'dataset_tile_provenance' || !query) return undefined;
  const appId = text(record.appId);
  const pageId = text(record.pageId);
  const tileId = text(record.tileId);
  const datasetId = text(record.datasetId);
  const sourceRevision = text(record.sourceRevision);
  const contractFingerprint = text(record.contractFingerprint);
  const queryFingerprint = text(record.queryFingerprint);
  const filterFingerprint = text(record.filterFingerprint);
  const parameterFingerprint = text(record.parameterFingerprint);
  const interactionFingerprint = text(record.interactionFingerprint);
  const snapshotFingerprint = text(record.snapshotFingerprint);
  const targetFingerprint = text(record.targetFingerprint);
  const personaPolicyFingerprint = text(record.personaPolicyFingerprint);
  const receiptId = text(record.receiptId);
  const sqlFingerprint = text(record.sqlFingerprint);
  const schemaFingerprint = text(record.schemaFingerprint);
  const resultFingerprint = text(record.resultFingerprint);
  const createdAt = text(record.createdAt);
  if (!appId || !pageId || !tileId || !datasetId || !sourceRevision || !contractFingerprint
    || !queryFingerprint || !filterFingerprint || !parameterFingerprint || !interactionFingerprint
    || !snapshotFingerprint || !targetFingerprint || !personaPolicyFingerprint || !receiptId
    || !sqlFingerprint || !schemaFingerprint || !resultFingerprint || !createdAt) return undefined;
  return {
    version: 1,
    kind: 'dataset_tile_provenance',
    appId,
    pageId,
    tileId,
    datasetId,
    sourceRevision,
    contractFingerprint,
    query,
    queryFingerprint,
    filterFingerprint,
    parameterFingerprint,
    interactionFingerprint,
    snapshotFingerprint,
    targetFingerprint,
    personaPolicyFingerprint,
    receiptId,
    sqlFingerprint,
    schemaFingerprint,
    resultFingerprint,
    createdAt,
  };
}

export function normalizeSemanticTileConversionProvenance(value: unknown): SemanticTileConversionProvenanceV1 | undefined {
  const record = objectRecord(value);
  const legacyPayload = objectRecord(record?.legacyPayload);
  if (!record || record.version !== 1 || record.kind !== 'semantic_tile_conversion_provenance' || !legacyPayload || !isJsonValue(legacyPayload)) return undefined;
  const legacyIdentityFingerprint = text(record.legacyIdentityFingerprint);
  const legacyTileFingerprint = text(record.legacyTileFingerprint);
  const datasetId = text(record.datasetId);
  const sourceRevision = text(record.sourceRevision);
  const contractFingerprint = text(record.contractFingerprint);
  const queryFingerprint = text(record.queryFingerprint);
  const equivalenceProofFingerprint = text(record.equivalenceProofFingerprint);
  const convertedAt = text(record.convertedAt);
  if (!legacyIdentityFingerprint || !legacyTileFingerprint || !datasetId || !sourceRevision || !contractFingerprint
    || !queryFingerprint || !equivalenceProofFingerprint || !convertedAt) return undefined;
  return {
    version: 1,
    kind: 'semantic_tile_conversion_provenance',
    legacyIdentityFingerprint,
    legacyTileFingerprint,
    legacyPayload,
    datasetId,
    sourceRevision,
    contractFingerprint,
    queryFingerprint,
    equivalenceProofFingerprint,
    convertedAt,
  };
}

export function normalizeEquivalenceProof(value: unknown): EquivalenceProofV1 | undefined {
  const record = objectRecord(value);
  if (!record || record.version !== 1 || record.kind !== 'dataset_equivalence_proof') return undefined;
  const datasetReceiptFingerprint = text(record.datasetReceiptFingerprint);
  const candidateReceiptFingerprint = text(record.candidateReceiptFingerprint);
  const schemaFingerprint = text(record.schemaFingerprint);
  const resultFingerprint = text(record.resultFingerprint);
  const executionIdentityFingerprint = text(record.executionIdentityFingerprint);
  const ordering = record.ordering === 'ordered' || record.ordering === 'multiset' ? record.ordering : undefined;
  const rowCount = typeof record.rowCount === 'number' && Number.isInteger(record.rowCount) && record.rowCount >= 0 ? record.rowCount : undefined;
  const provedAt = text(record.provedAt);
  if (!datasetReceiptFingerprint || !candidateReceiptFingerprint || !schemaFingerprint || !resultFingerprint
    || !executionIdentityFingerprint || !ordering || rowCount === undefined || !provedAt) return undefined;
  return {
    version: 1,
    kind: 'dataset_equivalence_proof',
    datasetReceiptFingerprint,
    candidateReceiptFingerprint,
    schemaFingerprint,
    resultFingerprint,
    executionIdentityFingerprint,
    ordering,
    rowCount,
    provedAt,
  };
}

export function normalizeDatasetCacheDeliveryReceipt(value: unknown): DatasetCacheDeliveryReceiptV1 | undefined {
  const record = objectRecord(value);
  if (!record || record.version !== 1 || record.kind !== 'dataset_cache_delivery') return undefined;
  const cacheKey = text(record.cacheKey);
  const originalReceiptId = text(record.originalReceiptId);
  const sourceRevision = text(record.sourceRevision);
  const contractFingerprint = text(record.contractFingerprint);
  const targetFingerprint = text(record.targetFingerprint);
  const cachedAt = text(record.cachedAt);
  const expiresAt = text(record.expiresAt);
  if (!cacheKey || !originalReceiptId || !sourceRevision || !contractFingerprint || !targetFingerprint || !cachedAt || !expiresAt) return undefined;
  return {
    version: 1,
    kind: 'dataset_cache_delivery',
    cacheKey,
    originalReceiptId,
    sourceRevision,
    contractFingerprint,
    targetFingerprint,
    cachedAt,
    expiresAt,
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  const record = objectRecord(value);
  return Boolean(record && Object.values(record).every(isJsonValue));
}
