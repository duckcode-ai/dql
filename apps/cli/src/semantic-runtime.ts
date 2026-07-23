import {
  semanticDimensionReference,
  type ComposeQueryResult,
  type MetricDefinition,
  type SemanticLayer,
} from '@duckcodeailabs/dql-core';
import {
  compileDbtCloudSemanticQuery,
  listDbtCloudCompatibleDimensions,
  testDbtCloudSemanticConnection,
  type DbtCloudSemanticTestResult,
} from './dbt-cloud-semantic.js';
import { compileMetricFlowQuery, hasDbtSemanticManifest, hasMetricFlowCli, listMetricFlowDimensions, managedMetricFlowBin, MetricFlowUnavailableError, resolveMetricFlowCli } from './metricflow.js';
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
  /**
   * The governed request as the USER expressed it (preferably model-scoped
   * dimension identities), after deterministic normalization. Echoed to callers
   * and back into `.dql` sources — it must never be replaced by adapter-specific
   * MetricFlow spellings such as `entity__dim`.
   */
  effectiveRequest: SemanticRuntimeQueryRequest;
  /**
   * The request actually SENT to a full runtime (MetricFlow / dbt Cloud), with
   * dimensions/filters/order-by/time qualified to entity-qualified names. Absent
   * for native compilation (which speaks bare names). Diagnostic only.
   */
  runtimeRequest?: SemanticRuntimeQueryRequest;
  /** Non-fatal advisories (e.g. a time grain clamped up to the column's base). */
  warnings?: string[];
}

export class SemanticRuntimeRequiredError extends Error {
  readonly code = 'SEMANTIC_RUNTIME_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'SemanticRuntimeRequiredError';
  }
}

export class SemanticRuntimeCompilationError extends Error {
  readonly code = 'SEMANTIC_COMPILATION_FAILED';
  readonly adapter: Exclude<SemanticRuntimeAdapterId, 'native'>;

