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

/**
 * Filters applied to dbt manifest import to keep only the subgraph relevant
 * to this DQL project. Each entry is either a plain model name, `tag:<name>`,
 * or `path:<prefix>` (matched against the node's `path` / `original_file_path`).
 *
 * Semantics
 * - `anchors` extend the DQL-referenced tables set — upstream BFS will follow
 *   from these as if DQL had queried them directly.
 * - `include` (if non-empty) narrows the considered set to models matching at
 *   least one entry; upstream deps of those are still walked.
 * - `exclude` removes matching models from the final import even if they are
 *   upstream of an anchor.
 */
export interface DbtImportFilters {
  anchors?: string[];
  include?: string[];
  exclude?: string[];
}

export interface ManifestBuildOptions {
  /** Project root directory (must contain dql.config.json) */
  projectRoot: string;
  /** DQL CLI version string */
  dqlVersion?: string;
  /** Path to dbt manifest.json for import */
  dbtManifestPath?: string;
  /**
   * Max upstream hops to follow through the dbt DAG from DQL anchor tables.
   * undefined = follow all the way to raw sources (default).
   * 3 = stop 3 hops above the anchor tables.
   * Useful for very large dbt projects to limit imported node count.
   */
  maxDbtHops?: number;
  /**
   * Total model threshold above which selective import is always used.
   * Defaults to 200. Projects with fewer models import everything.
   */
  selectiveDbtThreshold?: number;
  /**
   * Selective dbt import filters. When omitted, falls back to `dbtImport` in
   * `dql.config.json`. Caller-supplied filters take precedence over config.
   */
  dbtImportFilters?: DbtImportFilters;
  /** Additional directories to scan for .dql files */
  extraBlockDirs?: string[];
  /** Additional directories to scan for .dqlnb files */
  extraNotebookDirs?: string[];
}

/**
 * Enumerate every file whose contents could change the manifest output.
 *
 * Used by the cache layer to compute a fingerprint without building. Stays in
 * sync with `buildManifest`'s scan set: blocks, notebooks, semantic YAML,
 * `dql.config.json`, and (if present) the dbt `manifest.json`.
 *
 * Returns absolute paths, sorted. Does not read file contents.
 */
