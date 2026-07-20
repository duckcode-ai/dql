import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  classifyConversationalTurn,
  decideAgentAction,
  type IntentDecision,
  type IntentSignals,
} from "./intent-controller.js";
import { selectCascadeRunRoute } from "./cascade/route-policy.js";
import {
  canUseEngineEscalation,
  canUseLaneRepair,
  cascadeBudgetTrace,
  createCascadeBudgetState,
  recordEngineEscalation,
  recordLaneRepair,
  type CascadeAnalysisDepth,
  type CascadeBudgetTrace,
  type PartialCascadeBudgetModel,
} from "./cascade/budgets.js";
import type { MetadataAgentIntent } from "./metadata/catalog.js";
import type { ReasoningEffort, ThinkingMode } from "./providers/reasoning-effort.js";

export type AgentRunRequestedMode = "auto" | "ask" | "research" | "sql" | "block" | "app";

/**
 * Who the run serves. `analyst` (the Notebook) keeps every route, including
 * authoring (sql_cell, dql_block_draft). `stakeholder` (Chat / Apps / Research)
 * is consumption-only: authoring routes collapse to a governed answer and the
 * run offers a "request certification" handoff instead of inline authoring.
 */
export type AgentRunAudience = "stakeholder" | "analyst";

/** Routes a stakeholder may never land on (analyst authoring lives in the Notebook). */
const ANALYST_ONLY_ROUTES = new Set<AgentRunRoute>(["sql_cell", "dql_block_draft"]);

export type AgentRunRoute =
  | "conversation"
  | "certified_answer"
  | "semantic_answer"
  | "generated_answer"
  | "research"
  | "sql_cell"
  | "dql_block_draft"
  | "app_build"
  | "clarify"
  | "blocked";

/**
 * How the run's answer should be read for trust. `governed` is the default (a
 * data answer grounded in certified/generated SQL). `conversational` and
 * `general_knowledge` mark replies that do NOT come from the warehouse — the UI
 * renders them as plain chat and never attaches a data-trust badge.
 */
export type AgentRunAnswerKind = "governed" | "conversational" | "general_knowledge";

export type AgentRunStatus = "completed" | "needs_review" | "needs_clarification" | "blocked";
export type AgentRunTrustState = "certified" | "governed" | "grounded" | "review_required" | "blocked" | "not_applicable";

export type AgentRunStopReason =
  | "conversational_reply"
  | "certified_answer_found"
  | "governed_semantic_answer"
  | "generated_review_required"
  | "artifact_created"
  | "needs_clarification"
  | "human_review_required"
  | "blocked";

export type AgentRunArtifactKind =
  | "answer"
  | "research_run"
  | "sql_cell"
  | "dql_block_draft"
  | "app_draft"
  /** Two-phase app build: the confirmable pre-create content list. */
  | "app_proposal";

export type AgentRunEvaluationSeverity = "info" | "warning" | "blocking";

/**
 * How the loop should react when an evaluation fails.
 * - `retry`   → re-run the same route with the repair hint (the executor owns
 *   the actual repair, e.g. the answer-loop SQL repair or reflect-before-certify).
 * - `escalate`→ switch to a different route (e.g. answer that can't be grounded
 *   escalates to research; an app build with no coverage escalates to a block draft).
 * When omitted, a failing evaluation is terminal for its severity.
 */
export interface AgentRunRepairAction {
  kind: "retry" | "escalate";
  route?: AgentRunRoute;
  hint?: string;
}

export interface AgentRunEvaluation {
  id: string;
  label: string;
  passed: boolean;
  severity: AgentRunEvaluationSeverity;
  message: string;
  evidence?: unknown;
  /** Human-facing repair suggestion; presence also marks the eval as actionable. */
  suggestedRepair?: string;
  /** Machine-facing remediation the engine loop should attempt. */
  repairAction?: AgentRunRepairAction;
}

export interface AgentRunArtifact {
  id: string;
  kind: AgentRunArtifactKind;
  title: string;
  trustState: AgentRunTrustState;
  ref?: string;
  payload?: unknown;
}

export interface AgentRunNextAction {
  id: string;
  label: string;
  route?: AgentRunRoute;
  artifactKind?: AgentRunArtifactKind;
}

export interface AgentRunClarificationOption {
  /** Stable retrieved evidence ID; display text must never be used as identity. */
  id: string;
  label: string;
  description?: string;
  kind?: string;
}

export interface AgentRunSelectedObject {
  kind: "notebook" | "cell" | "block" | "app" | "dashboard" | "research" | "workspace";
  id?: string;
  title?: string;
  path?: string;
}

export interface AgentRunRequest {
  question: string;
  /** Exact candidate selected from a prior structured clarification. */
  selectedEvidenceId?: string;
  requestedMode?: AgentRunRequestedMode;
  /** Defaults to "analyst" (Notebook). Stakeholder surfaces pass "stakeholder". */
  audience?: AgentRunAudience;
  intent?: MetadataAgentIntent;
  signals?: IntentSignals;
  selectedObject?: AgentRunSelectedObject;
  workspaceContext?: Record<string, unknown>;
  conversationContext?: Record<string, unknown>;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  /** Server-side conversation thread this run belongs to (persistence + resume). */
  threadId?: string;
  runId?: string;
  /** Optional run-specific model effort. Hosts should still apply provider/settings ceilings. */
  reasoningEffort?: ReasoningEffort;
  /** Optional run-specific context depth for governed answer retrieval and prompting. */
  analysisDepth?: CascadeAnalysisDepth;
  /**
   * The user's chat-composer "thinking" selection for this thread. `auto` (or
   * unset) defers to shape-adaptive routing; `low`/`medium`/`high` resolve to an
   * effort+depth bundle via `resolveThinkingMode`. Explicit `reasoningEffort` /
   * `analysisDepth` above (e.g. CLI flags) take precedence over this.
   */
  thinkingMode?: ThinkingMode;
  /** Host-only cancellation signal. JSON request parsers must never hydrate it. */
  signal?: AbortSignal;
}

export interface AgentRunEvent {
  id: string;
  runId: string;
  type:
    | "run.started"
    | "plan.created"
    | "step.started"
    | "route.decided"
    | "executor.started"
    | "evaluation.recorded"
    | "replan.decided"
    | "repair.attempted"
    | "escalated"
    | "artifact.created"
    | "step.completed"
    | "run.completed"
    | "run.failed";
  at: string;
  message: string;
  route?: AgentRunRoute;
  status?: AgentRunStatus;
  trustState?: AgentRunTrustState;
  payload?: unknown;
}

/** A single planned step (the plan is an ordered list of these). */
export interface AgentRunPlannedStep {
  id: string;
  route: AgentRunRoute;
  goal: string;
  successCriteria: string[];
}

export type AgentRunPlanSource = "llm" | "deterministic";

export interface AgentRunPlan {
  source: AgentRunPlanSource;
  rationale: string;
  steps: AgentRunPlannedStep[];
}

export type AgentRunStepStatus =
  | "passed"
  | "repaired"
  | "needs_review"
  | "escalated"
  | "clarify"
  | "blocked";

/** A step after it has executed — carries its evaluations + artifacts for the trace. */
export interface AgentRunStep {
  id: string;
  index: number;
  route: AgentRunRoute;
  resolvedRoute?: AgentRunRoute;
  goal: string;
  successCriteria: string[];
  status: AgentRunStepStatus;
  attempts: number;
  summary?: string;
  evaluations: AgentRunEvaluation[];
  artifacts: AgentRunArtifact[];
}

