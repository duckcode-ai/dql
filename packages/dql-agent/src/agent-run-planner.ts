/**
 * LLM planner + replanner for the agent run loop.
 *
 * The engine accepts an injected {@link AgentRunPlanner}. This module builds an
 * LLM-backed one that decomposes an `auto` turn into an ordered, catalog-grounded
 * plan and decides repair/escalate/clarify when a step's gate fails. It is
 * deliberately provider-agnostic: callers inject a plain text completion fn
 * (`AgentRunPlannerCompletion`) so `dql-agent` never depends on the CLI's provider
 * wiring. Any parse/transport failure (or an explicit non-`auto` mode) falls back
 * to the deterministic planner so the engine stays fast, offline, and testable.
 */

import {
  AGENT_RUN_ESCALATION_MAP,
  createDeterministicAgentRunPlanner,
  defaultSuccessCriteria,
  type AgentRunAudience,
  type AgentRunEvaluation,
  type AgentRunPlan,
  type AgentRunPlanInput,
  type AgentRunPlannedStep,
  type AgentRunPlanner,
  type AgentRunReplanDecision,
  type AgentRunReplanInput,
  type AgentRunRequest,
  type AgentRunRequestedMode,
  type AgentRunRoute,
} from "./agent-run-engine.js";

/** Injected text completion. System + user in, raw model text out. Throws on transport errors. */
export type AgentRunPlannerCompletion = (input: {
  system: string;
  user: string;
  signal?: AbortSignal;
}) => Promise<string>;

const PLANNABLE_ROUTES: AgentRunRoute[] = [
  "certified_answer",
  "generated_answer",
  "research",
  "sql_cell",
  "dql_block_draft",
  "app_build",
  "clarify",
];

const PLANNABLE_ROUTE_SET = new Set<AgentRunRoute>(PLANNABLE_ROUTES);

export interface LlmAgentRunPlannerOptions {
  complete: AgentRunPlannerCompletion;
  /** Builds a compact, grounded catalog summary the model can plan against. */
  getCatalogContext?: (request: AgentRunRequest) => string | Promise<string>;
  /** Modes the LLM plans for. Others use the deterministic single-step plan. Default: `{ auto }`. */
  llmModes?: Iterable<AgentRunRequestedMode>;
  signal?: AbortSignal;
}

/**
 * Build an LLM planner. Falls back to the deterministic planner whenever the LLM
 * is not applicable (explicit mode) or fails (transport / unparsable output).
 */
export function createLlmAgentRunPlanner(options: LlmAgentRunPlannerOptions): AgentRunPlanner {
  const deterministic = createDeterministicAgentRunPlanner();
  const llmModes = new Set<AgentRunRequestedMode>(options.llmModes ?? ["auto"]);

  const usesLlm = (request: AgentRunRequest): boolean => llmModes.has(request.requestedMode ?? "auto");

  return {
    async plan(input: AgentRunPlanInput): Promise<AgentRunPlan> {
      // A conversational turn is a single deterministic step — never pay the
      // planner LLM call to "plan" a greeting.
      if (input.defaultRoute === "conversation" || !usesLlm(input.request)) {
        return deterministic.plan(input);
      }
      try {
        const catalogContext = options.getCatalogContext
          ? await options.getCatalogContext(input.request)
          : undefined;
        const raw = await options.complete({
          system: buildPlanSystemPrompt(input.maxSteps, input.audience),
          user: buildPlanUserPrompt(input, catalogContext),
          signal: options.signal,
        });
        const parsed = parsePlan(raw, input.maxSteps, input.audience);
        if (parsed && parsed.steps.length > 0) {
          return parsed;
        }
      } catch {
        // fall through to deterministic
      }
      return deterministic.plan(input);
    },

    async replan(input: AgentRunReplanInput): Promise<AgentRunReplanDecision> {
      if (!usesLlm(input.request)) {
        return deterministic.replan(input);
      }
      if (hasAuthoritativeRepairAction(input)) {
        return deterministic.replan(input);
      }
      try {
        const raw = await options.complete({
          system: buildReplanSystemPrompt(),
          user: buildReplanUserPrompt(input),
          signal: options.signal,
        });
        const parsed = parseReplan(raw, input);
        if (parsed) return parsed;
      } catch {
        // fall through to deterministic
      }
      return deterministic.replan(input);
    },
  };
}

