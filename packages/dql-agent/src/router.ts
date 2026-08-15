/**
 * Hybrid router — deterministic-first, LLM-assisted for the ambiguous middle.
 *
 * The engine already routes deterministically via {@link decideAgentAction}. That
 * cascade is fast, offline, and confident for the clear cases (a strong certified
 * match, an explicit "build me a dashboard", an obvious greeting). But paraphrased
 * or implicit analytical asks land at low confidence and misroute — which is why
 * users end up clicking "Dig deeper" by hand.
 *
 * This router keeps the deterministic decision when it is confident (>= the
 * threshold) — so certified fast paths and greetings stay 0-LLM — and only spends
 * ONE cheap classification call when the heuristics are unsure. The completion is
 * injected (provider-agnostic, like the planner and narrator); any failure falls
 * back to the deterministic decision unchanged. Results are cached so a repeated
 * question never pays twice.
 */

import {
  classifyConversationalTurn,
  decideAgentAction,
  type IntentDecision,
} from "./intent-controller.js";
import type { AgentRunRequest, AgentRouter } from "./agent-run-engine.js";
import type { MetadataAgentIntent } from "./metadata/catalog.js";
import {
  buildMeaningEvidencePackage,
  canonicalizeMetricMeasureCandidates,
  defaultQueryIntent,
  findExplicitEvidenceReference,
  questionTypeFromText,
  routeForEvidenceCandidate,
  validateMeaningResolution,
  type AgentEvidenceCandidate,
  type AgentMeaningResolver,
  type AgentRetrievalEvidence,
  type MeaningExecutionRoute,
  type MeaningResolution,
} from "./meaning-resolution.js";
import { normalizeAnalyticalQuestionFrameV2 } from "@duckcodeailabs/dql-core";
import {
  buildResolvedAnalyticalPlan,
  type ResolvedAnalyticalPlan,
} from "./resolved-analytical-plan.js";
import {
  normalizeEvidenceAnalyticalCapability,
  solveAnalyticalCompatibility,
} from "./analytical-compatibility.js";
import { buildDeterministicAnalyticalFrame, projectResolvedAnalyticalFrame } from "./analytical-frame.js";
import {
  conversationHistoryFromContext,
  renderConversationEnvelopeForPrompt,
} from "./conversation/snapshot.js";

/** The router's fine-grained classification of a turn. */
export interface RouterClassification {
  category:
    | "conversational"
    | "capability"
    | "general_knowledge"
    | "data_lookup"
    | "data_analysis"
    | "authoring"
    | "app"
    | "unclear";
  depth: "quick" | "deep";
  needsClarification: boolean;
  clarifyingQuestion?: string;
  rationale: string;
}

/** Injected text completion — system + user in, raw model text out. Throws on transport errors. */
export type RouterCompletion = (input: {
  system: string;
  user: string;
  signal?: AbortSignal;
}) => Promise<string>;

export interface HybridRouterOptions {
  /** Absent → pure heuristics (the router is a no-op wrapper over the deterministic decision). */
  complete?: RouterCompletion;
  /** Builds a compact catalog summary so the classifier can tell data from general knowledge. */
  getCatalogContext?: (request: AgentRunRequest) => string | Promise<string>;
  /**
   * Preferred structured retriever. It must return globally ranked, qualified
   * evidence before the router is allowed to classify a turn as general knowledge.
   */
  getEvidence?: (request: AgentRunRequest) => AgentRetrievalEvidence | undefined | Promise<AgentRetrievalEvidence | undefined>;
  /** Optional dedicated meaning resolver. When absent, `complete` is used once. */
  resolveMeaning?: AgentMeaningResolver;
  /** Maximum candidate cards sent to meaning resolution. Default 12. */
  maxMeaningCandidates?: number;
  /** Authoritative by default; `shadow` is the bounded rollback switch. */
  resolvedPlanMode?: ResolvedAnalyticalPlan['mode'];
  /**
   * Natural-language analytical turns use one bounded candidate-ID meaning
   * call by default.  Hosts may disable this only for migration/testing; an
   * explicit selectedEvidenceId or qualified @ reference is always allowed to
   * use the zero-call path because the user has already supplied identity.
   * Acceptance: AGT-027, AGT-028.
   */
  requireMeaningCallForNaturalLanguage?: boolean;
  /** Deterministic confidence at/above which the LLM is never called. Default 0.7. */
  llmThreshold?: number;
  /** Max cached classifications. Default 200. */
  cacheSize?: number;
  /** Cache TTL in ms. Default 10 minutes. */
  cacheTtlMs?: number;
  /** Injected clock for testing (defaults to Date.now via a monotonic counter fallback). */
  now?: () => number;
  signal?: AbortSignal;
}

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_CACHE_SIZE = 200;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  decision: IntentDecision;
  at: number;
}

/**
 * Map a router category to the fine-grained {@link MetadataAgentIntent} so the
 * downstream answer loop keeps its existing behavior. Only used to enrich the
 * decision — routing itself keys off `action`/`category`.
 */
function intentForCategory(category: RouterClassification["category"]): MetadataAgentIntent | undefined {
  switch (category) {
    case "data_lookup":
      return "ad_hoc_ranking";
    case "data_analysis":
      return "driver_breakdown";
    case "general_knowledge":
      return "definition_lookup";
    default:
      return undefined;
  }
}

/** Translate a validated classification into an engine {@link IntentDecision}. */
function classificationToDecision(
  classification: RouterClassification,
  base: IntentDecision,
): IntentDecision {
  const followsUp = base.followsUp;
  const common = {
    category: classification.category,
    depth: classification.depth,
    source: "llm" as const,
    followsUp,
  };
  switch (classification.category) {
    case "conversational":
      return { action: "converse", confidence: 0.9, reason: classification.rationale, conversationalKind: "smalltalk", ...common };
    case "capability":
      return { action: "converse", confidence: 0.9, reason: classification.rationale, conversationalKind: "meta_capability", ...common };
    case "general_knowledge":
      // Rendered as a conversation reply, but tagged general_knowledge downstream.
      return { action: "converse", confidence: 0.85, reason: classification.rationale, ...common };
    case "app":
      return { action: "compose_app", confidence: 0.82, reason: classification.rationale, ...common };
    case "data_analysis":
      return { action: "investigate", confidence: 0.8, reason: classification.rationale, ...common };
    case "authoring":
      return { action: "answer", confidence: 0.75, reason: classification.rationale, ...common };
    case "data_lookup":
      return { action: "answer", confidence: 0.75, reason: classification.rationale, ...common };
    case "unclear":
    default:
      return {
        action: "clarify",
        confidence: 0.6,
        reason: classification.rationale,
        clarifyingQuestion: classification.needsClarification && classification.clarifyingQuestion
          ? classification.clarifyingQuestion
          : base.clarifyingQuestion,
        ...common,
      };
  }
}

function buildSystemPrompt(): string {
  return [
    "You classify a user's turn in DQL, a governed analytics notebook, so the agent routes it well.",
    "Pick ONE category:",
    "- conversational: greeting, thanks, small talk — no data or knowledge needed.",
    "- capability: asking what the assistant/DQL can do.",
    "- general_knowledge: a factual question answerable from world knowledge, NOT the user's data (e.g. 'what is dbt?').",
    "- data_lookup: a specific value/ranking answerable from the user's governed data (e.g. 'total revenue', 'top 10 customers').",
    "- data_analysis: why / root-cause / driver / breakdown / comparison / trend / anomaly — needs multi-step investigation.",
    "- authoring: user wants a SQL cell or a DQL block created.",
    "- app: user wants a dashboard / app / standing view assembled.",
    "- unclear: a real request but missing the business object, measure, or grain needed to proceed.",
    "Also pick depth: 'deep' for data_analysis or anything needing several steps; otherwise 'quick'.",
    "If unclear, set needsClarification true and give ONE sharp clarifyingQuestion.",
    "Respond with ONLY a JSON object, no prose, no code fences:",
    '{"category": string, "depth": "quick"|"deep", "needsClarification": boolean, "clarifyingQuestion"?: string, "rationale": string}',
  ].join("\n");
}

function effectiveConversationHistory(
  request: AgentRunRequest,
): NonNullable<AgentRunRequest['history']> {
  return request.history?.length
    ? request.history
    : conversationHistoryFromContext(request.conversationContext);
}

function buildUserPrompt(request: AgentRunRequest, catalogContext?: string): string {
  const lines: string[] = [];
  lines.push(`Turn: ${request.question}`);
  const history = effectiveConversationHistory(request);
  if (history.length) {
    const recent = history.slice(-4).map((turn) => `${turn.role}: ${turn.text}`).join("\n");
    lines.push(`Recent conversation:\n${recent}`);
  }
  const envelope = renderConversationEnvelopeForPrompt(request.conversationContext);
  if (envelope) lines.push(`Structured conversation state:\n${envelope}`);
  if (request.signals) lines.push(`Retrieval signals: ${JSON.stringify(request.signals)}`);
  if (catalogContext) lines.push(`Available governed data (so you can tell data from general knowledge):\n${catalogContext}`);
  lines.push("Return the classification as JSON.");
  return lines.join("\n");
}

const CATEGORIES = new Set<RouterClassification["category"]>([
  "conversational",
  "capability",
  "general_knowledge",
  "data_lookup",
  "data_analysis",
  "authoring",
  "app",
  "unclear",
]);

/** Extract the first balanced JSON object from model text (tolerant of fences/prose). */
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

function parseClassification(raw: string): RouterClassification | undefined {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const category = record.category;
  if (typeof category !== "string" || !CATEGORIES.has(category as RouterClassification["category"])) return undefined;
  const depth = record.depth === "deep" ? "deep" : "quick";
  const needsClarification = record.needsClarification === true;
  const clarifyingQuestion = typeof record.clarifyingQuestion === "string" && record.clarifyingQuestion.trim().length > 0
    ? record.clarifyingQuestion.trim()
    : undefined;
  const rationale = typeof record.rationale === "string" && record.rationale.trim().length > 0
    ? record.rationale.trim()
    : "Classified by the AI router.";
  return {
    category: category as RouterClassification["category"],
    depth,
    needsClarification,
    clarifyingQuestion,
    rationale,
  };
}

function buildMeaningSystemPrompt(): string {
  return [
    "You resolve business meaning for DQL, a governed analytics system.",
    "The host already performed broad retrieval. Compare ONLY the supplied candidate cards.",
    "Select the concept that best matches the full question, entity, dimensions, filters, time grain, formula, aggregation, domain, and conversation context.",
    "Trust is an execution preference only after relevance and compatibility. Never select an unrelated certified block over a relevant semantic metric.",
    "You may reference ONLY candidate IDs supplied below. Never invent an ID, table, column, metric, relationship, or filter value.",
    "Use low confidence and recommend clarify when material business meanings remain unresolved.",
    "Respond with ONLY one JSON object matching this shape:",
    '{"interpretedQuestion":string,"questionType":"definition"|"value"|"ranking"|"trend"|"comparison"|"diagnosis"|"research","selectedConceptIds":string[],"recommendedExecutionId"?:string,"queryIntent":{"measures":string[],"dimensions":string[],"filters":[{"field":string,"value":string}],"timeRange"?:string,"timeGrain"?:string,"order"?:"asc"|"desc","limit"?:number},"analyticalFrame"?:AnalyticalQuestionFrameV2,"rejectedCandidates":[{"id":string,"reason":string}],"confidence":"high"|"medium"|"low","missingInformation":string[],"recommendedRoute":"certified"|"semantic"|"governed_sql"|"exploratory"|"clarify","clarifyingQuestion"?:string}',
    "AnalyticalQuestionFrameV2 uses version 2 and exact supplied IDs for metricConceptIds, entityGrainIds, dimensions with roles group_by/filter/display/rank_entity/time_axis, memberBindings, timeContext with bounded periods, comparison, ranking, requestedOutputs, and ambiguity. Include it for value/ranking/trend/comparison requests when the supplied capability facts are sufficient; otherwise report missingInformation.",
  ].join("\n");
}

