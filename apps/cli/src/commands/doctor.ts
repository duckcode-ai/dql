import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { resolveSemanticLayerWithDiagnostics } from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';
import {
  assertLocalQueryRuntimeReady,
  findProjectRoot,
  getConnectorInstallStatuses,
  loadProjectConfig,
} from '../local-runtime.js';

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
    checkProjectCliVersion(projectRoot),
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
  const nextSteps = [
    'npm run notebook    # open the local DQL workspace',
    'npm run validate    # check DQL files and semantic references',
    'npm run compile     # write dql-manifest.json',
    'npm run lineage     # inspect source -> block -> dashboard -> App lineage',
  ];

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      ok: passed === checks.length,
      projectRoot,
      checks,
      nextSteps,
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
  console.log('  Next local-first steps:');
  for (const step of nextSteps) {
    console.log(`    ${step}`);
  }
  console.log('');
  console.log('  OSS note: certification, personas, and policies are local single-user trust previews.');
  console.log('');
}

function checkNodeVersion(): Check {
  const match = process.versions.node.match(/^(\d+)/);
  const major = match ? Number(match[1]) : 0;
  return {
    name: 'Node.js',
    ok: major >= 20 && major < 23,
    detail: `version=${process.versions.node} (requires Node 20 or 22 LTS; Node 23 is not supported for native local drivers)`,
  };
}

function checkProjectCliVersion(projectRoot: string): Check {
  const packageJsonPath = join(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return {
      name: 'Project-local DQL CLI',
      ok: true,
      detail: 'no project package.json; skipping local CLI check',
    };
  }

  let declared: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    declared = pkg.devDependencies?.['@duckcodeailabs/dql-cli'] ?? pkg.dependencies?.['@duckcodeailabs/dql-cli'];
  } catch {
    return {
      name: 'Project-local DQL CLI',
      ok: false,
      detail: 'failed to parse package.json',
    };
  }

  if (!declared) {
    return {
      name: 'Project-local DQL CLI',
      ok: true,
      detail: 'not declared in package.json (optional for non-scaffolded projects)',
    };
  }

  const runningVersion = readRunningCliVersion();
  const installedPackage = join(projectRoot, 'node_modules', '@duckcodeailabs', 'dql-cli', 'package.json');
  if (!existsSync(installedPackage)) {
    return {
      name: 'Project-local DQL CLI',
      ok: false,
      detail: `package.json declares @duckcodeailabs/dql-cli ${declared}, but node_modules is missing. Run npm install, then npm run notebook or npx dql.`,
    };
  }

  try {
    const installed = JSON.parse(readFileSync(installedPackage, 'utf-8')) as { version?: string };
    if (installed.version && runningVersion !== 'unknown' && installed.version !== runningVersion) {
      return {
        name: 'Project-local DQL CLI',
        ok: false,
        detail: `running dql ${runningVersion}, but project-local @duckcodeailabs/dql-cli is ${installed.version}. Use npm run notebook, npm run compile, or ./node_modules/.bin/dql.`,
      };
    }
    return {
      name: 'Project-local DQL CLI',
      ok: true,
      detail: `declared=${declared}, installed=${installed.version ?? 'unknown'}, running=${runningVersion}`,
    };
  } catch {
    return {
      name: 'Project-local DQL CLI',
      ok: false,
      detail: 'failed to parse project-local @duckcodeailabs/dql-cli/package.json',
    };
  }
}

function readRunningCliVersion(): string {
  try {
    const commandDir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(commandDir, '../package.json'), 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function checkDuckDBDependency(projectRoot: string): Check {
  const status = getConnectorInstallStatuses(projectRoot).find((item) => item.driver === 'duckdb');
  if (!status) {
    return {
      name: 'DuckDB connector package',
      ok: false,
      detail: 'DuckDB connector status was not available.',
    };
  }

  return {
    name: 'DuckDB connector package',
    ok: status.installed,
    detail: status.installed
      ? `installed at ${status.installPath} or project node_modules`
      : `missing; install from the notebook Connections page or run ${status.installCommand}`,
  };
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
