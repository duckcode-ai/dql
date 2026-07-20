/**
 * dbt semantic layer provider.
 * Reads dbt's native YAML format (semantic_models + metrics) and maps
 * them to DQL SemanticLayer definitions.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
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
  node_relation?: {
    alias?: string;
    schema_name?: string;
    database?: string;
    relation_name?: string;
  };
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
      ? resolve(projectRoot, config.projectPath)
      : resolve(projectRoot);
    const dbtProjectSettings = readDbtProjectSettings(dbtRoot);
    const manifestPath = resolve(
      dbtRoot,
      config.manifestPath ?? join(dbtProjectSettings.targetPath, 'manifest.json'),
    );
    const semanticManifestPath = resolve(
      dbtRoot,
      config.semanticManifestPath ?? join(dirname(manifestPath), 'semantic_manifest.json'),
    );

    // Prefer target/semantic_manifest.json when available: it is the
    // MetricFlow/dbt Semantic Layer compatibility artifact and includes saved
    // queries plus resolved semantic metadata. Fall back to manifest.json and
    // then source YAML for projects that have not parsed semantic artifacts yet.
    let artifactLayer: SemanticLayer | null = null;
    if (existsSync(semanticManifestPath)) {
      artifactLayer = loadFromManifestJson(semanticManifestPath, 'semantic_manifest');
      if (artifactLayer && artifactHasTopLevelMetrics(semanticManifestPath)) return artifactLayer;
    }

    let manifestInventory: SemanticLayer | null = null;
    if (existsSync(manifestPath)) {
      const layer = loadFromManifestJson(manifestPath, 'manifest');
      if (layer && artifactHasTopLevelMetrics(manifestPath)) return layer;
      artifactLayer ??= layer;
      manifestInventory = loadDbtModelInventoryFromManifestPath(manifestPath);
    }

    // A dbt-core manifest can contain the technical model inventory while its
    // MetricFlow nodes are absent. Keep that inventory, but still scan the
    // configured model paths so semantic YAML is not hidden by an early return.
    const layer = artifactLayer ?? manifestInventory ?? new SemanticLayer();
    const modelPaths = config.modelPaths?.length
      ? config.modelPaths
      : dbtProjectSettings.modelPaths;
    const yamlFiles = Array.from(new Set(
      modelPaths.flatMap((modelPath) => collectYamlFiles(resolve(dbtRoot, modelPath))),
    ));
    if (yamlFiles.length === 0) return layer;

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

    // Convert each semantic model into a DQL CubeDefinition. Build the primary-entity
    // index first so foreign-entity joins resolve to the right target cube + key.
    const entityIndex = buildPrimaryEntityIndex(allModels);
    for (const model of allModels) {
      registerSemanticModel(layer, model, 'yaml', entityIndex);
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

  const models: DbtSemanticModel[] = [];
  for (const node of artifactCollection(manifest.semantic_models)) {
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
  for (const node of artifactCollection(manifest.metrics)) {
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
  for (const node of artifactCollection(manifest.saved_queries ?? manifest.savedQueries)) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || !('name' in node)) continue;
    const raw = node as DbtSavedQuery;
    savedQueries.push({ ...raw, name: raw.name });
  }

  if (models.length === 0 && dbtMetrics.length === 0 && savedQueries.length === 0) {
    // No semantic content — let the caller try source YAML. For manifest.json,
    // its technical model inventory is merged into that YAML layer by load().
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

  const entityIndex = buildPrimaryEntityIndex(models);
  for (const model of models) {
    registerSemanticModel(layer, model, artifactKind, entityIndex);
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

interface DbtManifestModelNode {
  name: string;
  alias?: string;
  relation_name?: string;
  database?: string;
  schema?: string;
  description?: string;
  resource_type?: string;
  columns?: Record<string, Record<string, unknown>>;
  config?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  tags?: string[];
  package_name?: string;
  original_file_path?: string;
  path?: string;
  unique_id?: string;
  fqn?: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function artifactCollection(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return Object.values(asRecord(value));
}

function readDbtProjectSettings(dbtRoot: string): { targetPath: string; modelPaths: string[] } {
  const defaults = { targetPath: 'target', modelPaths: ['models'] };
  const path = join(dbtRoot, 'dbt_project.yml');
  if (!existsSync(path)) return defaults;
  try {
    const parsed = yaml.load(readFileSync(path, 'utf-8')) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
    const targetPath = typeof parsed['target-path'] === 'string' && parsed['target-path'].trim()
      ? parsed['target-path'].trim()
      : defaults.targetPath;
    const rawModelPaths = parsed['model-paths'];
    const modelPaths = Array.isArray(rawModelPaths)
      ? rawModelPaths.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map((value) => value.trim())
      : defaults.modelPaths;
    return { targetPath, modelPaths: modelPaths.length ? modelPaths : defaults.modelPaths };
  } catch {
    return defaults;
  }
}

function loadDbtModelInventoryFromManifestPath(manifestPath: string): SemanticLayer | null {
  try {
    return loadDbtModelInventoryFromManifest(
      JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>,
    );
  } catch {
    return null;
  }
}

function artifactHasTopLevelMetrics(manifestPath: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    return artifactCollection(manifest.metrics).some((metric) => {
      if (!metric || typeof metric !== 'object' || Array.isArray(metric)) return false;
      return 'name' in metric;
    });
  } catch {
    return false;
  }
}

function loadDbtModelInventoryFromManifest(manifest: Record<string, unknown>): SemanticLayer | null {
  const nodes = Object.values(asRecord(manifest.nodes))
    .filter((node): node is DbtManifestModelNode => {
      return Boolean(
        node
        && typeof node === 'object'
        && !Array.isArray(node)
        && (node as DbtManifestModelNode).resource_type === 'model'
        && typeof (node as DbtManifestModelNode).name === 'string',
      );
    });
  if (nodes.length === 0) return null;

  const layer = new SemanticLayer();
  for (const node of nodes) {
    const tableName = resolveDbtModelTableName(node);
    const domain = deriveDbtManifestNodeDomain(node);
    const dimensions: DimensionDefinition[] = [];
    const timeDimensions: TimeDimensionDefinition[] = [];

    for (const [columnKey, columnValue] of Object.entries(asRecord(node.columns))) {
      const rawColumn = asRecord(columnValue);
      const columnName = firstString(rawColumn.name, columnKey);
      if (!columnName) continue;
      const columnType = inferDbtColumnType(rawColumn.data_type, columnName);
      const dimension: DimensionDefinition = {
        name: `${node.name}.${columnName}`,
        label: labelFromName(columnName),
        description: firstString(rawColumn.description) ?? '',
        domain,
        sql: columnName,
        type: columnType,
        table: tableName,
        cube: node.name,
        tags: Array.isArray(rawColumn.tags) ? rawColumn.tags.map(String) : undefined,
        source: dbtSource('dbt_column', `${node.unique_id ?? node.name}.${columnName}`, columnName, {
          ...rawColumn,
          unique_id: `${node.unique_id ?? node.name}.${columnName}`,
          package_name: node.package_name,
          original_file_path: node.original_file_path ?? node.path,
        }),
      };
      if (columnType === 'date') {
        timeDimensions.push({
          ...dimension,
          isTimeDimension: true,
          granularities: ['day', 'week', 'month', 'quarter', 'year'],
        });
      } else {
        dimensions.push(dimension);
      }
    }

    layer.addCube({
      name: node.name,
      label: labelFromName(node.name),
      description: node.description ?? '',
      sql: `SELECT * FROM ${tableName}`,
      table: tableName,
      domain,
      measures: [],
      dimensions,
      timeDimensions,
      joins: [],
      segments: [],
      preAggregations: [],
      source: dbtSource('dbt_model', node.unique_id ?? node.name, node.name, node as unknown as Record<string, unknown>),
    });
    layer.addSemanticModel({
      name: node.name,
      label: labelFromName(node.name),
      description: node.description ?? '',
      domain,
      model: node.name,
      table: tableName,
      entities: [],
      measures: [],
      dimensions: dimensions.map((dimension) => dimension.name),
      timeDimensions: timeDimensions.map((dimension) => dimension.name),
      tags: node.tags,
      source: dbtSource('dbt_model', node.unique_id ?? node.name, node.name, node as unknown as Record<string, unknown>),
    });
  }

  return layer;
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
function resolveDbtModelTableName(node: DbtManifestModelNode): string {
  if (node.relation_name) return node.relation_name;
  const relation = [node.database, node.schema, node.alias ?? node.name].filter(Boolean).join('.');
  return relation || node.name;
}

function inferDbtColumnType(dataType: unknown, columnName: string): DimensionDefinition['type'] {
  const value = `${typeof dataType === 'string' ? dataType : ''} ${columnName}`.toLowerCase();
  if (/\b(bool|boolean)\b/.test(value)) return 'boolean';
  if (/\b(date|time|timestamp|datetime)\b/.test(value)) return 'date';
  if (/\b(int|integer|number|numeric|decimal|double|float|real)\b/.test(value)) return 'number';
  return 'string';
}

function labelFromName(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function deriveDbtManifestNodeDomain(node: DbtManifestModelNode): string {
  const meta = asRecord(node.meta);
  const config = asRecord(node.config);
  const configMeta = asRecord(config.meta);
  return firstString(
    meta?.domain,
    meta?.group,
    configMeta?.domain,
    configMeta?.group,
    config?.group,
    Array.isArray(node.fqn) && node.fqn.length > 1 ? node.fqn[1] : undefined,
    node.package_name,
  )?.replace(/[^a-z0-9/_-]+/gi, '-').toLowerCase() || 'uncategorized';
}

function resolveTableName(model: DbtSemanticModel): string {
  // Modern MetricFlow semantic_manifest.json artifacts resolve `model` into a
  // concrete node_relation. Preserve that resolved relation instead of falling
  // back to the semantic-model name (`order_item` is not `dev.order_items`).
  if (model.node_relation?.relation_name?.trim()) {
    return model.node_relation.relation_name.trim();
  }
  if (model.node_relation?.alias?.trim()) {
    return model.node_relation.schema_name?.trim()
      ? `${model.node_relation.schema_name.trim()}.${model.node_relation.alias.trim()}`
      : model.node_relation.alias.trim();
  }
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

/**
 * Where a foreign entity joins TO. In dbt/MetricFlow, a foreign entity `location`
 * joins to the semantic model whose PRIMARY (or natural/unique) entity is also
 * named `location`. This index maps that entity name → the target cube and its
 * join key, so cross-model joins resolve to a real cube instead of the entity name.
 */
