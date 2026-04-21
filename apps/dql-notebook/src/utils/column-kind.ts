export type ColumnKind = 'numeric' | 'string' | 'date' | 'bool' | 'json';

const TEMPORAL_NAME = /date|time|_at$|_on$|timestamp/i;

function isNumeric(v: unknown): boolean {
  return typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(Number(v)));
}

export function inferColumnKind(column: string, rows: Record<string, unknown>[]): ColumnKind {
  if (TEMPORAL_NAME.test(column)) return 'date';
  const sample = rows.slice(0, 40).map((r) => r[column]).filter((v) => v !== null && v !== undefined);
  if (sample.length === 0) return 'string';
  if (sample.every((v) => typeof v === 'boolean')) return 'bool';
  if (sample.every((v) => typeof v === 'object')) return 'json';
  const numeric = sample.filter(isNumeric).length;
  if (numeric / sample.length > 0.8) return 'numeric';
  return 'string';
}

/** Chart builder partition: measures go on Y, dimensions on X, temporals on X/facet. */
export type ChartColumnRole = 'measure' | 'dimension' | 'temporal';

export function columnKindToChartRole(kind: ColumnKind): ChartColumnRole {
  if (kind === 'numeric') return 'measure';
  if (kind === 'date') return 'temporal';
  return 'dimension';
}
