export type DqlArtifactKind = 'certified_block' | 'semantic_block' | 'sql_block';

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
    ...(limit === undefined ? {} : { limit }),
  };
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
