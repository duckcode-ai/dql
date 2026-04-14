/**
 * Snowflake Semantic Views Provider.
 *
 * Introspects Snowflake's semantic views (CREATE SEMANTIC VIEW) to discover
 * metrics, dimensions, and relationships. Unlike file-based providers (dbt,
 * cubejs), this provider requires a live Snowflake connection.
 *
 * Because dql-core must not depend on dql-connectors, this provider accepts
 * a generic query executor function. The CLI / local-runtime injects the
 * actual Snowflake connector at runtime.
 *
 * Usage:
 *   const provider = new SnowflakeSemanticProvider(async (sql) => {
 *     return connector.execute(sql);
 *   });
 *   const layer = await provider.loadAsync(config, projectRoot);
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SemanticLayer } from '../semantic-layer.js';
import type { MetricDefinition, DimensionDefinition, CubeDefinition, JoinDefinition } from '../semantic-layer.js';
import type { SemanticLayerProviderConfig } from './provider.js';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface SnowflakeCacheEntry {
  timestamp: number;
  views: SemanticViewInfo[];
  viewDescriptions: Record<string, SnowflakeQueryRow[]>;
  relationships: Record<string, SnowflakeQueryRow[]>;
}

function getCachePath(projectRoot: string): string {
  return join(projectRoot, 'semantic-layer', 'cache', 'snowflake-introspection.json');
}

function readCache(projectRoot: string): SnowflakeCacheEntry | null {
  const path = getCachePath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as SnowflakeCacheEntry;
    if (Date.now() - data.timestamp > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(projectRoot: string, entry: SnowflakeCacheEntry): void {
  const path = getCachePath(projectRoot);
  const dir = join(projectRoot, 'semantic-layer', 'cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(entry, null, 2), 'utf-8');
}

type MetricType = MetricDefinition['type'];
type DimensionType = DimensionDefinition['type'];

export interface SnowflakeQueryRow {
  [column: string]: unknown;
}

export interface SnowflakeQueryResult {
  rows: SnowflakeQueryRow[];
}

/** A function that executes a SQL query against Snowflake and returns rows. */
export type SnowflakeQueryExecutor = (sql: string) => Promise<SnowflakeQueryResult>;

export class SnowflakeSemanticProvider {
  readonly name = 'snowflake';

  constructor(private readonly executeQuery: SnowflakeQueryExecutor) {}

  /**
   * Load semantic layer definitions from Snowflake semantic views.
   * This is async because it needs to query Snowflake metadata.
   * Uses a file cache (1-hour TTL) to avoid repeated introspection.
   */
  async loadAsync(
    config: SemanticLayerProviderConfig,
    _projectRoot: string,
  ): Promise<SemanticLayer> {
    const layer = new SemanticLayer();
    const database = config.projectPath; // Reuse projectPath as database filter

    // Try reading from cache first
    const cached = readCache(_projectRoot);
    if (cached) {
      this.populateLayerFromCache(layer, cached);
      return layer;
    }

    // 1. Discover semantic views
    const views = await this.discoverSemanticViews(database);

    // 2. For each semantic view, load its metrics and dimensions
    const cacheEntry: SnowflakeCacheEntry = {
      timestamp: Date.now(),
      views,
      viewDescriptions: {},
      relationships: {},
    };

    for (const view of views) {
      const fqn = `"${view.databaseName}"."${view.schemaName}"."${view.name}"`;
      try {
        const desc = await this.executeQuery(`DESC SEMANTIC VIEW ${fqn}`);
        cacheEntry.viewDescriptions[fqn] = desc.rows;
      } catch { /* skip */ }
      try {
        const rels = await this.executeQuery(
          `SELECT * FROM TABLE(INFORMATION_SCHEMA.SEMANTIC_VIEW_RELATIONSHIPS('${fqn}'))`,
        );
        cacheEntry.relationships[fqn] = rels.rows;
      } catch { /* skip */ }
    }

    // Populate layer from the fresh data
    this.populateLayerFromCache(layer, cacheEntry);

    // Write cache for next time
    writeCache(_projectRoot, cacheEntry);

    return layer;
  }

