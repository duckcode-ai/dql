/**
 * dbt semantic layer provider.
 * Reads dbt's native YAML format (semantic_models + metrics) and maps
 * them to DQL SemanticLayer definitions.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import * as yaml from 'js-yaml';
import {
  SemanticLayer,
  type MetricDefinition,
  type DimensionDefinition,
  type MeasureDefinition,
  type EntityDefinition,
  type SemanticModelDefinition,
  type SavedQueryDefinition,
  type JoinDefinition,
  type CubeDefinition,
  type TimeDimensionDefinition,
} from '../semantic-layer.js';
import type { SemanticLayerProvider, SemanticLayerProviderConfig } from './provider.js';

/** Map dbt aggregation types to DQL metric types. */
const AGG_TYPE_MAP: Record<string, MetricDefinition['type']> = {
  sum: 'sum',
  count: 'count',
  count_distinct: 'count_distinct',
  average: 'avg',
  avg: 'avg',
  min: 'min',
  max: 'max',
};

/** Map dbt dimension types to DQL dimension types. */
const DIM_TYPE_MAP: Record<string, DimensionDefinition['type']> = {
  categorical: 'string',
  time: 'date',
  boolean: 'boolean',
  number: 'number',
};

interface DbtSemanticModel {
  name: string;
  label?: string;
  description?: string;
  model?: string;
  defaults?: { agg_time_dimension?: string };
  entities?: Array<{
    name: string;
    type: string; // primary, foreign, unique, natural
    expr?: string;
    label?: string;
    description?: string;
    role?: string;
    config?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  }>;
  dimensions?: Array<{
    name: string;
    type: string;
    expr?: string;
    label?: string;
    description?: string;
    type_params?: Record<string, unknown> & { time_granularity?: string; validity_params?: Record<string, unknown> };
    config?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  }>;
  measures?: Array<{
    name: string;
    agg: string;
    expr?: string;
    label?: string;
    description?: string;
    agg_time_dimension?: string;
    create_metric?: boolean;
    non_additive_dimension?: Record<string, unknown>;
    filter?: string | Record<string, unknown> | Array<Record<string, unknown>>;
    config?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  }>;
  config?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  package_name?: string;
  original_file_path?: string;
  unique_id?: string;
}

interface DbtMetric {
  name: string;
  label?: string;
  description?: string;
  type: string; // simple, derived, cumulative, etc.
  type_params?: Record<string, unknown> & {
    measure?: string;
    measure_name?: string;
    expr?: string;
    metrics?: unknown[];
    numerator?: unknown;
    denominator?: unknown;
    window?: string;
    grain_to_date?: string;
    conversion_type_params?: Record<string, unknown>;
    cumulative_type_params?: Record<string, unknown>;
    derived_type_params?: Record<string, unknown>;
    ratio_type_params?: Record<string, unknown>;
  };
  filter?: string | Record<string, unknown> | Array<Record<string, unknown>>;
  filters?: Array<Record<string, unknown>>;
  config?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  package_name?: string;
  original_file_path?: string;
  unique_id?: string;
}

interface DbtSavedQuery {
  name: string;
  label?: string;
  description?: string;
  query_params?: {
    metrics?: string[];
    group_by?: string[];
    where?: string | Array<Record<string, unknown>>;
    order_by?: string[];
    limit?: number;
  };
  exports?: Array<Record<string, unknown>>;
  config?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  package_name?: string;
  original_file_path?: string;
  unique_id?: string;
}

export class DbtProvider implements SemanticLayerProvider {
  readonly name = 'dbt';