export type PrimaryEntityIndex = Map<string, { cube: string; key: string }>;

/** Build the primary-entity → {cube, key} index across all semantic models. */
export function buildPrimaryEntityIndex(models: DbtSemanticModel[]): PrimaryEntityIndex {
  const index: PrimaryEntityIndex = new Map();
  for (const model of models) {
    for (const entity of model.entities ?? []) {
      if (entity.type === 'primary' || entity.type === 'natural' || entity.type === 'unique') {
        // First primary wins; a model's identity is its primary entity.
        if (!index.has(entity.name)) {
          index.set(entity.name, { cube: model.name, key: entity.expr ?? entity.name });
        }
      }
    }
  }
  return index;
}

function registerSemanticModel(
  layer: SemanticLayer,
  model: DbtSemanticModel,
  artifactKind: 'manifest' | 'semantic_manifest' | 'yaml' = 'yaml',
  entityIndex: PrimaryEntityIndex = new Map(),
): void {
  const cube = convertSemanticModel(model, artifactKind, entityIndex);
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
  entityIndex: PrimaryEntityIndex = new Map(),
): CubeDefinition {
  const tableName = resolveTableName(model);
  const domain = deriveDbtDomain(model);

  const measures: MetricDefinition[] = (model.measures ?? []).map((m) => ({
    name: m.name,
    label: m.label ?? m.name,
    description: m.description ?? '',
    domain,
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
          domain,
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
          domain,
          source: dbtSource('dimension', `${model.name}.${dim.name}`, dim.name, {
          ...dim,
          semantic_model: model.name,
          artifactKind,
        }),
      });
    }
  }

  // Convert foreign entities to joins. A foreign entity joins to the model whose
  // PRIMARY entity shares its name (MetricFlow semantics) — resolve that target via
  // the cross-model entity index so `join.right` is the real target CUBE and the SQL
  // uses the target's actual key. The old code used `entity.name` for both the
  // target and the right-hand column, so `orders.location_id = ${right}.location`
  // pointed at a non-existent column on a cube named `locations` — findJoinPath
  // (which matches `join.right === targetCube`) never resolved it, and EVERY
  // cross-table governed query silently fell through to generated SQL.
  const joins: JoinDefinition[] = [];
  for (const entity of model.entities ?? []) {
    if (entity.type !== 'foreign') continue;
    const leftKey = entity.expr ?? entity.name;
    const target = entityIndex.get(entity.name);
    joins.push({
      name: target?.cube ?? entity.name,
      left: model.name,
      right: target?.cube ?? entity.name,
      type: 'left',
      sql: `\${left}.${leftKey} = \${right}.${target?.key ?? entity.expr ?? entity.name}`,
    });
  }

  return {
    name: model.name,
    label: model.label ?? model.name,
    description: model.description ?? '',
    sql: `SELECT * FROM ${tableName}`,
      table: tableName,
      domain,
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
  const isSimple = dbtMetric.type.toLowerCase() === 'simple';
  const measureName = firstSemanticRefName(
    dbtMetric.type_params?.measure,
    dbtMetric.type_params?.measure_name,
    dbtMetric.type_params?.input_measures,
  );
  // Only a simple metric can be represented by one input measure. Selecting a
  // numerator/input from a derived, ratio, conversion, or cumulative metric
  // changes its meaning and previously produced plausible but incorrect SQL.
  const resolvedMeasure = isSimple && measureName ? measureLookup.get(measureName) : undefined;
  const nativeMetricType = resolvedMeasure ? AGG_TYPE_MAP[resolvedMeasure.agg] : undefined;

  return {
    name: dbtMetric.name,
    label: dbtMetric.label ?? dbtMetric.name,
    description: dbtMetric.description ?? '',
    domain: deriveDbtMetricDomain(dbtMetric, resolvedMeasure?.modelName),
    sql: resolvedMeasure && nativeMetricType
      ? buildAggSql(resolvedMeasure.agg, resolvedMeasure.sql)
      : String(dbtMetric.type_params?.expr ?? dbtMetric.name),
    type: nativeMetricType ?? 'custom',
    table: nativeMetricType ? resolvedMeasure?.table ?? '' : '',
    cube: resolvedMeasure?.modelName,
    aggregation: dbtMetric.type,
    metricType: dbtMetric.type,
    typeParams: dbtMetric.type_params,
    filter: dbtMetric.filter ?? dbtMetric.filters,
    aggTimeDimension: resolvedMeasure?.measure.agg_time_dimension,
    source: dbtSource('metric', dbtMetric.unique_id ?? dbtMetric.name, dbtMetric.name, dbtMetric as unknown as Record<string, unknown>),
  };
}

