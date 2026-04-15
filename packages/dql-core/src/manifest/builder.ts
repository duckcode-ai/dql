/**
 * Manifest Builder — scans a DQL project and produces a DQLManifest.
 *
 * This is the core compilation step: discovers all blocks, notebooks,
 * semantic layer definitions, extracts dependencies, builds lineage,
 * and optionally imports dbt manifest data.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { Parser } from '../parser/index.js';
import { extractTablesFromSql } from '../lineage/sql-parser.js';
import { buildLineageGraph } from '../lineage/builder.js';
import { detectDomainFlows, getDomainTrustOverview } from '../lineage/domain-lineage.js';
import { loadSemanticLayerFromDir } from '../semantic/index.js';
import type {
  LineageBlockInput,
  LineageMetricInput,
  LineageDimensionInput,
  LineageDbtModelInput,
  LineageDashboardInput,
} from '../lineage/builder.js';
import type {
  DQLManifest,
  ManifestBlock,
  ManifestNotebook,
  ManifestNotebookCell,
  ManifestMetric,
  ManifestDimension,
  ManifestSource,
  ManifestLineage,
  ManifestDbtImport,
} from './types.js';

// ---- Public API ----

export interface ManifestBuildOptions {
  /** Project root directory (must contain dql.config.json) */
  projectRoot: string;
  /** DQL CLI version string */
  dqlVersion?: string;
  /** Path to dbt manifest.json for import */
  dbtManifestPath?: string;
  /** Additional directories to scan for .dql files */
  extraBlockDirs?: string[];
  /** Additional directories to scan for .dqlnb files */
  extraNotebookDirs?: string[];
}

export function buildManifest(options: ManifestBuildOptions): DQLManifest {
  const { projectRoot, dqlVersion = '0.6.0' } = options;

  // Load project config
  const config = loadProjectConfig(projectRoot);
  const projectName = config.project ?? 'dql-project';

  // Scan blocks
  const blockDirs = ['blocks', 'dashboards', 'workbooks', ...(options.extraBlockDirs ?? [])];
  const blocks = scanBlocks(projectRoot, blockDirs);

  // Scan notebooks
  const notebookDirs = ['notebooks', 'blocks', 'dashboards', 'workbooks', ...(options.extraNotebookDirs ?? [])];
  const notebooks = scanNotebooks(projectRoot, notebookDirs);

  // Extract blocks declared inside notebook DQL cells
  const notebookBlocks = extractNotebookBlocks(notebooks, projectRoot);
  for (const [name, block] of Object.entries(notebookBlocks)) {
    if (!blocks[name]) blocks[name] = block;
  }

  // Load semantic layer
  const semanticDir = resolveSemanticPath(projectRoot, config);
  const { metrics, dimensions } = loadSemanticDefinitions(projectRoot, semanticDir);

  // Collect all source tables
  const sources = collectSources(blocks, notebooks, metrics, dimensions);

  // Import dbt manifest if provided
  let dbtImport: ManifestDbtImport | undefined;
  if (options.dbtManifestPath) {
    dbtImport = importDbtManifest(options.dbtManifestPath, sources);
  }

  // Build lineage
  const lineage = buildManifestLineage(blocks, metrics, dimensions, notebooks, dbtImport);

  return {
    manifestVersion: 2,
    dqlVersion,
    generatedAt: new Date().toISOString(),
    project: projectName,
    projectRoot,
    blocks,
    notebooks,
    metrics,
    dimensions,
    sources,
    lineage,
    dbtImport,
  };
}

// ---- Project Config ----

interface ProjectConfig {
  project?: string;
  semanticLayer?: { provider?: string; path?: string; projectPath?: string };
  dataDir?: string;
}

function loadProjectConfig(projectRoot: string): ProjectConfig {
  const configPath = join(projectRoot, 'dql.config.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

function resolveSemanticPath(projectRoot: string, config: ProjectConfig): string {
  const customPath = config.semanticLayer?.path;
  if (customPath) return join(projectRoot, customPath);
  return join(projectRoot, 'semantic-layer');
}

// ---- Recursive File Scanner ----

function scanFilesRecursive(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden dirs and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      results.push(...scanFilesRecursive(fullPath, extensions));
    } else if (entry.isFile() && extensions.includes(extname(entry.name))) {
      results.push(fullPath);
    }
  }
  return results;
}

