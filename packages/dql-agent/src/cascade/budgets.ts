import type { AnalysisQuestionPlan } from '../metadata/analysis-planner.js';
import type { ReasoningEffort } from '../providers/reasoning-effort.js';

export type CascadeLaneRepairKind = 'reground' | 'execution';
export type CascadeAnalysisDepth = 'quick' | 'deep';
export type ProposalToolBudgetClass = 'lookup' | 'multi_entity' | 'deep_research';
export type ContextRetrievalStrictness = 'balanced' | 'exploratory';

export interface CascadeLaneBudgetLimits {
  reground: number;
  execution: number;
}

export interface CascadeBudgetModel {
  lane: CascadeLaneBudgetLimits;
  engineEscalations: number;
  /**
   * MCP tier-2 has no persistent run state yet, so it advertises a bounded
   * re-ground policy that callers can apply before retrying query_via_metadata.
   */
  mcpTier2Reground: number;
}

export interface CascadeBudgetUsage {
  laneRegroundAttemptsUsed: number;
  laneExecutionAttemptsUsed: number;
  engineEscalationsUsed: number;
}

export interface CascadeBudgetTrace {
  limits: CascadeBudgetModel;
  usage: CascadeBudgetUsage;
}

export interface CascadeBudgetState {
  readonly limits: CascadeBudgetModel;
  readonly usage: CascadeBudgetUsage;
}

export interface McpTier2RepairBudget {
  kind: 'reground';
  attemptsUsed: number;
  maxAttempts: number;
  attemptsRemaining: number;
  nextTool: 'expand_context';
}

export interface ProposalToolBudget {
  maxToolCalls: number;
  effortClass: ProposalToolBudgetClass;
  reason: string;
}

export interface ProposalToolBudgetOptions {
  analysisDepth?: CascadeAnalysisDepth;
  reasoningEffort?: ReasoningEffort;
}

export interface PromptContextBudget {
  label: CascadeAnalysisDepth;
  schemaTableLimit: number;
  schemaColumnLimit: number;
  contextObjectLimit: number;
  warningLimit: number;
  relationCardLimit: number;
  relationColumnLimit: number;
  selectedRelationReasonLimit: number;
  joinPathLimit: number;
  lineageEdgeLimit: number;
  otherRelationStart: number;
  otherRelationEnd: number;
  otherRelationLimit: number;
  sourceSqlLimit: number;
  sourceSqlColumnLimit: number;
  edgeLimit: number;
}

export interface ContextRetrievalBudget {
  analysisDepth: CascadeAnalysisDepth;
  strictness: ContextRetrievalStrictness;
  limit: number;
}

export const DEFAULT_CASCADE_BUDGET_MODEL: CascadeBudgetModel = {
  lane: {
    reground: 2,
    execution: 2,
  },
  engineEscalations: 2,
  mcpTier2Reground: 1,
};

export const QUICK_PROMPT_CONTEXT_BUDGET: PromptContextBudget = {
  label: 'quick',
  schemaTableLimit: 12,
  schemaColumnLimit: 50,
  contextObjectLimit: 18,
  warningLimit: 8,
  relationCardLimit: 12,
  relationColumnLimit: 32,
  selectedRelationReasonLimit: 8,
  joinPathLimit: 8,
  lineageEdgeLimit: 12,
  otherRelationStart: 12,
  otherRelationEnd: 40,
  otherRelationLimit: 24,
  sourceSqlLimit: 5,
  sourceSqlColumnLimit: 24,
  edgeLimit: 0,
};

export const DEEP_PROMPT_CONTEXT_BUDGET: PromptContextBudget = {
  label: 'deep',
  schemaTableLimit: 40,
  schemaColumnLimit: 120,
  contextObjectLimit: 80,
  warningLimit: 24,
  relationCardLimit: 40,
  relationColumnLimit: 120,
  selectedRelationReasonLimit: 24,
  joinPathLimit: 24,
  lineageEdgeLimit: 40,
  otherRelationStart: 40,
  otherRelationEnd: 120,
  otherRelationLimit: 80,
  sourceSqlLimit: 12,
  sourceSqlColumnLimit: 48,
  edgeLimit: 80,
};

export function createCascadeBudgetState(
  overrides: PartialCascadeBudgetModel = {},
): CascadeBudgetState {
  return {
    limits: mergeCascadeBudgetModel(overrides),
    usage: {
      laneRegroundAttemptsUsed: 0,
      laneExecutionAttemptsUsed: 0,
      engineEscalationsUsed: 0,
    },
  };
}

