/**
 * Non-query Ask readiness probe.
 *
 * This intentionally proves only local configuration/adapter/target binding;
 * it never opens a connector lease or sends SQL. The Ask compiler consumes the
 * result before plan freeze so an unavailable semantic runtime can advance to
 * a separately grounded physical program instead of being mislabeled as a
 * modeling gap.
 */

export type AskTierReadinessStateV1 = 'ready' | 'unavailable' | 'unknown';

export interface AskSemanticAdapterProbeV1 {
  id: string;
  ready: boolean;
  /** Whether this adapter is bound to the selected execution target. */
  targetBound: boolean;
}

export interface AskTierReadinessProbeInputV1 {
  targetConfigured: boolean;
  connectorInstalled: boolean;
  physicalSchemaAvailable: boolean;
  semanticCandidatesPresent: boolean;
  /** Adapter identities required by semantic metadata in this snapshot. */
  requiredSemanticAdapters: string[];
  adapters: AskSemanticAdapterProbeV1[];
  targetFingerprint?: string;
}

export interface AskTierReadinessProbeResultV1 {
  connector: AskTierReadinessStateV1;
  activeTarget: AskTierReadinessStateV1;
  semanticCompiler: AskTierReadinessStateV1;
  physicalSchema: AskTierReadinessStateV1;
  targetFingerprint?: string;
}

function normalizeAdapterId(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized === 'metricflow' ? 'metricflow-cli' : normalized;
}

/** Pure and testable; callers perform their own non-query configuration reads. */
export function probeAskTierReadinessV1(input: AskTierReadinessProbeInputV1): AskTierReadinessProbeResultV1 {
  const connector = input.targetConfigured && input.connectorInstalled ? 'ready' : 'unavailable';
  const activeTarget = input.targetConfigured ? 'ready' : 'unavailable';
  const required = [...new Set(input.requiredSemanticAdapters.map(normalizeAdapterId).filter(Boolean))];
  const byId = new Map(input.adapters.map((adapter) => [normalizeAdapterId(adapter.id), adapter]));
  // Native semantic composition is an in-process compiler. It can prove and
  // freeze an authored semantic program from the local semantic snapshot even
  // when no warehouse connection has been configured yet. The later execution
  // boundary remains responsible for reporting CONNECTION_NOT_CONFIGURED; do
  // not incorrectly turn that post-freeze setup failure into a pre-freeze
  // semantic availability failure (and silently route toward raw SQL).
  //
  // An adapter must be installed/healthy before the semantic compiler can be
  // selected. Target binding is a separate condition: it is required once a
  // target is selected, while a missing target remains a post-freeze
  // connection/setup boundary. Treating an unready external adapter as ready
  // merely because no target was selected hid real MetricFlow installation
  // failures behind a semantic route that could never compile.
  const adapterCompilerReady = (id: string): boolean => {
    if (id === 'native') return true;
    const adapter = byId.get(id);
    return Boolean(adapter?.ready);
  };
  const adapterReadyForTarget = (id: string): boolean => {
    if (!adapterCompilerReady(id)) return false;
    if (id === 'native') return true;
    return Boolean(byId.get(id)?.targetBound);
  };
  const semanticCompiler = !input.semanticCandidatesPresent
    ? 'unavailable'
    // No execution target is a post-freeze setup boundary, not evidence that
    // the snapshot's semantic contract cannot be compiled. Keep a semantic
    // plan semantic in this state so users see the actionable connection
    // failure rather than an unrelated exploratory/no-coverage result.
    : required.length === 0
      ? (adapterCompilerReady('native') ? 'ready' : 'unavailable')
      : input.targetConfigured
        ? (required.some(adapterReadyForTarget) ? 'ready' : 'unavailable')
        : (required.some(adapterCompilerReady) ? 'ready' : 'unavailable');
  return {
    connector,
    activeTarget,
    semanticCompiler,
    physicalSchema: input.physicalSchemaAvailable ? 'ready' : 'unavailable',
    ...(input.targetFingerprint ? { targetFingerprint: input.targetFingerprint } : {}),
  };
}