// ---- Block Scanning ----

function scanBlocks(projectRoot: string, dirs: string[]): Record<string, ManifestBlock> {
  const blocks: Record<string, ManifestBlock> = {};

  for (const dir of dirs) {
    const dirPath = join(projectRoot, dir);
    const files = scanFilesRecursive(dirPath, ['.dql']);

    for (const filePath of files) {
      try {
        const source = readFileSync(filePath, 'utf-8');
        const relPath = relative(projectRoot, filePath);
        const parser = new Parser(source, relPath);
        const ast = parser.parse();

        for (const stmt of ast.statements) {
          const block = stmt as any;
          if (block.kind !== 'BlockDecl') continue;

          const sql = block.query?.rawSQL ?? '';
          const parseResult = extractTablesFromSql(sql);
          const domain = extractProp(block, 'domain');
          const owner = extractProp(block, 'owner');
          const description = extractProp(block, 'description');
          const tags = extractTags(block);
          const tests = extractTests(block);

          blocks[block.name] = {
            name: block.name,
            filePath: relPath,
            domain,
            owner,
            status: extractProp(block, 'status'),
            blockType: block.blockType,
            sql,
            rawTableRefs: parseResult.tables,
            tableDependencies: parseResult.tables.map(normalizeTableName),
            refDependencies: parseResult.refs,
            metricRefs: parseResult.metricRefs,
            dimensionRefs: parseResult.dimensionRefs,
            allDependencies: [
              ...parseResult.refs,
              ...parseResult.tables.map(normalizeTableName),
              ...parseResult.metricRefs.map((m) => `@metric(${m})`),
              ...parseResult.dimensionRefs.map((d) => `@dim(${d})`),
            ],
            chartType: extractVisualizationChart(block),
            metricRef: block.metricRef,
            tests,
            tags,
            description,
          };
        }
      } catch {
        // Skip unparseable files
      }
    }
  }

  return blocks;
}

// ---- Notebook Scanning ----

function scanNotebooks(projectRoot: string, dirs: string[]): Record<string, ManifestNotebook> {
  const notebooks: Record<string, ManifestNotebook> = {};
  const seen = new Set<string>();

  for (const dir of dirs) {
    const dirPath = join(projectRoot, dir);
    const files = scanFilesRecursive(dirPath, ['.dqlnb']);

    for (const filePath of files) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);

      try {
        const raw = readFileSync(filePath, 'utf-8');
        const relPath = relative(projectRoot, filePath);
        const doc = JSON.parse(raw);

        if (doc.version !== 1 || !Array.isArray(doc.cells)) continue;

        const cells: ManifestNotebookCell[] = [];

        for (const cell of doc.cells) {
          const type = cell.type;
          if (type !== 'sql' && type !== 'dql') continue;

          const source = cell.source ?? cell.content ?? '';
          if (!source.trim()) continue;

          let sqlToAnalyze = source;
          let blockName: string | undefined;

          // For DQL cells, try to extract the block's SQL
          if (type === 'dql') {
            try {
              const parser = new Parser(source, `${relPath}:${cell.id}`);
              const ast = parser.parse();
              for (const stmt of ast.statements) {
                if ((stmt as any).kind === 'BlockDecl') {
                  blockName = (stmt as any).name;
                  sqlToAnalyze = (stmt as any).query?.rawSQL ?? source;
                  break;
                }
              }
            } catch {
              // Fall back to analyzing the raw source as SQL
            }
          }

          const parseResult = extractTablesFromSql(sqlToAnalyze);

          // Find if any chart cell references this cell
          const chartCell = doc.cells.find(
            (c: any) => c.type === 'chart' && c.config?.sourceCellId === cell.id,
          );

          cells.push({
            id: cell.id ?? `cell-${cells.length}`,
            type,
            title: cell.title ?? cell.name,
            source,
            tableDependencies: parseResult.tables.map(normalizeTableName),
            refDependencies: parseResult.refs,
            blockName,
            chartType: chartCell?.config?.chart,
          });
        }

        if (cells.length > 0) {
          notebooks[relPath] = {
            title: doc.metadata?.title ?? doc.title ?? relPath,
            filePath: relPath,
            cells,
          };
        }
      } catch {
        // Skip invalid notebooks
      }
    }
  }

  return notebooks;
}

