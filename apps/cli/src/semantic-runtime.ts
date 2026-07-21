import type { ComposeQueryResult, MetricDefinition, SemanticLayer } from '@duckcodeailabs/dql-core';
import {
  compileDbtCloudSemanticQuery,
  listDbtCloudCompatibleDimensions,
  testDbtCloudSemanticConnection,
  type DbtCloudSemanticTestResult,
} from './dbt-cloud-semantic.js';
import { compileMetricFlowQuery, hasMetricFlowCli, listMetricFlowDimensions, MetricFlowUnavailableError, resolveMetricFlowCli } from './metricflow.js';
import {
  getEffectiveDbtCloudSemanticSettings,
  getSemanticRuntimeSettings,
  semanticRuntimeDraft,
  type SemanticRuntimePreference,
  type SemanticRuntimeSettingsInput,
} from './semantic-runtime-settings.js';

export type SemanticRuntimeAdapterId = 'native' | 'metricflow-cli' | 'dbt-cloud';
export type SemanticMetricExecutionStatus = 'ready' | 'requires_setup' | 'unsupported';

export interface SemanticRuntimeProjectConfig {
  semanticLayer?: { provider?: string; projectPath?: string };
  dbt?: { projectDir?: string; profilesDir?: string };
}

export interface SemanticRuntimeAdapterStatus {
  id: SemanticRuntimeAdapterId;
  label: string;
  bundled: boolean;
  configured: boolean;
  tested: boolean;
  ready: boolean;
  source: 'bundled' | 'local' | 'env' | 'none';
  detail: string;
}

export interface SemanticRuntimeStatus {
  preference: SemanticRuntimePreference;
  active: SemanticRuntimeAdapterId;
  adapters: SemanticRuntimeAdapterStatus[];
  setup: string | null;
}

export interface SemanticMetricExecutionCapability {
  status: SemanticMetricExecutionStatus;
  engine: SemanticRuntimeAdapterId | null;
  reason: string | null;
}

export interface SemanticRuntimeQueryRequest {
  metrics: string[];
  dimensions: string[];
  filters?: Array<{ dimension?: string; operator?: string; values?: string[]; expression?: string }>;
  timeDimension?: { name: string; granularity: string };
  orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>;
  limit?: number;
  savedQuery?: string;
  engine?: 'native' | 'metricflow' | SemanticRuntimeAdapterId;
}

export interface SemanticRuntimeCompileContext {
  projectRoot: string;
  projectConfig: SemanticRuntimeProjectConfig;
  detectedProvider?: string | null;
  semanticLayer: SemanticLayer;
  driver?: string;
  tableMapping?: Record<string, string>;
}

export interface SemanticRuntimeCompileResult extends ComposeQueryResult {
  engine: SemanticRuntimeAdapterId;
  /** The governed request actually compiled after deterministic normalization. */
  effectiveRequest: SemanticRuntimeQueryRequest;
}

export class SemanticRuntimeRequiredError extends Error {
  readonly code = 'SEMANTIC_RUNTIME_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'SemanticRuntimeRequiredError';
  }
}

const cloudProbeCache = new Map<string, { expiresAt: number; result: DbtCloudSemanticTestResult }>();

const OFFSET_PARAMETER_KEYS = new Set(['offsetwindow', 'offsettograin']);
const METRIC_DEPENDENCY_KEYS = new Set([
  'metric',
  'metrics',
  'inputmetric',
  'inputmetrics',
  'numerator',
  'denominator',
  'basemetric',
]);
const TIME_GRAIN_ORDER = ['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'];

/**
 * API-004 / AGT-001: MetricFlow requires `metric_time` whenever an input metric uses a time offset.
 * dbt stores that requirement in the metric definition, so normalize it once at
 * the shared runtime boundary instead of asking every UI and agent route to infer
 * the same compiler constraint independently.
 */