export type PartialCascadeBudgetModel = {
  lane?: Partial<CascadeLaneBudgetLimits>;
  engineEscalations?: number;
  mcpTier2Reground?: number;
};

export function mergeCascadeBudgetModel(overrides: PartialCascadeBudgetModel = {}): CascadeBudgetModel {
  return {
    lane: {
      reground: normalizeBudgetLimit(overrides.lane?.reground, DEFAULT_CASCADE_BUDGET_MODEL.lane.reground),
      execution: normalizeBudgetLimit(overrides.lane?.execution, DEFAULT_CASCADE_BUDGET_MODEL.lane.execution),
    },
    engineEscalations: normalizeBudgetLimit(overrides.engineEscalations, DEFAULT_CASCADE_BUDGET_MODEL.engineEscalations),
    mcpTier2Reground: normalizeBudgetLimit(overrides.mcpTier2Reground, DEFAULT_CASCADE_BUDGET_MODEL.mcpTier2Reground),
  };
}

export function canUseLaneRepair(state: CascadeBudgetState, kind: CascadeLaneRepairKind): boolean {
  return laneRepairAttemptsUsed(state, kind) < state.limits.lane[kind];
}

export function recordLaneRepair(state: CascadeBudgetState, kind: CascadeLaneRepairKind): CascadeBudgetUsage {
  if (kind === 'reground') {
    state.usage.laneRegroundAttemptsUsed += 1;
  } else {
    state.usage.laneExecutionAttemptsUsed += 1;
  }
  return cascadeBudgetUsage(state);
}

export function canUseEngineEscalation(state: CascadeBudgetState): boolean {
  return state.usage.engineEscalationsUsed < state.limits.engineEscalations;
}

export function recordEngineEscalation(state: CascadeBudgetState): CascadeBudgetUsage {
  state.usage.engineEscalationsUsed += 1;
  return cascadeBudgetUsage(state);
}

export function cascadeBudgetUsage(state: CascadeBudgetState): CascadeBudgetUsage {
  return {
    laneRegroundAttemptsUsed: state.usage.laneRegroundAttemptsUsed,
    laneExecutionAttemptsUsed: state.usage.laneExecutionAttemptsUsed,
    engineEscalationsUsed: state.usage.engineEscalationsUsed,
  };
}

export function cascadeBudgetTrace(state: CascadeBudgetState): CascadeBudgetTrace {
  return {
    limits: {
      lane: { ...state.limits.lane },
      engineEscalations: state.limits.engineEscalations,
      mcpTier2Reground: state.limits.mcpTier2Reground,
    },
    usage: cascadeBudgetUsage(state),
  };
}

export function mcpTier2RegroundRepairBudget(
  attemptsUsed = 0,
  model: PartialCascadeBudgetModel = {},
): McpTier2RepairBudget {
  const maxAttempts = mergeCascadeBudgetModel(model).mcpTier2Reground;
  const used = normalizeBudgetLimit(attemptsUsed, 0);
  return {
    kind: 'reground',
    attemptsUsed: used,
    maxAttempts,
    attemptsRemaining: Math.max(0, maxAttempts - used),
    nextTool: 'expand_context',
  };
}

/**
 * Classify a question by analytical shape (S1). This is the ONE signal that drives
 * depth, tool budget, and the number of verification candidates — decoupled from
 * `reasoningEffort` so that "think harder on a call" and "run the heavy verification
 * pipeline N times" are no longer welded to the same knob:
 *   - `deep_research` — diagnosis / driver / anomaly / research workspace / trust gap
 *   - `multi_entity`  — joins, >1 dimension, filtered breakdowns, ranked, comparisons
 *   - `lookup`        — a single metric / single-table question (no joins → no fan-out)
 */
export function questionShapeClass(plan: AnalysisQuestionPlan, intent?: string): ProposalToolBudgetClass {
  if (
    plan.needsResearchWorkspace
    || plan.mode === 'diagnose_change'
    || plan.mode === 'driver_breakdown'
    || plan.mode === 'anomaly'
    || intent === 'diagnose_change'
    || intent === 'driver_breakdown'
    || intent === 'anomaly_investigation'
    || intent === 'trust_gap_review'
  ) {
    return 'deep_research';
  }
  const shape = plan.requestedShape;
  const entityOrJoinShape = plan.entities.length > 0
    || shape.dimensions.length > 1
    || shape.requiredOutputs.length > 2
    || (shape.filters.length > 0 && shape.dimensions.length > 0)
    || Boolean(shape.topN)
    || plan.mode === 'comparison'
    || plan.mode === 'entity_profile'
    || plan.mode === 'entity_drilldown';
  return entityOrJoinShape ? 'multi_entity' : 'lookup';
}