/** Extract blocks declared inside notebook DQL cells into the blocks map. */
function extractNotebookBlocks(
  notebooks: Record<string, ManifestNotebook>,
  projectRoot: string,
): Record<string, ManifestBlock> {
  const blocks: Record<string, ManifestBlock> = {};

  for (const [nbPath, nb] of Object.entries(notebooks)) {
    for (const cell of nb.cells) {
      if (cell.type !== 'dql' || !cell.blockName) continue;

      // Only add if not already found as a standalone block file
      if (!blocks[cell.blockName]) {
        const parseResult = extractTablesFromSql(cell.source);
        blocks[cell.blockName] = {
          name: cell.blockName,
          filePath: `${nbPath}#${cell.id}`,
          sql: cell.source,
          rawTableRefs: parseResult.tables,
          tableDependencies: parseResult.tables.map(normalizeTableName),
          refDependencies: parseResult.refs,
          allDependencies: [...parseResult.refs, ...parseResult.tables.map(normalizeTableName)],
          tests: [],
        };
      }
    }
  }

  return blocks;
}

// ---- Semantic Layer ----

function loadSemanticDefinitions(
  projectRoot: string,
  semanticDir: string,
): { metrics: Record<string, ManifestMetric>; dimensions: Record<string, ManifestDimension> } {
  const metrics: Record<string, ManifestMetric> = {};
  const dimensions: Record<string, ManifestDimension> = {};

  if (!existsSync(semanticDir)) return { metrics, dimensions };

  try {
    const layer = loadSemanticLayerFromDir(semanticDir);

    for (const m of layer.listMetrics()) {
      metrics[m.name] = {
        name: m.name,
        type: m.type,
        table: m.table,
        domain: m.domain,
        description: m.description,
        sql: m.sql,
      };
    }

    for (const d of layer.listDimensions()) {
      dimensions[d.name] = {
        name: d.name,
        table: d.table,
        type: d.type,
        description: d.description,
      };
    }

    // Try to find file paths for metrics and dimensions
    const metricFiles = scanFilesRecursive(join(semanticDir, 'metrics'), ['.yaml', '.yml']);
    for (const f of metricFiles) {
      try {
        const content = JSON.parse(JSON.stringify(
          // Simple YAML-like parse for name field
          Object.fromEntries(
            readFileSync(f, 'utf-8')
              .split('\n')
              .filter((l) => l.includes(':') && !l.startsWith('#'))
              .map((l) => {
                const [k, ...v] = l.split(':');
                return [k.trim(), v.join(':').trim()];
              }),
          ),
        ));
        if (content.name && metrics[content.name]) {
          metrics[content.name].filePath = relative(projectRoot, f);
        }
      } catch { /* skip */ }
    }
  } catch {
    // Non-fatal — semantic layer may not exist or be misconfigured
  }

  return { metrics, dimensions };
}

// ---- Source Collection ----

function collectSources(
  blocks: Record<string, ManifestBlock>,
  notebooks: Record<string, ManifestNotebook>,
  metrics: Record<string, ManifestMetric>,
  dimensions: Record<string, ManifestDimension>,
): Record<string, ManifestSource> {
  const sources: Record<string, ManifestSource> = {};

  function ensureSource(name: string, origin: 'sql' | 'semantic', rawRef?: string): ManifestSource {
    if (!sources[name]) {
      sources[name] = { name, origin, rawRef, referencedBy: [] };
    }
    return sources[name];
  }

  // From blocks
  for (const block of Object.values(blocks)) {
    for (let i = 0; i < block.tableDependencies.length; i++) {
      const tableName = block.tableDependencies[i];
      // Skip if it's actually a ref to another block
      if (blocks[tableName]) continue;
      const source = ensureSource(tableName, 'sql', block.rawTableRefs[i]);
      source.referencedBy.push(`block:${block.name}`);
    }
  }

  // From notebooks
  for (const nb of Object.values(notebooks)) {
    for (const cell of nb.cells) {
      for (const tableName of cell.tableDependencies) {
        if (blocks[tableName]) continue;
        const source = ensureSource(tableName, 'sql');
        source.referencedBy.push(`notebook:${nb.filePath}#${cell.id}`);
      }
    }
  }

  // From semantic layer
  for (const metric of Object.values(metrics)) {
    const source = ensureSource(metric.table, 'semantic');
    if (!source.referencedBy.includes(`metric:${metric.name}`)) {
      source.referencedBy.push(`metric:${metric.name}`);
    }
  }
  for (const dim of Object.values(dimensions)) {
    const source = ensureSource(dim.table, 'semantic');
    if (!source.referencedBy.includes(`dimension:${dim.name}`)) {
      source.referencedBy.push(`dimension:${dim.name}`);
    }
  }

  return sources;
}

