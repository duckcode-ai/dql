import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CLIFlags } from '../args.js';
import { findProjectRoot, loadProjectConfig } from '../local-runtime.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(targetPath: string | null, flags: CLIFlags): Promise<void> {
  const cwd = resolve(targetPath || '.');
  const projectRoot = findProjectRoot(cwd);
  const config = loadProjectConfig(projectRoot);

  const checks: Check[] = [
    checkNodeVersion(),
    {
      name: 'Project root',
      ok: existsSync(projectRoot),
      detail: projectRoot,
    },
    {
      name: 'dql.config.json',
      ok: existsSync(join(projectRoot, 'dql.config.json')),
      detail: existsSync(join(projectRoot, 'dql.config.json')) ? 'found' : 'missing',
    },
    {
      name: 'blocks/',
      ok: existsSync(join(projectRoot, 'blocks')),
      detail: existsSync(join(projectRoot, 'blocks')) ? 'found' : 'missing',
    },
    {
      name: 'semantic-layer/',
      ok: existsSync(join(projectRoot, 'semantic-layer')),
      detail: existsSync(join(projectRoot, 'semantic-layer')) ? 'found' : 'missing',
    },
    {
      name: 'data/',
      ok: existsSync(join(projectRoot, 'data')),
      detail: existsSync(join(projectRoot, 'data')) ? 'found' : 'missing',
    },
    {
      name: 'Default connection',
      ok: Boolean(config.defaultConnection?.driver),
      detail: config.defaultConnection?.driver ? `driver=${config.defaultConnection.driver}` : 'not configured',
    },
  ];

  if (config.defaultConnection?.driver === 'file' || config.defaultConnection?.driver === 'duckdb') {
    checks.push(checkDuckDBDependency(projectRoot));
  }

  const passed = checks.filter((check) => check.ok).length;

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      ok: passed === checks.length,
      projectRoot,
      checks,
    }, null, 2));
    return;
  }

  console.log(`\n  DQL Doctor`);
  console.log(`    Project: ${projectRoot}`);
  console.log('');
  for (const check of checks) {
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.name}`);
    console.log(`    ${check.detail}`);
  }
  console.log('');
  console.log(`  Summary: ${passed}/${checks.length} checks passed`);
  console.log('');
}

function checkNodeVersion(): Check {
  const match = process.versions.node.match(/^(\d+)/);
  const major = match ? Number(match[1]) : 0;
  return {
    name: 'Node.js',
    ok: major >= 18,
    detail: `version=${process.versions.node} (requires >= 18)` ,
  };
}

function checkDuckDBDependency(projectRoot: string): Check {
  const packageJsonPath = join(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return {
      name: 'duckdb dependency',
      ok: true,
      detail: 'no project package.json; skipping dependency check',
    };
  }

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const hasDuckDB = Boolean(pkg.dependencies?.duckdb || pkg.devDependencies?.duckdb);
    return {
      name: 'duckdb dependency',
      ok: hasDuckDB,
      detail: hasDuckDB ? 'duckdb listed in package.json' : 'add duckdb for file/duckdb local preview support',
    };
  } catch {
    return {
      name: 'duckdb dependency',
      ok: false,
      detail: 'failed to parse package.json',
    };
  }
}
