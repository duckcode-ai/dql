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
import { analyze, detectTrustConflicts } from '../semantic/index.js';
import { extractTablesFromSql } from '../lineage/sql-parser.js';
import { extractColumnLineage, type ColumnLineageResult } from '../lineage/column-lineage.js';
import { detectOutputDrift } from './output-drift.js';
import { buildLineageGraph } from '../lineage/builder.js';
import { detectDomainFlows, getDomainTrustOverview } from '../lineage/domain-lineage.js';
import { loadSemanticLayerFromDir } from '../semantic/index.js';
import { DataLexContractRegistry } from '../contracts/index.js';
import type {
  LineageBlockInput,
  LineageMetricInput,
  LineageDimensionInput,
  LineageDbtModelInput,
  LineageDashboardInput,
  LineageAppInput,
  LineageBusinessViewInput,
  LineageDomainInput,
  LineageTermInput,
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
  ManifestDiagnostic,
  ManifestApp,
  ManifestDashboard,
  ManifestBusinessView,
  ManifestDomain,
  ManifestTerm,
} from './types.js';
import {
  loadAppDocument,
  findAppDocuments,
  findDashboardsForApp,
  loadDashboardDocument,
  extractDashboardBlockRefs,
  appFolderRelPath,
  type AppDocument,
  type DashboardDocument,
} from '../apps/index.js';

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
  /** Path to a DataLex manifest JSON for optional datalex_contract validation */
  datalexManifestPath?: string;
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
  const datalexManifestPath = resolveDataLexManifestPath(projectRoot, options.datalexManifestPath, config);
  if (datalexManifestPath && existsSync(datalexManifestPath)) {
    files.add(datalexManifestPath);
  }

  const blockDirs = ['blocks', 'domains', 'dashboards', 'workbooks', ...(options.extraBlockDirs ?? [])];
  for (const dir of blockDirs) {
    for (const f of scanFilesRecursive(join(projectRoot, dir), ['.dql'])) files.add(f);
  }

  const businessViewDirs = ['blocks', 'business-views', 'domains', 'dashboards', 'workbooks', ...(options.extraBlockDirs ?? [])];
  for (const dir of businessViewDirs) {
    for (const f of scanFilesRecursive(join(projectRoot, dir), ['.dql'])) files.add(f);
  }

  const termDirs = ['terms', 'blocks', 'business-views', 'domains', 'dashboards', 'workbooks', ...(options.extraBlockDirs ?? [])];
  for (const dir of termDirs) {
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

  // Apps & dashboards. Manifests live at apps/<id>/dql.app.json; dashboards
  // live under apps/<id>/dashboards/*.dqld.
  for (const appJson of findAppDocuments(projectRoot)) {
    files.add(appJson);
    const appDir = appJson.slice(0, -'/dql.app.json'.length);
    for (const dqld of findDashboardsForApp(appDir)) files.add(dqld);
  }

  return [...files].sort();
}

export function buildManifest(options: ManifestBuildOptions): DQLManifest {
  const { projectRoot, dqlVersion = '0.6.0' } = options;

  const diagnostics: ManifestDiagnostic[] = [];

  // Load project config
  const config = loadProjectConfig(projectRoot);
  const projectName = config.project ?? 'dql-project';
  const datalexManifestPath = resolveDataLexManifestPath(projectRoot, options.datalexManifestPath, config);
  const datalexRegistry = datalexManifestPath
    ? new DataLexContractRegistry({ manifestPath: datalexManifestPath })
    : undefined;
  for (const message of datalexRegistry?.loadDiagnostics() ?? []) {
    diagnostics.push({
      kind: 'config',
      filePath: datalexManifestPath ? relative(projectRoot, datalexManifestPath) : undefined,
      severity: 'warning',
      message,
    });
  }

  // Scan first-class business domains
  const domainDirs = ['domains', 'blocks', 'terms', 'business-views', ...(options.extraBlockDirs ?? [])];
  const domains = scanDomains(projectRoot, domainDirs, diagnostics);

  // Scan blocks
  const blockDirs = ['blocks', 'domains', 'dashboards', 'workbooks', ...(options.extraBlockDirs ?? [])];
  const blocks = scanBlocks(projectRoot, blockDirs, diagnostics, datalexRegistry);

  // Scan business composition views
  const businessViewDirs = ['blocks', 'business-views', 'domains', 'dashboards', 'workbooks', ...(options.extraBlockDirs ?? [])];
  const businessViews = scanBusinessViews(projectRoot, businessViewDirs, diagnostics);

  // Scan business glossary terms
  const termDirs = ['terms', 'blocks', 'business-views', 'domains', 'dashboards', 'workbooks', ...(options.extraBlockDirs ?? [])];
  const terms = scanTerms(projectRoot, termDirs, diagnostics);

  // Scan notebooks
  const notebookDirs = ['notebooks', 'blocks', 'dashboards', 'workbooks', ...(options.extraNotebookDirs ?? [])];
  const notebooks = scanNotebooks(projectRoot, notebookDirs, diagnostics, datalexRegistry);

  // Extract blocks declared inside notebook DQL cells
  const notebookBlocks = extractNotebookBlocks(notebooks);
  for (const [name, block] of Object.entries(notebookBlocks)) {
    if (!blocks[name]) blocks[name] = block;
  }
  const notebookTerms = extractNotebookTerms(notebooks);
  for (const [name, term] of Object.entries(notebookTerms)) {
    if (!terms[name]) terms[name] = term;
  }

  validateDomains(domains, blocks, businessViews, terms, diagnostics);
  validateBusinessViews(businessViews, blocks, diagnostics);
  validateTermRefs(terms, blocks, businessViews, diagnostics);

  // Cross-artifact trust-conflict detection: two certified terms / blocks that
  // claim the same concept/grain but disagree. Additive `kind: 'conflict'`
  // diagnostics; conservative heuristics avoid false positives.
  diagnostics.push(...detectTrustConflicts(terms, blocks));

  // Output-contract drift detection: a parent block `ref()`s a child and
  // references a column the child no longer outputs. Additive `kind: 'drift'`
  // warnings — never fails the build; freeform composition stays unrestricted.
  diagnostics.push(...detectOutputDrift(blocks));

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

  // Apps & dashboards (consumption layer). Scanned after blocks/notebooks
  // because dashboard refs are resolved against the block path → name map.
  const { apps, dashboards } = scanAppsAndDashboards(projectRoot, blocks, diagnostics);

  // Build lineage
  const lineage = buildManifestLineage(
    domains,
    blocks,
    metrics,
    dimensions,
    notebooks,
    dbtImport,
    apps,
    dashboards,
    businessViews,
    terms,
  );

  return {
    manifestVersion: 2,
    dqlVersion,
    generatedAt: new Date().toISOString(),
    project: projectName,
    projectRoot,
    domains,
    blocks,
    businessViews,
    terms,
    notebooks,
    metrics,
    dimensions,
    sources,
    apps: Object.keys(apps).length > 0 ? apps : undefined,
    dashboards: Object.keys(dashboards).length > 0 ? dashboards : undefined,
    lineage,
    dbtImport,
    diagnostics,
  };
}

// ---- Project Config ----

interface ProjectConfig {
  project?: string;
  semanticLayer?: { provider?: string; path?: string; projectPath?: string };
  dataDir?: string;
  /** Selective dbt import filters; merged into buildManifest options. */
  dbtImport?: DbtImportFilters;
  /**
   * dbt integration — so commands can default to the right manifest path
   * without the user re-typing `--dbt-manifest` on every invocation.
   */
  dbt?: {
    /** Path to the dbt project root (absolute, or relative to projectRoot) */
    projectDir?: string;
    /** Path to the dbt manifest.json, relative to `projectDir`. Default: target/manifest.json */
    manifestPath?: string;
  };
  /** Optional interop path to a DataLex compiler manifest. DQL itself does not require DataLex. */
  datalex?: {
    /** Path to datalex-manifest.json, absolute or relative to projectRoot */
    manifestPath?: string;
  };
}