function buildMeaningUserPrompt(
  request: AgentRunRequest,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
): string {
  const cards = candidates.map((candidate) => ({
    id: candidate.id,
    kind: candidate.kind,
    trustTier: candidate.trustTier,
    name: compactText(candidate.name, 160),
    aliases: compactArray(candidate.aliases, 8, 120),
    definition: compactText(candidate.definition, 800),
    formula: compactText(candidate.formula, 500),
    aggregation: compactText(candidate.aggregation, 120),
    domain: compactText(candidate.domain, 120),
    semanticModel: compactText(candidate.semanticModel, 160),
    primaryEntity: compactText(candidate.primaryEntity, 160),
    dimensions: compactArray(candidate.dimensions, 16, 120),
    timeGrains: compactArray(candidate.timeGrains, 8, 80),
    requiredParameters: compactArray(candidate.requiredParameters, 12, 120),
    sourceObjects: compactArray(candidate.sourceObjects, 8, 160),
    relationshipEvidence: compactArray(candidate.relationshipEvidence, 8, 240),
    relevanceScore: candidate.relevanceScore,
    matchReasons: compactArray(candidate.matchReasons, 8, 240),
    compatibility: candidate.compatibility,
    compatibilityFacts: compactArray(candidate.compatibilityFacts, 8, 240),
    analyticalCapability: candidate.analyticalCapability,
  }));
  const lines = [
    `Question: ${compactText(request.question, 2_000)}`,
    `Parsed request hints: ${JSON.stringify(compactQueryIntent(defaultQueryIntent(evidence)))}`,
    `Candidate cards: ${JSON.stringify(cards)}`,
  ];
  const history = effectiveConversationHistory(request);
  if (history.length) {
    lines.push(`Recent conversation: ${JSON.stringify(history.slice(-4).map((turn) => ({
      role: turn.role,
      text: compactText(turn.text, 1_200),
    })))}`);
  }
  const envelope = renderConversationEnvelopeForPrompt(request.conversationContext);
  if (envelope) lines.push(`Structured conversation state: ${JSON.stringify(envelope)}`);
  lines.push("Resolve the intended meaning and return JSON only.");
  return lines.join("\n");
}

function compactText(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function compactArray(value: string[] | undefined, maxItems: number, maxItemLength: number): string[] | undefined {
  return value?.slice(0, maxItems).map((item) => compactText(item, maxItemLength) ?? "");
}

function compactQueryIntent(intent: ReturnType<typeof defaultQueryIntent>): ReturnType<typeof defaultQueryIntent> {
  return {
    measures: compactArray(intent.measures, 8, 160) ?? [],
    dimensions: compactArray(intent.dimensions, 12, 160) ?? [],
    filters: intent.filters.slice(0, 8).map((filter) => ({
      field: compactText(filter.field, 160) ?? "",
      value: compactText(filter.value, 240) ?? "",
    })),
    ...(intent.timeRange ? { timeRange: compactText(intent.timeRange, 160) } : {}),
    ...(intent.timeGrain ? { timeGrain: compactText(intent.timeGrain, 80) } : {}),
    ...(intent.order ? { order: intent.order } : {}),
    ...(intent.limit !== undefined ? { limit: intent.limit } : {}),
  };
}

const QUESTION_TYPES = new Set(["definition", "value", "ranking", "trend", "comparison", "diagnosis", "research"]);
const MEANING_CONFIDENCES = new Set(["high", "medium", "low"]);
const MEANING_ROUTES = new Set(["certified", "semantic", "governed_sql", "exploratory", "clarify"]);

function parseMeaningResolution(raw: string): MeaningResolution | undefined {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.interpretedQuestion !== "string" || !record.interpretedQuestion.trim()) return undefined;
  if (typeof record.questionType !== "string" || !QUESTION_TYPES.has(record.questionType)) return undefined;
  if (!Array.isArray(record.selectedConceptIds) || record.selectedConceptIds.some((id) => typeof id !== "string")) return undefined;
  if (typeof record.confidence !== "string" || !MEANING_CONFIDENCES.has(record.confidence)) return undefined;
  if (typeof record.recommendedRoute !== "string" || !MEANING_ROUTES.has(record.recommendedRoute)) return undefined;
  if (!record.queryIntent || typeof record.queryIntent !== "object" || Array.isArray(record.queryIntent)) return undefined;
  const query = record.queryIntent as Record<string, unknown>;
  const measures = stringArray(query.measures);
  const dimensions = stringArray(query.dimensions);
  const missingInformation = stringArray(record.missingInformation);
  if (!measures || !dimensions || !missingInformation || !Array.isArray(query.filters)) return undefined;
  const filters = query.filters.flatMap((filter) => {
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) return [];
    const item = filter as Record<string, unknown>;
    return typeof item.field === "string" && typeof item.value === "string"
      ? [{ field: item.field, value: item.value }]
      : [];
  });
  if (filters.length !== query.filters.length) return undefined;
  if (!Array.isArray(record.rejectedCandidates)) return undefined;
  const rejectedCandidates = record.rejectedCandidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    return typeof item.id === "string" && typeof item.reason === "string"
      ? [{ id: item.id, reason: item.reason }]
      : [];
  });
  if (rejectedCandidates.length !== record.rejectedCandidates.length)
    return undefined;
  const recommendedExecutionId =
    typeof record.recommendedExecutionId === "string"
      ? record.recommendedExecutionId
      : undefined;
  const clarifyingQuestion =
    typeof record.clarifyingQuestion === "string" &&
    record.clarifyingQuestion.trim()
      ? record.clarifyingQuestion.trim()
      : undefined;
  const analyticalFrame =
    record.analyticalFrame === undefined
      ? undefined
      : normalizeAnalyticalQuestionFrameV2(record.analyticalFrame);
  if (record.analyticalFrame !== undefined && !analyticalFrame)
    return undefined;
  return {
    interpretedQuestion: record.interpretedQuestion.trim(),
    questionType: record.questionType as MeaningResolution["questionType"],
    selectedConceptIds: record.selectedConceptIds as string[],
    ...(recommendedExecutionId ? { recommendedExecutionId } : {}),
    queryIntent: {
      measures,
      dimensions,
      filters,
      ...(typeof query.timeRange === "string" ? { timeRange: query.timeRange } : {}),
      ...(typeof query.timeGrain === "string" ? { timeGrain: query.timeGrain } : {}),
      ...(query.order === "asc" || query.order === "desc" ? { order: query.order } : {}),
      ...(typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
        ? { limit: Math.floor(query.limit) }
        : {}),
    },
    rejectedCandidates,
    confidence: record.confidence as MeaningResolution["confidence"],
    missingInformation,
    recommendedRoute: record.recommendedRoute as MeaningResolution["recommendedRoute"],
    ...(clarifyingQuestion ? { clarifyingQuestion } : {}),
    ...(analyticalFrame ? { analyticalFrame } : {}),
  };
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : undefined;
}

/** Normalize a question for cache keying (whitespace/case-insensitive). */
function cacheKey(
  request: AgentRunRequest,
  evidence?: AgentRetrievalEvidence,
  catalogContext?: string,
): string {
  const q = request.question.trim().toLowerCase().replace(/\s+/g, " ");
  const history = effectiveConversationHistory(request);
  const last = history.length ? history[history.length - 1].text.trim().toLowerCase() : "";
  const envelope = renderConversationEnvelopeForPrompt(request.conversationContext) ?? "";
  // WHERE THE THREAD IS, not just what it knows.
  //
  // The envelope renders working state and the summary — neither of which a
  // FAILED turn advances. Re-asking after a failure therefore produced a
  // byte-identical key and the router replayed its cached decision, so the same
  // question failed the same way for the full 10-minute TTL. A new thread got a
  // different `thread:` line, re-routed, and answered — which is exactly why the
  // same question worked in a new session and not in the current one.
  //
  // Every appended turn must invalidate the entry: a retry is a new decision.
  const position = conversationPositionToken(request.conversationContext);
  const evidenceVersion = evidence
    ? evidence.sourceFingerprint
      ?? evidence.snapshotId
      ?? evidence.candidates.map((candidate) => `${candidate.id}:${candidate.relevanceScore}:${candidate.compatibility}`).join("|")
    : catalogContext ?? "";
  return `${q}\u0000${last}\u0000${envelope}\u0000${position}\u0000${evidenceVersion}`;
}

/**
 * A compact token identifying how far along the thread is. Any appended turn —
 * answered OR failed — changes it, so a cached routing decision can never
 * outlive the turn it was made for.
 */
function conversationPositionToken(context: Record<string, unknown> | undefined): string {
  if (!context) return "";
  const turns = Array.isArray(context.turns) ? context.turns : [];
  const latest = typeof context.latestTurnId === "string"
    ? context.latestTurnId
    : typeof context.activeTurnId === "string"
      ? context.activeTurnId
      : "";
  const envelope = context.conversationEnvelope ?? context.serverSnapshot;
  const recent = envelope && typeof envelope === "object" && !Array.isArray(envelope)
    && Array.isArray((envelope as { recentTurns?: unknown }).recentTurns)
    ? ((envelope as { recentTurns: unknown[] }).recentTurns).length
    : 0;
  const tailId = recent > 0
    ? String(((envelope as { recentTurns: Array<{ id?: unknown }> }).recentTurns.at(-1)?.id) ?? "")
    : "";
  return `${latest}:${turns.length}:${recent}:${tailId}`;
}

function retrievalTrace(
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
): NonNullable<IntentDecision["retrievalEvidence"]> {
  return {
    ...(evidence.snapshotId ? { snapshotId: evidence.snapshotId } : {}),
    ...(evidence.sourceFingerprint ? { sourceFingerprint: evidence.sourceFingerprint } : {}),
    candidateCount: candidates.length,
    candidateIds: candidates.map((candidate) => candidate.id),
  };
}

function routeDecisionForResolution(
  base: IntentDecision,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
  resolution: MeaningResolution,
  source: "llm" | "heuristic",
  question = resolution.interpretedQuestion,
  mode: ResolvedAnalyticalPlan['mode'] = 'authoritative',
): IntentDecision {
  let planBoundResolution = resolution;
  if (resolution.analyticalFrame && resolution.recommendedRoute === 'semantic') {
    const { analyticalFrame: sourceFrame, ...resolutionWithoutFrame } = resolution;
    const bindingPlan = buildResolvedAnalyticalPlan({
      question,
      resolution: resolutionWithoutFrame,
      evidence,
      candidates,
      mode,
    });
    planBoundResolution = {
      ...resolution,
      analyticalFrame: projectResolvedAnalyticalFrame({ plan: bindingPlan, sourceFrame }),
    };
  }
  const routedResolution = enforceAnalyticalCompatibility(
    planBoundResolution,
    evidence,
    candidates,
  );
  const resolvedAnalyticalPlan = buildResolvedAnalyticalPlan({
    question,
    resolution: routedResolution,
    evidence,
    candidates,
    mode,
  });
  const reconciliation = reconcileResolvedPlanOutcome(
    routedResolution,
    resolvedAnalyticalPlan,
    candidates,
  );
  const needsClarification = reconciliation.outcome === 'clarify';
  const terminallyBlocked = reconciliation.outcome === 'modeling_gap'
    || reconciliation.outcome === 'policy_blocked';
  const analytical =
    routedResolution.questionType === "diagnosis" ||
    routedResolution.questionType === "research";
  const reason = reconciliation.reason;
  return {
    ...base,
    action: needsClarification
      ? "clarify"
      : terminallyBlocked
        ? "block"
      : analytical
        ? "investigate"
        : "answer",
    confidence:
      routedResolution.confidence === "high"
        ? 0.9
        : routedResolution.confidence === "medium"
          ? 0.72
          : 0.45,
    reason,
    source,
    category: analytical ? "data_analysis" : needsClarification ? "unclear" : "data_lookup",
    depth: analytical ? "deep" : "quick",
    meaningResolution: routedResolution,
    resolvedAnalyticalPlan,
    retrievalEvidence: retrievalTrace(evidence, candidates),
    requiresClarification: needsClarification,
    ...(terminallyBlocked
      ? {
          terminalOutcome: {
            kind: reconciliation.outcome === 'policy_blocked'
              ? 'policy_blocked' as const
              : 'modeling_gap' as const,
            code: reconciliation.outcome === 'policy_blocked'
              ? 'ANALYTICAL_POLICY_BLOCKED' as const
              : 'ANALYTICAL_MODELING_GAP' as const,
            message: reconciliation.reason,
            candidateIds: resolvedAnalyticalPlan.resolutionFailure?.candidateIds ?? [],
          },
        }
      : {}),
    ...(needsClarification
      ? { clarificationOptions: reconciliation.options }
      : {}),
    ...(needsClarification
      ? {
          clarifyingQuestion: reconciliation.question,
        }
      : {}),
  };
}

