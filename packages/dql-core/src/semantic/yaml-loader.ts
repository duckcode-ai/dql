/**
 * YAML-based semantic layer loader.
 * Reads metric, dimension, hierarchy, cube, and block-companion YAML files
 * from a project's semantic-layer/ directory and returns a populated SemanticLayer.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import * as yaml from 'js-yaml';
import {
  SemanticLayer,
  parseMetricDefinition,
  parseDimensionDefinition,
  parseHierarchyDefinition,
  parseCubeDefinition,
} from './semantic-layer.js';

/**
 * Load a SemanticLayer from a directory on disk.
 * Expected structure:
 *   semanticLayerDir/
 *     metrics/       → *.yaml metric definitions
 *     dimensions/    → *.yaml dimension definitions
 *     hierarchies/   → *.yaml hierarchy definitions
 *     cubes/         → *.yaml cube definitions
 *     blocks/        → *.yaml block companion definitions (metadata only, not loaded into layer)
 */
export function loadSemanticLayerFromDir(semanticLayerDir: string): SemanticLayer {
  const layer = new SemanticLayer();

  const subdirs: Array<{ folder: string; loader: (raw: Record<string, unknown>) => void }> = [
    { folder: 'metrics', loader: (raw) => layer.addMetric(parseMetricDefinition(raw)) },
    { folder: 'dimensions', loader: (raw) => layer.addDimension(parseDimensionDefinition(raw)) },
    { folder: 'hierarchies', loader: (raw) => layer.addHierarchy(parseHierarchyDefinition(raw)) },
    { folder: 'cubes', loader: (raw) => layer.addCube(parseCubeDefinition(raw)) },
  ];

  for (const { folder, loader } of subdirs) {
    const dir = join(semanticLayerDir, folder);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (extname(file) !== '.yaml' && extname(file) !== '.yml') continue;
      try {
        const content = readFileSync(join(dir, file), 'utf-8');
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
      }
    } catch {
      // Skip malformed files
    }
  }

  return layer;
}
