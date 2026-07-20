import type { ComposeQueryResult, SemanticLayer } from '@duckcodeailabs/dql-core';
import {
  compileDbtCloudSemanticQuery,
  listDbtCloudCompatibleDimensions,
  testDbtCloudSemanticConnection,
  type DbtCloudSemanticTestResult,
} from './dbt-cloud-semantic.js';
import { compileMetricFlowQuery, hasMetricFlowCli, MetricFlowUnavailableError } from './metricflow.js';
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
  dbt?: { projectDir?: string };
}

export interface SemanticRuntimeAdapterStatus {
  id: SemanticRuntimeAdapterId;
  label: string;
  bundled: true;
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
}

export class SemanticRuntimeRequiredError extends Error {
  readonly code = 'SEMANTIC_RUNTIME_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'SemanticRuntimeRequiredError';
  }
}

const cloudProbeCache = new Map<string, { expiresAt: number; result: DbtCloudSemanticTestResult }>();

export async function getSemanticRuntimeStatus(
  projectRoot: string,
  options: { probeConfiguredCloud?: boolean } = {},
): Promise<SemanticRuntimeStatus> {
  const redacted = getSemanticRuntimeSettings(projectRoot);
  const cloud = getEffectiveDbtCloudSemanticSettings(projectRoot);
  const cliReady = hasMetricFlowCli();
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
      bundled: true,
      configured: cliReady,
      tested: cliReady,
      ready: cliReady,
      source: cliReady ? 'local' : 'none',
      detail: cliReady
        ? 'Detected a compatible `mf` executable.'
        : 'Adapter is bundled; install a compatible dbt/MetricFlow Python runtime so `mf` is callable.',
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
  const status = await getSemanticRuntimeStatus(context.projectRoot, { probeConfiguredCloud: true });
  const explicit = request.engine;
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
          request,
        );
        return { sql: result.sql, joins: [], tables: [], engine: 'dbt-cloud' };
      } catch (error) {
        lastRuntimeError = error instanceof Error ? error : new Error(String(error));
        if (explicit === 'dbt-cloud') throw lastRuntimeError;
        continue;
      }
    }
    if (adapter === 'metricflow-cli') {
      if (!hasMetricFlowCli()) continue;
      try {
        const dbtProjectPath = context.projectConfig.semanticLayer?.provider === 'dbt'
          ? context.projectConfig.semanticLayer.projectPath
          : context.projectConfig.dbt?.projectDir;
        const compiled = compileMetricFlowQuery({
          projectRoot: context.projectRoot,
          dbtProjectPath,
          metrics: request.metrics,
          dimensions: request.dimensions,
          filters: request.filters,
          timeDimension: request.timeDimension,
          orderBy: request.orderBy,
          limit: request.limit,
          savedQuery: request.savedQuery,
        });
        return { sql: compiled.sql, joins: [], tables: [], engine: 'metricflow-cli' };
      } catch (error) {
        lastRuntimeError = error instanceof Error ? error : new Error(String(error));
        if (explicit === 'metricflow-cli' || explicit === 'metricflow') throw lastRuntimeError;
        continue;
      }
    }
    const composed = context.semanticLayer.composeQuery({
      metrics: request.metrics,
      dimensions: request.dimensions,
      filters: request.filters as Array<{ dimension: string; operator: string; values: string[] }> | undefined,
      limit: request.limit,
      timeDimension: request.timeDimension,
      orderBy: request.orderBy,
      driver: context.driver,
      tableMapping: context.tableMapping,
    });
    if (composed) return { ...composed, engine: 'native' };
  }

  if (fullRuntimeRequested) {
    throw lastRuntimeError ?? new SemanticRuntimeRequiredError(status.setup ?? 'The requested semantic runtime is unavailable.');
  }
  if (lastRuntimeError && !context.semanticLayer.canComposeMetric(request.metrics[0] ?? '')) {
    throw new SemanticRuntimeRequiredError(lastRuntimeError.message);
  }
  return null;
}

export async function listRuntimeCompatibleDimensions(
  projectRoot: string,
  semanticLayer: SemanticLayer,
  metrics: string[],
): Promise<Array<ReturnType<SemanticLayer['listDimensions']>[number]>> {
  if (metrics.length === 0) return [];
  const status = await getSemanticRuntimeStatus(projectRoot, { probeConfiguredCloud: true });
  if (status.active === 'dbt-cloud') {
    const cloud = await listDbtCloudCompatibleDimensions(
      getEffectiveDbtCloudSemanticSettings(projectRoot),
      metrics,
    );
    const localByName = new Map(semanticLayer.listDimensions().map((dimension) => [dimension.name.toLowerCase(), dimension]));
    return cloud.map((dimension) => localByName.get(dimension.name.toLowerCase()) ?? {
      name: dimension.name,
      label: dimension.name.replace(/[_-]+/g, ' '),
      description: dimension.description ?? '',
      domain: '',
      sql: dimension.name,
      type: dimension.type?.toLowerCase() === 'time' ? 'date' : 'string',
      table: '',
      isTimeDimension: dimension.type?.toLowerCase() === 'time',
      granularities: dimension.granularities.map((value) => value.toLowerCase()),
      source: { provider: 'dbt', objectType: 'dimension', objectId: dimension.name, objectName: dimension.name },
    });
  }
  return semanticLayer.listCompatibleDimensions(metrics);
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