export function normalizeSemanticRuntimeQueryRequest(
  request: SemanticRuntimeQueryRequest,
  semanticLayer: SemanticLayer,
): SemanticRuntimeQueryRequest {
  const normalized: SemanticRuntimeQueryRequest = {
    ...request,
    metrics: [...request.metrics],
    dimensions: [...request.dimensions],
    filters: request.filters?.map((filter) => ({
      ...filter,
      ...(filter.values ? { values: [...filter.values] } : {}),
    })),
    orderBy: request.orderBy?.map((order) => ({ ...order })),
    ...(request.timeDimension ? { timeDimension: { ...request.timeDimension } } : {}),
  };
  if (normalized.savedQuery || normalized.timeDimension || hasMetricTimeGrouping(normalized.dimensions)) {
    return normalized;
  }

  const metrics = semanticLayer.listMetrics();
  const metricByName = new Map(metrics.map((metric) => [metric.name.toLowerCase(), metric]));
  const grains = new Set<string>();
  const visited = new Set<string>();
  for (const metricName of normalized.metrics) {
    const metric = resolveMetricDefinition(metricName, metrics, metricByName);
    if (metric) collectMetricOffsetGrains(metric, metrics, metricByName, visited, grains);
  }
  const granularity = finestTimeGrain(grains);
  return granularity
    ? { ...normalized, timeDimension: { name: 'metric_time', granularity } }
    : normalized;
}

function hasMetricTimeGrouping(dimensions: string[]): boolean {
  return dimensions.some((dimension) => {
    const value = dimension.replace(/["`\[\]]/g, '').toLowerCase();
    return value === 'metric_time' || value.startsWith('metric_time__');
  });
}

function collectMetricOffsetGrains(
  metric: MetricDefinition,
  metrics: MetricDefinition[],
  metricByName: Map<string, MetricDefinition>,
  visited: Set<string>,
  grains: Set<string>,
): void {
  const identity = metric.name.toLowerCase();
  if (visited.has(identity)) return;
  visited.add(identity);
  const typeParams = metric.typeParams
    ?? readRecord(readRecord(metric.source?.extra)?.raw)?.type_params;
  if (!typeParams || typeof typeParams !== 'object') return;

  collectOffsetGrains(typeParams, grains);
  for (const dependencyName of collectMetricDependencyNames(typeParams)) {
    const dependency = resolveMetricDefinition(dependencyName, metrics, metricByName);
    if (dependency) collectMetricOffsetGrains(dependency, metrics, metricByName, visited, grains);
  }
}

function collectOffsetGrains(value: unknown, grains: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectOffsetGrains(item, grains);
    return;
  }
  const record = readRecord(value);
  if (!record) return;
  for (const [key, nested] of Object.entries(record)) {
    const normalizedKey = normalizeSemanticKey(key);
    if (OFFSET_PARAMETER_KEYS.has(normalizedKey)) {
      const grain = readTimeGrain(nested);
      if (grain) grains.add(grain);
    }
    collectOffsetGrains(nested, grains);
  }
}

function collectMetricDependencyNames(value: unknown): Set<string> {
  const names = new Set<string>();
  const visit = (nested: unknown): void => {
    if (Array.isArray(nested)) {
      for (const item of nested) visit(item);
      return;
    }
    const record = readRecord(nested);
    if (!record) return;
    for (const [key, child] of Object.entries(record)) {
      if (METRIC_DEPENDENCY_KEYS.has(normalizeSemanticKey(key))) collectNamedReferences(child, names);
      visit(child);
    }
  };
  visit(value);
  return names;
}

function collectNamedReferences(value: unknown, names: Set<string>): void {
  if (typeof value === 'string' && value.trim()) {
    names.add(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNamedReferences(item, names);
    return;
  }
  const record = readRecord(value);
  if (!record) return;
  for (const key of ['name', 'metric', 'metric_name']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) names.add(candidate.trim());
  }
}

function readTimeGrain(value: unknown): string | undefined {
  if (typeof value === 'string') return normalizeTimeGrain(value);
  const record = readRecord(value);
  if (!record) return undefined;
  for (const key of ['granularity', 'grain', 'value', 'name']) {
    const candidate = record[key];
    if (typeof candidate === 'string') {
      const grain = normalizeTimeGrain(candidate);
      if (grain) return grain;
    }
  }
  return undefined;
}

function normalizeTimeGrain(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, '_');
  return TIME_GRAIN_ORDER.includes(normalized) ? normalized : undefined;
}

