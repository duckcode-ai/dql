import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { createWelcomeNotebook, serializeNotebook } from '@duckcodeailabs/dql-notebook';
import { resolveLocalOwner } from '@duckcodeailabs/dql-agent';
import type { CLIFlags } from '../args.js';
import { performSemanticImport } from '../semantic-import.js';
import { runNotebook } from './notebook.js';

export async function runInit(targetArg: string | null, flags: CLIFlags): Promise<void> {
  const targetDir = resolve(targetArg || '.');
  const projectName = basename(targetDir) || 'dql-project';

  // Create target directory if it doesn't exist
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  // Refuse to clobber a project that's already been initialized. `--force`
  // lets us patch missing dirs; it still won't overwrite config/notebooks.
  const alreadyInitialized =
    existsSync(join(targetDir, 'dql.config.json')) || existsSync(join(targetDir, 'cdql.yaml'));
  if (alreadyInitialized && !flags.force) {
    console.error('✗ This directory already has a DQL project (dql.config.json exists).');
    console.error('  Re-run with --force to patch missing dirs without overwriting config.');
    process.exitCode = 1;
    return;
  }

  // Detect if this is a dbt project — either *in* this directory, or as a
  // sibling (the canonical `acme/dbt/` + `acme/analytics/` layout).
  let isDbt = existsSync(join(targetDir, 'dbt_project.yml'));
  let dbtProjectDir: string | null = isDbt ? targetDir : null;
  if (!dbtProjectDir) {
    for (const rel of ['..', '../..', '../dbt', '../../dbt']) {
      const probe = join(targetDir, rel, 'dbt_project.yml');
      if (existsSync(probe)) {
        dbtProjectDir = resolve(targetDir, rel);
        isDbt = true;
        break;
      }
    }
  }
  const hasDbtSemanticDefinitions = dbtProjectDir
    ? containsDbtSemanticDefinitions(join(dbtProjectDir, 'models'))
    : false;

  // Detect DuckDB file — in the workspace OR the dbt project dir (common layout:
  // the .duckdb lives next to dbt_project.yml, a level up from the DQL workspace).
  const duckdbPath = detectDuckDBFile(targetDir, dbtProjectDir);

  // Don't overwrite existing dql.config.json
  const configPath = join(targetDir, 'dql.config.json');
  if (!existsSync(configPath)) {
    // Resolve the local OSS owner up front (git user.email → $USER → guest@local)
    // and persist it as identity.owner so drafts are never born "Missing owner".
    const owner = resolveLocalOwner(targetDir, { persist: false });
    const config = buildConfig(projectName, isDbt, duckdbPath, dbtProjectDir, targetDir, owner);
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }

  // Create DQL directories
  const dirs = ['blocks', 'terms', 'business-views', 'notebooks', 'apps'];
  if (!isDbt) {
    dirs.push('semantic-layer', 'semantic-layer/metrics', 'semantic-layer/dimensions');
  }
  for (const dir of dirs) {
    const dirPath = join(targetDir, dir);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  }

  // Create .gitignore for DQL artifacts
  const gitignorePath = join(targetDir, '.gitignore');
  const dqlIgnoreEntries =
    '\n# DQL\ndql-manifest.json\n*.duckdb\n*.duckdb.wal\n.dql/runs/\n.dql/cache/\n.dql/imports/\n.dql/local/\n*.dqlnb.run.json\n*.dql.run.json\n';
  if (existsSync(gitignorePath)) {
    const existing = readFileSync(gitignorePath, 'utf-8');
    if (!existing.includes('dql-manifest.json')) {
      writeFileSync(gitignorePath, existing + dqlIgnoreEntries);
    }
  } else {
    writeFileSync(gitignorePath, 'node_modules/\n' + dqlIgnoreEntries);
  }

  // Create welcome notebook with driver-aware SQL
  const notebookPath = join(targetDir, 'notebooks', 'welcome.dqlnb');
  if (!existsSync(notebookPath)) {
    const configJson = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {};
    const defaultConnectionName = typeof configJson?.defaultConnectionName === 'string'
      ? configJson.defaultConnectionName
      : 'default';
    const driver = configJson?.connections?.[defaultConnectionName]?.driver
      ?? configJson?.connections?.default?.driver;
    const nb = createWelcomeNotebook(isDbt ? 'dbt' : 'default', projectName, driver);
    writeFileSync(notebookPath, serializeNotebook(nb), 'utf-8');
  }

  let importedSemanticCatalog = false;
  if (isDbt && hasDbtSemanticDefinitions && !existsSync(join(targetDir, 'semantic-layer', 'imports', 'manifest.json'))) {
    await performSemanticImport({
      targetProjectRoot: targetDir,
      provider: 'dbt',
      sourceConfig: {
        provider: 'dbt',
        projectPath: dbtProjectDir ? relativePath(targetDir, dbtProjectDir) : '.',
      },
    });
    importedSemanticCatalog = true;
  }

  // Output
  if (flags.format === 'json') {
    console.log(JSON.stringify({
      project: projectName,
      path: targetDir,
      created: true,
      dbt: isDbt,
      duckdb: duckdbPath ?? null,
    }, null, 2));
    return;
  }

  console.log(`\n  ✓ DQL project initialized: ${projectName}`);
  console.log(`    Path: ${targetDir}`);
  console.log('');
  console.log('  Detected:');
  if (isDbt && dbtProjectDir && dbtProjectDir !== targetDir) {
    console.log(`    dbt project: sibling at ${dbtProjectDir}`);
  } else {
    console.log(`    dbt project: ${isDbt ? 'yes (dbt_project.yml found)' : 'no'}`);
  }
  console.log(`    DuckDB file: ${duckdbPath ?? 'none'}`);
  if (isDbt) {
    console.log(`    Semantic layer: ${importedSemanticCatalog ? 'imported dbt catalog into semantic-layer/' : hasDbtSemanticDefinitions ? 'dbt project with semantic definitions detected' : 'dbt project detected (no semantic definitions imported)'}`);
  }
  console.log('');
  console.log('  Created:');
  console.log('    dql.config.json');
  console.log('    blocks/');
  console.log('    terms/');
  console.log('    business-views/');
  console.log('    apps/');
  console.log('    notebooks/welcome.dqlnb');
  if (importedSemanticCatalog) {
    console.log('    semantic-layer/ (imported local semantic catalog)');
  }
  console.log('');
  console.log('  Next steps:');
  const step = targetArg && targetArg !== '.' ? 1 : 0;
  if (step === 1) console.log(`    ${step}. cd ${targetArg}`);
  console.log(`    ${step + 1}. dql doctor`);
  console.log(`    ${step + 2}. dql notebook`);
  if (isDbt) {
    if (!importedSemanticCatalog && hasDbtSemanticDefinitions) {
      console.log(`    ${step + 3}. dql semantic import dbt .`);
      console.log(`    ${step + 4}. dql compile .`);
      console.log(`    ${step + 5}. dql sync dbt .`);
    } else {
      console.log(`    ${step + 3}. dql compile .`);
      console.log(`    ${step + 4}. dql sync dbt .`);
    }
  }
  console.log('');

  if (flags.open) {
    await runNotebook(targetDir, flags);
  }
}

