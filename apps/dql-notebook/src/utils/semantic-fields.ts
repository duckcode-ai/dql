import type { QueryResult } from '../store/types';
import { inferColumnKind, columnKindToChartRole, type ChartColumnRole } from './column-kind';

export type FieldKind = 'metric' | 'dimension' | 'column';

export interface ClassifiedField {
  name: string;
  kind: FieldKind;
  /** Present only for plain (non-semantic) columns; drives chart-builder roles and icons. */
  chartRole?: ChartColumnRole;
}

export interface ClassifiedColumns {
  metrics: string[];
  dimensions: string[];
  /** Raw columns that are not a semantic metric or dimension. */
  columns: string[];
  /** Every field in display order (metrics → dims → plain cols) with its kind. */
  fields: ClassifiedField[];
  /** True when the upstream result had no semantic refs at all. */
  hasSemanticBinding: boolean;
}

/**
 * Partition a result's columns into semantic metrics, semantic dimensions, and
 * plain columns. Metrics and dimensions come from the server-resolved
 * `QueryResult.semanticRefs`; anything not in either list is a raw column.
 */
export function classifyColumns(result: QueryResult | undefined): ClassifiedColumns {
  if (!result) {
    return { metrics: [], dimensions: [], columns: [], fields: [], hasSemanticBinding: false };
  }

  const refMetrics = new Set(result.semanticRefs?.metrics ?? []);
  const refDims = new Set(result.semanticRefs?.dimensions ?? []);
  const hasSemanticBinding = refMetrics.size > 0 || refDims.size > 0;

  const metrics: string[] = [];
  const dimensions: string[] = [];
  const columns: string[] = [];
  const fields: ClassifiedField[] = [];

  for (const col of result.columns) {
    if (refMetrics.has(col)) {
      metrics.push(col);
      fields.push({ name: col, kind: 'metric' });
    } else if (refDims.has(col)) {
      dimensions.push(col);
      fields.push({ name: col, kind: 'dimension' });
    }
  }

  for (const col of result.columns) {
    if (refMetrics.has(col) || refDims.has(col)) continue;
    columns.push(col);
    fields.push({
      name: col,
      kind: 'column',
      chartRole: columnKindToChartRole(inferColumnKind(col, result.rows)),
    });
  }

  return { metrics, dimensions, columns, fields, hasSemanticBinding };
}

/** Icon + color pair for a field kind; used in typed pickers and chips. */
export function fieldKindIcon(kind: FieldKind): string {
  if (kind === 'metric') return '#';
  if (kind === 'dimension') return '∴';
  return 'A';
}

export function fieldKindColor(kind: FieldKind, accent: string): string {
  if (kind === 'metric') return accent;
  if (kind === 'dimension') return '#e3b341';
  return '#56d364';
}

export function fieldKindLabel(kind: FieldKind): string {
  if (kind === 'metric') return 'metric';
  if (kind === 'dimension') return 'dimension';
  return 'column';
}