/**
 * Load `dql.config.json`. Exposed so CLI commands can read the same config
 * the manifest builder uses — no need for each command to re-implement parse.
 */
export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const configPath = join(projectRoot, 'dql.config.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Resolve the absolute path to the configured dbt manifest.json (if any).
 * Honors explicit CLI flag first, then `dbt.projectDir + dbt.manifestPath` from
 * config, then the conventional `target/manifest.json` inside the project root.
 * Returns `null` if none of those exist.
 */
export function resolveDbtManifestPath(
  projectRoot: string,
  explicit?: string,
): string | null {
  if (explicit) {
    return isAbsPath(explicit) ? explicit : join(projectRoot, explicit);
  }
  const config = loadProjectConfig(projectRoot);
  if (config.dbt?.projectDir) {
    const dbtRoot = isAbsPath(config.dbt.projectDir)
      ? config.dbt.projectDir
      : join(projectRoot, config.dbt.projectDir);
    const rel = config.dbt.manifestPath ?? 'target/manifest.json';
    const abs = isAbsPath(rel) ? rel : join(dbtRoot, rel);
    if (existsSync(abs)) return abs;
  }
  const fallback = join(projectRoot, 'target', 'manifest.json');
  if (existsSync(fallback)) return fallback;
  return null;
}

/**
 * Resolve the absolute path to the configured DataLex manifest.
 * Honors explicit CLI flag first, then `datalex.manifestPath` from config,
 * then `<projectRoot>/datalex-manifest.json`.
 */
export function resolveDataLexManifestPath(
  projectRoot: string,
  explicit?: string,
  loadedConfig?: ProjectConfig,
): string | null {
  if (explicit) {
    const abs = isAbsPath(explicit) ? explicit : join(projectRoot, explicit);
    return existsSync(abs) ? abs : abs;
  }
  const config = loadedConfig ?? loadProjectConfig(projectRoot);
  if (config.datalex?.manifestPath) {
    const rel = config.datalex.manifestPath;
    const abs = isAbsPath(rel) ? rel : join(projectRoot, rel);
    if (existsSync(abs)) return abs;
    return abs;
  }
  const fallback = join(projectRoot, 'datalex-manifest.json');
  if (existsSync(fallback)) return fallback;
  return null;
}

function isAbsPath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
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

function scanDomains(
  projectRoot: string,
  dirs: string[],
  diagnostics?: ManifestDiagnostic[],
): Record<string, ManifestDomain> {
  const domains: Record<string, ManifestDomain> = {};
  const seenFiles = new Set<string>();

  for (const dir of dirs) {
    const dirPath = join(projectRoot, dir);
    const files = scanFilesRecursive(dirPath, ['.dql']);

    for (const filePath of files) {
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      const relPath = relative(projectRoot, filePath);
      try {
        const source = readFileSync(filePath, 'utf-8');
        if (!/(^|\n)\s*domain\s+"/.test(source)) continue;
        const parser = new Parser(source, relPath);
        const ast = parser.parse();

        for (const stmt of ast.statements) {
          const domain = stmt as any;
          if (domain.kind !== 'DomainDecl') continue;

          if (domains[domain.name]) {
            diagnostics?.push({
              kind: 'resolve',
              filePath: relPath,
              severity: 'error',
              message: `duplicate domain "${domain.name}" also declared in ${domains[domain.name].filePath}`,
            });
            continue;
          }

          domains[domain.name] = domainDeclToManifestDomain(domain, relPath);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics?.push({
          kind: 'parse',
          filePath: relPath,
          severity: 'error',
          message: `Failed to parse domain file: ${msg}`,
        });
      }
    }
  }

  return domains;
}

function scanBlocks(
  projectRoot: string,
  dirs: string[],
  diagnostics?: ManifestDiagnostic[],
  datalexRegistry?: DataLexContractRegistry,
): Record<string, ManifestBlock> {
  const blocks: Record<string, ManifestBlock> = {};

  for (const dir of dirs) {
    const dirPath = join(projectRoot, dir);
    const files = scanFilesRecursive(dirPath, ['.dql']);

    for (const filePath of files) {
      const relPath = relative(projectRoot, filePath);
      try {
        const source = readFileSync(filePath, 'utf-8');
        const parser = new Parser(source, relPath);
        const ast = parser.parse();
        collectContractDiagnostics(ast, relPath, diagnostics, datalexRegistry);

        for (const stmt of ast.statements) {
          const block = stmt as any;
          if (block.kind !== 'BlockDecl') continue;

          const nextBlock = blockDeclToManifestBlock(block, relPath);
          if (blocks[block.name]) {
            diagnostics?.push({
              kind: 'resolve',
              filePath: relPath,
              severity: 'warning',
              message: `duplicate block "${block.name}" also declared in ${blocks[block.name].filePath}`,
            });
          }
          if (!blocks[block.name] || shouldReplaceDuplicateBlock(blocks[block.name], nextBlock)) {
            blocks[block.name] = nextBlock;
          }
        }
      } catch (err) {
        // Surface parse failures as diagnostics instead of silently dropping
        // the file. Users see a concrete error + path; `dql doctor` picks it up.
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics?.push({
          kind: 'parse',
          filePath: relPath,
          severity: 'error',
          message: `Failed to parse block file: ${msg}`,
        });
      }
    }
  }

  return blocks;
}

function shouldReplaceDuplicateBlock(existing: ManifestBlock, next: ManifestBlock): boolean {
  return duplicateBlockPriority(next) > duplicateBlockPriority(existing);
}

function duplicateBlockPriority(block: ManifestBlock): number {
  let score = 0;
  if (block.status === 'certified') score += 100;
  else if (block.status === 'review') score += 60;
  else if (block.status === 'draft') score += 20;
  else score += 10;
  const path = block.filePath.replaceAll('\\', '/');
  if (!path.includes('/_drafts/') && !path.startsWith('_drafts/') && !path.startsWith('blocks/_drafts/')) score += 10;
  if (path.startsWith('domains/') || path.startsWith('blocks/')) score += 5;
  return score;
}

// ---- Business View Scanning ----

function scanBusinessViews(
  projectRoot: string,
  dirs: string[],
  diagnostics?: ManifestDiagnostic[],
): Record<string, ManifestBusinessView> {
  const views: Record<string, ManifestBusinessView> = {};
  const seenFiles = new Set<string>();

  for (const dir of dirs) {
    const dirPath = join(projectRoot, dir);
    const files = scanFilesRecursive(dirPath, ['.dql']);

    for (const filePath of files) {
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      const relPath = relative(projectRoot, filePath);
      try {
        const source = readFileSync(filePath, 'utf-8');
        if (!source.includes('business_view')) continue;
        const parser = new Parser(source, relPath);
        const ast = parser.parse();

        for (const stmt of ast.statements) {
          const view = stmt as any;
          if (view.kind !== 'BusinessViewDecl') continue;

          if (views[view.name]) {
            diagnostics?.push({
              kind: 'resolve',
              filePath: relPath,
              severity: 'error',
              message: `duplicate business_view "${view.name}" also declared in ${views[view.name].filePath}`,
            });
            continue;
          }

          views[view.name] = businessViewDeclToManifestBusinessView(view, relPath);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics?.push({
          kind: 'parse',
          filePath: relPath,
          severity: 'error',
          message: `Failed to parse business view file: ${msg}`,
        });
      }
    }
  }

  return views;
}

// ---- Business Term Scanning ----

function scanTerms(
  projectRoot: string,
  dirs: string[],
  diagnostics?: ManifestDiagnostic[],
): Record<string, ManifestTerm> {
  const terms: Record<string, ManifestTerm> = {};
  const seenFiles = new Set<string>();

  for (const dir of dirs) {
    const dirPath = join(projectRoot, dir);
    const files = scanFilesRecursive(dirPath, ['.dql']);

    for (const filePath of files) {
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      const relPath = relative(projectRoot, filePath);
      try {
        const source = readFileSync(filePath, 'utf-8');
        if (!source.includes('term')) continue;
        const parser = new Parser(source, relPath);
        const ast = parser.parse();

        for (const stmt of ast.statements) {
          const term = stmt as any;
          if (term.kind !== 'TermDecl') continue;

          if (terms[term.name]) {
            diagnostics?.push({
              kind: 'resolve',
              filePath: relPath,
              severity: 'error',
              message: `duplicate term "${term.name}" also declared in ${terms[term.name].filePath}`,
            });
            continue;
          }

          terms[term.name] = termDeclToManifestTerm(term, relPath);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics?.push({
          kind: 'parse',
          filePath: relPath,
          severity: 'error',
          message: `Failed to parse term file: ${msg}`,
        });
      }
    }
  }

  return terms;
}

function validateDomains(
  domains: Record<string, ManifestDomain>,
  blocks: Record<string, ManifestBlock>,
  views: Record<string, ManifestBusinessView>,
  terms: Record<string, ManifestTerm>,
  diagnostics: ManifestDiagnostic[],
): void {
  const resolveDomain = createManifestDomainResolver(domains);
  const declaredDomains = new Set(Object.values(domains).map((domain) => domain.name));
  const usedDomains = new Map<string, string[]>();
  const addUse = (domain: string | undefined, label: string) => {
    if (!domain) return;
    const resolvedDomain = resolveDomain(domain);
    const list = usedDomains.get(resolvedDomain) ?? [];
    list.push(label);
    usedDomains.set(resolvedDomain, list);
  };

  for (const block of Object.values(blocks)) {
    addUse(block.domain, `block "${block.name}"`);
    if (!block.domain) {
      diagnostics.push({
        kind: 'resolve',
        filePath: block.filePath,
        severity: 'warning',
        message: `block "${block.name}" is missing a domain. Add a domain field or place it under domains/<domain>/blocks/.`,
      });
    }
  }
  for (const view of Object.values(views)) addUse(view.domain, `business_view "${view.name}"`);
  for (const term of Object.values(terms)) addUse(term.domain, `term "${term.name}"`);

  for (const block of Object.values(blocks)) {
    if (!block.domain) continue;
    const blockDomain = resolveDomain(block.domain);
    for (const ref of block.refDependencies ?? []) {
      const dependency = blocks[ref];
      const dependencyDomain = dependency?.domain ? resolveDomain(dependency.domain) : undefined;
      if (!dependencyDomain || dependencyDomain === blockDomain) continue;
      diagnostics.push({
        kind: 'resolve',
        filePath: block.filePath,
        severity: 'warning',
        message: `block "${block.name}" in domain "${blockDomain}" depends on block "${dependency.name}" in domain "${dependencyDomain}". Mark this as a bridge pattern or document the cross-domain dependency.`,
      });
    }
  }
  for (const view of Object.values(views)) {
    if (!view.domain) continue;
    const viewDomain = resolveDomain(view.domain);
    for (const ref of view.blockRefs ?? []) {
      const block = blocks[ref];
      const blockDomain = block?.domain ? resolveDomain(block.domain) : undefined;
      if (!blockDomain || blockDomain === viewDomain) continue;
      diagnostics.push({
        kind: 'resolve',
        filePath: view.filePath,
        severity: 'warning',
        message: `business_view "${view.name}" in domain "${viewDomain}" includes block "${block.name}" from domain "${blockDomain}". Review the cross-domain dependency.`,
      });
    }
    for (const ref of view.businessViewRefs ?? []) {
      const dependency = views[ref];
      const dependencyDomain = dependency?.domain ? resolveDomain(dependency.domain) : undefined;
      if (!dependencyDomain || dependencyDomain === viewDomain) continue;
      diagnostics.push({
        kind: 'resolve',
        filePath: view.filePath,
        severity: 'warning',
        message: `business_view "${view.name}" in domain "${viewDomain}" includes business_view "${dependency.name}" from domain "${dependencyDomain}". Review the cross-domain dependency.`,
      });
    }
  }

  for (const [domain, users] of usedDomains) {
    if (!declaredDomains.has(domain)) {
      diagnostics.push({
        kind: 'resolve',
        severity: 'warning',
        message: `domain "${domain}" is used by ${users.slice(0, 3).join(', ')}${users.length > 3 ? ` and ${users.length - 3} more` : ''} but has no first-class domain declaration.`,
      });
    }
  }

  for (const domain of Object.values(domains)) {
    if (!domain.owner) {
      diagnostics.push({
        kind: 'resolve',
        filePath: domain.filePath,
        severity: 'warning',
        message: `domain "${domain.name}" is missing owner metadata.`,
      });
    }
    if (!domain.reviewCadence) {
      diagnostics.push({
        kind: 'resolve',
        filePath: domain.filePath,
        severity: 'warning',
        message: `domain "${domain.name}" is missing reviewCadence metadata.`,
      });
    } else {
      const cadenceDays = reviewCadenceDays(domain.reviewCadence);
      if (cadenceDays === null) {
        diagnostics.push({
          kind: 'resolve',
          filePath: domain.filePath,
          severity: 'warning',
          message: `domain "${domain.name}" has unrecognized reviewCadence "${domain.reviewCadence}". Use daily, weekly, biweekly, monthly, quarterly, semiannual, or annual.`,
        });
      } else if (cadenceDays > 180) {
        diagnostics.push({
          kind: 'resolve',
          filePath: domain.filePath,
          severity: 'warning',
          message: `domain "${domain.name}" reviewCadence "${domain.reviewCadence}" is stale for enterprise use. Prefer quarterly or more frequent review for active domains.`,
        });
      }
    }
    if (!usedDomains.has(domain.name)) {
      diagnostics.push({
        kind: 'resolve',
        filePath: domain.filePath,
        severity: 'warning',
        message: `domain "${domain.name}" has no terms, blocks, or business views yet.`,
      });
    }
  }
}

function createManifestDomainResolver(domains: Record<string, ManifestDomain>): (domain: string) => string {
  const aliases = new Map<string, string>();
  for (const domain of Object.values(domains)) {
    aliases.set(domain.name, domain.name);
    aliases.set(domainAliasKey(domain.name), domain.name);
    const folderAlias = domain.filePath?.replace(/\\/g, '/').match(/^domains\/([^/]+)\//)?.[1];
    if (folderAlias) aliases.set(domainAliasKey(folderAlias), domain.name);
  }
  return (domain) => aliases.get(domain) ?? aliases.get(domainAliasKey(domain)) ?? domain;
}

function domainAliasKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function reviewCadenceDays(value: string): number | null {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!normalized) return null;
  if (normalized === 'daily' || normalized === 'day') return 1;
  if (normalized === 'weekly' || normalized === 'week') return 7;
  if (normalized === 'biweekly' || normalized === 'fortnightly') return 14;
  if (normalized === 'monthly' || normalized === 'month') return 30;
  if (normalized === 'quarterly' || normalized === 'quarter') return 90;
  if (normalized === 'semiannual' || normalized === 'semiannually' || normalized === 'halfyearly') return 180;
  if (normalized === 'annual' || normalized === 'annually' || normalized === 'yearly') return 365;
  const everyMatch = normalized.match(/^every(\d+)(day|days|week|weeks|month|months)$/);
  if (!everyMatch) return null;
  const amount = Number(everyMatch[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = everyMatch[2];
  if (unit.startsWith('day')) return amount;
  if (unit.startsWith('week')) return amount * 7;
  if (unit.startsWith('month')) return amount * 30;
  return null;
}

function validateBusinessViews(
  views: Record<string, ManifestBusinessView>,
  blocks: Record<string, ManifestBlock>,
  diagnostics: ManifestDiagnostic[],
): void {
  const blockNames = new Set(Object.keys(blocks));
  const viewNames = new Set(Object.keys(views));

  for (const view of Object.values(views)) {
    view.unresolvedBlockRefs = view.blockRefs.filter((ref) => !blockNames.has(ref));
    view.blockRefs = view.blockRefs.filter((ref) => blockNames.has(ref));
    view.unresolvedBusinessViewRefs = view.businessViewRefs.filter((ref) => !viewNames.has(ref));
    view.businessViewRefs = view.businessViewRefs.filter((ref) => viewNames.has(ref));

    if (view.unresolvedBlockRefs.length > 0) {
      diagnostics.push({
        kind: 'resolve',
        filePath: view.filePath,
        severity: 'error',
        message: `business_view "${view.name}" has unresolved block refs: ${view.unresolvedBlockRefs.join(', ')}`,
      });
    }

    if (view.unresolvedBusinessViewRefs.length > 0) {
      diagnostics.push({
        kind: 'resolve',
        filePath: view.filePath,
        severity: 'error',
        message: `business_view "${view.name}" has unresolved business_view refs: ${view.unresolvedBusinessViewRefs.join(', ')}`,
      });
    }
  }

  detectBusinessViewCycles(views, diagnostics);
}

function validateTermRefs(
  terms: Record<string, ManifestTerm>,
  blocks: Record<string, ManifestBlock>,
  views: Record<string, ManifestBusinessView>,
  diagnostics: ManifestDiagnostic[],
): void {
  const termNames = new Set(Object.keys(terms));

  for (const block of Object.values(blocks)) {
    const declared = block.termRefs ?? [];
    block.unresolvedTermRefs = declared.filter((ref) => !termNames.has(ref));
    block.termRefs = declared.filter((ref) => termNames.has(ref));
    if (block.unresolvedTermRefs.length > 0) {
      diagnostics.push({
        kind: 'resolve',
        filePath: block.filePath,
        severity: 'error',
        message: `block "${block.name}" has unresolved term refs: ${block.unresolvedTermRefs.join(', ')}`,
      });
    }
  }

  for (const view of Object.values(views)) {
    const declared = view.declaredTermRefs ?? [];
    view.unresolvedTermRefs = declared.filter((ref) => !termNames.has(ref));
    view.declaredTermRefs = declared.filter((ref) => termNames.has(ref));
    if (view.unresolvedTermRefs.length > 0) {
      diagnostics.push({
        kind: 'resolve',
        filePath: view.filePath,
        severity: 'error',
        message: `business_view "${view.name}" has unresolved term refs: ${view.unresolvedTermRefs.join(', ')}`,
      });
    }
  }

  const collectTermsForView = (viewName: string, seen = new Set<string>()): string[] => {
    const view = views[viewName];
    if (!view || seen.has(viewName)) return [];
    seen.add(viewName);
    const refs = new Set<string>(view.declaredTermRefs ?? []);
    for (const blockRef of view.blockRefs) {
      for (const termRef of blocks[blockRef]?.termRefs ?? []) refs.add(termRef);
    }
    for (const viewRef of view.businessViewRefs) {
      for (const termRef of collectTermsForView(viewRef, seen)) refs.add(termRef);
    }
    return [...refs];
  };

  for (const view of Object.values(views)) {
    const declaredSet = new Set(view.declaredTermRefs ?? []);
    const allRefs = collectTermsForView(view.name);
    view.termRefs = allRefs;
    view.inheritedTermRefs = allRefs.filter((ref) => !declaredSet.has(ref));
  }
}

function detectBusinessViewCycles(
  views: Record<string, ManifestBusinessView>,
  diagnostics: ManifestDiagnostic[],
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const reported = new Set<string>();

  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const cycleStart = stack.indexOf(name);
      const cycle = [...stack.slice(cycleStart), name];
      const key = cycle.join(' -> ');
      if (!reported.has(key)) {
        reported.add(key);
        diagnostics.push({
          kind: 'resolve',
          filePath: views[name]?.filePath,
          severity: 'error',
          message: `business_view cycle detected: ${cycle.join(' -> ')}`,
        });
      }
      return;
    }

    visiting.add(name);
    stack.push(name);
    for (const ref of views[name]?.businessViewRefs ?? []) {
      visit(ref);
    }
    stack.pop();
    visiting.delete(name);
    visited.add(name);
  };

  for (const name of Object.keys(views)) {
    visit(name);
  }
}

// ---- Notebook Scanning ----

function scanNotebooks(
  projectRoot: string,
  dirs: string[],
  diagnostics?: ManifestDiagnostic[],
  datalexRegistry?: DataLexContractRegistry,
): Record<string, ManifestNotebook> {
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
              collectContractDiagnostics(ast, relPath, diagnostics, datalexRegistry);
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
            bindingPath: typeof cell.blockBinding?.path === 'string' ? cell.blockBinding.path : undefined,
          });
        }

        if (cells.length > 0) {
          notebooks[relPath] = {
            title: doc.metadata?.title ?? doc.title ?? relPath,
            filePath: relPath,
            cells,
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics?.push({
          kind: 'parse',
          filePath: relative(projectRoot, filePath),
          severity: 'error',
          message: `Failed to parse notebook: ${msg}`,
        });
      }
    }
  }

  return notebooks;
}

/** Extract blocks declared inside notebook DQL cells into the blocks map. */
function extractNotebookBlocks(notebooks: Record<string, ManifestNotebook>): Record<string, ManifestBlock> {
  const blocks: Record<string, ManifestBlock> = {};

  for (const [nbPath, nb] of Object.entries(notebooks)) {
    for (const cell of nb.cells) {
      if (cell.type !== 'dql' || !cell.blockName) continue;

      // Only add if not already found as a standalone block file
      if (!blocks[cell.blockName]) {
        try {
          const ast = new Parser(cell.source, `${nbPath}:${cell.id}`).parse();
          const block = ast.statements.find((stmt: any) => stmt.kind === 'BlockDecl' && stmt.name === cell.blockName);
          if (block) {
            blocks[cell.blockName] = blockDeclToManifestBlock(block, `${nbPath}#${cell.id}`);
          }
        } catch {
          const parseResult = extractTablesFromSql(cell.source);
          blocks[cell.blockName] = {
            name: cell.blockName,
            filePath: `${nbPath}#${cell.id}`,
            sql: '',
            rawTableRefs: parseResult.tables,
            tableDependencies: parseResult.tables.map(normalizeTableName),
            refDependencies: parseResult.refs,
            allDependencies: [...parseResult.refs, ...parseResult.tables.map(normalizeTableName)],
            tests: [],
          };
        }
      }
    }
  }

  return blocks;
}

/** Extract terms declared inside notebook DQL cells into the terms map. */
function extractNotebookTerms(notebooks: Record<string, ManifestNotebook>): Record<string, ManifestTerm> {
  const terms: Record<string, ManifestTerm> = {};

  for (const [nbPath, nb] of Object.entries(notebooks)) {
    for (const cell of nb.cells) {
      if (cell.type !== 'dql' || !cell.source.includes('term')) continue;
      try {
        const ast = new Parser(cell.source, `${nbPath}:${cell.id}`).parse();
        for (const stmt of ast.statements) {
          const term = stmt as any;
          if (term.kind !== 'TermDecl' || terms[term.name]) continue;
          terms[term.name] = termDeclToManifestTerm(term, `${nbPath}#${cell.id}`);
        }
      } catch {
        // scanNotebooks already records parse diagnostics for invalid DQL cells.
      }
    }
  }

  return terms;
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

    // Build reverse lookup: normalised table/model names -> uniqueIds.
    // Multiple dbt nodes may share a short alias, so short-name matches are
    // used only when they resolve unambiguously.
    const nameToIds = new Map<string, Set<string>>();
    const addNameLookup = (key: string, uniqueId: string) => {
      const normalized = key.toLowerCase();
      const existing = nameToIds.get(normalized);
      if (existing) existing.add(uniqueId);
      else nameToIds.set(normalized, new Set([uniqueId]));
    };
    for (const entry of index.values()) {
      for (const key of entry.lookupKeys) {
        addNameLookup(key, entry.uniqueId);
      }
    }

    const resolveDbtAnchor = (ref: string): string | undefined => {
      for (const key of buildReferencedTableLookupKeys(ref)) {
        const ids = nameToIds.get(key);
        if (ids?.size === 1) return [...ids][0];
      }
      return undefined;
    };

    // Anchors = DQL-referenced tables ∪ user-declared `dbtImport.anchors`
    const anchors = new Set<string>();
    for (const tableName of referencedTables) {
      const uid = resolveDbtAnchor(tableName);
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
        const uid = resolveDbtAnchor(anchorExpr);
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
  const aliases = new Set([name.toLowerCase()]);
  const stripped = stripDbtRolePrefix(name);
  if (stripped) aliases.add(stripped);

  const keys = new Set<string>();
  for (const alias of aliases) {
    keys.add(alias);
    if (schema) keys.add(`${schema}.${alias}`.toLowerCase());
    if (schema && database) keys.add(`${database}.${schema}.${alias}`.toLowerCase());
  }
  return [...keys];
}

function buildReferencedTableLookupKeys(ref: string): string[] {
  const normalized = ref.replace(/["`]/g, '').toLowerCase();
  const parts = normalized.split('.').filter(Boolean);
  const keys = new Set<string>([normalized]);
  if (parts.length >= 2) keys.add(parts.slice(-2).join('.'));
  const last = parts.at(-1);
  if (last) keys.add(last);
  return [...keys];
}

function stripDbtRolePrefix(name: string): string | undefined {
  const normalized = name.toLowerCase();
  const match = /^(?:src|stg|int|dim|fct)_(.+)$/.exec(normalized);
  return match?.[1];
}

// ---- Apps & Dashboards Scanning ----

/**
 * Discover Apps under `apps/<id>/dql.app.json` plus their dashboards under
 * `apps/<id>/dashboards/*.dqld`. Returns the manifest views for both.
 *
 * Block refs declared in dashboards are resolved against the already-built
 * blocks map: block-id refs map directly; path refs go through the
 * file-path → block-name index. Unresolved refs are surfaced as diagnostics
 * but do not fail the build — partial Apps are still useful in the UI.
 */
function scanAppsAndDashboards(
  projectRoot: string,
  blocks: Record<string, ManifestBlock>,
  diagnostics: ManifestDiagnostic[],
): { apps: Record<string, ManifestApp>; dashboards: Record<string, ManifestDashboard> } {
  const apps: Record<string, ManifestApp> = {};
  const dashboards: Record<string, ManifestDashboard> = {};

  // Build block-path → block-name index once for all dashboards.
  const blockPathToName = new Map<string, string>();
  for (const block of Object.values(blocks)) {
    if (block.filePath) blockPathToName.set(block.filePath, block.name);
  }
  const knownBlockNames = new Set(Object.keys(blocks));

  const appJsonPaths = findAppDocuments(projectRoot);
  for (const appJsonPath of appJsonPaths) {
    const appRel = relative(projectRoot, appJsonPath);
    const { document: app, errors } = loadAppDocument(appJsonPath);
    if (errors.length > 0) {
      for (const e of errors) {
        diagnostics.push({
          kind: 'config',
          filePath: appRel,
          severity: 'error',
          message: e.message,
        });
      }
    }
    if (!app) continue;

    const appDir = appJsonPath.slice(0, -'/dql.app.json'.length);
    const appFolderRel = appFolderRelPath(projectRoot, appJsonPath);
    const localDashboardIds: string[] = [];
    const qualifiedDashboardIds: string[] = [];

    // Scan this App's dashboards.
    for (const dqldPath of findDashboardsForApp(appDir)) {
      const dqldRel = relative(projectRoot, dqldPath);
      const { document: dashboard, errors: dErrs } = loadDashboardDocument(dqldPath);
      if (dErrs.length > 0) {
        for (const e of dErrs) {
          diagnostics.push({
            kind: 'config',
            filePath: dqldRel,
            severity: 'error',
            message: e.message,
          });
        }
      }
      if (!dashboard) continue;

      const refs = extractDashboardBlockRefs(dashboard);
      const resolvedById: string[] = [];
      const resolvedByPath: string[] = [];
      const unresolved: string[] = [];
      for (const id of refs.byId) {
        if (knownBlockNames.has(id)) resolvedById.push(id);
        else unresolved.push(id);
      }
      for (const refPath of refs.byPath) {
        const resolved = blockPathToName.get(refPath);
        if (resolved) resolvedByPath.push(resolved);
        else unresolved.push(refPath);
      }
      if (unresolved.length > 0) {
        diagnostics.push({
          kind: 'resolve',
          filePath: dqldRel,
          severity: 'warning',
          message: `dashboard "${dashboard.id}" has unresolved block refs: ${unresolved.join(', ')}`,
        });
      }

      const qualifiedId = `${app.id}/${dashboard.id}`;
      const dashRecord: ManifestDashboard = {
        id: dashboard.id,
        appId: app.id,
        qualifiedId,
        title: dashboard.metadata.title,
        description: dashboard.metadata.description,
        businessOutcome: dashboard.metadata.businessOutcome,
        businessOwner: dashboard.metadata.businessOwner,
        decisionUse: dashboard.metadata.decisionUse,
        reviewCadence: dashboard.metadata.reviewCadence,
        businessRules: dashboard.metadata.businessRules,
        caveats: dashboard.metadata.caveats,
        domain: dashboard.metadata.domain ?? app.domain,
        subdomain: dashboard.metadata.subdomain ?? app.subdomain,
        groups: dashboard.metadata.groups ?? app.groups ?? [],
        audience: dashboard.metadata.audience ?? app.audience,
        visibility: dashboard.metadata.visibility ?? app.visibility ?? 'shared',
        lifecycle: dashboard.metadata.lifecycle ?? app.lifecycle ?? 'draft',
        tags: dashboard.metadata.tags ?? [],
        filePath: dqldRel,
        blockIds: resolvedById,
        blockPathRefs: resolvedByPath,
        unresolvedRefs: unresolved,
        params: (dashboard.params ?? []).map((p) => p.id),
        filters: (dashboard.filters ?? []).map((f) => f.id),
        layout: {
          kind: dashboard.layout.kind,
          cols: dashboard.layout.cols,
          rowHeight: dashboard.layout.rowHeight,
          itemCount: dashboard.layout.items.length,
        },
      };
      dashboards[qualifiedId] = dashRecord;
      localDashboardIds.push(dashboard.id);
      qualifiedDashboardIds.push(qualifiedId);
    }

    // Cross-check homepage dashboard exists.
    if (app.homepage?.type === 'dashboard') {
      if (!localDashboardIds.includes(app.homepage.id)) {
        diagnostics.push({
          kind: 'resolve',
          filePath: appRel,
          severity: 'warning',
          message: `homepage references unknown dashboard "${app.homepage.id}"`,
        });
      }
    } else if (app.homepage?.type === 'notebook' && !existsSync(join(projectRoot, app.homepage.path))) {
      diagnostics.push({
        kind: 'resolve',
        filePath: appRel,
        severity: 'warning',
        message: `homepage references unknown notebook "${app.homepage.path}"`,
      });
    }
    // Cross-check schedule dashboards exist.
    for (const sched of app.schedules ?? []) {
      if (!localDashboardIds.includes(sched.dashboard)) {
        diagnostics.push({
          kind: 'resolve',
          filePath: appRel,
          severity: 'warning',
          message: `schedule "${sched.id}" references unknown dashboard "${sched.dashboard}"`,
        });
      }
    }
    for (const notebook of app.notebooks ?? []) {
      if (!existsSync(join(projectRoot, notebook.path))) {
        diagnostics.push({
          kind: 'resolve',
          filePath: appRel,
          severity: 'warning',
          message: `notebook reference points to missing file "${notebook.path}"`,
        });
      }
    }

    apps[app.id] = appDocumentToManifest(app, appFolderRel, qualifiedDashboardIds);
  }

  return { apps, dashboards };
}

function appDocumentToManifest(
  app: AppDocument,
  filePath: string,
  dashboardIds: string[],
): ManifestApp {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    businessOutcome: app.businessOutcome,
    businessOwner: app.businessOwner,
    decisionUse: app.decisionUse,
    reviewCadence: app.reviewCadence,
    businessRules: app.businessRules,
    caveats: app.caveats,
    domain: app.domain,
    subdomain: app.subdomain,
    groups: app.groups ?? [],
    audience: app.audience,
    visibility: app.visibility ?? 'shared',
    lifecycle: app.lifecycle ?? 'draft',
    owners: app.owners,
    tags: app.tags ?? [],
    filePath,
    members: app.members.map((m) => ({
      userId: m.userId,
      displayName: m.displayName,
      roles: m.roles,
      attributes: m.attributes,
    })),
    roles: app.roles.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      description: r.description,
    })),
    policies: (app.policies ?? []).map((p) => ({
      id: p.id,
      description: p.description,
      domain: p.domain,
      minClassification: p.minClassification,
      allowedRoles: p.allowedRoles,
      allowedUsers: p.allowedUsers,
      accessLevel: p.accessLevel,
      enabled: p.enabled === undefined ? true : Boolean(p.enabled),
    })),
    rlsBindings: (app.rlsBindings ?? []).map((b) => ({
      role: b.role,
      variable: b.variable,
      from: b.from,
    })),
    schedules: (app.schedules ?? []).map((s) => ({
      id: s.id,
      cron: s.cron,
      dashboard: s.dashboard,
      deliver: s.deliver.map((d) => {
        if (d.kind === 'slack') return { kind: 'slack' as const, channel: d.channel };
        if (d.kind === 'email') return { kind: 'email' as const, to: d.to };
        return { kind: 'webhook' as const, url: d.url };
      }),
      description: s.description,
      enabled: s.enabled === undefined ? true : Boolean(s.enabled),
    })),
    dashboards: dashboardIds,
    notebooks: (app.notebooks ?? []).map((n) => ({
      path: n.path,
      title: n.title,
      role: n.role,
      visibility: n.visibility ?? 'shared',
    })),
    homepage: app.homepage,
  };
}