type ReconciledPlanOutcome = {
  outcome: 'ready' | 'clarify' | 'modeling_gap' | 'policy_blocked';
  reason: string;
  question?: string;
  options?: NonNullable<IntentDecision['clarificationOptions']>;
};

/**
 * The immutable RAP is the final routing authority. Meaning may nominate an
 * execution route, but cannot leave the router claiming an answer after the
 * host has retained an ambiguous or blocked qualified binding.
 */
function reconcileResolvedPlanOutcome(
  resolution: MeaningResolution,
  plan: ResolvedAnalyticalPlan,
  candidates: AgentEvidenceCandidate[],
): ReconciledPlanOutcome {
  if (plan.capability !== 'blocked') {
    return {
      outcome: 'ready',
      reason: `Resolved the question against ${plan.selectedConceptIds.join(', ')}: ${resolution.interpretedQuestion}`,
    };
  }

  const bindings = [
    ...plan.query.measures.map((binding) => ({ kind: 'measure', binding })),
    ...plan.query.dimensions.map((binding) => ({ kind: 'dimension', binding })),
    ...plan.query.filters.map((filter) => ({ kind: 'filter', binding: filter.binding })),
  ].filter(({ binding }) => binding.status !== 'resolved');
  const qualifiedChoiceIds = [...new Set(bindings.flatMap(({ binding }) => binding.candidateIds))].sort();
  const userResolvableBinding = bindings.some(({ binding }) =>
    binding.candidateIds.length > 0);

  if (plan.resolutionFailure?.outcome === 'policy_blocked') {
    return {
      outcome: 'policy_blocked',
      reason: `Policy blocked the selected analytical plan: ${plan.missingInformation.join(' ') || 'review the retained policy diagnostic.'}`,
    };
  }
  if (plan.resolutionFailure?.outcome === 'modeling_gap') {
    return {
      outcome: 'modeling_gap',
      reason: `The selected analytical plan has a governed modeling gap: ${plan.missingInformation.join(' ') || 'review the retained capability diagnostic.'}`,
    };
  }
  if (userResolvableBinding || plan.resolutionFailure?.outcome === 'clarify') {
    const optionIds = qualifiedChoiceIds.length > 0
      ? qualifiedChoiceIds
      : [...new Set((resolution.compatibilityFailures ?? []).flatMap((failure) => failure.candidateIds))].sort();
    const options = optionIds.length > 0
      ? clarificationOptionsForQualifiedIds(optionIds, candidates)
      : buildClarificationOptions(candidates);
    const bindingSummary = bindings.map(({ kind, binding }) =>
      `${kind} “${binding.requested}” is ${binding.status}`).join('; ');
    const question = routedClarificationQuestion(resolution, bindings, options);
    return {
      outcome: 'clarify',
      reason: `The immutable analytical plan needs one identifier-bound choice: ${bindingSummary || plan.missingInformation.join(' ')}`,
      question,
      options,
    };
  }
  if (resolution.confidence === 'low' || resolution.recommendedRoute === 'clarify') {
    return {
      outcome: 'clarify',
      reason: `The retrieved evidence needs one governed meaning choice: ${plan.missingInformation.join(' ') || resolution.interpretedQuestion}`,
      question: resolution.clarifyingQuestion ?? buildEvidenceClarification(candidates, plan.missingInformation),
      options: buildClarificationOptions(candidates),
    };
  }
  return {
    outcome: 'modeling_gap',
    reason: `The selected analytical plan is not executable from the governed model: ${plan.missingInformation.join(' ') || 'review its capability and relationship proof.'}`,
  };
}

function clarificationOptionsForQualifiedIds(
  ids: string[],
  candidates: AgentEvidenceCandidate[],
): NonNullable<IntentDecision['clarificationOptions']> {
  return ids.slice(0, 3).map((id) => {
    const candidate = candidates.find((item) => item.id === id || item.qualifiedId === id);
    return {
      id,
      label: candidate?.name ?? qualifiedIdLabel(id),
      ...(candidate?.definition?.trim() ? { description: candidate.definition.trim() } : {}),
      kind: candidate?.kind ?? 'semantic_member',
    };
  });
}

