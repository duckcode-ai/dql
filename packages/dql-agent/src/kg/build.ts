/**
 * Build the KG node + edge arrays from a compiled DQL manifest.
 *
 * Inputs:
 *   - dql-manifest.json (terms, business views, blocks, dashboards, apps, metrics, dimensions, sources)
 *   - dbt manifest (already merged into the DQL manifest's dbtImport.dbtDag)
 *   - project Skills folder (loaded separately by the Skills loader)
 *
 * The output is intentionally flat — caller passes it to `KGStore.rebuild()`.
 */

import type {
  DQLManifest,
  ManifestBusinessView,
  ManifestTerm,
  SemanticLayer,
} from '@duckcodeailabs/dql-core';
import type { KGNode, KGEdge, KGNodeKind, KGCertification } from './types.js';

export function buildKGFromManifest(manifest: DQLManifest): {
  nodes: KGNode[];
  edges: KGEdge[];
} {
  const nodes: KGNode[] = [];
  const edges: KGEdge[] = [];

  // Business terms
  for (const term of Object.values(manifest.terms ?? {})) {
    nodes.push({
      nodeId: `term:${term.name}`,
      kind: 'term',
      name: term.name,
      domain: term.domain,
      status: term.status,
      owner: term.owner,
      description: term.description,
      tags: termTags(term),
      llmContext: renderTermContext(term),
      businessOutcome: term.businessOutcome,
      businessOwner: term.businessOwner,
      decisionUse: term.decisionUse,
      reviewCadence: term.reviewCadence,
      businessRules: term.businessRules,
      caveats: term.caveats,
      sourcePath: term.filePath,
      sourceTier: 'business_context',
      certification: certificationFromStatus(term.status),
      provenance: 'DQL business term',
    });
  }

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
      businessOutcome: block.businessOutcome,
      businessOwner: block.businessOwner,
      decisionUse: block.decisionUse,
      reviewCadence: block.reviewCadence,
      businessRules: block.businessRules ?? block.invariants,
      caveats: block.caveats,
      sourcePath: block.filePath,
      sourceTier: 'certified_artifact',
      certification: block.status === 'certified' ? 'certified' : 'analyst_review_required',
      provenance: 'DQL block',
    });
    for (const termRef of block.termRefs ?? []) {
      edges.push({ src: `term:${termRef}`, dst: nodeId, kind: 'defines' });
    }
  }

  // Business views
  for (const view of Object.values(manifest.businessViews ?? {})) {
    const nodeId = `business_view:${view.name}`;
    nodes.push({
      nodeId,
      kind: 'business_view',
      name: view.name,
      domain: view.domain,
      status: view.status,
      owner: view.owner,
      description: view.description,
      tags: view.tags ?? [],
      llmContext: renderBusinessViewContext(view),
      businessOutcome: view.businessOutcome,
      businessOwner: view.businessOwner,
      decisionUse: view.decisionUse,
      reviewCadence: view.reviewCadence,
      businessRules: view.businessRules,
      caveats: view.caveats,
      sourcePath: view.filePath,
      sourceTier: 'business_context',
      certification: certificationFromStatus(view.status),
      provenance: 'DQL business view',
    });
    for (const termRef of view.termRefs ?? []) {
      edges.push({ src: `term:${termRef}`, dst: nodeId, kind: 'defines' });
    }
    for (const blockRef of view.blockRefs ?? []) {
      edges.push({ src: `block:${blockRef}`, dst: nodeId, kind: 'composes' });
    }
    for (const viewRef of view.businessViewRefs ?? []) {
      edges.push({ src: `business_view:${viewRef}`, dst: nodeId, kind: 'composes' });
    }
  }

  // Notebooks become searchable governed workspaces. DQL cells that declare
  // blocks are also linked so app/dashboard chat can route users to the
  // analyst workbench that produced an artifact.
  for (const nb of Object.values(manifest.notebooks ?? {})) {
    const nodeId = `notebook:${nb.filePath}`;
    const cellSummary = nb.cells
      .map((cell) => [cell.title, cell.blockName, cell.source.slice(0, 160)].filter(Boolean).join(' — '))
      .filter(Boolean)
      .slice(0, 8)
      .join('\n');
    nodes.push({
      nodeId,
      kind: 'notebook',
      name: nb.title || nb.filePath,
      description: `${nb.cells.length} SQL/DQL cell${nb.cells.length === 1 ? '' : 's'}`,
      llmContext: cellSummary || undefined,
      sourcePath: nb.filePath,
      sourceTier: 'certified_artifact',
      certification: 'analyst_review_required',
      provenance: 'DQL notebook',
    });
    for (const cell of nb.cells) {
      if (cell.blockName) edges.push({ src: `block:${cell.blockName}`, dst: nodeId, kind: 'contains' });
      for (const ref of cell.refDependencies) edges.push({ src: `block:${ref}`, dst: nodeId, kind: 'depends_on' });
    }
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
      sourceTier: 'semantic_layer',
      certification: 'ai_generated',
      provenance: 'DQL semantic metric',
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
      sourceTier: 'semantic_layer',
      certification: 'ai_generated',
      provenance: 'DQL semantic dimension',
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
      llmContext: s.dbtModel?.columns
        ? renderColumnsContext(s.dbtModel.columns)
        : undefined,
      sourceTier: isDbt ? 'dbt_manifest' : 'project',
      certification: 'ai_generated',
      provenance: isDbt ? 'dbt manifest.json' : 'SQL/table reference',
    });
  }

  // Dashboards
  for (const d of Object.values(manifest.dashboards ?? {})) {
    const nodeId = `dashboard:${d.qualifiedId ?? `${d.appId}/${d.id}`}`;
    nodes.push({
      nodeId,
      kind: 'dashboard',
      name: d.title,
      domain: d.domain,
      status: 'certified',
      description: d.description,
      tags: d.tags ?? [],
      businessOutcome: d.businessOutcome,
      businessOwner: d.businessOwner,
      decisionUse: d.decisionUse,
      reviewCadence: d.reviewCadence,
      businessRules: d.businessRules,
      caveats: d.caveats,
      sourcePath: d.filePath,
      sourceTier: 'certified_artifact',
      certification: 'certified',
      provenance: 'DQL dashboard',
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
      status: 'certified',
      owner: a.owners[0],
      description: a.description,
      tags: a.tags ?? [],
      businessOutcome: a.businessOutcome,
      businessOwner: a.businessOwner,
      decisionUse: a.decisionUse,
      reviewCadence: a.reviewCadence,
      businessRules: a.businessRules,
      caveats: a.caveats,
      sourcePath: a.filePath,
      sourceTier: 'certified_artifact',
      certification: 'certified',
      provenance: 'DQL app',
    });
    for (const dashboardId of a.dashboards) {
      edges.push({ src: `dashboard:${dashboardId}`, dst: nodeId, kind: 'contains' });
    }
  }

  // Domains: derive a node per distinct domain seen across blocks/dashboards/apps.
  const domains = new Set<string>();
  for (const term of Object.values(manifest.terms ?? {})) if (term.domain) domains.add(term.domain);
  for (const view of Object.values(manifest.businessViews ?? {})) if (view.domain) domains.add(view.domain);
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