export function collectInputFiles(options: ManifestBuildOptions): string[] {
  const { projectRoot } = options;
  const files = new Set<string>();

  const configPath = join(projectRoot, 'dql.config.json');
  if (existsSync(configPath)) files.add(configPath);

  const config = loadProjectConfig(projectRoot);

  const blockDirs = ['blocks', 'dashboards', 'workbooks', ...(options.extraBlockDirs ?? [])];
  for (const dir of blockDirs) {
    for (const f of scanFilesRecursive(join(projectRoot, dir), ['.dql'])) files.add(f);
  }

  const notebookDirs = ['notebooks', 'blocks', 'dashboards', 'workbooks', ...(options.extraNotebookDirs ?? [])];
  for (const dir of notebookDirs) {
    for (const f of scanFilesRecursive(join(projectRoot, dir), ['.dqlnb'])) files.add(f);
  }

  const semanticDir = resolveSemanticPath(projectRoot, config);
  if (existsSync(semanticDir)) {
    for (const f of scanFilesRecursive(semanticDir, ['.yaml', '.yml'])) files.add(f);
  }

  if (options.dbtManifestPath && existsSync(options.dbtManifestPath)) {
    files.add(options.dbtManifestPath);
  }

  return [...files].sort();
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

  // Collect all table names DQL actually references — these are the "anchors"
  // from which we walk upstream through the dbt DAG.
  const referencedTables = new Set<string>();
  for (const block of Object.values(blocks)) {
    for (const t of block.tableDependencies) referencedTables.add(t.toLowerCase());
  }
  for (const nb of Object.values(notebooks)) {
    for (const cell of nb.cells) {
      for (const t of cell.tableDependencies) referencedTables.add(t.toLowerCase());
    }
  }
  for (const m of Object.values(metrics)) referencedTables.add(m.table.toLowerCase());
  for (const d of Object.values(dimensions)) referencedTables.add(d.table.toLowerCase());

  // Import dbt manifest if provided. Filters come from options or config
  // (options win when both are present).
  let dbtImport: ManifestDbtImport | undefined;
  if (options.dbtManifestPath) {
    const filters = options.dbtImportFilters ?? config.dbtImport;
    dbtImport = importDbtManifest(options.dbtManifestPath, sources, referencedTables, {
      maxHops: options.maxDbtHops,
      selectiveThreshold: options.selectiveDbtThreshold ?? 200,
      filters,
    });
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
  /** Selective dbt import filters; merged into buildManifest options. */
  dbtImport?: DbtImportFilters;
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

interface DbtImportOptions {
  /** Max upstream hops from anchor tables. undefined = unlimited (follow to raw sources). */
  maxHops?: number;
  /** Auto-enable selective import when total model count exceeds this. Default: 200. */
  selectiveThreshold?: number;
  /** Tag/path/name filters for selective import. */
  filters?: DbtImportFilters;
}

/**
 * Lightweight index entry built from the raw dbt manifest.
 * Kept small — only the fields needed for the BFS traversal and final import.
 */
interface DbtIndexEntry {
  uniqueId: string;
  name: string;          // alias ?? name
  type: 'model' | 'source';
  schema?: string;
  database?: string;
  dependsOn: string[];   // upstream uniqueIds
  /** Normalised lookup names (name, schema.name, db.schema.name) */
  lookupKeys: string[];
  /** dbt tags (for `tag:<name>` filters) */
  tags: string[];
  /** File path relative to dbt project root (for `path:<prefix>` filters) */
  path?: string;
  raw: any;              // reference to the original manifest node
}

/** Parse a filter expression into a matcher function. */
function compileFilter(expr: string): (entry: DbtIndexEntry) => boolean {
  if (expr.startsWith('tag:')) {
    const tag = expr.slice(4);
    return (e) => e.tags.includes(tag);
  }
  if (expr.startsWith('path:')) {
    const prefix = expr.slice(5);
    return (e) => !!e.path && e.path.startsWith(prefix);
  }
  // Bare name — match against the model name (case-insensitive)
  const lower = expr.toLowerCase();
  return (e) => e.name.toLowerCase() === lower;
}

function compileFilters(exprs: string[] | undefined): ((e: DbtIndexEntry) => boolean) | null {
  if (!exprs || exprs.length === 0) return null;
  const matchers = exprs.map(compileFilter);
  return (entry) => matchers.some((m) => m(entry));
}

function importDbtManifest(
  manifestPath: string,
  sources: Record<string, ManifestSource>,
  referencedTables: Set<string>,
  opts: DbtImportOptions = {},
): ManifestDbtImport {
  const raw = readFileSync(manifestPath, 'utf-8');
  const manifest = JSON.parse(raw);
  const projectName = manifest.metadata?.project_name;

  // ── Step 1: Build a lightweight index of every model + source ──────────────
  const index = new Map<string, DbtIndexEntry>();

  const rawNodes: Record<string, any> = manifest.nodes ?? {};
  for (const [uniqueId, node] of Object.entries(rawNodes)) {
    if (node.resource_type !== 'model') continue;
    const name = (node.alias ?? node.name) as string;
    if (!name) continue;
    const schema: string | undefined = node.schema;
    const database: string | undefined = node.database;
    const dependsOn: string[] = Array.isArray(node.depends_on?.nodes) ? node.depends_on.nodes : [];
    const lookupKeys = buildLookupKeys(name, schema, database);
    const tags = Array.isArray(node.tags) ? (node.tags as string[]) : [];
    const path = (node.original_file_path ?? node.path) as string | undefined;
    index.set(uniqueId, { uniqueId, name, type: 'model', schema, database, dependsOn, lookupKeys, tags, path, raw: node });
  }

  const rawSources: Record<string, any> = manifest.sources ?? {};
  for (const [uniqueId, src] of Object.entries(rawSources)) {
    const name = (src.identifier ?? src.name) as string;
    if (!name) continue;
    const schema: string | undefined = src.schema;
    const database: string | undefined = src.database;
    const lookupKeys = buildLookupKeys(name, schema, database);
    const tags = Array.isArray(src.tags) ? (src.tags as string[]) : [];
    const path = (src.original_file_path ?? src.path) as string | undefined;
    index.set(uniqueId, { uniqueId, name, type: 'source', schema, database, dependsOn: [], lookupKeys, tags, path, raw: src });
  }

  const totalDbtModels = [...index.values()].filter((e) => e.type === 'model').length;
  const filters = opts.filters;
  const hasFilterConfig = !!(filters && (filters.anchors?.length || filters.include?.length || filters.exclude?.length));
  const useSelective = totalDbtModels > (opts.selectiveThreshold ?? 200)
    || referencedTables.size > 0
    || hasFilterConfig;

  // ── Step 2: Determine which nodes to import ────────────────────────────────
  let selectedIds: Set<string>;

  if (!useSelective) {
    // Small project: import everything (original behaviour)
    selectedIds = new Set(index.keys());
  } else {
    // Large project or explicit references: selective BFS upstream from anchors

    // Build reverse lookup: normalised name → uniqueId
    const nameToId = new Map<string, string>();
    for (const entry of index.values()) {
      for (const key of entry.lookupKeys) {
        nameToId.set(key, entry.uniqueId);
      }
    }

    // Anchors = DQL-referenced tables ∪ user-declared `dbtImport.anchors`
    const anchors = new Set<string>();
    for (const tableName of referencedTables) {
      const uid = nameToId.get(tableName);
      if (uid) anchors.add(uid);
    }
    for (const anchorExpr of filters?.anchors ?? []) {
      // anchors may be plain names, `tag:...`, or `path:...`
      if (anchorExpr.includes(':')) {
        const match = compileFilter(anchorExpr);
        for (const entry of index.values()) {
          if (match(entry)) anchors.add(entry.uniqueId);
        }
      } else {
        const uid = nameToId.get(anchorExpr.toLowerCase());
        if (uid) anchors.add(uid);
      }
    }

    // BFS upstream through depends_on edges
    selectedIds = new Set<string>(anchors);
    let frontier = [...anchors];
    let hop = 0;

    while (frontier.length > 0 && (opts.maxHops === undefined || hop < opts.maxHops)) {
      const next: string[] = [];
      for (const uid of frontier) {
        const entry = index.get(uid);
        for (const dep of entry?.dependsOn ?? []) {
          if (!selectedIds.has(dep) && index.has(dep)) {
            selectedIds.add(dep);
            next.push(dep);
          }
        }
      }
      frontier = next;
      hop++;
    }

    // Apply include/exclude filters. Include narrows the set; exclude removes
    // matching entries. Anchor nodes are always preserved even if include
    // would filter them out — they are the reason we're here.
    const includeMatch = compileFilters(filters?.include);
    const excludeMatch = compileFilters(filters?.exclude);
    if (includeMatch || excludeMatch) {
      for (const uid of [...selectedIds]) {
        if (anchors.has(uid)) continue;
        const entry = index.get(uid);
        if (!entry) continue;
        if (includeMatch && !includeMatch(entry)) selectedIds.delete(uid);
        else if (excludeMatch && excludeMatch(entry)) selectedIds.delete(uid);
      }
    }
  }

  // ── Step 3: Emit only selected nodes ──────────────────────────────────────
  let modelsImported = 0;
  let sourcesImported = 0;
  const dbtDagModels: NonNullable<ManifestDbtImport['dbtDag']>['models'] = [];
  const dbtDagEdges: NonNullable<ManifestDbtImport['dbtDag']>['edges'] = [];

  for (const uid of selectedIds) {
    const entry = index.get(uid);
    if (!entry) continue;

    if (entry.type === 'model') {
      const node = entry.raw;
      const tableName = entry.name;
      const columns = node.columns
        ? Object.values(node.columns as Record<string, any>).map((v: any) => ({
            name: v.name,
            description: v.description,
            type: v.data_type,
          }))
        : undefined;

      if (!sources[tableName]) {
        sources[tableName] = { name: tableName, origin: 'dbt', referencedBy: [] };
      }
      sources[tableName].dbtModel = {
        uniqueId: uid,
        database: entry.database,
        schema: entry.schema,
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
      if (sources[tableName].origin === 'sql') sources[tableName].origin = 'dbt';

      // Only include edges where both endpoints are in the selected set
      const selectedDeps = entry.dependsOn.filter((dep) => selectedIds.has(dep));
      dbtDagModels.push({
        uniqueId: uid,
        name: tableName,
        type: 'model',
        dependsOn: selectedDeps,
        columns,
        schema: entry.schema,
        database: entry.database,
        materialized: node.config?.materialized,
        description: node.description,
      });
      for (const dep of selectedDeps) {
        dbtDagEdges.push({ source: dep, target: uid });
      }
      modelsImported++;

    } else {
      // source
      const src = entry.raw;
      const tableName = entry.name;
      if (!sources[tableName]) {
        sources[tableName] = { name: tableName, origin: 'dbt', referencedBy: [] };
      }
      sources[tableName].dbtModel = {
        uniqueId: uid,
        database: entry.database,
        schema: entry.schema,
        description: src.description,
      };
      dbtDagModels.push({
        uniqueId: uid,
        name: tableName,
        type: 'source',
        dependsOn: [],
        schema: entry.schema,
        database: entry.database,
        description: src.description,
      });
      sourcesImported++;
    }
  }

  return {
    manifestPath,
    projectName,
    modelsImported,
    sourcesImported,
    totalDbtModels,
    selective: useSelective,
    maxHops: opts.maxHops,
    importedAt: new Date().toISOString(),
    dbtDag: { models: dbtDagModels, edges: dbtDagEdges },
  };
}

/** Build all normalised lookup keys for a dbt node name. */
function buildLookupKeys(name: string, schema?: string, database?: string): string[] {
  const keys = [name.toLowerCase()];
  if (schema) keys.push(`${schema}.${name}`.toLowerCase());
  if (schema && database) keys.push(`${database}.${schema}.${name}`.toLowerCase());
  return keys;
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
    filePath: b.filePath,
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

  // Pre-build a map of table name → block names that query that table.
  // Used to resolve "which blocks feed into a notebook" when a notebook
  // references a table directly rather than via ref().
  const tableToBlocks = new Map<string, string[]>();
  for (const block of Object.values(blocks)) {
    for (const table of block.tableDependencies) {
      const key = table.toLowerCase();
      if (!tableToBlocks.has(key)) tableToBlocks.set(key, []);
      tableToBlocks.get(key)!.push(block.name);
    }
  }

  const dashboards: LineageDashboardInput[] = Object.values(notebooks ?? {}).map((notebook) => {
    // Blocks declared inline inside this notebook (DQL cells with block declarations)
    const inlineBlockNames = notebook.cells
      .map((cell) => cell.blockName)
      .filter((name): name is string => Boolean(name));
    const inlineBlockSet = new Set(inlineBlockNames);

    // Blocks explicitly ref()-ed from notebook SQL cells
    const refDeps = new Set<string>();
    for (const cell of notebook.cells) {
      for (const ref of cell.refDependencies ?? []) {
        if (!inlineBlockSet.has(ref) && blocks[ref]) refDeps.add(ref);
      }
    }

    // Blocks whose output tables are directly queried by this notebook's SQL cells.
    // e.g. a notebook queries fct_orders and there is a block "Monthly Revenue" that
    // also queries fct_orders — link them so the flow is block → dashboard not
    // dbt_model → dashboard.
    const tableMatchedBlocks = new Set<string>();
    for (const cell of notebook.cells) {
      if (cell.blockName) continue; // skip block-declaring cells (already handled above)
      for (const table of cell.tableDependencies ?? []) {
        for (const blockName of tableToBlocks.get(table.toLowerCase()) ?? []) {
          if (!inlineBlockSet.has(blockName)) tableMatchedBlocks.add(blockName);
        }
      }
    }

    // Combine: inline declarations + explicit refs + table-matched standalone blocks
    const allBlocks = [...inlineBlockNames, ...refDeps, ...tableMatchedBlocks];

    return {
      name: notebook.title,
      filePath: notebook.filePath,
      blocks: allBlocks,
      charts: notebook.cells
        .filter((cell) => cell.chartType && cell.blockName)
        .map((cell) => cell.blockName!)
        .filter(Boolean),
      refDependencies: [],       // already merged into blocks above
      tableDependencies: [],     // intentionally empty — no dbt_model → dashboard shortcuts
    };
  });

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
      layer: n.layer,
      domain: n.domain,
      owner: n.owner,
      status: n.status,
      filePath: blocks[n.name]?.filePath ?? n.metadata?.filePath,
      columns: n.columns,
      metadata: n.metadata,
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