  load(config: SemanticLayerProviderConfig, projectRoot: string): SemanticLayer {
    const dbtRoot = config.projectPath
      ? join(projectRoot, config.projectPath)
      : projectRoot;

    // Prefer target/semantic_manifest.json when available: it is the
    // MetricFlow/dbt Semantic Layer compatibility artifact and includes saved
    // queries plus resolved semantic metadata. Fall back to manifest.json and
    // then source YAML for projects that have not parsed semantic artifacts yet.
    const semanticManifestPath = join(dbtRoot, 'target', 'semantic_manifest.json');
    if (existsSync(semanticManifestPath)) {
      const layer = loadFromManifestJson(semanticManifestPath, 'semantic_manifest');
      if (layer) return layer;
    }

    const manifestPath = join(dbtRoot, 'target', 'manifest.json');
    if (existsSync(manifestPath)) {
      const layer = loadFromManifestJson(manifestPath, 'manifest');
      if (layer) return layer;
    }

    const layer = new SemanticLayer();
    const modelsDir = join(dbtRoot, 'models');
    if (!existsSync(modelsDir)) return layer;

    // Collect all YAML files recursively
    const yamlFiles = collectYamlFiles(modelsDir);

    // First pass: collect all semantic models so we can resolve measure references
    const allModels: DbtSemanticModel[] = [];
    const allDbtMetrics: DbtMetric[] = [];

    for (const filePath of yamlFiles) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const doc = yaml.load(content) as Record<string, unknown> | null;
        if (!doc || typeof doc !== 'object') continue;

        if (Array.isArray(doc.semantic_models)) {
          for (const model of doc.semantic_models) {
            if (model && typeof model === 'object') {
              allModels.push(model as DbtSemanticModel);
            }
          }
        }

        if (Array.isArray(doc.metrics)) {
          for (const metric of doc.metrics) {
            if (metric && typeof metric === 'object') {
              allDbtMetrics.push(metric as DbtMetric);
            }
          }
        }
      } catch {
        // Skip malformed YAML files
      }
    }

    // Build a measure lookup: measure_name -> { sql, agg, model_name }
    const measureLookup = new Map<string, { sql: string; agg: string; modelName: string; table: string; measure: NonNullable<DbtSemanticModel['measures']>[number] }>();

    for (const model of allModels) {
      const tableName = resolveTableName(model);
      for (const measure of model.measures ?? []) {
        measureLookup.set(measure.name, {
          sql: measure.expr ?? measure.name,
          agg: measure.agg,
          modelName: model.name,
          table: tableName,
          measure,
        });
      }
    }

    // Convert each semantic model into a DQL CubeDefinition
    for (const model of allModels) {
      registerSemanticModel(layer, model);
    }

    // Convert dbt metrics (resolve measure references)
    for (const dbtMetric of allDbtMetrics) {
      const metric = convertDbtMetric(dbtMetric, measureLookup);
      if (metric) {
        layer.addMetric(metric);
      }
    }

    return layer;
  }
}

/**
 * Load semantic_models and metrics from a dbt `target/manifest.json`.
 *
 * dbt's manifest stores these as objects keyed by unique_id
 * (e.g. `semantic_model.jaffle_shop.orders`) with the same field shape as the
 * source YAML — so we can feed them through the existing converters directly.
 *
 * Returns `null` if the manifest is unreadable or contains no semantic nodes,
 * signalling the caller to fall back to the YAML walker.
 */
function loadFromManifestJson(manifestPath: string, artifactKind: 'manifest' | 'semantic_manifest'): SemanticLayer | null {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }

  const semanticModelsRaw = asRecord(manifest.semantic_models);
  const metricsRaw = asRecord(manifest.metrics);
  const savedQueriesRaw = asRecord(manifest.saved_queries ?? manifest.savedQueries);

  const models: DbtSemanticModel[] = [];
  for (const node of Object.values(semanticModelsRaw)) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || !('name' in node)) continue;
    const raw = node as DbtManifestSemanticModel;
    models.push({
      ...raw,
      name: raw.name,
      // node.model is already a string like "ref('stg_orders')" in manifests
      model: typeof raw.model === 'string' ? raw.model : undefined,
      defaults: raw.defaults,
      entities: raw.entities,
      dimensions: raw.dimensions,
      measures: raw.measures,
    });
  }

  const dbtMetrics: DbtMetric[] = [];
  for (const node of Object.values(metricsRaw)) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || !('name' in node)) continue;
    const raw = node as DbtManifestMetric;
    dbtMetrics.push({
      ...raw,
      name: raw.name,
      label: raw.label,
      description: raw.description,
      type: raw.type ?? 'simple',
      type_params: raw.type_params,
    });
  }

  const savedQueries: DbtSavedQuery[] = [];
  for (const node of Object.values(savedQueriesRaw)) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || !('name' in node)) continue;
    const raw = node as DbtSavedQuery;
    savedQueries.push({ ...raw, name: raw.name });
  }

  if (models.length === 0 && dbtMetrics.length === 0 && savedQueries.length === 0) {
    // No semantic content — let the caller try the YAML fallback.
    return null;
  }

  const layer = new SemanticLayer();

  // Build measure lookup first (identical logic to the YAML path).
  const measureLookup = new Map<string, { sql: string; agg: string; modelName: string; table: string; measure: NonNullable<DbtSemanticModel['measures']>[number] }>();
  for (const model of models) {
    const tableName = resolveTableName(model);
    for (const measure of model.measures ?? []) {
      measureLookup.set(measure.name, {
        sql: measure.expr ?? measure.name,
        agg: measure.agg,
        modelName: model.name,
        table: tableName,
        measure,
      });
    }
  }

  for (const model of models) {
    registerSemanticModel(layer, model, artifactKind);
  }
  for (const dbtMetric of dbtMetrics) {
    const metric = convertDbtMetric(dbtMetric, measureLookup);
    if (metric) layer.addMetric(metric);
  }
  for (const savedQuery of savedQueries) {
    layer.addSavedQuery(convertSavedQuery(savedQuery));
  }

  return layer;
}

