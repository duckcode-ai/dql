import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export class MetricFlowUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricFlowUnavailableError';
  }
}

export interface MetricFlowQueryRequest {
  projectRoot: string;
  dbtProjectPath?: string;
  metrics: string[];
  dimensions: string[];
  timeDimension?: { name: string; granularity: string };
  filters?: Array<{ dimension?: string; operator?: string; values?: string[]; expression?: string }>;
  orderBy?: Array<{ name: string; direction?: 'asc' | 'desc' }>;
  limit?: number;
  savedQuery?: string;
}

export interface MetricFlowCompileResult {
  sql: string;
  command: string[];
  stdout: string;
  stderr: string;
}

export function resolveDbtProjectRoot(projectRoot: string, configuredPath?: string): string {
  return configuredPath ? resolve(projectRoot, configuredPath) : projectRoot;
}

export function hasDbtSemanticManifest(projectRoot: string, configuredPath?: string): boolean {
  return existsSync(join(resolveDbtProjectRoot(projectRoot, configuredPath), 'target', 'semantic_manifest.json'));
}

/** Check whether the configured MetricFlow executable is callable. */
export function hasMetricFlowCli(): boolean {
  const bin = process.env.DQL_METRICFLOW_BIN || process.env.METRICFLOW_BIN || 'mf';
  const result = spawnSync(bin, ['--version'], {
    encoding: 'utf-8',
    env: process.env,
    timeout: 3000,
  });
  return !result.error && result.status === 0;
}

export function compileMetricFlowQuery(request: MetricFlowQueryRequest): MetricFlowCompileResult {
  const dbtRoot = resolveDbtProjectRoot(request.projectRoot, request.dbtProjectPath);
  if (!existsSync(join(dbtRoot, 'target', 'semantic_manifest.json'))) {
    throw new MetricFlowUnavailableError(
      'dbt semantic execution requires target/semantic_manifest.json. Run `dbt parse` or `dbt build` in the dbt project, then retry.',
    );
  }

  const bin = process.env.DQL_METRICFLOW_BIN || process.env.METRICFLOW_BIN || 'mf';
  const args = buildMetricFlowArgs(request);
  const result = spawnSync(bin, args, {
    cwd: dbtRoot,
    encoding: 'utf-8',
    env: process.env,
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

function buildMetricFlowArgs(request: MetricFlowQueryRequest): string[] {
  const args = ['query', '--compile'];
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
    args.push('--order', `${order.name} ${order.direction ?? 'asc'}`);
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
