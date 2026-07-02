import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  decideAgentAction,
  looksLikeComposeApp,
  type IntentDecision,
  type IntentSignals,
} from "./intent-controller.js";
import type { MetadataAgentIntent } from "./metadata/catalog.js";

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
  | "certified_answer"
  | "generated_answer"
  | "research"
  | "sql_cell"
  | "dql_block_draft"
  | "app_build"
  | "clarify"
  | "blocked";

export type AgentRunStatus = "completed" | "needs_review" | "needs_clarification" | "blocked";
export type AgentRunTrustState = "certified" | "grounded" | "review_required" | "blocked" | "not_applicable";

export type AgentRunStopReason =
  | "certified_answer_found"
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

export interface AgentRunSelectedObject {
  kind: "notebook" | "cell" | "block" | "app" | "dashboard" | "research" | "workspace";
  id?: string;
  title?: string;
  path?: string;
}

export interface AgentRunRequest {
  question: string;
  requestedMode?: AgentRunRequestedMode;
  /** Defaults to "analyst" (Notebook). Stakeholder surfaces pass "stakeholder". */
  audience?: AgentRunAudience;
  intent?: MetadataAgentIntent;
  signals?: IntentSignals;
  selectedObject?: AgentRunSelectedObject;
  workspaceContext?: Record<string, unknown>;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  runId?: string;
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
  artifacts: AgentRunArtifact[];
  evaluations: AgentRunEvaluation[];
  events: AgentRunEvent[];
  nextActions: AgentRunNextAction[];
  repairAttempts: number;
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
}

export interface AgentRouteExecutorResult {
  summary?: string;
  answer?: string;
  status?: AgentRunStatus;
  trustState?: AgentRunTrustState;
  stopReason?: AgentRunStopReason;
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

export interface AgentRunEngineOptions {
  executors?: AgentRunExecutors;
  gates?: AgentRunGates;
  planner?: AgentRunPlanner;
  store?: AgentRunStore;
  idGenerator?: () => string;
  now?: () => Date;
  maxRepairAttempts?: number;
  maxSteps?: number;
}

const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;
const DEFAULT_MAX_STEPS = 4;
const CERTIFIED_MATCH_THRESHOLD = 0.5;

/**
 * Routes whose gate failure is better answered by switching routes than by
 * re-running the same executor (repair can't add what the route can't produce).
 */
export const AGENT_RUN_ESCALATION_MAP: Partial<Record<AgentRunRoute, AgentRunRoute>> = {
  certified_answer: "research",
  generated_answer: "research",
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
 * "Answer anyway, labeled" — a stakeholder should get a best-effort governed answer
 * rather than a dead-end clarify, UNLESS the catalog explicitly flagged missing
 * context. The answer loop does its own grounding/retrieval and can still return a
 * needs-clarification result if it genuinely can't proceed.
 */
export function answerAnywayRoute(
  route: AgentRunRoute,
  request: AgentRunRequest,
  audience: AgentRunAudience,
): AgentRunRoute {
  if (audience !== "stakeholder" || route !== "clarify") return route;
  const explicitMissing = (request.signals?.missingContext?.length ?? 0) > 0;
  return explicitMissing ? "clarify" : "generated_answer";
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
}

export class AgentRunEngine {
  private readonly executors: AgentRunExecutors;
  private readonly gates: AgentRunGates;
  private readonly planner: AgentRunPlanner;
  private readonly store?: AgentRunStore;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;
  private readonly maxRepairAttempts: number;
  private readonly maxSteps: number;

  constructor(options: AgentRunEngineOptions = {}) {
    this.executors = options.executors ?? {};
    this.gates = options.gates ?? {};
    this.planner = options.planner ?? createDeterministicAgentRunPlanner();
    this.store = options.store;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.maxRepairAttempts = options.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
    this.maxSteps = Math.max(1, options.maxSteps ?? DEFAULT_MAX_STEPS);
  }

  async run(
    request: AgentRunRequest,
    onEvent?: (event: AgentRunEvent) => void,
  ): Promise<AgentRun> {
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
        question: request.question,
        requestedMode,
        selectedObject: request.selectedObject,
      },
    });

    const audience = resolveAudience(request);
    const routeDecision = buildIntentDecision(request);
    const defaultRoute = answerAnywayRoute(
      constrainRouteForAudience(selectRoute(request, routeDecision), audience),
      request,
      audience,
    );