/** Shape of a `semantic_models.*` entry in dbt's manifest.json. */
interface DbtManifestSemanticModel extends DbtSemanticModel {
  // dbt adds unique_id, package_name, etc. — we only care about the DbtSemanticModel fields.
}

/** Shape of a `metrics.*` entry in dbt's manifest.json. */
interface DbtManifestMetric extends DbtMetric {
  // Same story — manifest.json has extra metadata we don't consume.
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Recursively collect all .yml/.yaml files in a directory. */
function collectYamlFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...collectYamlFiles(fullPath));
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (ext === '.yml' || ext === '.yaml') {
          results.push(fullPath);
        }
      }
    } catch {
      // Skip inaccessible entries
    }
  }
  return results;
}

/** Extract a table name from a dbt semantic model. */
function resolveTableName(model: DbtSemanticModel): string {
  if (model.model) {
    // dbt model refs look like "ref('stg_orders')" - extract the model name
    const match = model.model.match(/ref\(['"](.+?)['"]\)/);
    if (match) return match[1];
    return model.model;
  }
  return model.name;
}

function dbtSource(
  objectType: string,
  objectId: string,
  objectName: string,
  raw?: Record<string, unknown>,
): MetricDefinition['source'] {
  return {
    provider: 'dbt',
    objectType,
    objectId,
    objectName,
    extra: raw
      ? {
          uniqueId: raw.unique_id,
          packageName: raw.package_name,
          path: raw.original_file_path ?? raw.path,
          meta: raw.meta,
          config: raw.config,
          raw,
        }
      : undefined,
  };
}

function registerSemanticModel(
  layer: SemanticLayer,
  model: DbtSemanticModel,
  artifactKind: 'manifest' | 'semantic_manifest' | 'yaml' = 'yaml',
): void {
  const cube = convertSemanticModel(model, artifactKind);
  layer.addCube(cube);
  layer.addSemanticModel(convertSemanticModelDetail(model, cube));
  for (const measure of model.measures ?? []) {
    layer.addMeasure(convertMeasure(model, measure, cube));
  }
  for (const entity of model.entities ?? []) {
    layer.addEntity(convertEntity(model, entity, cube));
  }
}

/** Convert a dbt semantic model to a DQL CubeDefinition. */
function convertSemanticModel(
  model: DbtSemanticModel,
  artifactKind: 'manifest' | 'semantic_manifest' | 'yaml' = 'yaml',
): CubeDefinition {
  const tableName = resolveTableName(model);

  const measures: MetricDefinition[] = (model.measures ?? []).map((m) => ({
    name: m.name,
    label: m.label ?? m.name,
    description: m.description ?? '',
    domain: '',
    sql: buildAggSql(m.agg, m.expr ?? m.name),
    type: AGG_TYPE_MAP[m.agg] ?? 'custom',
    table: tableName,
    cube: model.name,
    aggregation: m.agg,
    filter: m.filter,
    aggTimeDimension: m.agg_time_dimension,
    typeParams: {
      agg: m.agg,
      expr: m.expr,
      agg_time_dimension: m.agg_time_dimension,
      create_metric: m.create_metric,
      non_additive_dimension: m.non_additive_dimension,
    },
    source: dbtSource('measure', `${model.name}.${m.name}`, m.name, {
      ...m,
      semantic_model: model.name,
      artifactKind,
    }),
  }));

  const dimensions: DimensionDefinition[] = [];
  const timeDimensions: TimeDimensionDefinition[] = [];

  for (const dim of model.dimensions ?? []) {
    const dqlType = DIM_TYPE_MAP[dim.type] ?? 'string';
    const sqlExpr = dim.expr ?? dim.name;

    if (dim.type === 'time') {
      const granularity = dim.type_params?.time_granularity ?? 'day';
      const validGranularities = ['day', 'week', 'month', 'quarter', 'year'] as const;
      const defaultGrans: TimeDimensionDefinition['granularities'] = ['day', 'week', 'month', 'quarter', 'year'];
      const isPrimary = model.defaults?.agg_time_dimension === dim.name;

      timeDimensions.push({
        name: dim.name,
        label: dim.label ?? dim.name,
        description: dim.description ?? '',
        sql: sqlExpr,
        type: 'date',
        table: tableName,
        cube: model.name,
        expr: dim.expr,
        isTimeDimension: true,
        typeParams: dim.type_params,
        granularities: defaultGrans,
        primaryTime: isPrimary,
        source: dbtSource('time_dimension', `${model.name}.${dim.name}`, dim.name, {
          ...dim,
          semantic_model: model.name,
          artifactKind,
        }),
      });
    } else {
      dimensions.push({
        name: dim.name,
        label: dim.label ?? dim.name,
        description: dim.description ?? '',
        sql: sqlExpr,
        type: dqlType,
        table: tableName,
        cube: model.name,
        expr: dim.expr,
        typeParams: dim.type_params,
        source: dbtSource('dimension', `${model.name}.${dim.name}`, dim.name, {
          ...dim,
          semantic_model: model.name,
          artifactKind,
        }),
      });
    }
  }

  // Convert entities with foreign type to joins
  const joins: JoinDefinition[] = [];
  for (const entity of model.entities ?? []) {
    if (entity.type === 'foreign') {
      joins.push({
        name: entity.name,
        left: model.name,
        right: entity.name,
        type: 'left',
        sql: `\${left}.${entity.expr ?? entity.name} = \${right}.${entity.name}`,
      });
    }
  }

  return {
    name: model.name,
    label: model.label ?? model.name,
    description: model.description ?? '',
    sql: `SELECT * FROM ${tableName}`,
    table: tableName,
    domain: '',
    measures,
    dimensions,
    timeDimensions,
    joins,
    segments: [],
    preAggregations: [],
    defaultTimeDimension: model.defaults?.agg_time_dimension,
    source: dbtSource('semantic_model', model.unique_id ?? model.name, model.name, {
      ...model,
      artifactKind,
    }),
  };
}

function convertSemanticModelDetail(model: DbtSemanticModel, cube: CubeDefinition): SemanticModelDefinition {
  return {
    name: model.name,
    label: model.label ?? model.name,
    description: model.description ?? '',
    domain: cube.domain,
    model: model.model,
    table: cube.table,
    defaults: model.defaults,
    entities: (model.entities ?? []).map((entity) => entity.name),
    measures: (model.measures ?? []).map((measure) => measure.name),
    dimensions: cube.dimensions.map((dimension) => dimension.name),
    timeDimensions: cube.timeDimensions.map((dimension) => dimension.name),
    tags: cube.tags,
    owner: cube.owner,
    source: cube.source,
  };
}

function convertMeasure(
  model: DbtSemanticModel,
  measure: NonNullable<DbtSemanticModel['measures']>[number],
  cube: CubeDefinition,
): MeasureDefinition {
  return {
    name: measure.name,
    label: measure.label ?? measure.name,
    description: measure.description ?? '',
    domain: cube.domain,
    agg: measure.agg,
    expr: measure.expr,
    table: cube.table,
    cube: model.name,
    aggTimeDimension: measure.agg_time_dimension ?? model.defaults?.agg_time_dimension,
    createMetric: measure.create_metric,
    nonAdditiveDimension: measure.non_additive_dimension,
    filter: measure.filter,
    owner: cube.owner,
    tags: cube.tags,
    source: dbtSource('measure', `${model.name}.${measure.name}`, measure.name, {
      ...measure,
      semantic_model: model.name,
    }),
  };
}

function convertEntity(
  model: DbtSemanticModel,
  entity: NonNullable<DbtSemanticModel['entities']>[number],
  cube: CubeDefinition,
): EntityDefinition {
  return {
    name: entity.name,
    label: entity.label ?? entity.name,
    description: entity.description ?? '',
    domain: cube.domain,
    type: entity.type,
    expr: entity.expr,
    table: cube.table,
    cube: model.name,
    role: entity.role,
    owner: cube.owner,
    tags: cube.tags,
    source: dbtSource('entity', `${model.name}.${entity.name}`, entity.name, {
      ...entity,
      semantic_model: model.name,
    }),
  };
}

/** Build an aggregate SQL expression from a dbt agg type and expression. */
function buildAggSql(agg: string, expr: string): string {
  switch (agg) {
    case 'sum': return `SUM(${expr})`;
    case 'count': return `COUNT(${expr})`;
    case 'count_distinct': return `COUNT(DISTINCT ${expr})`;
    case 'average':
    case 'avg': return `AVG(${expr})`;
    case 'min': return `MIN(${expr})`;
    case 'max': return `MAX(${expr})`;
    default: return expr;
  }
}

/** Convert a dbt metric definition to a DQL MetricDefinition. */
function convertDbtMetric(
  dbtMetric: DbtMetric,
  measureLookup: Map<string, { sql: string; agg: string; modelName: string; table: string; measure: NonNullable<DbtSemanticModel['measures']>[number] }>,
): MetricDefinition | null {
  const measureName = firstString(dbtMetric.type_params?.measure, dbtMetric.type_params?.measure_name);
  const measureInfo = measureName ? measureLookup.get(measureName) : undefined;
  const metricRefs = collectMetricRefs(dbtMetric);
  const fallbackMeasure = metricRefs.map((ref) => measureLookup.get(ref)).find(Boolean);
  const resolvedMeasure = measureInfo ?? fallbackMeasure;

  return {
    name: dbtMetric.name,
    label: dbtMetric.label ?? dbtMetric.name,
    description: dbtMetric.description ?? '',
    domain: '',
    sql: resolvedMeasure
      ? buildAggSql(resolvedMeasure.agg, resolvedMeasure.sql)
      : String(dbtMetric.type_params?.expr ?? dbtMetric.name),
    type: resolvedMeasure ? (AGG_TYPE_MAP[resolvedMeasure.agg] ?? 'custom') : 'custom',
    table: resolvedMeasure?.table ?? '',
    cube: resolvedMeasure?.modelName,
    aggregation: dbtMetric.type,
    metricType: dbtMetric.type,
    typeParams: dbtMetric.type_params,
    filter: dbtMetric.filter ?? dbtMetric.filters,
    aggTimeDimension: resolvedMeasure?.measure.agg_time_dimension,
    source: dbtSource('metric', dbtMetric.unique_id ?? dbtMetric.name, dbtMetric.name, dbtMetric as unknown as Record<string, unknown>),
  };
}

function convertSavedQuery(savedQuery: DbtSavedQuery): SavedQueryDefinition {
  const groupBy = savedQuery.query_params?.group_by ?? [];
  const timeRef = groupBy.find((value) => value.includes('__')) ?? groupBy.find((value) => value.toLowerCase().includes('metric_time'));
  const [timeDimension, granularity] = timeRef?.split('__') ?? [];
  return {
    name: savedQuery.name,
    label: savedQuery.label ?? savedQuery.name,
    description: savedQuery.description ?? '',
    domain: '',
    metrics: savedQuery.query_params?.metrics ?? [],
    dimensions: groupBy.filter((value) => value !== timeRef),
    timeDimension: timeDimension || undefined,
    granularity,
    filters: savedQuery.query_params?.where,
    exports: savedQuery.exports,
    tags: Array.isArray(savedQuery.config?.tags) ? savedQuery.config.tags.map(String) : undefined,
    source: dbtSource('saved_query', savedQuery.unique_id ?? savedQuery.name, savedQuery.name, savedQuery as unknown as Record<string, unknown>),
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function collectMetricRefs(metric: DbtMetric): string[] {
  const refs = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value) return;
    if (typeof value === 'string') {
      refs.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === 'object') {
      const raw = value as Record<string, unknown>;
      for (const key of ['name', 'metric', 'metric_name', 'measure', 'measure_name']) visit(raw[key]);
      for (const nested of Object.values(raw)) {
        if (typeof nested === 'object') visit(nested);
      }
    }
  };
  visit(metric.type_params?.metrics);
  visit(metric.type_params?.numerator);
  visit(metric.type_params?.denominator);
  return Array.from(refs);
}
