import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  CubejsProvider,
  DbtProvider,
  SnowflakeSemanticProvider,
  type CubeDefinition,
  type DimensionDefinition,
  type HierarchyDefinition,
  type MetricDefinition,
  type PreAggregationDefinition,
  type SegmentDefinition,
  type SemanticLayer,
  type SemanticLayerProviderConfig,
  type SemanticSourceMetadata,
  type SnowflakeQueryExecutor,
  resolveRepoSource,
} from '@duckcodeailabs/dql-core';

export interface SemanticImportManifestObject {
  id: string;
  kind: 'cube' | 'metric' | 'dimension' | 'hierarchy' | 'segment' | 'pre_aggregation';
  name: string;
  label: string;
  domain: string;
  cube?: string;
  filePath: string;
  source?: SemanticSourceMetadata;
}

export interface SemanticImportManifest {
  version: 1;
  mode: 'imported';
  provider: 'dbt' | 'cubejs' | 'snowflake';
  importedAt: string;
  source: {
    projectPath?: string;
    repoUrl?: string;
    branch?: string;
    subPath?: string;
    connection?: string;
  };
  warnings: string[];
  generatedFiles: string[];
  objects: SemanticImportManifestObject[];
}

export interface SemanticImportResult {
  manifest: SemanticImportManifest;
  counts: Record<SemanticImportManifestObject['kind'], number>;
}

export interface SemanticTreeNode {
  id: string;
  label: string;
  kind: 'provider' | 'domain' | 'cube' | 'group' | SemanticImportManifestObject['kind'];
  count?: number;
  meta?: Record<string, string | number | boolean | null | undefined>;
  children?: SemanticTreeNode[];
}

export interface SemanticObjectDetail {
  id: string;
  kind: SemanticImportManifestObject['kind'];
  name: string;
  label: string;
  description: string;
  domain: string;
  cube?: string;
  table?: string;
  sql?: string;
  type?: string;
  tags: string[];
  owner: string | null;
  source: SemanticSourceMetadata | null;
  filePath: string | null;
  importedAt: string | null;
  joins?: CubeDefinition['joins'];
  levels?: HierarchyDefinition['levels'];
  measures?: string[];
  dimensions?: string[];
  timeDimension?: string;
  granularity?: string;
  refreshKey?: string;
}

const MANIFEST_RELATIVE_PATH = 'semantic-layer/imports/manifest.json';

export async function performSemanticImport(opts: {
  targetProjectRoot: string;
  provider: 'dbt' | 'cubejs' | 'snowflake';
  sourceConfig: SemanticLayerProviderConfig;
  executeQuery?: SnowflakeQueryExecutor;
}): Promise<SemanticImportResult> {
  const targetProjectRoot = resolve(opts.targetProjectRoot);
  const previousManifest = loadSemanticImportManifest(targetProjectRoot);
  const previousManaged = new Set(previousManifest?.generatedFiles ?? []);

  const source = resolveImportSource(opts.targetProjectRoot, opts.sourceConfig);
  const layer = await loadLayerForImport(opts.provider, source.localPath, source.config, opts.executeQuery);
  const warnings = [...source.warnings, ...collectImportWarnings(opts.provider, layer)];
  const objects = collectObjects(layer);

  const generatedFiles: string[] = [];
  const manifestObjects: SemanticImportManifestObject[] = [];

  for (const relPath of previousManaged) {
    const absPath = join(targetProjectRoot, relPath);
    if (existsSync(absPath)) {
      rmSync(absPath, { force: true });
    }
  }

  for (const object of objects) {
    const normalizedDomain = normalizeDomain(object.domain);
    const filePath = buildSemanticFilePath(object.kind, normalizedDomain, object.name);
    const absPath = join(targetProjectRoot, filePath);
    if (existsSync(absPath) && !previousManaged.has(filePath)) {
      throw new Error(`Import conflict: ${filePath} already exists and is not managed by semantic import.`);
    }
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, serializeSemanticObject(object), 'utf-8');
    generatedFiles.push(filePath);
    manifestObjects.push({
      id: objectId(object.kind, object.name),
      kind: object.kind,
      name: object.name,
      label: object.label,
      domain: normalizedDomain,
      cube: 'cube' in object ? object.cube : undefined,
      filePath,
      source: object.source,
    });
  }

  const manifest: SemanticImportManifest = {
    version: 1,
    mode: 'imported',
    provider: opts.provider,
    importedAt: new Date().toISOString(),
    source: {
      projectPath: opts.sourceConfig.projectPath,
      repoUrl: opts.sourceConfig.repoUrl,
      branch: opts.sourceConfig.branch,
      subPath: opts.sourceConfig.subPath,
      connection: opts.sourceConfig.connection,
    },
    warnings,
    generatedFiles: [...generatedFiles, MANIFEST_RELATIVE_PATH],
    objects: manifestObjects,
  };

  const manifestPath = join(targetProjectRoot, MANIFEST_RELATIVE_PATH);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  applyCanonicalSemanticConfig(targetProjectRoot);

  return {
    manifest,
    counts: countObjects(manifestObjects),
  };
}

