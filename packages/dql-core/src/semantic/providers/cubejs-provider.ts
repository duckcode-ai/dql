/**
 * Cube.js semantic layer provider.
 * Reads Cube.js YAML schema format and maps cubes to DQL SemanticLayer definitions.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import * as yaml from 'js-yaml';
import {
  SemanticLayer,
  type MetricDefinition,
  type DimensionDefinition,
  type TimeDimensionDefinition,
  type JoinDefinition,
  type CubeDefinition,
} from '../semantic-layer.js';
import type { SemanticLayerProvider, SemanticLayerProviderConfig } from './provider.js';

/** Map Cube.js measure types to DQL metric types. */
const MEASURE_TYPE_MAP: Record<string, MetricDefinition['type']> = {
  count: 'count',
  count_distinct: 'count_distinct',
  countDistinct: 'count_distinct',
  sum: 'sum',
  avg: 'avg',
  min: 'min',
  max: 'max',
  number: 'custom',
};

/** Map Cube.js dimension types to DQL dimension types. */
const DIM_TYPE_MAP: Record<string, DimensionDefinition['type']> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  time: 'date',
  geo: 'string',
};

/** Map Cube.js relationship types to DQL join types. */
const JOIN_TYPE_MAP: Record<string, JoinDefinition['type']> = {
  one_to_one: 'inner',
  one_to_many: 'left',
  many_to_one: 'left',
  many_to_many: 'full',
  // Also support camelCase variants
  oneToOne: 'inner',
  oneToMany: 'left',
  manyToOne: 'left',
  manyToMany: 'full',
};

interface CubeJsCube {
  name: string;
  sql_table?: string;
  sqlTable?: string;
  sql?: string;
  title?: string;
  description?: string;
  measures?: Array<{
    name: string;
    type: string;
    sql?: string;
    title?: string;
    description?: string;
  }>;
  dimensions?: Array<{
    name: string;
    type: string;
    sql?: string;
    title?: string;
    description?: string;
    primary_key?: boolean;
    primaryKey?: boolean;
  }>;
  joins?: Array<{
    name: string;
    sql: string;
    relationship: string;
  }>;
  segments?: Array<{
    name: string;
    sql?: string;
    title?: string;
    description?: string;
  }>;
  pre_aggregations?: Array<{
    name: string;
    type?: string;
    measures?: string[];
    dimensions?: string[];
    time_dimension?: string;
    granularity?: string;
    refresh_key?: string;
    sql?: string;
    title?: string;
    description?: string;
  }>;
}

export class CubejsProvider implements SemanticLayerProvider {
  readonly name = 'cubejs';

  load(config: SemanticLayerProviderConfig, projectRoot: string): SemanticLayer {
    const layer = new SemanticLayer();
    const cubeRoot = config.projectPath
      ? join(projectRoot, config.projectPath)
      : projectRoot;

    // Cube.js stores schemas in model/ or schema/ directory
    let schemaDir: string | undefined;
    for (const candidate of ['model', 'schema']) {
      const candidatePath = join(cubeRoot, candidate);
      if (existsSync(candidatePath)) {
        schemaDir = candidatePath;
        break;
      }
    }

    if (!schemaDir) return layer;

    const yamlFiles = collectYamlFiles(schemaDir);

    for (const filePath of yamlFiles) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const doc = yaml.load(content) as Record<string, unknown> | null;
        if (!doc || typeof doc !== 'object') continue;

        if (Array.isArray(doc.cubes)) {
          for (const rawCube of doc.cubes) {
            if (rawCube && typeof rawCube === 'object') {
              const cube = convertCube(rawCube as CubeJsCube);
              layer.addCube(cube);
            }
          }
        }
      } catch {
        // Skip malformed YAML files
      }
    }

    return layer;
  }
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

