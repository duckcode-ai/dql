/**
 * Semantic Layer: metric and dimension definitions parsed from YAML configs.
 * Maps to the architecture spec's semantic-layer/ directory structure.
 */

import { getDialect, type SQLDialect } from './sql-dialect.js';

export interface SemanticSourceMetadata {
  provider: string;
  objectType: string;
  objectId: string;
  objectName?: string;
  importedAt?: string;
  extra?: Record<string, unknown>;
}

export interface MetricDefinition {
  name: string;
  label: string;
  description: string;
  domain: string;
  status?: string;
  sql: string;
  type: 'sum' | 'count' | 'count_distinct' | 'avg' | 'min' | 'max' | 'custom';
  table: string;
  filters?: Record<string, string>;
  tags?: string[];
  owner?: string;
  cube?: string;
  aggregation?: string;
  metricType?: string;
  typeParams?: Record<string, unknown>;
  filter?: string | Record<string, unknown> | Array<Record<string, unknown>>;
  aggTimeDimension?: string;
  /** Display contract (currency/percent/decimals) from dbt meta or DQL YAML. */
  displayFormat?: SemanticDisplayFormat;
  /**
   * Distinguishes a real dbt metric from a dbt MEASURE that was projected into
   * the metrics map for native composition (see {@link SemanticLayer.addCube}).
   * `listMetrics({ includeMeasures: false })` filters on this so the UI metric
   * picker and the agent's metric matcher stop seeing measures as duplicate
   * metrics. Undefined is treated as a real metric for backward compatibility.
   */
  objectKind?: 'metric' | 'measure';
  source?: SemanticSourceMetadata;
}

/**
 * How a metric/measure value should be RENDERED. Declared once in metadata
 * (dbt `meta: {format: currency, currency: USD, decimals: 2}` or a DQL YAML
 * `format:` block) so every surface — narration, synthesis, tables, charts —
 * formats identically instead of each layer guessing from the column name.
 */
export interface SemanticDisplayFormat {
  kind: 'currency' | 'percent' | 'number' | 'count' | 'duration';
  currency?: string;
  decimals?: number;
}

export interface DimensionDefinition {
  name: string;
  label: string;
  description: string;
  domain?: string;
  status?: string;
  sql: string;
  type: 'string' | 'number' | 'date' | 'boolean';
  table: string;
  tags?: string[];
  owner?: string;
  cube?: string;
  expr?: string;
  isTimeDimension?: boolean;
  /**
   * Canonical MetricFlow group-by identity for this dimension, single-hop:
   * `<primaryEntity>__<name>` (e.g. `bcm_hdr__customer_name`). Additive — the
   * bare `name` remains the identity key everywhere. Multi-hop qualified names
   * (grouping a metric on a joined model's dimension) are computed per-request
   * by the compatibility service, not stored here.
   */
  qualifiedName?: string;
  /** Primary-entity name of the owning semantic model (source of qualifiedName). */
  entityLink?: string;
  typeParams?: Record<string, unknown>;
  source?: SemanticSourceMetadata;
}

export interface MeasureDefinition {
  name: string;
  label: string;
  description: string;
  domain?: string;
  agg: string;
  expr?: string;
  table: string;
  cube?: string;
  aggTimeDimension?: string;
  createMetric?: boolean;
  nonAdditiveDimension?: Record<string, unknown>;
  filter?: string | Record<string, unknown> | Array<Record<string, unknown>>;
  /** Display contract (currency/percent/decimals) from dbt meta or DQL YAML. */
  displayFormat?: SemanticDisplayFormat;
  tags?: string[];
  owner?: string;
  source?: SemanticSourceMetadata;
}

export interface EntityDefinition {
  name: string;
  label: string;
  description: string;
  domain?: string;
  type: 'primary' | 'unique' | 'foreign' | 'natural' | string;
  expr?: string;
  table: string;
  cube?: string;
  role?: string;
  tags?: string[];
  owner?: string;
  source?: SemanticSourceMetadata;
}

export interface SemanticModelDefinition {
  name: string;
  label: string;
  description: string;
  domain?: string;
  model?: string;
  table: string;
  defaults?: Record<string, unknown>;
  entities: string[];
  measures: string[];
  dimensions: string[];
  timeDimensions: string[];
  tags?: string[];
  owner?: string;
  source?: SemanticSourceMetadata;
}

export interface SavedQueryDefinition {
  name: string;
  label: string;
  description: string;
  domain?: string;
  metrics: string[];
  dimensions: string[];
  timeDimension?: string;
  granularity?: string;
  filters?: Array<Record<string, unknown>> | Record<string, unknown> | string;
  orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>;
  limit?: number;
  exports?: Array<Record<string, unknown>>;
  tags?: string[];
  owner?: string;
  source?: SemanticSourceMetadata;
}

export type HierarchyRollupType = 'sum' | 'count' | 'count_distinct' | 'avg' | 'min' | 'max' | 'none';