export function syncSemanticImport(opts: {
  targetProjectRoot: string;
  executeQuery?: SnowflakeQueryExecutor;
}): Promise<SemanticImportResult> {
  const manifest = loadSemanticImportManifest(opts.targetProjectRoot);
  if (!manifest) {
    throw new Error('No semantic import manifest found. Run `dql semantic import <provider>` first.');
  }
  const sourceConfig: SemanticLayerProviderConfig = {
    provider: manifest.provider,
    projectPath: manifest.source.projectPath,
    repoUrl: manifest.source.repoUrl,
    branch: manifest.source.branch,
    subPath: manifest.source.subPath,
    connection: manifest.source.connection,
  };
  return performSemanticImport({
    targetProjectRoot: opts.targetProjectRoot,
    provider: manifest.provider,
    sourceConfig,
    executeQuery: opts.executeQuery,
  });
}

export function loadSemanticImportManifest(projectRoot: string): SemanticImportManifest | null {
  const manifestPath = join(resolve(projectRoot), MANIFEST_RELATIVE_PATH);
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as SemanticImportManifest;
  } catch {
    return null;
  }
}

export function buildSemanticTree(
  layer: SemanticLayer,
  manifest: SemanticImportManifest | null,
): SemanticTreeNode {
  const providerName = manifest?.provider ?? 'dql';
  const domains = layer.listDomains();
  const cubes = layer.listCubes();
  const metrics = layer.listMetrics();
  const dimensions = layer.listDimensions();
  const hierarchies = layer.listHierarchies();
  const segments = layer.listSegments();
  const preAggregations = layer.listPreAggregations();

  const domainNodes = domains.map((domain) => {
    const domainCubes = cubes.filter((cube) => cube.domain === domain);
    const looseMetrics = metrics.filter((metric) => metric.domain === domain && !metric.cube);
    const looseDimensions = dimensions.filter((dimension) => dimension.domain === domain && !dimension.cube);
    const domainHierarchies = hierarchies.filter((hierarchy) => hierarchy.domain === domain);

    const cubeNodes = domainCubes.map((cube) => ({
      id: objectId('cube', cube.name),
      label: cube.label,
      kind: 'cube' as const,
      count:
        cube.measures.length +
        cube.dimensions.length +
        cube.timeDimensions.length +
        cube.segments.length +
        cube.preAggregations.length,
      meta: {
        provider: cube.source?.provider ?? providerName,
        domain: normalizeDomain(cube.domain),
        cube: cube.name,
        owner: cube.owner ?? null,
        tags: (cube.tags ?? []).join(','),
        table: cube.table,
      },
      children: [
        buildGroupNode('metric', 'Measures', cube.measures.map((metric) => toLeaf('metric', metric.name, metric.label, {
          provider: metric.source?.provider ?? providerName,
          domain: normalizeDomain(metric.domain),
          cube: metric.cube ?? cube.name,
          owner: metric.owner ?? cube.owner ?? null,
          tags: (metric.tags ?? []).join(','),
          table: metric.table,
        }))),
        buildGroupNode('dimension', 'Dimensions', [...cube.dimensions, ...cube.timeDimensions].map((dimension) => toLeaf('dimension', dimension.name, dimension.label, {
          provider: dimension.source?.provider ?? providerName,
          domain: normalizeDomain(dimension.domain),
          cube: dimension.cube ?? cube.name,
          owner: dimension.owner ?? cube.owner ?? null,
          tags: (dimension.tags ?? []).join(','),
          table: dimension.table,
        }))),
        buildGroupNode('segment', 'Segments', cube.segments.map((segment) => toLeaf('segment', segment.name, segment.label, {
          provider: segment.source?.provider ?? providerName,
          domain: normalizeDomain(segment.domain),
          cube: segment.cube || cube.name,
          owner: segment.owner ?? cube.owner ?? null,
          tags: (segment.tags ?? []).join(','),
        }))),
        buildGroupNode('pre_aggregation', 'Pre-aggregations', cube.preAggregations.map((preAggregation) => toLeaf('pre_aggregation', preAggregation.name, preAggregation.label, {
          provider: preAggregation.source?.provider ?? providerName,
          domain: normalizeDomain(preAggregation.domain),
          cube: preAggregation.cube || cube.name,
          owner: preAggregation.owner ?? cube.owner ?? null,
          tags: (preAggregation.tags ?? []).join(','),
        }))),
      ].filter((node): node is SemanticTreeNode => Boolean(node)),
    }));

    const children: SemanticTreeNode[] = [...cubeNodes];
    const looseNodes = [
      buildGroupNode('metric', 'Metrics', looseMetrics.map((metric) => toLeaf('metric', metric.name, metric.label, {
        provider: metric.source?.provider ?? providerName,
        domain: normalizeDomain(metric.domain),
        cube: metric.cube ?? null,
        owner: metric.owner ?? null,
        tags: (metric.tags ?? []).join(','),
        table: metric.table,
      }))),
      buildGroupNode('dimension', 'Dimensions', looseDimensions.map((dimension) => toLeaf('dimension', dimension.name, dimension.label, {
        provider: dimension.source?.provider ?? providerName,
        domain: normalizeDomain(dimension.domain),
        cube: dimension.cube ?? null,
        owner: dimension.owner ?? null,
        tags: (dimension.tags ?? []).join(','),
        table: dimension.table,
      }))),
      buildGroupNode('hierarchy', 'Hierarchies', domainHierarchies.map((hierarchy) => toLeaf('hierarchy', hierarchy.name, hierarchy.label, {
        provider: hierarchy.source?.provider ?? providerName,
        domain: normalizeDomain(hierarchy.domain),
        owner: hierarchy.owner ?? null,
        tags: (hierarchy.tags ?? []).join(','),
      }))),
      buildGroupNode('segment', 'Segments', segments.filter((segment) => segment.domain === domain && !segment.cube).map((segment) => toLeaf('segment', segment.name, segment.label, {
        provider: segment.source?.provider ?? providerName,
        domain: normalizeDomain(segment.domain),
        cube: segment.cube || null,
        owner: segment.owner ?? null,
        tags: (segment.tags ?? []).join(','),
      }))),
      buildGroupNode('pre_aggregation', 'Pre-aggregations', preAggregations.filter((preAggregation) => preAggregation.domain === domain && !preAggregation.cube).map((preAggregation) => toLeaf('pre_aggregation', preAggregation.name, preAggregation.label, {
        provider: preAggregation.source?.provider ?? providerName,
        domain: normalizeDomain(preAggregation.domain),
        cube: preAggregation.cube || null,
        owner: preAggregation.owner ?? null,
        tags: (preAggregation.tags ?? []).join(','),
      }))),
    ].filter((node): node is SemanticTreeNode => Boolean(node));
    children.push(...looseNodes);

    return {
      id: `domain:${domain}`,
      label: domain,
      kind: 'domain' as const,
      count: children.reduce((sum, node) => sum + (node.count ?? 0), 0),
      meta: {
        provider: providerName,
        domain,
      },
      children,
    };
  });

  return {
    id: `provider:${manifest?.provider ?? 'dql'}`,
    label: manifest?.provider ? `${manifest.provider} import` : 'semantic layer',
    kind: 'provider',
    count: domains.length,
    meta: {
      provider: providerName,
      importedAt: manifest?.importedAt ?? null,
      warnings: manifest?.warnings.length ?? 0,
    },
    children: domainNodes,
  };
}