  /**
   * Clear the cached introspection so the next load queries Snowflake fresh.
   */
  static clearCache(projectRoot: string): boolean {
    const path = getCachePath(projectRoot);
    if (existsSync(path)) {
      const { unlinkSync } = require('node:fs');
      unlinkSync(path);
      return true;
    }
    return false;
  }

  /**
   * Check if cache is present and fresh.
   */
  static isCached(projectRoot: string): { cached: boolean; age?: number } {
    const path = getCachePath(projectRoot);
    if (!existsSync(path)) return { cached: false };
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as SnowflakeCacheEntry;
      const age = Date.now() - data.timestamp;
      return { cached: age <= CACHE_TTL_MS, age };
    } catch {
      return { cached: false };
    }
  }

  private populateLayerFromCache(layer: SemanticLayer, cache: SnowflakeCacheEntry): void {
    for (const view of cache.views) {
      const fqn = `"${view.databaseName}"."${view.schemaName}"."${view.name}"`;
      const descRows = cache.viewDescriptions[fqn] ?? [];
      const relRows = cache.relationships[fqn] ?? [];

      // Process metrics and dimensions from cached description
      for (const row of descRows) {
        const colName = String(row['name'] ?? row['NAME'] ?? '');
        const colType = String(row['type'] ?? row['TYPE'] ?? '');
        const semanticRole = String(row['semantic_role'] ?? row['SEMANTIC_ROLE'] ?? row['kind'] ?? row['KIND'] ?? '');
        const expression = String(row['expression'] ?? row['EXPRESSION'] ?? row['default'] ?? row['DEFAULT'] ?? colName);
        const description = String(row['comment'] ?? row['COMMENT'] ?? '');

        if (semanticRole.toLowerCase() === 'measure' || semanticRole.toLowerCase() === 'metric') {
          const aggregation = inferAggregation(colType, expression);
          layer.addMetric({
            name: `${view.name}.${colName}`,
            label: colName.replace(/_/g, ' '),
            description: description || `Metric from ${view.name}`,
            sql: expression,
            type: aggregation,
            table: fqn,
            domain: view.schemaName,
            cube: view.name,
            aggregation,
            source: {
              provider: 'snowflake',
              objectType: 'metric',
              objectId: `${fqn}.${colName}`,
              objectName: colName,
            },
          });
        } else if (semanticRole.toLowerCase() === 'dimension' || semanticRole.toLowerCase() === 'entity') {
          const dimType = inferDimensionType(colType);
          layer.addDimension({
            name: `${view.name}.${colName}`,
            label: colName.replace(/_/g, ' '),
            description: description || `Dimension from ${view.name}`,
            sql: colName,
            type: dimType,
            table: fqn,
            cube: view.name,
            source: {
              provider: 'snowflake',
              objectType: 'dimension',
              objectId: `${fqn}.${colName}`,
              objectName: colName,
            },
          });
        }
      }

      // Process relationships
      for (const row of relRows) {
        const leftTable = String(row['left_table'] ?? row['LEFT_TABLE'] ?? '');
        const rightTable = String(row['right_table'] ?? row['RIGHT_TABLE'] ?? '');
        const joinType = String(row['join_type'] ?? row['JOIN_TYPE'] ?? 'left');
        const joinCondition = String(row['join_condition'] ?? row['JOIN_CONDITION'] ?? '');

        if (leftTable && rightTable && joinCondition) {
          const leftName = leftTable.split('.').pop() ?? leftTable;
          const rightName = rightTable.split('.').pop() ?? rightTable;

          const emptyCube = (cubeName: string, cubeTable: string): CubeDefinition => ({
            name: cubeName,
            label: cubeName,
            description: `Auto-discovered from Snowflake semantic view`,
            sql: `SELECT * FROM ${cubeTable}`,
            table: cubeTable,
            domain: view.schemaName,
            measures: [],
            dimensions: [],
            timeDimensions: [],
            joins: [],
            segments: [],
            preAggregations: [],
            source: {
              provider: 'snowflake',
              objectType: 'semantic_view',
              objectId: cubeTable,
              objectName: cubeName,
            },
          });

          if (!layer.getCube(leftName)) layer.addCube(emptyCube(leftName, leftTable));
          if (!layer.getCube(rightName)) layer.addCube(emptyCube(rightName, rightTable));

          const leftCube = layer.getCube(leftName);
          if (leftCube) {
            const jt = joinType.toLowerCase();
            const joinDef: JoinDefinition = {
              name: `${leftName}_${rightName}`,
              left: leftName,
              right: rightName,
              type: jt.includes('right') ? 'right' : jt.includes('full') ? 'full' : jt.includes('inner') ? 'inner' : 'left',
              sql: joinCondition,
            };
            leftCube.joins.push(joinDef);
          }
        }
      }
    }
  }

  /**
   * Discover available semantic views in the Snowflake account.
   */
  private async discoverSemanticViews(database?: string): Promise<SemanticViewInfo[]> {
    // Snowflake exposes semantic views via SHOW SEMANTIC VIEWS or
    // INFORMATION_SCHEMA. We try SHOW first as it's more universally available.
    let sql = 'SHOW SEMANTIC VIEWS';
    if (database) {
      sql += ` IN DATABASE "${database}"`;
    }

    try {
      const result = await this.executeQuery(sql);
      return result.rows.map((row) => ({
        name: String(row['name'] ?? row['NAME'] ?? ''),
        databaseName: String(row['database_name'] ?? row['DATABASE_NAME'] ?? ''),
        schemaName: String(row['schema_name'] ?? row['SCHEMA_NAME'] ?? ''),
      }));
    } catch {
      // SHOW SEMANTIC VIEWS may not be available in older Snowflake versions.
      // Fall back to INFORMATION_SCHEMA query.
      return this.discoverViaInformationSchema(database);
    }
  }

  private async discoverViaInformationSchema(database?: string): Promise<SemanticViewInfo[]> {
    const db = database ? `"${database}".` : '';
    const sql = `
      SELECT TABLE_NAME, TABLE_CATALOG, TABLE_SCHEMA
      FROM ${db}INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'SEMANTIC VIEW'
      ORDER BY TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME
    `;

    try {
      const result = await this.executeQuery(sql);
      return result.rows.map((row) => ({
        name: String(row['TABLE_NAME'] ?? ''),
        databaseName: String(row['TABLE_CATALOG'] ?? ''),
        schemaName: String(row['TABLE_SCHEMA'] ?? ''),
      }));
    } catch {
      // If neither approach works, return empty — the error will surface as
      // "no metrics found" which is more helpful than a raw SQL error.
      return [];
    }
  }

}

