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
  model?: string;
  defaults?: { agg_time_dimension?: string };
  entities?: Array<{
    name: string;
    type: string; // primary, foreign, unique, natural
    expr?: string;
  }>;
  dimensions?: Array<{
    name: string;
    type: string;
    expr?: string;
    type_params?: { time_granularity?: string };
  }>;
  measures?: Array<{
    name: string;
    agg: string;
    expr?: string;
    description?: string;
  }>;
}

interface DbtMetric {
  name: string;
  label?: string;
  description?: string;
  type: string; // simple, derived, cumulative, etc.
  type_params?: {
    measure?: string;
    expr?: string;
  };
}

export class DbtProvider implements SemanticLayerProvider {
  readonly name = 'dbt';

  load(config: SemanticLayerProviderConfig, projectRoot: string): SemanticLayer {
    const dbtRoot = config.projectPath
      ? join(projectRoot, config.projectPath)
      : projectRoot;

    // Prefer target/manifest.json when available: it is the authoritative,
    // fully-resolved view of the dbt project (including semantic_models and
    // metrics). Walking models/**/*.yml is kept as a fallback for projects
    // that haven't run `dbt parse` / `dbt compile` yet.
    const manifestPath = join(dbtRoot, 'target', 'manifest.json');
    if (existsSync(manifestPath)) {
      const layer = loadFromManifestJson(manifestPath);
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
    const measureLookup = new Map<string, { sql: string; agg: string; modelName: string; table: string }>();

    for (const model of allModels) {
      const tableName = resolveTableName(model);
      for (const measure of model.measures ?? []) {
        measureLookup.set(measure.name, {
          sql: measure.expr ?? measure.name,
          agg: measure.agg,
          modelName: model.name,
          table: tableName,
        });
      }
    }

    // Convert each semantic model into a DQL CubeDefinition
    for (const model of allModels) {
      const cube = convertSemanticModel(model);
      layer.addCube(cube);
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
function loadFromManifestJson(manifestPath: string): SemanticLayer | null {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }

  const semanticModelsRaw = (manifest.semantic_models ?? {}) as Record<string, DbtManifestSemanticModel>;
  const metricsRaw = (manifest.metrics ?? {}) as Record<string, DbtManifestMetric>;

  const models: DbtSemanticModel[] = [];
  for (const node of Object.values(semanticModelsRaw)) {
    if (!node || typeof node !== 'object' || !node.name) continue;
    models.push({
      name: node.name,
      // node.model is already a string like "ref('stg_orders')" in manifests
      model: typeof node.model === 'string' ? node.model : undefined,
      defaults: node.defaults,
      entities: node.entities,
      dimensions: node.dimensions,
      measures: node.measures,
    });
  }

  const dbtMetrics: DbtMetric[] = [];
  for (const node of Object.values(metricsRaw)) {
    if (!node || typeof node !== 'object' || !node.name) continue;
    dbtMetrics.push({
      name: node.name,
      label: node.label,
      description: node.description,
      type: node.type ?? 'simple',
      type_params: node.type_params,
    });
  }

  if (models.length === 0 && dbtMetrics.length === 0) {
    // No semantic content — let the caller try the YAML fallback.
    return null;
  }

  const layer = new SemanticLayer();

  // Build measure lookup first (identical logic to the YAML path).
  const measureLookup = new Map<string, { sql: string; agg: string; modelName: string; table: string }>();
  for (const model of models) {
    const tableName = resolveTableName(model);
    for (const measure of model.measures ?? []) {
      measureLookup.set(measure.name, {
        sql: measure.expr ?? measure.name,
        agg: measure.agg,
        modelName: model.name,
        table: tableName,
      });
    }
  }

  for (const model of models) {
    layer.addCube(convertSemanticModel(model));
  }
  for (const dbtMetric of dbtMetrics) {
    const metric = convertDbtMetric(dbtMetric, measureLookup);
    if (metric) layer.addMetric(metric);
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

/** Convert a dbt semantic model to a DQL CubeDefinition. */
function convertSemanticModel(model: DbtSemanticModel): CubeDefinition {
  const tableName = resolveTableName(model);

  const measures: MetricDefinition[] = (model.measures ?? []).map((m) => ({
    name: m.name,
    label: m.name,
    description: m.description ?? '',
    domain: '',
    sql: buildAggSql(m.agg, m.expr ?? m.name),
    type: AGG_TYPE_MAP[m.agg] ?? 'custom',
    table: tableName,
    cube: model.name,
    aggregation: m.agg,
    source: {
      provider: 'dbt',
      objectType: 'measure',
      objectId: `${model.name}.${m.name}`,
      objectName: m.name,
    },
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
        label: dim.name,
        description: '',
        sql: sqlExpr,
        type: 'date',
        table: tableName,
        cube: model.name,
        granularities: defaultGrans,
        primaryTime: isPrimary,
        source: {
          provider: 'dbt',
          objectType: 'time_dimension',
          objectId: `${model.name}.${dim.name}`,
          objectName: dim.name,
        },
      });
    } else {
      dimensions.push({
        name: dim.name,
        label: dim.name,
        description: '',
        sql: sqlExpr,
        type: dqlType,
        table: tableName,
        cube: model.name,
        source: {
          provider: 'dbt',
          objectType: 'dimension',
          objectId: `${model.name}.${dim.name}`,
          objectName: dim.name,
        },
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
    label: model.name,
    description: '',
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
    source: {
      provider: 'dbt',
      objectType: 'semantic_model',
      objectId: model.name,
      objectName: model.name,
    },
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
  measureLookup: Map<string, { sql: string; agg: string; modelName: string; table: string }>,
): MetricDefinition | null {
  const measureName = dbtMetric.type_params?.measure;
  if (!measureName) return null;

  const measureInfo = measureLookup.get(measureName);
  if (!measureInfo) return null;

  return {
    name: dbtMetric.name,
    label: dbtMetric.label ?? dbtMetric.name,
    description: dbtMetric.description ?? '',
    domain: '',
    sql: buildAggSql(measureInfo.agg, measureInfo.sql),
    type: AGG_TYPE_MAP[measureInfo.agg] ?? 'custom',
    table: measureInfo.table,
    cube: measureInfo.modelName,
    aggregation: dbtMetric.type,
    source: {
      provider: 'dbt',
      objectType: 'metric',
      objectId: dbtMetric.name,
      objectName: dbtMetric.name,
    },
  };
}