export function buildSemanticObjectDetail(
  layer: SemanticLayer,
  manifest: SemanticImportManifest | null,
  id: string,
): SemanticObjectDetail | null {
  const [kind, ...rest] = id.split(':');
  const name = rest.join(':');
  const manifestObject = manifest?.objects.find((object) => object.id === id) ?? null;
  const importedAt = manifest?.importedAt ?? null;

  if (kind === 'cube') {
    const cube = layer.getCube(name);
    if (!cube) return null;
    return {
      id,
      kind: 'cube',
      name: cube.name,
      label: cube.label,
      description: cube.description,
      domain: cube.domain || normalizeDomain(undefined),
      table: cube.table,
      sql: cube.sql,
      tags: cube.tags ?? [],
      owner: cube.owner ?? null,
      source: cube.source ?? manifestObject?.source ?? null,
      filePath: manifestObject?.filePath ?? null,
      importedAt,
      joins: cube.joins,
    };
  }

  if (kind === 'metric') {
    const metric = layer.getMetric(name);
    if (!metric) return null;
    return {
      id,
      kind: 'metric',
      name: metric.name,
      label: metric.label,
      description: metric.description,
      domain: normalizeDomain(metric.domain),
      cube: metric.cube,
      table: metric.table,
      sql: metric.sql,
      type: metric.type,
      tags: metric.tags ?? [],
      owner: metric.owner ?? null,
      source: metric.source ?? manifestObject?.source ?? null,
      filePath: manifestObject?.filePath ?? null,
      importedAt,
    };
  }

  if (kind === 'dimension') {
    const dimension = layer.getDimension(name);
    if (!dimension) return null;
    return {
      id,
      kind: 'dimension',
      name: dimension.name,
      label: dimension.label,
      description: dimension.description,
      domain: normalizeDomain(dimension.domain),
      cube: dimension.cube,
      table: dimension.table,
      sql: dimension.sql,
      type: dimension.type,
      tags: dimension.tags ?? [],
      owner: dimension.owner ?? null,
      source: dimension.source ?? manifestObject?.source ?? null,
      filePath: manifestObject?.filePath ?? null,
      importedAt,
    };
  }

  if (kind === 'hierarchy') {
    const hierarchy = layer.getHierarchy(name);
    if (!hierarchy) return null;
    return {
      id,
      kind: 'hierarchy',
      name: hierarchy.name,
      label: hierarchy.label,
      description: hierarchy.description,
      domain: normalizeDomain(hierarchy.domain),
      tags: hierarchy.tags ?? [],
      owner: hierarchy.owner ?? null,
      source: hierarchy.source ?? manifestObject?.source ?? null,
      filePath: manifestObject?.filePath ?? null,
      importedAt,
      levels: hierarchy.levels,
    };
  }

  if (kind === 'segment') {
    const segment = layer.getSegment(name);
    if (!segment) return null;
    return {
      id,
      kind: 'segment',
      name: segment.name,
      label: segment.label,
      description: segment.description,
      domain: normalizeDomain(segment.domain),
      cube: segment.cube,
      sql: segment.sql,
      tags: segment.tags ?? [],
      owner: segment.owner ?? null,
      source: segment.source ?? manifestObject?.source ?? null,
      filePath: manifestObject?.filePath ?? null,
      importedAt,
    };
  }

  if (kind === 'pre_aggregation') {
    const preAggregation = layer.getPreAggregation(name);
    if (!preAggregation) return null;
    return {
      id,
      kind: 'pre_aggregation',
      name: preAggregation.name,
      label: preAggregation.label,
      description: preAggregation.description,
      domain: normalizeDomain(preAggregation.domain),
      cube: preAggregation.cube,
      sql: preAggregation.sql,
      tags: preAggregation.tags ?? [],
      owner: preAggregation.owner ?? null,
      source: preAggregation.source ?? manifestObject?.source ?? null,
      filePath: manifestObject?.filePath ?? null,
      importedAt,
      measures: preAggregation.measures,
      dimensions: preAggregation.dimensions,
      timeDimension: preAggregation.timeDimension,
      granularity: preAggregation.granularity,
      refreshKey: preAggregation.refreshKey,
    };
  }

  return null;
}