    try {
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
        route: answerAnywayRoute(constrainRouteForAudience(step.route, audience), request, audience),
      }));
      let repairAttemptsTotal = 0;
      let stepCount = 0;
      let finalStep: AgentRunStep | undefined;
      let finalResult: AgentRouteExecutorResult | undefined;
      let finalOutcome: StepOutcome | undefined;
      let clarifyOutcome: { step: AgentRunStep; question?: string } | undefined;

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
            maxRepairAttempts: this.maxRepairAttempts,
            attempt,
            stepGoal: planned.goal,
            priorEvaluations,
            repairHint,
            emit,
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

          // Out of modify budget — accept the best result we have.
          if (repairAttemptsTotal >= this.maxRepairAttempts) {
            stepStatus = "needs_review";
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
            repairAttemptsUsed: repairAttemptsTotal,
            maxRepairAttempts: this.maxRepairAttempts,
          });
          emit({
            type: "replan.decided",
            message: describeReplan(decision),
            route,
            payload: decision,
          });

          if (decision.decision === "repair") {
            repairAttemptsTotal += 1;
            attempt += 1;
            repairHint = decision.repairHint || failing.suggestedRepair;
            priorEvaluations = evaluations;
            emit({
              type: "repair.attempted",
              message: `Repairing ${route.replaceAll("_", " ")}: ${repairHint}`,
              route,
              payload: { attempt, repairHint },
            });
            continue;
          }
          if (decision.decision === "escalate") {
            repairAttemptsTotal += 1;
            escalation = { route: decision.route, goal: decision.goal, hint: decision.repairHint || failing.suggestedRepair };
            stepStatus = "escalated";
            emit({
              type: "escalated",
              message: `Escalating ${route.replaceAll("_", " ")} → ${decision.route.replaceAll("_", " ")}.`,
              route,
              payload: decision,
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
        repairAttemptsTotal,
        events,
      });
      emit({
        type: "run.completed",
        message: `Agent run completed with status ${run.status}.`,
        route: run.route,
        status: run.status,
        trustState: run.trustState,
      });
      run.completedAt = this.timestamp();
      await this.store?.save(run);
      return run;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({
        type: "run.failed",
        message,
        route: "blocked",
        status: "blocked",
        trustState: "blocked",
      });
      const run: AgentRun = {
        id: runId,
        question: request.question,
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
    repairAttemptsTotal: number;
    events: AgentRunEvent[];
  }): AgentRun {
    const { finalStep, finalResult, finalOutcome } = input;
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
        repairAttempts: input.repairAttemptsTotal,
      };
    }

    const route = finalStep.route;
    // Aggregate artifacts across every accepted step so a multi-step plan
    // (e.g. research → block draft) surfaces all of its durable work, while the
    // status/trust/answer reflect the final step.
    const artifacts = input.steps.flatMap((step) => step.artifacts);
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
      answer: input.clarifyOutcome?.question ?? finalResult.answer,
      artifacts,
      evaluations: finalStep.evaluations,
      events: input.events,
      nextActions: applyAudienceToNextActions(
        finalResult.nextActions ?? defaultNextActions(route, finalOutcome.status),
        resolveAudience(input.request),
        finalOutcome.status,
      ),
      repairAttempts: finalResult.repairAttempts ?? input.repairAttemptsTotal,
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
  };
}

function isTerminalSuccess(route: AgentRunRoute, outcome: StepOutcome): boolean {
  // A completed certified answer is the terminal success — no further steps add trust.
  // Every other accepted step falls through so a multi-step plan can keep going; the
  // run loop ends naturally when the planned queue empties or maxSteps is hit.
  return route === "certified_answer" && outcome.status === "completed";
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
      if (escalationRoute) {
        return { decision: "escalate", route: escalationRoute, goal: hint, repairHint: hint };
      }
      return { decision: "accept" };
    },
  };
}

export function defaultSuccessCriteria(route: AgentRunRoute): string[] {
  switch (route) {
    case "certified_answer":
      return ["Answer is backed by a certified DQL block or governed metric."];
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
  const mode = request.requestedMode ?? "auto";
  if (mode === "research") return "research";
  if (mode === "sql") return "sql_cell";
  if (mode === "block") return "dql_block_draft";
  if (mode === "app") return "app_build";

  const question = request.question;
  if (looksLikeDqlBlockRequest(question)) return "dql_block_draft";
  if (looksLikeSqlCellRequest(question)) return "sql_cell";
  if (looksLikeComposeApp(question)) return "app_build";

  if (decision.action === "compose_app") return "app_build";
  if (decision.action === "investigate") return "research";
  if (decision.action === "clarify") return "clarify";

  const certifiedScore = request.signals?.certifiedScore ?? 0;
  if (certifiedScore >= CERTIFIED_MATCH_THRESHOLD) return "certified_answer";
  return "generated_answer";
}

function looksLikeSqlCellRequest(question: string): boolean {
  return /\b(sql|query|notebook cell|cell draft|write a select|generate a query)\b/i.test(question);
}

function looksLikeDqlBlockRequest(question: string): boolean {
  return /\b(dql block|block draft|draft block|create.*block|turn .* into .*block|promote .* block)\b/i.test(question);
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
    case "certified_answer":
      return {
        status: "completed",
        trustState: "certified",
        summary: "Answered from certified DQL context.",
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
  request: AgentRunRequest,
  decision?: IntentDecision,
): AgentRunEvaluation[] {
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
      passed: (request.signals?.certifiedScore ?? 0) >= CERTIFIED_MATCH_THRESHOLD,
      severity: "blocking",
      message: "A certified DQL block or governed artifact must cover the answer.",
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
  if (route === "certified_answer") return "completed";
  return fallback;
}

function trustStateFromEvaluations(
  route: AgentRunRoute,
  evaluations: AgentRunEvaluation[],
  fallback: AgentRunTrustState,
): AgentRunTrustState {
  if (evaluations.some((evaluation) => !evaluation.passed && evaluation.severity === "blocking")) return "blocked";
  if (route === "certified_answer") return "certified";
  if (route === "clarify") return "not_applicable";
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
    case "generated_answer":
      return [{
        id: `${route}:answer`,
        kind: "answer",
        title: route === "certified_answer" ? "Certified answer" : "Generated answer",
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
  if (status === "needs_clarification") return "needs_clarification";
  if (route === "certified_answer") return "certified_answer_found";
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
  if (route === "research") {
    return [
      { id: "insert-sql", label: "Insert SQL cell", route: "sql_cell", artifactKind: "sql_cell" },
      { id: "create-block", label: "Create DQL draft", route: "dql_block_draft", artifactKind: "dql_block_draft" },
    ];
  }
  if (route === "sql_cell") {
    return [{ id: "create-block", label: "Promote to DQL draft", route: "dql_block_draft", artifactKind: "dql_block_draft" }];
  }
  if (route === "dql_block_draft") {
    return [{ id: "open-review", label: "Open review checklist", artifactKind: "dql_block_draft" }];
  }
  if (route === "app_build") {
    return [{ id: "open-app", label: "Open app draft", artifactKind: "app_draft" }];
  }
  return [];
}