export interface HierarchyLevelDefinition {
  name: string;
  label: string;
  description: string;
  dimension: string;
  sql?: string;
  order: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface HierarchyDrillPathDefinition {
  name: string;
  levels: string[];
}

export interface HierarchyDefinition {
  name: string;
  label: string;
  description: string;
  domain?: string;
  levels: HierarchyLevelDefinition[];
  drillPaths?: HierarchyDrillPathDefinition[];
  defaultDrillPath?: string;
  defaultRollup?: HierarchyRollupType;
  tags?: string[];
  owner?: string;
  source?: SemanticSourceMetadata;
}

// ── Cube / Semantic Model Types ──

export interface SegmentDefinition {
  name: string;
  label: string;
  description: string;
  domain?: string;
  cube: string;
  sql: string;
  tags?: string[];
  owner?: string;
  source?: SemanticSourceMetadata;
}

export interface PreAggregationDefinition {
  name: string;
  label: string;
  description: string;
  domain?: string;
  cube: string;
  measures?: string[];
  dimensions?: string[];
  timeDimension?: string;
  granularity?: string;
  refreshKey?: string;
  sql?: string;
  tags?: string[];
  owner?: string;
  source?: SemanticSourceMetadata;
}

export interface JoinDefinition {
  name: string;
  left: string;   // cube name
  right: string;  // cube name
  type: 'inner' | 'left' | 'right' | 'full';
  sql: string;    // e.g. "${left}.customer_id = ${right}.id"
  /**
   * Foreign-entity name this join traverses, when derived from a dbt entity
   * (e.g. `bcm_hdr`). The compatibility service concatenates these along a join
   * path to build MetricFlow multi-hop group-by names (`bcm_hdr__customer_name`).
   */
  entity?: string;
}

export interface TimeDimensionDefinition extends DimensionDefinition {
  granularities: ('day' | 'week' | 'month' | 'quarter' | 'year')[];
  /**
   * The dbt-declared base grain (`type_params.time_granularity`). A column
   * stored at month grain cannot be truncated finer than month, so
   * `granularities` advertises only grains ≥ this. Undefined ⇒ base unknown
   * and all five grains are offered (backward-compatible default).
   */
  baseGranularity?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  primaryTime?: boolean;
}

export interface CubeDefinition {
  name: string;
  label: string;
  description: string;
  sql: string;           // base table/subquery
  table: string;         // shorthand table name
  domain: string;
  measures: MetricDefinition[];
  dimensions: DimensionDefinition[];
  timeDimensions: TimeDimensionDefinition[];
  joins: JoinDefinition[];
  segments: SegmentDefinition[];
  preAggregations: PreAggregationDefinition[];
  defaultTimeDimension?: string;
  owner?: string;
  tags?: string[];
  source?: SemanticSourceMetadata;
}

export interface ComposeQueryOptions {
  metrics: string[];
  dimensions: string[];
  timeDimension?: { name: string; granularity: string };
  filters?: Array<{ dimension: string; operator: string; values: string[] }>;
  orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>;
  limit?: number;
  /** SQL dialect for the target database. Defaults to DuckDB if not specified. */
  dialect?: SQLDialect;
  /** Shorthand: driver name (e.g. 'snowflake', 'bigquery') to auto-resolve dialect. */
  driver?: string;
  /** Maps semantic table names to actual database table names (e.g. 'stg_orders' → 'main.stg_orders'). */
  tableMapping?: Record<string, string>;
}

export interface ComposeQueryResult {
  sql: string;
  joins: string[];
  tables: string[];
  /** Compilation strategy used to protect multi-fact metric grain. */
  strategy?: 'direct_join' | 'aggregate_islands';
  /**
   * Present when a direct_join composition includes JOIN clauses. Executors
   * SHOULD run this one-row probe (base_rows, joined_rows) before trusting the
   * composed SQL: joined_rows > base_rows means the join multiplies fact rows
   * (non-unique key on the joined side) and every aggregated value is inflated.
   */
  fanoutProbeSql?: string;
  /** Dimension/time aliases that form the aggregate-island join grain. */
  grainKeys?: string[];
}

export interface BlockCompanionDefinition {
  name: string;
  block: string;
  domain?: string;
  description: string;
  owner?: string;
  tags?: string[];
  glossary?: string[];
  source?: SemanticSourceMetadata;
  semanticMetrics?: string[];
  semanticDimensions?: string[];
  semanticMappings?: Record<string, string>;
  lineage?: string[];
  notes?: string[];
  reviewStatus?: 'draft' | 'review' | 'approved';
}

export interface SemanticLayerConfig {
  metrics: MetricDefinition[];
  dimensions: DimensionDefinition[];
  hierarchies?: HierarchyDefinition[];
  segments?: SegmentDefinition[];
  preAggregations?: PreAggregationDefinition[];
  measures?: MeasureDefinition[];
  entities?: EntityDefinition[];
  semanticModels?: SemanticModelDefinition[];
  savedQueries?: SavedQueryDefinition[];
}

export interface SemanticSearchOptions {
  domains?: string[];
  tags?: string[];
  types?: Array<'metric' | 'dimension' | 'hierarchy' | 'measure' | 'entity' | 'semantic_model' | 'saved_query'>;
}

export interface SemanticSearchResults {
  metrics: MetricDefinition[];
  dimensions: DimensionDefinition[];
  hierarchies: HierarchyDefinition[];
  measures: MeasureDefinition[];
  entities: EntityDefinition[];
  semanticModels: SemanticModelDefinition[];
  savedQueries: SavedQueryDefinition[];
}

/**
 * Parse a YAML-like metric definition object into a MetricDefinition.
 * In production, this would use a YAML parser. For now, accepts plain objects.
 */
export function parseMetricDefinition(raw: Record<string, unknown>): MetricDefinition {
  return {
    name: String(raw.name ?? ''),
    label: String(raw.label ?? raw.name ?? ''),
    description: String(raw.description ?? ''),
    domain: String(raw.domain ?? ''),
    status: parseStatus(raw.status),
    sql: String(raw.sql ?? ''),
    type: validateMetricType(String(raw.type ?? 'sum')),
    table: String(raw.table ?? ''),
    filters: raw.filters as Record<string, string> | undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
    owner: raw.owner ? String(raw.owner) : undefined,
    cube: raw.cube ? String(raw.cube) : undefined,
    aggregation: raw.aggregation ? String(raw.aggregation) : undefined,
    metricType: raw.metricType ? String(raw.metricType) : raw.metric_type ? String(raw.metric_type) : undefined,
    typeParams: parseRecord(raw.typeParams ?? raw.type_params),
    filter: parseSemanticFilter(raw.filter),
    aggTimeDimension: raw.aggTimeDimension ? String(raw.aggTimeDimension) : raw.agg_time_dimension ? String(raw.agg_time_dimension) : undefined,
    source: parseSourceMetadata(raw.source),
  };
}

export function parseDimensionDefinition(raw: Record<string, unknown>): DimensionDefinition {
  return {
    name: String(raw.name ?? ''),
    label: String(raw.label ?? raw.name ?? ''),
    description: String(raw.description ?? ''),
    domain: raw.domain != null ? String(raw.domain) : undefined,
    status: parseStatus(raw.status),
    sql: String(raw.sql ?? ''),
    type: validateDimensionType(String(raw.type ?? 'string')),
    table: String(raw.table ?? ''),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
    owner: raw.owner ? String(raw.owner) : undefined,
    cube: raw.cube ? String(raw.cube) : undefined,
    expr: raw.expr ? String(raw.expr) : undefined,
    isTimeDimension: Boolean(raw.isTimeDimension ?? raw.is_time_dimension ?? false),
    typeParams: parseRecord(raw.typeParams ?? raw.type_params),
    source: parseSourceMetadata(raw.source),
  };
}

export function parseHierarchyDefinition(raw: Record<string, unknown>): HierarchyDefinition {
  const levelsRaw = Array.isArray(raw.levels) ? raw.levels : [];
  const levels = levelsRaw.reduce<HierarchyLevelDefinition[]>((acc, level, index) => {
    if (!level || typeof level !== 'object' || Array.isArray(level)) return acc;
    const levelRaw = level as Record<string, unknown>;
    const orderVal = Number(levelRaw.order);
    acc.push({
      name: String(levelRaw.name ?? `level_${index + 1}`),
      label: String(levelRaw.label ?? levelRaw.name ?? `Level ${index + 1}`),
      description: String(levelRaw.description ?? ''),
      dimension: String(levelRaw.dimension ?? levelRaw.name ?? ''),
      sql: levelRaw.sql != null ? String(levelRaw.sql) : undefined,
      order: Number.isFinite(orderVal) ? orderVal : index + 1,
      tags: Array.isArray(levelRaw.tags) ? levelRaw.tags.map(String) : undefined,
      metadata:
        levelRaw.metadata && typeof levelRaw.metadata === 'object' && !Array.isArray(levelRaw.metadata)
          ? (levelRaw.metadata as Record<string, unknown>)
          : undefined,
    });
    return acc;
  }, []).sort((a, b) => a.order - b.order);

  const drillPathsRaw = Array.isArray(raw.drillPaths) ? raw.drillPaths : [];
  const drillPaths = drillPathsRaw.reduce<HierarchyDrillPathDefinition[]>((acc, path, index) => {
    if (!path || typeof path !== 'object' || Array.isArray(path)) return acc;
    const pathRaw = path as Record<string, unknown>;
    const pathLevels = Array.isArray(pathRaw.levels)
      ? pathRaw.levels.map(String)
      : levels.map((level) => level.name);
    acc.push({
      name: String(pathRaw.name ?? `path_${index + 1}`),
      levels: pathLevels,
    });
    return acc;
  }, []);

  return {
    name: String(raw.name ?? ''),
    label: String(raw.label ?? raw.name ?? ''),
    description: String(raw.description ?? ''),
    domain: raw.domain != null ? String(raw.domain) : undefined,
    levels,
    drillPaths: drillPaths.length > 0 ? drillPaths : undefined,
    defaultDrillPath: raw.defaultDrillPath != null ? String(raw.defaultDrillPath) : undefined,
    defaultRollup: validateRollupType(String(raw.defaultRollup ?? 'sum')),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
    owner: raw.owner ? String(raw.owner) : undefined,
    source: parseSourceMetadata(raw.source),
  };
}

export function parseSegmentDefinition(raw: Record<string, unknown>): SegmentDefinition {
  return {
    name: String(raw.name ?? ''),
    label: String(raw.label ?? raw.name ?? ''),
    description: String(raw.description ?? ''),
    domain: raw.domain != null ? String(raw.domain) : undefined,
    cube: String(raw.cube ?? ''),
    sql: String(raw.sql ?? ''),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
    owner: raw.owner ? String(raw.owner) : undefined,
    source: parseSourceMetadata(raw.source),
  };
}

export function parsePreAggregationDefinition(raw: Record<string, unknown>): PreAggregationDefinition {
  return {
    name: String(raw.name ?? ''),
    label: String(raw.label ?? raw.name ?? ''),
    description: String(raw.description ?? ''),
    domain: raw.domain != null ? String(raw.domain) : undefined,
    cube: String(raw.cube ?? ''),
    measures: Array.isArray(raw.measures) ? raw.measures.map(String) : undefined,
    dimensions: Array.isArray(raw.dimensions) ? raw.dimensions.map(String) : undefined,
    timeDimension: raw.timeDimension != null ? String(raw.timeDimension) : raw.time_dimension != null ? String(raw.time_dimension) : undefined,
    granularity: raw.granularity != null ? String(raw.granularity) : undefined,
    refreshKey: raw.refreshKey != null ? String(raw.refreshKey) : raw.refresh_key != null ? String(raw.refresh_key) : undefined,
    sql: raw.sql != null ? String(raw.sql) : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
    owner: raw.owner ? String(raw.owner) : undefined,
    source: parseSourceMetadata(raw.source),
  };
}

export function parseBlockCompanionDefinition(raw: Record<string, unknown>): BlockCompanionDefinition {
  return {
    name: String(raw.name ?? raw.block ?? ''),
    block: String(raw.block ?? raw.name ?? ''),
    domain: raw.domain != null ? String(raw.domain) : undefined,
    description: String(raw.description ?? ''),
    owner: raw.owner ? String(raw.owner) : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
    glossary: Array.isArray(raw.glossary) ? raw.glossary.map(String) : undefined,
    source: parseSourceMetadata(raw.source),
    semanticMetrics: Array.isArray(raw.semanticMetrics) ? raw.semanticMetrics.map(String) : undefined,
    semanticDimensions: Array.isArray(raw.semanticDimensions) ? raw.semanticDimensions.map(String) : undefined,
    semanticMappings:
      raw.semanticMappings && typeof raw.semanticMappings === 'object' && !Array.isArray(raw.semanticMappings)
        ? Object.fromEntries(
          Object.entries(raw.semanticMappings as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
        )
        : undefined,
    lineage: Array.isArray(raw.lineage) ? raw.lineage.map(String) : undefined,
    notes: Array.isArray(raw.notes) ? raw.notes.map(String) : undefined,
    reviewStatus: validateReviewStatus(raw.reviewStatus),
  };
}

/**
 * SemanticLayer holds all metric and dimension definitions and provides
 * lookup and search capabilities for the AI agent pipeline.
 */
export class SemanticLayer {
  private metrics: Map<string, MetricDefinition> = new Map();
  private dimensions: Map<string, DimensionDefinition> = new Map();
  /**
   * A dbt project may legitimately declare the same dimension name on many
   * semantic models (for example `report_date`).  The flat map above remains a
   * backwards-compatible lookup, while this index preserves every model-owned
   * variant so composition can resolve the dimension relative to the selected
   * metric instead of whichever model happened to load last.
   */
  private dimensionVariants: Map<string, DimensionDefinition[]> = new Map();
  private hierarchies: Map<string, HierarchyDefinition> = new Map();
  private segments: Map<string, SegmentDefinition> = new Map();
  private preAggregations: Map<string, PreAggregationDefinition> = new Map();
  private cubes: Map<string, CubeDefinition> = new Map();
  private measures: Map<string, MeasureDefinition> = new Map();
  private entities: Map<string, EntityDefinition> = new Map();
  private semanticModels: Map<string, SemanticModelDefinition> = new Map();
  private savedQueries: Map<string, SavedQueryDefinition> = new Map();
  // cube-name → list of joins for that cube (adjacency list)
  private joinGraph: Map<string, JoinDefinition[]> = new Map();

  constructor(config?: SemanticLayerConfig) {
    if (config) {
      for (const m of config.metrics) this.addMetric(m);
      for (const d of config.dimensions) this.addDimension(d);
      for (const h of config.hierarchies ?? []) this.addHierarchy(h);
      for (const s of config.segments ?? []) this.addSegment(s);
      for (const p of config.preAggregations ?? []) this.addPreAggregation(p);
      for (const m of config.measures ?? []) this.addMeasure(m);
      for (const e of config.entities ?? []) this.addEntity(e);
      for (const sm of config.semanticModels ?? []) this.addSemanticModel(sm);
      for (const sq of config.savedQueries ?? []) this.addSavedQuery(sq);
    }
  }

  addMetric(metric: MetricDefinition): void {
    // A real dbt metric (or DQL YAML metric) is authoritative for its name and
    // overrides any measure-derived entry of the same name (dbt emits both a
    // measure and a metric when `create_metric: true`). Default the tag to
    // 'metric' so the de-conflation filter treats untagged entries as metrics.
    this.metrics.set(metric.name, { ...metric, objectKind: metric.objectKind ?? 'metric' });
  }

  addDimension(dimension: DimensionDefinition): void {
    this.registerDimension(dimension);
  }

  addCube(cube: CubeDefinition): void {
    this.cubes.set(cube.name, cube);
    // Auto-populate flat maps for backward compatibility. Measures are projected
    // into the metrics map so native composition can aggregate them, but they are
    // tagged `objectKind: 'measure'` so the UI picker and agent matcher can filter
    // them back out (a real dbt metric of the same name, added later via
    // addMetric, overrides with 'metric'). We must NOT stop populating the map —
    // canComposeMetric/composeQuery/listCompatibleDimensions all read it.
    for (const m of cube.measures) this.metrics.set(m.name, { ...m, objectKind: m.objectKind ?? 'measure', cube: m.cube ?? cube.name, domain: m.domain || cube.domain, owner: m.owner ?? cube.owner, source: m.source ?? cube.source });
    for (const d of cube.dimensions) this.registerDimension({ ...d, cube: d.cube ?? cube.name, domain: d.domain ?? cube.domain, owner: d.owner ?? cube.owner, source: d.source ?? cube.source });
    for (const td of cube.timeDimensions) this.registerDimension({ ...td, cube: td.cube ?? cube.name, domain: td.domain ?? cube.domain, owner: td.owner ?? cube.owner, source: td.source ?? cube.source });
    for (const segment of cube.segments) this.segments.set(segment.name, { ...segment, cube: segment.cube || cube.name, domain: segment.domain ?? cube.domain, owner: segment.owner ?? cube.owner, source: segment.source ?? cube.source });
    for (const preAggregation of cube.preAggregations) this.preAggregations.set(preAggregation.name, { ...preAggregation, cube: preAggregation.cube || cube.name, domain: preAggregation.domain ?? cube.domain, owner: preAggregation.owner ?? cube.owner, source: preAggregation.source ?? cube.source });
    // Register joins in adjacency list
    for (const join of cube.joins) {
      const existing = this.joinGraph.get(join.left) ?? [];
      existing.push(join);
      this.joinGraph.set(join.left, existing);
      // Also add reverse direction
      const rev = this.joinGraph.get(join.right) ?? [];
      rev.push({ ...join, left: join.right, right: join.left });
      this.joinGraph.set(join.right, rev);
    }
  }

  addMeasure(measure: MeasureDefinition): void {
    this.measures.set(measure.name, measure);
  }

  private registerDimension(dimension: DimensionDefinition): void {
    const variants = this.dimensionVariants.get(dimension.name) ?? [];
    const identity = semanticDimensionIdentity(dimension);
    const existingIndex = variants.findIndex((candidate) => semanticDimensionIdentity(candidate) === identity);
    if (existingIndex >= 0) variants[existingIndex] = dimension;
    else variants.push(dimension);
    this.dimensionVariants.set(dimension.name, variants);
    // Preserve the historical direct lookup. Metric-aware compilation does not
    // use this lossy value; it resolves through `dimensionVariants` below.
    this.dimensions.set(dimension.name, dimension);
  }

  addEntity(entity: EntityDefinition): void {
    this.entities.set(entity.name, entity);
  }

  addSemanticModel(model: SemanticModelDefinition): void {
    this.semanticModels.set(model.name, model);
  }

  addSavedQuery(savedQuery: SavedQueryDefinition): void {
    this.savedQueries.set(savedQuery.name, savedQuery);
  }

  getCube(name: string): CubeDefinition | undefined {
    return this.cubes.get(name);
  }

  listCubes(): CubeDefinition[] {
    return Array.from(this.cubes.values());
  }

  addSegment(segment: SegmentDefinition): void {
    this.segments.set(segment.name, segment);
  }

  addPreAggregation(preAggregation: PreAggregationDefinition): void {
    this.preAggregations.set(preAggregation.name, preAggregation);
  }

  getSegment(name: string): SegmentDefinition | undefined {
    return this.segments.get(name);
  }

  getPreAggregation(name: string): PreAggregationDefinition | undefined {
    return this.preAggregations.get(name);
  }

  listSegments(domain?: string): SegmentDefinition[] {
    const all = Array.from(this.segments.values());
    return domain ? all.filter((segment) => segment.domain === domain) : all;
  }

  listPreAggregations(domain?: string): PreAggregationDefinition[] {
    const all = Array.from(this.preAggregations.values());
    return domain ? all.filter((preAggregation) => preAggregation.domain === domain) : all;
  }

  /** BFS shortest join path between two cube names. Returns empty array if same cube. */
  findJoinPath(fromCube: string, toCube: string): JoinDefinition[] {
    if (fromCube === toCube) return [];
    const queue: Array<{ cube: string; path: JoinDefinition[] }> = [{ cube: fromCube, path: [] }];
    const visited = new Set<string>([fromCube]);
    while (queue.length > 0) {
      const { cube, path } = queue.shift()!;
      const neighbors = this.joinGraph.get(cube) ?? [];
      for (const join of neighbors) {
        if (visited.has(join.right)) continue;
        const newPath = [...path, join];
        if (join.right === toCube) return newPath;
        visited.add(join.right);
        queue.push({ cube: join.right, path: newPath });
      }
    }
    return []; // no path found
  }

  /** Compose a multi-metric, cross-table SQL query using join graph traversal. */
  composeQuery(options: ComposeQueryOptions): ComposeQueryResult | null {
    const { metrics, dimensions, timeDimension, filters, orderBy, limit, driver, tableMapping } = options;
    const dialect = options.dialect ?? getDialect(driver);
    const resolveTable = (name: string): string => tableMapping?.[name] ?? name;
    if (metrics.length === 0) return null;

    // Resolve metric definitions
    const resolvedMetrics = metrics
      .map((m) => this.resolveComposableMetric(m))
      .filter(Boolean) as MetricDefinition[];
    if (resolvedMetrics.length !== metrics.length) return null;

    // Resolve dimension definitions relative to the selected metric models.
    // Names such as `report_date` are commonly repeated across enterprise dbt
    // semantic models; global last-write-wins lookup would bind the wrong table.
    const resolvedDimensions = dimensions
      .map((d) => this.resolveDimensionForMetrics(d, resolvedMetrics))
      .filter(Boolean) as DimensionDefinition[];
    if (resolvedDimensions.length !== dimensions.length) return null;

    // Resolve time dimension
    let timeDimDef: DimensionDefinition | undefined;
    if (timeDimension) {
      timeDimDef = this.resolveDimensionForMetrics(timeDimension.name, resolvedMetrics);
      if (!timeDimDef) return null;
    }

    const resolvedFilterDimensions = (filters ?? [])
      .map((filter) => this.resolveDimensionForMetrics(filter.dimension, resolvedMetrics))
      .filter(Boolean) as DimensionDefinition[];

    // Multiple metrics from different fact tables must never be aggregated after
    // one raw fact-to-fact join: that multiplies rows and silently inflates sums.
    // Compile one aggregate island per metric at the requested conformed grain,
    // then join the small aggregate results. Each island still uses the semantic
    // graph and refuses independently when a dimension/filter is unjoinable.
    const metricTables = new Set(resolvedMetrics.map((metric) => metric.table));
    if (metricTables.size > 1) {
      return this.composeAggregateIslands(options, resolvedMetrics, resolvedDimensions, timeDimDef, dialect);
    }

    // Find the primary table (from first metric)
    const primaryTable = resolvedMetrics[0].table;

    // Collect all tables referenced
    const allTables = new Set<string>([primaryTable]);
    for (const m of resolvedMetrics) allTables.add(m.table);
    for (const d of resolvedDimensions) allTables.add(d.table);
    for (const d of resolvedFilterDimensions) allTables.add(d.table);
    if (timeDimDef) allTables.add(timeDimDef.table);

    // Find which cube corresponds to a table
    const cubeByTable = (table: string): string | undefined => {
      for (const [name, cube] of this.cubes) {
        if (cube.table === table || cube.name === table) return name;
      }
      return table; // fallback: treat table as cube name
    };

    // A semantic model name and its physical relation frequently differ
    // (`order_item` -> `dev.order_items`). Multi-table SQL therefore needs one
    // stable alias vocabulary owned by the compiler; mixing cube names,
    // physical names, and unqualified columns produces ambiguous or invalid SQL.
    const useStableAliases = allTables.size > 1;
    const aliasForCube = (cube: string): string => sanitizeSqlAlias(cube);
    const aliasForTable = (table: string): string => aliasForCube(cubeByTable(table) ?? table);
    const qualifierAliases = new Map<string, string>();
    for (const table of allTables) {
      const cube = cubeByTable(table) ?? table;
      const alias = aliasForCube(cube);
      qualifierAliases.set(table, alias);
      qualifierAliases.set(cube, alias);
      const cubeDefinition = this.cubes.get(cube);
      if (cubeDefinition?.table) qualifierAliases.set(cubeDefinition.table, alias);
    }
    const qualifyForTable = (sql: string, table: string): string => {
      if (!useStableAliases) return sql;
      return qualifyBareSqlIdentifiers(rewriteSqlQualifiers(sql, qualifierAliases), aliasForTable(table));
    };

    // Build JOIN clauses using join graph
    const primaryCube = cubeByTable(primaryTable);
    const joinsUsed: JoinDefinition[] = [];
    const joinedTables = new Set<string>([primaryTable]);
    const unjoinedTables = new Set<string>();

    for (const table of allTables) {
      if (table === primaryTable) continue;
      const targetCube = cubeByTable(table) ?? table;
      const path = this.findJoinPath(primaryCube ?? primaryTable, targetCube);
      for (const join of path) {
        const joinKey = `${join.left}_${join.right}`;
        if (!joinsUsed.some((j) => `${j.left}_${j.right}` === joinKey)) {
          joinsUsed.push(join);
          joinedTables.add(join.right);
          const joinedCube = this.cubes.get(join.right);
          if (joinedCube?.table) joinedTables.add(joinedCube.table);
          const leftCube = this.cubes.get(join.left);
          if (leftCube?.table) joinedTables.add(leftCube.table);
          const leftAlias = aliasForCube(join.left);
          const rightAlias = aliasForCube(join.right);
          qualifierAliases.set(join.left, leftAlias);
          qualifierAliases.set(join.right, rightAlias);
          if (leftCube?.table) qualifierAliases.set(leftCube.table, leftAlias);
          if (joinedCube?.table) qualifierAliases.set(joinedCube.table, rightAlias);
        }
      }
      // No join path to a required table: emitting SELECT `table.col` with no JOIN
      // for `table` produces DEGENERATE SQL that errors or returns wrong/zero rows
      // (e.g. a cumulative revenue metric sliced by an unjoined product dimension).
      // Refuse to compose rather than hand back a query that can't answer — the
      // caller then falls through to a generated join instead of surfacing a hollow
      // "governed metric" answer with no rows.
      if (!joinedTables.has(table)) {
        unjoinedTables.add(table);
      }
    }
    if (unjoinedTables.size > 0) return null;

    // Metric-scoped filters (G1 correctness). A governed metric may declare a
    // `filter` that scopes its aggregate to a subset of rows (e.g.
    // completed_revenue = SUM(amount) WHERE status='completed'). Dropping it
    // silently returns a WRONG number at the highest-trust tier, so we either
    // apply it or refuse to compose (null) — the caller then falls through to
    // generated SQL rather than surfacing a governed-but-wrong answer.
    const resolveFilterColumn = (ref: string): string => {
      const dim = this.resolveDimensionForMetrics(ref, resolvedMetrics);
      if (dim?.sql) return qualifyForTable(dim.sql, dim.table);
      const column = ref.includes('__') ? ref.split('__').pop() ?? ref : ref;
      return qualifyForTable(column, primaryTable);
    };
    const metricFilters = resolvedMetrics.map((m) => computeMetricFilterPredicate(m, resolveFilterColumn));
    // A metric that declares a filter we cannot render fails the whole compose.
    if (metricFilters.some((r) => r.kind === 'fail')) return null;
    const okFilters = metricFilters.filter((r): r is { kind: 'ok'; sql: string } => r.kind === 'ok');
    // When EVERY metric carries the SAME filter, hoist it to a single WHERE
    // predicate (cleaner and equivalent); otherwise apply per-metric via CASE WHEN.
    const distinctPredicates = new Set(okFilters.map((r) => r.sql));
    const hoistFilterToWhere =
      okFilters.length === resolvedMetrics.length && resolvedMetrics.length > 0 && distinctPredicates.size === 1;

    // Build SELECT
    const selectParts: string[] = [];

    // Add dimensions
    for (const d of resolvedDimensions) {
      const prefix = !useStableAliases && d.table !== primaryTable ? `${d.table}.` : '';
      const sql = useStableAliases ? qualifyForTable(d.sql, d.table) : d.sql.includes('.') ? d.sql : `${prefix}${d.sql}`;
      selectParts.push(`${sql} AS ${d.name}`);
    }

    // Add time dimension with granularity (dialect-aware)
    if (timeDimDef && timeDimension) {
      const grain = timeDimension.granularity;
      const tdSql = useStableAliases
        ? qualifyForTable(timeDimDef.sql, timeDimDef.table)
        : timeDimDef.sql.includes('.') ? timeDimDef.sql : `${timeDimDef.table}.${timeDimDef.sql}`;
      const truncated = dialect.dateTrunc(grain, tdSql);
      selectParts.push(`${truncated} AS ${timeDimDef.name}_${grain}`);
    }

    // Add metrics (applying per-metric scoped filters via CASE WHEN unless hoisted)
    for (let i = 0; i < resolvedMetrics.length; i++) {
      const m = resolvedMetrics[i];
      const fr = metricFilters[i];
      let expr = qualifyForTable(renderMetricExpression(m), m.table);
      if (fr.kind === 'ok' && !hoistFilterToWhere) {
        const wrapped = wrapAggregateWithFilter(expr, fr.sql);
        // Unparseable aggregate + a per-metric filter → refuse rather than emit
        // a partially-applied filter.
        if (wrapped === null) return null;
        expr = wrapped;
      }
      selectParts.push(`${expr} AS ${m.name}`);
    }

    // Build FROM + JOINs (apply tableMapping for actual DB table names)
    let fromClause = `FROM ${resolveTable(primaryTable)}${useStableAliases ? ` AS ${aliasForTable(primaryTable)}` : ''}`;
    const joinClauses: string[] = [];
    for (const join of joinsUsed) {
      const rightCube = this.cubes.get(join.right);
      const rightTable = resolveTable(rightCube?.table ?? join.right);
      const leftQualifier = useStableAliases ? aliasForCube(join.left) : resolveTable(this.cubes.get(join.left)?.table ?? join.left);
      const rightQualifier = useStableAliases ? aliasForCube(join.right) : rightTable;
      const resolvedSql = rewriteSqlQualifiers(
        join.sql
          .replaceAll('${left}', leftQualifier)
          .replaceAll('${right}', rightQualifier),
        qualifierAliases,
      );
      joinClauses.push(`${join.type.toUpperCase()} JOIN ${rightTable}${useStableAliases ? ` AS ${rightQualifier}` : ''} ON ${resolvedSql}`);
    }

    // Build GROUP BY
    const groupByParts: string[] = [];
    for (const d of resolvedDimensions) {
      const prefix = !useStableAliases && d.table !== primaryTable ? `${d.table}.` : '';
      const sql = useStableAliases ? qualifyForTable(d.sql, d.table) : d.sql.includes('.') ? d.sql : `${prefix}${d.sql}`;
      groupByParts.push(sql);
    }
    if (timeDimDef && timeDimension) {
      const grain = timeDimension.granularity;
      const tdSql = useStableAliases
        ? qualifyForTable(timeDimDef.sql, timeDimDef.table)
        : timeDimDef.sql.includes('.') ? timeDimDef.sql : `${timeDimDef.table}.${timeDimDef.sql}`;
      groupByParts.push(dialect.dateTrunc(grain, tdSql));
    }

    // Build WHERE
    const whereParts: string[] = [];
    for (const f of filters ?? []) {
      if (!f.dimension) continue;
      const dimDef = this.resolveDimensionForMetrics(f.dimension, resolvedMetrics);
      const dimSql = dimDef
        ? useStableAliases
          ? qualifyForTable(dimDef.sql, dimDef.table)
          : (dimDef.sql.includes('.') || dimDef.table === primaryTable ? dimDef.sql : `${dimDef.table}.${dimDef.sql}`)
        : f.dimension;
      const v0 = f.values?.[0] ?? '';
      const v1 = f.values?.[1] ?? '';
      // Detect if value looks numeric (no quoting needed)
      const isNumeric = (v: string) => /^-?\d+(\.\d+)?$/.test(v.trim());
      const quote = (v: string) => isNumeric(v) ? v : `'${v.replace(/'/g, "''")}'`;

      switch (f.operator) {
        case 'equals':
          if (f.values.length <= 1) {
            whereParts.push(`${dimSql} = ${quote(v0)}`);
          } else {
            whereParts.push(`${dimSql} IN (${f.values.map(quote).join(', ')})`);
          }
          break;
        case 'not_equals':
          whereParts.push(`${dimSql} != ${quote(v0)}`);
          break;
        case 'in':
          if (f.values.length > 0) {
            whereParts.push(`${dimSql} IN (${f.values.map(quote).join(', ')})`);
          }
          break;
        case 'not_in':
          if (f.values.length > 0) {
            whereParts.push(`${dimSql} NOT IN (${f.values.map(quote).join(', ')})`);
          }
          break;
        case 'contains':
          whereParts.push(`${dimSql} LIKE '%${v0.replace(/'/g, "''")}%'`);
          break;
        case 'starts_with':
          whereParts.push(`${dimSql} LIKE '${v0.replace(/'/g, "''")}%'`);
          break;
        case 'ends_with':
          whereParts.push(`${dimSql} LIKE '%${v0.replace(/'/g, "''")}'`);
          break;
        case 'gt':
          whereParts.push(`${dimSql} > ${quote(v0)}`);
          break;
        case 'gte':
          whereParts.push(`${dimSql} >= ${quote(v0)}`);
          break;
        case 'lt':
          whereParts.push(`${dimSql} < ${quote(v0)}`);
          break;
        case 'lte':
          whereParts.push(`${dimSql} <= ${quote(v0)}`);
          break;
        case 'between':
          if (v0 && v1) {
            whereParts.push(`${dimSql} BETWEEN ${quote(v0)} AND ${quote(v1)}`);
          }
          break;
        case 'is_null':
          whereParts.push(`${dimSql} IS NULL`);
          break;
        case 'is_not_null':
          whereParts.push(`${dimSql} IS NOT NULL`);
          break;
      }
    }

    // Governed metric filter shared by every metric: applied once as WHERE.
    if (hoistFilterToWhere && okFilters.length > 0) {
      whereParts.push(okFilters[0].sql);
    }

    // Build ORDER BY
    const orderByParts: string[] = [];
    for (const o of orderBy ?? []) {
      orderByParts.push(`${o.name} ${o.direction.toUpperCase()}`);
    }

    // Compose full SQL (dialect-aware)
    let sql = `SELECT\n  ${selectParts.join(',\n  ')}\n${fromClause}`;
    if (joinClauses.length > 0) sql += `\n${joinClauses.join('\n')}`;
    if (whereParts.length > 0) sql += `\nWHERE ${whereParts.join('\n  AND ')}`;
    if (groupByParts.length > 0) sql += `\nGROUP BY ${groupByParts.join(', ')}`;
    if (orderByParts.length > 0) sql += `\nORDER BY ${orderByParts.join(', ')}`;
    if (limit) sql += `\n${dialect.limitClause(limit)}`;

    // A direct join aggregates AFTER joining: any duplicate join-key row on the
    // joined side multiplies fact rows before SUM and silently inflates every
    // number (observed in the field as trillions-scale "governed" answers).
    // Emit a structural probe the executor can run first: if the unfiltered
    // joined row count exceeds the primary table's row count, the declared key
    // is not unique on the joined side and the composed SQL must not be trusted.
    const fanoutProbeSql = joinClauses.length > 0
      ? [
          'SELECT',
          `  (SELECT COUNT(*) ${fromClause}) AS base_rows,`,
          `  (SELECT COUNT(*) ${fromClause}\n${joinClauses.map((clause) => `   ${clause}`).join('\n')}) AS joined_rows`,
        ].join('\n')
      : undefined;

    return {
      sql,
      joins: joinClauses,
      tables: Array.from(new Set([
        ...allTables,
        ...joinsUsed.map((join) => this.cubes.get(join.right)?.table ?? join.right),
      ])),
      strategy: 'direct_join',
      ...(fanoutProbeSql ? { fanoutProbeSql } : {}),
      grainKeys: [
        ...resolvedDimensions.map((dimension) => dimension.name),
        ...(timeDimDef && timeDimension ? [`${timeDimDef.name}_${timeDimension.granularity}`] : []),
      ],
    };
  }

  /**
   * Cheap capability probe for large semantic catalogs. This intentionally
   * avoids generating SQL: catalog/readiness surfaces may call it for thousands
   * of metrics, while full composition is reserved for a selected metric.
   */
  canComposeMetric(name: string): boolean {
    return Boolean(this.resolveComposableMetric(name));
  }

  /**
   * Resolve the DISPLAY format for a metric/measure name: explicit
   * declaration first (metric, then its backing measure), then a conservative
   * inference from metric type (ratio → percent). Returns undefined when
   * nothing is declared — callers keep their name-based fallback for ad-hoc
   * columns, but governed values format from the contract, not the guess.
   */
  displayFormatFor(name: string): SemanticDisplayFormat | undefined {
    const metric = this.metrics.get(name);
    if (metric?.displayFormat) return metric.displayFormat;
    const measure = this.measures.get(name);
    if (measure?.displayFormat) return measure.displayFormat;
    if (metric) {
      const backing = this.resolveComposableMetric(name);
      if (backing) {
        const backingMeasure = this.measures.get(backing.sql) ?? this.measures.get(metric.name);
        if (backingMeasure?.displayFormat) return backingMeasure.displayFormat;
      }
      if (metric.metricType === 'ratio') return { kind: 'percent' };
    }
    return undefined;
  }

  /**
   * dbt simple metrics may store physical ownership on their input measure
   * instead of duplicating it on the metric node. Materialize that contract for
   * native composition; derived/ratio/cumulative metrics remain MetricFlow-only.
   */
  private resolveComposableMetric(name: string): MetricDefinition | undefined {
    const metric = this.metrics.get(name);
    if (!metric) return undefined;
    if (metric.table) return metric;
    if (metric.metricType && metric.metricType !== 'simple') return undefined;

    const measureNames: string[] = [];
    const direct = metric.typeParams?.measure;
    if (typeof direct === 'string') measureNames.push(direct);
    else if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      const directName = (direct as Record<string, unknown>).name;
      if (typeof directName === 'string') measureNames.push(directName);
    }
    const inputs = metric.typeParams?.input_measures;
    if (Array.isArray(inputs)) {
      for (const input of inputs) {
        if (typeof input === 'string') measureNames.push(input);
        else if (input && typeof input === 'object' && !Array.isArray(input)) {
          const inputName = (input as Record<string, unknown>).name;
          if (typeof inputName === 'string') measureNames.push(inputName);
        }
      }
    }
    measureNames.push(metric.name);

    const measure = measureNames
      .map((measureName) => this.measures.get(measureName))
      .find((candidate) => Boolean(candidate?.table));
    if (!measure || measure.nonAdditiveDimension) return undefined;
    const type = normalizeMeasureMetricType(measure.agg);
    if (!type) return undefined;
    return {
      ...metric,
      table: measure.table,
      cube: metric.cube ?? measure.cube,
      sql: measure.expr?.trim() || (type === 'count' ? '*' : measure.name),
      type,
    };
  }

  /**
   * Resolve a possibly repeated dimension name from the owning metric model.
   * Explicit model-scoped references (`model.dimension` or
   * `model__dimension`) win. For the common unqualified form, the metric's own
   * table/cube wins, followed by the shortest declared semantic join path.
   */
  private resolveDimensionForMetrics(
    reference: string,
    metrics: MetricDefinition[],
  ): DimensionDefinition | undefined {
    const directVariants = this.dimensionVariants.get(reference) ?? [];
    const allVariants = directVariants.length > 0
      ? directVariants
      : Array.from(this.dimensionVariants.values()).flat().filter((dimension) =>
          semanticDimensionReferences(dimension).some((candidate) => candidate === reference),
        );
    if (allVariants.length === 0) return this.dimensions.get(reference);
    if (allVariants.length === 1) return allVariants[0];

    const metricTables = new Set(metrics.map((metric) => metric.table).filter(Boolean));
    const metricCubes = new Set(metrics.map((metric) => metric.cube).filter((cube): cube is string => Boolean(cube)));
    const primaryCube = metrics[0]?.cube ?? this.cubeNameForTable(metrics[0]?.table ?? '');
    return [...allVariants]
      .map((dimension) => {
        const dimensionCube = dimension.cube ?? this.cubeNameForTable(dimension.table);
        let score = 0;
        if (metricTables.has(dimension.table)) score += 1_000;
        if (dimensionCube && metricCubes.has(dimensionCube)) score += 900;
        if (primaryCube && dimensionCube) {
          if (primaryCube === dimensionCube) score += 500;
          else {
            const path = this.findJoinPath(primaryCube, dimensionCube);
            if (path.length > 0) score += Math.max(1, 300 - path.length * 20);
          }
        }
        return { dimension, score };
      })
      .sort((left, right) =>
        right.score - left.score
        || semanticDimensionIdentity(left.dimension).localeCompare(semanticDimensionIdentity(right.dimension)),
      )[0]?.dimension;
  }

  private cubeNameForTable(table: string): string | undefined {
    if (!table) return undefined;
    for (const [name, cube] of this.cubes) {
      if (cube.table === table || name === table) return name;
    }
    return undefined;
  }

  private composeAggregateIslands(
    options: ComposeQueryOptions,
    metrics: MetricDefinition[],
    dimensions: DimensionDefinition[],
    timeDimension: DimensionDefinition | undefined,
    dialect: SQLDialect,
  ): ComposeQueryResult | null {
    const grainKeys = [
      ...dimensions.map((dimension) => dimension.name),
      ...(timeDimension && options.timeDimension
        ? [`${timeDimension.name}_${options.timeDimension.granularity}`]
        : []),
    ];
    const islands = metrics.map((metric) => this.composeQuery({
      ...options,
      metrics: [metric.name],
      // Ranking/limits apply to the consolidated result, never inside an island.
      orderBy: undefined,
      limit: undefined,
    }));
    if (islands.some((island) => !island)) return null;
    const compiled = islands as ComposeQueryResult[];
    const cteNames = metrics.map((metric, index) => `metric_${index + 1}_${sanitizeSqlAlias(metric.name)}`);
    const ctes = compiled.map((island, index) => `${cteNames[index]} AS (\n${indentSql(island.sql)}\n)`);

    let body: string;
    const joinClauses: string[] = [];
    if (grainKeys.length === 0) {
      const select = metrics.map((metric, index) => `${cteNames[index]}.${metric.name} AS ${metric.name}`);
      body = `SELECT\n  ${select.join(',\n  ')}\nFROM ${cteNames[0]}`;
      for (const cte of cteNames.slice(1)) {
        const clause = `CROSS JOIN ${cte}`;
        joinClauses.push(clause);
        body += `\n${clause}`;
      }
    } else {
      const keysCte = `grain_keys AS (\n${cteNames.map((cte) => `  SELECT ${grainKeys.join(', ')} FROM ${cte}`).join('\n  UNION\n')}\n)`;
      ctes.push(keysCte);
      const select = [
        ...grainKeys.map((key) => `grain_keys.${key} AS ${key}`),
        ...metrics.map((metric, index) => `${cteNames[index]}.${metric.name} AS ${metric.name}`),
      ];
      body = `SELECT\n  ${select.join(',\n  ')}\nFROM grain_keys`;
      for (let index = 0; index < cteNames.length; index += 1) {
        const cte = cteNames[index];
        const predicate = grainKeys.map((key) => `grain_keys.${key} = ${cte}.${key}`).join(' AND ');
        const clause = `LEFT JOIN ${cte} ON ${predicate}`;
        joinClauses.push(clause);
        body += `\n${clause}`;
      }
    }

    if ((options.orderBy ?? []).length > 0) {
      body += `\nORDER BY ${options.orderBy!.map((order) => `${order.name} ${order.direction.toUpperCase()}`).join(', ')}`;
    }
    if (options.limit) body += `\n${dialect.limitClause(options.limit)}`;
    return {
      sql: `WITH ${ctes.join(',\n')}\n${body}`,
      joins: joinClauses,
      tables: Array.from(new Set(compiled.flatMap((island) => island.tables))),
      strategy: 'aggregate_islands',
      grainKeys,
    };
  }

  addHierarchy(hierarchy: HierarchyDefinition): void {
    const levels = [...(hierarchy.levels ?? [])].sort((a, b) => a.order - b.order);
    const levelNames = new Set(levels.map((level) => level.name));
    const normalizedDrillPaths = (hierarchy.drillPaths ?? [])
      .map((path) => ({
        name: path.name,
        levels: path.levels.filter((levelName) => levelNames.has(levelName)),
      }))
      .filter((path) => path.levels.length > 0);
    const defaultPath = hierarchy.defaultDrillPath
      && normalizedDrillPaths.some((path) => path.name === hierarchy.defaultDrillPath)
      ? hierarchy.defaultDrillPath
      : normalizedDrillPaths[0]?.name;

    this.hierarchies.set(hierarchy.name, {
      ...hierarchy,
      levels,
      drillPaths: normalizedDrillPaths.length > 0 ? normalizedDrillPaths : undefined,
      defaultDrillPath: defaultPath,
      defaultRollup: hierarchy.defaultRollup ?? 'sum',
    });
  }

  getMetric(name: string): MetricDefinition | undefined {
    return this.metrics.get(name);
  }

  getDimension(name: string): DimensionDefinition | undefined {
    return this.dimensions.get(name);
  }

  getHierarchy(name: string): HierarchyDefinition | undefined {
    return this.hierarchies.get(name);
  }

  getMeasure(name: string): MeasureDefinition | undefined {
    return this.measures.get(name);
  }

  getEntity(name: string): EntityDefinition | undefined {
    return this.entities.get(name);
  }

  getSemanticModel(name: string): SemanticModelDefinition | undefined {
    return this.semanticModels.get(name);
  }

  getSavedQuery(name: string): SavedQueryDefinition | undefined {
    return this.savedQueries.get(name);
  }

  /**
   * List metrics. By default returns everything in the metrics map — including
   * measures projected in by {@link addCube} — for backward compatibility.
   * Pass `{ includeMeasures: false }` to exclude measure-derived entries so the
   * UI metric picker and the agent's metric matcher see only real metrics.
   */
  listMetrics(domain?: string, opts?: { includeMeasures?: boolean }): MetricDefinition[] {
    let all = Array.from(this.metrics.values());
    if (opts?.includeMeasures === false) {
      all = all.filter((m) => m.objectKind !== 'measure');
    }
    return domain ? all.filter((m) => m.domain === domain) : all;
  }

  /**
   * Resolve a group-by reference that may be a bare dimension name
   * (`customer_name`) OR a MetricFlow-qualified name (`bcm_hdr__customer_name`).
   * The single tolerance point that lets native composition accept both
   * spellings without changing what it emits. Returns the best-matching
   * dimension variant, or undefined when nothing matches.
   */
  resolveGroupBy(name: string): DimensionDefinition | undefined {
    if (!name) return undefined;
    // Exact bare-name hit first.
    const direct = this.dimensions.get(name);
    if (direct) return direct;
    // Qualified `<entityPath>__<dim>`: match the trailing dimension segment,
    // preferring a variant whose entityLink/cube matches the qualifier head.
    if (name.includes('__')) {
      const segments = name.split('__');
      const leaf = segments[segments.length - 1]!;
      const qualifier = segments[segments.length - 2];
      const variants = this.dimensionVariants.get(leaf) ?? (this.dimensions.has(leaf) ? [this.dimensions.get(leaf)!] : []);
      if (variants.length > 0) {
        const byEntity = qualifier
          ? variants.find((d) => d.entityLink === qualifier || d.cube === qualifier)
          : undefined;
        return byEntity ?? variants.find((d) => d.qualifiedName === name) ?? variants[0];
      }
    }
    // Bare leaf with no direct map hit (e.g. a variant-only dimension).
    const variants = this.dimensionVariants.get(name);
    return variants?.[0];
  }

  listDimensions(domain?: string): DimensionDefinition[] {
    const all = Array.from(this.dimensions.values());
    return domain ? all.filter((d) => d.domain === domain) : all;
  }

  listHierarchies(domain?: string): HierarchyDefinition[] {
    const all = Array.from(this.hierarchies.values());
    return domain ? all.filter((h) => h.domain === domain) : all;
  }

  listMeasures(domain?: string): MeasureDefinition[] {
    const all = Array.from(this.measures.values());
    return domain ? all.filter((m) => m.domain === domain) : all;
  }

  listEntities(domain?: string): EntityDefinition[] {
    const all = Array.from(this.entities.values());
    return domain ? all.filter((e) => e.domain === domain) : all;
  }

  listTimeDimensions(domain?: string): TimeDimensionDefinition[] {
    return this.listDimensions(domain).filter((d): d is TimeDimensionDefinition => Boolean(d.isTimeDimension || d.source?.objectType === 'time_dimension'));
  }

  /** The time-dimension record for a name, including its real `granularities`. */
  getTimeDimension(name: string): TimeDimensionDefinition | undefined {
    const dim = this.dimensions.get(name);
    if (dim && (dim.isTimeDimension || dim.source?.objectType === 'time_dimension')) {
      return dim as TimeDimensionDefinition;
    }
    return this.listTimeDimensions().find((d) => d.name === name);
  }

  listSemanticModels(domain?: string): SemanticModelDefinition[] {
    const all = Array.from(this.semanticModels.values());
    return domain ? all.filter((m) => m.domain === domain) : all;
  }

  listSavedQueries(domain?: string): SavedQueryDefinition[] {
    const all = Array.from(this.savedQueries.values());
    return domain ? all.filter((q) => q.domain === domain) : all;
  }

  listDomains(): string[] {
    const domains = new Set<string>();
    const addDomain = (domain?: string) => domains.add(domain && domain.trim() ? domain : 'uncategorized');
    for (const metric of this.metrics.values()) {
      addDomain(metric.domain);
    }
    for (const dimension of this.dimensions.values()) {
      addDomain(dimension.domain);
    }
    for (const hierarchy of this.hierarchies.values()) {
      addDomain(hierarchy.domain);
    }
    for (const segment of this.segments.values()) {
      addDomain(segment.domain);
    }
    for (const preAggregation of this.preAggregations.values()) {
      addDomain(preAggregation.domain);
    }
    for (const cube of this.cubes.values()) {
      addDomain(cube.domain);
    }
    for (const measure of this.measures.values()) {
      addDomain(measure.domain);
    }
    for (const entity of this.entities.values()) {
      addDomain(entity.domain);
    }
    for (const model of this.semanticModels.values()) {
      addDomain(model.domain);
    }
    for (const query of this.savedQueries.values()) {
      addDomain(query.domain);
    }
    return Array.from(domains).sort((a, b) => a.localeCompare(b));
  }

  listTags(): string[] {
    const tags = new Set<string>();
    const collect = (values?: string[]) => {
      for (const value of values ?? []) {
        if (value) tags.add(value);
      }
    };
    for (const metric of this.metrics.values()) collect(metric.tags);
    for (const dimension of this.dimensions.values()) collect(dimension.tags);
    for (const hierarchy of this.hierarchies.values()) collect(hierarchy.tags);
    for (const segment of this.segments.values()) collect(segment.tags);
    for (const preAggregation of this.preAggregations.values()) collect(preAggregation.tags);
    for (const cube of this.cubes.values()) collect(cube.tags);
    for (const measure of this.measures.values()) collect(measure.tags);
    for (const entity of this.entities.values()) collect(entity.tags);
    for (const model of this.semanticModels.values()) collect(model.tags);
    for (const query of this.savedQueries.values()) collect(query.tags);
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  }

  resolveDrillPath(hierarchyName: string, drillPathName?: string): HierarchyLevelDefinition[] {
    const hierarchy = this.hierarchies.get(hierarchyName);
    if (!hierarchy) return [];

    const fallback = hierarchy.levels;
    if (!hierarchy.drillPaths || hierarchy.drillPaths.length === 0) return fallback;

    const selectedPathName = drillPathName ?? hierarchy.defaultDrillPath ?? hierarchy.drillPaths[0].name;
    const selectedPath = hierarchy.drillPaths.find((path) => path.name === selectedPathName);
    if (!selectedPath) return fallback;

    const levelMap = new Map(hierarchy.levels.map((level) => [level.name, level]));
    return selectedPath.levels
      .map((levelName) => levelMap.get(levelName))
      .filter((level): level is HierarchyLevelDefinition => Boolean(level));
  }

  nextDrillLevel(
    hierarchyName: string,
    currentLevelName?: string,
    drillPathName?: string,
  ): HierarchyLevelDefinition | null {
    const path = this.resolveDrillPath(hierarchyName, drillPathName);
    if (path.length === 0) return null;
    if (!currentLevelName) return path[0];

    const currentIndex = path.findIndex((level) => level.name === currentLevelName);
    if (currentIndex < 0) return path[0];
    return path[currentIndex + 1] ?? null;
  }

  /**
   * Search metrics and dimensions by text query.
   */
  search(query: string): { metrics: MetricDefinition[]; dimensions: DimensionDefinition[] } {
    const q = query.toLowerCase();
    return {
      metrics: Array.from(this.metrics.values()).filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.label.toLowerCase().includes(q) ||
          m.description.toLowerCase().includes(q) ||
          (m.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      ),
      dimensions: Array.from(this.dimensions.values()).filter(
        (d) =>
          d.name.toLowerCase().includes(q) ||
          d.label.toLowerCase().includes(q) ||
          d.description.toLowerCase().includes(q),
      ),
    };
  }

  searchAdvanced(query: string, options: SemanticSearchOptions = {}): SemanticSearchResults {
    const q = query.trim().toLowerCase();
    const domainSet = new Set((options.domains ?? []).filter(Boolean));
    const tagSet = new Set((options.tags ?? []).filter(Boolean));
    const typeSet = new Set(options.types ?? []);

    const matchesQuery = (values: Array<string | undefined>): boolean => {
      if (!q) return true;
      return values.some((value) => (value ?? '').toLowerCase().includes(q));
    };
    const matchesDomain = (domain?: string): boolean => domainSet.size === 0 || (!!domain && domainSet.has(domain));
    const matchesTags = (tags?: string[]): boolean => tagSet.size === 0 || (tags ?? []).some((tag) => tagSet.has(tag));
    const wantsType = (type: NonNullable<SemanticSearchOptions['types']>[number]): boolean => typeSet.size === 0 || typeSet.has(type);

    return {
      metrics: wantsType('metric')
        ? Array.from(this.metrics.values()).filter((metric) =>
            matchesQuery([metric.name, metric.label, metric.description, metric.table, metric.domain, ...(metric.tags ?? [])]) &&
            matchesDomain(metric.domain) &&
            matchesTags(metric.tags),
          )
        : [],
      dimensions: wantsType('dimension')
        ? Array.from(this.dimensions.values()).filter((dimension) =>
            matchesQuery([dimension.name, dimension.label, dimension.description, dimension.table, dimension.domain, ...(dimension.tags ?? [])]) &&
            matchesDomain(dimension.domain) &&
            matchesTags(dimension.tags),
          )
        : [],
      hierarchies: wantsType('hierarchy')
        ? Array.from(this.hierarchies.values()).filter((hierarchy) =>
            matchesQuery([hierarchy.name, hierarchy.label, hierarchy.description, hierarchy.domain, ...(hierarchy.tags ?? [])]) &&
            matchesDomain(hierarchy.domain) &&
            matchesTags(hierarchy.tags),
          )
        : [],
      measures: wantsType('measure')
        ? Array.from(this.measures.values()).filter((measure) =>
            matchesQuery([measure.name, measure.label, measure.description, measure.table, measure.domain, measure.agg, ...(measure.tags ?? [])]) &&
            matchesDomain(measure.domain) &&
            matchesTags(measure.tags),
          )
        : [],
      entities: wantsType('entity')
        ? Array.from(this.entities.values()).filter((entity) =>
            matchesQuery([entity.name, entity.label, entity.description, entity.table, entity.domain, entity.type, ...(entity.tags ?? [])]) &&
            matchesDomain(entity.domain) &&
            matchesTags(entity.tags),
          )
        : [],
      semanticModels: wantsType('semantic_model')
        ? Array.from(this.semanticModels.values()).filter((model) =>
            matchesQuery([model.name, model.label, model.description, model.table, model.domain, model.model, ...(model.tags ?? [])]) &&
            matchesDomain(model.domain) &&
            matchesTags(model.tags),
          )
        : [],
      savedQueries: wantsType('saved_query')
        ? Array.from(this.savedQueries.values()).filter((query) =>
            matchesQuery([query.name, query.label, query.description, query.domain, ...(query.metrics ?? []), ...(query.dimensions ?? []), ...(query.tags ?? [])]) &&
            matchesDomain(query.domain) &&
            matchesTags(query.tags),
          )
        : [],
    };
  }

  listCompatibleDimensions(metricNames: string[]): DimensionDefinition[] {
    const resolvedMetrics = metricNames
      .map((name) => this.metrics.get(name))
      .filter((metric): metric is MetricDefinition => Boolean(metric));
    if (resolvedMetrics.length === 0) return [];

    const resolveCubeNameForTable = (table: string): string | undefined => {
      for (const cube of this.cubes.values()) {
        if (cube.table === table || cube.name === table) return cube.name;
      }
      return undefined;
    };

    const collectMeasureNames = (metric: MetricDefinition, measureNames: Set<string>): void => {
      const measure = metric.typeParams?.measure;
      if (typeof measure === 'string' && measure.trim()) measureNames.add(measure.trim());
      if (measure && typeof measure === 'object' && !Array.isArray(measure) && typeof (measure as Record<string, unknown>).name === 'string') {
        measureNames.add(String((measure as Record<string, unknown>).name));
      }
      const inputs = metric.typeParams?.input_measures;
      if (Array.isArray(inputs)) {
        for (const input of inputs) {
          if (typeof input === 'string' && input.trim()) measureNames.add(input.trim());
          else if (input && typeof input === 'object' && typeof (input as Record<string, unknown>).name === 'string') {
            measureNames.add(String((input as Record<string, unknown>).name));
          }
        }
      }
    };

    // Derived/ratio metrics reference OTHER metrics (type_params.metrics /
    // numerator / denominator) rather than carrying measures directly. Some dbt
    // versions omit transitive input_measures, which left the reachable-table
    // set empty and the semantic panel graying EVERY dimension (including the
    // time dimension) for those metrics. Walk the referenced-metric graph
    // (bounded) so dimension compatibility reflects the metric's real models
    // even when the metric itself executes through a MetricFlow runtime.
    const referencedMetricNames = (metric: MetricDefinition): string[] => {
      const names = new Set<string>();
      const visit = (value: unknown): void => {
        if (!value) return;
        if (typeof value === 'string') {
          if (value.trim()) names.add(value.trim());
          return;
        }
        if (Array.isArray(value)) {
          for (const item of value) visit(item);
          return;
        }
        if (typeof value === 'object') {
          const raw = value as Record<string, unknown>;
          for (const key of ['name', 'metric', 'metric_name']) {
            if (typeof raw[key] === 'string') visit(raw[key]);
          }
        }
      };
      const typeParams = (metric.typeParams ?? {}) as Record<string, unknown>;
      visit(typeParams.metrics);
      visit(typeParams.numerator);
      visit(typeParams.denominator);
      return Array.from(names);
    };

    const metricTables = resolvedMetrics.map((metric) => {
      const reachableTables = new Set<string>();
      const measureNames = new Set<string>();
      collectMeasureNames(metric, measureNames);
      const visited = new Set<string>([metric.name]);
      let frontier = referencedMetricNames(metric);
      for (let depth = 0; depth < 3 && frontier.length > 0; depth += 1) {
        const next: string[] = [];
        for (const name of frontier) {
          if (visited.has(name)) continue;
          visited.add(name);
          const referenced = this.metrics.get(name);
          if (!referenced) continue;
          collectMeasureNames(referenced, measureNames);
          if (referenced.table) reachableTables.add(referenced.table);
          next.push(...referencedMetricNames(referenced));
        }
        frontier = next;
      }
      if (metric.table) reachableTables.add(metric.table);
      for (const measureName of measureNames) {
        const definition = this.measures.get(measureName);
        if (definition?.table) reachableTables.add(definition.table);
        for (const model of this.semanticModels.values()) {
          if (model.measures.includes(measureName) && model.table) reachableTables.add(model.table);
        }
      }

      for (const table of Array.from(reachableTables)) {
        const cubeName = resolveCubeNameForTable(table);
        if (!cubeName) continue;
        const queue = [cubeName];
        const visited = new Set<string>(queue);
        while (queue.length > 0) {
          const current = queue.shift()!;
          const cube = this.cubes.get(current);
          if (cube?.table) reachableTables.add(cube.table);
          const joins = this.joinGraph.get(current) ?? [];
          for (const join of joins) {
            const next = join.right;
            if (visited.has(next)) continue;
            visited.add(next);
            queue.push(next);
          }
        }
      }
      return reachableTables;
    });

    const reachableTables = metricTables.slice(1).reduce((common, tables) => {
      for (const table of common) if (!tables.has(table)) common.delete(table);
      return common;
    }, new Set(metricTables[0]));

    const compatibleVariants = Array.from(this.dimensionVariants.values())
      .flat()
      .filter((dimension) => reachableTables.has(dimension.table));
    const names = Array.from(new Set(compatibleVariants.map((dimension) => dimension.name)));
    return names
      .map((name) => this.resolveDimensionForMetrics(name, resolvedMetrics))
      .filter((dimension): dimension is DimensionDefinition =>
        Boolean(dimension && reachableTables.has(dimension.table)),
      )
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * Validate that all metric references in a SQL query resolve to known metrics/dimensions.
   */
  validateReferences(references: string[]): { valid: string[]; unknown: string[] } {
    const valid: string[] = [];
    const unknown: string[] = [];
    for (const ref of references) {
      const knownLevel = Array.from(this.hierarchies.values()).some((h) =>
        h.levels.some((level) => level.name === ref),
      );
      if (
        this.metrics.has(ref) ||
        this.dimensions.has(ref) ||
        this.hierarchies.has(ref) ||
        this.measures.has(ref) ||
        this.entities.has(ref) ||
        this.semanticModels.has(ref) ||
        this.savedQueries.has(ref) ||
        knownLevel
      ) {
        valid.push(ref);
      } else {
        unknown.push(ref);
      }
    }
    return { valid, unknown };
  }

  /**
   * Generate SQL for a metric with optional dimension grouping.
   * Delegates to composeQuery() to leverage the join graph when cubes are available.
   */
  generateMetricSQL(metricName: string, groupBy?: string[]): string | null {
    const metric = this.metrics.get(metricName);
    if (!metric) return null;

    // If we have cubes registered, use composeQuery for cross-table JOIN support
    if (this.cubes.size > 0) {
      const result = this.composeQuery({ metrics: [metricName], dimensions: groupBy ?? [] });
      if (result) return result.sql;
    }

    // Fallback: simple single-table SQL (original behavior, no cubes loaded)
    const dims = (groupBy ?? [])
      .map((d) => this.dimensions.get(d))
      .filter(Boolean) as DimensionDefinition[];

    const selectParts = [
      ...dims.map((d) => `${d.sql} AS ${d.name}`),
      `${renderMetricExpression(metric)} AS ${metric.name}`,
    ];

    const groupByParts = dims.map((d) => d.sql);

    let sql = `SELECT\n  ${selectParts.join(',\n  ')}\nFROM ${metric.table}`;
    if (groupByParts.length > 0) {
      sql += `\nGROUP BY ${groupByParts.join(', ')}`;
    }
    return sql;
  }
}

function renderMetricExpression(metric: MetricDefinition): string {
  const sql = metric.sql.trim();
  if (/^(sum|count|count_distinct|avg|min|max)\s*\(/i.test(sql)) return sql;

  switch (metric.type) {
    case 'sum':
      return `SUM(${sql})`;
    case 'count':
      return sql === '*' ? 'COUNT(*)' : `COUNT(${sql})`;
    case 'count_distinct':
      return `COUNT(DISTINCT ${sql})`;
    case 'avg':
      return `AVG(${sql})`;
    case 'min':
      return `MIN(${sql})`;
    case 'max':
      return `MAX(${sql})`;
    case 'custom':
    default:
      return sql;
  }
}

function normalizeMeasureMetricType(agg: string): MetricDefinition['type'] | null {
  switch (agg.toLowerCase()) {
    case 'sum':
    case 'count':
    case 'count_distinct':
    case 'avg':
    case 'min':
    case 'max':
      return agg.toLowerCase() as MetricDefinition['type'];
    case 'average':
      return 'avg';
    default:
      return null;
  }
}

/**
 * Outcome of resolving a governed metric's scoped `filter` into a SQL predicate.
 *  - `none`: the metric declares no filter.
 *  - `ok`: the metric filter rendered to a boolean SQL predicate.
 *  - `fail`: the metric DECLARES a filter we cannot safely render — the caller
 *    must refuse to compose (return null) rather than silently drop it and
 *    return a wrong number at the highest-trust tier.
 */
type MetricFilterResult = { kind: 'none' } | { kind: 'ok'; sql: string } | { kind: 'fail' };

/** Quote a scalar value for SQL, matching composeQuery's WHERE conventions. */
function quoteSqlValue(v: string): string {
  return /^-?\d+(\.\d+)?$/.test(v.trim()) ? v : `'${v.replace(/'/g, "''")}'`;
}

/**
 * Substitute MetricFlow-style `{{ Dimension('entity__dim') }}` /
 * `{{ TimeDimension('entity__dim', 'day') }}` references in a raw SQL filter
 * string. Plain SQL predicates (no Jinja) are trusted and returned as-is.
 * Returns null when any non-Dimension Jinja tag remains, so the caller fails safe.
 */
function resolveFilterJinja(raw: string, resolveColumn: (ref: string) => string): string | null {
  if (!raw.includes('{{')) return raw;
  const out = raw.replace(
    /\{\{\s*(?:Time)?Dimension\(\s*['"]([^'"]+)['"](?:\s*,\s*['"][^'"]+['"])?\s*\)\s*\}\}/g,
    (_full, ref: string) => resolveColumn(String(ref)),
  );
  return out.includes('{{') ? null : out;
}

/** Render a single object-shaped metric filter (`{ field, operator, value(s) }`). */
function renderObjectFilter(raw: Record<string, unknown>, resolveColumn: (ref: string) => string): string | null {
  // semantic_manifest.json represents compiled MetricFlow filters as
  // `{ where_filters: [{ where_sql_template: "..." }] }`. Normalize that
  // provider shape here so native fallback preserves the governed predicate.
  if (Array.isArray(raw.where_filters)) {
    const predicates: string[] = [];
    for (const item of raw.where_filters) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const template = (item as Record<string, unknown>).where_sql_template;
      if (typeof template !== 'string' || !template.trim()) return null;
      const rendered = resolveFilterJinja(template.trim(), resolveColumn);
      if (rendered === null) return null;
      if (rendered) predicates.push(`(${rendered})`);
    }
    return predicates.length > 0 ? predicates.join(' AND ') : '';
  }
  const field = raw.field ?? raw.dimension ?? raw.column ?? raw.name;
  if (field == null || String(field).trim() === '') {
    if (typeof raw.sql === 'string' && raw.sql.trim()) return resolveFilterJinja(raw.sql.trim(), resolveColumn);
    return null;
  }
  const col = resolveColumn(String(field));
  const rawValues = raw.values ?? (raw.value !== undefined ? [raw.value] : []);
  const values = (Array.isArray(rawValues) ? rawValues : [rawValues]).map((v) => String(v));
  const op = String(raw.operator ?? raw.op ?? (values.length > 1 ? 'in' : 'equals')).toLowerCase();
  const q = quoteSqlValue;
  switch (op) {
    case 'equals': case '=': case 'eq':
      return values.length > 1 ? `${col} IN (${values.map(q).join(', ')})` : `${col} = ${q(values[0] ?? '')}`;
    case 'not_equals': case '!=': case 'neq':
      return `${col} != ${q(values[0] ?? '')}`;
    case 'in':
      return values.length ? `${col} IN (${values.map(q).join(', ')})` : null;
    case 'not_in':
      return values.length ? `${col} NOT IN (${values.map(q).join(', ')})` : null;
    case 'gt': case '>': return `${col} > ${q(values[0] ?? '')}`;
    case 'gte': case '>=': return `${col} >= ${q(values[0] ?? '')}`;
    case 'lt': case '<': return `${col} < ${q(values[0] ?? '')}`;
    case 'lte': case '<=': return `${col} <= ${q(values[0] ?? '')}`;
    case 'contains': return `${col} LIKE '%${String(values[0] ?? '').replace(/'/g, "''")}%'`;
    case 'is_null': return `${col} IS NULL`;
    case 'is_not_null': return `${col} IS NOT NULL`;
    default: return null;
  }
}

/** Render a metric `filter` spec (string | object | array-of-objects) to SQL, or null if unrenderable. */
function renderFilterSpec(
  spec: string | Record<string, unknown> | Array<Record<string, unknown>>,
  resolveColumn: (ref: string) => string,
): string | null {
  if (typeof spec === 'string') {
    const trimmed = spec.trim();
    return trimmed ? resolveFilterJinja(trimmed, resolveColumn) : '';
  }
  if (Array.isArray(spec)) {
    const parts: string[] = [];
    for (const item of spec) {
      if (!item || typeof item !== 'object') return null;
      const r = renderObjectFilter(item, resolveColumn);
      if (r === null) return null;
      if (r) parts.push(`(${r})`);
    }
    return parts.length ? parts.join(' AND ') : '';
  }
  if (spec && typeof spec === 'object') return renderObjectFilter(spec, resolveColumn);
  return null;
}

/** Compute a metric's scoped-filter predicate, distinguishing none / ok / unrenderable. */
function computeMetricFilterPredicate(
  metric: MetricDefinition,
  resolveColumn: (ref: string) => string,
): MetricFilterResult {
  const f = metric.filter;
  if (f === undefined || f === null) return { kind: 'none' };
  const rendered = renderFilterSpec(f, resolveColumn);
  if (rendered === null) return { kind: 'fail' };
  if (!rendered) return { kind: 'none' };
  return { kind: 'ok', sql: rendered };
}

/**
 * Inject a metric's scoped filter INSIDE its aggregate via CASE WHEN so that a
 * multi-metric query with differing per-metric filters stays correct, e.g.
 * `SUM(amount)` + `status='completed'` → `SUM(CASE WHEN status='completed' THEN amount END)`.
 * Returns null when the expression is not a single recognizable aggregate call
 * (e.g. a ratio `SUM(a)/SUM(b)`), so the caller fails safe rather than emit
 * a filter that only partially applies.
 */
function wrapAggregateWithFilter(expr: string, predicate: string): string | null {
  const head = expr.match(/^\s*(sum|avg|min|max|count)\s*\(/i);
  if (!head) return null;
  const fn = head[1].toUpperCase();
  const openIdx = expr.indexOf('(', head.index ?? 0);
  // Find the close paren that matches the aggregate's opening paren. If it is
  // not the end of the expression, this is NOT a single aggregate call (e.g. a
  // ratio `SUM(a) / SUM(b)`) — refuse rather than inject a half-applied filter.
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < expr.length; i++) {
    if (expr[i] === '(') depth++;
    else if (expr[i] === ')' && --depth === 0) { closeIdx = i; break; }
  }
  if (closeIdx === -1 || expr.slice(closeIdx + 1).trim() !== '') return null;
  let inner = expr.slice(openIdx + 1, closeIdx).trim();
  const distinctMatch = inner.match(/^distinct\s+/i);
  const distinct = Boolean(distinctMatch);
  if (distinct) inner = inner.slice(distinctMatch![0].length).trim();
  if (fn === 'COUNT' && !distinct && inner === '*') return `COUNT(CASE WHEN ${predicate} THEN 1 END)`;
  const distinctKw = distinct ? 'DISTINCT ' : '';
  return `${fn}(${distinctKw}CASE WHEN ${predicate} THEN ${inner} END)`;
}

export function parseCubeDefinition(raw: Record<string, unknown>): CubeDefinition {
  const measuresRaw = Array.isArray(raw.measures) ? raw.measures : [];
  const dimensionsRaw = Array.isArray(raw.dimensions) ? raw.dimensions : [];
  const timeDimsRaw = Array.isArray(raw.time_dimensions ?? raw.timeDimensions) ? (raw.time_dimensions ?? raw.timeDimensions) as unknown[] : [];
  const joinsRaw = Array.isArray(raw.joins) ? raw.joins : [];
  const segmentsRaw = Array.isArray(raw.segments) ? raw.segments : [];
  const preAggregationsRaw = Array.isArray(raw.pre_aggregations ?? raw.preAggregations) ? (raw.pre_aggregations ?? raw.preAggregations) as unknown[] : [];
  const cubeName = String(raw.name ?? '');
  const cubeTable = String(raw.table ?? raw.name ?? '');
  const cubeSource = parseSourceMetadata(raw.source);

  const measures = measuresRaw
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .map((m) => parseMetricDefinition({ ...m, table: cubeTable, cube: cubeName, source: m.source ?? cubeSource }));

  const dimensions = dimensionsRaw
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
    .map((d) => parseDimensionDefinition({ ...d, table: cubeTable, cube: cubeName, source: d.source ?? cubeSource }));

  const timeDimensions = (timeDimsRaw as unknown[])
    .filter((td): td is Record<string, unknown> => !!td && typeof td === 'object')
    .map((td): TimeDimensionDefinition => {
      const base = parseDimensionDefinition({ ...td, table: cubeTable, cube: cubeName, type: 'date', source: (td as Record<string, unknown>).source ?? cubeSource });
      const granRaw = Array.isArray((td as Record<string, unknown>).granularities) ? (td as Record<string, unknown>).granularities as unknown[] : ['day', 'month', 'year'];
      const validGranularities = ['day', 'week', 'month', 'quarter', 'year'];
      return {
        ...base,
        granularities: granRaw.map(String).filter((g) => validGranularities.includes(g)) as TimeDimensionDefinition['granularities'],
        primaryTime: Boolean((td as Record<string, unknown>).primary_time ?? (td as Record<string, unknown>).primaryTime ?? false),
      };
    });

  const joins = joinsRaw
    .filter((j): j is Record<string, unknown> => !!j && typeof j === 'object')
    .map((j): JoinDefinition => ({
      name: String(j.name ?? ''),
      left: String(j.left ?? cubeName),
      right: String(j.right ?? j.name ?? ''),
      type: (['inner', 'left', 'right', 'full'].includes(String(j.type ?? 'left')) ? String(j.type ?? 'left') : 'left') as JoinDefinition['type'],
      sql: String(j.sql ?? ''),
    }));

  const segments = segmentsRaw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => parseSegmentDefinition({ ...s, cube: cubeName, domain: raw.domain, source: s.source ?? cubeSource }));

  const preAggregations = preAggregationsRaw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => parsePreAggregationDefinition({ ...p, cube: cubeName, domain: raw.domain, source: p.source ?? cubeSource }));