function resolveImportSource(
  targetProjectRoot: string,
  sourceConfig: SemanticLayerProviderConfig,
): { localPath: string; config: SemanticLayerProviderConfig; warnings: string[] } {
  const projectRoot = resolve(targetProjectRoot);
  if (sourceConfig.provider === 'snowflake') {
    return {
      localPath: projectRoot,
      config: sourceConfig,
      warnings: [],
    };
  }

  if (sourceConfig.projectPath && !sourceConfig.repoUrl && sourceConfig.source !== 'github' && sourceConfig.source !== 'gitlab') {
    return {
      localPath: resolve(projectRoot, sourceConfig.projectPath),
      config: { ...sourceConfig, projectPath: undefined },
      warnings: [],
    };
  }

  const resolved = resolveRepoSource(sourceConfig, projectRoot);
  return {
    localPath: resolved.localPath,
    config: { ...sourceConfig, projectPath: undefined, source: 'local' },
    warnings: resolved.warnings,
  };
}

async function loadLayerForImport(
  provider: 'dbt' | 'cubejs' | 'snowflake',
  sourceRoot: string,
  config: SemanticLayerProviderConfig,
  executeQuery?: SnowflakeQueryExecutor,
): Promise<SemanticLayer> {
  if (provider === 'dbt') {
    return new DbtProvider().load({ ...config, provider }, sourceRoot);
  }
  if (provider === 'cubejs') {
    return new CubejsProvider().load({ ...config, provider }, sourceRoot);
  }
  if (!executeQuery) {
    throw new Error('Snowflake semantic import requires an active query executor.');
  }
  return new SnowflakeSemanticProvider(executeQuery).loadAsync({ ...config, provider }, sourceRoot);
}