function qualifiedIdLabel(id: string): string {
  const local = id.split(/[:./]/).filter(Boolean).at(-1) ?? id;
  return local.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function routedClarificationQuestion(
  resolution: MeaningResolution,
  bindings: Array<{ kind: string; binding: ResolvedAnalyticalPlan['query']['measures'][number] }>,
  options: NonNullable<IntentDecision['clarificationOptions']>,
): string {
  if (resolution.clarifyingQuestion && !/^The analytical frame has unresolved ambiguity:/i.test(resolution.clarifyingQuestion)) {
    return resolution.clarifyingQuestion;
  }
  const first = bindings[0];
  const labels = options.map((option) => option.label);
  if (first && labels.length > 1) {
    return `Which governed ${first.kind} should I use for “${first.binding.requested}”: ${labels.join(' or ')}?`;
  }
  return resolution.clarifyingQuestion
    ?? `Which governed binding should I use before running this query?`;
}

function continueCascadeAfterIncompleteSelection(
  base: IntentDecision,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
  selected: AgentEvidenceCandidate,
): IntentDecision {
  return {
    ...base,
    action: 'answer',
    confidence: 0.78,
    reason: `The user selected ${selected.name}, but that evidence does not prove the complete requested metric, dimension, filter, and grain tuple. The selection is consumed once; continue through the governed semantic/SQL cascade without dropping any requested part.`,
    source: 'heuristic',
    category: 'data_lookup',
    depth: 'quick',
    retrievalEvidence: retrievalTrace(evidence, candidates),
    requiresClarification: false,
  };
}

function enforceAnalyticalCompatibility(
  resolution: MeaningResolution,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
): MeaningResolution {
  const missingMetricTerms = missingExplicitMetricTerms(
    evidence.parsedIntent?.measures ?? resolution.queryIntent.measures,
    candidates,
  );
  const requestedMetricCount = new Set(
    (evidence.parsedIntent?.measures ?? resolution.queryIntent.measures)
      .map(normalizeMetricPhrase)
      .filter(Boolean),
  ).size;
  // Parser hints may split one business metric name into overlapping measure
  // tokens (for example "rollover balance amount" -> "balance", "amount").
  // Treat several hints as a multi-metric contract only when the question
  // actually coordinates separate measures; otherwise one exact qualified
  // capability is allowed to bind all synonymous hints.
  const explicitlyCoordinatesMetrics = /(?:,|\b(?:and|plus|versus|vs\.?|along with)\b)/i.test(
    resolution.interpretedQuestion,
  );
  if (
    requestedMetricCount > 1
    && explicitlyCoordinatesMetrics
    && (missingMetricTerms.length > 0
      || (resolution.analyticalFrame?.metricConceptIds.length ?? 0) < requestedMetricCount)
  ) {
    const missing = missingMetricTerms.length > 0
      ? missingMetricTerms
      : ['one or more requested metrics'];
    const message = `No governed metric capability was resolved for ${missing.join(', ')}; no requested metric was dropped.`;
    return {
      ...resolution,
      confidence: 'low',
      recommendedRoute: 'clarify',
      missingInformation: [...new Set([...resolution.missingInformation, message])],
      clarifyingQuestion: `I can’t safely compose all requested metrics because ${missing.join(', ')} is unavailable or ambiguous. Which governed metric should I use?`,
    };
  }
  if (!resolution.analyticalFrame) return resolution;
  const capabilityCandidates = candidates.flatMap((candidate) => {
    const normalized = normalizeEvidenceAnalyticalCapability(candidate);
    return normalized.status === "complete" && normalized.capability
      ? [
          {
            candidateId: candidate.id,
            capability: normalized.capability,
            fitClass:
              candidate.kind === "certified_block"
                ? (candidate.analyticalFitClass ?? ("parameterized" as const))
                : ("exact" as const),
          },
        ]
      : [];
  });
  const result = solveAnalyticalCompatibility({
    frame: resolution.analyticalFrame,
    candidates: capabilityCandidates,
    policies: evidence.analyticalPolicies,
  });
  if (result.status === "ready") {
    const metricIds = new Set(result.capabilities.map((capability) => capability.metricId));
    const metricEvidence = candidates.filter(
      (candidate) =>
        candidate.kind === "semantic_metric" &&
        candidate.analyticalCapability?.metricId &&
        metricIds.has(candidate.analyticalCapability.metricId),
    );
    return {
      ...resolution,
      analyticalFrame: result.frame,
      analyticalPolicyIds: result.policyIds,
      ...(metricEvidence.length > 0
        ? { selectedConceptIds: metricEvidence.map((candidate) => candidate.id) }
        : {}),
      recommendedExecutionId: result.candidateId,
      recommendedRoute: result.route,
      missingInformation: [],
      compatibilityOutcome: undefined,
      compatibilityFailures: undefined,
    };
  }
  // A question asking for SEVERAL metrics ("revenue and refunds by month") is a
  // legitimate question, not an ambiguous one. The v2 analytical lane is
  // contract-per-metric by construction, so it blocks — but blocking must not
  // turn into a clarify prompt or a silent collapse to one metric. Drop the
  // single-metric frame instead and let the cascade fall through to the semantic
  // bridge, which compiles multi-metric selections natively.
  if (result.status === "blocked"
    && result.failures.length > 0
    && result.failures.every((failure) => failure.code === "MULTI_METRIC_UNSUPPORTED")) {
    const { analyticalFrame: _droppedFrame, ...withoutFrame } = resolution;
    return {
      ...withoutFrame,
      analyticalPolicyIds: result.policyIds,
    };
  }
  const failures = result.failures.map((failure) => failure.message);
  const compatibilityFailures = result.failures.map((failure) => ({
    code: failure.code,
    field: failure.field,
    message: failure.message,
    candidateIds: [...(failure.candidateIds ?? [])],
  }));
  const policyFailure = result.failures.some((failure) => failure.code.startsWith('POLICY_'));
  const compatibilityOutcome = policyFailure
    ? 'policy_blocked' as const
    : result.status === 'clarify'
      ? 'clarify' as const
      : 'modeling_gap' as const;
  return {
    ...resolution,
    analyticalFrame: result.frame,
    analyticalPolicyIds: result.policyIds,
    confidence: result.status === "clarify" ? "low" : resolution.confidence,
    recommendedRoute: "clarify",
    compatibilityOutcome,
    compatibilityFailures,
    missingInformation: [
      ...new Set([...resolution.missingInformation, ...failures]),
    ],
    clarifyingQuestion:
      result.status === "clarify"
        ? result.failure.message
        : (failures[0] ??
          "The requested analytical tuple is not executable from the current governed model."),
  };
}

function buildClarificationOptions(
  candidates: AgentEvidenceCandidate[],
): NonNullable<IntentDecision["clarificationOptions"]> {
  const governed = candidates.filter(
    (candidate) =>
      candidate.compatibility !== "incompatible" &&
      (candidate.kind === "certified_block" ||
        candidate.kind === "semantic_metric" ||
        candidate.kind === "semantic_member"),
  );
  const pool = governed.length > 1
    ? governed
    : candidates.filter((candidate) => candidate.compatibility !== "incompatible");
  const chosen = pool.slice(0, 3);
  // Two candidates can legitimately share a display name (a dbt model and its
  // MetricFlow measure are both "customers"). Rendering both as "customers"
  // asks the user to choose between two identical-looking buttons, so the
  // duplicates carry their distinguishing identity.
  const nameCounts = new Map<string, number>();
  for (const candidate of chosen) {
    nameCounts.set(candidate.name, (nameCounts.get(candidate.name) ?? 0) + 1);
  }
  return chosen.map((candidate) => {
    const ambiguousName = (nameCounts.get(candidate.name) ?? 0) > 1;
    const description = humanizeCandidateDefinition(candidate.definition);
    return {
      id: candidate.id,
      label: ambiguousName
        ? `${candidate.name} (${candidateKindLabel(candidate.kind)})`
        : candidate.name,
      ...(description ? { description } : {}),
      kind: candidate.kind,
    };
  });
}

function candidateKindLabel(kind: string): string {
  if (kind === 'certified_block') return 'certified block';
  if (kind === 'semantic_metric') return 'metric';
  if (kind === 'semantic_member') return 'model field';
  return kind.replace(/[_-]+/g, ' ');
}

/**
 * A candidate's `definition` is sometimes the raw semantic-layer record —
 * `label: customers\naggregation: count_distinct\ntable: "..."\nexpr: customer_id`.
 * Dumping that into a question asks a business user to disambiguate by reading
 * YAML. Turn a recognisable key/value record into one plain sentence; leave
 * genuine authored prose alone.
 */
export function humanizeCandidateDefinition(definition: string | undefined): string | undefined {
  const text = definition?.trim();
  if (!text) return undefined;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fields = new Map<string, string>();
  for (const line of lines) {
    const match = /^([a-z_][a-z0-9_]*)\s*:\s*(.+)$/i.exec(line);
    if (match) fields.set(match[1]!.toLowerCase(), match[2]!.trim().replace(/^["']|["']$/g, ''));
  }
  // Only treat it as a record when MOST of it is key/value pairs; a one-line
  // sentence containing a colon is prose, not a dump.
  if (fields.size < 2 || fields.size < lines.length - 1) {
    return text.replace(/\s+/g, ' ').slice(0, 200);
  }
  const aggregation = fields.get('aggregation');
  const expr = fields.get('expr');
  const table = fields.get('table');
  const parts: string[] = [];
  if (aggregation) parts.push(`${aggregation.replace(/_/g, ' ')}${expr ? ` of ${expr}` : ''}`);
  else if (expr) parts.push(expr);
  if (table) parts.push(`from ${table.split('.').pop()?.replace(/"/g, '') ?? table}`);
  const summary = parts.join(' ');
  return summary ? `${summary}.` : undefined;
}

function buildEvidenceClarification(candidates: AgentEvidenceCandidate[], missing: string[] = []): string {
  const governedChoices = candidates.filter((candidate) =>
    candidate.compatibility !== "incompatible"
    && (candidate.kind === "certified_block" || candidate.kind === "semantic_metric" || candidate.kind === "semantic_member")
  );
  const choicePool = governedChoices.length > 1
    ? governedChoices
    : candidates.filter((candidate) => candidate.compatibility !== "incompatible");
  const choices = choicePool.slice(0, 3).map((candidate) => {
    const meaning = candidate.definition?.trim() || candidate.name;
    return `${candidate.name} — ${meaning}`;
  });
  if (choices.length > 1) return `Which meaning do you want: ${choices.join("; or ")}?`;
  if (missing.length > 0) return `I found relevant governed context, but need ${missing.join(" and ")}. What should I use?`;
  return "Which governed business meaning should I use for this question?";
}

/**
 * A distinct-entity count is not a useful ranking measure at the same entity
 * grain: every customer normally has a count of one. Keep the candidate in the
 * evidence trace, but do not let lexical relevance freeze it as the answer to
 * "top customers". This is deliberately a semantic suitability check, not a
 * name-based ban; an explicit "top customers by customer count" request remains
 * the user's choice and can proceed through normal compatibility checks.
 */
function isDegenerateRankingMetric(
  question: string,
  evidence: AgentRetrievalEvidence,
  candidate: AgentEvidenceCandidate,
): boolean {
  if (questionTypeFromText(question) !== 'ranking') return false;
  if (candidate.kind !== 'semantic_metric' && candidate.kind !== 'semantic_member') return false;
  const capability = normalizeEvidenceAnalyticalCapability(candidate).capability;
  const aggregation = normalizeMetricPhrase(candidate.aggregation ?? capability?.aggregation ?? '');
  if (!aggregation || !/^(count|count distinct|count unique|count distinct values)$/.test(aggregation)) return false;
  const questionTerms = new Set(substantiveLexicalTokens(question));
  const entityTerms = [
    candidate.primaryEntity ?? '',
    ...(candidate.analyticalCapability?.resultGrainIds ?? []),
    ...(candidate.dimensions ?? []),
    ...(evidence.parsedIntent?.dimensions ?? []),
  ].flatMap((value) => substantiveLexicalTokens(value));
  const metricTerms = [candidate.name, candidate.qualifiedId ?? '', ...(candidate.aliases ?? [])]
    .flatMap((value) => substantiveLexicalTokens(value));
  return entityTerms.some((term) => questionTerms.has(term))
    && metricTerms.some((term) => entityTerms.includes(term));
}

function hasExplicitRankingMeasure(
  question: string,
  evidence: AgentRetrievalEvidence,
): boolean {
  const parsed = [
    ...(evidence.parsedIntent?.measures ?? []),
    ...extractRankingMeasurePhrases(question),
  ].map(normalizeMetricPhrase).filter(Boolean);
  return parsed.length > 0;
}

function extractRankingMeasurePhrases(question: string): string[] {
  const matches: string[] = [];
  for (const pattern of [
    /\b(?:by|based on|using|with|for)\s+(?:the\s+)?([a-z][a-z0-9_. -]{1,80}?)(?=\s+(?:among|for each|per|in|where|during|over)|[?.!,]|$)/gi,
    /\b(?:highest|lowest|most|least)\s+([a-z][a-z0-9_. -]{1,80}?)(?=\s+(?:among|for each|per|in|where|during|over)|[?.!,]|$)/gi,
  ]) {
    for (const match of question.matchAll(pattern)) if (match[1]) matches.push(match[1]);
  }
  return matches;
}

function rankingMetricChoiceDecision(
  base: IntentDecision,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
  selected: AgentEvidenceCandidate,
  question: string,
): IntentDecision {
  const options = candidates
    .filter((candidate) =>
      candidate.id !== selected.id
      && candidate.compatibility !== 'incompatible'
      && candidate.kind === 'semantic_metric'
      && !isDegenerateRankingMetric(question, evidence, candidate),
    )
    .slice(0, 3);
  const labels = options.length > 0
    ? options.map((candidate) => renderCandidateChoice(candidate)).join(' or ')
    : 'revenue, order count, or another measure available in the model';
  return {
    ...base,
    action: 'clarify',
    confidence: 1,
    source: 'heuristic',
    category: 'unclear',
    depth: 'quick',
    followsUp: true,
    requiresClarification: true,
    reason: `${selected.name} counts customers; it cannot distinguish individual customers for a top-customer ranking.`,
    clarifyingQuestion: `That metric counts unique customers and cannot rank individual customers. Which measure should rank them: ${labels}?`,
    clarificationOptions: options.length > 0 ? buildClarificationOptions(options) : undefined,
    retrievalEvidence: retrievalTrace(evidence, candidates),
    resolvedAnalyticalPlan: undefined,
    meaningResolution: undefined,
  };
}

function preventDegenerateRankingResolution(
  resolution: MeaningResolution,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
  question: string,
): MeaningResolution {
  if (hasExplicitRankingMeasure(question, evidence)) return resolution;
  const selected = candidates.find((candidate) =>
    candidate.id === resolution.recommendedExecutionId
    || resolution.selectedConceptIds.includes(candidate.id),
  );
  if (!selected || !isDegenerateRankingMetric(question, evidence, selected)) return resolution;
  const alternatives = candidates
    .filter((candidate) =>
      candidate.id !== selected.id
      && candidate.kind === 'semantic_metric'
      && candidate.compatibility !== 'incompatible'
      && !isDegenerateRankingMetric(question, evidence, candidate),
    )
    .slice(0, 3);
  const alternativeLabels = alternatives.map(renderCandidateChoice).join(' or ');
  return {
    ...resolution,
    confidence: 'low',
    recommendedRoute: 'clarify',
    recommendedExecutionId: undefined,
    selectedConceptIds: [],
    analyticalFrame: undefined,
    missingInformation: [
      ...new Set([
        ...resolution.missingInformation,
        `${selected.name} counts the ranked entity and is not a suitable ranking measure`,
      ]),
    ],
    clarifyingQuestion: alternativeLabels
      ? `I found ${selected.name}, but it counts the ranked entity and cannot identify the top individual customers. Which measure should I use: ${alternativeLabels}?`
      : `I found ${selected.name}, but it counts the ranked entity and cannot identify the top individual customers. Which measure should I use for the ranking?`,
  };
}

function directResolution(
  request: AgentRunRequest,
  evidence: AgentRetrievalEvidence,
  candidate: AgentEvidenceCandidate,
  candidates: AgentEvidenceCandidate[],
): MeaningResolution {
  const inferredQuestionType = questionTypeFromText(request.question);
  const questionType = inferredQuestionType === 'definition'
    && candidate.kind === 'semantic_metric'
    && candidate.exactMatch
    && Boolean(normalizeEvidenceAnalyticalCapability(candidate).capability)
    && /^\s*what (?:is|was|were|are)\b/i.test(request.question)
    && !/\b(?:define|definition|meaning|mean)\b/i.test(request.question)
      ? 'value'
      : inferredQuestionType;
  const metricCandidates = explicitlyRequestedMetricCandidates(
    request.question,
    evidence,
    candidate,
    candidates,
  );
  const analyticalFrame = buildDeterministicAnalyticalFrame({
    question: request.question,
    questionType,
    evidence,
    metricCandidate: candidate,
    metricCandidates,
    candidates,
  });
  const queryIntent = defaultQueryIntent(evidence);
  const memberCandidates = candidates.filter((item) => {
    if (item.kind !== 'semantic_member' || item.compatibility === 'incompatible') return false;
    const identities = [item.name, ...(item.aliases ?? [])].map(normalizeMetricPhrase).filter(Boolean);
    return queryIntent.filters.some((filter) => identities.includes(normalizeMetricPhrase(filter.value)));
  });
  const canonicalFilters = queryIntent.filters.map((filter) => {
    const member = memberCandidates.find((item) =>
      [item.name, ...(item.aliases ?? [])]
        .map(normalizeMetricPhrase)
        .includes(normalizeMetricPhrase(filter.value)));
    return member ? { ...filter, value: member.name } : filter;
  });
  return {
    interpretedQuestion: request.question,
    questionType,
    selectedConceptIds: [...metricCandidates, ...memberCandidates].map((item) => item.id),
    recommendedExecutionId: candidate.id,
    queryIntent: { ...queryIntent, filters: canonicalFilters },
    rejectedCandidates: [],
    confidence: "high",
    missingInformation: [],
    recommendedRoute: routeForEvidenceCandidate(candidate),
    ...(analyticalFrame ? { analyticalFrame } : {}),
  };
}

function explicitlyRequestedMetricCandidates(
  question: string,
  evidence: AgentRetrievalEvidence,
  primary: AgentEvidenceCandidate,
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate[] {
  const requested = evidence.parsedIntent?.measures ?? [];
  const requestedTerms = [...new Set(
    requested.map(normalizeMetricPhrase).filter(Boolean),
  )];
  // A single business metric can be retrieved alongside technical dbt measure
  // shims and registry aliases that share its words. Those are execution
  // representations of the same request, not additional requested metrics.
  if (requestedTerms.length <= 1) return [primary];
  const primaryNames = [primary.name, ...(primary.aliases ?? [])]
    .map(normalizeMetricPhrase)
    .filter(Boolean);
  if (requestedTerms.every((term) => primaryNames.some((name) => metricTermsMatch(name, term)))) {
    return [primary];
  }
  const questionText = normalizeMetricPhrase(question);
  const metrics = candidates.filter((candidate) => {
    if (candidate.kind !== 'semantic_metric' || candidate.compatibility === 'incompatible') return false;
    if (!normalizeEvidenceAnalyticalCapability(candidate).capability) return false;
    if (candidate.id === primary.id) return true;
    const names = [candidate.name, ...(candidate.aliases ?? [])]
      .map(normalizeMetricPhrase)
      .filter(Boolean);
    return requestedTerms.some((term) => names.some((name) => metricTermsMatch(name, term)))
      || names.some((name) => name.length >= 3 && questionText.includes(name));
  });
  const ordered = [
    primary,
    ...metrics.filter((candidate) => candidate.id !== primary.id),
  ];
  return ordered.filter((candidate, index, all) =>
    all.findIndex((other) => other.id === candidate.id) === index);
}

function normalizeMetricPhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/%/g, ' percentage ')
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function metricTermsMatch(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right || left.endsWith(` ${right}`) || right.endsWith(` ${left}`)) return true;
  const leftTokens = new Set(left.split(' '));
  const rightTokens = right.split(' ').filter((token) => token.length >= 3);
  return rightTokens.length > 0 && rightTokens.every((token) => leftTokens.has(token));
}

function missingExplicitMetricTerms(
  requested: string[],
  candidates: AgentEvidenceCandidate[],
): string[] {
  const metricTerms = candidates
    .filter((candidate) =>
      candidate.kind === 'semantic_metric'
      && candidate.compatibility !== 'incompatible'
      && Boolean(normalizeEvidenceAnalyticalCapability(candidate).capability))
    .map((candidate) =>
      [candidate.name, ...(candidate.aliases ?? [])]
        .map(normalizeMetricPhrase)
        .filter(Boolean));
  return [...new Set(requested.map(normalizeMetricPhrase).filter(Boolean))]
    .filter((term) => !metricTerms.some((names) =>
      names.some((name) => metricTermsMatch(name, term))));
}

function exactMultiMetricPrimary(
  question: string,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate | undefined {
  if ((evidence.parsedIntent?.measures?.length ?? 0) < 2) return undefined;
  const primary = candidates.find((candidate) =>
    candidate.kind === 'semantic_metric'
    && candidate.exactMatch
    && candidate.compatibility !== 'incompatible'
    && Boolean(normalizeEvidenceAnalyticalCapability(candidate).capability));
  if (!primary) return undefined;
  const requested = explicitlyRequestedMetricCandidates(question, evidence, primary, candidates);
  return requested.length >= 2
    && requested.every((candidate) => candidate.exactMatch)
    ? primary
    : undefined;
}

function routeWithoutMeaningModel(
  request: AgentRunRequest,
  base: IntentDecision,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
  planMode: ResolvedAnalyticalPlan['mode'] = 'authoritative',
  /**
   * Whether DQL may commit to the best-ranked reading on the user's behalf.
   *
   * False when the meaning resolver never got to run (provider outage). Two
   * genuinely different metrics that merely share an alias — `booked_revenue`
   * and `billed_revenue` both aliased "revenue" — must not be settled by
   * lexical rank alone with the semantic judgment switched off. AGT-017.
   */
  mayAssumeInterpretation = true,
): IntentDecision {
  const multiMetricPrimary = exactMultiMetricPrimary(request.question, evidence, candidates);
  if (multiMetricPrimary) {
    return routeDecisionForResolution(
      base,
      evidence,
      candidates,
      directResolution(request, evidence, multiMetricPrimary, candidates),
      "heuristic",
      request.question,
      planMode,
    );
  }
  const rankingCandidates = hasExplicitRankingMeasure(request.question, evidence)
    ? candidates
    : candidates.filter((candidate) => !isDegenerateRankingMetric(request.question, evidence, candidate));
  if (questionTypeFromText(request.question) === 'ranking'
    && !hasExplicitRankingMeasure(request.question, evidence)) {
    return bareRankingClarification(
      base,
      retrievalTrace(evidence, candidates),
      request.question,
      evidence,
      rankingCandidates,
    );
  }
  const exactCompatible = candidates.filter(
    (candidate) =>
      candidate.exactMatch
      && candidate.compatibility !== "incompatible"
      && rankingCandidates.includes(candidate),
  );
  if (
    exactCompatible.length === 1 &&
    !hasMateriallyRelatedCompetitor(exactCompatible[0], candidates)
  ) {
    return routeDecisionForResolution(
      base,
      evidence,
      candidates,
      directResolution(request, evidence, exactCompatible[0], candidates),
      "heuristic",
      request.question,
      planMode,
    );
  }
  const semanticMetric = uniqueExecutableSemanticMetric(evidence, rankingCandidates);
  if (semanticMetric) {
    return routeDecisionForResolution(
      base,
      evidence,
      candidates,
      directResolution(request, evidence, semanticMetric, candidates),
      "heuristic",
      request.question,
      planMode,
    );
  }
  // Last resort before asking the user: commit to the best governed reading.
  // Clarifying whenever retrieval returned more than one candidate meant a
  // `type: simple` metric, the measure it wraps, and the model that holds them
  // were offered as three competing "meanings" of the same number.
  const best = mayAssumeInterpretation
    ? bestGovernedInterpretation(request.question, rankingCandidates)
    : undefined;
  if (best) {
    return routeDecisionForResolution(
      base,
      evidence,
      candidates,
      directResolution(request, evidence, best, candidates),
      "heuristic",
      request.question,
      planMode,
    );
  }
  return unresolvedAnalyticalPlanDecision(base, evidence, candidates, request.question);
}

/** Leaf identity of a governed candidate, ignoring its source qualification. */
function candidateLeafName(candidate: AgentEvidenceCandidate): string {
  const identity = candidate.qualifiedId ?? candidate.id;
  return (identity.split(/[.:]/).at(-1) ?? candidate.name).trim().toLowerCase();
}

/** Prefer the most authoritative representative of one underlying meaning. */
function governedObjectAuthority(candidate: AgentEvidenceCandidate): number {
  if (candidate.semanticObjectType === 'metric') return 3;
  if (candidate.semanticObjectType === 'measure') return 2;
  if (candidate.semanticObjectType === 'model') return 1;
  return 0;
}

/**
 * Reduce retrieval output to genuinely DIFFERENT governed meanings.
 *
 * Two collapses, both provable from the semantic registry rather than guessed:
 *  - A simple metric, the measure it wraps, and the model that holds them are
 *    one meaning. Offering all three asks a person to choose between a thing
 *    and its own wrapper.
 *  - An entity is a join key, not an answer. When the question asks for an
 *    attribute ("customer names") and a dimension matched, entities are not
 *    candidate readings of it at all.
 */
export function collapseRedundantGovernedCandidates(
  question: string,
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate[] {
  const byScore = [...new Map(
    candidates
      .filter((candidate) => candidate.eligible !== false && candidate.compatibility !== 'incompatible')
      .map((candidate) => [candidate.id, candidate] as const),
  ).values()].sort((left, right) =>
    right.relevanceScore - left.relevanceScore || left.id.localeCompare(right.id));

  const wantsAttribute = /\b(names?|labels?|titles?|descriptions?)\b/i.test(question);
  const hasDimension = byScore.some((candidate) => candidate.semanticObjectType === 'dimension');
  const kindFiltered = wantsAttribute && hasDimension
    ? byScore.filter((candidate) => candidate.semanticObjectType !== 'entity')
    : byScore;

  const representatives = new Map<string, AgentEvidenceCandidate>();
  const passthrough: AgentEvidenceCandidate[] = [];
  for (const candidate of kindFiltered) {
    const type = candidate.semanticObjectType;
    if (type !== 'metric' && type !== 'measure' && type !== 'model') {
      passthrough.push(candidate);
      continue;
    }
    const key = `${(candidate.semanticModel ?? '').toLowerCase()}::${candidateLeafName(candidate)}`;
    const current = representatives.get(key);
    if (!current || governedObjectAuthority(candidate) > governedObjectAuthority(current)) {
      representatives.set(key, candidate);
    }
  }
  // A certified block that already OUTPUTS an attribute is not a competing
  // MEANING of that attribute — it is the same reading at higher authority.
  // Keeping both turned an ordinary attribute lookup ("what customer type is
  // <member>?") into a "Which governed meaning should DQL bind: customer_profile
  // or customers.customer_type?" interrogation, even though the block declares
  // that exact output, sits at the requested grain, and permits the member
  // filter. The cascade already says certified outranks semantic for one
  // reading; this stops the tie from being mistaken for ambiguity.
  const certifiedCoverage = passthrough
    .filter((candidate) => candidate.kind === 'certified_block')
    .map((candidate) => new Set([
      ...(candidate.dimensions ?? []),
      ...(candidate.compatibilityFacts ?? [])
        .filter((fact) => fact.startsWith('output: '))
        .map((fact) => fact.slice('output: '.length)),
    ].map((value) => normalizeMetricPhrase(String(value).split(/[.:/]/).at(-1) ?? ''))
      .filter(Boolean)));
  const survivingPassthrough = certifiedCoverage.length === 0
    ? passthrough
    : passthrough.filter((candidate) => {
      // The same field can arrive three ways — the block's declared output, the
      // semantic dimension, and the raw warehouse/dbt column. Only the first is
      // a governed meaning; the other two are lower-trust representations of it.
      const supersedable = candidate.semanticObjectType === 'dimension'
        || candidate.kind === 'sql_column';
      if (!supersedable) return true;
      // A column's qualified identity points at its PARENT RELATION, so
      // `candidateLeafName` yields "customers" for `customers.customer_type`.
      // Match the candidate's own name as well, or a raw column is never
      // recognised as the field a block already publishes.
      const leaves = [
        normalizeMetricPhrase(String(candidate.name ?? '').split(/[.:/]/).at(-1) ?? ''),
        normalizeMetricPhrase(candidateLeafName(candidate)),
      ].filter(Boolean);
      return !leaves.some((leaf) => certifiedCoverage.some((outputs) => outputs.has(leaf)));
    });

  return [...survivingPassthrough, ...representatives.values()].sort((left, right) =>
    right.relevanceScore - left.relevanceScore || left.id.localeCompare(right.id));
}

/**
 * The governed meaning to run when nothing proved a single exact reading.
 *
 * DQL commits to the best-ranked interpretation and discloses it through the
 * route label, instead of stopping to ask. Asking on every multi-candidate
 * question made ordinary lookups feel like an interrogation, and most of those
 * questions had no real ambiguity behind them.
 */
export function bestGovernedInterpretation(
  question: string,
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate | undefined {
  // Take the best candidate that is actually executable, rather than refusing
  // because the top-ranked hit happens to be a descriptive modeling entity.
  // `compatibility: 'unknown'` is common for governed objects that execute
  // perfectly well, so it does not disqualify — but 'partial' does. A partial
  // match has already been proven NOT to cover the request, and running one
  // silently answers a different question than the one that was asked.
  return collapseRedundantGovernedCandidates(question, candidates).find((candidate) =>
    candidate.compatibility !== 'partial'
    && (candidate.kind === 'certified_block'
      || candidate.kind === 'semantic_metric'
      || candidate.kind === 'semantic_member'));
}

/**
 * Retrieval may nominate qualified candidates, but only the resolved plan may
 * authorize analytical execution. If bounded meaning cannot freeze one exact
 * tuple, retain stable candidate identities for a focused continuation or emit
 * a typed modeling gap. Never hand those candidates to the legacy answer loop
 * as another meaning/planning authority.
 */
function unresolvedAnalyticalPlanDecision(
  base: IntentDecision,
  evidence?: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[] = [],
  question = '',
): IntentDecision {
  // Ask only about meanings that genuinely differ. A metric, the measure it
  // wraps, and their model are one reading, and a join key is not a reading of
  // an attribute question at all.
  const eligible = collapseRedundantGovernedCandidates(question, candidates);
  const trace = evidence ? retrievalTrace(evidence, candidates) : {
    candidateCount: 0,
    candidateIds: [],
  };
  if (eligible.length > 1) {
    const choices = eligible.slice(0, 3);
    return {
      ...base,
      action: 'clarify',
      confidence: 1,
      source: 'heuristic',
      category: 'unclear',
      depth: 'quick',
      reason: 'Bounded retrieval found multiple governed meanings, so no analytical plan was frozen.',
      requiresClarification: true,
      clarifyingQuestion: `Which governed meaning should DQL bind: ${choices.map(renderCandidateChoice).join(' or ')}?`,
      clarificationOptions: buildClarificationOptions(choices),
      retrievalEvidence: trace,
      resolvedAnalyticalPlan: undefined,
      meaningResolution: undefined,
    };
  }

  const candidateIds = eligible.map((candidate) => candidate.qualifiedId ?? candidate.id);
  const message = candidateIds.length === 1
    ? `The retrieved governed candidate ${candidateIds[0]} did not prove the complete requested metric, grain, filters, ordering, and outputs. Model the missing capability before retrying.`
    : 'No governed candidate proved the complete requested metric, grain, filters, ordering, and outputs. Model the missing capability or choose a governed identifier before retrying.';
  return {
    ...base,
    action: 'block',
    confidence: 1,
    source: 'heuristic',
    category: base.action === 'investigate' ? 'data_analysis' : 'data_lookup',
    depth: 'quick',
    reason: message,
    requiresClarification: false,
    retrievalEvidence: trace,
    terminalOutcome: {
      kind: 'modeling_gap',
      code: 'ANALYTICAL_MODELING_GAP',
      message,
      candidateIds,
    },
    resolvedAnalyticalPlan: undefined,
    meaningResolution: undefined,
  };
}

/**
 * Deterministic business questions that must be settled before meaning/model
 * orchestration.  These are not proof failures: no immutable analytical plan
 * exists yet, so the only valid outcome is one concise clarification.
 */
function deterministicPrePlanClarification(
  request: AgentRunRequest,
  base: IntentDecision,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
): IntentDecision | undefined {
  const asksForRanking = questionTypeFromText(request.question) === 'ranking';
  const requestedMeasures = (evidence.parsedIntent?.measures ?? [])
    .map(normalizeMetricPhrase)
    .filter(Boolean);
  const hasExplicitRankingMetric = requestedMeasures.length > 0
    && requestedMeasures.every((requested) =>
      candidates.some((candidate) => candidateProvesMetricTerm(candidate, requested)))
    || hasStrongQualifiedMetricEvidence(candidates)
    || hasQuestionQualifiedMetricEvidence(request.question, evidence, candidates);
  const retrievalEvidence = retrievalTrace(evidence, candidates);

  const requestedDimensions = uniqueNormalizedTerms(evidence.parsedIntent?.dimensions ?? []);
  const modeledFilterFields = new Set(
    (evidence.parsedIntent?.filters ?? []).flatMap((filter) =>
      candidates.some((candidate) =>
        isCompatibleQualifiedMember(candidate)
        && candidateIdentityTerms(candidate).some((term) =>
          metricTermsMatch(term, normalizeMetricPhrase(filter.value))))
        ? [normalizeMetricPhrase(filter.field)]
        : []),
  );
  const missingDimensions = requestedDimensions.filter((requested) =>
    !modeledFilterFields.has(requested)
    && !candidates.some((candidate) => candidateProvesDimensionTerm(candidate, requested)));

  if (missingDimensions.length > 0) {
    const filterValues = (evidence.parsedIntent?.filters ?? []).map((filter) =>
      normalizeMetricPhrase(filter.value));
    const alternatives = candidates
      .filter(isCompatibleQualifiedMember)
      .filter((candidate) => candidateIsDeclaredDimensionAlternative(candidate, missingDimensions))
      .filter((candidate) => !candidateIdentityTerms(candidate).some((term) =>
        requestedDimensions.some((requested) => metricTermsMatch(term, requested))
        || filterValues.some((value) => metricTermsMatch(term, value))))
      .sort((left, right) =>
        right.relevanceScore - left.relevanceScore || left.id.localeCompare(right.id))
      .slice(0, 3);
    if (alternatives.length === 0) {
      if (!asksForRanking || hasExplicitRankingMetric) return undefined;
      return bareRankingClarification(base, retrievalEvidence, request.question, evidence, candidates);
    }
    const requestedLabel = missingDimensions.map((term) => `“${term}”`).join(' and ');
    const alternativeLabels = alternatives.map(renderCandidateChoice);
    return {
      ...base,
      action: 'clarify',
      confidence: 1,
      reason: `The requested dimension ${requestedLabel} is absent from the retrieved qualified evidence, so no analytical plan was frozen.`,
      source: 'heuristic',
      category: 'unclear',
      depth: 'quick',
      requiresClarification: true,
      clarifyingQuestion: alternativeLabels.length > 0
        ? `${requestedLabel} is not modeled. Should I use ${alternativeLabels.join(' or ')} instead?`
        : `${requestedLabel} is not modeled. Which governed dimension should I use instead?`,
      retrievalEvidence,
      ...(alternatives.length > 0 ? { clarificationOptions: buildClarificationOptions(alternatives) } : {}),
      resolvedAnalyticalPlan: undefined,
      meaningResolution: undefined,
    };
  }

  if (asksForRanking && !hasExplicitRankingMetric) {
    return bareRankingClarification(base, retrievalEvidence, request.question, evidence, candidates);
  }
  return undefined;
}

/**
 * "Top by which governed metric?" with NO choices is a dead end: the asker
 * cannot know which measures are both governed and valid at the ranked grain,
 * so the only move left is to guess. A built-CLI run on the commerce fixture
 * ended here with zero options while `revenue`, `lifetime_spend_pretax`, and
 * `orders` were all modeled.
 *
 * The question stays exactly as it was — this only attaches the compatible
 * ranking measures as selectable choices, minus any same-grain entity count,
 * which is degenerate for ranking individuals. Selecting one returns an
 * explicit qualified id, which takes the resolved-selection path instead of
 * asking again.
 *
 * Acceptance: AGT-030.
 */
function bareRankingClarification(
  base: IntentDecision,
  retrievalEvidence: NonNullable<IntentDecision['retrievalEvidence']>,
  question?: string,
  evidence?: AgentRetrievalEvidence,
  candidates?: AgentEvidenceCandidate[],
): IntentDecision {
  const rankingChoices = (candidates ?? []).filter((candidate) => {
    if (candidate.compatibility === 'incompatible') return false;
    if (candidate.kind !== 'certified_block'
      && candidate.kind !== 'semantic_metric'
      && candidate.kind !== 'semantic_member') return false;
    // Check BOTH identities: `qualifiedId` is often the bare semantic-layer
    // name, so testing it alone let `semantic:model:customers` through.
    const identities = [candidate.id, candidate.qualifiedId ?? ''].filter(Boolean);
    // A model, entity, dimension, dbt node, or warehouse table cannot BE the
    // measure a ranking is ordered by; offering one as a "governed metric" is
    // how `semantic:model:customers` reached the choice list.
    if (identities.some((identity) =>
      /^(semantic:(model|entity|dimension|time_dimension):|dbt:|warehouse:)/i.test(identity))) return false;
    // `semantic:measure:X.X` is a count of X reported at X's own grain — every
    // row scores 1, so it can never order X. The metadata-driven guard below
    // needs a declared aggregation, which retrieval does not always carry, so
    // this identity check catches the case that metadata misses.
    const degenerateIdentity = identities.some((identity) => {
      const measurePath = /^semantic:(?:measure|metric):(.+)$/i.exec(identity)?.[1] ?? '';
      const [owner, measureName] = measurePath.split('.');
      return Boolean(owner && measureName
        && normalizeMetricPhrase(owner) === normalizeMetricPhrase(measureName));
    });
    if (degenerateIdentity) return false;
    if (question && evidence && isDegenerateRankingMetric(question, evidence, candidate)) return false;
    return true;
  });
  return {
    ...base,
    action: 'clarify',
    confidence: 1,
    reason: 'A ranking needs a positively identified governed metric before an execution capability can be selected.',
    source: 'heuristic',
    category: 'unclear',
    depth: 'quick',
    requiresClarification: true,
    clarifyingQuestion: 'Top by which governed metric?',
    retrievalEvidence,
    ...(rankingChoices.length > 0
      ? { clarificationOptions: buildClarificationOptions(rankingChoices) }
      : {}),
    resolvedAnalyticalPlan: undefined,
    meaningResolution: undefined,
  };
}

function uniqueNormalizedTerms(values: string[]): string[] {
  return [...new Set(values.map(normalizeMetricPhrase).filter(Boolean))];
}

function isCompatibleQualifiedMember(candidate: AgentEvidenceCandidate): boolean {
  return candidate.kind === 'semantic_member'
    && candidate.compatibility !== 'incompatible'
    && Boolean(candidate.qualifiedId ?? candidate.id);
}

function candidateIdentityTerms(candidate: AgentEvidenceCandidate): string[] {
  return uniqueNormalizedTerms([
    candidate.id,
    candidate.qualifiedId ?? '',
    candidate.name,
    ...(candidate.aliases ?? []),
    ...(candidate.dimensions ?? []),
  ]);
}

function candidateProvesDimensionTerm(candidate: AgentEvidenceCandidate, requested: string): boolean {
  if (candidate.compatibility === 'incompatible') return false;
  if (
    candidate.kind === 'semantic_member'
    && candidateIdentityTerms(candidate).some((term) => metricTermsMatch(term, requested))
  ) return true;
  const normalized = normalizeEvidenceAnalyticalCapability(candidate);
  return normalized.status === 'complete'
    && Boolean(normalized.capability?.dimensions.some((dimension) =>
      metricTermsMatch(normalizeMetricPhrase(dimension.dimensionId), requested)));
}

function candidateProvesMetricTerm(candidate: AgentEvidenceCandidate, requested: string): boolean {
  if (candidate.compatibility === 'incompatible') return false;
  if (candidate.kind === 'certified_block') {
    return candidate.compatibility === 'compatible';
  }
  if (candidate.kind !== 'semantic_metric') return false;
  const stableIdentity = candidate.qualifiedId ?? candidate.id;
  if (!stableIdentity) return false;
  return [candidate.name, ...(candidate.aliases ?? [])]
    .map(normalizeMetricPhrase)
    .some((term) => metricTermsMatch(term, requested));
}

function candidateIsDeclaredDimensionAlternative(
  candidate: AgentEvidenceCandidate,
  missingDimensions: string[],
): boolean {
  const facts = candidate.compatibilityFacts?.map(normalizeMetricPhrase) ?? [];
  return missingDimensions.some((requested) =>
    facts.includes(`alternative for ${requested}`)
    || facts.includes(`dimension alternative for ${requested}`));
}

/**
 * A missing optional parsed-intent projection must not erase positive metric
 * evidence already retrieved for the question. Only complete, compatible,
 * qualified semantic metrics with an exact/explicit match reason can bypass
 * the bare-ranking clarification; mere catalog presence is insufficient.
 */
function hasStrongQualifiedMetricEvidence(candidates: AgentEvidenceCandidate[]): boolean {
  return candidates.some((candidate) => {
    if (candidate.kind !== 'semantic_metric' || candidate.compatibility === 'incompatible') return false;
    if (!candidate.qualifiedId || !normalizeEvidenceAnalyticalCapability(candidate).capability) return false;
    if (candidate.exactMatch) return true;
    return candidate.matchReasons.some((reason) => {
      const normalized = normalizeMetricPhrase(reason);
      return /\b(?:exact|explicit)\b/.test(normalized)
        && /\b(?:metric|measure|meaning|name|alias)\b/.test(normalized);
    });
  });
}

function hasQuestionQualifiedMetricEvidence(
  question: string,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
): boolean {
  const questionTokens = new Set(substantiveLexicalTokens(question));
  const dimensionTokens = new Set(substantiveLexicalTokens(
    (evidence.parsedIntent?.dimensions ?? []).join(' '),
  ));
  return candidates.some((candidate) => {
    if (candidate.kind !== 'semantic_metric' || candidate.compatibility === 'incompatible') return false;
    const normalized = normalizeEvidenceAnalyticalCapability(candidate);
    if (normalized.status !== 'complete' || !candidate.qualifiedId) return false;
    return metricLexicalVariants(candidate).some((variant) => {
      const metricTokens = [...new Set(
        substantiveLexicalTokens(variant)
          .filter((token) => !dimensionTokens.has(token)),
      )];
      if (metricTokens.length === 0) return false;
      const matched = metricTokens.filter((token) => questionTokens.has(token)).length;
      return metricTokens.length === 1
        ? matched === 1
        : matched >= 2 && matched / metricTokens.length >= 0.5;
    });
  });
}

/**
 * Compare both authored identities and their canonical local names. Generated
 * semantic-model namespaces remain available as authored evidence, but cannot
 * dilute the leaf metric phrase that users naturally ask for.
 */
function metricLexicalVariants(candidate: AgentEvidenceCandidate): string[] {
  const authored = [
    candidate.name,
    ...(candidate.aliases ?? []),
    ...(candidate.qualifiedId ? [candidate.qualifiedId] : []),
  ].filter(Boolean);
  return [...new Set(authored.flatMap((value) => {
    const local = value.split(/[.:/]/).filter(Boolean).at(-1);
    return local && local !== value ? [value, local] : [value];
  }))];
}

const NON_SUBSTANTIVE_RANKING_TOKENS = new Set([
  'a', 'an', 'and', 'are', 'at', 'best', 'bottom', 'by', 'count', 'for',
  'from', 'give', 'has', 'have', 'highest', 'in', 'is', 'least', 'list',
  'lowest', 'me', 'measure', 'metric', 'most', 'number', 'of', 'on', 'or',
  'per', 'rank', 'ranked', 'ranking', 'show', 'that', 'the', 'this', 'to',
  'top', 'total', 'value', 'what', 'which', 'who', 'with', 'without', 'worst',
  'amount',
]);

function substantiveLexicalTokens(value: string): string[] {
  return normalizeMetricPhrase(value)
    .split(' ')
    .filter((token) => token.length >= 2 && !NON_SUBSTANTIVE_RANKING_TOKENS.has(token));
}

function renderCandidateChoice(candidate: AgentEvidenceCandidate): string {
  const identity = candidate.qualifiedId ?? candidate.id;
  const stableName = identity.split(/[.:]/).at(-1) ?? candidate.name;
  // Never paste a raw semantic-layer record into the question a person reads.
  const description = humanizeCandidateDefinition(candidate.definition);
  const grain = candidate.primaryEntity?.trim();
  const kind = candidateKindLabel(candidate.kind);
  const detail = [description, grain ? `grain: ${grain}` : ''].filter(Boolean).join('; ');
  return detail
    ? `${candidate.name} — ${kind}, ${detail}`
    : `${candidate.name} — ${kind} (${stableName})`;
}

/**
 * AGT-017 / AGT-018 / PERF-002 — provider failure must not send an otherwise
 * unambiguous semantic question back through the legacy answer cascade. A dbt
 * semantic snapshot can expose one authored metric alongside three technical
 * representations of the same calculation: its backing measure, a
 * measure-derived metric execution shim, and a canonical registry alias. Only
 * complete authored metric capabilities count as business meanings here.
 *
 * This is a fallback, not a general lexical winner: all surviving authored
 * metrics must normalize to one stable metric identity, be compatible with the
 * requested tuple, and match the planner's requested measure terms. Two real
 * metrics therefore remain ambiguous and continue to clarification/resolution.
 */
function uniqueExecutableSemanticMetric(
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate | undefined {
  const requestedTokens = metricTokens(evidence.parsedIntent?.measures ?? []);
  if (requestedTokens.size === 0) return undefined;
  const byMetricId = new Map<string, AgentEvidenceCandidate>();
  for (const candidate of candidates) {
    if (candidate.kind !== "semantic_metric" || candidate.compatibility !== "compatible") continue;
    if (/\bdbt\s+measure\b/i.test(candidate.provenance ?? "")) continue;
    const normalized = normalizeEvidenceAnalyticalCapability(candidate);
    if (normalized.status !== "complete" || !normalized.capability) continue;
    const candidateTokens = metricTokens([
      candidate.name,
      ...(candidate.aliases ?? []),
      normalized.capability.metricId,
    ]);
    if (![...requestedTokens].some((token) => candidateTokens.has(token))) continue;
    const current = byMetricId.get(normalized.capability.metricId);
    if (!current || candidate.relevanceScore > current.relevanceScore) {
      byMetricId.set(normalized.capability.metricId, candidate);
    }
  }
  return byMetricId.size === 1 ? [...byMetricId.values()][0] : undefined;
}

function metricTokens(values: string[]): Set<string> {
  const ignored = new Set([
    "a", "an", "and", "as", "at", "by", "current", "for", "from", "is",
    "last", "measure", "metric", "of", "on", "show", "the", "this", "today",
    "top", "total", "value", "what", "year",
  ]);
  return new Set(
    values
      .join(" ")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 2 && !ignored.has(token)),
  );
}

function hasMateriallyRelatedCompetitor(
  exact: AgentEvidenceCandidate,
  candidates: AgentEvidenceCandidate[],
): boolean {
  const floor = Math.max(0.55, exact.relevanceScore - 0.2);
  return candidates.some((candidate) =>
    candidate.id !== exact.id
    && candidate.compatibility !== "incompatible"
    && candidate.relevanceScore >= floor
    // A dimension/member card can help bind the selected metric's tuple, but
    // it is not a competing business metric meaning. Treating it as one sends
    // an exact metric plus its own dimension candidates back to the resolver.
    && (exact.kind !== 'semantic_metric'
      || candidate.kind === 'semantic_metric'
      || candidate.kind === 'certified_block')
  );
}

/**
 * Skip the meaning-model call only when host-owned fit checks have already
 * proven one strongly relevant governed execution path and no other executable
 * governed meaning is close. Partial/raw context never forces a clarification
 * against a uniquely compatible certified block; a second compatible block or
 * metric still goes to the bounded AI resolver.
 */
function dominantCompatibleGovernedCandidate(
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate | undefined {
  const compatible = candidates.filter((candidate) =>
    candidate.compatibility === "compatible"
    && (candidate.kind === "certified_block" || candidate.kind === "semantic_metric" || candidate.kind === "semantic_member")
  );
  if (compatible.length === 0) return undefined;
  const best = compatible[0];
  // Similar semantic metric names are exactly where the tiny evidence resolver
  // adds value. This zero-call shortcut is reserved for an executable certified
  // block whose complete output/filter/grain contract has already passed.
  if (best.kind !== "certified_block") return undefined;
  if (best.relevanceScore < 0.82) return undefined;
  // Deterministic fit proves executability, not business meaning. Preserve the
  // one bounded meaning call whenever a plausible semantic interpretation is
  // present, even if the certified block won lexical ranking.
  if (candidates.some((candidate) =>
    (candidate.kind === 'semantic_metric' || candidate.kind === 'semantic_member')
    && candidate.compatibility !== 'incompatible'
    && candidate.relevanceScore >= 0.45)) return undefined;
  const competitorFloor = Math.max(0.7, best.relevanceScore - 0.12);
  const hasExecutableCompetitor = compatible.some((candidate) =>
    candidate.id !== best.id && candidate.relevanceScore >= competitorFloor
  );
  return hasExecutableCompetitor ? undefined : best;
}

function authoritativeExactCertifiedExample(
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate | undefined {
  const exact = candidates.filter((candidate) =>
    candidate.kind === 'certified_block'
    && candidate.exactMatch
    && candidate.compatibility === 'compatible'
    && candidate.analyticalFitClass === 'exact');
  return exact.length === 1 ? exact[0] : undefined;
}

function shouldDeferCompositionalFollowUpToExecutor(
  base: IntentDecision,
  candidates: AgentEvidenceCandidate[],
): boolean {
  if (!base.followsUp) return false;
  const executableKinds = new Set<AgentEvidenceCandidate['kind']>([
    'certified_block',
    'semantic_metric',
    'semantic_member',
    'dql_modeling',
    'dbt_model',
    'dbt_source',
    'sql_table',
    'sql_column',
  ]);
  const relevant = candidates.filter((candidate) =>
    candidate.compatibility !== 'incompatible' && executableKinds.has(candidate.kind));
  if (relevant.length === 0) return false;
  // If a complete governed executor exists, similar names still deserve the tiny
  // meaning resolver. When every candidate is only partial, however, the turn is
  // necessarily a composition. A separate resolver cannot authorize execution;
  // it only duplicates the SQL agent's evidence decision and adds a full provider
  // round trip. Let the single bounded executor select and compose from the same
  // ranked cards plus the typed prior-result carrier.
  return !relevant.some((candidate) => candidate.compatibility === 'compatible');
}

function rethrowCancellation(error: unknown, ...signals: Array<AbortSignal | undefined>): void {
  for (const signal of signals) {
    if (signal?.aborted) throw signal.reason ?? error;
  }
  if (error instanceof Error && error.name === "AbortError") throw error;
}

/**
 * Build a retrieval-first hybrid router. Narrow conversational/app preflight is
 * deterministic. Every other turn loads structured evidence before any
 * general-knowledge classification, then uses at most one bounded meaning call.
 * The legacy string catalog path remains supported for hosts during migration.
 */
export function createHybridRouter(options: HybridRouterOptions = {}): AgentRouter {
  const threshold = options.llmThreshold ?? DEFAULT_THRESHOLD;
  const cacheSize = options.cacheSize ?? DEFAULT_CACHE_SIZE;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const requireMeaningCall = options.requireMeaningCallForNaturalLanguage ?? true;
  const cache = new Map<string, CacheEntry>();
  let tick = 0;
  const now = options.now ?? (() => { tick += 1; return tick; });

  const remember = (key: string, decision: IntentDecision): IntentDecision => {
    cache.set(key, { decision, at: now() });
    if (cache.size > cacheSize) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return decision;
  };

  const deterministic = (request: AgentRunRequest): IntentDecision => {
    const history = effectiveConversationHistory(request);
    const conversationalKind = classifyConversationalTurn(request.question, history.length > 0);
    return decideAgentAction({
      question: request.question,
      intent: request.intent ?? (conversationalKind ? "clarify" : "ad_hoc_ranking"),
      signals: request.signals,
      history,
    });
  };

  return {
    async decide(request: AgentRunRequest): Promise<IntentDecision> {
      const base = deterministic(request);

      // The only pre-retrieval exits are deliberately narrow and unambiguously
      // non-analytical. App composition has its own catalog-grounded workflow.
      if (base.action === "converse" || base.action === "compose_app") {
        return { ...base, source: base.source ?? "heuristic" };
      }

      const initialDiscoveryRoute = discoveryRouteBeforeRetrieval(request, base);
      if (request.runBudget && !request.runBudget.mayStartDiscovery(initialDiscoveryRoute)) {
        return softBoundaryDecision(request, base, initialDiscoveryRoute);
      }

      let evidence: AgentRetrievalEvidence | undefined;
      if (options.getEvidence) {
        try {
          evidence = await options.getEvidence(request);
        } catch (error) {
          rethrowCancellation(error, request.signal, options.signal);
          // Retrieval failure must not prevent the existing fallback path. The
          // answer executor can still return a specific index/configuration error.
        }
      }

      if (evidence) {
        evidence = {
          ...evidence,
          candidates: canonicalizeMetricMeasureCandidates(evidence.candidates),
          ...(evidence.clarificationCandidates
            ? { clarificationCandidates: canonicalizeMetricMeasureCandidates([
                ...evidence.candidates,
                ...evidence.clarificationCandidates,
              ]).filter((candidate) => evidence!.clarificationCandidates!.some((item) => item.id === candidate.id)) }
            : {}),
        };
        let candidates = buildMeaningEvidencePackage(evidence, options.maxMeaningCandidates ?? 12);
        // A structured clarification selection is authoritative identity input,
        // not a new fuzzy-search phrase. Keep it in the bounded package even if
        // per-tier limits would otherwise trim it from a large catalog.
        const selectedEvidence = request.selectedEvidenceId
          ? evidence.candidates.find((candidate) => candidate.id === request.selectedEvidenceId && candidate.eligible !== false)
          : undefined;
        if (selectedEvidence && !candidates.some((candidate) => candidate.id === selectedEvidence.id)) {
          candidates = [selectedEvidence, ...candidates.filter((candidate) => candidate.id !== selectedEvidence.id)]
            .slice(0, options.maxMeaningCandidates ?? 12);
        }
        if (candidates.length > 0) {
          // Clarification is local and never provider-bound, so it can inspect the
          // complete already-retrieved set. Keep the smaller package below for
          // any later meaning call.
          const clarificationCandidates = [
            ...evidence.candidates,
            ...(evidence.clarificationCandidates ?? []),
          ].filter((candidate, index, all) =>
            candidate.eligible !== false && all.findIndex((other) => other.id === candidate.id) === index);
          const explicit = selectedEvidence ?? findExplicitEvidenceReference(request.question, candidates);
          const explicitMeaningBinding = Boolean(explicit && (
            request.selectedEvidenceId
            || /@(metric|block|model|table|column)\(/i.test(request.question)
          ));
          const shouldUseMeaningCall = requireMeaningCall
            && !explicitMeaningBinding
            && Boolean(options.resolveMeaning || options.complete);

          // A normal natural-language turn must be interpreted against the
          // candidate cards before a deterministic clarification is allowed.
          // Running this gate first was the source of the "Top by which
          // governed metric?" repeat loop: it treated a customer-count
          // execution shim as the answer and never let the meaning model see
          // the ranking entity/measure distinction.
          if (!shouldUseMeaningCall && !explicitMeaningBinding) {
            const deterministicClarification = deterministicPrePlanClarification(
              request,
              base,
              evidence,
              clarificationCandidates,
            );
            if (deterministicClarification) return deterministicClarification;
          }

          if (explicit
            && explicit.compatibility !== "incompatible"
            && (!shouldUseMeaningCall || explicitMeaningBinding)) {
            if (isDegenerateRankingMetric(request.question, evidence, explicit)
              && !hasExplicitRankingMeasure(request.question, evidence)) {
              return rankingMetricChoiceDecision(
                base,
                evidence,
                candidates,
                explicit,
                request.question,
              );
            }
            const decision = routeDecisionForResolution(
              base,
              evidence,
              candidates,
              directResolution(request, evidence, explicit, candidates),
              "heuristic",
              request.question,
              options.resolvedPlanMode ?? 'authoritative',
            );
            return selectedEvidence && decision.requiresClarification
              ? continueCascadeAfterIncompleteSelection(base, evidence, candidates, selectedEvidence)
              : decision;
          }

          const multiMetricPrimary = !shouldUseMeaningCall
            ? exactMultiMetricPrimary(request.question, evidence, candidates)
            : undefined;
          if (multiMetricPrimary) {
            return routeDecisionForResolution(
              base,
              evidence,
              candidates,
              directResolution(request, evidence, multiMetricPrimary, candidates),
              "heuristic",
              request.question,
              options.resolvedPlanMode ?? 'authoritative',
            );
          }


          const authoredExample = !shouldUseMeaningCall
            ? authoritativeExactCertifiedExample(candidates)
            : undefined;
          if (authoredExample) {
            return routeDecisionForResolution(
              base,
              evidence,
              candidates,
              directResolution(request, evidence, authoredExample, candidates),
              'heuristic',
              request.question,
              options.resolvedPlanMode ?? 'authoritative',
            );
          }

          const exactCompatible = !shouldUseMeaningCall ? candidates.filter((candidate) =>
            candidate.exactMatch && candidate.compatibility !== "incompatible"
          ) : [];
          if (exactCompatible.length === 1 && !hasMateriallyRelatedCompetitor(exactCompatible[0], candidates)) {
            return routeDecisionForResolution(
              base,
              evidence,
              candidates,
              directResolution(
                request,
                evidence,
                exactCompatible[0],
                candidates,
              ),
              "heuristic",
              request.question,
              options.resolvedPlanMode ?? 'authoritative',
            );
          }

          const dominant = !shouldUseMeaningCall
            ? dominantCompatibleGovernedCandidate(candidates)
            : undefined;
          if (dominant) {
            return routeDecisionForResolution(
              base,
              evidence,
              candidates,
              directResolution(request, evidence, dominant, candidates),
              "heuristic",
              request.question,
              options.resolvedPlanMode ?? 'authoritative',
            );
          }

          if (!shouldUseMeaningCall && shouldDeferCompositionalFollowUpToExecutor(base, candidates)) {
            return routeWithoutMeaningModel(request, base, evidence, candidates, options.resolvedPlanMode ?? 'authoritative');
          }

          const key = cacheKey(request, evidence);
          const cached = cache.get(key);
          if (cached && (options.cacheTtlMs === undefined || now() - cached.at < cacheTtlMs)) {
            return { ...cached.decision, source: "cache" };
          }

          // Distinguish "the resolver could not run" from "the resolver ran and
          // froze nothing". Only the first is a reason to refuse to interpret:
          // with the semantic judgment unavailable, lexical rank alone must not
          // settle two genuinely different metrics (AGT-017). When the resolver
          // did run, committing to the best governed reading is the whole point.
          let meaningResolverReachable = true;
          try {
            if (request.runBudget && !request.runBudget.mayStartDiscovery('clarify')) {
              return softBoundaryDecision(request, base, 'clarify');
            }
            const resolution = options.resolveMeaning
              ? await options.resolveMeaning({
                  question: request.question,
                  history: effectiveConversationHistory(request),
                  // The resolver/provider receives the same bounded evidence
                  // package as its candidate argument. Supplemental qualified
                  // cards are a host-only clarification aid and must not leak
                  // through this richer carrier.
                  evidence: {
                    ...evidence,
                    candidates,
                    clarificationCandidates: undefined,
                  },
                  candidates,
                  signal: request.signal ?? options.signal,
                })
              : options.complete
                ? parseMeaningResolution(await options.complete({
                    system: buildMeaningSystemPrompt(),
                    user: buildMeaningUserPrompt(request, evidence, candidates),
                    signal: request.signal ?? options.signal,
                  }))
                : undefined;
            if (resolution) {
              const validated = validateMeaningResolution(resolution, candidates);
              if (validated.ok) {
                const safeResolution = preventDegenerateRankingResolution(
                  validated.resolution,
                  evidence,
                  candidates,
                  request.question,
                );
                // Meaning interpretation is still required for a fresh turn,
                // but it cannot invent a ranking measure when the user only
                // supplied an entity. Preserve the precise follow-up after the
                // bounded call so this does not regress into a generic block
                // or a repeated customer-count answer.
                //
                // Gate on the MEANING MODEL's classification, not on
                // `questionTypeFromText`. The text heuristic only looks for
                // words like "top", so it also claimed "what region does the
                // top customer belong to" (an attribute lookup) and "top
                // products in Philadelphia and the customers who bought them"
                // (a compound turn) — both were preempted here and never
                // routed, even though the bounded call had just resolved them.
                //
                // A resolution that named an execution target is honored:
                // `preventDegenerateRankingResolution` above has already
                // downgraded a same-grain entity count to `clarify`, so
                // anything still standing is a governed measure the model
                // selected from qualified candidate ids.
                const resolutionResolvedRanking = safeResolution.recommendedRoute !== 'clarify'
                  && Boolean(safeResolution.recommendedExecutionId
                    || safeResolution.selectedConceptIds.length > 0);
                if (
                  safeResolution.questionType === 'ranking'
                  && !hasExplicitRankingMeasure(request.question, evidence)
                  && !resolutionResolvedRanking
                ) {
                  return bareRankingClarification(
                    base,
                    retrievalTrace(evidence, candidates),
                    request.question,
                    evidence,
                    // Supplemental clarification cards carry the ranking
                    // measures for the requested entity, which the execution
                    // candidate set deliberately does not.
                    clarificationCandidates,
                  );
                }
                const deterministicGap = deterministicPrePlanClarification(
                  request,
                  base,
                  evidence,
                  clarificationCandidates,
                );
                if (deterministicGap && safeResolution.recommendedRoute === 'clarify') {
                  return deterministicGap;
                }
                return remember(
                  key,
                  routeDecisionForResolution(base, evidence, candidates, safeResolution, "llm", request.question, options.resolvedPlanMode ?? 'authoritative'),
                );
              }
              const invalidResolution: MeaningResolution = {
                interpretedQuestion: request.question,
                questionType: questionTypeFromText(request.question),
                selectedConceptIds: resolution.selectedConceptIds,
                recommendedExecutionId: resolution.recommendedExecutionId,
                queryIntent: resolution.queryIntent,
                rejectedCandidates: [],
                confidence: "low",
                missingInformation: [validated.reason],
                recommendedRoute: "clarify",
                compatibilityOutcome: 'modeling_gap',
                compatibilityFailures: [{
                  code: 'INVALID_EVIDENCE_REFERENCE',
                  field: 'meaningResolution',
                  message: validated.reason,
                  candidateIds: [],
                }],
              };
              const invalidDecision = routeDecisionForResolution(
                base,
                evidence,
                candidates,
                invalidResolution,
                "llm",
                request.question,
                options.resolvedPlanMode ?? 'authoritative',
              );
              return remember(key, {
                ...invalidDecision,
                meaningResolutionErrorCode: 'invalid_evidence_reference',
              });
            }
          } catch (error) {
            rethrowCancellation(error, request.signal, options.signal);
            // A resolver transport/parse failure falls back without losing the
            // retrieval signal or permitting a general-knowledge misroute.
            meaningResolverReachable = false;
          }
          const fallbackDecision = routeWithoutMeaningModel(
            request,
            base,
            evidence,
            candidates,
            options.resolvedPlanMode ?? 'authoritative',
            meaningResolverReachable,
          );
          if (!shouldUseMeaningCall) return fallbackDecision;
          // The provider was unavailable or returned malformed JSON. Apply the
          // deterministic clarification only after the bounded meaning attempt
          // has been exhausted; this preserves a precise recovery path without
          // allowing the generic governed error to terminate the question.
          return deterministicPrePlanClarification(request, base, evidence, clarificationCandidates)
            ?? fallbackDecision;
        }
      }

      // Legacy/no-evidence path. A confident analytical heuristic stays offline;
      // only the ambiguous middle pays the old classification call. Importantly,
      // load the catalog context before the model may choose general knowledge.
      if (base.confidence >= threshold || !options.complete) {
        return { ...base, source: base.source ?? "heuristic" };
      }
      let catalogContext: string | undefined;
      if (request.runBudget && !request.runBudget.mayStartDiscovery('clarify')) {
        return softBoundaryDecision(request, base, 'clarify');
      }
      try {
        catalogContext = options.getCatalogContext ? await options.getCatalogContext(request) : undefined;
      } catch (error) {
        rethrowCancellation(error, request.signal, options.signal);
        catalogContext = undefined;
      }
      const key = cacheKey(request, undefined, catalogContext);
      const cached = cache.get(key);
      if (cached && (options.cacheTtlMs === undefined || now() - cached.at < cacheTtlMs)) {
        return { ...cached.decision, source: "cache" };
      }
      try {
        const raw = await options.complete({
          system: buildSystemPrompt(),
          user: buildUserPrompt(request, catalogContext),
          signal: request.signal ?? options.signal,
        });
        const classification = parseClassification(raw);
        if (classification) return remember(key, classificationToDecision(classification, base));
      } catch (error) {
        rethrowCancellation(error, request.signal, options.signal);
        // fall through to deterministic
      }
      return { ...base, source: "heuristic" };
    },
  };
}

function discoveryRouteBeforeRetrieval(request: AgentRunRequest, base: IntentDecision): import('./agent-run-engine.js').AgentRunRoute {
  if (request.runBudget?.mode === 'research' || request.requestedMode === 'research') return 'research';
  if (base.action === 'clarify' || base.requiresClarification || request.signals?.missingContext?.length) return 'clarify';
  if (
    request.intent === 'exact_certified_lookup'
    || (request.signals?.certifiedScore ?? 0) >= 0.5
    || (request.signals?.metricScore ?? 0) >= 0.5
  ) return 'semantic_answer';
  return 'generated_answer';
}

function softBoundaryDecision(
  request: AgentRunRequest,
  base: IntentDecision,
  route: import('./agent-run-engine.js').AgentRunRoute,
): IntentDecision {
  const seconds = Math.round((request.runBudget?.softTargetMs(route) ?? 15_000) / 1_000);
  return {
    ...base,
    action: 'clarify',
    confidence: 1,
    source: 'heuristic',
    requiresClarification: true,
    reason: `The ${seconds}-second discovery target elapsed before a plan was frozen, so DQL did not start another retrieval or provider branch.`,
    clarifyingQuestion: request.runBudget?.mode === 'research'
      ? 'Research has stopped starting new branches. Would you like to narrow the question and retry?'
      : 'The discovery window ended before an exact plan was frozen. Which metric or grain should DQL use on retry?',
  };
}

export { intentForCategory, parseMeaningResolution };