function finestTimeGrain(grains: Set<string>): string | undefined {
  return TIME_GRAIN_ORDER.find((grain) => grains.has(grain));
}

function normalizeSemanticKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function resolveMetricDefinition(
  name: string,
  metrics: MetricDefinition[],
  metricByName: Map<string, MetricDefinition>,
): MetricDefinition | undefined {
  const normalized = name.toLowerCase();
  return metricByName.get(normalized)
    ?? metrics.find((metric) => metric.name.toLowerCase().endsWith(`.${normalized}`)
      || normalized.endsWith(`.${metric.name.toLowerCase()}`));
}

export async function getSemanticRuntimeStatus(
  projectRoot: string,
  options: { probeConfiguredCloud?: boolean } = {},
): Promise<SemanticRuntimeStatus> {
  const redacted = getSemanticRuntimeSettings(projectRoot);
  const cloud = getEffectiveDbtCloudSemanticSettings(projectRoot);
  const metricFlowCli = resolveMetricFlowCli(projectRoot);
  const cliReady = Boolean(metricFlowCli);
  let cloudTest: DbtCloudSemanticTestResult | undefined;
  if (cloud.configured && cloud.testState === 'passed') {
    cloudTest = {
      ok: true,
      message: cloud.testMessage ?? 'Previously tested.',
      dialect: cloud.dialect,
      metricCount: cloud.metricCount,
    };
  } else if (cloud.configured && options.probeConfiguredCloud) {
    cloudTest = await probeDbtCloudSemanticRuntime(projectRoot).catch((error) => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
  const cloudReady = Boolean(cloudTest?.ok);
  const preference = redacted.preference;
  const active = selectActiveAdapter(preference, cloudReady, cliReady);
  const adapters: SemanticRuntimeAdapterStatus[] = [
    {
      id: 'native',
      label: 'DQL native semantic compiler',
      bundled: true,
      configured: true,
      tested: true,
      ready: true,
      source: 'bundled',
      detail: 'Bundled with DQL. Executes safe simple/additive metrics without an external runtime.',
    },
    {
      id: 'metricflow-cli',
      label: 'Local MetricFlow',
      bundled: false,
      configured: cliReady,
      tested: cliReady,
      ready: cliReady,
      source: cliReady ? 'local' : 'none',
      detail: cliReady
        ? `Detected ${metricFlowCli?.source === 'managed' ? 'the project-local managed runtime' : 'a compatible `mf` executable'}${metricFlowCli?.version ? ` · ${metricFlowCli.version}` : ''}.`
        : 'The DQL adapter is bundled; install a project-local MetricFlow Python runtime or use an existing `mf` executable.',
    },
    {
      id: 'dbt-cloud',
      label: 'dbt Cloud Semantic Layer',
      bundled: true,
      configured: cloud.configured,
      tested: cloudReady || cloud.testState === 'failed',
      ready: cloudReady,
      source: cloud.source,
      detail: !cloud.configured
        ? 'Adapter is bundled; configure Host, Environment ID, and a Semantic Layer service token.'
        : cloudReady
          ? cloudTest?.message ?? 'Test passed.'
          : cloudTest?.message ?? cloud.testMessage ?? 'Configured but not tested.',
    },
  ];
  const setup = active !== 'native'
    ? null
    : cloud.configured && !cloudReady
      ? 'Test the configured dbt Cloud Semantic Layer connection, or install a compatible local MetricFlow runtime.'
      : 'Configure dbt Cloud Semantic Layer, or install a compatible local MetricFlow runtime for derived, ratio, cumulative, and conversion metrics.';
  return { preference, active, adapters, setup };
}

export async function testSemanticRuntimeDraft(
  projectRoot: string,
  input: SemanticRuntimeSettingsInput,
): Promise<DbtCloudSemanticTestResult> {
  const draft = semanticRuntimeDraft(projectRoot, input);
  return testDbtCloudSemanticConnection(draft);
}

export async function compileSemanticRuntimeQuery(
  request: SemanticRuntimeQueryRequest,
  context: SemanticRuntimeCompileContext,
): Promise<SemanticRuntimeCompileResult | null> {
  const effectiveRequest = normalizeSemanticRuntimeQueryRequest(request, context.semanticLayer);
  const status = await getSemanticRuntimeStatus(context.projectRoot, { probeConfiguredCloud: true });
  const explicit = effectiveRequest.engine;
  const fullRuntimeRequested = explicit === 'metricflow' || explicit === 'metricflow-cli' || explicit === 'dbt-cloud';
  const candidates: SemanticRuntimeAdapterId[] = explicit === 'native'
    ? ['native']
    : explicit === 'dbt-cloud'
      ? ['dbt-cloud']
      : explicit === 'metricflow-cli'
        ? ['metricflow-cli']
        : status.active === 'dbt-cloud'
          ? ['dbt-cloud', 'metricflow-cli', 'native']
          : status.active === 'metricflow-cli'
            ? ['metricflow-cli', 'dbt-cloud', 'native']
            : ['native'];

  let lastRuntimeError: Error | undefined;
  for (const adapter of candidates) {
    if (adapter === 'dbt-cloud') {
      const adapterStatus = status.adapters.find((item) => item.id === adapter);
      if (!adapterStatus?.ready) continue;
      try {
        const result = await compileDbtCloudSemanticQuery(
          getEffectiveDbtCloudSemanticSettings(context.projectRoot),
          effectiveRequest,
        );
        return { sql: result.sql, joins: [], tables: [], engine: 'dbt-cloud', effectiveRequest };
      } catch (error) {
        lastRuntimeError = error instanceof Error ? error : new Error(String(error));
        if (explicit === 'dbt-cloud') throw lastRuntimeError;
        continue;
      }
    }
    if (adapter === 'metricflow-cli') {
      if (!hasMetricFlowCli(context.projectRoot)) continue;
      try {
        const dbtProjectPath = context.projectConfig.semanticLayer?.provider === 'dbt'
          ? context.projectConfig.semanticLayer.projectPath
          : context.projectConfig.dbt?.projectDir;
        const compiled = compileMetricFlowQuery({
          projectRoot: context.projectRoot,
          dbtProjectPath,
          profilesDir: context.projectConfig.dbt?.profilesDir,
          metrics: effectiveRequest.metrics,
          dimensions: effectiveRequest.dimensions,
          filters: effectiveRequest.filters,
          timeDimension: effectiveRequest.timeDimension,
          orderBy: effectiveRequest.orderBy,
          limit: effectiveRequest.limit,
          savedQuery: effectiveRequest.savedQuery,
        });
        return { sql: compiled.sql, joins: [], tables: [], engine: 'metricflow-cli', effectiveRequest };
      } catch (error) {
        lastRuntimeError = error instanceof Error ? error : new Error(String(error));
        if (explicit === 'metricflow-cli' || explicit === 'metricflow') throw lastRuntimeError;
        continue;
      }
    }
    const composed = context.semanticLayer.composeQuery({
      metrics: effectiveRequest.metrics,
      dimensions: effectiveRequest.dimensions,
      filters: effectiveRequest.filters as Array<{ dimension: string; operator: string; values: string[] }> | undefined,
      limit: effectiveRequest.limit,
      timeDimension: effectiveRequest.timeDimension,
      orderBy: effectiveRequest.orderBy,
      driver: context.driver,
      tableMapping: context.tableMapping,
    });
    if (composed) return { ...composed, engine: 'native', effectiveRequest };
  }

  if (fullRuntimeRequested) {
    throw lastRuntimeError ?? new SemanticRuntimeRequiredError(status.setup ?? 'The requested semantic runtime is unavailable.');
  }
  if (lastRuntimeError && !context.semanticLayer.canComposeMetric(effectiveRequest.metrics[0] ?? '')) {
    throw new SemanticRuntimeRequiredError(lastRuntimeError.message);
  }
  return null;
}

/** A compatible dimension enriched with its MetricFlow-qualified name and, for
 *  time dimensions, real queryable grains. */
export type RuntimeCompatibleDimension = ReturnType<SemanticLayer['listDimensions']>[number] & {
  qualifiedName?: string;
  granularities?: string[];
};

export interface RuntimeCompatibilityResult {
  /** The engine that produced this compatibility answer. */
  engine: SemanticRuntimeAdapterId;
  dimensions: RuntimeCompatibleDimension[];
  incompatible: Array<{ name: string; qualifiedName?: string; reason: string }>;
  /** Set when a preferred runtime failed and we fell back (e.g. mf → native). */
  degraded?: string;
}

/**
 * The authoritative per-metric dimension-compatibility answer, resolved through
 * the SAME cascade that executes the query, so the builder can never offer a
 * dimension the runtime would reject:
 *   dbt Cloud (already qualified + real grains) → `mf list dimensions` → native.
 * mf failures fall through to native with a `degraded` note (never throw).
 */
export async function describeRuntimeCompatibility(
  projectRoot: string,
  semanticLayer: SemanticLayer,
  metrics: string[],
  projectConfig?: SemanticRuntimeProjectConfig,
): Promise<RuntimeCompatibilityResult> {
  if (metrics.length === 0) return { engine: 'native', dimensions: [], incompatible: [] };
  const status = await getSemanticRuntimeStatus(projectRoot, { probeConfiguredCloud: true });

  const nativeExplain = (): RuntimeCompatibilityResult => {
    const { compatible, incompatible } = semanticLayer.explainCompatibleDimensions(metrics);
    return {
      engine: 'native',
      dimensions: compatible.map((d) => ({ ...d, qualifiedName: d.qualifiedName })),
      incompatible: incompatible.map((d) => ({ name: d.name, qualifiedName: d.qualifiedName, reason: d.reason })),
    };
  };

  // dbt Cloud is truth when active: it returns entity-qualified names and real
  // queryable grains straight from the semantic layer.
  if (status.active === 'dbt-cloud') {
    try {
      const cloud = await listDbtCloudCompatibleDimensions(getEffectiveDbtCloudSemanticSettings(projectRoot), metrics);
      const localByName = new Map(semanticLayer.listDimensions().map((d) => [d.name.toLowerCase(), d]));
      const dimensions: RuntimeCompatibleDimension[] = cloud.map((dimension) => {
        const local = localByName.get(dimension.name.toLowerCase());
        const isTime = dimension.type?.toLowerCase() === 'time';
        return {
          ...(local ?? {
            name: dimension.name,
            label: dimension.name.replace(/[_-]+/g, ' '),
            description: dimension.description ?? '',
            domain: '',
            sql: dimension.name,
            type: isTime ? 'date' : 'string',
            table: '',
            isTimeDimension: isTime,
            source: { provider: 'dbt', objectType: 'dimension', objectId: dimension.name, objectName: dimension.name },
          }),
          qualifiedName: dimension.name,
          granularities: dimension.granularities.map((v) => v.toLowerCase()),
        } as RuntimeCompatibleDimension;
      });
      return { engine: 'dbt-cloud', dimensions, incompatible: [] };
    } catch (error) {
      const native = nativeExplain();
      return { ...native, degraded: `dbt Cloud dimension listing failed (${error instanceof Error ? error.message : String(error)}); showing native compatibility.` };
    }
  }

  // Local MetricFlow: ask mf itself, then hydrate labels/types from the local
  // catalog by matching each qualified name's tail (same trick as the cloud path).
  if (status.active === 'metricflow-cli') {
    const dbtProjectPath = projectConfig?.semanticLayer?.provider === 'dbt'
      ? projectConfig.semanticLayer.projectPath
      : projectConfig?.dbt?.projectDir;
    const mfDims = listMetricFlowDimensions({ projectRoot, dbtProjectPath, profilesDir: projectConfig?.dbt?.profilesDir, metrics });
    if (mfDims.length > 0) {
      const localByTail = new Map(semanticLayer.listDimensions().map((d) => [d.name.toLowerCase(), d]));
      const dimensions: RuntimeCompatibleDimension[] = mfDims.map((mf) => {
        const tail = mf.qualifiedName.split('__').pop()!.toLowerCase();
        const local = localByTail.get(tail);
        const isTime = Boolean(mf.granularities?.length) || Boolean(local?.isTimeDimension);
        return {
          ...(local ?? {
            name: tail,
            label: tail.replace(/[_-]+/g, ' '),
            description: '',
            domain: '',
            sql: tail,
            type: isTime ? 'date' : 'string',
            table: '',
            isTimeDimension: isTime,
            source: { provider: 'dbt', objectType: 'dimension', objectId: tail, objectName: tail },
          }),
          qualifiedName: mf.qualifiedName,
          granularities: mf.granularities,
        } as RuntimeCompatibleDimension;
      });
      return { engine: 'metricflow-cli', dimensions, incompatible: [] };
    }
    return { ...nativeExplain(), degraded: '`mf list dimensions` returned nothing; showing native compatibility.' };
  }

  return nativeExplain();
}

export async function listRuntimeCompatibleDimensions(
  projectRoot: string,
  semanticLayer: SemanticLayer,
  metrics: string[],
  projectConfig?: SemanticRuntimeProjectConfig,
): Promise<Array<ReturnType<SemanticLayer['listDimensions']>[number]>> {
  const result = await describeRuntimeCompatibility(projectRoot, semanticLayer, metrics, projectConfig);
  return result.dimensions;
}

export function semanticMetricExecutionCapability(
  metricName: string,
  semanticLayer: SemanticLayer,
  provider: string,
  runtime: SemanticRuntimeStatus,
): SemanticMetricExecutionCapability {
  const fullRuntime = runtime.active === 'dbt-cloud' || runtime.active === 'metricflow-cli'
    ? runtime.active
    : null;
  if (provider === 'dbt' && fullRuntime) {
    return { status: 'ready', engine: fullRuntime, reason: null };
  }
  if (semanticLayer.canComposeMetric(metricName)) {
    return { status: 'ready', engine: 'native', reason: null };
  }
  const metric = semanticLayer.getMetric(metricName);
  if (provider === 'dbt') {
    const kind = metric?.metricType || metric?.aggregation || metric?.type || 'metric';
    return {
      status: 'requires_setup',
      engine: null,
      reason: `${kind} metric requires a full semantic runtime. ${runtime.setup ?? 'Configure dbt Cloud Semantic Layer or local MetricFlow.'}`,
    };
  }
  return {
    status: 'unsupported',
    engine: null,
    reason: 'The metric does not have enough composable measure and relation metadata.',
  };
}

async function probeDbtCloudSemanticRuntime(projectRoot: string): Promise<DbtCloudSemanticTestResult> {
  const cloud = getEffectiveDbtCloudSemanticSettings(projectRoot);
  if (!cloud.configured || !cloud.fingerprint) {
    return { ok: false, message: 'dbt Cloud Semantic Layer is not configured.' };
  }
  const cached = cloudProbeCache.get(cloud.fingerprint);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const result = await testDbtCloudSemanticConnection(cloud);
  cloudProbeCache.set(cloud.fingerprint, { expiresAt: Date.now() + 5 * 60_000, result });
  return result;
}

function selectActiveAdapter(
  preference: SemanticRuntimePreference,
  cloudReady: boolean,
  cliReady: boolean,
): SemanticRuntimeAdapterId {
  if (preference === 'dbt-cloud') return cloudReady ? 'dbt-cloud' : cliReady ? 'metricflow-cli' : 'native';
  if (preference === 'metricflow-cli') return cliReady ? 'metricflow-cli' : cloudReady ? 'dbt-cloud' : 'native';
  if (preference === 'native') return 'native';
  if (cloudReady) return 'dbt-cloud';
  if (cliReady) return 'metricflow-cli';
  return 'native';
}

export function isSemanticRuntimeError(error: unknown): boolean {
  return error instanceof SemanticRuntimeRequiredError || error instanceof MetricFlowUnavailableError;
}