function firstSemanticRefName(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const nested = firstSemanticRefName(...value);
      if (nested) return nested;
      continue;
    }
    if (value && typeof value === 'object') {
      const raw = value as Record<string, unknown>;
      const nested = firstSemanticRefName(raw.name, raw.measure, raw.measure_name);
      if (nested) return nested;
    }
  }
  return undefined;
}

function deriveDbtDomain(model: DbtSemanticModel): string {
  const meta = asRecord(model.meta);
  const config = asRecord(model.config);
  const configMeta = asRecord(config.meta);
  return firstString(
    meta?.domain,
    meta?.group,
    configMeta?.domain,
    configMeta?.group,
    config?.group,
    model.package_name,
  )?.replace(/[^a-z0-9/_-]+/gi, '-').toLowerCase() || 'uncategorized';
}

function deriveDbtMetricDomain(metric: DbtMetric, modelName?: string): string {
  const meta = asRecord(metric.meta);
  const config = asRecord(metric.config);
  const configMeta = asRecord(config.meta);
  return firstString(
    meta?.domain,
    meta?.group,
    configMeta?.domain,
    configMeta?.group,
    config?.group,
    metric.package_name,
    modelName,
  )?.replace(/[^a-z0-9/_-]+/gi, '-').toLowerCase() || 'uncategorized';
}

function convertSavedQuery(savedQuery: DbtSavedQuery): SavedQueryDefinition {
  const groupBy = savedQuery.query_params?.group_by ?? [];
  const timeRef = groupBy.find((value) => value.includes('__')) ?? groupBy.find((value) => value.toLowerCase().includes('metric_time'));
  const [timeDimension, granularity] = timeRef?.split('__') ?? [];
  const meta = asRecord(savedQuery.config?.meta);
  return {
    name: savedQuery.name,
    label: savedQuery.label ?? savedQuery.name,
    description: savedQuery.description ?? '',
    domain: firstString(meta.domain, meta.group) ?? 'uncategorized',
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