function collectObjects(layer: SemanticLayer): Array<
  | (CubeDefinition & { kind: 'cube' })
  | (MetricDefinition & { kind: 'metric' })
  | (DimensionDefinition & { kind: 'dimension' })
  | (HierarchyDefinition & { kind: 'hierarchy' })
  | (SegmentDefinition & { kind: 'segment' })
  | (PreAggregationDefinition & { kind: 'pre_aggregation' })
> {
  return [
    ...layer.listCubes().map((cube) => ({ ...cube, kind: 'cube' as const })),
    ...layer.listMetrics().map((metric) => ({ ...metric, kind: 'metric' as const })),
    ...layer.listDimensions().map((dimension) => ({ ...dimension, kind: 'dimension' as const })),
    ...layer.listHierarchies().map((hierarchy) => ({ ...hierarchy, kind: 'hierarchy' as const })),
    ...layer.listSegments().map((segment) => ({ ...segment, kind: 'segment' as const })),
    ...layer.listPreAggregations().map((preAggregation) => ({ ...preAggregation, kind: 'pre_aggregation' as const })),
  ];
}

function buildSemanticFilePath(
  kind: SemanticImportManifestObject['kind'],
  domain: string,
  name: string,
): string {
  const folder = kind === 'pre_aggregation' ? 'pre_aggregations' : `${kind}s`.replace('hierarchys', 'hierarchies');
  return join('semantic-layer', folder, slugifyPathSegment(domain), `${slugifyPathSegment(name)}.yaml`);
}

