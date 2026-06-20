import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { buildManifest, collectInputFiles, resolveSemanticLayerWithDiagnostics } from '@duckcodeailabs/dql-core';
import { buildLocalContextPack, defaultKgPath, defaultMetadataPath, openMetadataCatalog } from '@duckcodeailabs/dql-agent';
import type { CLIFlags } from '../args.js';
import {
  assertLocalQueryRuntimeReady,
  findProjectRoot,
  getConnectorInstallStatuses,
  loadProjectConfig,
  normalizeProjectConnection,
  resolveProjectSemanticConfig,
} from '../local-runtime.js';
import { listRemoteMcpSettings } from '../llm/mcp-config.js';
import { listProviderSettings } from '../settings/provider-settings.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(targetPath: string | null, flags: CLIFlags): Promise<void> {
  if (targetPath === 'scale') {
    await runDoctorScale(null, flags);
    return;
  }

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
      ok: true,
      detail: defaultConnection?.driver
        ? `driver=${defaultConnection.driver}`
        : 'not configured yet; add Databricks, DuckDB/file, or Snowflake in the notebook Connections page',
    },
    checkSemanticLayer(resolveProjectSemanticConfig(config, projectRoot), projectRoot),
  ];

  checks.push(checkNotebookAssets());

  if (defaultConnection?.driver === 'file' || defaultConnection?.driver === 'duckdb') {
    checks.push(checkDuckDBDependency(projectRoot));
  }
  if (defaultConnection?.driver) {
    checks.push(await checkLocalQueryRuntime(projectRoot, defaultConnection));
  }
  if (flags.ai) {
    checks.push(...checkAiRuntime(projectRoot));
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

interface ScaleIssue {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
}

interface ScaleReport {
  ok: boolean;
  projectRoot: string;
  counts: Record<string, number>;
  cache: {
    manifestFresh: boolean;
    manifestAgeMs: number | null;
    metadataCatalog: { exists: boolean; path: string; sizeBytes: number | null };
    agentKg: { exists: boolean; path: string; sizeBytes: number | null };
    contextPackMs: number | null;
    contextPackObjects: number | null;
    sourceFingerprints: number | null;
    domainShards: number | null;
  };
  issues: ScaleIssue[];
}

async function runDoctorScale(targetPath: string | null, flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(resolve(targetPath || '.'));
  const started = Date.now();
  const manifest = buildManifest({ projectRoot });
  const inputFiles = collectInputFiles({ projectRoot });
  const manifestPath = join(projectRoot, 'dql-manifest.json');
  const manifestFresh = isManifestFresh(manifestPath, inputFiles);
  const metadataPath = defaultMetadataPath(projectRoot);
  const kgPath = defaultKgPath(projectRoot);
  const contextStarted = Date.now();
  let contextPackMs: number | null = null;
  let contextPackObjects: number | null = null;
  let sourceFingerprints: number | null = null;
  let domainShards: number | null = null;
  const issues: ScaleIssue[] = [];

  if (existsSync(metadataPath)) {
    try {
      const catalog = openMetadataCatalog(projectRoot);
      try {
        sourceFingerprints = catalog.sourceFingerprints(10000).length;
        domainShards = catalog.domainShards(1000).length;
      } finally {
        catalog.close();
      }
      const pack = await buildLocalContextPack(projectRoot, {
        question: 'DQL doctor scale retrieval check for enterprise metadata coverage',
        mode: 'debug',
        surface: 'doctor',
        limit: 25,
      });
      contextPackMs = Date.now() - contextStarted;
      contextPackObjects = pack.objects.length;
      if (sourceFingerprints === 0) {
        issues.push({
          severity: 'warning',
          code: 'source_fingerprints_missing',
          message: 'metadata.sqlite has no source fingerprints. Run dql compile or dql agent reindex with the current CLI to refresh the scale index.',
        });
      }
      if (domainShards === 0) {
        issues.push({
          severity: 'warning',
          code: 'domain_shards_missing',
          message: 'metadata.sqlite has no domain shard stats. Run dql compile or dql agent reindex with the current CLI to refresh the scale index.',
        });
      }
    } catch (error) {
      issues.push({
        severity: 'warning',
        code: 'context_pack_failed',
        message: `Metadata retrieval check failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  } else {
    issues.push({
      severity: 'warning',
      code: 'metadata_catalog_missing',
      message: 'metadata.sqlite is missing. Run dql compile or dql agent reindex before AI import and Ask AI workflows.',
    });
  }

  if (!existsSync(kgPath)) {
    issues.push({
      severity: 'warning',
      code: 'agent_kg_missing',
      message: 'agent-kg.sqlite is missing. Run dql agent reindex for scalable agent retrieval.',
    });
  }
  if (!manifestFresh) {
    issues.push({
      severity: 'warning',
      code: 'manifest_stale',
      message: 'dql-manifest.json is missing or older than at least one tracked project input.',
    });
  }

  const declaredDomains = new Set(Object.keys(manifest.domains ?? {}));
  const usedDomains = new Set<string>();
  for (const block of Object.values(manifest.blocks)) if (block.domain) usedDomains.add(block.domain);
  for (const term of Object.values(manifest.terms ?? {})) if (term.domain) usedDomains.add(term.domain);
  for (const view of Object.values(manifest.businessViews ?? {})) if (view.domain) usedDomains.add(view.domain);
  const missingDomains = [...usedDomains].filter((domain) => !declaredDomains.has(domain));
  if (missingDomains.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'missing_domain_declarations',
      message: `${missingDomains.length} used domain(s) have no first-class domain declaration: ${missingDomains.slice(0, 10).join(', ')}${missingDomains.length > 10 ? '...' : ''}`,
    });
  }
  const missingEnterpriseMetadata = Object.values(manifest.blocks).filter((block) =>
    !block.pattern || !block.grain || !(block.declaredOutputs?.length),
  );
  if (missingEnterpriseMetadata.length > 0) {
    issues.push({
      severity: 'info',
      code: 'block_contract_gaps',
      message: `${missingEnterpriseMetadata.length} block(s) are missing pattern, grain, or declared outputs.`,
    });
  }
  if (contextPackMs !== null && contextPackMs > 1000) {
    issues.push({
      severity: 'warning',
      code: 'slow_context_pack',
      message: `Context-pack retrieval took ${contextPackMs}ms; target is under 1000ms for common questions.`,
    });
  }

  const report: ScaleReport = {
    ok: !issues.some((issue) => issue.severity === 'error'),
    projectRoot,
    counts: {
      domains: Object.keys(manifest.domains ?? {}).length,
      blocks: Object.keys(manifest.blocks).length,
      certifiedBlocks: Object.values(manifest.blocks).filter((block) => block.status === 'certified').length,
      draftBlocks: Object.values(manifest.blocks).filter((block) => block.status === 'draft').length,
      terms: Object.keys(manifest.terms ?? {}).length,
      businessViews: Object.keys(manifest.businessViews ?? {}).length,
      apps: Object.keys(manifest.apps ?? {}).length,
      dashboards: Object.keys(manifest.dashboards ?? {}).length,
      semanticMetrics: Object.keys(manifest.metrics ?? {}).length,
      semanticDimensions: Object.keys(manifest.dimensions ?? {}).length,
      dbtModels: manifest.dbtImport?.dbtDag?.models?.length ?? 0,
      dbtSources: manifest.dbtImport?.sourcesImported ?? 0,
      lineageNodes: manifest.lineage.nodes.length,
      lineageEdges: manifest.lineage.edges.length,
      diagnostics: manifest.diagnostics?.length ?? 0,
    },
    cache: {
      manifestFresh,
      manifestAgeMs: manifestAgeMs(manifestPath),
      metadataCatalog: fileState(metadataPath),
      agentKg: fileState(kgPath),
      contextPackMs,
      contextPackObjects,
      sourceFingerprints,
      domainShards,
    },
    issues,
  };

  if (flags.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\n  DQL Doctor Scale');
  console.log(`    Project: ${projectRoot}`);
  console.log(`    Checked in ${Date.now() - started}ms`);
  console.log('');
  console.log('  Counts:');
  for (const [key, value] of Object.entries(report.counts)) {
    console.log(`    ${key}: ${value}`);
  }
  console.log('');
  console.log('  Cache:');
  console.log(`    manifest fresh: ${report.cache.manifestFresh ? 'yes' : 'no'}`);
  console.log(`    metadata.sqlite: ${report.cache.metadataCatalog.exists ? formatBytes(report.cache.metadataCatalog.sizeBytes ?? 0) : 'missing'}`);
  console.log(`    agent-kg.sqlite: ${report.cache.agentKg.exists ? formatBytes(report.cache.agentKg.sizeBytes ?? 0) : 'missing'}`);
  console.log(`    context pack: ${report.cache.contextPackMs === null ? 'not checked' : `${report.cache.contextPackMs}ms, ${report.cache.contextPackObjects} objects`}`);
  console.log(`    source fingerprints: ${report.cache.sourceFingerprints === null ? 'not checked' : report.cache.sourceFingerprints}`);
  console.log(`    domain shards: ${report.cache.domainShards === null ? 'not checked' : report.cache.domainShards}`);
  if (issues.length > 0) {
    console.log('');
    console.log('  Issues:');
    for (const issue of issues) {
      console.log(`    ${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`);
    }
  }
  console.log('');
}

function isManifestFresh(manifestPath: string, inputFiles: string[]): boolean {
  if (!existsSync(manifestPath)) return false;
  const manifestMtime = statSync(manifestPath).mtimeMs;
  return inputFiles.every((filePath) => {
    try {
      return statSync(filePath).mtimeMs <= manifestMtime;
    } catch {
      return true;
    }
  });
}

function manifestAgeMs(manifestPath: string): number | null {
  if (!existsSync(manifestPath)) return null;
  return Math.max(0, Date.now() - statSync(manifestPath).mtimeMs);
}

function fileState(path: string): { exists: boolean; path: string; sizeBytes: number | null } {
  if (!existsSync(path)) return { exists: false, path, sizeBytes: null };
  return { exists: true, path, sizeBytes: statSync(path).size };
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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
    await assertLocalQueryRuntimeReady(executor, normalizeProjectConnection(connection, projectRoot));
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

function checkAiRuntime(projectRoot: string): Check[] {
  const providers = listProviderSettings(projectRoot);
  const active = providers.find((provider) => provider.active);
  const usableProviders = providers.filter((provider) =>
    provider.enabled &&
    provider.hasApiKey &&
    (provider.id !== 'ollama' || provider.active || provider.source !== 'none')
  );
  const mcp = listRemoteMcpSettings(projectRoot);
  const trustedMcp = mcp.entries.filter((entry) => entry.enabled && entry.trusted);
  const metadataPath = defaultMetadataPath(projectRoot);
  const kgPath = defaultKgPath(projectRoot);

  return [
    {
      name: 'AI provider',
      ok: Boolean(active?.enabled && active.hasApiKey) || usableProviders.length > 0,
      detail: active
        ? `${active.label} is active${active.model ? `, model=${active.model}` : ''}, source=${active.source}`
        : usableProviders.length > 0
          ? `${usableProviders.map((provider) => provider.label).join(', ')} configured; choose one in Connections`
          : 'no usable provider configured; add OpenAI, Anthropic Claude, or another provider in Connections',
    },
    {
      name: 'Provider fallback',
      ok: true,
      detail: 'DQL uses the selected provider and reports errors instead of silently falling back to another model.',
    },
    {
      name: 'MCP servers and connectors',
      ok: mcp.warnings.length === 0,
      detail: trustedMcp.length > 0
        ? `${trustedMcp.length} trusted enabled MCP connection(s); config=${mcp.path}`
        : mcp.warnings.length > 0
          ? mcp.warnings.join('; ')
          : `none configured yet; optional config path=${mcp.path}`,
    },
    {
      name: 'Metadata catalog',
      ok: existsSync(metadataPath),
      detail: existsSync(metadataPath)
        ? metadataPath
        : 'missing; run dql compile or dql agent reindex before deep ask/build flows',
    },
    {
      name: 'Agent knowledge index',
      ok: existsSync(kgPath),
      detail: existsSync(kgPath)
        ? kgPath
        : 'missing; run dql agent reindex before Claude Code/Codex ask flows',
    },
  ];
}