/**
 * How many diverse alternative candidates the self-consistency vote generates.
 * `lookup` skips the vote entirely (0 — quick path, guarded by the grain ledger +
 * validateSql); `multi_entity` does a lightweight 1-alternative agreement check;
 * `deep_research` does the full 3-alternative vote. This is the class-B tradeoff:
 * verification scales to the question's actual join/analysis complexity.
 */
export function deepAlternativeCountForQuestion(plan: AnalysisQuestionPlan, intent?: string): number {
  switch (questionShapeClass(plan, intent)) {
    case 'deep_research': return 3;
    case 'multi_entity': return 1;
    default: return 0;
  }
}

export function analysisDepthForQuestion(
  plan: AnalysisQuestionPlan,
  reasoningEffort?: ReasoningEffort,
  requestedDepth?: CascadeAnalysisDepth,
  intent?: string,
): CascadeAnalysisDepth {
  // A user-selected depth (e.g. the "thinking" chip) always wins. Otherwise depth
  // is decided by the question's SHAPE, not its reasoning effort — a single-table
  // lookup runs the fast path even at high effort; a join/breakdown/diagnosis runs
  // the verification path even at low effort. `reasoningEffort` is intentionally NOT
  // consulted here (that is the S1 decouple).
  if (requestedDepth) return requestedDepth;
  return questionShapeClass(plan, intent) === 'lookup' ? 'quick' : 'deep';
}

export function promptContextBudgetForQuestion(input: {
  questionPlan: AnalysisQuestionPlan;
  requestedDepth?: CascadeAnalysisDepth;
  reasoningEffort?: ReasoningEffort;
}): PromptContextBudget {
  return analysisDepthForQuestion(input.questionPlan, input.reasoningEffort, input.requestedDepth) === 'deep'
    ? DEEP_PROMPT_CONTEXT_BUDGET
    : QUICK_PROMPT_CONTEXT_BUDGET;
}

export function contextRetrievalBudgetForQuestion(input: {
  questionPlan: AnalysisQuestionPlan;
  requestedDepth?: CascadeAnalysisDepth;
  reasoningEffort?: ReasoningEffort;
}): ContextRetrievalBudget {
  const analysisDepth = analysisDepthForQuestion(input.questionPlan, input.reasoningEffort, input.requestedDepth);
  return analysisDepth === 'deep'
    ? { analysisDepth, strictness: 'exploratory', limit: 160 }
    : { analysisDepth, strictness: 'balanced', limit: 100 };
}

export function proposalToolBudgetForQuestion(
  plan: AnalysisQuestionPlan,
  intent: string,
  _options: ProposalToolBudgetOptions = {},
): ProposalToolBudget {
  // Tool budget follows the question's SHAPE, not its reasoning effort / analysis
  // depth (the S1 decouple). Previously a high-effort or deep-depth signal forced
  // the 15-call deep_research budget on every generated answer — which, combined
  // with generated_answer defaulting to `high`, is what made simple questions slow.
  switch (questionShapeClass(plan, intent)) {
    case 'deep_research':
      return {
        maxToolCalls: 15,
        effortClass: 'deep_research',
        reason: 'deep analysis, diagnosis, anomaly, trust review, or research workspace request',
      };
    case 'multi_entity':
      return {
        // 10 (was 8) leaves headroom for one extra schema-discovery round-trip
        // (search_metadata + get_table_schema) on a join question without changing
        // the latency class — see P3. Lookup stays at 3 to preserve the S1 fast path.
        maxToolCalls: 10,
        effortClass: 'multi_entity',
        reason: 'multi-entity, ranked, filtered, comparison, profile, or drilldown shape',
      };
    default:
      return {
        maxToolCalls: 3,
        effortClass: 'lookup',
        reason: 'single metric or simple generated lookup',
      };
  }
}

function laneRepairAttemptsUsed(state: CascadeBudgetState, kind: CascadeLaneRepairKind): number {
  return kind === 'reground'
    ? state.usage.laneRegroundAttemptsUsed
    : state.usage.laneExecutionAttemptsUsed;
}

function normalizeBudgetLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}