// ---- Lineage Builder ----

function buildManifestLineage(
  manifestDomains: Record<string, ManifestDomain>,
  blocks: Record<string, ManifestBlock>,
  metrics: Record<string, ManifestMetric>,
  dimensions: Record<string, ManifestDimension>,
  notebooks?: Record<string, ManifestNotebook>,
  dbtImport?: ManifestDbtImport,
  apps?: Record<string, ManifestApp>,
  appDashboards?: Record<string, ManifestDashboard>,
  businessViews?: Record<string, ManifestBusinessView>,
  terms?: Record<string, ManifestTerm>,
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
    metricsRef: b.metricsRef,
    dimensionsRef: b.dimensionsRef,
    chartType: b.chartType,
    filePath: b.filePath,
    description: b.description,
    businessOutcome: b.businessOutcome,
    reviewCadence: b.reviewCadence,
    tests: b.tests,
    termRefs: b.termRefs,
    pattern: b.pattern,
    grain: b.grain,
    entities: b.entities,
    declaredOutputs: b.declaredOutputs,
    dimensions: b.dimensions,
    allowedFilters: b.allowedFilters,
    parameterPolicy: b.parameterPolicy,
    filterBindings: b.filterBindings,
    sourceSystems: b.sourceSystems,
    replacementFor: b.replacementFor,
  }));

  const lineageDomains: LineageDomainInput[] = Object.values(manifestDomains ?? {}).map((domain) => ({
    name: domain.name,
    owner: domain.owner,
    businessOwner: domain.businessOwner,
    boundedContext: domain.boundedContext,
    filePath: domain.filePath,
    sourceSystems: domain.sourceSystems,
    primaryTerms: domain.primaryTerms,
    reviewCadence: domain.reviewCadence,
    businessOutcome: domain.businessOutcome,
    tags: domain.tags,
  }));

  const lineageTerms: LineageTermInput[] = Object.values(terms ?? {}).map((term) => ({
    name: term.name,
    domain: term.domain,
    owner: term.owner,
    status: term.status as any,
    termType: term.termType,
    filePath: term.filePath,
    description: term.description,
    identifiers: term.identifiers,
    synonyms: term.synonyms,
    businessOutcome: term.businessOutcome,
    reviewCadence: term.reviewCadence,
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

  const lineageBusinessViews: LineageBusinessViewInput[] = Object.values(businessViews ?? {}).map((view) => ({
    name: view.name,
    domain: view.domain,
    owner: view.owner,
    status: view.status as any,
    filePath: view.filePath,
    description: view.description,
    businessOutcome: view.businessOutcome,
    reviewCadence: view.reviewCadence,
    blockRefs: view.blockRefs,
    businessViewRefs: view.businessViewRefs,
    termRefs: view.termRefs,
    declaredTermRefs: view.declaredTermRefs,
  }));

  // Pre-build a map of table name → block names that query that table.
  // Used to resolve "which blocks feed into a notebook" when a notebook
  // references a table directly rather than via ref().
  const tableToBlocks = new Map<string, string[]>();
  const pathToBlockName = new Map<string, string>();
  for (const block of Object.values(blocks)) {
    for (const table of block.tableDependencies) {
      const key = table.toLowerCase();
      if (!tableToBlocks.has(key)) tableToBlocks.set(key, []);
      tableToBlocks.get(key)!.push(block.name);
    }
    if (block.filePath) pathToBlockName.set(block.filePath, block.name);
  }

  const dashboards: LineageDashboardInput[] = Object.values(notebooks ?? {}).map((notebook) => {
    // Blocks declared inline inside this notebook (DQL cells with block declarations)
    const inlineBlockNames = notebook.cells
      .map((cell) => cell.blockName)
      .filter((name): name is string => Boolean(name));
    const inlineBlockSet = new Set(inlineBlockNames);

    // Blocks explicitly ref()-ed from notebook SQL cells, plus bound cells
    // (Track 5): a bound cell points at a `.dql` block file by path.
    const refDeps = new Set<string>();
    for (const cell of notebook.cells) {
      for (const ref of cell.refDependencies ?? []) {
        if (!inlineBlockSet.has(ref) && blocks[ref]) refDeps.add(ref);
      }
      if (cell.bindingPath) {
        const bound = pathToBlockName.get(cell.bindingPath);
        if (bound && !inlineBlockSet.has(bound)) refDeps.add(bound);
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
      kind: 'notebook',
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

  // First-class dashboards from `.dqld` files. Keyed by qualified id so
  // dashboards with the same local id can exist in different Apps.
  const appDashboardInputs: LineageDashboardInput[] = Object.values(appDashboards ?? {}).map((d) => ({
    name: d.qualifiedId,
    kind: 'dashboard',
    filePath: d.filePath,
    blocks: [...d.blockIds, ...d.blockPathRefs],
    charts: [],
    refDependencies: [],
    tableDependencies: [],
  }));

  const lineageApps: LineageAppInput[] = Object.values(apps ?? {}).map((a) => ({
    id: a.id,
    name: a.name,
    domain: a.domain,
    owner: a.owners[0],
    filePath: a.filePath,
    dashboards: a.dashboards,
  }));

  const graph = buildLineageGraph(lineageBlocks, lineageMetrics, lineageDimensions, {
    dbtModels,
    dashboards: [...dashboards, ...appDashboardInputs],
    apps: lineageApps,
    businessViews: lineageBusinessViews,
    terms: lineageTerms,
    domains: lineageDomains,
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
      filePath: blocks[n.name]?.filePath ?? businessViews?.[n.name]?.filePath ?? terms?.[n.name]?.filePath ?? n.metadata?.filePath,
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

function blockDeclToManifestBlock(block: any, filePath: string): ManifestBlock {
  const sql = block.query?.rawSQL ?? '';
  const parseResult = extractTablesFromSql(sql);
  const columnLineage = sql ? extractColumnLineage(sql) : null;
  const domain = extractProp(block, 'domain');
  const owner = extractProp(block, 'owner');
  const description = extractProp(block, 'description');
  const tags = extractTags(block);
  const tests = extractTests(block);
  const agent = extractAgentMetadata(block);

  return {
    name: block.name,
    filePath,
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
    dimensionsRef: block.dimensionsRef,
    allDependencies: [
      ...parseResult.refs,
      ...parseResult.tables.map(normalizeTableName),
      ...parseResult.metricRefs.map((m) => `@metric(${m})`),
      ...parseResult.dimensionRefs.map((d) => `@dim(${d})`),
      ...((block.metricsRef ?? (block.metricRef ? [block.metricRef] : [])).map((m: string) => `@metric(${m})`)),
      ...((block.dimensionsRef ?? []).map((d: string) => `@dim(${d})`)),
    ],
    chartType: extractVisualizationChart(block),
    displayHints: extractDisplayHints(block),
    metricRef: block.metricRef,
    metricsRef: block.metricsRef,
    tests,
    tags,
    description,
    termRefs: Array.isArray(block.termRefs) ? block.termRefs : undefined,
    pattern: typeof block.pattern === 'string' ? block.pattern : undefined,
    grain: typeof block.grain === 'string' ? block.grain : undefined,
    entities: Array.isArray(block.entities) ? block.entities : undefined,
    declaredOutputs: Array.isArray(block.outputs) ? block.outputs : undefined,
    dimensions: Array.isArray(block.dimensions) ? block.dimensions : undefined,
    allowedFilters: Array.isArray(block.allowedFilters) ? block.allowedFilters : undefined,
    parameterPolicy: Array.isArray(block.parameterPolicy)
      ? block.parameterPolicy.map((entry: { name: string; policy: string }) => ({
          name: entry.name,
          policy: entry.policy,
        }))
      : undefined,
    filterBindings: Array.isArray(block.filterBindings)
      ? block.filterBindings.map((entry: { filter: string; binding: string }) => ({
          filter: entry.filter,
          binding: entry.binding,
        }))
      : undefined,
    sourceSystems: Array.isArray(block.sourceSystems) ? block.sourceSystems : undefined,
    replacementFor: Array.isArray(block.replacementFor) ? block.replacementFor : undefined,
    unresolvedTermRefs: [],
    llmContext: agent.llmContext,
    examples: agent.examples,
    invariants: agent.invariants,
    businessOutcome: agent.businessOutcome,
    businessOwner: agent.businessOwner,
    decisionUse: agent.decisionUse,
    reviewCadence: agent.reviewCadence,
    businessRules: agent.businessRules,
    caveats: agent.caveats,
    datalexContract: typeof block.datalexContract === 'string' ? block.datalexContract : undefined,
    draftMetadata: extractDraftMetadata(block),
    outputs: columnLineage?.parsed && columnLineage.columns.length > 0
      ? columnLineage.columns.map((c) => ({
          name: c.name,
          isAggregate: c.isAggregate,
          aggregateFn: c.aggregateFn,
          sources: c.sources,
          unresolved: c.unresolved,
        }))
      : undefined,
    outputContract: buildOutputContract(
      Array.isArray(block.outputs) ? block.outputs : undefined,
      columnLineage,
    ),
  };
}

/**
 * Build a block's typed `outputContract` — the columns a parent that `ref()`s
 * this block can rely on. Additive and distinct from `outputs` (column-lineage
 * shaped). Source of truth, in priority order:
 *
 *   1. `declaredOutputs` (reviewer-declared field names) when present. These
 *      are the contract the block author committed to, so they win. Column
 *      lineage is used only to enrich `role`/`type` for matching names.
 *   2. Otherwise, the resolved column-lineage output columns — but only when
 *      the projection is fully resolved (no `*`/unresolved entries). A star or
 *      unparsed projection means the schema is open, so we emit no contract and
 *      drift detection stays silent for this block (conservative).
 *
 * Returns undefined when neither source yields a usable schema, keeping the
 * field optional and backward-compatible.
 */
function buildOutputContract(
  declaredOutputs: string[] | undefined,
  columnLineage: ColumnLineageResult | null,
): Array<{ name: string; type?: string; role?: string }> | undefined {
  const roleByName = new Map<string, string>();
  if (columnLineage?.parsed) {
    for (const col of columnLineage.columns) {
      if (col.isAggregate) roleByName.set(col.name.toLowerCase(), 'metric');
    }
  }

  if (Array.isArray(declaredOutputs) && declaredOutputs.length > 0) {
    const seen = new Set<string>();
    const contract: Array<{ name: string; type?: string; role?: string }> = [];
    for (const raw of declaredOutputs) {
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      contract.push({ name, role: roleByName.get(name.toLowerCase()) });
    }
    return contract.length > 0 ? contract : undefined;
  }

  if (!columnLineage?.parsed || columnLineage.columns.length === 0) return undefined;
  // Only emit a derived contract when every output column is resolved — a star
  // or unresolved entry means we cannot enumerate the real output schema.
  if (columnLineage.columns.some((c) => c.unresolved || c.name === '*' || c.name.endsWith('.*'))) {
    return undefined;
  }
  const seen = new Set<string>();
  const contract: Array<{ name: string; type?: string; role?: string }> = [];
  for (const col of columnLineage.columns) {
    const name = col.name?.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    contract.push({ name, role: col.isAggregate ? 'metric' : undefined });
  }
  return contract.length > 0 ? contract : undefined;
}

function domainDeclToManifestDomain(domain: any, filePath: string): ManifestDomain {
  return {
    name: domain.name,
    filePath,
    owner: typeof domain.owner === 'string' ? domain.owner : undefined,
    businessOwner: typeof domain.businessOwner === 'string' ? domain.businessOwner : undefined,
    boundedContext: typeof domain.boundedContext === 'string' ? domain.boundedContext : undefined,
    sourceSystems: Array.isArray(domain.sourceSystems) ? domain.sourceSystems : undefined,
    primaryTerms: Array.isArray(domain.primaryTerms) ? domain.primaryTerms : undefined,
    reviewCadence: typeof domain.reviewCadence === 'string' ? domain.reviewCadence : undefined,
    tags: Array.isArray(domain.tags) ? domain.tags : undefined,
    businessOutcome: typeof domain.businessOutcome === 'string' ? domain.businessOutcome : undefined,
    description: typeof domain.description === 'string' ? domain.description : undefined,
  };
}

function termDeclToManifestTerm(term: any, filePath: string): ManifestTerm {
  return {
    name: term.name,
    filePath,
    domain: extractProp(term, 'domain'),
    owner: extractProp(term, 'owner'),
    status: extractProp(term, 'status'),
    termType: typeof term.termType === 'string' ? term.termType : undefined,
    tags: extractTags(term),
    description: extractProp(term, 'description'),
    identifiers: Array.isArray(term.identifiers) ? term.identifiers : undefined,
    synonyms: Array.isArray(term.synonyms) ? term.synonyms : undefined,
    businessOutcome: typeof term.businessOutcome === 'string' ? term.businessOutcome : undefined,
    businessOwner: typeof term.businessOwner === 'string' ? term.businessOwner : undefined,
    decisionUse: typeof term.decisionUse === 'string' ? term.decisionUse : undefined,
    reviewCadence: typeof term.reviewCadence === 'string' ? term.reviewCadence : undefined,
    businessRules: Array.isArray(term.businessRules) ? term.businessRules : undefined,
    caveats: Array.isArray(term.caveats) ? term.caveats : undefined,
  };
}

function businessViewDeclToManifestBusinessView(view: any, filePath: string): ManifestBusinessView {
  const blockRefs: string[] = [];
  const businessViewRefs: string[] = [];
  for (const ref of view.includes ?? []) {
    if (ref.refType === 'block') blockRefs.push(ref.name);
    if (ref.refType === 'business_view') businessViewRefs.push(ref.name);
  }

  return {
    name: view.name,
    filePath,
    domain: extractProp(view, 'domain'),
    owner: extractProp(view, 'owner'),
    status: extractProp(view, 'status'),
    tags: extractTags(view),
    description: extractProp(view, 'description'),
    businessOutcome: typeof view.businessOutcome === 'string' ? view.businessOutcome : undefined,
    businessOwner: typeof view.businessOwner === 'string' ? view.businessOwner : undefined,
    decisionUse: typeof view.decisionUse === 'string' ? view.decisionUse : undefined,
    reviewCadence: typeof view.reviewCadence === 'string' ? view.reviewCadence : undefined,
    businessRules: Array.isArray(view.businessRules) ? view.businessRules : undefined,
    caveats: Array.isArray(view.caveats) ? view.caveats : undefined,
    blockRefs,
    businessViewRefs,
    termRefs: Array.isArray(view.termRefs) ? view.termRefs : [],
    declaredTermRefs: Array.isArray(view.termRefs) ? view.termRefs : [],
    inheritedTermRefs: [],
    unresolvedTermRefs: [],
    unresolvedBlockRefs: [],
    unresolvedBusinessViewRefs: [],
  };
}

function collectContractDiagnostics(
  ast: import('../ast/index.js').ProgramNode,
  relPath: string,
  diagnostics?: ManifestDiagnostic[],
  datalexRegistry?: DataLexContractRegistry,
): void {
  if (!diagnostics) return;
  const hasContractRef = ast.statements.some((stmt: any) => stmt.kind === 'BlockDecl' && typeof stmt.datalexContract === 'string' && stmt.datalexContract.trim() !== '');
  if (!hasContractRef) return;

  const semanticDiagnostics = analyze(ast, { datalexRegistry });
  for (const diag of semanticDiagnostics) {
    if (!diag.message.includes('datalex_contract') && !diag.message.includes('DataLex manifest')) continue;
    diagnostics.push({
      kind: 'semantic',
      filePath: relPath,
      severity: diag.severity === 'error' ? 'error' : 'warning',
      message: diag.message,
    });
  }
}

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
    if (prop.name === 'chart' && prop.value?.kind === 'StringLiteral') {
      return String(prop.value.value);
    }
    if (prop.key === 'chart' && prop.value?.kind === 'Literal') {
      return String(prop.value.value);
    }
  }
  return undefined;
}

function extractDisplayHints(block: any): ManifestBlock['displayHints'] | undefined {
  const chart = extractVisualizationChart(block);
  const fieldHints: Record<string, string> = {};
  if (block.visualization) {
    for (const prop of block.visualization.properties ?? []) {
      const name = String(prop.name ?? prop.key ?? '');
      if (!['x', 'y', 'color', 'time', 'label', 'value', 'rank'].includes(name)) continue;
      const value = literalOrIdentifier(prop.value);
      if (value) fieldHints[name] = value;
    }
  }
  if (!chart && Object.keys(fieldHints).length === 0) return undefined;
  const allowed = new Set<string>();
  if (chart) allowed.add(chart);
  allowed.add('table');
  if (chart === 'bar' || chart === 'grouped_bar' || chart === 'stacked_bar') {
    allowed.add('line');
  }
  if (chart === 'line' || chart === 'area') {
    allowed.add('bar');
  }
  return {
    ...(chart ? { defaultVisualization: chart } : {}),
    allowedVisualizations: Array.from(allowed),
    ...(Object.keys(fieldHints).length > 0 ? { fieldHints } : {}),
    source: 'block_visualization',
  };
}

function literalOrIdentifier(value: any): string | undefined {
  if (!value) return undefined;
  if (value.kind === 'StringLiteral' || value.kind === 'Literal') return String(value.value);
  if (value.kind === 'Identifier') return String(value.name);
  if (typeof value.name === 'string') return value.name;
  if (typeof value.value === 'string' || typeof value.value === 'number') return String(value.value);
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

/**
 * v1.2 Track G — agent-facing metadata.
 * Pulls `llmContext`, `invariants`, `examples` directly from the parsed block
 * node. All three are optional; absent values return undefined so the MCP
 * layer can omit them.
 */
function extractAgentMetadata(block: any): {
  llmContext?: string;
  examples?: Array<{ question: string; sql?: string }>;
  invariants?: string[];
  businessOutcome?: string;
  businessOwner?: string;
  decisionUse?: string;
  reviewCadence?: string;
  businessRules?: string[];
  caveats?: string[];
} {
  return {
    llmContext: typeof block.llmContext === 'string' ? block.llmContext : undefined,
    invariants: Array.isArray(block.invariants) ? block.invariants : undefined,
    examples: Array.isArray(block.examples) ? block.examples : undefined,
    businessOutcome: typeof block.businessOutcome === 'string' ? block.businessOutcome : undefined,
    businessOwner: typeof block.businessOwner === 'string' ? block.businessOwner : undefined,
    decisionUse: typeof block.decisionUse === 'string' ? block.decisionUse : undefined,
    reviewCadence: typeof block.reviewCadence === 'string' ? block.reviewCadence : undefined,
    businessRules: Array.isArray(block.businessRules) ? block.businessRules : undefined,
    caveats: Array.isArray(block.caveats) ? block.caveats : undefined,
  };
}

function extractDraftMetadata(block: any): NonNullable<ManifestBlock['draftMetadata']> | undefined {
  const metadata = stripUndefined({
    sourceQuestion: typeof block.sourceQuestion === 'string' ? block.sourceQuestion : undefined,
    sourceBlock: typeof block.sourceBlock === 'string' ? block.sourceBlock : undefined,
    followupKind: typeof block.followupKind === 'string' ? block.followupKind : undefined,
    requestedFilters: Array.isArray(block.requestedFilters) ? block.requestedFilters : undefined,
    requestedDimensions: Array.isArray(block.requestedDimensions) ? block.requestedDimensions : undefined,
    contextPackId: typeof block.contextPackId === 'string' ? block.contextPackId : undefined,
    routeIntent: typeof block.routeIntent === 'string' ? block.routeIntent : undefined,
    askedTimes: typeof block.askedTimes === 'number' ? block.askedTimes : undefined,
    validationWarnings: Array.isArray(block.validationWarnings) ? block.validationWarnings : undefined,
    proposedContractId: typeof block.proposedContractId === 'string' ? block.proposedContractId : undefined,
    proposedDomain: typeof block.proposedDomain === 'string' ? block.proposedDomain : undefined,
    proposedEntity: typeof block.proposedEntity === 'string' ? block.proposedEntity : undefined,
    upstreamRefs: Array.isArray(block.upstreamRefs) ? block.upstreamRefs : undefined,
    firstAsked: typeof block.firstAsked === 'string' ? block.firstAsked : undefined,
    lastAsked: typeof block.lastAsked === 'string' ? block.lastAsked : undefined,
  });
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function extractTests(block: any): string[] {
  if (Array.isArray(block.tests)) {
    return block.tests.map((a: any) => {
      if (typeof a === 'string') return a;
      const expected = formatManifestTestExpected(a.expected);
      return `${a.field ?? ''} ${a.operator ?? ''} ${expected}`.trim();
    });
  }
  if (!block.tests?.assertions) return [];
  return block.tests.assertions.map((a: any) => {
    if (typeof a === 'string') return a;
    return `${a.field ?? ''} ${a.operator ?? ''} ${a.expected ?? ''}`.trim();
  });
}

function formatManifestTestExpected(node: any): string {
  if (!node || typeof node !== 'object') return String(node ?? '');
  switch (node.kind) {
    case 'StringLiteral':
      return JSON.stringify(node.value);
    case 'NumberLiteral':
    case 'BooleanLiteral':
      return String(node.value);
    case 'Identifier':
      return node.name;
    case 'ArrayLiteral':
      return `[${(node.elements ?? []).map(formatManifestTestExpected).join(', ')}]`;
    default:
      return String(node.value ?? '');
  }
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