  return {
    name: cubeName,
    label: String(raw.label ?? raw.name ?? ''),
    description: String(raw.description ?? ''),
    sql: String(raw.sql ?? `SELECT * FROM ${cubeTable}`),
    table: cubeTable,
    domain: String(raw.domain ?? ''),
    measures,
    dimensions,
    timeDimensions,
    joins,
    segments,
    preAggregations,
    defaultTimeDimension: raw.default_time_dimension != null ? String(raw.default_time_dimension) : undefined,
    owner: raw.owner ? String(raw.owner) : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
    source: cubeSource,
  };
}

function semanticDimensionIdentity(dimension: DimensionDefinition): string {
  return [
    dimension.cube ?? '',
    dimension.table,
    dimension.name,
    dimension.sql,
    dimension.source?.objectId ?? '',
  ].join('|').toLowerCase();
}

function semanticDimensionReferences(dimension: DimensionDefinition): string[] {
  const references = new Set<string>([dimension.name]);
  if (dimension.cube) {
    references.add(`${dimension.cube}.${dimension.name}`);
    references.add(`${dimension.cube}__${dimension.name}`);
  }
  if (dimension.source?.objectId) references.add(dimension.source.objectId);
  return Array.from(references);
}

function sanitizeSqlAlias(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || 'metric';
}

