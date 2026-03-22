import type { SemanticLayer } from '../semantic-layer.js';

export interface SemanticLayerProviderConfig {
  provider: 'dql' | 'dbt' | 'cubejs' | 'lookml';
  /** Path to the external project (for dbt, cubejs, lookml). */
  projectPath?: string;
  /** Path to DQL's native semantic-layer/ directory. */
  path?: string;
}

export interface SemanticLayerProvider {
  readonly name: string;
  /** Load semantic definitions and populate a SemanticLayer instance. */
  load(config: SemanticLayerProviderConfig, projectRoot: string): SemanticLayer;
}