// ---- dbt Manifest Import ----

function importDbtManifest(
  manifestPath: string,
  sources: Record<string, ManifestSource>,
): ManifestDbtImport {
  const raw = readFileSync(manifestPath, 'utf-8');
  const manifest = JSON.parse(raw);

  let modelsImported = 0;
  let sourcesImported = 0;
  const projectName = manifest.metadata?.project_name;
  const dbtDagModels: NonNullable<ManifestDbtImport['dbtDag']>['models'] = [];
  const dbtDagEdges: NonNullable<ManifestDbtImport['dbtDag']>['edges'] = [];

  // Import models as source tables
  const nodes = manifest.nodes ?? {};
  for (const [uniqueId, node] of Object.entries(nodes) as [string, any][]) {
    if (node.resource_type !== 'model') continue;

    const tableName = node.alias ?? node.name;
    if (!tableName) continue;

    // Create or update source entry
    const columns = node.columns
      ? Object.values(node.columns as Record<string, any>).map((value: any) => ({
          name: value.name,
          description: value.description,
          type: value.data_type,
        }))
      : undefined;

    if (!sources[tableName]) {
      sources[tableName] = {
        name: tableName,
        origin: 'dbt',
        referencedBy: [],
      };
      sourcesImported++;
    }

    sources[tableName].dbtModel = {
      uniqueId,
      database: node.database,
      schema: node.schema,
      materializedAs: node.config?.materialized,
      description: node.description,
      columns: node.columns
        ? Object.fromEntries(
            Object.entries(node.columns as Record<string, any>).map(([k, v]: [string, any]) => [
              k,
              { name: v.name, description: v.description, type: v.data_type },
            ]),
          )
        : undefined,
    };
    if (sources[tableName].origin === 'sql') {
      sources[tableName].origin = 'dbt';
    }
    modelsImported++;
    const dependsOn = Array.isArray(node.depends_on?.nodes) ? node.depends_on.nodes : [];
    dbtDagModels.push({
      uniqueId,
      name: tableName,
      type: 'model',
      dependsOn,
      columns,
      schema: node.schema,
      database: node.database,
      materialized: node.config?.materialized,
      description: node.description,
    });
    for (const dependency of dependsOn) {
      dbtDagEdges.push({ source: dependency, target: uniqueId });
    }
  }

  // Import dbt sources
  const dbtSources = manifest.sources ?? {};
  for (const [uniqueId, src] of Object.entries(dbtSources) as [string, any][]) {
    const tableName = src.identifier ?? src.name;
    if (!tableName) continue;

    if (!sources[tableName]) {
      sources[tableName] = {
        name: tableName,
        origin: 'dbt',
        referencedBy: [],
      };
    }
    sources[tableName].dbtModel = {
      uniqueId,
      database: src.database,
      schema: src.schema,
      description: src.description,
    };
    sourcesImported++;
    dbtDagModels.push({
      uniqueId,
      name: tableName,
      type: 'source',
      dependsOn: [],
      schema: src.schema,
      database: src.database,
      description: src.description,
    });
  }

  return {
    manifestPath,
    projectName,
    modelsImported,
    sourcesImported,
    importedAt: new Date().toISOString(),
    dbtDag: {
      models: dbtDagModels,
      edges: dbtDagEdges,
    },
  };
}

// ---- Lineage Builder ----