function serializeSemanticObject(
  object:
    | (CubeDefinition & { kind: 'cube' })
    | (MetricDefinition & { kind: 'metric' })
    | (DimensionDefinition & { kind: 'dimension' })
    | (HierarchyDefinition & { kind: 'hierarchy' })
    | (SegmentDefinition & { kind: 'segment' })
    | (PreAggregationDefinition & { kind: 'pre_aggregation' }),
): string {
  const lines: string[] = [
    `name: ${yamlScalar(object.name)}`,
    `label: ${yamlScalar(object.label)}`,
    `description: ${yamlScalar(object.description)}`,
    `domain: ${yamlScalar(object.domain || normalizeDomain(undefined))}`,
  ];

  if ('table' in object && object.table) lines.push(`table: ${yamlScalar(object.table)}`);
  if ('cube' in object && object.cube) lines.push(`cube: ${yamlScalar(object.cube)}`);
  if ('sql' in object && typeof object.sql === 'string') lines.push(`sql: ${yamlBlockScalar(object.sql)}`);
  if ('type' in object && typeof object.type === 'string') lines.push(`type: ${yamlScalar(object.type)}`);
  if ('aggregation' in object && object.aggregation) lines.push(`aggregation: ${yamlScalar(object.aggregation)}`);
  if ('owner' in object && object.owner) lines.push(`owner: ${yamlScalar(object.owner)}`);
  if ('tags' in object && object.tags && object.tags.length > 0) {
    lines.push('tags:');
    for (const tag of object.tags) lines.push(`  - ${yamlScalar(tag)}`);
  }
  if (object.source) {
    lines.push('source:');
    lines.push(`  provider: ${yamlScalar(object.source.provider)}`);
    lines.push(`  objectType: ${yamlScalar(object.source.objectType)}`);
    lines.push(`  objectId: ${yamlScalar(object.source.objectId)}`);
    if (object.source.objectName) lines.push(`  objectName: ${yamlScalar(object.source.objectName)}`);
    if (object.source.importedAt) lines.push(`  importedAt: ${yamlScalar(object.source.importedAt)}`);
    if (object.source.extra && Object.keys(object.source.extra).length > 0) {
      lines.push('  extra:');
      for (const [key, value] of Object.entries(object.source.extra)) {
        lines.push(`    ${key}: ${yamlScalar(String(value))}`);
      }
    }
  }

  if (object.kind === 'hierarchy') {
    lines.push('levels:');
    for (const level of object.levels) {
      lines.push(`  - name: ${yamlScalar(level.name)}`);
      lines.push(`    label: ${yamlScalar(level.label)}`);
      lines.push(`    description: ${yamlScalar(level.description)}`);
      lines.push(`    dimension: ${yamlScalar(level.dimension)}`);
      lines.push(`    order: ${level.order}`);
    }
  }

  if (object.kind === 'cube') {
    lines.push('measures:');
    for (const measure of object.measures) {
      lines.push(`  - name: ${yamlScalar(measure.name)}`);
      lines.push(`    label: ${yamlScalar(measure.label)}`);
      lines.push(`    description: ${yamlScalar(measure.description)}`);
      lines.push(`    sql: ${yamlBlockScalar(measure.sql, 4)}`);
      lines.push(`    type: ${yamlScalar(measure.type)}`);
      if (measure.aggregation) lines.push(`    aggregation: ${yamlScalar(measure.aggregation)}`);
    }
    lines.push('dimensions:');
    for (const dimension of object.dimensions) {
      lines.push(`  - name: ${yamlScalar(dimension.name)}`);
      lines.push(`    label: ${yamlScalar(dimension.label)}`);
      lines.push(`    description: ${yamlScalar(dimension.description)}`);
      lines.push(`    sql: ${yamlBlockScalar(dimension.sql, 4)}`);
      lines.push(`    type: ${yamlScalar(dimension.type)}`);
    }
    if (object.timeDimensions.length > 0) {
      lines.push('time_dimensions:');
      for (const dimension of object.timeDimensions) {
        lines.push(`  - name: ${yamlScalar(dimension.name)}`);
        lines.push(`    label: ${yamlScalar(dimension.label)}`);
        lines.push(`    description: ${yamlScalar(dimension.description)}`);
        lines.push(`    sql: ${yamlBlockScalar(dimension.sql, 4)}`);
        lines.push('    granularities:');
        for (const granularity of dimension.granularities) {
          lines.push(`      - ${yamlScalar(granularity)}`);
        }
        if (dimension.primaryTime) lines.push('    primary_time: true');
      }
    }
    if (object.joins.length > 0) {
      lines.push('joins:');
      for (const joinDef of object.joins) {
        lines.push(`  - name: ${yamlScalar(joinDef.name)}`);
        lines.push(`    right: ${yamlScalar(joinDef.right)}`);
        lines.push(`    type: ${yamlScalar(joinDef.type)}`);
        lines.push(`    sql: ${yamlBlockScalar(joinDef.sql, 4)}`);
      }
    }
    if (object.segments.length > 0) {
      lines.push('segments:');
      for (const segment of object.segments) {
        lines.push(`  - name: ${yamlScalar(segment.name)}`);
        lines.push(`    label: ${yamlScalar(segment.label)}`);
        lines.push(`    description: ${yamlScalar(segment.description)}`);
        lines.push(`    sql: ${yamlBlockScalar(segment.sql, 4)}`);
      }
    }
    if (object.preAggregations.length > 0) {
      lines.push('pre_aggregations:');
      for (const preAggregation of object.preAggregations) {
        lines.push(`  - name: ${yamlScalar(preAggregation.name)}`);
        lines.push(`    label: ${yamlScalar(preAggregation.label)}`);
        lines.push(`    description: ${yamlScalar(preAggregation.description)}`);
        if (preAggregation.measures?.length) {
          lines.push('    measures:');
          for (const measure of preAggregation.measures) lines.push(`      - ${yamlScalar(measure)}`);
        }
        if (preAggregation.dimensions?.length) {
          lines.push('    dimensions:');
          for (const dimension of preAggregation.dimensions) lines.push(`      - ${yamlScalar(dimension)}`);
        }
        if (preAggregation.timeDimension) lines.push(`    timeDimension: ${yamlScalar(preAggregation.timeDimension)}`);
        if (preAggregation.granularity) lines.push(`    granularity: ${yamlScalar(preAggregation.granularity)}`);
        if (preAggregation.refreshKey) lines.push(`    refreshKey: ${yamlScalar(preAggregation.refreshKey)}`);
      }
    }
  }

  if (object.kind === 'pre_aggregation') {
    if (object.measures?.length) {
      lines.push('measures:');
      for (const measure of object.measures) lines.push(`  - ${yamlScalar(measure)}`);
    }
    if (object.dimensions?.length) {
      lines.push('dimensions:');
      for (const dimension of object.dimensions) lines.push(`  - ${yamlScalar(dimension)}`);
    }
    if (object.timeDimension) lines.push(`timeDimension: ${yamlScalar(object.timeDimension)}`);
    if (object.granularity) lines.push(`granularity: ${yamlScalar(object.granularity)}`);
    if (object.refreshKey) lines.push(`refreshKey: ${yamlScalar(object.refreshKey)}`);
  }

  return lines.join('\n') + '\n';
}

