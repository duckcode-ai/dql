/**
 * Which orchestrator handles a turn.
 *
 * The rebuild is a strangler, not a rewrite: the new loop runs BESIDE the
 * 10k-line answer loop and takes traffic one lane at a time. `answer-loop.ts`
 * grew from 4,532 to 10,105 lines over 300 commits because every fix had to land
 * inside it; the only way that stops is for new behaviour to have somewhere else
 * to go while the old path keeps serving.
 *
 * Default is `legacy` on purpose. A flag that defaults on is not a migration
 * control, it is a release — and this one changes how every question is answered.
 */

export type OrchestratorMode = 'legacy' | 'shadow' | 'agentic';

/**
 * Lanes migrate independently, cheapest risk first. `certified` and `semantic`
 * go early precisely because the agentic path for them is a BYPASS (no planner,
 * no tools) — it is the <5s fast lane, not new reasoning.
 */
export type AgenticLane =
  | 'conversational'
  | 'definition'
  | 'certified'
  | 'semantic'
  | 'generated'
  | 'research';

export const AGENTIC_LANES: readonly AgenticLane[] = [
  'conversational', 'definition', 'certified', 'semantic', 'generated', 'research',
];

export interface OrchestratorPolicy {
  mode: OrchestratorMode;
  lanes: ReadonlySet<AgenticLane>;
  maxIterations: number;
  /** Fall back to the legacy loop when the agentic path throws. */
  fallbackOnError: boolean;
}

/** Bounded by default: an agent loop without a ceiling is an outage waiting to happen. */
export const DEFAULT_MAX_ITERATIONS = 8;

export const LEGACY_ORCHESTRATOR_POLICY: OrchestratorPolicy = {
  mode: 'legacy',
  lanes: new Set<AgenticLane>(),
  maxIterations: DEFAULT_MAX_ITERATIONS,
  fallbackOnError: true,
};

function parseMode(value: unknown): OrchestratorMode | undefined {
  return value === 'legacy' || value === 'shadow' || value === 'agentic' ? value : undefined;
}

function parseLanes(value: unknown): Set<AgenticLane> | undefined {
  if (!Array.isArray(value)) return undefined;
  const lanes = new Set<AgenticLane>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    if ((AGENTIC_LANES as readonly string[]).includes(entry)) lanes.add(entry as AgenticLane);
  }
  return lanes;
}

/**
 * Resolve the policy from project config plus an optional host override.
 *
 * Malformed input resolves to `legacy` rather than to a partial agentic policy.
 * A typo in `dql.config.json` must not silently route real questions through an
 * unproven path.
 */
export function resolveOrchestratorPolicy(input: {
  config?: { mode?: unknown; lanes?: unknown; maxIterations?: unknown; fallbackOnError?: unknown } | null;
  /** Host-owned per-request override; never parsed from user-facing request fields. */
  override?: { mode?: unknown; lanes?: unknown } | null;
} = {}): OrchestratorPolicy {
  const mode = parseMode(input.override?.mode) ?? parseMode(input.config?.mode) ?? 'legacy';
  const lanes = parseLanes(input.override?.lanes) ?? parseLanes(input.config?.lanes) ?? new Set<AgenticLane>();
  const rawIterations = input.config?.maxIterations;
  const maxIterations = typeof rawIterations === 'number' && Number.isFinite(rawIterations) && rawIterations > 0
    ? Math.min(Math.floor(rawIterations), 40)
    : DEFAULT_MAX_ITERATIONS;
  return {
    mode,
    lanes,
    maxIterations,
    fallbackOnError: input.config?.fallbackOnError !== false,
  };
}

/**
 * Does this lane run on the agentic path?
 *
 * `shadow` deliberately answers NO. Shadow runs the new loop for comparison only;
 * letting it serve the user would make "observe before switching" meaningless.
 */
export function laneUsesAgenticOrchestrator(policy: OrchestratorPolicy, lane: AgenticLane): boolean {
  return policy.mode === 'agentic' && policy.lanes.has(lane);
}

/** Should the new loop run purely for comparison on this lane? */
export function laneRunsShadowComparison(policy: OrchestratorPolicy, lane: AgenticLane): boolean {
  return policy.mode === 'shadow' && policy.lanes.has(lane);
}
