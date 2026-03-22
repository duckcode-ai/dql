/**
 * Provider registry: resolves a SemanticLayerProviderConfig to a loaded SemanticLayer.
 * Supports auto-detection when no config is provided.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SemanticLayer } from '../semantic-layer.js';
import type { SemanticLayerProviderConfig } from './provider.js';
import { DqlProvider } from './dql-provider.js';
import { DbtProvider } from './dbt-provider.js';
import { CubejsProvider } from './cubejs-provider.js';

/**
 * Resolve the semantic layer from config, or auto-detect if no config is given.
 *
 * Auto-detection order:
 *  1. If `semantic-layer/` exists in projectRoot, use DQL native provider.
 *  2. Otherwise return undefined.
 */
export function resolveSemanticLayer(
  config: SemanticLayerProviderConfig | undefined,
  projectRoot: string,
): SemanticLayer | undefined {
  if (config) {
    return loadFromConfig(config, projectRoot);
  }

  // Auto-detect: check for native DQL semantic-layer directory
  const nativeDir = join(projectRoot, 'semantic-layer');
  if (existsSync(nativeDir)) {
    const provider = new DqlProvider();
    return provider.load({ provider: 'dql' }, projectRoot);
  }

  return undefined;
}

function loadFromConfig(
  config: SemanticLayerProviderConfig,
  projectRoot: string,
): SemanticLayer | undefined {
  switch (config.provider) {
    case 'dql': {
      const provider = new DqlProvider();
      return provider.load(config, projectRoot);
    }
    case 'dbt': {
      const provider = new DbtProvider();
      return provider.load(config, projectRoot);
    }
    case 'cubejs': {
      const provider = new CubejsProvider();
      return provider.load(config, projectRoot);
    }
    case 'lookml': {
      // LookML provider not yet implemented
      return undefined;
    }
    default:
      return undefined;
  }
}