function hasAuthoritativeRepairAction(input: AgentRunReplanInput): boolean {
  return input.currentStep.evaluations.some((evaluation) =>
    !evaluation.passed
    && Boolean(evaluation.suggestedRepair)
    && Boolean(evaluation.repairAction)
  );
}

function buildPlanSystemPrompt(maxSteps: number, audience: AgentRunAudience): string {
  const lines = [
    "You are the planner for DQL, a governed analytics agent.",
    `Decompose the user's request into an ordered list of 1 to ${maxSteps} steps. Prefer the fewest steps.`,
    "Each step picks exactly one route:",
    "- certified_answer: a certified DQL block/governed metric clearly covers the question.",
    "- generated_answer: ad-hoc question answerable with review-required generated SQL.",
    "- research: why / root-cause / driver / breakdown / comparison / anomaly investigations.",
    "- app_build: assemble a dashboard / app / standing view.",
    "- clarify: a required business object, measure, or grain is missing — ask ONE sharp question.",
  ];
  if (audience === "analyst") {
    lines.push("- sql_cell: the user wants a SQL notebook cell / query.");
    lines.push("- dql_block_draft: create or revise a governed DQL block.");
  } else {
    lines.push("Audience is a stakeholder (consumer). Do NOT use authoring routes (sql_cell, dql_block_draft); answer or research instead — certification is a separate handoff.");
  }
  lines.push("Governance: generated SQL and analysis are always review-required; never claim work is certified.");
  lines.push("Respond with ONLY a JSON object, no prose, no code fences:");
  lines.push('{"rationale": string, "steps": [{"route": string, "goal": string, "successCriteria": string[]}]}');
  return lines.join("\n");
}

function buildPlanUserPrompt(input: AgentRunPlanInput, catalogContext?: string): string {
  const { request, routeDecision, defaultRoute } = input;
  const lines: string[] = [];
  lines.push(`Question: ${request.question}`);
  if (request.intent) lines.push(`Classified intent: ${request.intent}`);
  if (request.signals) lines.push(`Retrieval signals: ${JSON.stringify(request.signals)}`);
  if (request.selectedObject) lines.push(`Selected object: ${JSON.stringify(request.selectedObject)}`);
  if (request.history?.length) {
    const recent = request.history.slice(-4).map((turn) => `${turn.role}: ${turn.text}`).join("\n");
    lines.push(`Recent conversation:\n${recent}`);
  }
  lines.push(`Deterministic route hint: ${defaultRoute} (${routeDecision.reason})`);
  if (catalogContext) lines.push(`Catalog context:\n${catalogContext}`);
  lines.push("Return the plan as JSON.");
  return lines.join("\n");
}

function buildReplanSystemPrompt(): string {
  return [
    "You supervise a governed agent loop. A step failed its evaluation gate.",
    "Decide the single best next move:",
    '- "repair": re-run the same route with a concrete repairHint (use when the route can still succeed).',
    '- "escalate": switch to a different route (provide route + goal) when the current route cannot satisfy the gate.',
    '- "clarify": ask the user ONE sharp question (provide question) when required context is missing.',
    '- "accept": keep the current review-required result as-is.',
    "Respond with ONLY a JSON object, no prose, no code fences:",
    '{"decision": "repair"|"escalate"|"clarify"|"accept", "route"?: string, "goal"?: string, "repairHint"?: string, "question"?: string}',
  ].join("\n");
}

function buildReplanUserPrompt(input: AgentRunReplanInput): string {
  const { currentStep, attemptsUsed, maxRepairAttempts } = input;
  const failing = currentStep.evaluations.filter((evaluation) => !evaluation.passed);
  const suggestedEscalation = AGENT_RUN_ESCALATION_MAP[currentStep.route];
  const engineEscalationsUsed = input.engineEscalationsUsed ?? input.budgetUsage?.usage.engineEscalationsUsed;
  const maxEngineEscalations = input.maxEngineEscalations ?? input.budgetUsage?.limits.engineEscalations;
  const lines: string[] = [];
  lines.push(`Question: ${input.request.question}`);
  lines.push(`Current route: ${currentStep.route}`);
  lines.push(`Step goal: ${currentStep.goal}`);
  lines.push(`Repair attempts used so far: ${attemptsUsed} of ${maxRepairAttempts}.`);
  if (engineEscalationsUsed !== undefined && maxEngineEscalations !== undefined) {
    lines.push(`Engine escalations used so far: ${engineEscalationsUsed} of ${maxEngineEscalations}.`);
  }
  lines.push(`Failing evaluations: ${JSON.stringify(failing.map(summariseEvaluation))}`);
  if (suggestedEscalation) lines.push(`Suggested escalation route: ${suggestedEscalation}`);
  if (input.remainingSteps.length) {
    lines.push(`Remaining planned steps: ${JSON.stringify(input.remainingSteps.map((step) => step.route))}`);
  }
  lines.push("Return the decision as JSON.");
  return lines.join("\n");
}

