import { existsSync, statSync } from 'node:fs';
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

export interface MetricFlowDimension {
  /** Entity-qualified group-by name exactly as MetricFlow addresses it. */
  qualifiedName: string;
  /** Queryable grains, when MetricFlow reports them (time dimensions). */
  granularities?: string[];
}

interface MetricFlowDimensionListRequest {
  projectRoot: string;
  dbtProjectPath?: string;
  profilesDir?: string;
  metrics: string[];
}

// Cache `mf list dimensions` by (binary + metrics-set + semantic_manifest mtime).
// The UI calls this on every metric toggle and mf cold-start is seconds.
const metricFlowDimensionCache = new Map<string, MetricFlowDimension[]>();

/**
 * Ask MetricFlow itself which dimensions a metric set can be grouped by, via
 * `mf list dimensions --metrics X,Y`. This is the EXACT truth for the executing
 * engine — entity-qualified names and real queryable grains — which the native
 * reachable-table heuristic can only approximate. Tolerant to output-format
 * drift across MetricFlow versions: unrecognized lines are ignored and a parse
 * that yields nothing returns [] so the caller falls back to native.
 */
export function listMetricFlowDimensions(request: MetricFlowDimensionListRequest): MetricFlowDimension[] {
  const dbtRoot = resolveDbtProjectRoot(request.projectRoot, request.dbtProjectPath);
  const manifestPath = join(dbtRoot, 'target', 'semantic_manifest.json');
  if (!existsSync(manifestPath) || request.metrics.length === 0) return [];

  const resolvedCli = resolveMetricFlowCli(request.projectRoot);
  const bin = resolvedCli?.bin ?? process.env.DQL_METRICFLOW_BIN ?? process.env.METRICFLOW_BIN ?? 'mf';
  let mtime = '';
  try { mtime = String(statSync(manifestPath).mtimeMs); } catch { /* ignore */ }
  const cacheKey = `${bin}::${mtime}::${[...request.metrics].sort().join(',')}`;
  const cached = metricFlowDimensionCache.get(cacheKey);
  if (cached) return cached;

  const args = ['list', 'dimensions', '--metrics', request.metrics.join(',')];
  const result = spawnSync(bin, args, {
    cwd: dbtRoot,
    encoding: 'utf-8',
    timeout: 30_000,
    env: {
      ...process.env,
      ...(request.profilesDir ? { DBT_PROFILES_DIR: resolve(request.projectRoot, request.profilesDir) } : {}),
    },
  });
  if (result.error || result.status !== 0) return [];

  const parsed = parseMetricFlowDimensionList(result.stdout ?? '');
  if (parsed.length > 0) metricFlowDimensionCache.set(cacheKey, parsed);
  return parsed;
}

/** Parse `mf list dimensions` stdout into qualified names + grains. Kept
 *  separate + exported so its format tolerance is unit-testable without mf. */