function containsDbtSemanticDefinitions(root: string): boolean {
  if (!existsSync(root)) return false;

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry);
      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) continue;

      try {
        const contents = readFileSync(fullPath, 'utf-8');
        if (contents.includes('semantic_models:') || contents.includes('\nmetrics:') || contents.startsWith('metrics:')) {
          return true;
        }
      } catch {
        // Ignore unreadable files during best-effort detection.
      }
    }
  }

  return false;
}

function detectDuckDBFile(workspaceDir: string, dbtProjectDir: string | null): string | null {
  // Common DuckDB file locations in dbt projects
  const candidates = [
    'jaffle_shop.duckdb',
    'dev.duckdb',
    'database.duckdb',
    'analytics.duckdb',
    'target/dev.duckdb',
    'target/jaffle_shop.duckdb',
    'reports/jaffle_shop.duckdb',
  ];
  // 1. The DQL workspace itself — store a bare relative path.
  for (const candidate of candidates) {
    if (existsSync(join(workspaceDir, candidate))) return candidate;
  }
  const inWorkspace = firstDuckDBIn(workspaceDir);
  if (inWorkspace) return inWorkspace;

  // 2. The dbt project dir (often a level up). Store the path RELATIVE TO THE
  // workspace (e.g. `../jaffle_shop.duckdb`) so the stored connection — which
  // resolves relative filepaths against the workspace — opens the real file.
  if (dbtProjectDir && resolve(dbtProjectDir) !== resolve(workspaceDir)) {
    for (const candidate of candidates) {
      const abs = join(dbtProjectDir, candidate);
      if (existsSync(abs)) return relative(workspaceDir, abs) || candidate;
    }
    const inDbt = firstDuckDBIn(dbtProjectDir);
    if (inDbt) return relative(workspaceDir, join(dbtProjectDir, inDbt)) || inDbt;
  }
  return null;
}

function firstDuckDBIn(dir: string): string | null {
  try {
    return readdirSync(dir).find((entry: string) => entry.endsWith('.duckdb')) ?? null;
  } catch {
    return null;
  }
}

function buildConfig(
  projectName: string,
  isDbt: boolean,
  duckdbPath: string | null,
  dbtProjectDir: string | null,
  projectRoot: string,
  owner?: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    project: projectName,
  };

  // Persist the resolved local owner so AI-drafted blocks pass the Certifier's
  // owner rule out of the box (humans still certify).
  if (owner && owner.trim()) {
    config.identity = { owner: owner.trim() };
  }

  if (duckdbPath) {
    config.defaultConnectionName = 'default';
    config.connections = {
      default: {
        driver: 'duckdb',
        filepath: duckdbPath,
      },
    };
  }

  if (isDbt) {
    // Normalize dbt path to a repo-relative form if possible — makes
    // dql.config.json portable across machines.
    const projectPath =
      dbtProjectDir && dbtProjectDir !== projectRoot
        ? relativePath(projectRoot, dbtProjectDir)
        : '.';
    config.semanticLayer = {
      provider: 'dbt',
      projectPath,
    };
    // Tell `dql sync dbt` and `dql compile` where to find target/manifest.json
    // without requiring --dbt-manifest on every invocation.
    config.dbt = {
      projectDir: projectPath,
      manifestPath: 'target/manifest.json',
    };
  } else {
    config.semanticLayer = {
      provider: 'dql',
    };
  }

  return config;
}

function relativePath(from: string, to: string): string {
  return relative(from, to) || '.';
}