function summariseEvaluation(evaluation: AgentRunEvaluation): Record<string, unknown> {
  return {
    id: evaluation.id,
    severity: evaluation.severity,
    message: evaluation.message,
    suggestedRepair: evaluation.suggestedRepair,
    repairAction: evaluation.repairAction,
  };
}

/** Extract the first balanced JSON object from model text (tolerates code fences/prose). */
function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function asRoute(value: unknown): AgentRunRoute | undefined {
  return typeof value === "string" && PLANNABLE_ROUTE_SET.has(value as AgentRunRoute)
    ? value as AgentRunRoute
    : undefined;
}

const STAKEHOLDER_BLOCKED_ROUTES = new Set<AgentRunRoute>(["sql_cell", "dql_block_draft"]);

function parsePlan(raw: string, maxSteps: number, audience: AgentRunAudience): AgentRunPlan | undefined {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const rawSteps = Array.isArray(record.steps) ? record.steps : [];
  const steps: AgentRunPlannedStep[] = [];
  for (const item of rawSteps) {
    if (steps.length >= maxSteps) break;
    if (!item || typeof item !== "object") continue;
    const stepRecord = item as Record<string, unknown>;
    let route = asRoute(stepRecord.route);
    if (!route) continue;
    // Stakeholders never author — collapse any authoring step to a governed answer.
    if (audience === "stakeholder" && STAKEHOLDER_BLOCKED_ROUTES.has(route)) route = "generated_answer";
    const goal = typeof stepRecord.goal === "string" && stepRecord.goal.trim().length > 0
      ? stepRecord.goal.trim()
      : `Run ${route.replaceAll("_", " ")}.`;
    const successCriteria = Array.isArray(stepRecord.successCriteria)
      ? stepRecord.successCriteria.filter((value): value is string => typeof value === "string")
      : defaultSuccessCriteria(route);
    steps.push({
      id: `step-${steps.length + 1}`,
      route,
      goal,
      successCriteria: successCriteria.length > 0 ? successCriteria : defaultSuccessCriteria(route),
    });
  }
  if (steps.length === 0) return undefined;
  return {
    source: "llm",
    rationale: typeof record.rationale === "string" && record.rationale.trim().length > 0
      ? record.rationale.trim()
      : "LLM-planned multi-step run.",
    steps,
  };
}

function parseReplan(raw: string, input: AgentRunReplanInput): AgentRunReplanDecision | undefined {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const decision = typeof record.decision === "string" ? record.decision : undefined;
  const failing = input.currentStep.evaluations.find((evaluation) => !evaluation.passed && evaluation.suggestedRepair);
  const fallbackHint = failing?.suggestedRepair ?? "Revise and retry.";

  if (decision === "repair") {
    const repairHint = typeof record.repairHint === "string" && record.repairHint.trim().length > 0
      ? record.repairHint.trim()
      : fallbackHint;
    return { decision: "repair", repairHint };
  }
  if (decision === "escalate") {
    const route = asRoute(record.route) ?? AGENT_RUN_ESCALATION_MAP[input.currentStep.route];
    if (!route) return undefined;
    return {
      decision: "escalate",
      route,
      goal: typeof record.goal === "string" ? record.goal : undefined,
      repairHint: typeof record.repairHint === "string" ? record.repairHint : fallbackHint,
    };
  }
  if (decision === "clarify") {
    return {
      decision: "clarify",
      question: typeof record.question === "string" ? record.question : undefined,
    };
  }
  if (decision === "accept") {
    return { decision: "accept" };
  }
  return undefined;
}
