/**
 * Hypothesis-driven research state.
 *
 * `planResearch` emits a fixed three-step template — baseline, compare over
 * time, break down — always bound to ONE metric, with dimensions scraped by
 * `/\bby\s+([a-z_][a-z0-9_]*)/gi`. Its own comment says it is deterministic and
 * offline, `RESEARCH_BUDGET.plannerCalls` is TYPED as the literal `1`, and the
 * branches it fans out are frozen against the root plan.
 *
 * The consequence is the reported one: research answers a question instead of
 * investigating it. A template cannot be wrong, so it never notices that its
 * first finding ruled the premise out, and it never follows the thread that
 * finding opened.
 *
 * What is missing is not more steps. It is the edge from an OBSERVATION back to
 * the plan: a finding has to be able to refute a hypothesis, sharpen it, or
 * spawn a new one. This module owns that edge as a pure state machine, so the
 * part that decides what to investigate next is testable without a provider,
 * a warehouse, or a clock.
 */

export type HypothesisStatus = 'open' | 'supported' | 'refuted' | 'inconclusive';

export interface Hypothesis {
  id: string;
  /** A falsifiable statement, not a task ("revenue fell because enterprise churned"). */
  statement: string;
  /** Belief before any evidence, 0..1. Drives which hypothesis is tested next. */
  priorConfidence: number;
  status: HypothesisStatus;
  /** Ids of observations that bear on this hypothesis. */
  evidenceIds: string[];
  /** Which hypothesis this was spawned from, when a finding opened a new thread. */
  parentId?: string;
  /** Why it reached its current status — carried into the final narrative. */
  rationale?: string;
}

/** What one investigation step established. */
export interface HypothesisFinding {
  id: string;
  hypothesisId: string;
  /**
   * Whether the finding supports, refutes, or fails to settle the hypothesis.
   * `inconclusive` is a real outcome, not a failure: an executed query that
   * simply does not discriminate must not be recorded as support.
   */
  verdict: 'supports' | 'refutes' | 'inconclusive';
  summary: string;
  /** Confidence the finding itself carries, 0..1. */
  strength: number;
  /**
   * A hypothesis this finding suggests testing next. The edge that a frozen
   * branch plan cannot express.
   */
  spawns?: Array<{ statement: string; priorConfidence: number }>;
}

export interface ResearchState {
  rootQuestion: string;
  hypotheses: Hypothesis[];
  findings: HypothesisFinding[];
  hopsUsed: number;
}

export interface ResearchLimits {
  /** Total investigation steps. Bounded: an unbounded loop is an outage. */
  maxHops: number;
  /** Ceiling on live hypotheses, so spawning cannot fan out without end. */
  maxOpenHypotheses: number;
}

export const DEFAULT_RESEARCH_LIMITS: ResearchLimits = {
  maxHops: 12,
  maxOpenHypotheses: 6,
};

export function createResearchState(rootQuestion: string, initial: Array<Omit<Hypothesis, 'status' | 'evidenceIds'>>): ResearchState {
  return {
    rootQuestion,
    hypotheses: initial.map((hypothesis) => ({ ...hypothesis, status: 'open', evidenceIds: [] })),
    findings: [],
    hopsUsed: 0,
  };
}

/**
 * Which hypothesis to test next: the open one with the highest prior.
 *
 * Returns `undefined` when the budget is spent or nothing is open, which is how
 * the caller learns to stop. Deliberately not "cheapest first" — the point of
 * research is to resolve the question, and testing a likely explanation first is
 * what lets a later hop be skipped entirely.
 */
export function nextHypothesis(state: ResearchState, limits: ResearchLimits = DEFAULT_RESEARCH_LIMITS): Hypothesis | undefined {
  if (state.hopsUsed >= limits.maxHops) return undefined;
  return [...state.hypotheses]
    .filter((hypothesis) => hypothesis.status === 'open')
    .sort((left, right) => right.priorConfidence - left.priorConfidence || left.id.localeCompare(right.id))[0];
}

/**
 * Fold a finding into the state — the replan edge.
 *
 * A refutation CLOSES its hypothesis rather than leaving it open to be retried:
 * the template's failure was continuing to elaborate a premise its own evidence
 * had already ruled out.
 *
 * Spawned hypotheses are admitted only while there is room, and never duplicate
 * an existing statement — a loop that keeps re-proposing the same idea burns the
 * whole hop budget without learning anything.
 */
export function applyFinding(
  state: ResearchState,
  finding: HypothesisFinding,
  limits: ResearchLimits = DEFAULT_RESEARCH_LIMITS,
): ResearchState {
  const hypotheses = state.hypotheses.map((hypothesis) => {
    if (hypothesis.id !== finding.hypothesisId) return hypothesis;
    const status: HypothesisStatus = finding.verdict === 'supports'
      ? 'supported'
      : finding.verdict === 'refutes'
        ? 'refuted'
        : 'inconclusive';
    return {
      ...hypothesis,
      status,
      evidenceIds: [...hypothesis.evidenceIds, finding.id],
      rationale: finding.summary,
    };
  });

  const known = new Set(hypotheses.map((hypothesis) => normalizeStatement(hypothesis.statement)));
  const openCount = () => hypotheses.filter((hypothesis) => hypothesis.status === 'open').length;
  for (const spawn of finding.spawns ?? []) {
    const key = normalizeStatement(spawn.statement);
    if (!spawn.statement.trim() || known.has(key)) continue;
    if (openCount() >= limits.maxOpenHypotheses) break;
    known.add(key);
    hypotheses.push({
      id: `${finding.hypothesisId}.${hypotheses.length + 1}`,
      statement: spawn.statement,
      priorConfidence: clamp01(spawn.priorConfidence),
      status: 'open',
      evidenceIds: [],
      parentId: finding.hypothesisId,
    });
  }

  return {
    ...state,
    hypotheses,
    findings: [...state.findings, finding],
    hopsUsed: state.hopsUsed + 1,
  };
}

export interface ResearchConclusion {
  /** Hypotheses the evidence actually settled, strongest first. */
  supported: Hypothesis[];
  refuted: Hypothesis[];
  /** Open or inconclusive — what the investigation could NOT establish. */
  unresolved: Hypothesis[];
  /** True when the hop budget ran out with hypotheses still open. */
  exhausted: boolean;
}

/**
 * Summarise what the investigation established.
 *
 * `unresolved` is reported as prominently as `supported` on purpose. A research
 * answer that lists only what it confirmed reads as a complete explanation, and
 * the one thing a bounded investigation cannot honestly claim is completeness.
 */
export function concludeResearch(state: ResearchState, limits: ResearchLimits = DEFAULT_RESEARCH_LIMITS): ResearchConclusion {
  const byConfidence = (left: Hypothesis, right: Hypothesis): number =>
    right.priorConfidence - left.priorConfidence || left.id.localeCompare(right.id);
  const open = state.hypotheses.filter((hypothesis) => hypothesis.status === 'open');
  return {
    supported: state.hypotheses.filter((h) => h.status === 'supported').sort(byConfidence),
    refuted: state.hypotheses.filter((h) => h.status === 'refuted').sort(byConfidence),
    unresolved: [...open, ...state.hypotheses.filter((h) => h.status === 'inconclusive')].sort(byConfidence),
    exhausted: state.hopsUsed >= limits.maxHops && open.length > 0,
  };
}

function normalizeStatement(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
