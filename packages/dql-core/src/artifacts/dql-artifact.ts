import type { BlockParameterBinding, BlockParameterDefinition, BlockParameterPolicy } from '../blocks/parameters.js';

export type DqlArtifactKind = 'certified_block' | 'semantic_block' | 'sql_block';
export type DqlArtifactPersistence = 'transient' | 'saved';
export type DqlArtifactTrustState = 'certified' | 'governed' | 'review_required';

export interface DqlArtifactFilter {
  dimension: string;
  operator: string;
  values: string[];
}

export interface DqlArtifactOrderBy {
  name: string;
  direction: 'asc' | 'desc';
}

export interface DqlArtifactTimeDimension {
  name: string;
  granularity: string;
}

/**
 * Redacted proof that an Ask result was produced by this executable artifact.
 * Fingerprints deliberately contain no SQL text, parameter values, or rows.
 */
export interface DqlArtifactExecutionReceipt {
  sourceFingerprint: string;
  compiledSqlFingerprint: string;
  parameterFingerprint: string;
  resultFingerprint: string;
}

export interface DqlArtifactReference {
  kind: DqlArtifactKind;
  source: string;
  name?: string;
  sourcePath?: string;
  metrics?: string[];
  dimensions?: string[];
  filters?: DqlArtifactFilter[];
  timeDimension?: DqlArtifactTimeDimension;
  orderBy?: DqlArtifactOrderBy[];
  limit?: number;
  /** Typed runtime contract carried with transient, draft, and certified artifacts. */
  parameters?: BlockParameterDefinition[];
  /** Values used for the current execution. Changing them must not require another AI search. */
  parameterValues?: Record<string, unknown>;
  /** Transient answers become saved drafts without regenerating their DQL source. */
  persistence?: DqlArtifactPersistence;
  /** Trust is independent from executability and persistence. */
  trustState?: DqlArtifactTrustState;
  /** Optional compiled evidence. The DQL source remains the primary artifact. */
  compiledSql?: string;
  /** Exact execution contract used for the displayed result. */
  executionReceipt?: DqlArtifactExecutionReceipt;
}

export function normalizeDqlArtifactReference(value: unknown): DqlArtifactReference | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const kind = normalizeDqlArtifactKind(record.kind);
  const source = cleanString(record.source);
  if (!kind || !source) return undefined;
  const limit = finitePositiveInteger(record.limit);
  return {
    kind,
    source,
    name: cleanString(record.name),
    sourcePath: cleanString(record.sourcePath),
    metrics: cleanStringList(record.metrics),
    dimensions: cleanStringList(record.dimensions),
    filters: normalizeDqlArtifactFilters(record.filters),
    timeDimension: normalizeDqlArtifactTimeDimension(record.timeDimension),
    orderBy: normalizeDqlArtifactOrderBy(record.orderBy),
    parameters: normalizeDqlArtifactParameters(record.parameters),
    parameterValues: normalizeParameterValues(record.parameterValues),
    persistence: normalizeDqlArtifactPersistence(record.persistence),
    trustState: normalizeDqlArtifactTrustState(record.trustState),
    compiledSql: cleanString(record.compiledSql),
    executionReceipt: normalizeExecutionReceipt(record.executionReceipt),
    ...(limit === undefined ? {} : { limit }),
  };
}

function normalizeExecutionReceipt(value: unknown): DqlArtifactExecutionReceipt | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const sourceFingerprint = normalizeFingerprint(record.sourceFingerprint);
  const compiledSqlFingerprint = normalizeFingerprint(record.compiledSqlFingerprint);
  const parameterFingerprint = normalizeFingerprint(record.parameterFingerprint);
  const resultFingerprint = normalizeFingerprint(record.resultFingerprint);
  return sourceFingerprint && compiledSqlFingerprint && parameterFingerprint && resultFingerprint
    ? { sourceFingerprint, compiledSqlFingerprint, parameterFingerprint, resultFingerprint }
    : undefined;
}

function normalizeFingerprint(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined;
}

export function normalizeDqlArtifactKind(value: unknown): DqlArtifactKind | undefined {
  return value === 'certified_block' || value === 'semantic_block' || value === 'sql_block'
    ? value
    : undefined;
}

function normalizeDqlArtifactFilters(value: unknown): DqlArtifactFilter[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filters = value.flatMap((item): DqlArtifactFilter[] => {
    const record = objectRecord(item);
    if (!record) return [];
    const dimension = cleanString(record.dimension);
    const operator = cleanString(record.operator);
    if (!dimension || !operator) return [];
    return [{ dimension, operator, values: cleanStringList(record.values) ?? [] }];
  });
  return filters.length ? filters : undefined;
}

function normalizeDqlArtifactTimeDimension(value: unknown): DqlArtifactTimeDimension | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const name = cleanString(record.name);
  const granularity = cleanString(record.granularity);
  return name && granularity ? { name, granularity } : undefined;
}

function normalizeDqlArtifactOrderBy(value: unknown): DqlArtifactOrderBy[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const orderBy = value.flatMap((item): DqlArtifactOrderBy[] => {
    const record = objectRecord(item);
    if (!record) return [];
    const name = cleanString(record.name);
    const direction = record.direction === 'asc' || record.direction === 'desc' ? record.direction : undefined;
    return name && direction ? [{ name, direction }] : [];
  });
  return orderBy.length ? orderBy : undefined;
}

function normalizeDqlArtifactParameters(value: unknown): BlockParameterDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const parameters = value.flatMap((item): BlockParameterDefinition[] => {
    const record = objectRecord(item);
    const name = cleanString(record?.name);
    const type = normalizeParameterType(record?.type);
    const policy = normalizeParameterPolicy(record?.policy);
    if (!record || !name || !type || !policy || seen.has(name)) return [];
    seen.add(name);
    const binding = normalizeParameterBinding(record.binding);
    return [{
      name,
      type,
      required: record.required === true,
      ...(record.default === undefined ? {} : { default: record.default }),
      policy,
      ...(binding ? { binding } : {}),
    }];
  });
  return parameters.length ? parameters : undefined;
}

function normalizeParameterType(value: unknown): BlockParameterDefinition['type'] | undefined {
  return value === 'string' || value === 'number' || value === 'boolean' || value === 'date'
    || value === 'string[]' || value === 'number[]' || value === 'date[]'
    ? value
    : undefined;
}

function normalizeParameterPolicy(value: unknown): BlockParameterPolicy | undefined {
  return value === 'dynamic' || value === 'static' || value === 'business' || value === 'derived'
    || value === 'optional' || value === 'ambiguous_review_required'
    ? value
    : undefined;
}

function normalizeParameterBinding(value: unknown): BlockParameterBinding | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  if (record.kind === 'sql_value') return { kind: 'sql_value' };
  if (record.kind === 'limit') return { kind: 'limit' };
  const field = cleanString(record.field);
  if (record.kind === 'semantic_filter' && field
    && (record.operator === 'equals' || record.operator === 'in' || record.operator === 'gte' || record.operator === 'lte')) {
    return { kind: 'semantic_filter', field, operator: record.operator };
  }
  return undefined;
}

function normalizeParameterValues(value: unknown): Record<string, unknown> | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record).filter(([name]) => name.trim().length > 0);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizeDqlArtifactPersistence(value: unknown): DqlArtifactPersistence | undefined {
  return value === 'transient' || value === 'saved' ? value : undefined;
}

function normalizeDqlArtifactTrustState(value: unknown): DqlArtifactTrustState | undefined {
  return value === 'certified' || value === 'governed' || value === 'review_required' ? value : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function cleanStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
  return values.length ? values : undefined;
}

function finitePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