/** Convert a Cube.js cube definition to a DQL CubeDefinition. */
function convertCube(raw: CubeJsCube): CubeDefinition {
  const cubeName = raw.name;
  const tableName = raw.sql_table ?? raw.sqlTable ?? cubeName;

  const measures: MetricDefinition[] = (raw.measures ?? []).map((m) => {
    const aggType = MEASURE_TYPE_MAP[m.type] ?? 'custom';
    const sqlExpr = m.sql ?? m.name;
    return {
      name: m.name,
      label: m.title ?? m.name,
      description: m.description ?? '',
      domain: '',
      sql: buildAggSql(aggType, sqlExpr),
      type: aggType,
      table: tableName,
      cube: cubeName,
      aggregation: m.type,
      source: {
        provider: 'cubejs',
        objectType: 'measure',
        objectId: `${cubeName}.${m.name}`,
        objectName: m.name,
      },
    };
  });

  const dimensions: DimensionDefinition[] = [];
  const timeDimensions: TimeDimensionDefinition[] = [];

  for (const dim of raw.dimensions ?? []) {
    const dqlType = DIM_TYPE_MAP[dim.type] ?? 'string';
    const sqlExpr = dim.sql ?? dim.name;

    if (dim.type === 'time') {
      timeDimensions.push({
        name: dim.name,
        label: dim.title ?? dim.name,
        description: dim.description ?? '',
        sql: sqlExpr,
        type: 'date',
        table: tableName,
        cube: cubeName,
        granularities: ['day', 'week', 'month', 'quarter', 'year'],
        primaryTime: Boolean(dim.primary_key ?? dim.primaryKey),
        source: {
          provider: 'cubejs',
          objectType: 'time_dimension',
          objectId: `${cubeName}.${dim.name}`,
          objectName: dim.name,
        },
      });
    } else {
      dimensions.push({
        name: dim.name,
        label: dim.title ?? dim.name,
        description: dim.description ?? '',
        sql: sqlExpr,
        type: dqlType,
        table: tableName,
        cube: cubeName,
        source: {
          provider: 'cubejs',
          objectType: 'dimension',
          objectId: `${cubeName}.${dim.name}`,
          objectName: dim.name,
        },
      });
    }
  }

  // Convert joins, replacing Cube.js template variables
  const joins: JoinDefinition[] = (raw.joins ?? []).map((j) => {
    // Replace {CUBE} with the current cube name and {OtherCube} with the join target
    let resolvedSql = j.sql
      .replace(/\{CUBE\}/g, tableName)
      .replace(new RegExp(`\\{${j.name}\\}`, 'g'), j.name);

    return {
      name: j.name,
      left: cubeName,
      right: j.name,
      type: JOIN_TYPE_MAP[j.relationship] ?? 'left',
      sql: resolvedSql,
    };
  });

  const segments = (raw.segments ?? []).map((segment) => ({
    name: segment.name,
    label: segment.title ?? segment.name,
    description: segment.description ?? '',
    domain: '',
    cube: cubeName,
    sql: segment.sql ?? '',
    source: {
      provider: 'cubejs',
      objectType: 'segment',
      objectId: `${cubeName}.${segment.name}`,
      objectName: segment.name,
    },
  }));

  const preAggregations = (raw.pre_aggregations ?? []).map((preAggregation) => ({
    name: preAggregation.name,
    label: preAggregation.title ?? preAggregation.name,
    description: preAggregation.description ?? '',
    domain: '',
    cube: cubeName,
    measures: preAggregation.measures,
    dimensions: preAggregation.dimensions,
    timeDimension: preAggregation.time_dimension,
    granularity: preAggregation.granularity,
    refreshKey: preAggregation.refresh_key,
    sql: preAggregation.sql,
    source: {
      provider: 'cubejs',
      objectType: 'pre_aggregation',
      objectId: `${cubeName}.${preAggregation.name}`,
      objectName: preAggregation.name,
      extra: preAggregation.type ? { type: preAggregation.type } : undefined,
    },
  }));

  return {
    name: cubeName,
    label: raw.title ?? cubeName,
    description: raw.description ?? '',
    sql: raw.sql ?? `SELECT * FROM ${tableName}`,
    table: tableName,
    domain: '',
    measures,
    dimensions,
    timeDimensions,
    joins,
    segments,
    preAggregations,
    source: {
      provider: 'cubejs',
      objectType: 'cube',
      objectId: cubeName,
      objectName: cubeName,
    },
  };
}

/** Build an aggregate SQL expression. */
function buildAggSql(aggType: MetricDefinition['type'], expr: string): string {
  switch (aggType) {
    case 'sum': return `SUM(${expr})`;
    case 'count': return `COUNT(${expr})`;
    case 'count_distinct': return `COUNT(DISTINCT ${expr})`;
    case 'avg': return `AVG(${expr})`;
    case 'min': return `MIN(${expr})`;
    case 'max': return `MAX(${expr})`;
    default: return expr;
  }
}