export interface AgentRun {
  id: string;
  question: string;
  requestedMode: AgentRunRequestedMode;
  route: AgentRunRoute;
  status: AgentRunStatus;
  trustState: AgentRunTrustState;
  stopReason: AgentRunStopReason;
  startedAt: string;
  completedAt: string;
  selectedObject?: AgentRunSelectedObject;
  routeDecision?: IntentDecision;
  plan?: AgentRunPlan;
  steps: AgentRunStep[];
  summary: string;
  answer?: string;
  /** How to read `answer` for trust; defaults to "governed". */
  answerKind?: AgentRunAnswerKind;
  artifacts: AgentRunArtifact[];
  evaluations: AgentRunEvaluation[];
  events: AgentRunEvent[];
  nextActions: AgentRunNextAction[];
  clarificationOptions?: AgentRunClarificationOption[];
  /** Same-lane repair reruns. Escalations are tracked separately. */
  repairAttempts: number;
  /** Engine-level route escalations, separate from same-lane repairs. */
  escalationAttempts?: number;
  /** Visible budget model and spend for audits/traces. */
  budgetUsage?: CascadeBudgetTrace;
}

export interface AgentRouteExecutionContext {
  runId: string;
  request: AgentRunRequest;
  route: AgentRunRoute;
  routeDecision?: IntentDecision;
  maxRepairAttempts: number;
  /** 0 on the first build of a step; increments on each repair re-run. */
  attempt: number;
  /** The goal the planner assigned to this step. */
  stepGoal?: string;
  /** Evaluations from the previous attempt (so executors can target the repair). */
  priorEvaluations?: AgentRunEvaluation[];
  /** The repair hint the loop wants this re-run to act on. */
  repairHint?: string;
  emit: (event: Omit<AgentRunEvent, "id" | "runId" | "at">) => void;
  /**
   * Stream answer text to the client as it is generated. Deltas are transient
   * (never persisted on the run) — the final `answer` remains authoritative.
   * A no-op when the host did not wire streaming.
   */
  emitAnswerDelta?: (delta: string) => void;
}

export interface AgentRouteExecutorResult {
  summary?: string;
  answer?: string;
  /**
   * Route resolved by a deeper executor-owned cascade. For example, Ask mode may
   * execute through the generated-answer route, then the answer loop can prove
   * the result came from a certified block.
   */
  resolvedRoute?: AgentRunRoute;
  /**
   * Cascade tier that actually produced the answer (certified_block /
   * semantic_metric / generated_sql / business_context / no_answer). Lets the
   * engine short-circuit on a governed tier even when the route was generated_answer.
   */
  answerTier?: string;
  /** How to read `answer` for trust; defaults to "governed". */
  answerKind?: AgentRunAnswerKind;
  status?: AgentRunStatus;
  trustState?: AgentRunTrustState;
  stopReason?: AgentRunStopReason;
  /**
   * When this result is a governed no-answer, the reason the answer loop refused —
   * so the gate can distinguish a genuine clarify (`ambiguous`) from a retryable
   * decline (`model_declined`) or grounding gap without inspecting prose. Absent
   * for any successful answer.
   */
  answerRefusalCode?: 'grounding_gap' | 'modeling_gap' | 'ambiguous' | 'model_declined' | 'provider_error' | 'policy_blocked';
  artifacts?: AgentRunArtifact[];
  evaluations?: AgentRunEvaluation[];
  nextActions?: AgentRunNextAction[];
  repairAttempts?: number;
}

export type AgentRouteExecutor = (
  context: AgentRouteExecutionContext,
) => AgentRouteExecutorResult | Promise<AgentRouteExecutorResult>;

export type AgentRunExecutors = Partial<Record<AgentRunRoute, AgentRouteExecutor>>;

/** A gate evaluates an executed step's result and returns authoritative evaluations. */
export interface AgentRunGateContext {
  route: AgentRunRoute;
  request: AgentRunRequest;
  routeDecision?: IntentDecision;
  result: AgentRouteExecutorResult;
  attempt: number;
}

export type AgentRunGate = (context: AgentRunGateContext) => AgentRunEvaluation[];

export type AgentRunGates = Partial<Record<AgentRunRoute, AgentRunGate>>;

export interface AgentRunPlanInput {
  request: AgentRunRequest;
  routeDecision: IntentDecision;
  defaultRoute: AgentRunRoute;
  maxSteps: number;
  audience: AgentRunAudience;
}

export interface AgentRunReplanInput {
  request: AgentRunRequest;
  plan: AgentRunPlan;
  currentStep: AgentRunStep;
  remainingSteps: AgentRunPlannedStep[];
  attemptsUsed: number;
  repairAttemptsUsed: number;
  maxRepairAttempts: number;
  engineEscalationsUsed?: number;
  maxEngineEscalations?: number;
  budgetUsage?: CascadeBudgetTrace;
}

export type AgentRunReplanDecision =
  | { decision: "accept" }
  | { decision: "repair"; repairHint: string }
  | { decision: "escalate"; route: AgentRunRoute; goal?: string; repairHint?: string }
  | { decision: "clarify"; question?: string };

export interface AgentRunPlanner {
  plan(input: AgentRunPlanInput): AgentRunPlan | Promise<AgentRunPlan>;
  replan(input: AgentRunReplanInput): AgentRunReplanDecision | Promise<AgentRunReplanDecision>;
}

export interface AgentRunStore {
  save(run: AgentRun): void | Promise<void>;
  get(id: string): AgentRun | undefined | Promise<AgentRun | undefined>;
  list?(): AgentRun[] | Promise<AgentRun[]>;
}

/**
 * An injectable router that decides the high-level action for a request. When
 * present the engine awaits it instead of the built-in deterministic decision;
 * a forced `requestedMode` still bypasses routing entirely. The router itself is
 * responsible for its own fallback (heuristics) when an LLM is unavailable.
 */
export interface AgentRouter {
  decide(request: AgentRunRequest): IntentDecision | Promise<IntentDecision>;
}

