import type { DatasetDescriptor, DatasetField, DatasetPhysicalField } from '@duckcodeailabs/dql-core/datasets/descriptor';
import { datasetTileVisualizationCompatibility, type TileQuery } from '@duckcodeailabs/dql-core/apps/tile-query';

/**
 * Click-a-field tile building. A measure click adds or removes a value; a
 * dimension or time click adds or removes a grouping. The result is always an
 * ordinary TileQuery — the Dataset contract still validates it on every run.
 */

export type TileView = 'kpi' | 'chart' | 'table';

export const EMPTY_TILE_QUERY: TileQuery = { dimensions: [], measures: [], respectsGlobalFilters: true };

export type FieldGroups = {
  measures: DatasetField[];
  time: DatasetPhysicalField[];
  dimensions: DatasetPhysicalField[];
  review: DatasetField[];
};

/** Fields in the order the Data panel lists them. Suggested fields are shown but cannot be used. */
export function groupDatasetFields(descriptor: DatasetDescriptor, search = ''): FieldGroups {
  const needle = search.trim().toLowerCase();
  const matches = (field: DatasetField) => !needle
    || field.name.toLowerCase().includes(needle)
    || field.name.replace(/_/g, ' ').toLowerCase().includes(needle);
  const groups: FieldGroups = { measures: [], time: [], dimensions: [], review: [] };
  for (const field of descriptor.fields) {
    if (!matches(field)) continue;
    if (field.status !== 'approved') groups.review.push(field);
    else if (field.kind === 'measure') groups.measures.push(field);
    else if (field.role === 'time' || field.type === 'date' || field.type === 'timestamp') groups.time.push(field);
    else groups.dimensions.push(field);
  }
  return groups;
}

/** The grain a time field is grouped by when picked: month when offered, else its base grain. */
export function defaultTimeGrain(field: DatasetPhysicalField): string | undefined {
  const grains = field.time?.grains ?? [];
  if (grains.includes('month')) return 'month';
  return field.time?.baseGrain ?? grains[0];
}

export function isTimeField(field: DatasetField): field is DatasetPhysicalField {
  return field.kind === 'physical' && (field.role === 'time' || field.type === 'date' || field.type === 'timestamp');
}

/** Field names a query already uses, for check marks in the field list. */
export function queryFieldNames(query: TileQuery | undefined): Set<string> {
  const names = new Set<string>();
  for (const measure of query?.measures ?? []) names.add(measure.measure.toLowerCase());
  for (const dimension of query?.dimensions ?? []) names.add(dimension.field.toLowerCase());
  return names;
}

export function toggleFieldInQuery(query: TileQuery, field: DatasetField): TileQuery {
  const name = field.name;
  const lower = name.toLowerCase();
  let measures = query.measures;
  let dimensions = query.dimensions;
  if (field.kind === 'measure') {
    measures = measures.some((measure) => measure.measure.toLowerCase() === lower)
      ? measures.filter((measure) => measure.measure.toLowerCase() !== lower)
      : [...measures, { measure: name }];
  } else if (dimensions.some((dimension) => dimension.field.toLowerCase() === lower)) {
    dimensions = dimensions.filter((dimension) => dimension.field.toLowerCase() !== lower);
  } else {
    const grain = isTimeField(field) ? defaultTimeGrain(field) : undefined;
    dimensions = [...dimensions, { field: name, ...(grain ? { timeGrain: grain } : {}) }];
  }
  // Order follows the fields: biggest first for a category, time runs in
  // order on its own. Stale sort/limit keys never survive a field change.
  const { orderBy: _orderBy, limit: _limit, detail: _detail, detailColumns: _detailColumns, ...rest } = query;
  const categorical = dimensions.length > 0 && !dimensions.some((dimension) => dimension.timeGrain);
  return {
    ...rest,
    measures,
    dimensions,
    ...(categorical && measures[0] ? { orderBy: [{ alias: measures[0].alias ?? measures[0].measure, direction: 'desc' as const }] } : {}),
  };
}

/** The view a picked set of fields reads best as. */
export function autoTileView(query: TileQuery): TileView {
  if (query.detail) return 'table';
  if (query.dimensions.length === 0) return query.measures.length === 1 ? 'kpi' : 'table';
  const compatibility = datasetTileVisualizationCompatibility(query, 'bar');
  return compatibility.compatible ? 'chart' : 'table';
}

/** The concrete visualization a view renders as for this query. */
export function tileVisualization(query: TileQuery, view: TileView): 'single_value' | 'bar' | 'line' | 'table' {
  if (view === 'kpi') return 'single_value';
  if (view === 'table') return 'table';
  return query.dimensions.some((dimension) => dimension.timeGrain) ? 'line' : 'bar';
}

export function defaultTileTitle(query: TileQuery, label: (name: string) => string): string {
  if (!query.measures.length) return 'Untitled tile';
  const values = query.measures.map((measure) => label(measure.measure));
  const head = values.length > 2 ? `${values[0]} and ${values.length - 1} more` : values.join(' and ');
  if (!query.dimensions.length) return head;
  const groups = query.dimensions.map((dimension) => dimension.timeGrain ? label(dimension.timeGrain) : label(dimension.field));
  return `${head} by ${groups.join(' and ').toLowerCase()}`;
}
