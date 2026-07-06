/**
 * Node-only filesystem loaders for the YAML semantic layer.
 *
 * This module is intentionally separate from `yaml-loader.ts` (which is
 * browser-safe: pure string/object parsing and serialization) because it
 * imports `node:fs`/`node:path`. Keeping the filesystem traversal here means
 * the browser-reachable barrel never drags node builtins into a browser
 * bundle. Node consumers import filesystem loaders from here (or the semantic
 * barrel, which re-exports from here); browser consumers use the pure helpers
 * in `yaml-loader.ts`.
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
} from './semantic-layer.js';
import { expandDefinitions, addIfNamed } from './yaml-loader.js';

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
