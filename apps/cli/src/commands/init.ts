import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { createWelcomeNotebook, serializeNotebook } from '@duckcodeailabs/dql-notebook';
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

  // Detect DuckDB file in the directory
  const duckdbPath = detectDuckDBFile(targetDir);

  // Don't overwrite existing dql.config.json
  const configPath = join(targetDir, 'dql.config.json');
  if (!existsSync(configPath)) {
    const config = buildConfig(projectName, isDbt, duckdbPath, dbtProjectDir, targetDir);
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }

  // Create DQL directories
  const dirs = ['blocks', 'notebooks'];
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
    '\n# DQL\ndql-manifest.json\n*.duckdb\n*.duckdb.wal\n.dql/runs/\n.dql/cache/\n*.dqlnb.run.json\n*.dql.run.json\n';
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
    const driver = configJson?.connections?.default?.driver ?? 'duckdb';
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
        projectPath: '.',
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
  console.log(`    DuckDB file: ${duckdbPath ?? 'none (using :memory:)'}`);
  if (isDbt) {
    console.log(`    Semantic layer: ${importedSemanticCatalog ? 'imported dbt catalog into semantic-layer/' : hasDbtSemanticDefinitions ? 'dbt project with semantic definitions detected' : 'dbt project detected (no semantic definitions imported)'}`);
  }
  console.log('');
  console.log('  Created:');
  console.log('    dql.config.json');
  console.log('    blocks/');
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
      console.log(`    ${step + 4}. dql compile --dbt-manifest target/manifest.json`);
    } else {
      console.log(`    ${step + 3}. dql compile --dbt-manifest target/manifest.json`);
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

function detectDuckDBFile(dir: string): string | null {
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
  for (const candidate of candidates) {
    if (existsSync(join(dir, candidate))) {
      return candidate;
    }
  }
  // Search root directory for any .duckdb file
  try {
    const entries = readdirSync(dir);
    const duckdb = entries.find((e: string) => e.endsWith('.duckdb'));
    return duckdb ?? null;
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
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    project: projectName,
    connections: {
      default: {
        driver: 'duckdb',
        filepath: duckdbPath ?? ':memory:',
      },
    },
  };

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
