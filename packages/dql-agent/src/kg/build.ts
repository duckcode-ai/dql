/**
 * Build the KG node + edge arrays from a compiled DQL manifest.
 *
 * Inputs:
 *   - dql-manifest.json (blocks, dashboards, apps, metrics, dimensions, sources)
 *   - dbt manifest (already merged into the DQL manifest's dbtImport.dbtDag)
 *   - project Skills folder (loaded separately by the Skills loader)
 *
 * The output is intentionally flat — caller passes it to `KGStore.rebuild()`.
 */

import type { DQLManifest } from '@duckcodeailabs/dql-core';
import type { KGNode, KGEdge, KGNodeKind } from './types.js';

export function buildKGFromManifest(manifest: DQLManifest): {
  nodes: KGNode[];
  edges: KGEdge[];
} {
  const nodes: KGNode[] = [];
  const edges: KGEdge[] = [];

  // Blocks
  for (const block of Object.values(manifest.blocks)) {
    const nodeId = `block:${block.name}`;
    nodes.push({
      nodeId,
      kind: 'block',
      name: block.name,
      domain: block.domain,
      status: block.status,
      owner: block.owner,
      description: block.description,
      tags: block.tags ?? [],
      llmContext: block.llmContext,
      examples: block.examples,
      sourcePath: block.filePath,
    });
  }

  // Metrics
  for (const m of Object.values(manifest.metrics)) {
    const nodeId = `metric:${m.name}`;
    nodes.push({
      nodeId,
      kind: 'metric',
      name: m.name,
      domain: m.domain,
      description: m.description,
      sourcePath: m.filePath,
    });
  }

  // Dimensions
  for (const d of Object.values(manifest.dimensions)) {
    const nodeId = `dimension:${d.name}`;
    nodes.push({
      nodeId,
      kind: 'dimension',
      name: d.name,
      description: d.description,
      sourcePath: d.filePath,
    });
  }

  // Sources / dbt models
  for (const s of Object.values(manifest.sources)) {
    const isDbt = s.origin === 'dbt';
    const kind: KGNodeKind = isDbt ? 'dbt_model' : 'dbt_source';
    const nodeId = `${kind}:${s.name}`;
    nodes.push({
      nodeId,
      kind,
      name: s.name,
      description: s.dbtModel?.description,
    });
  }

  // Dashboards
  for (const d of Object.values(manifest.dashboards ?? {})) {
    const nodeId = `dashboard:${d.id}`;
    nodes.push({
      nodeId,
      kind: 'dashboard',
      name: d.title,
      domain: d.domain,
      description: d.description,
      tags: d.tags ?? [],
      sourcePath: d.filePath,
    });
    for (const blockId of d.blockIds) {
      edges.push({ src: `block:${blockId}`, dst: nodeId, kind: 'contains' });
    }
    for (const blockName of d.blockPathRefs) {
      edges.push({ src: `block:${blockName}`, dst: nodeId, kind: 'contains' });
    }
  }

  // Apps
  for (const a of Object.values(manifest.apps ?? {})) {
    const nodeId = `app:${a.id}`;
    nodes.push({
      nodeId,
      kind: 'app',
      name: a.name,
      domain: a.domain,
      owner: a.owners[0],
      description: a.description,
      tags: a.tags ?? [],
      sourcePath: a.filePath,
    });
    for (const dashboardId of a.dashboards) {
      edges.push({ src: `dashboard:${dashboardId}`, dst: nodeId, kind: 'contains' });
    }
  }

  // Domains: derive a node per distinct domain seen across blocks/dashboards/apps.
  const domains = new Set<string>();
  for (const block of Object.values(manifest.blocks)) if (block.domain) domains.add(block.domain);
  for (const d of Object.values(manifest.dashboards ?? {})) if (d.domain) domains.add(d.domain);
  for (const a of Object.values(manifest.apps ?? {})) if (a.domain) domains.add(a.domain);
  for (const m of Object.values(manifest.metrics)) if (m.domain) domains.add(m.domain);
  for (const d of domains) {
    nodes.push({
      nodeId: `domain:${d}`,
      kind: 'domain',
      name: d,
      domain: d,
    });
  }

  return { nodes, edges };
}
