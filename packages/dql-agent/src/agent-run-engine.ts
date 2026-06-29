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
export type AgentRunTrustState = "certified" | "review_required" | "blocked" | "not_applicable";

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
  | "app_draft";

export type AgentRunEvaluationSeverity = "info" | "warning" | "blocking";

export interface AgentRunEvaluation {
  id: string;
  label: string;
  passed: boolean;
  severity: AgentRunEvaluationSeverity;
  message: string;
  evidence?: unknown;
  suggestedRepair?: string;
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
    | "route.decided"
    | "executor.started"
    | "evaluation.recorded"
    | "artifact.created"
    | "run.completed"
    | "run.failed";
  at: string;
  message: string;
  route?: AgentRunRoute;
  status?: AgentRunStatus;
  trustState?: AgentRunTrustState;
  payload?: unknown;
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

export interface AgentRunStore {
  save(run: AgentRun): void | Promise<void>;
  get(id: string): AgentRun | undefined | Promise<AgentRun | undefined>;
  list?(): AgentRun[] | Promise<AgentRun[]>;
}

export interface AgentRunEngineOptions {
  executors?: AgentRunExecutors;
  store?: AgentRunStore;
  idGenerator?: () => string;
  now?: () => Date;
  maxRepairAttempts?: number;
}

const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;
const CERTIFIED_MATCH_THRESHOLD = 0.5;

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

export class AgentRunEngine {
  private readonly executors: AgentRunExecutors;
  private readonly store?: AgentRunStore;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;
  private readonly maxRepairAttempts: number;

  constructor(options: AgentRunEngineOptions = {}) {
    this.executors = options.executors ?? {};
    this.store = options.store;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.maxRepairAttempts = options.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
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

    const routeDecision = buildIntentDecision(request);
    const route = selectRoute(request, routeDecision);
    emit({
      type: "route.decided",
      message: routeDecision.reason,
      route,
      payload: routeDecision,
    });

    try {
      emit({
        type: "executor.started",
        message: `Running ${route.replaceAll("_", " ")} executor.`,
        route,
      });
      const executorResult = await this.executeRoute({
        runId,
        request,
        route,
        routeDecision,
        maxRepairAttempts: this.maxRepairAttempts,
        emit,
      });
      const evaluations = executorResult.evaluations ?? defaultEvaluations(route, request, routeDecision);
      for (const evaluation of evaluations) {
        emit({
          type: "evaluation.recorded",
          message: evaluation.message,
          route,
          payload: evaluation,
        });
      }
      const fallback = defaultOutcome(route);
      const status = executorResult.status ?? statusFromEvaluations(route, evaluations, fallback.status);
      const trustState = executorResult.trustState ?? trustStateFromEvaluations(route, evaluations, fallback.trustState);
      const artifacts = status === "blocked"
        ? []
        : executorResult.artifacts ?? defaultArtifacts(route, executorResult, request);
      for (const artifact of artifacts) {
        emit({
          type: "artifact.created",
          message: `Created ${artifact.kind.replaceAll("_", " ")} artifact.`,
          route,
          trustState: artifact.trustState,
          payload: artifact,
        });
      }

      const stopReason = executorResult.stopReason ?? stopReasonFor(route, status, trustState, artifacts);
      const completedAt = this.timestamp();
      emit({
        type: "run.completed",
        message: `Agent run completed with status ${status}.`,
        route,
        status,
        trustState,
      });

      const run: AgentRun = {
        id: runId,
        question: request.question,
        requestedMode,
        route,
        status,
        trustState,
        stopReason,
        startedAt,
        completedAt,
        selectedObject: request.selectedObject,
        routeDecision,
        summary: executorResult.summary ?? fallback.summary,
        answer: executorResult.answer,
        artifacts,
        evaluations,
        events,
        nextActions: executorResult.nextActions ?? defaultNextActions(route, status),
        repairAttempts: executorResult.repairAttempts ?? 0,
      };
      await this.store?.save(run);
      return run;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({
        type: "run.failed",
        message,
        route,
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

  private async executeRoute(context: AgentRouteExecutionContext): Promise<AgentRouteExecutorResult> {
    const executor = this.executors[context.route];
    if (executor) return executor(context);
    return defaultExecutorResult(context.route, context.request, context.routeDecision);
  }

  private timestamp(): string {
    return this.now().toISOString();
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