export interface AgentRunEngineOptions {
  executors?: AgentRunExecutors;
  gates?: AgentRunGates;
  planner?: AgentRunPlanner;
  router?: AgentRouter;
  store?: AgentRunStore;
  idGenerator?: () => string;
  now?: () => Date;
  maxRepairAttempts?: number;
  maxEngineEscalations?: number;
  budgets?: PartialCascadeBudgetModel;
  maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 4;

/**
 * Routes whose gate failure is better answered by switching routes than by
 * re-running the same executor (repair can't add what the route can't produce).
 */
export const AGENT_RUN_ESCALATION_MAP: Partial<Record<AgentRunRoute, AgentRunRoute>> = {
  // Ordinary answers never silently turn into Research. A certified shape gap
  // may still explicitly escalate to generated_answer through its gate; after
  // the one bounded generated repair, the result remains visible for review.
  app_build: "dql_block_draft",
};

/** Resolve the request's audience, defaulting to analyst (Notebook) for back-compat. */
export function resolveAudience(request: AgentRunRequest): AgentRunAudience {
  return request.audience ?? "analyst";
}

/** A stakeholder may never land on an authoring route — collapse it to a governed answer. */
export function constrainRouteForAudience(route: AgentRunRoute, audience: AgentRunAudience): AgentRunRoute {
  if (audience === "stakeholder" && ANALYST_ONLY_ROUTES.has(route)) return "generated_answer";
  return route;
}

/**
 * "Answer anyway, labeled" — get a best-effort governed answer rather than a
 * dead-end clarify. The answer loop does its own grounding/retrieval and can still
 * return a needs-clarification result if it genuinely can't proceed.
 *
 * - A SOFT clarify ("nothing governed matched") is answered anyway for EVERY
 *   audience — analysts included — so a real analytical question never dead-ends.
 * - A genuine clarify (explicit missing context, explicit clarify intent, or a
 *   trust-gap review) stays a clarify for analysts; stakeholders keep the legacy
 *   answer-anyway affordance unless the catalog explicitly flagged missing context.
 */
export function answerAnywayRoute(
  route: AgentRunRoute,
  request: AgentRunRequest,
  audience: AgentRunAudience,
  decision?: IntentDecision,
): AgentRunRoute {
  if (route !== "clarify") return route;
  // Meaning resolution found real, material ambiguity. This is a hard safety
  // boundary: generated SQL must not guess which similarly named metric/block
  // the user intended.
  if (decision?.requiresClarification === true) return "clarify";
  const explicitMissing = (request.signals?.missingContext?.length ?? 0) > 0;
  const explicitClarifyIntent = request.intent === "clarify" || request.intent === "trust_gap_review";
  // A router suggestion alone is not enough to dead-end an answerable data
  // question. Let the governed answer loop search certified/semantic context and
  // generate review-required DQL; it can still return a precise clarification if
  // execution genuinely lacks required context.
  if (!explicitMissing && !explicitClarifyIntent) return "generated_answer";
  if (decision?.clarifySoft === true && !explicitMissing) return "generated_answer";
  if (audience === "stakeholder" && !explicitMissing) return "generated_answer";
  return "clarify";
}

export interface ClarificationContinuation {
  sourceQuestion: string;
  clarifyingQuestion: string;
  reply: string;
  resolvedQuestion: string;
}

/**
 * Resolve the turn immediately after a persisted clarification. The visible run
 * still keeps the user's short reply (for example, "yes"), while executors receive
 * the original analytical question plus the reply so metadata retrieval does not
 * restart from a context-free word and ask the same clarification again.
 */
export function resolveClarificationContinuation(request: AgentRunRequest): ClarificationContinuation | undefined {
  const reply = request.question.trim();
  if (!reply || looksLikeNewQuestionAfterClarification(reply)) return undefined;

  const fromServer = latestClarificationFromConversationContext(request.conversationContext);
  const fromHistory = latestClarificationFromHistory(request.history);
  const pending = fromServer ?? fromHistory;
  if (!pending || pending.sourceQuestion.trim().toLowerCase() === reply.toLowerCase()) return undefined;

  return {
    ...pending,
    reply,
    resolvedQuestion: [
      pending.sourceQuestion.trim(),
      `Clarification asked: ${pending.clarifyingQuestion.trim()}`,
      `User clarification: ${reply}`,
      'Proceed with the most specific governed interpretation supported by the original request and this reply. Do not repeat the same clarification. If the reply does not select one of several options explicitly, choose the narrowest concrete interpretation consistent with the original wording and state that assumption in the answer.',
    ].join('\n\n'),
  };
}

function looksLikeNewQuestionAfterClarification(value: string): boolean {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length > 40) return true;
  // Natural-language Ask does not require terminal punctuation. Treat a
  // substantive interrogative/imperative as a new analytical turn before we
  // consider it a reply to a pending clarification. The old `?` requirement
  // caused questions such as "who are the customers who used beverage
  // products" to be appended to the previous clarification and sent to the
  // provider as one polluted prompt.
  if (
    words.length >= 4
    && /^(?:who|what|why|where|when|how|show|give|list|compare|build|create|which|calculate|find|tell)\b/i.test(value)
  ) return true;
  return words.length >= 7 && /\?\s*$/.test(value);
}

function latestClarificationFromHistory(
  history: AgentRunRequest['history'],
): Pick<ClarificationContinuation, 'sourceQuestion' | 'clarifyingQuestion'> | undefined {
  if (!history?.length) return undefined;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (turn.role !== 'assistant' || !turn.text.trim().endsWith('?')) continue;
    let fallbackQuestion: string | undefined;
    for (let prior = index - 1; prior >= 0; prior -= 1) {
      if (history[prior].role === 'user' && history[prior].text.trim()) {
        fallbackQuestion = history[prior].text;
        if (looksLikeNewQuestionAfterClarification(history[prior].text)) {
          return { sourceQuestion: history[prior].text, clarifyingQuestion: turn.text };
        }
      }
    }
    if (fallbackQuestion) return { sourceQuestion: fallbackQuestion, clarifyingQuestion: turn.text };
  }
  return undefined;
}

function latestClarificationFromConversationContext(
  context: Record<string, unknown> | undefined,
): Pick<ClarificationContinuation, 'sourceQuestion' | 'clarifyingQuestion'> | undefined {
  const contextRecord = clarificationRecord(context);
  const snapshot = clarificationRecord(contextRecord?.serverSnapshot);
  const sources = [snapshot?.recentTurns, contextRecord?.turns];
  for (const source of sources) {
    if (!Array.isArray(source) || source.length === 0) continue;
    const latestIndex = source.length - 1;
    const latest = clarificationRecord(source[latestIndex]);
    const route = clarificationString(latest?.route);
    const clarifyingQuestion = clarificationString(latest?.answerSummary);
    if (route !== 'clarify' || !clarifyingQuestion) continue;

    // A previously deployed client may already have persisted a repeated
    // clarification chain (original question -> "yes" -> clarify again). Walk
    // back through that chain so the next reply recovers the analytical request,
    // not the terse intermediate reply.
    let sourceQuestion = clarificationString(latest?.question);
    for (let index = latestIndex; index >= 0; index -= 1) {
      const candidate = clarificationRecord(source[index]);
      if (clarificationString(candidate?.route) !== 'clarify') break;
      const question = clarificationString(candidate?.question);
      if (!question) continue;
      sourceQuestion = question;
      if (looksLikeNewQuestionAfterClarification(question)) break;
    }
    if (sourceQuestion) {
      return { sourceQuestion, clarifyingQuestion };
    }
  }
  return undefined;
}

function clarificationRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function clarificationString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Task-adaptive reasoning effort per route — the DQL differentiator. Cheap,
 * mechanical routes (chat, clarify, blocked, a pre-written certified lookup) run
 * `low`; a plain generated answer runs `medium` (the "Auto" default — S1); the
 * heavy authoring/investigation routes that genuinely reason over a whole
 * research workspace or draft a block run `high`. This is the reasoning-effort
 * half of the S1 decouple: it sets how hard the model THINKS per call and is no
 * longer welded to how many verification passes run (that follows the question
 * shape — see `questionShapeClass`/`analysisDepthForQuestion`). A user's explicit
 * thinking selection overrides this default; the host also clamps by the
 * provider's Settings ceiling before sending it to the model.
 */
export function routeReasoningEffort(route: AgentRunRoute): ReasoningEffort {
  switch (route) {
    case "conversation":
    case "clarify":
    case "certified_answer":
    case "semantic_answer":
    case "blocked":
      return "low";
    case "generated_answer":
    case "app_build":
      return "medium";
    case "research":
    case "sql_cell":
    case "dql_block_draft":
      return "high";
    default:
      return "medium";
  }
}

/** Audience-aware escalation target: stakeholders never escalate into authoring. */
export function escalationRouteFor(route: AgentRunRoute, audience: AgentRunAudience): AgentRunRoute | undefined {
  const target = AGENT_RUN_ESCALATION_MAP[route];
  if (!target) return undefined;
  if (audience === "stakeholder" && ANALYST_ONLY_ROUTES.has(target)) return "research";
  return target;
}

/** The handoff action shown on a stakeholder's review-required output. */
function requestCertificationAction(): AgentRunNextAction {
  return { id: "request-certification", label: "Request certification" };
}

