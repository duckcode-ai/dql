/**
 * Semantic Layer: metric and dimension definitions parsed from YAML configs.
 * Maps to the architecture spec's semantic-layer/ directory structure.
 */

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
}

export interface DimensionDefinition {
  name: string;
  label: string;
  description: string;
  sql: string;
  type: 'string' | 'number' | 'date' | 'boolean';
  table: string;
  tags?: string[];
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
}

// ── Cube / Semantic Model Types ──

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
  defaultTimeDimension?: string;
  owner?: string;
  tags?: string[];
}

export interface ComposeQueryOptions {
  metrics: string[];
  dimensions: string[];
  timeDimension?: { name: string; granularity: string };
  filters?: Array<{ dimension: string; operator: string; values: string[] }>;
  orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>;
  limit?: number;
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
  semanticMappings?: Record<string, string>;
  lineage?: string[];
  notes?: string[];
  reviewStatus?: 'draft' | 'review' | 'approved';
}

export interface SemanticLayerConfig {
  metrics: MetricDefinition[];
  dimensions: DimensionDefinition[];
  hierarchies?: HierarchyDefinition[];
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
  };
}

export function parseDimensionDefinition(raw: Record<string, unknown>): DimensionDefinition {
  return {
    name: String(raw.name ?? ''),
    label: String(raw.label ?? raw.name ?? ''),
    description: String(raw.description ?? ''),
    sql: String(raw.sql ?? ''),
    type: validateDimensionType(String(raw.type ?? 'string')),
    table: String(raw.table ?? ''),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
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
  private cubes: Map<string, CubeDefinition> = new Map();
  // cube-name → list of joins for that cube (adjacency list)
  private joinGraph: Map<string, JoinDefinition[]> = new Map();

  constructor(config?: SemanticLayerConfig) {
    if (config) {
      for (const m of config.metrics) this.addMetric(m);
      for (const d of config.dimensions) this.addDimension(d);
      for (const h of config.hierarchies ?? []) this.addHierarchy(h);
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
    for (const m of cube.measures) this.metrics.set(m.name, m);
    for (const d of cube.dimensions) this.dimensions.set(d.name, d);
    for (const td of cube.timeDimensions) this.dimensions.set(td.name, td);
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

  getCube(name: string): CubeDefinition | undefined {
    return this.cubes.get(name);
  }

  listCubes(): CubeDefinition[] {
    return Array.from(this.cubes.values());
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
    const { metrics, dimensions, timeDimension, filters, orderBy, limit } = options;
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

    // Add time dimension with granularity
    if (timeDimDef && timeDimension) {
      const grain = timeDimension.granularity;
      const tdSql = timeDimDef.sql.includes('.') ? timeDimDef.sql : `${timeDimDef.table}.${timeDimDef.sql}`;
      const truncated = grain === 'day'
        ? `DATE_TRUNC('day', ${tdSql})`
        : grain === 'week'
          ? `DATE_TRUNC('week', ${tdSql})`
          : grain === 'month'
            ? `DATE_TRUNC('month', ${tdSql})`
            : grain === 'quarter'
              ? `DATE_TRUNC('quarter', ${tdSql})`
              : `DATE_TRUNC('year', ${tdSql})`;
      selectParts.push(`${truncated} AS ${timeDimDef.name}_${grain}`);
    }

    // Add metrics
    for (const m of resolvedMetrics) {
      selectParts.push(`${m.sql} AS ${m.name}`);
    }

    // Build FROM + JOINs
    let fromClause = `FROM ${primaryTable}`;
    const joinClauses: string[] = [];
    for (const join of joinsUsed) {
      const rightCube = this.cubes.get(join.right);
      const rightTable = rightCube?.table ?? join.right;
      const resolvedSql = join.sql
        .replace('${left}', join.left)
        .replace('${right}', join.right);
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
      groupByParts.push(`DATE_TRUNC('${grain}', ${tdSql})`);
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

    // Compose full SQL
    let sql = `SELECT\n  ${selectParts.join(',\n  ')}\n${fromClause}`;
    if (joinClauses.length > 0) sql += `\n${joinClauses.join('\n')}`;
    if (whereParts.length > 0) sql += `\nWHERE ${whereParts.join('\n  AND ')}`;
    if (groupByParts.length > 0) sql += `\nGROUP BY ${groupByParts.join(', ')}`;
    if (orderByParts.length > 0) sql += `\nORDER BY ${orderByParts.join(', ')}`;
    if (limit) sql += `\nLIMIT ${limit}`;

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

  listMetrics(domain?: string): MetricDefinition[] {
    const all = Array.from(this.metrics.values());
    return domain ? all.filter((m) => m.domain === domain) : all;
  }

  listDimensions(): DimensionDefinition[] {
    return Array.from(this.dimensions.values());
  }

  listHierarchies(domain?: string): HierarchyDefinition[] {
    const all = Array.from(this.hierarchies.values());
    return domain ? all.filter((h) => h.domain === domain) : all;
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
      if (this.metrics.has(ref) || this.dimensions.has(ref) || this.hierarchies.has(ref) || knownLevel) {
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
      `${metric.sql} AS ${metric.name}`,
    ];

    const groupByParts = dims.map((d) => d.sql);

    let sql = `SELECT\n  ${selectParts.join(',\n  ')}\nFROM ${metric.table}`;
    if (groupByParts.length > 0) {
      sql += `\nGROUP BY ${groupByParts.join(', ')}`;
    }
    return sql;
  }
}

export function parseCubeDefinition(raw: Record<string, unknown>): CubeDefinition {
  const measuresRaw = Array.isArray(raw.measures) ? raw.measures : [];
  const dimensionsRaw = Array.isArray(raw.dimensions) ? raw.dimensions : [];
  const timeDimsRaw = Array.isArray(raw.time_dimensions ?? raw.timeDimensions) ? (raw.time_dimensions ?? raw.timeDimensions) as unknown[] : [];
  const joinsRaw = Array.isArray(raw.joins) ? raw.joins : [];

  const measures = measuresRaw
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .map((m) => parseMetricDefinition({ ...m, table: String(raw.table ?? raw.name ?? '') }));

  const dimensions = dimensionsRaw
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
    .map((d) => parseDimensionDefinition({ ...d, table: String(raw.table ?? raw.name ?? '') }));

  const timeDimensions = (timeDimsRaw as unknown[])
    .filter((td): td is Record<string, unknown> => !!td && typeof td === 'object')
    .map((td): TimeDimensionDefinition => {
      const base = parseDimensionDefinition({ ...td, table: String(raw.table ?? raw.name ?? ''), type: 'date' });
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
      left: String(raw.name ?? ''),
      right: String(j.name ?? ''),
      type: (['inner', 'left', 'right', 'full'].includes(String(j.type ?? 'left')) ? String(j.type ?? 'left') : 'left') as JoinDefinition['type'],
      sql: String(j.sql ?? ''),
    }));

  return {
    name: String(raw.name ?? ''),
    label: String(raw.label ?? raw.name ?? ''),
    description: String(raw.description ?? ''),
    sql: String(raw.sql ?? `SELECT * FROM ${String(raw.table ?? raw.name ?? '')}`),
    table: String(raw.table ?? raw.name ?? ''),
    domain: String(raw.domain ?? ''),
    measures,
    dimensions,
    timeDimensions,
    joins,
    defaultTimeDimension: raw.default_time_dimension != null ? String(raw.default_time_dimension) : undefined,
    owner: raw.owner ? String(raw.owner) : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
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
