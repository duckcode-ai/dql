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
import { resolveRepoSource } from './repo-resolver.js';

export interface SemanticLayerResult {
  layer: SemanticLayer | undefined;
  errors: string[];
  detectedProvider?: string;
}

/**
 * Resolve the semantic layer from config, or auto-detect if no config is given.
 *
 * Auto-detection order:
 *  1. If explicit config is provided, use that provider.
 *  2. If `semantic-layer/` exists in projectRoot, use DQL native provider.
 *  3. If `dbt_project.yml` exists in projectRoot, use dbt provider.
 *  4. If `model/` or `schema/` with cube YAML exists, use cubejs provider.
 *  5. Otherwise return undefined.
 */
export function resolveSemanticLayer(
  config: SemanticLayerProviderConfig | undefined,
  projectRoot: string,
): SemanticLayer | undefined {
  return resolveSemanticLayerWithDiagnostics(config, projectRoot).layer;
}

export function resolveSemanticLayerWithDiagnostics(
  config: SemanticLayerProviderConfig | undefined,
  projectRoot: string,
): SemanticLayerResult {
  if (config) {
    return loadFromConfig(config, projectRoot);
  }

  return autoDetect(projectRoot);
}

function autoDetect(projectRoot: string): SemanticLayerResult {
  // 1. DQL native semantic-layer/ directory
  const nativeDir = join(projectRoot, 'semantic-layer');
  if (existsSync(nativeDir)) {
    const result = loadFromConfig({ provider: 'dql' }, projectRoot);
    result.detectedProvider = 'dql';
    return result;
  }

  // 2. dbt project (dbt_project.yml in root)
  if (existsSync(join(projectRoot, 'dbt_project.yml'))) {
    const result = loadFromConfig({ provider: 'dbt' }, projectRoot);
    result.detectedProvider = 'dbt';
    return result;
  }

  // 3. Cube.js project (model/ or schema/ directory)
  for (const candidate of ['model', 'schema']) {
    if (existsSync(join(projectRoot, candidate))) {
      const result = loadFromConfig({ provider: 'cubejs' }, projectRoot);
      result.detectedProvider = 'cubejs';
      return result;
    }
  }

  return { layer: undefined, errors: [] };
}

function loadFromConfig(
  config: SemanticLayerProviderConfig,
  projectRoot: string,
): SemanticLayerResult {
  const errors: string[] = [];

  try {
    // Resolve remote repo source to a local path if needed
    let effectiveRoot = projectRoot;
    if (config.source && config.source !== 'local' && config.repoUrl) {
      const resolved = resolveRepoSource(config, projectRoot);
      effectiveRoot = resolved.localPath;
      if (resolved.warnings.length > 0) {
        errors.push(...resolved.warnings);
      }
      // When using a remote source, the provider should read from the resolved
      // root directly — clear projectPath so the provider doesn't double-join.
      config = { ...config, projectPath: undefined };
    }

    switch (config.provider) {
      case 'dql': {
        const provider = new DqlProvider();
        return { layer: provider.load(config, effectiveRoot), errors };
      }
      case 'dbt': {
        const provider = new DbtProvider();
        return { layer: provider.load(config, effectiveRoot), errors };
      }
      case 'cubejs': {
        const provider = new CubejsProvider();
        return { layer: provider.load(config, effectiveRoot), errors };
      }
      case 'snowflake': {
        errors.push('Snowflake semantic views provider requires a live connection. Use the SnowflakeSemanticProvider directly.');
        return { layer: undefined, errors };
      }
      case 'lookml': {
        errors.push('LookML provider is not yet implemented. Use provider "dql", "dbt", or "cubejs".');
        return { layer: undefined, errors };
      }
      default:
        errors.push(`Unknown semantic layer provider: "${config.provider}". Supported: dql, dbt, cubejs, snowflake, lookml.`);
        return { layer: undefined, errors };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    errors.push(`Failed to load ${config.provider} semantic layer: ${msg}`);
    return { layer: undefined, errors };
  }
}