/**
 * For stakeholders, strip analyst-authoring next actions and, on review-required
 * output, offer the certification handoff. Analysts keep their actions untouched.
 */
function applyAudienceToNextActions(
  actions: AgentRunNextAction[],
  audience: AgentRunAudience,
  status: AgentRunStatus,
): AgentRunNextAction[] {
  if (audience !== "stakeholder") return actions;
  const consumption = actions.filter((action) =>
    !ANALYST_ONLY_ROUTES.has(action.route ?? "clarify")
    && action.artifactKind !== "sql_cell"
    && action.artifactKind !== "dql_block_draft"
    && !/insert-sql|create-block|promote|open-review|draft/i.test(action.id));
  if (status === "needs_review" && !consumption.some((action) => action.id === "request-certification")) {
    consumption.push(requestCertificationAction());
  }
  return consumption;
}

export class InMemoryAgentRunStore implements AgentRunStore {
  private readonly runs = new Map<string, AgentRun>();

  save(run: AgentRun): void {
    this.runs.set(run.id, run);
  }

  get(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  list(): AgentRun[] {
    return [...this.runs.values()];
  }
}

export interface FileAgentRunStoreOptions {
  path: string;
  maxRuns?: number;
}

export class FileAgentRunStore implements AgentRunStore {
  private readonly path: string;
  private readonly maxRuns: number;

  constructor(options: FileAgentRunStoreOptions) {
    this.path = options.path;
    this.maxRuns = options.maxRuns ?? 500;
  }

  save(run: AgentRun): void {
    const runs = this.list();
    const index = runs.findIndex((candidate) => candidate.id === run.id);
    if (index >= 0) {
      runs[index] = run;
    } else {
      runs.push(run);
    }
    const pruned = runs
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, this.maxRuns);
    this.write(pruned);
  }

  get(id: string): AgentRun | undefined {
    return this.list().find((run) => run.id === id);
  }

