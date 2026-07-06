/**
 * YAML-based semantic layer loader.
 * Reads metric, dimension, hierarchy, cube, and block-companion YAML files
 * from a project's semantic-layer/ directory and returns a populated SemanticLayer.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import * as yaml from 'js-yaml';
import {
  SemanticLayer,
  parseMetricDefinition,
  parseDimensionDefinition,
  parseHierarchyDefinition,
  parseCubeDefinition,
  parseSegmentDefinition,
  parsePreAggregationDefinition,
  type MetricDefinition,
  type DimensionDefinition,
} from './semantic-layer.js';

/**
 * Load a SemanticLayer from a directory on disk.
 * Expected structure:
 *   semanticLayerDir/
 *     metrics/       → *.yaml metric definitions
 *     dimensions/    → *.yaml dimension definitions
 *     hierarchies/   → *.yaml hierarchy definitions
 *     cubes/         → *.yaml cube definitions
 *     segments/      → *.yaml segment definitions
 *     pre_aggregations/ → *.yaml pre-aggregation definitions
 *     blocks/        → *.yaml block companion definitions (metadata only, not loaded into layer)
 */
export function loadSemanticLayerFromDir(semanticLayerDir: string): SemanticLayer {
  const layer = new SemanticLayer();

  const subdirs: Array<{ folder: string; keys: string[]; loader: (raw: Record<string, unknown>) => void }> = [
    { folder: 'metrics', keys: ['metrics'], loader: (raw) => addIfNamed(parseMetricDefinition(raw), (item) => layer.addMetric(item)) },
    { folder: 'dimensions', keys: ['dimensions'], loader: (raw) => addIfNamed(parseDimensionDefinition(raw), (item) => layer.addDimension(item)) },
    { folder: 'hierarchies', keys: ['hierarchies'], loader: (raw) => addIfNamed(parseHierarchyDefinition(raw), (item) => layer.addHierarchy(item)) },
    { folder: 'cubes', keys: ['cubes'], loader: (raw) => addIfNamed(parseCubeDefinition(raw), (item) => layer.addCube(item)) },
    { folder: 'segments', keys: ['segments'], loader: (raw) => addIfNamed(parseSegmentDefinition(raw), (item) => layer.addSegment(item)) },
    { folder: 'pre_aggregations', keys: ['pre_aggregations', 'preAggregations'], loader: (raw) => addIfNamed(parsePreAggregationDefinition(raw), (item) => layer.addPreAggregation(item)) },
  ];

  for (const { folder, keys, loader } of subdirs) {
    const dir = join(semanticLayerDir, folder);
    if (!existsSync(dir)) continue;
    for (const filePath of collectYamlFiles(dir)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const raw = yaml.load(content) as Record<string, unknown>;
        if (raw && typeof raw === 'object') {
          for (const item of expandDefinitions(raw, keys)) {
            loader(withLocalSemanticSource(item, semanticLayerDir, filePath, folder));
          }
        }
      } catch {
        // Skip malformed YAML files
      }
    }
  }

  return layer;
}

/**
 * Load a SemanticLayer from pre-read file contents (no filesystem access needed).
 * Useful for browser contexts or when files are already loaded.
 */
export function loadSemanticLayerFromConfig(
  files: Array<{ path: string; content: string }>,
): SemanticLayer {
  const layer = new SemanticLayer();

  for (const file of files) {
    try {
      const raw = yaml.load(file.content) as Record<string, unknown>;
      if (!raw || typeof raw !== 'object') continue;

      const pathLower = file.path.toLowerCase();
      if (pathLower.includes('/metrics/') || pathLower.includes('\\metrics\\')) {
        for (const item of expandDefinitions(raw, ['metrics'])) {
          addIfNamed(parseMetricDefinition(item), (parsed) => layer.addMetric(parsed));
        }
      } else if (pathLower.includes('/dimensions/') || pathLower.includes('\\dimensions\\')) {
        for (const item of expandDefinitions(raw, ['dimensions'])) {
          addIfNamed(parseDimensionDefinition(item), (parsed) => layer.addDimension(parsed));
        }
      } else if (pathLower.includes('/hierarchies/') || pathLower.includes('\\hierarchies\\')) {
        for (const item of expandDefinitions(raw, ['hierarchies'])) {
          addIfNamed(parseHierarchyDefinition(item), (parsed) => layer.addHierarchy(parsed));
        }
      } else if (pathLower.includes('/cubes/') || pathLower.includes('\\cubes\\')) {
        for (const item of expandDefinitions(raw, ['cubes'])) {
          addIfNamed(parseCubeDefinition(item), (parsed) => layer.addCube(parsed));
        }
      } else if (pathLower.includes('/segments/') || pathLower.includes('\\segments\\')) {
        for (const item of expandDefinitions(raw, ['segments'])) {
          addIfNamed(parseSegmentDefinition(item), (parsed) => layer.addSegment(parsed));
        }
      } else if (pathLower.includes('/pre_aggregations/') || pathLower.includes('\\pre_aggregations\\')) {
        for (const item of expandDefinitions(raw, ['pre_aggregations', 'preAggregations'])) {
          addIfNamed(parsePreAggregationDefinition(item), (parsed) => layer.addPreAggregation(parsed));
        }
      }
    } catch {
      // Skip malformed files
    }
  }

  return layer;
}