const SQL_EXPRESSION_KEYWORDS = new Set([
  'and', 'or', 'not', 'null', 'true', 'false', 'case', 'when', 'then', 'else', 'end',
  'distinct', 'as', 'in', 'is', 'like', 'between', 'over', 'partition', 'by', 'order',
  'asc', 'desc', 'rows', 'range', 'current', 'row', 'unbounded', 'preceding', 'following',
  'interval', 'date', 'timestamp', 'varchar', 'string', 'numeric', 'decimal', 'integer',
  'float', 'double', 'boolean', 'cast', 'extract', 'from', 'at', 'time', 'zone',
]);

/** Replace semantic/physical qualifiers with the compiler-owned stable alias. */
function rewriteSqlQualifiers(sql: string, aliases: Map<string, string>): string {
  let output = sql;
  const entries = [...aliases.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [qualifier, alias] of entries) {
    if (!qualifier || qualifier === alias) continue;
    const escaped = qualifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    output = output.replace(new RegExp(`\\b${escaped}\\s*\\.`, 'g'), `${alias}.`);
  }
  return output;
}

/**
 * Qualify bare identifiers inside a semantic expression. This scanner keeps
 * quoted literals, SQL keywords, function names, and existing qualifiers
 * untouched while qualifying physical member references such as
 * `SUM(product_price)` and `CASE WHEN is_food_item THEN product_price END`.
 */