export function parseMetricFlowDimensionList(stdout: string): MetricFlowDimension[] {
  const dimensions: MetricFlowDimension[] = [];
  let current: MetricFlowDimension | undefined;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // A dimension entry: a bullet or bare token that is a valid identifier,
    // optionally entity-qualified with `__`. Skip headers/counts/emoji lines.
    const nameMatch = /^(?:[•*-]\s*)?([A-Za-z_][A-Za-z0-9_]*(?:__[A-Za-z0-9_]+)*)$/.exec(line);
    if (nameMatch) {
      current = { qualifiedName: nameMatch[1] };
      dimensions.push(current);
      continue;
    }
    // A grain hint attaches to the dimension it follows.
    const grainMatch = /queryable\s+granularities?\s*[:=]?\s*\[?([^\]]+)\]?/i.exec(line);
    if (grainMatch && current) {
      const grains = grainMatch[1]
        .split(/[,\s]+/)
        .map((g) => g.replace(/['"]/g, '').trim().toLowerCase())
        .filter(Boolean);
      if (grains.length > 0) current.granularities = grains;
    }
  }
  return dimensions;
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
  const mode = metricFlowCompileMode(resolvedCli?.version ?? '');
  const spawn = (spawnRequest: MetricFlowQueryRequest) => {
    const args = buildMetricFlowArgs(spawnRequest, mode);
    return {
      args,
      result: spawnSync(bin, args, {
        cwd: dbtRoot,
        encoding: 'utf-8',
        env: {
          ...process.env,
          ...(spawnRequest.profilesDir
            ? { DBT_PROFILES_DIR: resolve(spawnRequest.projectRoot, spawnRequest.profilesDir) }
            : {}),
        },
      }),
    };
  };
  let { args, result } = spawn(request);

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MetricFlowUnavailableError(
        'MetricFlow CLI was not found. Install dbt Semantic Layer dependencies so `mf` is on PATH, or set DQL_METRICFLOW_BIN to the MetricFlow executable.',
      );
    }
    throw result.error;
  }

  let stdout = result.stdout ?? '';
  let stderr = result.stderr ?? '';
  if (result.status !== 0) {
    // MetricFlow group-by items are ENTITY-QUALIFIED ("bcm_hdr__customer_name"),
    // while DQL's semantic layer speaks bare dimension names ("customer_name").
    // On a group-by resolution failure MetricFlow lists the valid qualified
    // names — adopt its own suggestion and retry ONCE rather than surfacing a
    // wall of resolver errors for a question that has an exact governed answer.
    const repaired = repairMetricFlowGroupBy(request, `${stderr}\n${stdout}`);
    if (repaired) {
      const retry = spawn(repaired);
      if (!retry.result.error && retry.result.status === 0) {
        args = retry.args;
        result = retry.result;
        stdout = retry.result.stdout ?? '';
        stderr = retry.result.stderr ?? '';
      }
    }
  }
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

/**
 * Parse a MetricFlow "does not match any of the available group-by-items"
 * failure and rewrite the failing bare names to the qualified names MetricFlow
 * itself suggested. Returns the corrected request, or null when the failure is
 * not a group-by resolution problem or no suggestion unambiguously matches.
 *
 * Selection rule per failing input: among the suggested qualified names whose
 * final segment equals the input (`…__<input>`), take the one with the fewest
 * entity hops; ties on hop count → null (genuinely ambiguous, do not guess).
 */
export function repairMetricFlowGroupBy(
  request: MetricFlowQueryRequest,
  output: string,
): MetricFlowQueryRequest | null {
  if (!/does not match any of the available group-by-items/i.test(output)) return null;

  const inputs = [...output.matchAll(/Query Input:\s*\n?\s*['"]?([A-Za-z0-9_.]+)['"]?/g)]
    .map((match) => match[1]);
  const suggestions = [...output.matchAll(/Suggestions:\s*\[([^\]]*)\]/g)]
    .flatMap((match) => match[1].split(',').map((item) => item.replace(/['"\s]/g, '')).filter(Boolean));
  if (inputs.length === 0 || suggestions.length === 0) return null;

  const uniqueSuggestions = [...new Set(suggestions)];
  const resolveQualified = (input: string): string | null => {
    // Strip an existing granularity suffix for matching (metric_time__day).
    const bare = input.includes('__') ? input.split('__').pop()! : input;
    const candidates = uniqueSuggestions.filter((name) => {
      const tail = name.split('__').pop();
      return tail === bare || name === input;
    });
    if (candidates.length === 0) return null;
    const byHops = [...candidates].sort((a, b) => a.split('__').length - b.split('__').length);
    const fewest = byHops[0].split('__').length;
    if (byHops.filter((name) => name.split('__').length === fewest).length > 1) return null;
    return byHops[0];
  };

  const renames = new Map<string, string>();
  for (const input of new Set(inputs)) {
    const qualified = resolveQualified(input);
    if (!qualified || qualified === input) continue;
    renames.set(input, qualified);
  }
  if (renames.size === 0) return null;

  const renameOf = (name: string): string => renames.get(name) ?? name;
  return {
    ...request,
    dimensions: request.dimensions.map(renameOf),
    ...(request.timeDimension
      ? { timeDimension: { ...request.timeDimension, name: renameOf(request.timeDimension.name) } }
      : {}),
    ...(request.filters
      ? {
          filters: request.filters.map((filter) => filter.dimension
            ? { ...filter, dimension: renameOf(filter.dimension) }
            : filter),
        }
      : {}),
    ...(request.orderBy
      ? { orderBy: request.orderBy.map((order) => ({ ...order, name: renameOf(order.name) })) }
      : {}),
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
