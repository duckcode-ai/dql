import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  buildManifest,
  resolveDbtManifestPath,
  SemanticLayer,
  loadSemanticLayerFromDir,
  LineageGraph,
  type DQLManifest,
  type LineageEdgeType,
  type LineageLayer,
  type LineageNodeType,
} from '@duckcodeailabs/dql-core';

export interface DQLContextOptions {
  projectRoot: string;
  dqlVersion?: string;
}

/**
 * Shared read-only view over a DQL project.
 *
 * Loads the manifest + semantic layer once per MCP session. Tools call
 * {@link refresh} between turns if they need to see edits.
 */
export class DQLContext {
  readonly projectRoot: string;
  private readonly dqlVersion: string;
  private _manifest: DQLManifest | null = null;
  private _semanticLayer: SemanticLayer | null = null;
  private _lineage: LineageGraph | null = null;

  constructor(options: DQLContextOptions) {
    this.projectRoot = options.projectRoot;
    this.dqlVersion = options.dqlVersion ?? 'mcp';
  }

  get manifest(): DQLManifest {
    if (!this._manifest) this.refresh();
    return this._manifest!;
  }

  get semanticLayer(): SemanticLayer {
    if (!this._semanticLayer) this.refresh();
    return this._semanticLayer!;
  }

  get lineageGraph(): LineageGraph {
    if (!this._lineage) this._lineage = buildGraphFromManifest(this.manifest);
    return this._lineage;
  }

  refresh(): void {
    const dbtManifestPath = resolveDbtManifestPath(this.projectRoot) ?? undefined;
    this._manifest = buildManifest({
      projectRoot: this.projectRoot,
      dqlVersion: this.dqlVersion,
      dbtManifestPath,
    });

    const semanticDir = resolveSemanticDir(this.projectRoot);
    this._semanticLayer = existsSync(semanticDir)
      ? loadSemanticLayerFromDir(semanticDir)
      : new SemanticLayer();

    this._lineage = null;
  }
}

function buildGraphFromManifest(manifest: DQLManifest): LineageGraph {
  const graph = new LineageGraph();
  for (const node of manifest.lineage.nodes) {
    graph.addNode({
      id: node.id,
      type: node.type as LineageNodeType,
      name: node.name,
      layer: node.layer as LineageLayer | undefined,
      domain: node.domain,
      owner: node.owner,
      status: node.status as 'draft' | 'review' | 'certified' | 'deprecated' | 'pending_recertification' | undefined,
      metadata: node.metadata,
      columns: node.columns,
    });
  }
  for (const edge of manifest.lineage.edges) {
    graph.addEdge({
      source: edge.source,
      target: edge.target,
      type: edge.type as LineageEdgeType,
      sourceDomain: edge.sourceDomain,
      targetDomain: edge.targetDomain,
    });
  }
  return graph;
}

function resolveSemanticDir(projectRoot: string): string {
  const configPath = join(projectRoot, 'dql.config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        semanticLayer?: { path?: string };
      };
      if (config.semanticLayer?.path) {
        return join(projectRoot, config.semanticLayer.path);
      }
    } catch {
      /* fall through */
    }
  }
  return join(projectRoot, 'semantic-layer');
}

/** Walk up from `startDir` until a `dql.config.json` is found, else return `startDir`. */
export function findProjectRoot(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, 'dql.config.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}
