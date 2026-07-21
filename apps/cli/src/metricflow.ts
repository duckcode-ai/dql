import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export type MetricFlowCliSource = 'env' | 'managed' | 'path';

export interface MetricFlowCliResolution {
  bin: string;
  source: MetricFlowCliSource;
  version: string;
}

export class MetricFlowUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricFlowUnavailableError';
  }
}

export interface MetricFlowQueryRequest {
  projectRoot: string;
  dbtProjectPath?: string;
  profilesDir?: string;
  metrics: string[];
  dimensions: string[];
  timeDimension?: { name: string; granularity: string };
  filters?: Array<{ dimension?: string; operator?: string; values?: string[]; expression?: string }>;
  orderBy?: Array<{ name: string; direction?: 'asc' | 'desc' }>;
  limit?: number;
  savedQuery?: string;
}

export function managedMetricFlowRuntimeRoot(projectRoot: string): string {
  return join(projectRoot, '.dql', 'runtimes', 'metricflow');
}

export function managedMetricFlowBin(projectRoot: string): string {
  return process.platform === 'win32'
    ? join(managedMetricFlowRuntimeRoot(projectRoot), 'Scripts', 'mf.exe')
    : join(managedMetricFlowRuntimeRoot(projectRoot), 'bin', 'mf');
}

/** Resolve the semantic compiler without mutating PATH. A DQL-managed,
 * project-local runtime is considered before the user's ambient executable so
 * Settings installations work after completion without restarting the server. */
// MetricFlow is a Python CLI: a cold start through a venv routinely takes
// 2-6+ seconds on a loaded machine. Probing with a tight timeout on EVERY
// request made readiness flap — pass when idle, time out under load — and the
// adapter then silently fell back to native, which read as "MetricFlow
// disconnects after connecting". Cache POSITIVE resolutions per binary for the
// process lifetime (a working binary stays trusted; if it is later removed,
// the actual compile fails with a clear error). Negative results are never
// cached so a Settings-installed runtime is discovered without a restart.
const metricFlowCliCache = new Map<string, MetricFlowCliResolution>();

export function resolveMetricFlowCli(projectRoot?: string): MetricFlowCliResolution | null {
  const explicit = process.env.DQL_METRICFLOW_BIN || process.env.METRICFLOW_BIN;
  const candidates: Array<{ bin: string; source: MetricFlowCliSource }> = explicit
    ? [{ bin: explicit, source: 'env' }]
    : [
        ...(projectRoot ? [{ bin: managedMetricFlowBin(projectRoot), source: 'managed' as const }] : []),
        { bin: 'mf', source: 'path' },
      ];
  for (const candidate of candidates) {
    if (candidate.source === 'managed' && !existsSync(candidate.bin)) continue;
    const cached = metricFlowCliCache.get(candidate.bin);
    if (cached) return cached;
    const result = spawnSync(candidate.bin, ['--version'], {
      encoding: 'utf-8',
      env: process.env,
      timeout: 10_000,
    });
    if (!result.error && result.status === 0) {
      const resolution: MetricFlowCliResolution = {
        ...candidate,
        version: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n')[0] ?? '',
      };
      metricFlowCliCache.set(candidate.bin, resolution);
      return resolution;
    }
  }
  return null;
}

export interface MetricFlowCompileResult {
  sql: string;
  command: string[];
  stdout: string;
  stderr: string;
}

export type MetricFlowCompileMode = 'legacy-compile' | 'explain';

/** dbt-metricflow 0.13 removed `mf query --compile`. Its quiet explain mode
 * emits only the compiled SQL and does not print the result table. Keep the
 * legacy flag for existing user-managed MetricFlow installations. */
export function metricFlowCompileMode(version: string): MetricFlowCompileMode {
  const match = /(?:version\s*)?(\d+)\.(\d+)\.(\d+)/i.exec(version);
  if (!match) return 'legacy-compile';
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 13 ? 'explain' : 'legacy-compile';
}

export function resolveDbtProjectRoot(projectRoot: string, configuredPath?: string): string {
  return configuredPath ? resolve(projectRoot, configuredPath) : projectRoot;
}

export function hasDbtSemanticManifest(projectRoot: string, configuredPath?: string): boolean {
  return existsSync(join(resolveDbtProjectRoot(projectRoot, configuredPath), 'target', 'semantic_manifest.json'));
}

/** Check whether the configured MetricFlow executable is callable. */
export function hasMetricFlowCli(projectRoot?: string): boolean {
  return resolveMetricFlowCli(projectRoot) !== null;
}