  constructor(adapter: Exclude<SemanticRuntimeAdapterId, 'native'>, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    super(`${adapter} semantic compilation failed: ${message}`, {
      cause: error instanceof Error ? error : undefined,
    });
    this.name = 'SemanticRuntimeCompilationError';
    this.adapter = adapter;
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

/**
 * Rewrite a semantic request's dimension references (dimensions, filter
 * dimensions, order-by names, time dimension) from bare names to the
 * MetricFlow entity-qualified names the runtime expects, using the
 * compatibility service as the source of truth. Names it can't resolve pass
 * through unchanged (the 1.8.13 group-by suggestion-retry is the safety net).
 * `metric_time` is never rewritten. Also clamps a requested time grain up to
 * the column's base grain, collecting a warning. Pure — returns a new request.
 */
/**
 * Explain, actionably, why no full semantic runtime is active for a derived/
 * ratio/cumulative metric — probing the REAL runtime state so the message names
 * the actual gap instead of a generic "configure a runtime". Covers both traps:
 *   • dbt Cloud is configured but its connection test is failing (bad host/env/
 *     token or network) — so it never becomes active, and the query silently
 *     falls back to native, which can't compose a derived metric;
 *   • MetricFlow is installed but this server process can't find it, because the
 *     server was launched from a shell without the dbt virtualenv on PATH.
 */
/** A dbt Cloud connection error that reads like a rejected/expired token rather
 *  than a bad host or a network failure. Exported for testability. */
export function looksLikeAuthFailure(detail: string): boolean {
  return /\b(401|403|unauthori[sz]ed|forbidden|expired|invalid[\s-]*token|token[\s-]*(?:is[\s-]*)?(?:invalid|expired)|authenticat[a-z]*|permission denied|not[\s-]*authori[sz]ed)\b/i.test(detail);
}

export async function explainMissingSemanticRuntime(projectRoot: string, dbtProjectPath?: string): Promise<string> {
  const status = await getSemanticRuntimeStatus(projectRoot, { probeConfiguredCloud: true });
  const cloud = status.adapters.find((adapter) => adapter.id === 'dbt-cloud');
  const cli = resolveMetricFlowCli(projectRoot);
  const head = 'This is a derived metric — it needs dbt Cloud or local MetricFlow, and neither is active for this server right now.';
  const reasons: string[] = [];

  // dbt Cloud is configured but not usable — the most likely cause once a user
  // has "switched to cloud". `detail` carries the live connection-test error.
  if (cloud?.configured && !cloud.ready) {
    const detail = cloud.detail ?? 'not tested';
    if (looksLikeAuthFailure(detail)) {
      // An expired/invalid token is the "works, then stops after a while"
      // symptom: a short-lived Semantic Layer session token was used instead of
      // a durable service token, or the token lacks Semantic Layer permission.
      reasons.push(`dbt Cloud rejected the service token (${detail}) — it has expired or lacks Semantic Layer permission. In dbt Cloud → Account Settings → Service Tokens, create a durable service token with the “Semantic Layer Only” permission set and no short expiration (do NOT copy the short-lived token from the Semantic Layer “Connect/Query” dialog — that one expires), paste it into Settings, then “Test & save”.`);
    } else {
      reasons.push(`dbt Cloud is configured but its connection test is not passing (${detail}). In Settings → Semantic execution adapters → dbt Cloud, re-check Host, Environment ID, and the Semantic Layer service token, then “Test & save”.`);
    }
  }

  // Local MetricFlow.
  if (cli) {
    if (!hasDbtSemanticManifest(projectRoot, dbtProjectPath)) {
      reasons.push(`MetricFlow is installed (${cli.bin}) but target/semantic_manifest.json is missing — run \`dbt parse\` in the dbt project.`);
    }
  } else if (!cloud?.configured) {
    const managed = managedMetricFlowBin(projectRoot);
    reasons.push(`MetricFlow is not on this server’s PATH: start the server from the shell where \`mf\` works (activate your dbt virtualenv) and restart it, set DQL_METRICFLOW_BIN to the path from \`which mf\`, or install the managed runtime in Settings (${managed}).`);
  }

  return reasons.length > 0
    ? `${head} ${reasons.join(' ')}`
    : `${head} ${status.setup ?? 'Configure a runtime in Settings → Semantic execution adapters.'}`;
}

export function qualifyForMetricFlow(
  request: SemanticRuntimeQueryRequest,
  semanticLayer: SemanticLayer,
): { request: SemanticRuntimeQueryRequest; warnings: string[] } {
  const warnings: string[] = [];
  const { compatible } = semanticLayer.explainCompatibleDimensions(request.metrics);
  const qualifiedByReference = new Map<string, string>();
  for (const dim of compatible) {
    if (!dim.qualifiedName) continue;
    for (const reference of [
      dim.name,
      semanticDimensionReference(dim),
      dim.source?.objectId,
      dim.qualifiedName,
    ]) {
      if (reference) qualifiedByReference.set(reference.toLowerCase(), dim.qualifiedName);
    }
  }
  const qualify = (name: string | undefined): string | undefined => {
    if (!name) return name;
    if (name === 'metric_time' || name.includes('__')) return name; // already qualified / reserved
    const exact = semanticLayer.resolveDimension(name, request.metrics);
    return qualifiedByReference.get(name.toLowerCase())
      ?? exact?.qualifiedName
      ?? name;
  };

  const timeDimension = request.timeDimension
    ? (() => {
        const name = qualify(request.timeDimension!.name);
        let granularity = request.timeDimension!.granularity;
        const td = semanticLayer.getTimeDimension(request.timeDimension!.name);
        if (td?.granularities?.length && !td.granularities.includes(granularity as typeof td.granularities[number])) {
          const clamped = td.granularities[0];
          warnings.push(`Time grain "${granularity}" is finer than ${request.timeDimension!.name}'s base grain; using "${clamped}".`);
          granularity = clamped;
        }
        return { name: name!, granularity };
      })()
    : undefined;

  return {
    warnings,
    request: {
      ...request,
      dimensions: request.dimensions.map((d) => qualify(d) ?? d),
      ...(request.filters ? { filters: request.filters.map((f) => f.dimension ? { ...f, dimension: qualify(f.dimension) } : f) } : {}),
      ...(request.orderBy ? { orderBy: request.orderBy.map((o) => ({ ...o, name: qualify(o.name) ?? o.name })) } : {}),
      ...(timeDimension ? { timeDimension } : {}),
    },
  };
}

export async function compileSemanticRuntimeQuery(
  request: SemanticRuntimeQueryRequest,
  context: SemanticRuntimeCompileContext,
): Promise<SemanticRuntimeCompileResult | null> {
  const effectiveRequest = normalizeSemanticRuntimeQueryRequest(request, context.semanticLayer);
  const status = await getSemanticRuntimeStatus(context.projectRoot, { probeConfiguredCloud: true });
  const explicit = effectiveRequest.engine;
  const fullRuntimeRequested = explicit === 'metricflow' || explicit === 'metricflow-cli' || explicit === 'dbt-cloud';
  const candidates = selectSemanticRuntimeAdapters(explicit, status.active);
  const routeLockedToFullRuntime = candidates.length === 1 && candidates[0] !== 'native';

  // Qualify dimension references to MetricFlow entity-qualified names ONCE, at
  // this boundary, for the full-runtime engines. Native keeps the bare request.
  const { request: runtimeRequest, warnings: qualifyWarnings } = qualifyForMetricFlow(effectiveRequest, context.semanticLayer);

  let lastRuntimeError: Error | undefined;
  for (const adapter of candidates) {
    if (adapter === 'dbt-cloud') {
      const adapterStatus = status.adapters.find((item) => item.id === adapter);
      if (!adapterStatus?.ready) continue;
      try {
        const result = await compileDbtCloudSemanticQuery(
          getEffectiveDbtCloudSemanticSettings(context.projectRoot),
          runtimeRequest,
        );
        return { sql: result.sql, joins: [], tables: [], engine: 'dbt-cloud', effectiveRequest, runtimeRequest, warnings: qualifyWarnings };
      } catch (error) {
        lastRuntimeError = error instanceof Error ? error : new Error(String(error));
        if (isSemanticRuntimeError(error)) throw error;
        throw new SemanticRuntimeCompilationError('dbt-cloud', error);
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
          metrics: runtimeRequest.metrics,
          dimensions: runtimeRequest.dimensions,
          filters: runtimeRequest.filters,
          timeDimension: runtimeRequest.timeDimension,
          orderBy: runtimeRequest.orderBy,
          limit: runtimeRequest.limit,
          savedQuery: runtimeRequest.savedQuery,
        });
        return { sql: compiled.sql, joins: [], tables: [], engine: 'metricflow-cli', effectiveRequest, runtimeRequest, warnings: qualifyWarnings };
      } catch (error) {
        lastRuntimeError = error instanceof Error ? error : new Error(String(error));
        if (isSemanticRuntimeError(error)) throw error;
        throw new SemanticRuntimeCompilationError('metricflow-cli', error);
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

  if (fullRuntimeRequested || routeLockedToFullRuntime) {
    throw lastRuntimeError ?? new SemanticRuntimeRequiredError(status.setup ?? 'The requested semantic runtime is unavailable.');
  }
  if (lastRuntimeError && !context.semanticLayer.canComposeMetric(effectiveRequest.metrics[0] ?? '')) {
    throw new SemanticRuntimeRequiredError(lastRuntimeError.message);
  }
  return null;
}

/**
 * AGT-013/AGT-014/SEC-004: planning selects one adapter. Compilation may not
 * silently downgrade to another semantic engine or native SQL after selection.
 */
export function selectSemanticRuntimeAdapters(
  requested: SemanticRuntimeQueryRequest['engine'],
  active: SemanticRuntimeAdapterId,
): SemanticRuntimeAdapterId[] {
  if (requested === 'native') return ['native'];
  if (requested === 'dbt-cloud') return ['dbt-cloud'];
  if (requested === 'metricflow' || requested === 'metricflow-cli') return ['metricflow-cli'];
  return [active];
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
  /** Retained for wire compatibility; selected-adapter failures no longer downgrade. */
  degraded?: string;
}

/**
 * The authoritative per-metric dimension-compatibility answer from the exact
 * adapter selected for execution. A selected adapter failure is preserved; it
 * never becomes a native compatibility answer.
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
      const dimensions: RuntimeCompatibleDimension[] = cloud.map((dimension) => {
        const local = semanticLayer.resolveDimension(dimension.name, metrics);
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
      throw new SemanticRuntimeRequiredError(
        `dbt Cloud dimension listing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
      const dimensions: RuntimeCompatibleDimension[] = mfDims.map((mf) => {
        const tail = mf.qualifiedName.split('__').pop()!.toLowerCase();
        const local = semanticLayer.resolveDimension(mf.qualifiedName, metrics)
          ?? semanticLayer.resolveDimension(tail, metrics);
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
    throw new SemanticRuntimeRequiredError('Local MetricFlow returned no compatible dimensions for the selected metrics.');
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

// Timestamp of the last SUCCESSFUL probe per connection fingerprint. A dbt Cloud
// connection that worked recently must not be demoted to "not ready" by a single
// transient probe failure (network blip / cold connection / rate limit) — that
// flipped the active runtime to native and stranded derived metrics on the
// generic "configure a runtime" error for minutes at a time ("first works, then
// not"). Mirrors the MetricFlow positive-resolution cache.
const cloudLastGoodAt = new Map<string, number>();
const CLOUD_TRUST_WINDOW_MS = 30 * 60_000; // treat a failure as transient if it worked within this window

async function probeDbtCloudSemanticRuntime(projectRoot: string): Promise<DbtCloudSemanticTestResult> {
  const cloud = getEffectiveDbtCloudSemanticSettings(projectRoot);
  if (!cloud.configured || !cloud.fingerprint) {
    return { ok: false, message: 'dbt Cloud Semantic Layer is not configured.' };
  }
  const now = Date.now();
  const cached = cloudProbeCache.get(cloud.fingerprint);
  if (cached && cached.expiresAt > now) return cached.result;

  const result = await testDbtCloudSemanticConnection(cloud);
  if (result.ok) {
    // A working connection stays trusted for a good while.
    cloudProbeCache.set(cloud.fingerprint, { expiresAt: now + 5 * 60_000, result });
    cloudLastGoodAt.set(cloud.fingerprint, now);
    return result;
  }

  // Probe failed. If this connection succeeded within the trust window, treat the
  // failure as transient: keep it ready (better to attempt the real compile and
  // surface a specific cloud error than to silently fall back to native), and
  // retry the probe soon rather than caching the failure for minutes.
  const lastGoodAt = cloudLastGoodAt.get(cloud.fingerprint) ?? 0;
  if (now - lastGoodAt < CLOUD_TRUST_WINDOW_MS) {
    const transient: DbtCloudSemanticTestResult = {
      ok: true,
      message: 'Using the recent successful dbt Cloud connection; a readiness probe failed transiently.',
    };
    cloudProbeCache.set(cloud.fingerprint, { expiresAt: now + 20_000, result: transient });
    return transient;
  }
  // No recent success — cache the failure only briefly so it self-heals fast.
  cloudProbeCache.set(cloud.fingerprint, { expiresAt: now + 20_000, result });
  return result;
}

function selectActiveAdapter(
  preference: SemanticRuntimePreference,
  cloudReady: boolean,
  cliReady: boolean,
): SemanticRuntimeAdapterId {
  // An explicit preference is a route lock, including while setup is broken.
  // Reporting the preferred adapter as active lets every surface return the
  // original readiness/compiler failure instead of silently selecting a
  // different engine with different semantic behavior.
  if (preference === 'dbt-cloud') return 'dbt-cloud';
  if (preference === 'metricflow-cli') return 'metricflow-cli';
  if (preference === 'native') return 'native';
  if (cloudReady) return 'dbt-cloud';
  if (cliReady) return 'metricflow-cli';
  return 'native';
}

export function isSemanticRuntimeError(error: unknown): boolean {
  return error instanceof SemanticRuntimeRequiredError
    || error instanceof SemanticRuntimeCompilationError
    || error instanceof MetricFlowUnavailableError;
}

export function semanticRuntimeErrorCode(
  error: unknown,
): 'SEMANTIC_RUNTIME_REQUIRED' | 'SEMANTIC_COMPILATION_FAILED' | undefined {
  if (error instanceof SemanticRuntimeCompilationError) return error.code;
  if (error instanceof SemanticRuntimeRequiredError || error instanceof MetricFlowUnavailableError) {
    return 'SEMANTIC_RUNTIME_REQUIRED';
  }
  return undefined;
}
