import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createWelcomeNotebook, serializeNotebook } from '@duckcodeailabs/dql-notebook';
import type { CLIFlags } from '../args.js';
import { runNotebook } from './notebook.js';

export async function runInit(targetArg: string | null, flags: CLIFlags): Promise<void> {
  const targetDir = resolve(targetArg || '.');
  const projectName = basename(targetDir) || 'dql-project';

  // Create target directory if it doesn't exist
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  // Detect if this is a dbt project
  const isDbt = existsSync(join(targetDir, 'dbt_project.yml'));

  // Detect DuckDB file in the directory
  const duckdbPath = detectDuckDBFile(targetDir);

  // Don't overwrite existing dql.config.json
  const configPath = join(targetDir, 'dql.config.json');
  if (!existsSync(configPath)) {
    const config = buildConfig(projectName, isDbt, duckdbPath);
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
  const dqlIgnoreEntries = '\n# DQL\ndql-manifest.json\n*.duckdb\n*.duckdb.wal\n';
  if (existsSync(gitignorePath)) {
    const existing = readFileSync(gitignorePath, 'utf-8');
    if (!existing.includes('dql-manifest.json')) {
      writeFileSync(gitignorePath, existing + dqlIgnoreEntries);
    }
  } else {
    writeFileSync(gitignorePath, 'node_modules/\n' + dqlIgnoreEntries);
  }

  // Create welcome notebook
  const notebookPath = join(targetDir, 'notebooks', 'welcome.dqlnb');
  if (!existsSync(notebookPath)) {
    const nb = createWelcomeNotebook(isDbt ? 'dbt' : 'default', projectName);
    writeFileSync(notebookPath, serializeNotebook(nb), 'utf-8');
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
  console.log(`    dbt project: ${isDbt ? 'yes (dbt_project.yml found)' : 'no'}`);
  console.log(`    DuckDB file: ${duckdbPath ?? 'none (using :memory:)'}`);
  if (isDbt) {
    console.log('    Semantic layer: dbt provider');
  }
  console.log('');
  console.log('  Created:');
  console.log('    dql.config.json');
  console.log('    blocks/');
  console.log('    notebooks/welcome.dqlnb');
  console.log('');
  console.log('  Next steps:');
  const step = targetArg && targetArg !== '.' ? 1 : 0;
  if (step === 1) console.log(`    ${step}. cd ${targetArg}`);
  console.log(`    ${step + 1}. dql doctor`);
  console.log(`    ${step + 2}. dql notebook`);
  if (isDbt) {
    console.log(`    ${step + 3}. dql compile --dbt-manifest target/manifest.json`);
  }
  console.log('');

  if (flags.open) {
    await runNotebook(targetDir, flags);
  }
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
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    project: projectName,
    connections: {
      default: {
        driver: 'duckdb',
        path: duckdbPath ?? ':memory:',
      },
    },
  };

  if (isDbt) {
    config.semanticLayer = {
      provider: 'dbt',
      projectPath: '.',
    };
  } else {
    config.semanticLayer = {
      provider: 'dql',
    };
  }

  return config;
}
