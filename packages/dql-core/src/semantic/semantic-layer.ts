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
  source?: SemanticSourceMetadata;
}

export interface DimensionDefinition {
  name: string;
  label: string;
  description: string;
  domain?: string;
  sql: string;
  type: 'string' | 'number' | 'date' | 'boolean';
  table: string;
  tags?: string[];
  owner?: string;
  cube?: string;
  expr?: string;
  isTimeDimension?: boolean;
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
}

export interface TimeDimensionDefinition extends DimensionDefinition {
  granularities: ('day' | 'week' | 'month' | 'quarter' | 'year')[];
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
    sql: String(raw.sql ?? ''),
    type: validateMetricType(String(raw.type ?? 'sum')),
    table: String(raw.table ?? ''),
    filters: raw.filters as Record<string, string> | undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
    owner: raw.owner ? String(raw.owner) : undefined,
    cube: raw.cube ? String(raw.cube) : undefined,
    aggregation: raw.aggregation ? String(raw.aggregation) : undefined,
    source: parseSourceMetadata(raw.source),
  };
}

export function parseDimensionDefinition(raw: Record<string, unknown>): DimensionDefinition {
  return {
    name: String(raw.name ?? ''),
    label: String(raw.label ?? raw.name ?? ''),
    description: String(raw.description ?? ''),
    domain: raw.domain != null ? String(raw.domain) : undefined,
    sql: String(raw.sql ?? ''),
    type: validateDimensionType(String(raw.type ?? 'string')),
    table: String(raw.table ?? ''),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
    owner: raw.owner ? String(raw.owner) : undefined,
    cube: raw.cube ? String(raw.cube) : undefined,
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
    this.metrics.set(metric.name, metric);
  }

  addDimension(dimension: DimensionDefinition): void {
    this.dimensions.set(dimension.name, dimension);
  }

  addCube(cube: CubeDefinition): void {
    this.cubes.set(cube.name, cube);
    // Auto-populate flat maps for backward compatibility
    for (const m of cube.measures) this.metrics.set(m.name, { ...m, cube: m.cube ?? cube.name, domain: m.domain || cube.domain, owner: m.owner ?? cube.owner, source: m.source ?? cube.source });
    for (const d of cube.dimensions) this.dimensions.set(d.name, { ...d, cube: d.cube ?? cube.name, domain: d.domain ?? cube.domain, owner: d.owner ?? cube.owner, source: d.source ?? cube.source });
    for (const td of cube.timeDimensions) this.dimensions.set(td.name, { ...td, cube: td.cube ?? cube.name, domain: td.domain ?? cube.domain, owner: td.owner ?? cube.owner, source: td.source ?? cube.source });
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
      .map((m) => this.metrics.get(m))
      .filter(Boolean) as MetricDefinition[];
    if (resolvedMetrics.length === 0) return null;

    // Resolve dimension definitions
    const resolvedDimensions = dimensions
      .map((d) => this.dimensions.get(d))
      .filter(Boolean) as DimensionDefinition[];

    // Resolve time dimension
    let timeDimDef: DimensionDefinition | undefined;
    if (timeDimension) {
      timeDimDef = this.dimensions.get(timeDimension.name);
    }

    // Find the primary table (from first metric)
    const primaryTable = resolvedMetrics[0].table;

    // Collect all tables referenced
    const allTables = new Set<string>([primaryTable]);
    for (const m of resolvedMetrics) allTables.add(m.table);
    for (const d of resolvedDimensions) allTables.add(d.table);
    if (timeDimDef) allTables.add(timeDimDef.table);

    // Find which cube corresponds to a table
    const cubeByTable = (table: string): string | undefined => {
      for (const [name, cube] of this.cubes) {
        if (cube.table === table || cube.name === table) return name;
      }
      return table; // fallback: treat table as cube name
    };

    // Build JOIN clauses using join graph
    const primaryCube = cubeByTable(primaryTable);
    const joinsUsed: JoinDefinition[] = [];
    const joinedTables = new Set<string>([primaryTable]);

    for (const table of allTables) {
      if (table === primaryTable) continue;
      const targetCube = cubeByTable(table) ?? table;
      const path = this.findJoinPath(primaryCube ?? primaryTable, targetCube);
      for (const join of path) {
        const joinKey = `${join.left}_${join.right}`;
        if (!joinsUsed.some((j) => `${j.left}_${j.right}` === joinKey)) {
          joinsUsed.push(join);
          joinedTables.add(join.right);
        }
      }
      // If no path found, still include the table with a simple reference
      if (!joinedTables.has(table)) {
        joinedTables.add(table);
      }
    }

    // Build SELECT
    const selectParts: string[] = [];

    // Add dimensions
    for (const d of resolvedDimensions) {
      const prefix = d.table !== primaryTable ? `${d.table}.` : '';
      const sql = d.sql.includes('.') ? d.sql : `${prefix}${d.sql}`;
      selectParts.push(`${sql} AS ${d.name}`);
    }

    // Add time dimension with granularity (dialect-aware)
    if (timeDimDef && timeDimension) {
      const grain = timeDimension.granularity;
      const tdSql = timeDimDef.sql.includes('.') ? timeDimDef.sql : `${timeDimDef.table}.${timeDimDef.sql}`;
      const truncated = dialect.dateTrunc(grain, tdSql);
      selectParts.push(`${truncated} AS ${timeDimDef.name}_${grain}`);
    }

    // Add metrics
    for (const m of resolvedMetrics) {
      selectParts.push(`${renderMetricExpression(m)} AS ${m.name}`);
    }

    // Build FROM + JOINs (apply tableMapping for actual DB table names)
    let fromClause = `FROM ${resolveTable(primaryTable)}`;
    const joinClauses: string[] = [];
    for (const join of joinsUsed) {
      const rightCube = this.cubes.get(join.right);
      const rightTable = resolveTable(rightCube?.table ?? join.right);
      const resolvedSql = join.sql
        .replace('${left}', resolveTable(join.left))
        .replace('${right}', rightTable);
      joinClauses.push(`${join.type.toUpperCase()} JOIN ${rightTable} ON ${resolvedSql}`);
    }

    // Build GROUP BY
    const groupByParts: string[] = [];
    for (const d of resolvedDimensions) {
      const prefix = d.table !== primaryTable ? `${d.table}.` : '';
      const sql = d.sql.includes('.') ? d.sql : `${prefix}${d.sql}`;
      groupByParts.push(sql);
    }
    if (timeDimDef && timeDimension) {
      const grain = timeDimension.granularity;
      const tdSql = timeDimDef.sql.includes('.') ? timeDimDef.sql : `${timeDimDef.table}.${timeDimDef.sql}`;
      groupByParts.push(dialect.dateTrunc(grain, tdSql));
    }

    // Build WHERE
    const whereParts: string[] = [];
    for (const f of filters ?? []) {
      if (!f.dimension) continue;
      const dimDef = this.dimensions.get(f.dimension);
      const dimSql = dimDef?.sql ?? f.dimension;
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

    return {
      sql,
      joins: joinClauses,
      tables: Array.from(allTables),
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

  listMetrics(domain?: string): MetricDefinition[] {
    const all = Array.from(this.metrics.values());
    return domain ? all.filter((m) => m.domain === domain) : all;
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
    for (const metric of this.metrics.values()) {
      if (metric.domain) domains.add(metric.domain);
    }
    for (const dimension of this.dimensions.values()) {
      if (dimension.domain) domains.add(dimension.domain);
    }
    for (const hierarchy of this.hierarchies.values()) {
      if (hierarchy.domain) domains.add(hierarchy.domain);
    }
    for (const segment of this.segments.values()) {
      if (segment.domain) domains.add(segment.domain);
    }
    for (const preAggregation of this.preAggregations.values()) {
      if (preAggregation.domain) domains.add(preAggregation.domain);
    }
    for (const cube of this.cubes.values()) {
      if (cube.domain) domains.add(cube.domain);
    }
    for (const measure of this.measures.values()) {
      if (measure.domain) domains.add(measure.domain);
    }
    for (const entity of this.entities.values()) {
      if (entity.domain) domains.add(entity.domain);
    }
    for (const model of this.semanticModels.values()) {
      if (model.domain) domains.add(model.domain);
    }
    for (const query of this.savedQueries.values()) {
      if (query.domain) domains.add(query.domain);
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

    const reachableTables = new Set<string>();
    const resolveCubeNameForTable = (table: string): string | undefined => {
      for (const cube of this.cubes.values()) {
        if (cube.table === table || cube.name === table) return cube.name;
      }
      return undefined;
    };

    for (const metric of resolvedMetrics) {
      reachableTables.add(metric.table);
      const cubeName = resolveCubeNameForTable(metric.table);
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

    return Array.from(this.dimensions.values())
      .filter((dimension) => reachableTables.has(dimension.table))
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