function qualifyBareSqlIdentifiers(sql: string, alias: string): string {
  let output = '';
  let index = 0;
  let quote: "'" | '"' | '`' | undefined;
  while (index < sql.length) {
    const char = sql[index];
    if (quote) {
      output += char;
      if (char === quote) {
        if (sql[index + 1] === quote) {
          output += sql[index + 1];
          index += 2;
          continue;
        }
        quote = undefined;
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      output += char;
      index += 1;
      continue;
    }
    if (!/[A-Za-z_]/.test(char)) {
      output += char;
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) end += 1;
    const token = sql.slice(index, end);
    const lower = token.toLowerCase();
    const previousNonSpace = output.match(/\S(?=\s*$)/)?.[0];
    const nextNonSpace = sql.slice(end).match(/^\s*(.)/)?.[1];
    const alreadyQualified = previousNonSpace === '.';
    const functionName = nextNonSpace === '(';
    if (alreadyQualified || functionName || lower === alias.toLowerCase() || SQL_EXPRESSION_KEYWORDS.has(lower)) {
      output += token;
    } else {
      output += `${alias}.${token}`;
    }
    index = end;
  }
  return output;
}

function indentSql(sql: string): string {
  return sql.split(/\r?\n/).map((line) => `  ${line}`).join('\n');
}

function validateMetricType(t: string): MetricDefinition['type'] {
  const valid = ['sum', 'count', 'count_distinct', 'avg', 'min', 'max', 'custom'];
  return valid.includes(t) ? (t as MetricDefinition['type']) : 'sum';
}

function validateDimensionType(t: string): DimensionDefinition['type'] {
  const valid = ['string', 'number', 'date', 'boolean'];
  return valid.includes(t) ? (t as DimensionDefinition['type']) : 'string';
}

function validateRollupType(t: string): HierarchyRollupType {
  const valid = ['sum', 'count', 'count_distinct', 'avg', 'min', 'max', 'none'];
  return valid.includes(t) ? (t as HierarchyRollupType) : 'sum';
}

function validateReviewStatus(value: unknown): BlockCompanionDefinition['reviewStatus'] {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'draft' || normalized === 'review' || normalized === 'approved') {
    return normalized;
  }
  return undefined;
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseSemanticFilter(value: unknown): MetricDefinition['filter'] {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const filters = value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
    return filters.length > 0 ? filters : undefined;
  }
  return parseRecord(value);
}

