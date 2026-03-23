import type { SemanticLayer } from '../semantic-layer.js';

export interface SemanticLayerProviderConfig {
  provider: 'dql' | 'dbt' | 'cubejs' | 'lookml' | 'snowflake';
  /** Path to the external project (for dbt, cubejs, lookml). */
  projectPath?: string;
  /** Path to DQL's native semantic-layer/ directory. */
  path?: string;
  /** Source type for the semantic layer definitions. Defaults to 'local'. */
  source?: 'local' | 'github' | 'gitlab';
  /** Git repository URL (for source: 'github' or 'gitlab'). */
  repoUrl?: string;
  /** Branch to use when cloning a remote repo. Defaults to 'main'. */
  branch?: string;
  /** Sub-path within the cloned repo where the project lives. */
  subPath?: string;
  /** Named connection reference (for provider: 'snowflake'). */
  connection?: string;
}

export interface SemanticLayerProvider {
  readonly name: string;
  /** Load semantic definitions and populate a SemanticLayer instance. */
  load(config: SemanticLayerProviderConfig, projectRoot: string): SemanticLayer;
}