export function compileMetricFlowQuery(request: MetricFlowQueryRequest): MetricFlowCompileResult {
  const dbtRoot = resolveDbtProjectRoot(request.projectRoot, request.dbtProjectPath);
  if (!existsSync(join(dbtRoot, 'target', 'semantic_manifest.json'))) {
    throw new MetricFlowUnavailableError(
      'dbt semantic execution requires target/semantic_manifest.json. Run `dbt parse` or `dbt build` in the dbt project, then retry.',
    );
  }

  const resolvedCli = resolveMetricFlowCli(request.projectRoot);
  const bin = resolvedCli?.bin ?? process.env.DQL_METRICFLOW_BIN ?? process.env.METRICFLOW_BIN ?? 'mf';
  const args = buildMetricFlowArgs(request, metricFlowCompileMode(resolvedCli?.version ?? ''));
  const result = spawnSync(bin, args, {
    cwd: dbtRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...(request.profilesDir
        ? { DBT_PROFILES_DIR: resolve(request.projectRoot, request.profilesDir) }
        : {}),
    },
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MetricFlowUnavailableError(
        'MetricFlow CLI was not found. Install dbt Semantic Layer dependencies so `mf` is on PATH, or set DQL_METRICFLOW_BIN to the MetricFlow executable.',
      );
    }
    throw result.error;
  }

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.status !== 0) {
    throw new Error(`MetricFlow compile failed (${result.status}): ${stderr || stdout || 'no output'}`);
  }

  const sql = extractCompiledSql(stdout);
  if (!sql) {
    throw new Error('MetricFlow compile completed but no SQL statement was found in stdout.');
  }

  return {
    sql,
    command: [bin, ...args],
    stdout,
    stderr,
  };
}

function buildMetricFlowArgs(request: MetricFlowQueryRequest, mode: MetricFlowCompileMode): string[] {
  const args = mode === 'explain'
    ? ['query', '--explain', '--quiet']
    : ['query', '--compile'];
  if (request.savedQuery) {
    args.push('--saved-query', request.savedQuery);
  } else {
    if (request.metrics.length === 0) {
      throw new Error('MetricFlow semantic query requires at least one metric.');
    }
    args.push('--metrics', request.metrics.join(','));
    const groupBy = [...request.dimensions];
    if (request.timeDimension) {
      groupBy.push(`${request.timeDimension.name}__${request.timeDimension.granularity}`);
    }
    if (groupBy.length > 0) args.push('--group-by', groupBy.join(','));
  }

  for (const where of buildWhereClauses(request.filters ?? [])) {
    args.push('--where', where);
  }
  for (const order of request.orderBy ?? []) {
    if (!order.name) continue;
    args.push('--order', mode === 'explain' && order.direction === 'desc'
      ? `-${order.name}`
      : mode === 'explain'
        ? order.name
        : `${order.name} ${order.direction ?? 'asc'}`);
  }
  if (request.limit && Number.isFinite(request.limit)) {
    args.push('--limit', String(request.limit));
  }
  return args;
}

function buildWhereClauses(filters: NonNullable<MetricFlowQueryRequest['filters']>): string[] {
  return filters.flatMap((filter) => {
    if (filter.expression?.trim()) return [filter.expression.trim()];
    if (!filter.dimension || !filter.operator) return [];
    const values = filter.values ?? [];
    const quote = (value: string) => /^-?\d+(\.\d+)?$/.test(value.trim())
      ? value
      : `'${value.replace(/'/g, "''")}'`;
    const first = values[0] ?? '';
    switch (filter.operator) {
      case 'equals':
        return values.length <= 1
          ? [`{{ Dimension('${filter.dimension}') }} = ${quote(first)}`]
          : [`{{ Dimension('${filter.dimension}') }} IN (${values.map(quote).join(', ')})`];
      case 'not_equals':
        return [`{{ Dimension('${filter.dimension}') }} != ${quote(first)}`];
      case 'in':
        return values.length > 0 ? [`{{ Dimension('${filter.dimension}') }} IN (${values.map(quote).join(', ')})`] : [];
      case 'not_in':
        return values.length > 0 ? [`{{ Dimension('${filter.dimension}') }} NOT IN (${values.map(quote).join(', ')})`] : [];
      case 'gt':
        return [`{{ Dimension('${filter.dimension}') }} > ${quote(first)}`];
      case 'gte':
        return [`{{ Dimension('${filter.dimension}') }} >= ${quote(first)}`];
      case 'lt':
        return [`{{ Dimension('${filter.dimension}') }} < ${quote(first)}`];
      case 'lte':
        return [`{{ Dimension('${filter.dimension}') }} <= ${quote(first)}`];
      default:
        return [];
    }
  });
}

function extractCompiledSql(output: string): string {
  const normalized = output.trim();
  const index = normalized.search(/\b(with|select)\b/i);
  if (index < 0) return '';
  return normalized.slice(index).trim().replace(/;?\s*$/, '');
}