interface SemanticViewInfo {
  name: string;
  databaseName: string;
  schemaName: string;
}

/**
 * Infer the metric aggregation type from the column type and expression.
 */
function inferAggregation(colType: string, expression: string): MetricType {
  const exprLower = expression.toLowerCase();
  if (exprLower.includes('count(')) return 'count';
  if (exprLower.includes('sum(')) return 'sum';
  if (exprLower.includes('avg(') || exprLower.includes('average(')) return 'avg';
  if (exprLower.includes('min(')) return 'min';
  if (exprLower.includes('max(')) return 'max';
  if (exprLower.includes('count_distinct(') || exprLower.includes('count(distinct')) return 'count_distinct';

  // Infer from column type
  const typeLower = colType.toLowerCase();
  if (typeLower.includes('number') || typeLower.includes('float') || typeLower.includes('decimal')) {
    return 'sum';
  }
  return 'count';
}


/**
 * Infer the dimension type from the column SQL type.
 */
function inferDimensionType(colType: string): DimensionType {
  const typeLower = colType.toLowerCase();
  if (typeLower.includes('date') || typeLower.includes('time') || typeLower.includes('timestamp')) {
    return 'date';
  }
  if (typeLower.includes('number') || typeLower.includes('float') || typeLower.includes('decimal') || typeLower.includes('int')) {
    return 'number';
  }
  if (typeLower.includes('bool')) {
    return 'boolean';
  }
  return 'string';
}