function certificationFromStatus(status: string | undefined): KGCertification {
  return status === 'certified' ? 'certified' : 'analyst_review_required';
}

function termTags(term: ManifestTerm): string[] {
  return Array.from(new Set([
    ...(term.tags ?? []),
    term.termType,
    ...(term.identifiers ?? []),
    ...(term.synonyms ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)));
}

function renderTermContext(term: ManifestTerm): string | undefined {
  return [
    term.termType ? `type: ${term.termType}` : '',
    term.identifiers?.length ? `identifiers: ${term.identifiers.join(', ')}` : '',
    term.synonyms?.length ? `synonyms: ${term.synonyms.join(', ')}` : '',
    term.businessRules?.length ? `business rules: ${term.businessRules.join('; ')}` : '',
    term.caveats?.length ? `caveats: ${term.caveats.join('; ')}` : '',
  ].filter(Boolean).join('\n') || undefined;
}

function renderBusinessViewContext(view: ManifestBusinessView): string | undefined {
  return [
    view.termRefs?.length ? `terms: ${view.termRefs.join(', ')}` : '',
    view.blockRefs?.length ? `blocks: ${view.blockRefs.join(', ')}` : '',
    view.businessViewRefs?.length ? `business views: ${view.businessViewRefs.join(', ')}` : '',
    view.businessRules?.length ? `business rules: ${view.businessRules.join('; ')}` : '',
    view.caveats?.length ? `caveats: ${view.caveats.join('; ')}` : '',
  ].filter(Boolean).join('\n') || undefined;
}

export function buildKGFromSemanticLayer(layer: SemanticLayer | undefined): {
  nodes: KGNode[];
  edges: KGEdge[];
} {
  const nodes: KGNode[] = [];
  const edges: KGEdge[] = [];
  if (!layer) return { nodes, edges };

  for (const metric of layer.listMetrics()) {
    const nodeId = `metric:${qualifiedSemanticName(metric.cube, metric.name)}`;
    nodes.push({
      nodeId,
      kind: 'metric',
      name: qualifiedSemanticName(metric.cube, metric.name),
      domain: metric.domain,
      owner: metric.owner,
      description: metric.description,
      tags: metric.tags ?? [],
      ...businessMetadataFromRaw(metric.source?.extra?.raw),
      llmContext: [
        metric.label ? `label: ${metric.label}` : '',
        metric.metricType ? `metric type: ${metric.metricType}` : '',
        metric.aggregation ? `aggregation: ${metric.aggregation}` : '',
        metric.table ? `table: ${metric.table}` : '',
        metric.sql ? `sql: ${metric.sql}` : '',
      ].filter(Boolean).join('\n') || undefined,
      sourceTier: 'semantic_layer',
      certification: 'ai_generated',
      provenance: metric.source?.provider === 'dbt'
        ? `dbt ${metric.source.objectType}`
        : metric.source?.provider ?? 'semantic layer',
      sourcePath: semanticSourcePath(metric.source?.extra),
    });
    if (metric.cube) edges.push({ src: nodeId, dst: `semantic_model:${metric.cube}`, kind: 'depends_on' });
  }

  for (const dimension of layer.listDimensions()) {
    const nodeId = `dimension:${qualifiedSemanticName(dimension.cube, dimension.name)}`;
    nodes.push({
      nodeId,
      kind: 'dimension',
      name: qualifiedSemanticName(dimension.cube, dimension.name),
      domain: dimension.domain,
      owner: dimension.owner,
      description: dimension.description,
      tags: dimension.tags ?? [],
      ...businessMetadataFromRaw(dimension.source?.extra?.raw),
      llmContext: [
        dimension.label ? `label: ${dimension.label}` : '',
        dimension.type ? `type: ${dimension.type}` : '',
        dimension.table ? `table: ${dimension.table}` : '',
        dimension.sql ? `sql: ${dimension.sql}` : '',
      ].filter(Boolean).join('\n') || undefined,
      sourceTier: 'semantic_layer',
      certification: 'ai_generated',
      provenance: dimension.source?.provider === 'dbt'
        ? `dbt ${dimension.source.objectType}`
        : dimension.source?.provider ?? 'semantic layer',
      sourcePath: semanticSourcePath(dimension.source?.extra),
    });
    if (dimension.cube) edges.push({ src: nodeId, dst: `semantic_model:${dimension.cube}`, kind: 'depends_on' });
  }

  for (const measure of layer.listMeasures()) {
    const nodeId = `measure:${qualifiedSemanticName(measure.cube, measure.name)}`;
    nodes.push({
      nodeId,
      kind: 'measure',
      name: qualifiedSemanticName(measure.cube, measure.name),
      domain: measure.domain,
      owner: measure.owner,
      description: measure.description,
      tags: measure.tags ?? [],
      ...businessMetadataFromRaw(measure.source?.extra?.raw),
      llmContext: [
        measure.label ? `label: ${measure.label}` : '',
        measure.agg ? `aggregation: ${measure.agg}` : '',
        measure.table ? `table: ${measure.table}` : '',
        measure.expr ? `expr: ${measure.expr}` : '',
        measure.aggTimeDimension ? `agg_time_dimension: ${measure.aggTimeDimension}` : '',
      ].filter(Boolean).join('\n') || undefined,
      sourceTier: 'semantic_layer',
      certification: 'ai_generated',
      provenance: measure.source?.provider === 'dbt'
        ? `dbt ${measure.source.objectType}`
        : measure.source?.provider ?? 'semantic layer',
      sourcePath: semanticSourcePath(measure.source?.extra),
    });
    if (measure.cube) edges.push({ src: nodeId, dst: `semantic_model:${measure.cube}`, kind: 'contains' });
  }

  for (const entity of layer.listEntities()) {
    const nodeId = `entity:${qualifiedSemanticName(entity.cube, entity.name)}`;
    nodes.push({
      nodeId,
      kind: 'entity',
      name: qualifiedSemanticName(entity.cube, entity.name),
      domain: entity.domain,
      owner: entity.owner,
      description: entity.description,
      tags: entity.tags ?? [],
      ...businessMetadataFromRaw(entity.source?.extra?.raw),
      llmContext: [
        entity.label ? `label: ${entity.label}` : '',
        entity.type ? `type: ${entity.type}` : '',
        entity.table ? `table: ${entity.table}` : '',
        entity.expr ? `expr: ${entity.expr}` : '',
      ].filter(Boolean).join('\n') || undefined,
      sourceTier: 'semantic_layer',
      certification: 'ai_generated',
      provenance: entity.source?.provider === 'dbt'
        ? `dbt ${entity.source.objectType}`
        : entity.source?.provider ?? 'semantic layer',
      sourcePath: semanticSourcePath(entity.source?.extra),
    });
    if (entity.cube) edges.push({ src: nodeId, dst: `semantic_model:${entity.cube}`, kind: 'contains' });
  }

  for (const model of layer.listSemanticModels()) {
    const nodeId = `semantic_model:${model.name}`;
    nodes.push({
      nodeId,
      kind: 'semantic_model',
      name: model.name,
      domain: model.domain,
      owner: model.owner,
      description: model.description,
      tags: model.tags ?? [],
      ...businessMetadataFromRaw(model.source?.extra?.raw),
      llmContext: [
        model.label ? `label: ${model.label}` : '',
        model.table ? `table: ${model.table}` : '',
        model.model ? `model: ${model.model}` : '',
        model.entities.length ? `entities: ${model.entities.join(', ')}` : '',
        model.measures.length ? `measures: ${model.measures.join(', ')}` : '',
        model.dimensions.length ? `dimensions: ${model.dimensions.join(', ')}` : '',
        model.timeDimensions.length ? `time_dimensions: ${model.timeDimensions.join(', ')}` : '',
      ].filter(Boolean).join('\n') || undefined,
      sourceTier: 'semantic_layer',
      certification: 'ai_generated',
      provenance: model.source?.provider === 'dbt'
        ? `dbt ${model.source.objectType}`
        : model.source?.provider ?? 'semantic layer',
      sourcePath: semanticSourcePath(model.source?.extra),
    });
    if (model.table) edges.push({ src: nodeId, dst: `dbt_model:${model.table}`, kind: 'depends_on' });
  }

  for (const query of layer.listSavedQueries()) {
    const nodeId = `saved_query:${query.name}`;
    nodes.push({
      nodeId,
      kind: 'saved_query',
      name: query.name,
      domain: query.domain,
      owner: query.owner,
      description: query.description,
      tags: query.tags ?? [],
      ...businessMetadataFromRaw(query.source?.extra?.raw),
      llmContext: [
        query.label ? `label: ${query.label}` : '',
        query.metrics.length ? `metrics: ${query.metrics.join(', ')}` : '',
        query.dimensions.length ? `dimensions: ${query.dimensions.join(', ')}` : '',
        query.timeDimension ? `time_dimension: ${query.timeDimension}` : '',
        query.granularity ? `granularity: ${query.granularity}` : '',
      ].filter(Boolean).join('\n') || undefined,
      sourceTier: 'semantic_layer',
      certification: 'ai_generated',
      provenance: query.source?.provider === 'dbt'
        ? `dbt ${query.source.objectType}`
        : query.source?.provider ?? 'semantic layer',
      sourcePath: semanticSourcePath(query.source?.extra),
    });
    for (const metric of query.metrics) edges.push({ src: nodeId, dst: `metric:${metric}`, kind: 'depends_on' });
    for (const dimension of query.dimensions) edges.push({ src: nodeId, dst: `dimension:${dimension}`, kind: 'depends_on' });
  }

  return { nodes, edges };
}

function qualifiedSemanticName(cube: string | undefined, name: string): string {
  return cube ? `${cube}.${name}` : name;
}

function semanticSourcePath(extra: Record<string, unknown> | undefined): string | undefined {
  const path = extra?.path ?? (extra?.raw && typeof extra.raw === 'object' ? (extra.raw as Record<string, unknown>).original_file_path : undefined);
  return typeof path === 'string' ? path : undefined;
}

function renderColumnsContext(columns: Record<string, { name: string; description?: string; type?: string }>): string {
  const rendered = Object.values(columns)
    .slice(0, 80)
    .map((col) => `- ${col.name}${col.type ? ` (${col.type})` : ''}${col.description ? `: ${col.description}` : ''}`)
    .join('\n');
  return rendered ? `Columns:\n${rendered}` : '';
}

function businessMetadataFromRaw(raw: unknown): Partial<KGNode> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const nested = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown>
    : {};
  const value = (camel: string, snake: string): unknown => record[camel] ?? record[snake] ?? nested[camel] ?? nested[snake];
  return {
    businessOutcome: stringValue(value('businessOutcome', 'business_outcome')),
    businessOwner: stringValue(value('businessOwner', 'business_owner')),
    decisionUse: stringValue(value('decisionUse', 'decision_use')),
    reviewCadence: stringValue(value('reviewCadence', 'review_cadence')),
    businessRules: stringArrayValue(value('businessRules', 'business_rules')),
    caveats: stringArrayValue(value('caveats', 'caveats')),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : undefined;
}