function applyCanonicalSemanticConfig(projectRoot: string): void {
  const configPath = join(projectRoot, 'dql.config.json');
  const raw = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    : {};
  raw.semanticLayer = {
    provider: 'dql',
    path: './semantic-layer',
  };
  writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
}

function collectImportWarnings(provider: 'dbt' | 'cubejs' | 'snowflake', layer: SemanticLayer): string[] {
  const warnings: string[] = [];
  if (provider === 'dbt') {
    if (layer.listHierarchies().length === 0) {
      warnings.push('No dbt hierarchies were imported; dbt semantic models were normalized into cubes, measures, dimensions, and joins.');
    }
  }
  if (provider === 'snowflake' && layer.listCubes().length === 0) {
    warnings.push('Snowflake semantic import returned no semantic views.');
  }
  return warnings;
}

function countObjects(objects: SemanticImportManifestObject[]): Record<SemanticImportManifestObject['kind'], number> {
  return {
    cube: objects.filter((object) => object.kind === 'cube').length,
    metric: objects.filter((object) => object.kind === 'metric').length,
    dimension: objects.filter((object) => object.kind === 'dimension').length,
    hierarchy: objects.filter((object) => object.kind === 'hierarchy').length,
    segment: objects.filter((object) => object.kind === 'segment').length,
    pre_aggregation: objects.filter((object) => object.kind === 'pre_aggregation').length,
  };
}

function normalizeDomain(domain: string | undefined): string {
  return domain && domain.trim().length > 0 ? domain.trim() : 'uncategorized';
}

function slugifyPathSegment(value: string): string {
  return normalizeDomain(value)
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^-+|-+$/g, '');
}

function objectId(kind: SemanticImportManifestObject['kind'], name: string): string {
  return `${kind}:${name}`;
}

function yamlScalar(value: string): string {
  if (/^[a-zA-Z0-9_.:/-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function yamlBlockScalar(value: string, indent: number = 2): string {
  const indentText = ' '.repeat(indent);
  if (!value.includes('\n')) return yamlScalar(value);
  return `|\n${value.split('\n').map((line) => `${indentText}${line}`).join('\n')}`;
}

function buildGroupNode(
  kind: SemanticImportManifestObject['kind'],
  label: string,
  children: SemanticTreeNode[],
): SemanticTreeNode | null {
  if (children.length === 0) return null;
  return {
    id: `group:${kind}:${label.toLowerCase()}`,
    label,
    kind: 'group',
    count: children.length,
    meta: {
      objectKind: kind,
    },
    children,
  };
}

function toLeaf(
  kind: SemanticImportManifestObject['kind'],
  name: string,
  label: string,
  meta?: SemanticTreeNode['meta'],
): SemanticTreeNode {
  return {
    id: objectId(kind, name),
    label,
    kind,
    meta,
  };
}
