/**
 * YAML-based semantic layer loader.
 * Reads metric, dimension, hierarchy, cube, and block-companion YAML files
 * from a project's semantic-layer/ directory and returns a populated SemanticLayer.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import * as yaml from 'js-yaml';
import {
  SemanticLayer,
  parseMetricDefinition,
  parseDimensionDefinition,
  parseHierarchyDefinition,
  parseCubeDefinition,
  parseSegmentDefinition,
  parsePreAggregationDefinition,
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
          for (const item of expandDefinitions(raw, keys)) loader(item);
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