/**
 * Serialize a MetricDefinition back into stable semantic-layer YAML.
 * Used by governance flows that propose human-reviewed semantic changesets.
 */
export function serializeMetricDefinitionToYaml(metric: MetricDefinition): string {
  return dumpSemanticYaml(stripUndefined({
    name: metric.name,
    label: metric.label,
    description: metric.description,
    domain: metric.domain,
    status: metric.status,
    sql: metric.sql,
    type: metric.type,
    table: metric.table,
    filters: metric.filters,
    filter: metric.filter,
    tags: metric.tags,
    owner: metric.owner,
    cube: metric.cube,
    aggregation: metric.aggregation,
    metricType: metric.metricType,
    typeParams: metric.typeParams,
    aggTimeDimension: metric.aggTimeDimension,
    source: serializeSourceMetadata(metric.source),
  }));
}

/**
 * Serialize a DimensionDefinition back into stable semantic-layer YAML.
 * This mirrors the metric serializer so future composting can propose reusable
 * dimensions without hand-building YAML strings.
 */
export function serializeDimensionDefinitionToYaml(dimension: DimensionDefinition): string {
  return dumpSemanticYaml(stripUndefined({
    name: dimension.name,
    label: dimension.label,
    description: dimension.description,
    domain: dimension.domain,
    status: dimension.status,
    sql: dimension.sql,
    type: dimension.type,
    table: dimension.table,
    tags: dimension.tags,
    owner: dimension.owner,
    cube: dimension.cube,
    expr: dimension.expr,
    isTimeDimension: dimension.isTimeDimension,
    typeParams: dimension.typeParams,
    source: serializeSourceMetadata(dimension.source),
  }));
}

function expandDefinitions(raw: Record<string, unknown>, collectionKeys: string[]): Record<string, unknown>[] {
  for (const key of collectionKeys) {
    const collection = raw[key];
    if (Array.isArray(collection)) {
      return collection.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
    }
  }
  if (typeof raw.name === 'string' && raw.name.trim().length > 0) return [raw];
  return [];
}

function withLocalSemanticSource(
  raw: Record<string, unknown>,
  semanticLayerDir: string,
  filePath: string,
  folder: string,
): Record<string, unknown> {
  const existing = raw.source && typeof raw.source === 'object' && !Array.isArray(raw.source)
    ? raw.source as Record<string, unknown>
    : {};
  const existingExtra = existing.extra && typeof existing.extra === 'object' && !Array.isArray(existing.extra)
    ? existing.extra as Record<string, unknown>
    : {};
  const relativePath = relative(semanticLayerDir, filePath).replace(/\\/g, '/');
  const objectName = typeof raw.name === 'string' ? raw.name : undefined;
  return {
    ...raw,
    source: {
      ...existing,
      provider: typeof existing.provider === 'string' ? existing.provider : 'dql',
      objectType: typeof existing.objectType === 'string' ? existing.objectType : folder.replace(/s$/, ''),
      objectId: typeof existing.objectId === 'string' ? existing.objectId : objectName ?? relativePath,
      objectName: typeof existing.objectName === 'string' ? existing.objectName : objectName,
      extra: {
        ...existingExtra,
        path: typeof existingExtra.path === 'string' ? existingExtra.path : relativePath,
        raw: existingExtra.raw ?? raw,
      },
    },
  };
}

function dumpSemanticYaml(value: Record<string, unknown>): string {
  return yaml.dump(value, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function serializeSourceMetadata(source: MetricDefinition['source'] | DimensionDefinition['source']): Record<string, unknown> | undefined {
  if (!source) return undefined;
  return stripUndefined({
    provider: source.provider,
    objectType: source.objectType,
    objectId: source.objectId,
    objectName: source.objectName,
    importedAt: source.importedAt,
    extra: source.extra,
  });
}

function addIfNamed<T extends { name: string }>(item: T, add: (item: T) => void): void {
  if (item.name.trim().length > 0) add(item);
}

function collectYamlFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const filePath = join(dir, entry);
    try {
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        results.push(...collectYamlFiles(filePath));
      } else if (stat.isFile() && (extname(entry) === '.yaml' || extname(entry) === '.yml')) {
        results.push(filePath);
      }
    } catch {
      // Skip unreadable entries.
    }
  }
  return results;
}
