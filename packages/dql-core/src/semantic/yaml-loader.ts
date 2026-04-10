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

  const subdirs: Array<{ folder: string; loader: (raw: Record<string, unknown>) => void }> = [
    { folder: 'metrics', loader: (raw) => layer.addMetric(parseMetricDefinition(raw)) },
    { folder: 'dimensions', loader: (raw) => layer.addDimension(parseDimensionDefinition(raw)) },
    { folder: 'hierarchies', loader: (raw) => layer.addHierarchy(parseHierarchyDefinition(raw)) },
    { folder: 'cubes', loader: (raw) => layer.addCube(parseCubeDefinition(raw)) },
    { folder: 'segments', loader: (raw) => layer.addSegment(parseSegmentDefinition(raw)) },
    { folder: 'pre_aggregations', loader: (raw) => layer.addPreAggregation(parsePreAggregationDefinition(raw)) },
  ];

  for (const { folder, loader } of subdirs) {
    const dir = join(semanticLayerDir, folder);
    if (!existsSync(dir)) continue;
    for (const filePath of collectYamlFiles(dir)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const raw = yaml.load(content) as Record<string, unknown>;
        if (raw && typeof raw === 'object') {
          loader(raw);
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
        layer.addMetric(parseMetricDefinition(raw));
      } else if (pathLower.includes('/dimensions/') || pathLower.includes('\\dimensions\\')) {
        layer.addDimension(parseDimensionDefinition(raw));
      } else if (pathLower.includes('/hierarchies/') || pathLower.includes('\\hierarchies\\')) {
        layer.addHierarchy(parseHierarchyDefinition(raw));
      } else if (pathLower.includes('/cubes/') || pathLower.includes('\\cubes\\')) {
        layer.addCube(parseCubeDefinition(raw));
      } else if (pathLower.includes('/segments/') || pathLower.includes('\\segments\\')) {
        layer.addSegment(parseSegmentDefinition(raw));
      } else if (pathLower.includes('/pre_aggregations/') || pathLower.includes('\\pre_aggregations\\')) {
        layer.addPreAggregation(parsePreAggregationDefinition(raw));
      }
    } catch {
      // Skip malformed files
    }
  }

  return layer;
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
