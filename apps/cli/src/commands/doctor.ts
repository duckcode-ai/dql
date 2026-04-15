import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { resolveSemanticLayerWithDiagnostics } from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';
import { assertLocalQueryRuntimeReady, findProjectRoot, loadProjectConfig } from '../local-runtime.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(targetPath: string | null, flags: CLIFlags): Promise<void> {
  const cwd = resolve(targetPath || '.');
  const projectRoot = findProjectRoot(cwd);
  const config = loadProjectConfig(projectRoot);

  // loadProjectConfig normalizes connections.default → defaultConnection
  const defaultConnection = config.defaultConnection;

  // Detect dbt project for conditional checks
  const isDbt = existsSync(join(projectRoot, 'dbt_project.yml'));

  // For dbt projects, semantic-layer/ dir is not needed (dbt provides it)
  const hasSemanticLayerDir = existsSync(join(projectRoot, 'semantic-layer'));
  const semanticLayerOk = isDbt || hasSemanticLayerDir;
  const semanticLayerDetail = isDbt
    ? (hasSemanticLayerDir ? 'found' : 'provided by dbt')
    : (hasSemanticLayerDir ? 'found' : 'missing');

  // data/ is optional
  const hasDataDir = existsSync(join(projectRoot, 'data'));

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
      ok: semanticLayerOk,
      detail: semanticLayerDetail,
    },
    {
      name: 'data/',
      ok: true,
      detail: hasDataDir ? 'found' : 'not found (optional)',
    },
    {
      name: 'Default connection',
      ok: Boolean(defaultConnection?.driver),
      detail: defaultConnection?.driver ? `driver=${defaultConnection.driver}` : 'not configured',
    },
    checkSemanticLayer(config.semanticLayer, projectRoot),
  ];

  checks.push(checkNotebookAssets());

  if (defaultConnection?.driver === 'file' || defaultConnection?.driver === 'duckdb') {
    checks.push(checkDuckDBDependency(projectRoot));
  }
  if (defaultConnection?.driver) {
    checks.push(await checkLocalQueryRuntime(projectRoot, defaultConnection));
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

function checkSemanticLayer(semanticConfig: unknown, projectRoot: string): Check {
  try {
    const result = resolveSemanticLayerWithDiagnostics(
      semanticConfig as Parameters<typeof resolveSemanticLayerWithDiagnostics>[0],
      projectRoot,
    );

    if (result.errors.length > 0) {
      return {
        name: 'Semantic layer',
        ok: false,
        detail: result.errors.join('; '),
      };
    }

    if (!result.layer) {
      return {
        name: 'Semantic layer',
        ok: true,
        detail: 'not configured (optional)',
      };
    }

    const metrics = result.layer.listMetrics().length;
    const dims = result.layer.listDimensions().length;
    const provider = result.detectedProvider ?? 'configured';
    return {
      name: 'Semantic layer',
      ok: true,
      detail: `provider=${provider}, ${metrics} metrics, ${dims} dimensions`,
    };
  } catch (err) {
    return {
      name: 'Semantic layer',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkNotebookAssets(): Check {
  const commandDir = dirname(fileURLToPath(import.meta.url));
  const reactAppDir = resolve(commandDir, '../assets/dql-notebook');
  const legacyAppDir = resolve(commandDir, '../assets/notebook-browser');
  const hasReact = existsSync(join(reactAppDir, 'index.html'));
  const hasLegacy = existsSync(join(legacyAppDir, 'index.html'));
  return {
    name: 'Notebook app assets',
    ok: hasReact || hasLegacy,
    detail: hasReact || hasLegacy
      ? 'found'
      : 'missing — try reinstalling: npm i -g @duckcodeailabs/dql-cli',
  };
}

async function checkLocalQueryRuntime(projectRoot: string, connection: NonNullable<ReturnType<typeof loadProjectConfig>['defaultConnection']>): Promise<Check> {
  const previousCwd = process.cwd();
  const executor = new QueryExecutor();

  try {
    process.chdir(projectRoot);
    await assertLocalQueryRuntimeReady(executor, connection);
    return {
      name: 'Local query runtime',
      ok: true,
      detail: `driver=${connection.driver} is available`,
    };
  } catch (error) {
    return {
      name: 'Local query runtime',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    process.chdir(previousCwd);
    await executor.disconnect().catch(() => {});
  }
}