function buildManifestLineage(
  blocks: Record<string, ManifestBlock>,
  metrics: Record<string, ManifestMetric>,
  dimensions: Record<string, ManifestDimension>,
  notebooks?: Record<string, ManifestNotebook>,
  dbtImport?: ManifestDbtImport,
): ManifestLineage {
  // Convert to lineage builder input format
  const lineageBlocks: LineageBlockInput[] = Object.values(blocks).map((b) => ({
    name: b.name,
    sql: b.sql,
    domain: b.domain,
    owner: b.owner,
    status: b.status as any,
    blockType: b.blockType,
    metricRef: b.metricRef,
    chartType: b.chartType,
  }));

  const lineageMetrics: LineageMetricInput[] = Object.values(metrics).map((m) => ({
    name: m.name,
    table: m.table,
    domain: m.domain ?? '',
    type: m.type,
  }));

  const lineageDimensions: LineageDimensionInput[] = Object.values(dimensions).map((d) => ({
    name: d.name,
    table: d.table,
  }));

  const dashboards: LineageDashboardInput[] = Object.values(notebooks ?? {}).map((notebook) => ({
    name: notebook.title,
    blocks: notebook.cells
      .map((cell) => cell.blockName)
      .filter((name): name is string => Boolean(name)),
    charts: notebook.cells
      .filter((cell) => cell.chartType && cell.blockName)
      .map((cell) => cell.blockName!)
      .filter(Boolean),
  }));

  const dbtModels: LineageDbtModelInput[] = (dbtImport?.dbtDag?.models ?? []).map((model) => ({
    name: model.name,
    uniqueId: model.uniqueId,
    type: model.type,
    dependsOn: model.dependsOn,
    columns: model.columns,
    schema: model.schema,
    database: model.database,
    materialized: model.materialized,
    description: model.description,
  }));

  const graph = buildLineageGraph(lineageBlocks, lineageMetrics, lineageDimensions, {
    dbtModels,
    dashboards,
  });

  // Serialize to manifest format
  const graphJson = graph.toJSON();
  const domains = graph.getDomains();
  const flows = detectDomainFlows(graph);

  const domainTrust: Record<string, { total: number; certified: number; score: number }> = {};
  for (const domain of domains) {
    const overview = getDomainTrustOverview(graph, domain);
    domainTrust[domain] = {
      total: overview.totalBlocks,
      certified: overview.certified,
      score: overview.trustScore,
    };
  }

  return {
    nodes: graphJson.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      name: n.name,
      domain: n.domain,
      owner: n.owner,
      status: n.status,
      filePath: blocks[n.name]?.filePath,
      columns: n.columns,
    })),
    edges: graphJson.edges.map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
      sourceDomain: e.sourceDomain,
      targetDomain: e.targetDomain,
    })),
    domains,
    crossDomainFlows: flows.map((f) => ({
      from: f.from,
      to: f.to,
      edgeCount: f.edges.length,
    })),
    domainTrust,
  };
}

// ---- AST Helpers ----

function extractProp(block: any, propName: string): string | undefined {
  if (block[propName] !== undefined && block[propName] !== null) {
    return String(block[propName]);
  }
  if (!block.properties) return undefined;
  for (const prop of block.properties) {
    if (prop.key === propName && prop.value?.kind === 'Literal') {
      return String(prop.value.value);
    }
  }
  return undefined;
}

function extractVisualizationChart(block: any): string | undefined {
  if (!block.visualization) return undefined;
  for (const prop of block.visualization.properties ?? []) {
    if (prop.key === 'chart' && prop.value?.kind === 'Literal') {
      return String(prop.value.value);
    }
  }
  return undefined;
}

function extractTags(block: any): string[] | undefined {
  if (Array.isArray(block.tags)) return block.tags;
  if (!block.properties) return undefined;
  for (const prop of block.properties) {
    if (prop.key === 'tags' && prop.value?.kind === 'ArrayLiteral') {
      return prop.value.elements
        ?.map((e: any) => (e.kind === 'Literal' ? String(e.value) : null))
        .filter(Boolean);
    }
  }
  return undefined;
}

function extractTests(block: any): string[] {
  if (!block.tests?.assertions) return [];
  return block.tests.assertions.map((a: any) => {
    if (typeof a === 'string') return a;
    return `${a.field ?? ''} ${a.operator ?? ''} ${a.expected ?? ''}`.trim();
  });
}

/**
 * Normalize DuckDB reader function calls to plain table names.
 * e.g., "read_csv_auto('./data/revenue.csv')" → "revenue"
 */
function normalizeTableName(name: string): string {
  const readerMatch = name.match(
    /^(?:read_csv_auto|read_csv|read_parquet|read_json|read_json_auto)\s*\(\s*['"]([^'"]+)['"]\s*\)$/i,
  );
  if (readerMatch) {
    const path = readerMatch[1];
    const filename = path.split('/').pop() ?? path;
    return filename.replace(/\.(csv|parquet|json)$/i, '');
  }
  return name;
}