  list(): AgentRun[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as {
        runs?: unknown;
      };
      if (!Array.isArray(parsed.runs)) return [];
      return parsed.runs.flatMap((run) => isAgentRunRecord(run) ? [run] : []);
    } catch {
      return [];
    }
  }

  private write(runs: AgentRun[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmpPath = `${this.path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ version: 1, runs }, null, 2) + "\n", "utf-8");
    renameSync(tmpPath, this.path);
  }
}

export function defaultAgentRunStorePath(projectRoot: string): string {
  return join(projectRoot, ".dql", "local", "agent-runs.json");
}

function isAgentRunRecord(value: unknown): value is AgentRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.question === "string"
    && typeof record.route === "string"
    && Array.isArray(record.events)
    && Array.isArray(record.artifacts)
    && Array.isArray(record.evaluations);
}

/** Outcome of a single accepted step (status/trust/artifacts derived from evaluations). */
interface StepOutcome {
  status: AgentRunStatus;
  trustState: AgentRunTrustState;
  artifacts: AgentRunArtifact[];
  stopReason: AgentRunStopReason;
  summary: string;
  /** Cascade tier that produced the answer (drives governed short-circuit). */
  terminalTier?: string;
}

export class AgentRunEngine {
  private readonly executors: AgentRunExecutors;
  private readonly gates: AgentRunGates;
  private readonly planner: AgentRunPlanner;
  private readonly router?: AgentRouter;
  private readonly store?: AgentRunStore;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;
  private readonly budgetModel: PartialCascadeBudgetModel;
  private readonly maxSteps: number;

  constructor(options: AgentRunEngineOptions = {}) {
    this.executors = options.executors ?? {};
    this.gates = options.gates ?? {};
    this.planner = options.planner ?? createDeterministicAgentRunPlanner();
    this.router = options.router;
    this.store = options.store;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.budgetModel = {
      ...options.budgets,
      lane: {
        ...options.budgets?.lane,
        execution: options.maxRepairAttempts ?? options.budgets?.lane?.execution,
      },
      engineEscalations: options.maxEngineEscalations ?? options.budgets?.engineEscalations,
    };
    this.maxSteps = Math.max(1, options.maxSteps ?? DEFAULT_MAX_STEPS);
  }

  /**
   * Decide the high-level action. A forced `requestedMode` bypasses routing.
   * Otherwise an injected router (LLM-assisted) wins; failing that, the built-in
   * deterministic decision. The router owns its own fallback to heuristics.
   */
  private async decideRoute(request: AgentRunRequest): Promise<IntentDecision> {
    const requestedAction = requestedModeToAction(request.requestedMode);
    // `ask` constrains the eventual analytical action to a direct answer, but it
    // still needs retrieval-first meaning resolution. Treating it like the SQL,
    // block, or app authoring modes used to bypass the evidence router entirely
    // on the primary Ask surface.
    if (requestedAction && request.requestedMode !== "ask") return buildIntentDecision(request);
    if (this.router) {
      try {
        const routed = await this.router.decide(request);
        if (
          request.requestedMode === "ask"
          && routed.action !== "converse"
          && routed.action !== "compose_app"
          && routed.requiresClarification !== true
        ) {
          return { ...routed, action: "answer" };
        }
        return routed;
      } catch (error) {
        if (request.signal?.aborted) throw request.signal.reason ?? error;
        if (error instanceof Error && error.name === "AbortError") throw error;
        // Router failed entirely — fall back to deterministic routing.
      }
    }
    return buildIntentDecision(request);
  }

  async run(
    request: AgentRunRequest,
    onEvent?: (event: AgentRunEvent) => void,
    onAnswerDelta?: (delta: string) => void,
  ): Promise<AgentRun> {
    const submittedQuestion = request.question;
    const clarificationContinuation = resolveClarificationContinuation(request);
    if (clarificationContinuation) {
      request = {
        ...request,
        // A structured choice is already an exact meaning binding. Retrieve and
        // execute against the original analytical question so artifact names,
        // planning, and SQL shape are not polluted by clarification prose.
        question: request.selectedEvidenceId
          ? clarificationContinuation.sourceQuestion
          : clarificationContinuation.resolvedQuestion,
      };
    }
    const runId = request.runId ?? this.idGenerator();
    const startedAt = this.timestamp();
    const requestedMode = request.requestedMode ?? "auto";
    const events: AgentRunEvent[] = [];
    const emit = (event: Omit<AgentRunEvent, "id" | "runId" | "at">) => {
      const full: AgentRunEvent = {
        id: `${runId}:event:${events.length + 1}`,
        runId,
        at: this.timestamp(),
        ...event,
      };
      events.push(full);
      onEvent?.(full);
    };

    emit({
      type: "run.started",
      message: "Started governed agent run.",
      payload: {
        question: submittedQuestion,
        requestedMode,
        selectedObject: request.selectedObject,
        ...(clarificationContinuation ? { clarificationResolved: true } : {}),
      },
    });

    const audience = resolveAudience(request);
    // Initialize a deterministic decision so router/provider timeouts can still
    // be persisted as a complete blocked run with an inspectable trace. The old
    // pre-try await escaped the engine and left active UI runs looking endless.
    let routeDecision: IntentDecision = buildIntentDecision(request);
    try {
      routeDecision = clarificationContinuation && !request.selectedEvidenceId
        ? {
            action: "answer",
            confidence: 1,
            reason: "This continues a pending clarification, so I will resolve it against the original analytical question and produce a governed answer instead of asking again.",
            followsUp: true,
            source: "heuristic",
          }
        : await this.decideRoute(request);
      const defaultRoute = answerAnywayRoute(
        constrainRouteForAudience(selectRoute(request, routeDecision), audience),
        request,
        audience,
        routeDecision,
      );
      const plan = await this.planner.plan({
        request,
        routeDecision,
        defaultRoute,
        maxSteps: this.maxSteps,
        audience,
      });
      emit({
        type: "plan.created",
        message: plan.rationale,
        route: plan.steps[0]?.route,
        payload: plan,
      });

      const executedSteps: AgentRunStep[] = [];
      // Normalize planned routes to the audience (works for LLM and deterministic
      // plans alike): stakeholders never author and never dead-end on clarify
      // without explicit missing context.
      const queue: AgentRunPlannedStep[] = plan.steps.map((step) => ({
        ...step,
        route: answerAnywayRoute(constrainRouteForAudience(step.route, audience), request, audience, routeDecision),
      }));
      const budgets = createCascadeBudgetState(this.budgetModel);
      let stepCount = 0;
      let finalStep: AgentRunStep | undefined;
      let finalResult: AgentRouteExecutorResult | undefined;
      let finalOutcome: StepOutcome | undefined;
      let clarifyOutcome: { step: AgentRunStep; question?: string } | undefined;
      // The last step that actually produced a user-facing answer. A later
      // non-answer step (e.g. a research/draft step that emits only an artifact)
      // must not drop the data answer an earlier step already computed.
      let bestAnswerResult: AgentRouteExecutorResult | undefined;

      while (queue.length > 0 && stepCount < this.maxSteps) {
        const planned = queue.shift()!;
        stepCount += 1;
        const route = planned.route;
        const stepId = `${runId}:step:${stepCount}`;

        emit({
          type: "step.started",
          message: `Step ${stepCount}: ${planned.goal}`,
          route,
          payload: { stepId, index: stepCount, goal: planned.goal, successCriteria: planned.successCriteria },
        });
        emit({
          type: "route.decided",
          message: stepCount === 1
            ? routeDecision.reason
            : `Routed step ${stepCount} to ${route.replaceAll("_", " ")}.`,
          route,
          payload: stepCount === 1 ? routeDecision : { route, goal: planned.goal },
        });

        let attempt = 0;
        let repairHint: string | undefined;
        let priorEvaluations: AgentRunEvaluation[] | undefined;
        let result: AgentRouteExecutorResult = {};
        let evaluations: AgentRunEvaluation[] = [];
        let escalation: { route: AgentRunRoute; goal?: string; hint?: string } | undefined;
        let stepStatus: AgentRunStepStatus = "needs_review";
        let clarifyQuestion: string | undefined;
        let isClarify = false;

        // Build → evaluate → modify loop for this step.
        for (;;) {
          emit({
            type: "executor.started",
            message: attempt === 0
              ? `Running ${route.replaceAll("_", " ")} executor.`
              : `Re-running ${route.replaceAll("_", " ")} executor (repair attempt ${attempt}).`,
            route,
          });
          result = await this.executeRoute({
            runId,
            request,
            route,
            routeDecision,
            maxRepairAttempts: budgets.limits.lane.execution,
            attempt,
            stepGoal: planned.goal,
            priorEvaluations,
            repairHint,
            emit,
            emitAnswerDelta: onAnswerDelta,
          });

          evaluations = this.evaluate({ route, request, routeDecision, result, attempt });
          for (const evaluation of evaluations) {
            emit({
              type: "evaluation.recorded",
              message: evaluation.message,
              route,
              payload: evaluation,
            });
          }

          // An executor that explicitly self-declares blocked is terminal (infra blocker).
          if (result.status === "blocked") {
            stepStatus = "blocked";
            break;
          }

          const failing = evaluations.find((evaluation) => !evaluation.passed && evaluation.suggestedRepair);
          if (!failing) {
            stepStatus = attempt > 0 ? "repaired" : "passed";
            break;
          }

          const currentStep: AgentRunStep = {
            id: stepId,
            index: stepCount,
            route,
            goal: planned.goal,
            successCriteria: planned.successCriteria,
            status: "needs_review",
            attempts: attempt + 1,
            summary: result.summary,
            evaluations,
            artifacts: result.artifacts ?? [],
          };
          const decision = await this.planner.replan({
            request,
            plan,
            currentStep,
            remainingSteps: queue,
            attemptsUsed: attempt,
            repairAttemptsUsed: budgets.usage.laneExecutionAttemptsUsed,
            maxRepairAttempts: budgets.limits.lane.execution,
            engineEscalationsUsed: budgets.usage.engineEscalationsUsed,
            maxEngineEscalations: budgets.limits.engineEscalations,
            budgetUsage: cascadeBudgetTrace(budgets),
          });
          emit({
            type: "replan.decided",
            message: describeReplan(decision),
            route,
            payload: decision,
          });

          if (decision.decision === "repair") {
            const nextRepairHint = repairHintForEvaluation(failing, decision.repairHint);
            if (!canUseLaneRepair(budgets, "execution")) {
              stepStatus = "needs_review";
              emit({
                type: "repair.attempted",
                message: `Repair budget exhausted for ${route.replaceAll("_", " ")}.`,
                route,
                payload: {
                  repairHint: nextRepairHint,
                  budgetUsage: cascadeBudgetTrace(budgets),
                },
              });
              break;
            }
            recordLaneRepair(budgets, "execution");
            attempt += 1;
            repairHint = nextRepairHint;
            priorEvaluations = evaluations;
            emit({
              type: "repair.attempted",
              message: `Repairing ${route.replaceAll("_", " ")}: ${repairHint}`,
              route,
              payload: { attempt, repairHint, budgetUsage: cascadeBudgetTrace(budgets) },
            });
            continue;
          }
          if (decision.decision === "escalate") {
            if (!canUseEngineEscalation(budgets)) {
              stepStatus = "needs_review";
              emit({
                type: "escalated",
                message: `Escalation budget exhausted for ${route.replaceAll("_", " ")}.`,
                route,
                payload: { decision, budgetUsage: cascadeBudgetTrace(budgets) },
              });
              break;
            }
            recordEngineEscalation(budgets);
            escalation = { route: decision.route, goal: decision.goal, hint: repairHintForEvaluation(failing, decision.repairHint) };
            stepStatus = "escalated";
            emit({
              type: "escalated",
              message: `Escalating ${route.replaceAll("_", " ")} → ${decision.route.replaceAll("_", " ")}.`,
              route,
              payload: { ...decision, budgetUsage: cascadeBudgetTrace(budgets) },
            });
            break;
          }
          if (decision.decision === "clarify") {
            isClarify = true;
            clarifyQuestion = decision.question;
            stepStatus = "clarify";
            break;
          }
          // "accept"
          stepStatus = "needs_review";
          break;
        }

        // Escalated steps are recorded in the trace but their output is superseded.
        if (escalation) {
          executedSteps.push({
            id: stepId,
            index: stepCount,
            route,
            goal: planned.goal,
            successCriteria: planned.successCriteria,
            status: "escalated",
            attempts: attempt + 1,
            summary: result.summary,
            evaluations,
            artifacts: [],
          });
          emit({
            type: "step.completed",
            message: `Step ${stepCount} escalated to ${escalation.route.replaceAll("_", " ")}.`,
            route,
            payload: { stepId, status: "escalated" },
          });
          queue.unshift({
            id: `${stepId}:escalation`,
            route: escalation.route,
            goal: escalation.goal ?? `Escalated from ${route} to ${escalation.route}.`,
            successCriteria: [],
          });
          continue;
        }

        const outcome = computeStepOutcome(route, result, evaluations, request, isClarify, clarifyQuestion);
        const step: AgentRunStep = {
          id: stepId,
          index: stepCount,
          route,
          resolvedRoute: result.resolvedRoute,
          goal: planned.goal,
          successCriteria: planned.successCriteria,
          status: outcome.status === "blocked" ? "blocked" : stepStatus,
          attempts: attempt + 1,
          summary: outcome.summary,
          evaluations,
          artifacts: outcome.artifacts,
        };
        executedSteps.push(step);

        for (const artifact of outcome.artifacts) {
          emit({
            type: "artifact.created",
            message: `Created ${artifact.kind.replaceAll("_", " ")} artifact.`,
            route,
            trustState: artifact.trustState,
            payload: artifact,
          });
        }
        emit({
          type: "step.completed",
          message: `Step ${stepCount} ${step.status}.`,
          route,
          status: outcome.status,
          trustState: outcome.trustState,
          payload: { stepId, status: step.status },
        });

        if (isClarify) {
          clarifyOutcome = { step, question: clarifyQuestion };
          finalStep = step;
          finalResult = result;
          finalOutcome = outcome;
          break;
        }

        finalStep = step;
        finalResult = result;
        finalOutcome = outcome;
        if (outcome.status !== "blocked" && typeof result.answer === "string" && result.answer.trim().length > 0) {
          bestAnswerResult = result;
        }

        if (outcome.status === "blocked") break;
        if (isTerminalSuccess(route, outcome)) break;
        // Otherwise continue to the next planned step (if any remain).
      }

      const run = this.finalizeRun({
        runId,
        request,
        requestedMode,
        startedAt,
        routeDecision,
        plan,
        steps: executedSteps,
        finalStep,
        finalResult,
        finalOutcome,
        clarifyOutcome,
        bestAnswerResult,
        budgetUsage: cascadeBudgetTrace(budgets),
        events,
      });
      run.question = submittedQuestion;
      emit({
        type: "run.completed",
        message: `Agent run completed with status ${run.status}.`,
        route: run.route,
        status: run.status,
        trustState: run.trustState,
        payload: { budgetUsage: run.budgetUsage },
      });
      run.completedAt = this.timestamp();
      await this.store?.save(run);
      return run;
    } catch (err) {
      const message = err instanceof Error && err.name === "TimeoutError"
        ? "This request reached its bounded execution deadline. No additional retry or Research run was started; refine the question or start Research explicitly for a longer investigation."
        : err instanceof Error ? err.message : String(err);
      emit({
        type: "run.failed",
        message,
        route: "blocked",
        status: "blocked",
        trustState: "blocked",
      });
      const run: AgentRun = {
        id: runId,
        question: submittedQuestion,
        requestedMode,
        route: "blocked",
        status: "blocked",
        trustState: "blocked",
        stopReason: "blocked",
        startedAt,
        completedAt: this.timestamp(),
        selectedObject: request.selectedObject,
        routeDecision,
        steps: [],
        summary: message,
        artifacts: [],
        evaluations: [{
          id: "executor-error",
          label: "Executor error",
          passed: false,
          severity: "blocking",
          message,
        }],
        events,
        nextActions: [],
        repairAttempts: 0,
        escalationAttempts: 0,
        budgetUsage: cascadeBudgetTrace(createCascadeBudgetState(this.budgetModel)),
      };
      await this.store?.save(run);
      return run;
    }
  }

  private finalizeRun(input: {
    runId: string;
    request: AgentRunRequest;
    requestedMode: AgentRunRequestedMode;
    startedAt: string;
    routeDecision: IntentDecision;
    plan: AgentRunPlan;
    steps: AgentRunStep[];
    finalStep?: AgentRunStep;
    finalResult?: AgentRouteExecutorResult;
    finalOutcome?: StepOutcome;
    clarifyOutcome?: { step: AgentRunStep; question?: string };
    bestAnswerResult?: AgentRouteExecutorResult;
    budgetUsage: CascadeBudgetTrace;
    events: AgentRunEvent[];
  }): AgentRun {
    const { finalStep, finalResult, finalOutcome } = input;
    const repairAttempts = input.budgetUsage.usage.laneExecutionAttemptsUsed;
    const escalationAttempts = input.budgetUsage.usage.engineEscalationsUsed;
    const completedAt = this.timestamp();

    if (!finalStep || !finalResult || !finalOutcome) {
      // No step produced a usable result (e.g. an empty plan). Treat as blocked.
      return {
        id: input.runId,
        question: input.request.question,
        requestedMode: input.requestedMode,
        route: "blocked",
        status: "blocked",
        trustState: "blocked",
        stopReason: "blocked",
        startedAt: input.startedAt,
        completedAt,
        selectedObject: input.request.selectedObject,
        routeDecision: input.routeDecision,
        plan: input.plan,
        steps: input.steps,
        summary: "The agent run produced no executable step.",
        artifacts: [],
        evaluations: [{
          id: "empty-plan",
          label: "Empty plan",
          passed: false,
          severity: "blocking",
          message: "The planner returned no runnable steps.",
        }],
        events: input.events,
        nextActions: [],
        repairAttempts,
        escalationAttempts,
        budgetUsage: input.budgetUsage,
      };
    }

    const route = finalResult.resolvedRoute ?? finalStep.resolvedRoute ?? finalStep.route;
    // Aggregate artifacts across every accepted step so a multi-step plan
    // (e.g. research → block draft) surfaces all of its durable work, while the
    // status/trust/answer reflect the final step.
    const artifacts = input.steps.flatMap((step) => step.artifacts);
    // If the final step produced no user-facing answer (e.g. it only drafted an
    // artifact), fall back to the last step that DID answer so the run never
    // drops a data answer an earlier step already computed.
    const finalHasAnswer = typeof finalResult.answer === "string" && finalResult.answer.trim().length > 0;
    const answerSource = finalHasAnswer ? finalResult : (input.bestAnswerResult ?? finalResult);
    return {
      id: input.runId,
      question: input.request.question,
      requestedMode: input.requestedMode,
      route,
      status: finalOutcome.status,
      trustState: finalOutcome.trustState,
      stopReason: finalOutcome.stopReason,
      startedAt: input.startedAt,
      completedAt,
      selectedObject: input.request.selectedObject,
      routeDecision: input.routeDecision,
      plan: input.plan,
      steps: input.steps,
      summary: finalOutcome.summary,
      answer: input.clarifyOutcome?.question ?? answerSource.answer,
      answerKind: answerSource.answerKind ?? "governed",
      artifacts,
      evaluations: finalStep.evaluations,
      events: input.events,
      nextActions: applyAudienceToNextActions(
        finalResult.nextActions ?? defaultNextActions(route, finalOutcome.status),
        resolveAudience(input.request),
        finalOutcome.status,
      ),
      ...(finalOutcome.status === "needs_clarification" && input.routeDecision.clarificationOptions?.length
        ? { clarificationOptions: input.routeDecision.clarificationOptions }
        : {}),
      repairAttempts: finalResult.repairAttempts ?? repairAttempts,
      escalationAttempts,
      budgetUsage: input.budgetUsage,
    };
  }

  private evaluate(context: AgentRunGateContext): AgentRunEvaluation[] {
    const gate = this.gates[context.route];
    if (gate) return gate(context);
    return context.result.evaluations
      ?? defaultEvaluations(context.route, context.request, context.routeDecision);
  }

  private async executeRoute(context: AgentRouteExecutionContext): Promise<AgentRouteExecutorResult> {
    const executor = this.executors[context.route];
    if (executor) return executor(context);
    return defaultExecutorResult(context.route, context.request, context.routeDecision);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function computeStepOutcome(
  route: AgentRunRoute,
  result: AgentRouteExecutorResult,
  evaluations: AgentRunEvaluation[],
  request: AgentRunRequest,
  isClarify: boolean,
  clarifyQuestion?: string,
): StepOutcome {
  const fallback = defaultOutcome(route);
  if (isClarify) {
    return {
      status: "needs_clarification",
      trustState: "not_applicable",
      artifacts: [],
      stopReason: "needs_clarification",
      summary: result.summary ?? clarifyQuestion ?? fallback.summary,
    };
  }
  const status = result.status ?? statusFromEvaluations(route, evaluations, fallback.status);
  const trustState = result.trustState ?? trustStateFromEvaluations(route, evaluations, fallback.trustState);
  const artifacts = status === "blocked"
    ? []
    : result.artifacts ?? defaultArtifacts(route, result, request);
  const stopReason = result.stopReason ?? stopReasonFor(route, status, trustState, artifacts);
  return {
    status,
    trustState,
    artifacts,
    stopReason,
    summary: result.summary ?? fallback.summary,
    ...(result.answerTier ? { terminalTier: result.answerTier } : {}),
  };
}

function isTerminalSuccess(route: AgentRunRoute, outcome: StepOutcome): boolean {
  // A completed certified answer is the terminal success — no further steps add trust.
  // A conversational reply is likewise terminal (there is no data work to chain).
  // Every other accepted step falls through so a multi-step plan can keep going; the
  // run loop ends naturally when the planned queue empties or maxSteps is hit.
  if (route === "conversation" && outcome.status === "completed") return true;
  if ((route === "certified_answer" || route === "semantic_answer") && outcome.status === "completed") return true;
  // A governed SEMANTIC answer (deterministically compiled from the semantic layer)
  // is as terminal as a certified block for a metric question — no further step adds
  // trust. Generated SQL (generated_sql / business_context) stays NON-terminal so a
  // multi-step plan can still chain a research step.
  if (outcome.status === "completed" && outcome.terminalTier === "semantic_metric") return true;
  return false;
}

function describeReplan(decision: AgentRunReplanDecision): string {
  switch (decision.decision) {
    case "repair":
      return `Repairing the current route: ${decision.repairHint}`;
    case "escalate":
      return `Escalating to ${decision.route.replaceAll("_", " ")}.`;
    case "clarify":
      return decision.question ?? "Needs a clarifying question before continuing.";
    default:
      return "Accepting the current result.";
  }
}

function repairHintForEvaluation(evaluation: AgentRunEvaluation, plannerHint?: string): string {
  return evaluation.repairAction?.hint
    ?? plannerHint
    ?? evaluation.suggestedRepair
    ?? "Revise and retry.";
}

/**
 * The default, fully deterministic planner. Produces a single-step plan from the
 * existing route selection and drives repair/escalation from failing evaluations.
 * Used when no LLM planner is injected — keeps the engine offline + testable.
 */
export function createDeterministicAgentRunPlanner(): AgentRunPlanner {
  return {
    plan({ request, routeDecision, defaultRoute }) {
      return {
        source: "deterministic",
        rationale: routeDecision.reason,
        steps: [{
          id: "step-1",
          route: defaultRoute,
          goal: request.question,
          successCriteria: defaultSuccessCriteria(defaultRoute),
        }],
      };
    },
    replan({ request, currentStep, attemptsUsed, maxRepairAttempts }) {
      const failing = currentStep.evaluations.find((evaluation) => !evaluation.passed && evaluation.suggestedRepair);
      if (!failing) return { decision: "accept" };
      const audience = resolveAudience(request);
      const action = failing.repairAction;
      const requested = action?.kind === "escalate" ? action.route : undefined;
      // Honor an explicit escalate target, else the route's default — then clamp for the audience.
      const rawEscalation = requested ?? AGENT_RUN_ESCALATION_MAP[currentStep.route];
      const escalationRoute = rawEscalation
        ? (audience === "stakeholder" && ANALYST_ONLY_ROUTES.has(rawEscalation) ? "research" : rawEscalation)
        : undefined;
      const hint = action?.hint ?? failing.suggestedRepair ?? "Revise and retry.";

      if (action?.kind === "escalate" && escalationRoute) {
        return { decision: "escalate", route: escalationRoute, goal: hint, repairHint: hint };
      }
      if (attemptsUsed < maxRepairAttempts) {
        return { decision: "repair", repairHint: hint };
      }
      if (action?.kind === "retry") {
        return { decision: "accept" };
      }
      if (escalationRoute) {
        return { decision: "escalate", route: escalationRoute, goal: hint, repairHint: hint };
      }
      return { decision: "accept" };
    },
  };
}

export function defaultSuccessCriteria(route: AgentRunRoute): string[] {
  switch (route) {
    case "conversation":
      return ["A direct, friendly reply — no data routing needed."];
    case "certified_answer":
      return ["Answer is backed by a certified DQL block or governed metric."];
    case "semantic_answer":
      return ["Answer is compiled from governed semantic members and executed without generated SQL."];
    case "generated_answer":
      return ["Answer is grounded in governed context and marked review-required."];
    case "research":
      return ["Research dossier is grounded in catalog or context-pack evidence."];
    case "sql_cell":
      return ["Generated SQL executes against the preview without errors."];
    case "dql_block_draft":
      return ["Draft passes the certifier with no blockers (still human-reviewed)."];
    case "app_build":
      return ["App tiles are backed by certified blocks."];
    case "clarify":
      return ["A single sharp clarifying question is returned."];
    default:
      return [];
  }
}

function buildIntentDecision(request: AgentRunRequest): IntentDecision {
  const hasConversationContext = Boolean(request.conversationContext && Object.keys(request.conversationContext).length > 0);
  const conversationalKind = classifyConversationalTurn(
    request.question,
    Boolean((request.history?.length ?? 0) > 0 || hasConversationContext),
  );
  if (request.requestedMode === "ask" && conversationalKind && hasConversationContext) {
    return {
      action: "converse",
      confidence: 0.9,
      reason: "This asks about the prior conversation, so I will answer from conversation context instead of querying governed data.",
      conversationalKind,
      category: "conversational",
      source: "heuristic",
      followsUp: true,
    };
  }
  const forcedAction = requestedModeToAction(request.requestedMode);
  if (forcedAction) {
    return {
      action: forcedAction,
      confidence: 1,
      reason: `User selected ${request.requestedMode} mode.`,
      followsUp: Boolean(request.history?.length),
    };
  }
  return decideAgentAction({
    question: request.question,
    intent: request.intent ?? "ad_hoc_ranking",
    signals: request.signals,
    history: request.history,
  });
}

function requestedModeToAction(mode: AgentRunRequestedMode | undefined): IntentDecision["action"] | undefined {
  if (!mode || mode === "auto") return undefined;
  if (mode === "app") return "compose_app";
  if (mode === "research") return "investigate";
  if (mode === "ask" || mode === "sql" || mode === "block") return "answer";
  return undefined;
}

export function selectRoute(request: AgentRunRequest, decision: IntentDecision): AgentRunRoute {
  // Retrieval + meaning resolution already established a compatible execution
  // class. Route directly to the shared answer executor instead of paying for a
  // planner/tool-search pass. The executor still owns authorization and runtime
  // compatibility validation.
  if (decision.action === "answer" && decision.meaningResolution && decision.requiresClarification !== true) {
    if (decision.meaningResolution.recommendedRoute === "certified") return "certified_answer";
    if (decision.meaningResolution.recommendedRoute === "semantic") return "semantic_answer";
  }
  return selectCascadeRunRoute(request, decision);
}

function defaultExecutorResult(
  route: AgentRunRoute,
  request: AgentRunRequest,
  decision?: IntentDecision,
): AgentRouteExecutorResult {
  const fallback = defaultOutcome(route);
  return {
    summary: fallback.summary,
    answer: route === "clarify" ? decision?.clarifyingQuestion : undefined,
    evaluations: defaultEvaluations(route, request, decision),
    artifacts: defaultArtifacts(route, {}, request),
  };
}

function defaultOutcome(route: AgentRunRoute): Pick<AgentRun, "status" | "trustState" | "summary"> {
  switch (route) {
    case "conversation":
      return {
        status: "completed",
        trustState: "not_applicable",
        summary: "Replied conversationally.",
      };
    case "certified_answer":
      return {
        status: "completed",
        trustState: "certified",
        summary: "Answered from certified DQL context.",
      };
    case "semantic_answer":
      return {
        status: "completed",
        trustState: "governed",
        summary: "Answered from governed semantic definitions.",
      };
    case "clarify":
      return {
        status: "needs_clarification",
        trustState: "not_applicable",
        summary: "Needs clarification before a governed answer can be produced.",
      };
    case "blocked":
      return {
        status: "blocked",
        trustState: "blocked",
        summary: "Agent run is blocked.",
      };
    default:
      return {
        status: "needs_review",
        trustState: "review_required",
        summary: "Created review-required agent output.",
      };
  }
}

function defaultEvaluations(
  route: AgentRunRoute,
  _request: AgentRunRequest,
  decision?: IntentDecision,
): AgentRunEvaluation[] {
  // A conversational reply carries no governance checks — it renders as plain chat.
  if (route === "conversation") return [];
  const base: AgentRunEvaluation[] = [{
    id: "route-decision",
    label: "Route decision",
    passed: true,
    severity: "info",
    message: decision?.reason ?? `Routed request to ${route.replaceAll("_", " ")}.`,
  }];
  if (route === "certified_answer") {
    base.push({
      id: "certified-context",
      label: "Certified context",
      passed: true,
      severity: "info",
      message: "Certified status must come from the route executor or resolved answer-loop tier, not token-overlap routing.",
    });
  }
  if (route === "semantic_answer") {
    base.push({
      id: "semantic-context",
      label: "Governed semantic context",
      passed: true,
      severity: "info",
      message: "The semantic compiler, not the language model, owns the executed SQL.",
    });
  }
  if (route === "generated_answer" || route === "sql_cell") {
    base.push({
      id: "review-boundary",
      label: "Review boundary",
      passed: true,
      severity: "warning",
      message: "Generated SQL or metadata-derived analysis remains review-required.",
    });
  }
  if (route === "dql_block_draft") {
    base.push({
      id: "certification-boundary",
      label: "Certification boundary",
      passed: true,
      severity: "warning",
      message: "AI may create a draft block, but certification stays gated by review.",
    });
  }
  return base;
}

function statusFromEvaluations(
  route: AgentRunRoute,
  evaluations: AgentRunEvaluation[],
  fallback: AgentRunStatus,
): AgentRunStatus {
  if (evaluations.some((evaluation) => !evaluation.passed && evaluation.severity === "blocking")) return "blocked";
  if (route === "clarify") return "needs_clarification";
  if (route === "conversation") return "completed";
  if (route === "certified_answer") return "completed";
  if (route === "semantic_answer") return "completed";
  return fallback;
}

function trustStateFromEvaluations(
  route: AgentRunRoute,
  evaluations: AgentRunEvaluation[],
  fallback: AgentRunTrustState,
): AgentRunTrustState {
  if (evaluations.some((evaluation) => !evaluation.passed && evaluation.severity === "blocking")) return "blocked";
  if (route === "certified_answer") return "certified";
  if (route === "semantic_answer") return "governed";
  if (route === "clarify" || route === "conversation") return "not_applicable";
  // A generated/research answer that grounded to the catalog AND executed cleanly against
  // real data is "grounded" — honest verification pending human certification (never auto-certified).
  if (route === "research" || route === "generated_answer") {
    const grounded = evaluations.find((evaluation) => evaluation.id === "catalog-grounding")?.passed;
    const executed = evaluations.find((evaluation) => evaluation.id === "result-executed")?.passed;
    if (grounded && executed) return "grounded";
  }
  return fallback;
}

function defaultArtifacts(
  route: AgentRunRoute,
  result: Pick<AgentRouteExecutorResult, "answer">,
  request: AgentRunRequest,
): AgentRunArtifact[] {
  const trustState = defaultOutcome(route).trustState;
  switch (route) {
    case "certified_answer":
    case "semantic_answer":
    case "generated_answer":
      return [{
        id: `${route}:answer`,
        kind: "answer",
        title: route === "certified_answer"
          ? "Certified answer"
          : route === "semantic_answer"
            ? "Governed semantic answer"
            : "Generated answer",
        trustState,
        payload: { question: request.question, answer: result.answer },
      }];
    case "research":
      return [{
        id: "research:run",
        kind: "research_run",
        title: "Research run",
        trustState,
        payload: { question: request.question },
      }];
    case "sql_cell":
      return [{
        id: "notebook:sql-cell",
        kind: "sql_cell",
        title: "Generated SQL cell",
        trustState,
        payload: { question: request.question },
      }];
    case "dql_block_draft":
      return [{
        id: "dql:block-draft",
        kind: "dql_block_draft",
        title: "DQL block draft",
        trustState,
        payload: { question: request.question },
      }];
    case "app_build":
      return [{
        id: "app:draft",
        kind: "app_draft",
        title: "App draft",
        trustState,
        payload: { question: request.question },
      }];
    default:
      return [];
  }
}

function stopReasonFor(
  route: AgentRunRoute,
  status: AgentRunStatus,
  trustState: AgentRunTrustState,
  artifacts: AgentRunArtifact[],
): AgentRunStopReason {
  if (status === "blocked" || trustState === "blocked") return "blocked";
  if (route === "conversation") return "conversational_reply";
  if (status === "needs_clarification") return "needs_clarification";
  if (route === "certified_answer") return "certified_answer_found";
  if (route === "semantic_answer") return "governed_semantic_answer";
  if (artifacts.length > 0 && route !== "generated_answer") return "artifact_created";
  if (status === "needs_review") return "human_review_required";
  return "generated_review_required";
}

function defaultNextActions(route: AgentRunRoute, status: AgentRunStatus): AgentRunNextAction[] {
  if (status === "blocked") return [];
  if (route === "certified_answer") {
    return [
      { id: "research-gap", label: "Research missing breakdown", route: "research" },
      { id: "build-app", label: "Build app from certified answer", route: "app_build" },
    ];
  }
  if (route === "semantic_answer") {
    return [
      { id: "create-block", label: "Save as reviewed DQL block", route: "dql_block_draft", artifactKind: "dql_block_draft" },
      { id: "research-gap", label: "Research deeper", route: "research" },
    ];
  }
  if (route === "research") {
    return [
      { id: "create-block", label: "Review DQL draft", route: "dql_block_draft", artifactKind: "dql_block_draft" },
      { id: "insert-sql", label: "Insert SQL preview", route: "sql_cell", artifactKind: "sql_cell" },
    ];
  }
  if (route === "sql_cell") {
    return [{ id: "create-block", label: "Review as DQL draft", route: "dql_block_draft", artifactKind: "dql_block_draft" }];
  }
  if (route === "dql_block_draft") {
    return [{ id: "open-review", label: "Open review checklist", artifactKind: "dql_block_draft" }];
  }
  if (route === "app_build") {
    return [{ id: "open-app", label: "Open app draft", artifactKind: "app_draft" }];
  }
  return [];
}