function parseSourceMetadata(value: unknown): SemanticSourceMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const provider = raw.provider ? String(raw.provider) : '';
  const objectType = raw.objectType ? String(raw.objectType) : raw.object_type ? String(raw.object_type) : '';
  const objectId = raw.objectId ? String(raw.objectId) : raw.object_id ? String(raw.object_id) : '';
  if (!provider || !objectType || !objectId) return undefined;
  const extra = raw.extra && typeof raw.extra === 'object' && !Array.isArray(raw.extra)
    ? raw.extra as Record<string, unknown>
    : undefined;
  return {
    provider,
    objectType,
    objectId,
    objectName: raw.objectName ? String(raw.objectName) : raw.object_name ? String(raw.object_name) : undefined,
    importedAt: raw.importedAt ? String(raw.importedAt) : raw.imported_at ? String(raw.imported_at) : undefined,
    extra,
  };
}

function parseStatus(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Normalize a display-format declaration from dbt `meta` or DQL YAML. Accepts
 * `meta.format: "currency"`, `meta: {format: {kind: percent, decimals: 1}}`,
 * `meta.currency: "EUR"`, and common shorthands ("usd", "$", "%").
 */
export function parseSemanticDisplayFormat(meta: unknown): SemanticDisplayFormat | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const record = meta as Record<string, unknown>;
  const raw = record.format ?? record.display_format ?? record.displayFormat;
  const currencyHint = typeof record.currency === 'string' ? record.currency.toUpperCase() : undefined;
  const decimalsHint = Number.isFinite(Number(record.decimals)) ? Math.max(0, Math.min(6, Math.floor(Number(record.decimals)))) : undefined;
  const fromKind = (kind: string, extra: Partial<SemanticDisplayFormat> = {}): SemanticDisplayFormat | undefined => {
    const normalized = kind.trim().toLowerCase();
    if (['currency', 'money', 'usd', '$', 'dollar', 'dollars'].includes(normalized)) {
      return { kind: 'currency', currency: extra.currency ?? currencyHint ?? 'USD', decimals: extra.decimals ?? decimalsHint ?? 2 };
    }
    if (['percent', 'percentage', 'pct', '%'].includes(normalized)) {
      return { kind: 'percent', ...(extra.decimals ?? decimalsHint) !== undefined ? { decimals: extra.decimals ?? decimalsHint } : {} };
    }
    if (['count', 'integer', 'int'].includes(normalized)) return { kind: 'count' };
    if (['number', 'decimal', 'float'].includes(normalized)) {
      return { kind: 'number', ...(extra.decimals ?? decimalsHint) !== undefined ? { decimals: extra.decimals ?? decimalsHint } : {} };
    }
    if (normalized === 'duration') return { kind: 'duration' };
    return undefined;
  };
  if (typeof raw === 'string') return fromKind(raw);
  if (raw && typeof raw === 'object') {
    const nested = raw as Record<string, unknown>;
    const kind = typeof nested.kind === 'string' ? nested.kind : typeof nested.format === 'string' ? nested.format : undefined;
    if (kind) {
      return fromKind(kind, {
        currency: typeof nested.currency === 'string' ? nested.currency.toUpperCase() : undefined,
        decimals: Number.isFinite(Number(nested.decimals)) ? Math.max(0, Math.min(6, Math.floor(Number(nested.decimals)))) : undefined,
      });
    }
  }
  if (currencyHint) return { kind: 'currency', currency: currencyHint, decimals: decimalsHint ?? 2 };
  return undefined;
}
