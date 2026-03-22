/**
 * DQL Native semantic layer provider.
 * Reads from the project's semantic-layer/ directory using the existing YAML loader.
 */

import { join } from 'node:path';
import { loadSemanticLayerFromDir } from '../yaml-loader.js';
import type { SemanticLayerProvider, SemanticLayerProviderConfig } from './provider.js';
import type { SemanticLayer } from '../semantic-layer.js';

export class DqlProvider implements SemanticLayerProvider {
  readonly name = 'dql';

  load(config: SemanticLayerProviderConfig, projectRoot: string): SemanticLayer {
    const semanticDir = config.path
      ? join(projectRoot, config.path)
      : join(projectRoot, 'semantic-layer');
    return loadSemanticLayerFromDir(semanticDir);
  }
}
