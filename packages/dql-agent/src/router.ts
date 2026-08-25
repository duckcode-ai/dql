import { assumeDominantCandidate, type AnswerAssumption } from './agentic/assumptions.js';
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
  type AnalyticalTerminalGapWitness,
} from "./intent-controller.js";
import type { AgentRunRequest, AgentRouter } from "./agent-run-engine.js";
import type { MetadataAgentIntent } from "./metadata/catalog.js";
import {
  buildMeaningEvidencePackage,
  canonicalizeMetricMeasureCandidates,
  certifiedCandidateExplicitlyCoversMeasures,
  defaultQueryIntent,
  findExplicitEvidenceReference,
  mergeMeaningResolutionWithRequirementSeed,
  questionTypeFromText,
  routeForEvidenceCandidate,
  validateMeaningResolution,
  type AgentEvidenceCandidate,
  type AgentMeaningResolver,
  type AgentRelationshipSafetyEvidence,
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
  buildAnalyticalCascadeDecision,
  buildAnalyticalRequirementSeedV1,
  buildAnalyticalRequirementSet,
  categoricalDimensionRequirementTerms,
  candidateConflictsWithExplicitRankingMeasure,
  candidateMatchesCategoricalDimensionRequirement,
  evidenceCandidateRoles,
  isEntityAttributeCandidate,
  type AnalyticalCascadeDecisionV1,
  type AnalyticalCascadeTerminalGapV1,
  type AnalyticalRequirementSetV1,
  type AnalyticalRequirementSeedV1,
  type CascadeTierAttemptV1,
  type ContextSourceCoverageV1,
} from './analytical-orchestration.js';
import { askTraceObserverForV1, type AskTraceSpanNameV1 } from './ask-observability/index.js';
import {
  normalizeEvidenceAnalyticalCapability,
  solveAnalyticalCompatibility,
} from "./analytical-compatibility.js";
import {
  buildDeterministicAnalyticalFrame,
  projectResolvedAnalyticalFrame,
  resolveMetricCapabilityDimension,
} from "./analytical-frame.js";
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
  /**
   * The request carries the non-enumerable server-owned trace observer.  A
   * completion backend may use it only for physical provider observations;
   * it is not model input and must not affect routing or execution.
   */
  request: AgentRunRequest;
  /** Identifies the host-owned purpose of this bounded completion. */
  phase: 'classification' | 'meaning_resolution';
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
   * a server-issued structured selection or qualified @ reference is always
   * allowed to use the zero-call path because it has already supplied a
   * validated identity.  A raw selectedEvidenceId is never an authority.
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
    "The host already performed broad retrieval and supplied a host-owned requirement seed. Compare ONLY the supplied candidate cards against that seed.",
    "Select the supplied candidate IDs that best bind the host-owned metric, entity, dimensions, filters, time grain, ranking, and output requirements.",
    "Trust, route selection, SQL, and the final analytical frame are host-owned. Never select an unrelated certified block over a relevant semantic metric.",
    "You may reference ONLY candidate IDs supplied below. Never invent an ID, table, column, metric, relationship, or filter value.",
    "Do not rewrite, add, remove, or replace any host-owned requirement. Do not use prior conversation unless the host seed says it is a continuation.",
    "Do not emit SQL, trust labels, an execution route, query intent, or an analytical frame. Those fields are ignored if present for legacy compatibility.",
    "Use low confidence and recommend clarify when material business meanings remain unresolved.",
    "Respond with ONLY one JSON object matching this minimal candidate-ID shape:",
    '{"selectedCandidateIds":string[],"recommendedExecutionId"?:string,"confidence"?:"high"|"medium"|"low","missingInformation"?:string[]}',
    "`selectedConceptIds` is accepted only for legacy compatibility. All omitted optional fields receive host-owned safe defaults.",
  ].join("\n");
}

function buildMeaningUserPrompt(
  request: AgentRunRequest,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
  requirementSeed: AnalyticalRequirementSeedV1,
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
    `Host-owned requirement seed: ${JSON.stringify(requirementSeed)}`,
    `Candidate cards: ${JSON.stringify(cards)}`,
  ];
  const history = effectiveConversationHistory(request);
  const continuation = request.conversationBinding ?? 'none';
  if (history.length && continuation !== 'none') {
    lines.push(`Recent conversation: ${JSON.stringify(history.slice(-4).map((turn) => ({
      role: turn.role,
      text: compactText(turn.text, 1_200),
    })))}`);
  }
  const envelope = continuation === 'none'
    ? undefined
    : renderConversationEnvelopeForPrompt(request.conversationContext);
  if (envelope) lines.push(`Structured conversation state: ${JSON.stringify(envelope)}`);
  lines.push("Bind only supplied candidate IDs to the host-owned seed and return JSON only.");
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

function parseMeaningResolution(
  raw: string,
  requirementSeed?: AnalyticalRequirementSeedV1,
): MeaningResolution | undefined {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const interpretedQuestion = typeof record.interpretedQuestion === "string" && record.interpretedQuestion.trim()
    ? record.interpretedQuestion.trim()
    : requirementSeed?.sourceQuestion;
  if (!interpretedQuestion) return undefined;
  const questionType = typeof record.questionType === "string" && QUESTION_TYPES.has(record.questionType)
    ? record.questionType as MeaningResolution["questionType"]
    : requirementSeed ? questionTypeFromText(requirementSeed.sourceQuestion) : undefined;
  if (!questionType) return undefined;
  const selectedConceptIds = Array.isArray(record.selectedCandidateIds)
    ? record.selectedCandidateIds
    : record.selectedConceptIds;
  if (!Array.isArray(selectedConceptIds) || selectedConceptIds.some((id) => typeof id !== "string")) return undefined;
  const confidence = typeof record.confidence === "string" && MEANING_CONFIDENCES.has(record.confidence)
    ? record.confidence as MeaningResolution['confidence']
    : requirementSeed
      ? selectedConceptIds.length > 0 ? 'medium' as const : 'low' as const
      : undefined;
  if (!confidence) return undefined;
  const recommendedRoute = typeof record.recommendedRoute === "string" && MEANING_ROUTES.has(record.recommendedRoute)
    ? record.recommendedRoute as MeaningResolution["recommendedRoute"]
    : requirementSeed ? "clarify" : undefined;
  if (!recommendedRoute) return undefined;
  const missingInformation = stringArray(record.missingInformation) ?? (requirementSeed ? [] : undefined);
  if (!missingInformation) return undefined;
  const query = record.queryIntent && typeof record.queryIntent === "object" && !Array.isArray(record.queryIntent)
    ? record.queryIntent as Record<string, unknown>
    : undefined;
  const measures = query ? stringArray(query.measures) : undefined;
  const dimensions = query ? stringArray(query.dimensions) : undefined;
  const filters = Array.isArray(query?.filters)
    ? query.filters.flatMap((filter) => {
        if (!filter || typeof filter !== "object" || Array.isArray(filter)) return [];
        const item = filter as Record<string, unknown>;
        return typeof item.field === "string" && typeof item.value === "string"
          ? [{ field: item.field, value: item.value }]
          : [];
      })
    : undefined;
  if (!requirementSeed && (!measures || !dimensions || !filters || !Array.isArray(query?.filters) || filters.length !== query.filters.length)) return undefined;
  const rejectedCandidatesRaw = record.rejectedCandidates;
  if (rejectedCandidatesRaw !== undefined && !Array.isArray(rejectedCandidatesRaw)) return undefined;
  const rejectedCandidates = (rejectedCandidatesRaw ?? []).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    return typeof item.id === "string" && typeof item.reason === "string"
      ? [{ id: item.id, reason: item.reason }]
      : [];
  });
  if (rejectedCandidates.length !== (rejectedCandidatesRaw?.length ?? 0)) return undefined;
  const recommendedExecutionId = typeof record.recommendedExecutionId === "string"
    ? record.recommendedExecutionId
    : undefined;
  const clarifyingQuestion = typeof record.clarifyingQuestion === "string" && record.clarifyingQuestion.trim()
    ? record.clarifyingQuestion.trim()
    : undefined;
  const providerExplicitlyClarified = (recommendedRoute === 'clarify'
    && typeof record.recommendedRoute === 'string')
    || Boolean(clarifyingQuestion)
    || missingInformation.length > 0
    || rejectedCandidates.length > 0;
  // Legacy callers may still send a V2 frame. It remains readable without a
  // seed, but a seeded meaning call must never grant a model frame authority.
  const analyticalFrame = requirementSeed || record.analyticalFrame === undefined
    ? undefined
    : normalizeAnalyticalQuestionFrameV2(record.analyticalFrame);
  if (!requirementSeed && record.analyticalFrame !== undefined && !analyticalFrame) return undefined;
  return {
    interpretedQuestion,
    questionType,
    selectedConceptIds: selectedConceptIds as string[],
    ...(recommendedExecutionId ? { recommendedExecutionId } : {}),
    queryIntent: requirementSeed
      ? queryIntentFromRequirementSeed(requirementSeed)
      : {
          measures: measures!,
          dimensions: dimensions!,
          filters: filters!,
          ...(typeof query?.timeRange === "string" ? { timeRange: query.timeRange } : {}),
          ...(typeof query?.timeGrain === "string" ? { timeGrain: query.timeGrain } : {}),
          ...(query?.order === "asc" || query?.order === "desc" ? { order: query.order } : {}),
          ...(typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
            ? { limit: Math.floor(query.limit) }
            : {}),
        },
    rejectedCandidates,
    confidence,
    missingInformation,
    recommendedRoute,
    ...(clarifyingQuestion ? { clarifyingQuestion } : {}),
    ...(analyticalFrame ? { analyticalFrame } : {}),
    ...(selectedConceptIds.length === 0 && !recommendedExecutionId && !providerExplicitlyClarified
      ? { emptyCandidateBinding: true as const }
      : {}),
  };
}

function queryIntentFromRequirementSeed(seed: AnalyticalRequirementSeedV1): MeaningResolution["queryIntent"] {
  return {
    measures: [...seed.queryIntent.measures],
    dimensions: [...seed.queryIntent.dimensions],
    filters: seed.queryIntent.filters.map((filter) => ({ field: filter.field, value: filter.value })),
    ...(seed.queryIntent.timeRange ? { timeRange: seed.queryIntent.timeRange } : {}),
    ...(seed.queryIntent.timeGrain ? { timeGrain: seed.queryIntent.timeGrain } : {}),
    ...(seed.queryIntent.order ? { order: seed.queryIntent.order } : {}),
    ...(seed.queryIntent.limit !== undefined ? { limit: seed.queryIntent.limit } : {}),
    ...(seed.queryIntent.fiscalCalendarId ? { fiscalCalendarId: seed.queryIntent.fiscalCalendarId } : {}),
    ...(seed.queryIntent.fiscalDateRoleId ? { fiscalDateRoleId: seed.queryIntent.fiscalDateRoleId } : {}),
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
  const candidateTraceMetadata = candidates.flatMap((candidate) => evidenceCandidateRoles(candidate).map((role) => ({
    // `id` is the identity accepted by the meaning resolver. It is already
    // source-qualified by the retrieval contract; keep it so later selection
    // IDs can be joined without guessing a legacy-to-canonical mapping.
    candidateId: candidate.id,
    role,
    source: traceSourceForCandidate(candidate),
    ...(candidate.retrievalLanes?.length ? { lanes: candidate.retrievalLanes } : {}),
  })));
  return {
    ...(evidence.snapshotId ? { snapshotId: evidence.snapshotId } : {}),
    ...(evidence.sourceFingerprint ? { sourceFingerprint: evidence.sourceFingerprint } : {}),
    candidateCount: candidates.length,
    candidateIds: candidates.map((candidate) => candidate.id),
    ...(candidateTraceMetadata.length ? { candidateTraceMetadata } : {}),
  };
}

/**
 * Observability is a projection of snapshot-bound evidence, never a second
 * retriever or a route authority. Keep source classification conservative so
 * an absent lane is not manufactured from an arbitrary ID prefix.
 */
function traceSourceForCandidate(candidate: AgentEvidenceCandidate): ContextSourceCoverageV1['source'] {
  // Qualified candidate identities preserve their originating index. Prefer
  // that declared provenance for collapsed `sql_column`/`sql_table` kinds: a
  // dbt manifest column must not be relabelled as runtime-schema evidence.
  const identity = candidate.qualifiedId ?? candidate.id;
  if (identity.startsWith('dbt:')) return 'dbt_manifest';
  if (identity.startsWith('runtime:')) return 'runtime_schema';
  if (identity.startsWith('semantic:')) return 'semantic';
  if (identity.startsWith('dql:')) return candidate.kind === 'certified_block' ? 'certified' : 'governed_relational';
  if (candidate.kind === 'certified_block') return 'certified';
  if (candidate.kind === 'semantic_metric' || candidate.kind === 'semantic_member') return 'semantic';
  if (candidate.kind === 'dql_modeling') return 'governed_relational';
  if (candidate.kind === 'dbt_model' || candidate.kind === 'dbt_source') return 'dbt_manifest';
  if (candidate.kind === 'sql_table' || candidate.kind === 'sql_column') return 'runtime_schema';
  return 'exploratory';
}

function traceCandidateLifecycleBeforePruning(
  request: AgentRunRequest,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
  packageCandidates: AgentEvidenceCandidate[],
): void {
  const observer = askTraceObserverForV1(request);
  if (!observer.enabled) return;
  const packageIds = new Set(packageCandidates.map((candidate) => candidate.id));
  const fuse = observer.startSpan({
    name: 'retrieval.fuse',
    stage: 'retrieval',
    payload: { kind: 'retrieval', candidateCount: candidates.length },
  });
  const requirements = buildAnalyticalRequirementSet({ question: request.question, parsedIntent: evidence.parsedIntent });
  const requestedRoles = new Set<ReturnType<typeof evidenceCandidateRoles>[number]>([
    ...(requirements.measures.length || requirements.ranking?.metricTerms.length ? ['metric' as const] : []),
    ...(requirements.entityTerms.length || requirements.entityDisplayTerms.length ? ['entity_label' as const] : []),
    ...(requirements.time ? ['time_dimension' as const] : []),
    ...(requirements.dimensions.length ? ['categorical_dimension' as const] : []),
    ...(requirements.dimensions.length > 1 || requirements.entityTerms.length ? ['relationship' as const] : []),
  ]);
  const candidateLimit = 32;
  const hasRequestedEntityLabel = requirements.entityTerms.length > 0 || requirements.entityDisplayTerms.length > 0;
  for (const [index, candidate] of candidates.slice(0, candidateLimit).entries()) {
    const roles = evidenceCandidateRoles(candidate);
    const source = traceSourceForCandidate(candidate);
    // This receipt must retain the actual retrieval memberships captured by
    // the snapshot. Do not infer a lane from aliases, IDs, or a relationship
    // attribute after fusion has already lost that physical provenance.
    const lanes = candidate.retrievalLanes
      ?.map((entry) => ({ ...entry }))
      .sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER)
        || left.lane.localeCompare(right.lane));
    const lane = lanes?.[0]?.lane;
    const laneRank = lanes?.[0]?.rank;
    const initialReason = candidate.exactMatch
      ? 'exact_name_match' as const
      : 'unknown' as const;
    const compatibilityCode = candidate.compatibility === 'compatible' ? 'compatible' as const
      : candidate.compatibility === 'incompatible' ? 'operation_unsupported' as const
        : 'unknown' as const;
    for (const role of roles) {
      const common = {
        // The resolver and cascade use `id`; keeping that exact stable identity
        // makes retrieval, admission, and model-selection receipts joinable.
        candidateId: candidate.id,
        role,
        source,
        ...(lane ? { lane } : {}),
        ...(laneRank !== undefined ? { laneRank } : {}),
        ...(lanes?.length ? { lanes } : {}),
        fusedRank: index + 1,
        compatibilityCode,
      };
      observer.recordCandidateDecision({
        ...common,
        decision: 'retrieved',
        reasonCode: candidate.eligible === false ? 'role_mismatch' : initialReason,
      });
      // An explicit ranking measure is a typed request, not a relevance hint.
      // Keep correlated metrics in the receipt, but record their exclusion at
      // the metric admission boundary instead of allowing them to become
      // clarification options or to fill an unrelated analytical role.
      if (role === 'metric' && candidateConflictsWithExplicitRankingMeasure(candidate, requirements)) {
        observer.recordCandidateDecision({
          ...common,
          decision: 'excluded',
          reasonCode: 'explicit_measure_conflict',
        });
        continue;
      }
      if (candidate.eligible === false || candidate.compatibility === 'incompatible') {
        observer.recordCandidateDecision({
          ...common,
          decision: 'excluded',
          reasonCode: candidate.compatibility === 'incompatible' ? 'capability_incompatible' : 'role_mismatch',
        });
        continue;
      }
      if (packageIds.has(candidate.id)) {
        const reservedForRole = requestedRoles.has(role);
        observer.recordCandidateDecision({
          ...common,
          decision: 'reserved',
          reasonCode: candidate.exactMatch ? 'exact_name_match' : reservedForRole ? 'role_reserved' : 'fused_relevance_fill',
        });
        observer.recordCandidateDecision({
          ...common,
          decision: 'admitted',
          reasonCode: candidate.exactMatch ? 'exact_name_match' : reservedForRole ? 'role_reserved' : 'fused_relevance_fill',
        });
      } else {
        const isNoisyEntityAttribute = hasRequestedEntityLabel
          && isEntityAttributeCandidate(candidate)
          && role === 'categorical_dimension';
        observer.recordCandidateDecision({
          ...common,
          decision: 'excluded',
          reasonCode: isNoisyEntityAttribute ? 'entity_label_mismatch' : 'below_fused_limit',
        });
      }
    }
  }
  observer.finishSpan(fuse, { outcome: 'ok', reasonCode: 'completed' });
}

/**
 * Emit source-bound lane summaries before the meaning-package cap applies.
 * These spans are evidence about the existing retrieval result only; they do
 * not invoke, retry, or reinterpret any retrieval source.
 */
function traceRetrievalLanesBeforePruning(
  request: AgentRunRequest,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
): void {
  const observer = askTraceObserverForV1(request);
  if (!observer.enabled) return;
  const sourceSpan: Partial<Record<ContextSourceCoverageV1['source'], Exclude<AskTraceSpanNameV1, 'ask.run' | 'research.run'>>> = {
    certified: 'retrieval.certified',
    semantic: 'retrieval.semantic',
    governed_relational: 'retrieval.governed_relational',
    dbt_manifest: 'retrieval.dbt_manifest',
    runtime_schema: 'retrieval.runtime_schema',
    vector: 'retrieval.vector',
    conversation: 'retrieval.conversation',
  };
  const record = (
    name: Exclude<AskTraceSpanNameV1, 'ask.run' | 'research.run'>,
    source: ContextSourceCoverageV1['source'] | undefined,
    count: number,
    coverage: ContextSourceCoverageV1['status'] | undefined,
    lane?: 'exact' | 'lexical' | 'vector' | 'graph' | 'conversation',
  ) => {
    const span = observer.startSpan({
      name,
      stage: 'retrieval',
      reasonCode: coverage === 'unavailable' ? 'source_unavailable' : coverage === 'empty' ? 'source_empty' : coverage === 'stale' ? 'source_stale' : 'completed',
      payload: { kind: 'retrieval', ...(source ? { source } : {}), ...(lane ? { lane } : {}), candidateCount: count, ...(coverage ? { coverage } : {}) },
    });
    observer.finishSpan(span, {
      outcome: coverage === 'unavailable' ? 'unavailable' : 'ok',
      reasonCode: coverage === 'unavailable' ? 'source_unavailable' : coverage === 'empty' ? 'source_empty' : coverage === 'stale' ? 'source_stale' : 'completed',
    });
  };
  for (const coverage of sourceCoverageFromEvidence(evidence, candidates)) {
    const name = sourceSpan[coverage.source];
    if (!name) continue;
    record(name, coverage.source, coverage.candidateIds.length, coverage.status,
      coverage.source === 'vector' ? 'vector' : coverage.source === 'conversation' ? 'conversation' : undefined);
  }
  const laneSpan: Record<'exact' | 'lexical' | 'vector' | 'graph' | 'conversation', Exclude<AskTraceSpanNameV1, 'ask.run' | 'research.run'>> = {
    exact: 'retrieval.exact',
    lexical: 'retrieval.lexical',
    vector: 'retrieval.vector',
    graph: 'retrieval.graph',
    conversation: 'retrieval.conversation',
  };
  for (const lane of Object.keys(laneSpan) as Array<keyof typeof laneSpan>) {
    const count = candidates.filter((candidate) => candidate.retrievalLanes?.some((membership) => membership.lane === lane)).length;
    if (count > 0) record(laneSpan[lane], undefined, count, 'available', lane);
  }
}

/** Preserve actual retrieval provenance; never infer lane state from an ID regex. */
function sourceCoverageFromEvidence(
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
): ContextSourceCoverageV1[] {
  const supplied = new Map((evidence.diagnostics?.sourceCoverage ?? []).map((coverage) => [coverage.source, coverage]));
  const sourceKinds: Array<[ContextSourceCoverageV1['source'], (candidate: AgentEvidenceCandidate) => boolean]> = [
    ['certified', (candidate) => candidate.kind === 'certified_block'],
    ['semantic', (candidate) => candidate.trustTier === 'semantic' || candidate.kind === 'semantic_metric' || candidate.kind === 'semantic_member'],
    ['governed_relational', (candidate) => candidate.kind === 'dql_modeling' || (candidate.relationshipEvidence?.length ?? 0) > 0],
    ['exploratory', (candidate) => candidate.kind === 'dbt_model' || candidate.kind === 'dbt_source' || candidate.kind === 'sql_table' || candidate.kind === 'sql_column'],
    ['dbt_manifest', (candidate) => candidate.kind === 'dbt_model' || candidate.kind === 'dbt_source'],
    ['runtime_schema', (candidate) => candidate.kind === 'sql_table' || candidate.kind === 'sql_column'],
  ];
  const coverage: ContextSourceCoverageV1[] = [];
  for (const [source, matches] of sourceKinds) {
    const explicit = supplied.get(source);
    if (explicit) {
      coverage.push({ ...explicit, version: 1, candidateIds: [...new Set(explicit.candidateIds)].slice(0, 32) });
      continue;
    }
    const ids = candidates.filter(matches).map((candidate) => candidate.qualifiedId ?? candidate.id).slice(0, 32);
    const searched = evidence.diagnostics?.searchedKinds ?? [];
    const relevantSearched = source === 'certified'
      ? searched.includes('certified_block')
      : source === 'semantic'
        ? searched.includes('semantic_metric') || searched.includes('semantic_member')
        : source === 'dbt_manifest'
          ? searched.includes('dbt_model') || searched.includes('dbt_source')
          : source === 'runtime_schema'
            ? searched.includes('sql_table') || searched.includes('sql_column')
            : source === 'exploratory'
              ? searched.some((kind) => kind === 'dbt_model' || kind === 'dbt_source' || kind === 'sql_table' || kind === 'sql_column')
              : searched.includes('dql_modeling');
    coverage.push({ version: 1, source, status: ids.length > 0 ? 'available' : relevantSearched ? 'empty' : 'unavailable', candidateIds: ids });
  }
  // Vector/conversation status is only included when its retrieval lane told us
  // its real status. It is not a synthetic “skipped” placeholder.
  for (const source of ['vector', 'conversation'] as const) {
    const explicit = supplied.get(source);
    if (explicit) coverage.push({ ...explicit, version: 1, candidateIds: [...new Set(explicit.candidateIds)].slice(0, 32) });
  }
  return coverage;
}

function declaredFiscalCalendar(
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
): NonNullable<AgentRetrievalEvidence['fiscalCalendar']> | undefined {
  const calendar = evidence.fiscalCalendar;
  // A fiscal period value is meaningless without the date role it applies to.
  // Older snapshots may not contain this field, but they must clarify instead
  // of silently applying FY26 to an arbitrary date column.
  if (!calendar?.dateRoleId) return undefined;
  const identifiers = new Set(candidates.flatMap((candidate) => [candidate.id, candidate.qualifiedId].filter((id): id is string => Boolean(id))));
  return identifiers.has(calendar.id)
    && identifiers.has(calendar.fiscalPeriodFieldId)
    && identifiers.has(calendar.dateRoleId)
    ? calendar
    : undefined;
}

function withDeclaredFiscalBinding(
  resolution: MeaningResolution,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
  question: string,
): MeaningResolution {
  const requirements = buildAnalyticalRequirementSet({ question, parsedIntent: evidence.parsedIntent });
  const fiscalPeriod = requirements.time?.fiscalPeriod;
  const calendar = fiscalPeriod ? declaredFiscalCalendar(evidence, candidates) : undefined;
  if (!fiscalPeriod || !calendar) return resolution;
  const filters = resolution.queryIntent.filters.filter((filter) => filter.field !== calendar.fiscalPeriodFieldId);
  return {
    ...resolution,
    queryIntent: {
      ...resolution.queryIntent,
      filters: [...filters, { field: calendar.fiscalPeriodFieldId, value: fiscalPeriod }],
      ...(requirements.time?.grain && !resolution.queryIntent.timeGrain ? { timeGrain: requirements.time.grain } : {}),
      fiscalCalendarId: calendar.id,
      fiscalDateRoleId: calendar.dateRoleId,
    },
  };
}

function fiscalCalendarClarification(
  request: AgentRunRequest,
  base: IntentDecision,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
): IntentDecision | undefined {
  const requirements = buildAnalyticalRequirementSet({ question: request.question, parsedIntent: evidence.parsedIntent });
  if (!requirements.time?.requiresDeclaredFiscalCalendar || declaredFiscalCalendar(evidence, candidates)) return undefined;
  const fiscalPeriod = requirements.time.fiscalPeriod ?? 'the requested fiscal period';
  const coverage = sourceCoverageFromEvidence(evidence, candidates);
  return {
    ...base,
    action: 'clarify',
    confidence: 1,
    source: 'heuristic',
    category: 'unclear',
    depth: 'quick',
    reason: `${fiscalPeriod} requires one declared fiscal calendar and date-role mapping before a plan can freeze.`,
    clarifyingQuestion: `Which declared fiscal calendar and date role should DQL use for ${fiscalPeriod}?`,
    requiresClarification: true,
    retrievalEvidence: retrievalTrace(evidence, candidates),
    analyticalCascadeDecision: buildAnalyticalCascadeDecision({
      requirements,
      sourceCoverage: coverage,
      attempts: [{ version: 1, tier: 'clarify_or_gap', outcome: 'ambiguous', candidateIds: [], reason: 'No declared fiscal calendar/date-role binding was present in the snapshot.', planFrozen: false }],
      planFrozen: false,
      stopReason: 'ambiguous',
    }),
  };
}

function normalizedRelationshipIdentity(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The retrieval parser is intentionally generous because its terms also seed
 * search.  Before the router turns those terms into a resolved plan, replace
 * grammatical aggregation wrappers with the shared typed requirement set.
 * This keeps all router paths (fast certified, no-meaning, structured
 * continuation, and one-call meaning) on the same count/customer contract.
 */
function withNormalizedAnalyticalRequirements(
  evidence: AgentRetrievalEvidence,
  question: string,
): AgentRetrievalEvidence {
  if (!evidence.parsedIntent) return evidence;
  const requirements = buildAnalyticalRequirementSet({ question, parsedIntent: evidence.parsedIntent });
  return {
    ...evidence,
    parsedIntent: {
      ...evidence.parsedIntent,
      measures: requirements.measures,
      dimensions: requirements.dimensions,
      ...(requirements.time?.grain && !evidence.parsedIntent.timeGrain
        ? { timeGrain: requirements.time.grain }
        : {}),
    },
  };
}

function relationshipSafetyIdentities(safety: AgentRelationshipSafetyEvidence): string[] {
  return [...new Set([safety.id, ...(safety.aliases ?? [])]
    .map(normalizedRelationshipIdentity)
    .filter(Boolean))];
}

/**
 * This mirrors the local manifest relationship admission gate with the compact
 * facts preserved in retrieval evidence. IDs and names deliberately play no
 * part in the decision: a neutral draft/many-to-many identity is still unsafe.
 */
function relationshipSafetyAllowsAutomaticJoin(
  safety: AgentRelationshipSafetyEvidence,
  requiredJoinKey?: string,
): boolean {
  const validation = safety.validation;
  const checkedAt = Date.parse(validation?.checkedAt ?? '');
  const expiresAt = safety.evidenceExpiresAt ? Date.parse(safety.evidenceExpiresAt) : undefined;
  const expirationInvalid = safety.evidenceExpiresAt !== undefined
    && (expiresAt === undefined || !Number.isFinite(expiresAt) || expiresAt <= Date.now());
  if (safety.status !== 'certified'
    || safety.staleCertification !== false
    || safety.automaticJoinAllowed !== true
    || safety.fanout !== 'safe'
    || !['one_to_one', 'one_to_many', 'many_to_one'].includes(safety.cardinality ?? '')
    || !safety.from?.trim()
    || !safety.to?.trim()
    || !safety.certificationFingerprint?.trim()
    || !validation
    || validation.status !== 'passed'
    || !validation.queryFingerprint?.trim()
    || !validation.proofFingerprint?.trim()
    || !Number.isFinite(checkedAt)
    || expirationInvalid
    || safety.keys.length === 0
    || safety.keys.some((key) => !key.from.trim() || !key.to.trim())) return false;
  if (!requiredJoinKey) return true;
  const normalizedKey = normalizeMetricPhrase(requiredJoinKey);
  return safety.keys.some((key) =>
    metricTermsMatch(normalizeMetricPhrase(key.from), normalizedKey)
    || metricTermsMatch(normalizeMetricPhrase(key.to), normalizedKey));
}

/**
 * Relationship evidence has three deliberately different authorities:
 *
 * - governed: a certified, fresh proof may compile a governed relational plan;
 * - exploratory: an explicitly allowed, validated relation may close a raw
 *   review-required SQL plan after normal runtime validation; and
 * - hint: anything weaker may improve retrieval, but can never add a join.
 *
 * The first authority remains intentionally stricter.  Reusing it for raw
 * fallback is what made a missing semantic capability look like a terminal
 * absence even when the dbt/runtime snapshot had the exact relations, keys,
 * and fields required to inspect it safely.  This helper never upgrades a
 * draft relationship to governed trust: callers that use it must select the
 * exploratory tier and retain review_required provenance.
 */
function relationshipSafetyAllowsExploratoryJoin(
  safety: AgentRelationshipSafetyEvidence,
  requiredJoinKey?: string,
): boolean {
  const validation = safety.validation;
  const checkedAt = Date.parse(validation?.checkedAt ?? '');
  const expiresAt = safety.evidenceExpiresAt ? Date.parse(safety.evidenceExpiresAt) : undefined;
  const expirationInvalid = safety.evidenceExpiresAt !== undefined
    && (expiresAt === undefined || !Number.isFinite(expiresAt) || expiresAt <= Date.now());
  const lifecycleAllowsExploration = safety.status === 'certified'
    || safety.status === 'validated'
    || safety.status === 'draft';
  if (!lifecycleAllowsExploration
    || safety.staleCertification === true
    || safety.automaticJoinAllowed !== true
    || safety.fanout !== 'safe'
    || !['one_to_one', 'one_to_many', 'many_to_one'].includes(safety.cardinality ?? '')
    || !safety.from?.trim()
    || !safety.to?.trim()
    || !validation
    || validation.status !== 'passed'
    || !validation.queryFingerprint?.trim()
    || !validation.proofFingerprint?.trim()
    || !Number.isFinite(checkedAt)
    || expirationInvalid
    || safety.keys.length === 0
    || safety.keys.some((key) => !key.from.trim() || !key.to.trim())) return false;
  if (!requiredJoinKey) return true;
  const normalizedKey = normalizeMetricPhrase(requiredJoinKey);
  return safety.keys.some((key) =>
    metricTermsMatch(normalizeMetricPhrase(key.from), normalizedKey)
    || metricTermsMatch(normalizeMetricPhrase(key.to), normalizedKey));
}

type RelationshipJoinAuthority = 'governed' | 'exploratory';

function relationshipSafetyAllowsJoin(
  safety: AgentRelationshipSafetyEvidence,
  authority: RelationshipJoinAuthority,
  requiredJoinKey?: string,
): boolean {
  return authority === 'governed'
    ? relationshipSafetyAllowsAutomaticJoin(safety, requiredJoinKey)
    : relationshipSafetyAllowsExploratoryJoin(safety, requiredJoinKey);
}

function safeRelationshipProofsForCandidate(
  candidate: AgentEvidenceCandidate,
  requiredJoinKey?: string,
  authority: RelationshipJoinAuthority = 'governed',
): Map<string, AgentRelationshipSafetyEvidence> {
  const referenced = new Set((candidate.relationshipEvidence ?? []).map(normalizedRelationshipIdentity));
  const proofs = new Map<string, AgentRelationshipSafetyEvidence>();
  for (const safety of candidate.relationshipSafety ?? []) {
    if (!relationshipSafetyAllowsJoin(safety, authority, requiredJoinKey)) continue;
    if (!relationshipSafetyIdentities(safety).some((identity) => referenced.has(identity))) continue;
    proofs.set(safety.id, safety);
  }
  return proofs;
}

function candidateRelationshipEndpoints(candidate: AgentEvidenceCandidate): Set<string> {
  return new Set([
    ...(candidate.relationshipEndpointIds ?? []),
    candidate.primaryEntity ?? '',
    candidate.analyticalCapability?.primaryEntityId ?? '',
  ].map(normalizedRelationshipIdentity).filter(Boolean));
}

/**
 * An attribution-required relationship is intentionally not a generic join
 * failure.  It becomes terminal only when the user explicitly asks to rank an
 * un-attributed/attribution-scoped signal and the same immutable snapshot
 * proves that getting from that signal to the requested entity would require
 * the declared attribution edge.  This keeps neutral unsafe relationship
 * evidence available for the normal clarification path (AGT-029), while
 * preventing a bare-ranking metric picker from masking a known governance
 * boundary with unrelated options.
 */
const EXPLICIT_ATTRIBUTION_REQUEST_RE = /\b(?:un[-\s]?attributed|attribution|allocation|allocate)\b/i;

function relationshipEndpointMatchesQuestionConcept(endpoint: string, question: string): boolean {
  const leaf = normalizedRelationshipIdentity(endpoint).split('::').at(-1) ?? endpoint;
  const concept = normalizeMetricPhrase(leaf);
  const conceptTokens = substantiveLexicalTokens(concept);
  const questionTokens = new Set(substantiveLexicalTokens(question));
  return conceptTokens.length >= 2 && conceptTokens.every((token) => questionTokens.has(token));
}

function relationshipEndpointMatchesEntityTerms(
  endpoint: string,
  entityTerms: readonly string[],
): boolean {
  const normalizedEndpoint = normalizeMetricPhrase(endpoint);
  return entityTerms.some((term) => metricTermsMatch(normalizedEndpoint, normalizeMetricPhrase(term)));
}

function relationshipGraphReaches(
  starts: ReadonlySet<string>,
  targets: ReadonlySet<string>,
  relationships: readonly AgentRelationshipSafetyEvidence[],
): boolean {
  if (starts.size === 0 || targets.size === 0) return false;
  const graph = new Map<string, Set<string>>();
  for (const relationship of relationships) {
    const from = normalizedRelationshipIdentity(relationship.from ?? '');
    const to = normalizedRelationshipIdentity(relationship.to ?? '');
    if (!from || !to) continue;
    const fromNeighbors = graph.get(from) ?? new Set<string>();
    fromNeighbors.add(to);
    graph.set(from, fromNeighbors);
    const toNeighbors = graph.get(to) ?? new Set<string>();
    toNeighbors.add(from);
    graph.set(to, toNeighbors);
  }
  const pending = [...starts];
  const visited = new Set(pending);
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (targets.has(current)) return true;
    for (const next of graph.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        pending.push(next);
      }
    }
  }
  return false;
}

function attributionRequiredRelationshipGapDecision(input: {
  request: AgentRunRequest;
  base: IntentDecision;
  evidence: AgentRetrievalEvidence;
  requirements: AnalyticalRequirementSetV1;
}): IntentDecision | undefined {
  if (!EXPLICIT_ATTRIBUTION_REQUEST_RE.test(input.request.question)
    || input.requirements.entityTerms.length === 0) return undefined;

  // Use the complete same-snapshot retrieval result. The compact provider
  // package is intentionally allowed to omit a relationship card; omission
  // cannot erase an authored governance restriction before it is evaluated.
  const snapshotCandidates = [
    ...input.evidence.candidates,
    ...(input.evidence.clarificationCandidates ?? []),
  ].filter((candidate, index, all) => all.findIndex((other) => other.id === candidate.id) === index);
  const relationships = [...new Map(snapshotCandidates
    .flatMap((candidate) => candidate.relationshipSafety ?? [])
    .map((relationship) => [relationship.id, relationship] as const)).values()]
    .filter((relationship) => Boolean(relationship.from?.trim() && relationship.to?.trim()));
  const attributionRequired = relationships.filter((relationship) => relationship.fanout === 'attribution_required');
  if (attributionRequired.length === 0) return undefined;

  const targetEndpoints = new Set(snapshotCandidates
    .flatMap((candidate) => [...candidateRelationshipEndpoints(candidate)])
    .filter((endpoint) => relationshipEndpointMatchesEntityTerms(endpoint, input.requirements.entityTerms)));
  if (targetEndpoints.size === 0) return undefined;

  const attributed = attributionRequired.find((relationship) => {
    const endpoints = [
      normalizedRelationshipIdentity(relationship.from ?? ''),
      normalizedRelationshipIdentity(relationship.to ?? ''),
    ].filter(Boolean);
    const requestedSignalEndpoints = new Set(endpoints.filter((endpoint) =>
      relationshipEndpointMatchesQuestionConcept(endpoint, input.request.question)));
    if (requestedSignalEndpoints.size === 0) return false;
    // The declared graph can demonstrate why the requested entity would need
    // this relation, but only a fully certified/fanout-safe graph may
    // authorize automatic composition. A path that requires this edge is a
    // typed modeling gap, never a reason to invent an attribution join.
    const allReachable = relationshipGraphReaches(requestedSignalEndpoints, targetEndpoints, relationships);
    const safeRelationships = relationships.filter((candidate) => relationshipSafetyAllowsAutomaticJoin(candidate));
    const safelyReachable = relationshipGraphReaches(requestedSignalEndpoints, targetEndpoints, safeRelationships);
    return allReachable && !safelyReachable;
  });
  if (!attributed) return undefined;

  const coverage = sourceCoverageFromEvidence(input.evidence, snapshotCandidates);
  const coverageFor = (source: Extract<ContextSourceCoverageV1['source'], 'certified' | 'semantic'>) =>
    coverage.find((item) => item.source === source);
  const skipped = (tier: Extract<CascadeTierAttemptV1['tier'], 'certified' | 'semantic'>): CascadeTierAttemptV1 => {
    const item = coverageFor(tier);
    return {
      version: 1,
      tier,
      outcome: item?.status === 'available' ? 'ineligible' : 'unavailable',
      candidateIds: item?.candidateIds ?? [],
      reason: item?.status === 'available'
        ? `The ${tier} tier did not prove the complete attribution-safe requested tuple before plan freeze.`
        : `The ${tier} source was ${item?.status ?? 'unavailable'} in this snapshot.`,
      planFrozen: false,
    };
  };
  const message = 'The requested un-attributed signal requires a certified attribution relationship or approved allocation policy before it can be ranked by the requested entity. DQL did not infer a relationship or execute a query.';
  const witnessCandidateIds = [attributed.id];
  const terminalGap: AnalyticalTerminalGapWitness = {
    code: 'MISSING_RELATIONSHIP',
    missing: ['a certified attribution relationship or approved allocation policy for the requested un-attributed signal'],
    witnessCandidateIds,
  };
  const observer = askTraceObserverForV1(input.request);
  for (const candidate of snapshotCandidates.filter((candidate) =>
    (candidate.relationshipSafety ?? []).some((relationship) => relationship.id === attributed.id))) {
    observer.recordCandidateDecision({
      candidateId: candidate.id,
      role: 'relationship',
      source: traceSourceForCandidate(candidate),
      decision: 'excluded',
      reasonCode: 'policy_denied',
      compatibilityCode: 'unknown',
    });
  }
  return {
    ...input.base,
    action: 'block',
    confidence: 1,
    reason: message,
    source: 'heuristic',
    category: 'data_lookup',
    depth: 'quick',
    requiresClarification: false,
    clarifyingQuestion: undefined,
    clarificationOptions: undefined,
    retrievalEvidence: retrievalTrace(input.evidence, snapshotCandidates),
    terminalOutcome: {
      kind: 'modeling_gap',
      code: 'ANALYTICAL_MODELING_GAP',
      message,
      candidateIds: witnessCandidateIds,
      gap: terminalGap,
    },
    analyticalCascadeDecision: buildAnalyticalCascadeDecision({
      requirements: input.requirements,
      sourceCoverage: coverage,
      attempts: [
        skipped('certified'),
        skipped('semantic'),
        {
          version: 1,
          tier: 'governed_relational',
          outcome: 'denied',
          candidateIds: witnessCandidateIds,
          reason: 'The declared relationship requires attribution or allocation approval and cannot authorize the requested ranking.',
          planFrozen: false,
        },
      ],
      planFrozen: false,
      terminalGap: cascadeTerminalRelationshipGap(terminalGap),
      stopReason: 'denied',
    }),
    resolvedAnalyticalPlan: undefined,
    meaningResolution: undefined,
  };
}

/**
 * A proof may be structurally safe yet belong to a different domain's relation
 * with the same leaf name. The selected pair must match the proof's canonical
 * endpoints in either direction before it can close an exploratory join.
 */
function relationshipProofMatchesSelectedPair(
  safety: AgentRelationshipSafetyEvidence,
  left: AgentEvidenceCandidate,
  right: AgentEvidenceCandidate,
): boolean {
  const leftEndpoints = candidateRelationshipEndpoints(left);
  const rightEndpoints = candidateRelationshipEndpoints(right);
  const from = normalizedRelationshipIdentity(safety.from ?? '');
  const to = normalizedRelationshipIdentity(safety.to ?? '');
  return Boolean(from && to && (
    (leftEndpoints.has(from) && rightEndpoints.has(to))
    || (leftEndpoints.has(to) && rightEndpoints.has(from))
  ));
}

function safeRelationshipProofsForPair(
  left: AgentEvidenceCandidate,
  right: AgentEvidenceCandidate,
  requiredJoinKey?: string,
  authority: RelationshipJoinAuthority = 'governed',
): Map<string, AgentRelationshipSafetyEvidence> {
  const leftProofs = safeRelationshipProofsForCandidate(left, requiredJoinKey, authority);
  const rightProofs = safeRelationshipProofsForCandidate(right, requiredJoinKey, authority);
  const shared = new Map<string, AgentRelationshipSafetyEvidence>();
  for (const [id, proof] of leftProofs) {
    const pairedProof = rightProofs.get(id);
    if (!pairedProof
      || !relationshipProofMatchesSelectedPair(proof, left, right)
      || !relationshipProofMatchesSelectedPair(pairedProof, left, right)) continue;
    shared.set(id, proof);
  }
  return shared;
}

type ExploratoryPhysicalPath = {
  ok: boolean;
  candidateIds: string[];
  reason: string;
  /** Present only when structured physical/relationship evidence proves the gap category. */
  gap?: AnalyticalTerminalGapWitness;
};

function hasSafeExploratoryPhysicalPath(
  requirements: ReturnType<typeof buildAnalyticalRequirementSet>,
  candidates: AgentEvidenceCandidate[],
  missingDimensions: string[],
  requiredPhysicalFieldTerms: string[] = [],
): ExploratoryPhysicalPath {
  const physical = candidates.filter((candidate) => candidate.eligible !== false
    && candidate.compatibility !== 'incompatible'
    && (candidate.kind === 'dbt_model' || candidate.kind === 'dbt_source' || candidate.kind === 'sql_table' || candidate.kind === 'sql_column'));
  const relations = physical.filter((candidate) => candidate.kind !== 'sql_column');
  const columns = physical.filter((candidate) => candidate.kind === 'sql_column');
  if (relations.length === 0 || columns.length === 0) {
    return { ok: false, candidateIds: [], reason: 'No qualified raw relation plus column coverage was retrieved from this snapshot.' };
  }
  // This list is intentionally field/role-only.  Filter values such as
  // `Datadog`, `FY26`, or `true` are member constraints, not column names;
  // their safe-value validation happens independently from proving the raw
  // physical closure.  Treating them as fields made a valid relation appear
  // unmodeled and produced a false absence diagnostic.
  const terms = [...new Set([
    ...missingDimensions,
    ...requirements.measures,
    ...requirements.entityDisplayTerms,
    ...(requirements.outputTerms ?? []),
    ...requiredPhysicalFieldTerms,
  ]
    .map(normalizeMetricPhrase)
    .filter(Boolean))];
  if (terms.length === 0) {
    return { ok: false, candidateIds: [], reason: 'No typed physical fields were available to prove an exploratory plan.' };
  }

  const relationSources = (relation: AgentEvidenceCandidate): string[] =>
    relation.sourceObjects?.length ? relation.sourceObjects : [relation.qualifiedId ?? relation.id];
  const columnTouchesRelation = (column: AgentEvidenceCandidate, relation: AgentEvidenceCandidate): boolean =>
    column.sourceObjects?.length
      ? column.sourceObjects.some((source) => relationSources(relation).includes(source))
      // A source that omitted its column edge cannot substantiate a multi-table
      // plan. It remains usable only when a single relation is selected.
      : relations.length === 1;
  const columnFieldIdentityTerms = (column: AgentEvidenceCandidate): string[] => uniqueNormalizedTerms([
    column.name,
    ...(column.aliases ?? []),
    ...(column.dimensions ?? []),
  ]);
  // These are intentionally a tiny, role-only bridge for raw physical
  // evidence. They are evaluated against a column's own name/aliases in this
  // immutable snapshot; they neither infer a relation nor turn a member value
  // into a column. The aliases cover common authored field terminology in the
  // supplied dbt/runtime schema (`product category` -> `product_type`, and a
  // product-level revenue ask -> `product_price`).
  const hasProductCategoryRequirement = [
    ...requirements.dimensions,
    ...missingDimensions,
    ...requiredPhysicalFieldTerms,
  ].some((term) => ['product category', 'category'].includes(normalizeMetricPhrase(term)));
  const physicalRoleAliases: Readonly<Record<string, readonly string[]>> = {
    'product category': ['product type'],
    category: ['product type'],
    customer: ['customer name'],
    account: ['account name'],
    // `product_price` is a local revenue witness only when the same request
    // also requires product-category grain. It must not let a bare selected
    // revenue metric bypass its semantic contract through an unrelated raw
    // price column.
    ...(hasProductCategoryRequirement ? { revenue: ['product price'] } : {}),
  };
  const physicalRoleTerms = (term: string): string[] => uniqueNormalizedTerms([
    term,
    ...(physicalRoleAliases[normalizeMetricPhrase(term)] ?? []),
  ]);
  const columnMatchesTerm = (column: AgentEvidenceCandidate, term: string): boolean =>
    // A relation-qualified ID can contain a metric word even when the column
    // itself does not.  Raw `fact_revenue.competitor` is not revenue evidence.
    // Physical role proof therefore starts with field-local name/alias facts,
    // never a parent relation token.
    columnFieldIdentityTerms(column).some((identity) =>
      physicalRoleTerms(term).some((role) => metricTermsMatch(identity, role)));
  const matchingColumns = new Map<string, AgentEvidenceCandidate[]>(terms.map((term) => [
    term,
    columns.filter((column) => columnMatchesTerm(column, term)),
  ]));
  const uncovered = terms.filter((term) => (matchingColumns.get(term) ?? []).length === 0);
  if (uncovered.length > 0) {
    return { ok: false, candidateIds: [], reason: `Qualified physical columns did not cover ${uncovered.join(', ')}.` };
  }

  const stableCandidateId = (candidate: AgentEvidenceCandidate): string => candidate.qualifiedId ?? candidate.id;
  const stableCandidates = (values: AgentEvidenceCandidate[]): AgentEvidenceCandidate[] =>
    [...values].sort((left, right) =>
      Number(right.exactMatch === true) - Number(left.exactMatch === true)
      || right.relevanceScore - left.relevanceScore
      || stableCandidateId(left).localeCompare(stableCandidateId(right)));
  const stableColumnsForTerm = (
    values: AgentEvidenceCandidate[],
    term: string,
  ): AgentEvidenceCandidate[] =>
    [...values].sort((left, right) => {
      const rank = (column: AgentEvidenceCandidate): number => {
        const identities = columnFieldIdentityTerms(column);
        if (identities.some((identity) => identity === term)) return 0;
        if (identities.some((identity) => metricTermsMatch(identity, term))) return 1;
        return 2;
      };
      return rank(left) - rank(right)
        || Number(right.exactMatch === true) - Number(left.exactMatch === true)
        || right.relevanceScore - left.relevanceScore
        || stableCandidateId(left).localeCompare(stableCandidateId(right));
    });
  const relationCoverage = relations.map((relation) => new Set(
    terms.filter((term) => (matchingColumns.get(term) ?? []).some((column) => columnTouchesRelation(column, relation))),
  ));
  const selectRequiredColumns = (
    selectedRelations: AgentEvidenceCandidate[],
  ): AgentEvidenceCandidate[] | undefined => {
    const selected = new Map<string, AgentEvidenceCandidate>();
    for (const term of [...terms].sort()) {
      const alreadySelected = [...selected.values()].some((column) => columnMatchesTerm(column, term));
      if (alreadySelected) continue;
      const matches = stableColumnsForTerm((matchingColumns.get(term) ?? []).filter((column) =>
        selectedRelations.some((relation) => columnTouchesRelation(column, relation))), term);
      const selectedColumn = matches[0];
      if (!selectedColumn) return undefined;
      selected.set(stableCandidateId(selectedColumn), selectedColumn);
    }
    return [...selected.values()];
  };
  const physicalEvidence = (
    selectedRelations: AgentEvidenceCandidate[],
    requiredColumns: AgentEvidenceCandidate[],
    joinColumns: AgentEvidenceCandidate[],
    relationshipProofIds: string[],
    reason: string,
  ): { ok: boolean; candidateIds: string[]; reason: string } => {
    // Keep one deterministic witness for every requested role, then the
    // necessary join-key witnesses and proof identities.  Do not add an
    // entire table schema: that used to hide required columns behind a broad
    // 32-card truncation.  If the minimal evidence itself exceeds the cap,
    // decline the path rather than silently dropping a required witness.
    const ids = [...new Set([
      ...stableCandidates(selectedRelations).map(stableCandidateId),
      ...stableCandidates(requiredColumns).map(stableCandidateId),
      ...stableCandidates(joinColumns).map(stableCandidateId),
      ...[...relationshipProofIds].sort(),
    ])];
    if (ids.length > 32) {
      return {
        ok: false,
        candidateIds: [],
        reason: `The minimal qualified exploratory closure needs ${ids.length} required relation, field, join-key, or proof witnesses, exceeding the 32-card safety cap; no required evidence was dropped.`,
      };
    }
    return { ok: true, candidateIds: ids, reason };
  };
  const completeRelation = relationCoverage
    .map((coverage, index) => ({ coverage, index }))
    .filter(({ coverage }) => coverage.size === terms.length)
    .sort((left, right) => stableCandidateId(relations[left.index]!).localeCompare(stableCandidateId(relations[right.index]!)))[0];
  if (completeRelation) {
    const relation = relations[completeRelation.index]!;
    const requiredColumns = selectRequiredColumns([relation]);
    if (!requiredColumns) {
      return { ok: false, candidateIds: [], reason: 'Qualified physical columns did not cover the requested fields on the selected relation.' };
    }
    return physicalEvidence(
      [relation],
      requiredColumns,
      [],
      [],
      'One qualified physical relation covers the requested fields without a join.',
    );
  }

  // Build only from structured relationship proofs. A large retrieval snapshot
  // routinely contains unrelated raw tables; requiring every one to join made
  // a complete local path appear unavailable. Conversely, never infer a join
  // from names or shared column strings: the proof must retain the structured
  // exploratory-safe disposition above. A selected path remains
  // review-required; it is not a governed relational plan.
  const adjacent = relations.map(() => new Set<number>());
  type SafeJoinWitness = {
    proof: AgentRelationshipSafetyEvidence;
    columns: AgentEvidenceCandidate[];
  };
  const joinColumnsForProof = (
    proof: AgentRelationshipSafetyEvidence,
    left: AgentEvidenceCandidate,
    right: AgentEvidenceCandidate,
  ): AgentEvidenceCandidate[] | undefined => {
    const leftEndpoints = candidateRelationshipEndpoints(left);
    const rightEndpoints = candidateRelationshipEndpoints(right);
    const from = normalizedRelationshipIdentity(proof.from ?? '');
    const to = normalizedRelationshipIdentity(proof.to ?? '');
    const direct = leftEndpoints.has(from) && rightEndpoints.has(to);
    const reverse = leftEndpoints.has(to) && rightEndpoints.has(from);
    if (!direct && !reverse) return undefined;
    const witnesses = new Map<string, AgentEvidenceCandidate>();
    for (const key of proof.keys) {
      const leftKey = normalizeMetricPhrase(direct ? key.from : key.to);
      const rightKey = normalizeMetricPhrase(direct ? key.to : key.from);
      const leftColumn = stableColumnsForTerm(columns.filter((column) =>
        columnTouchesRelation(column, left)
        && columnMatchesTerm(column, leftKey)), leftKey)[0];
      const rightColumn = stableColumnsForTerm(columns.filter((column) =>
        columnTouchesRelation(column, right)
        && columnMatchesTerm(column, rightKey)), rightKey)[0];
      // A relationship record alone cannot prove a compilable raw join.  Both
      // canonical endpoint columns must be present in this same snapshot.
      if (!leftColumn || !rightColumn) return undefined;
      witnesses.set(stableCandidateId(leftColumn), leftColumn);
      witnesses.set(stableCandidateId(rightColumn), rightColumn);
    }
    return [...witnesses.values()];
  };
  const witnessesForEdge = new Map<string, SafeJoinWitness[]>();
  for (let left = 0; left < relations.length; left += 1) {
    for (let right = left + 1; right < relations.length; right += 1) {
      const shared = [...safeRelationshipProofsForPair(
        relations[left]!,
        relations[right]!,
        undefined,
        'exploratory',
      ).values()]
        .sort((first, second) => first.id.localeCompare(second.id))
        .flatMap((proof) => {
          const joinColumns = joinColumnsForProof(proof, relations[left]!, relations[right]!);
          return joinColumns ? [{ proof, columns: joinColumns }] : [];
        });
      if (shared.length === 0) continue;
      adjacent[left]!.add(right);
      adjacent[right]!.add(left);
      witnessesForEdge.set(`${Math.min(left, right)}:${Math.max(left, right)}`, shared);
    }
  }

  type SafeClosure = { nodes: Set<number>; edges: Array<[number, number]>; covered: Set<string> };
  const closures: SafeClosure[] = [];
  for (let root = 0; root < relations.length; root += 1) {
    const nodes = new Set<number>([root]);
    const edges: Array<[number, number]> = [];
    const covered = new Set(relationCoverage[root]);
    while (covered.size < terms.length) {
      let best: { path: number[]; gain: number; distance: number } | undefined;
      const pending: Array<{ node: number; path: number[] }> = [{ node: root, path: [root] }];
      const seen = new Set<number>([root]);
      while (pending.length > 0) {
        const current = pending.shift()!;
        const gain = [...relationCoverage[current.node]!].filter((term) => !covered.has(term)).length;
        if (gain > 0 && (!best || gain > best.gain || (gain === best.gain && current.path.length < best.distance))) {
          best = { path: current.path, gain, distance: current.path.length };
        }
        for (const neighbor of adjacent[current.node] ?? []) {
          if (seen.has(neighbor)) continue;
          seen.add(neighbor);
          pending.push({ node: neighbor, path: [...current.path, neighbor] });
        }
      }
      if (!best) break;
      for (const node of best.path) {
        nodes.add(node);
        for (const term of relationCoverage[node]!) covered.add(term);
      }
      for (let index = 1; index < best.path.length; index += 1) {
        const left = best.path[index - 1]!;
        const right = best.path[index]!;
        if (!edges.some(([edgeLeft, edgeRight]) => edgeLeft === left && edgeRight === right || edgeLeft === right && edgeRight === left)) {
          edges.push([left, right]);
        }
      }
    }
    if (covered.size === terms.length) closures.push({ nodes, edges, covered });
  }
  const selected = closures.sort((left, right) =>
    left.nodes.size - right.nodes.size
    || left.edges.length - right.edges.length
    || [...left.nodes].join(',').localeCompare([...right.nodes].join(',')),
  )[0];
  if (!selected) {
    return {
      ok: false,
      candidateIds: [],
      reason: 'Multiple physical relations lacked one connected, structured, fanout-safe exploratory join path.',
      // This is not a lexical conclusion. Every requested physical field was
      // found above, no one relation covered the tuple, and the structured
      // relationship/fanout proof graph could not connect the required
      // relations. Preserve that proof-specific category for downstream
      // receipts and repair guidance.
      gap: {
        code: 'MISSING_RELATIONSHIP',
        missing: ['a connected, explicitly allowed, validated, fanout-safe relationship proof'],
        witnessCandidateIds: stableCandidates(relations).map(stableCandidateId),
      },
    };
  }
  const selectedRelations = [...selected.nodes].map((index) => relations[index]!);
  const requiredColumns = selectRequiredColumns(selectedRelations);
  if (!requiredColumns) {
    return { ok: false, candidateIds: [], reason: 'Qualified physical columns did not cover the requested fields on the selected relationship closure.' };
  }
  const selectedWitnesses = selected.edges.map(([left, right]) =>
    witnessesForEdge.get(`${Math.min(left, right)}:${Math.max(left, right)}`)?.[0]).filter((witness): witness is SafeJoinWitness => Boolean(witness));
  if (selectedWitnesses.length !== selected.edges.length) {
    return { ok: false, candidateIds: [], reason: 'The selected relationship closure lacked qualified join-key witnesses for every automatic join.' };
  }
  return physicalEvidence(
    selectedRelations,
    requiredColumns,
    selectedWitnesses.flatMap((witness) => witness.columns),
    selectedWitnesses.map((witness) => witness.proof.id),
    'Qualified physical relations and explicitly allowed relationship proofs support a bounded exploratory plan.',
  );
}

/**
 * The pre-freeze cascade is router authority, including when the bounded
 * meaning call could not run.  A missing role in a compact meaning package is
 * not terminal proof of absence: eligible certified/semantic tiers are marked
 * ineligible, then the same immutable snapshot may prove a review-required
 * physical path.  Policy, fiscal, and relationship safety gates run before
 * this helper and remain terminal where appropriate.
 */
function preFreezePhysicalCascadeDecision(input: {
  base: IntentDecision;
  evidence: AgentRetrievalEvidence;
  candidates: AgentEvidenceCandidate[];
  question: string;
  requirements: AnalyticalRequirementSetV1;
  missingTerms: string[];
  requiredPhysicalFieldTerms?: string[];
  messagePrefix: string;
  terminalCandidateIds?: string[];
  /** A bare ranking can inspect physical safety, but cannot invent its measure. */
  requireRankingMetric?: boolean;
}): IntentDecision {
  // `candidates` can be the capped meaning package. Physical eligibility is
  // allowed one same-snapshot extension, never a new retrieval/domain scope.
  const snapshotCandidates = immutableSnapshotCandidates(input.evidence, input.candidates);
  const physicalPath = hasSafeExploratoryPhysicalPath(
    input.requirements,
    snapshotCandidates,
    input.missingTerms,
    input.requiredPhysicalFieldTerms ?? [],
  );
  const missingRankingMetric = Boolean(physicalPath.ok
    && input.requireRankingMetric
    && input.requirements.ranking
    && input.requirements.ranking.metricTerms.length === 0);
  const exploratoryExecutable = physicalPath.ok && !missingRankingMetric;
  const selectedPhysicalLegacyIds = snapshotCandidates
    .filter((candidate) => physicalPath.candidateIds.includes(candidate.qualifiedId ?? candidate.id))
    .map((candidate) => candidate.id);
  const selectedPhysicalIdsForPlan = selectedPhysicalLegacyIds.length > 0
    ? selectedPhysicalLegacyIds
    : physicalPath.candidateIds;
  // The physical cascade is still an authoritative Ask route, not a legacy
  // escape hatch. Recreate the same host-owned seed used before the meaning
  // call so a semantic miss cannot erase an explicit entity display key,
  // member/filter, ranking limit, time role, or output tuple on the way to
  // review-required exploration.
  const hostRequirementSeed = buildAnalyticalRequirementSeedV1({
    question: input.question,
    parsedIntent: input.evidence.parsedIntent,
    requirements: input.requirements,
    fiscalCalendar: declaredFiscalCalendar(input.evidence, snapshotCandidates),
  });
  // The router, not the SQL generator, owns analytical meaning and the
  // physical closure.  Freeze that selected exploratory plan before a model
  // sees SQL work.  The host later attaches an authorization receipt for the
  // exact read-only SQL/target; it must never be the event that changes the
  // selected tier or reinterprets this request.
  const exploratoryMeaning: MeaningResolution | undefined = exploratoryExecutable
    ? {
        interpretedQuestion: input.question,
        questionType: questionTypeFromText(input.question),
        selectedConceptIds: selectedPhysicalIdsForPlan,
        recommendedExecutionId: selectedPhysicalIdsForPlan[0],
        queryIntent: queryIntentFromRequirementSeed(hostRequirementSeed),
        rejectedCandidates: [],
        // Low confidence is intentionally non-executable in a resolved plan.
        // This is a router-proven physical closure, not a speculative model
        // answer, so the confidence describes the selected route only.
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'exploratory',
        hostRequirementSeed,
        compatibilityOutcome: 'modeling_gap',
        compatibilityFailures: input.missingTerms.map((term) => ({
          code: 'MISSING_DIMENSION' as const,
          field: term,
          message: `${term} was not complete in the earlier governed tiers.`,
          candidateIds: [],
        })),
      }
    : undefined;
  const resolvedAnalyticalPlan = exploratoryMeaning
    ? buildResolvedAnalyticalPlan({
        question: input.question,
        resolution: exploratoryMeaning,
        evidence: input.evidence,
        candidates: snapshotCandidates,
        mode: 'authoritative',
      })
    : undefined;
  const exploratoryPlanFrozen = resolvedAnalyticalPlan?.capability === 'bounded_exploration';
  const coverage = sourceCoverageFromEvidence(input.evidence, snapshotCandidates);
  const coverageFor = (source: ContextSourceCoverageV1['source']) => coverage.find((item) => item.source === source);
  const skippedAttempt = (
    tier: Extract<CascadeTierAttemptV1['tier'], 'certified' | 'semantic'>,
    source: Extract<ContextSourceCoverageV1['source'], 'certified' | 'semantic'>,
  ): CascadeTierAttemptV1 => {
    const item = coverageFor(source);
    return {
      version: 1,
      tier,
      outcome: item?.status === 'available' ? 'ineligible' : 'unavailable',
      candidateIds: item?.candidateIds ?? [],
      reason: item?.status === 'available'
        ? `The ${tier} tier did not prove the complete requested tuple before plan freeze.`
        : `The ${tier} source was ${item?.status ?? 'unavailable'} in this snapshot.`,
      planFrozen: false,
    };
  };
  const governedCoverage = coverageFor('governed_relational');
  const attempts: CascadeTierAttemptV1[] = [
    skippedAttempt('certified', 'certified'),
    skippedAttempt('semantic', 'semantic'),
    {
      version: 1,
      tier: 'governed_relational',
      outcome: governedCoverage?.status === 'available' ? 'ineligible' : 'unavailable',
      candidateIds: governedCoverage?.candidateIds ?? [],
      reason: governedCoverage?.status === 'available'
        ? 'Retrieved governed relationship evidence did not prove a complete relational execution tuple.'
        : `The governed relational source was ${governedCoverage?.status ?? 'unavailable'}; exploratory eligibility is evaluated independently.`,
      planFrozen: false,
    },
    {
      version: 1,
      tier: 'exploratory_sql',
      outcome: exploratoryExecutable ? 'executable' : missingRankingMetric ? 'ambiguous' : 'unavailable',
      candidateIds: physicalPath.candidateIds,
      reason: missingRankingMetric
        ? `${physicalPath.reason} A ranking measure remains unbound, so exploration cannot be selected.`
        : physicalPath.reason,
      planFrozen: exploratoryPlanFrozen,
    },
  ];
  const message = exploratoryExecutable
    ? `${input.messagePrefix} A same-snapshot qualified physical path is available for review-required exploratory SQL.`
    : missingRankingMetric
      ? `${input.messagePrefix} ${physicalPath.reason} A ranking measure must be selected before DQL can freeze or explore this plan.`
      : `${input.messagePrefix} ${physicalPath.reason}`;
  const analyticalCascadeDecision = buildAnalyticalCascadeDecision({
    requirements: input.requirements,
    sourceCoverage: coverage,
    attempts: exploratoryExecutable
      ? attempts
      : [...attempts, {
          version: 1,
          tier: 'clarify_or_gap',
          outcome: 'unavailable',
          candidateIds: [],
          reason: message,
          planFrozen: false,
        }],
    ...(exploratoryExecutable ? { selectedTier: 'exploratory_sql' as const } : {}),
    planFrozen: exploratoryPlanFrozen,
    stopReason: exploratoryExecutable ? 'selected' : missingRankingMetric ? 'ambiguous' : 'coverage_gap',
  });
  if (!exploratoryExecutable) {
    return {
      ...input.base,
      action: 'block',
      confidence: 1,
      reason: message,
      source: 'heuristic',
      category: 'data_lookup',
      depth: 'quick',
      requiresClarification: false,
      clarifyingQuestion: undefined,
      clarificationOptions: undefined,
      retrievalEvidence: retrievalTrace(input.evidence, snapshotCandidates),
      terminalOutcome: {
        kind: 'modeling_gap',
        code: 'ANALYTICAL_MODELING_GAP',
        message,
        candidateIds: input.terminalCandidateIds ?? [],
        ...(physicalPath.gap ? { gap: physicalPath.gap } : {}),
      },
      analyticalCascadeDecision,
      resolvedAnalyticalPlan: undefined,
      meaningResolution: undefined,
    };
  }
  return {
    ...input.base,
    action: 'answer',
    confidence: 0.55,
    reason: message,
    source: 'heuristic',
    category: 'data_lookup',
    depth: 'quick',
    requiresClarification: false,
    clarifyingQuestion: undefined,
    clarificationOptions: undefined,
    retrievalEvidence: retrievalTrace(input.evidence, snapshotCandidates),
    analyticalCascadeDecision,
    meaningResolution: exploratoryMeaning,
    resolvedAnalyticalPlan,
  };
}

/**
 * The compact meaning package is deliberately not a proof-of-absence set.
 * Preserve the complete immutable retrieval snapshot for physical closure and
 * structured-continuation checks, while retaining a caller's server-issued
 * selection when it was supplied as a same-snapshot clarification card.
 */
function immutableSnapshotCandidates(
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate[] {
  const byId = new Map<string, AgentEvidenceCandidate>();
  for (const candidate of [
    ...evidence.candidates,
    ...(evidence.clarificationCandidates ?? []),
    ...candidates,
  ]) {
    if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
  }
  return [...byId.values()];
}

/**
 * A normal meaning call may nominate either a semantic metric or a governed
 * modeling card whose declared execution contract cannot satisfy the exact
 * tuple.  Before presenting that *pre-freeze* modeling gap as terminal,
 * inspect the complete immutable snapshot for one bounded, relationship-safe
 * physical closure.  This is not a post-freeze downgrade: policy, fiscal, and
 * unsafe failures remain blocked and a safe result is explicitly
 * review-required exploratory work.
 */
function continuePreFreezeModelingGapThroughPhysicalSnapshot(input: {
  decision: IntentDecision;
  base: IntentDecision;
  evidence: AgentRetrievalEvidence;
  candidates: AgentEvidenceCandidate[];
  question: string;
}): IntentDecision {
  const { decision, evidence } = input;
  const plan = decision.resolvedAnalyticalPlan;
  if (!plan
    || decision.terminalOutcome?.kind !== 'modeling_gap'
    || decision.analyticalCascadeDecision?.planFrozen === true
    || (plan.recommendedRoute !== 'semantic' && plan.recommendedRoute !== 'governed_sql')) return decision;
  const selectedPreFreezeTier = plan.recommendedRoute;
  const requirements = buildAnalyticalRequirementSet({
    question: input.question,
    parsedIntent: input.evidence.parsedIntent,
  });
  const unresolved = plan.resolutionFailure?.bindings
    .filter((binding) => binding.status !== 'resolved')
    .map((binding) => binding.requested) ?? [];
  const missingTerms = [...new Set([
    ...unresolved,
    ...requirements.dimensions,
    ...requirements.entityTerms,
    ...requirements.entityDisplayTerms,
    ...(plan.outputContract.requiredOutputs ?? []).map((binding) => binding.requested),
  ])];
  const requiredPhysicalFieldTerms = [...new Set([
    ...requirements.dimensions,
    ...requirements.entityTerms,
    ...requirements.entityDisplayTerms,
    ...(plan.outputContract.requiredOutputs ?? []).map((binding) => binding.requested),
    ...(plan.query.filters ?? []).map((filter) => filter.field),
    ...unresolved,
  ])];
  const physicalContinuation = preFreezePhysicalCascadeDecision({
    base: input.base,
    evidence,
    candidates: immutableSnapshotCandidates(evidence, input.candidates),
    question: input.question,
    requirements,
    missingTerms,
    requiredPhysicalFieldTerms,
    messagePrefix: selectedPreFreezeTier === 'governed_sql'
      ? 'The selected governed relational interpretation did not prove a compiler-owned DQL projection before plan freeze.'
      : 'The selected semantic interpretation was pre-freeze-ineligible for the complete requested tuple.',
    terminalCandidateIds: plan.selectedConceptIds,
  });
  if (physicalContinuation.action === 'answer'
    && physicalContinuation.analyticalCascadeDecision?.selectedTier === 'exploratory_sql') {
    return physicalContinuation;
  }
  // The physical extension was considered and was not safe/executable. Keep
  // the original immutable semantic plan and its typed failure rather than
  // replacing it with a synthetic exploratory meaning; surface the full
  // snapshot cascade evidence so the terminal block explains why it could not
  // continue. This retains policy/unsafe/fiscal terminal semantics.
  return {
    ...decision,
    reason: physicalContinuation.reason,
    retrievalEvidence: physicalContinuation.retrievalEvidence,
    analyticalCascadeDecision: physicalContinuation.analyticalCascadeDecision,
    terminalOutcome: physicalContinuation.terminalOutcome ?? decision.terminalOutcome,
  };
}

/**
 * A pair of raw relations is not normally a reason to bypass a clarification:
 * `orders`, `customers`, and `products` can still be three competing meanings.
 * It is different when the reader asked for a display value from one relation
 * and a predicate that physically exists only on another relation.  In that
 * narrow case the evidence is complementary rather than competing.
 *
 * This helper is intentionally conservative.  It requires all of the
 * following from ONE retrieval snapshot before it can select review-required
 * exploration:
 *   - a display-shaped column (for example `product_name`),
 *   - a boolean/predicate-shaped column on a different relation (for example
 *     `is_perishable_supply`),
 *   - the same qualified join key on both relations, and
 *   - a shared, non-fanout relationship proof that touches those relations.
 *
 * That means a lexical collection of tables can never suppress a genuine
 * ambiguity.  The generated executor still validates read-only SQL and its
 * join/aggregation safety before anything runs.
 */
function findSafeComplementaryPhysicalComposition(
  question: string,
  candidates: AgentEvidenceCandidate[],
): {
  requirements: ReturnType<typeof buildAnalyticalRequirementSet>;
  candidateIds: string[];
  displayColumn: AgentEvidenceCandidate;
  predicateColumn: AgentEvidenceCandidate;
  joinKey: string;
  relationshipProofIds: string[];
  reason: string;
} | undefined {
  const physical = candidates.filter((candidate) => candidate.eligible !== false
    && candidate.compatibility !== 'incompatible'
    && (candidate.kind === 'dbt_model' || candidate.kind === 'dbt_source' || candidate.kind === 'sql_table' || candidate.kind === 'sql_column'));
  const relations = physical.filter((candidate) => candidate.kind !== 'sql_column');
  const columns = physical.filter((candidate) => candidate.kind === 'sql_column');
  if (relations.length < 2 || columns.length < 4) return undefined;

  const relationSources = (candidate: AgentEvidenceCandidate): string[] =>
    candidate.sourceObjects?.length
      ? candidate.sourceObjects
      : [candidate.qualifiedId ?? candidate.id];
  const relationForColumn = (column: AgentEvidenceCandidate): AgentEvidenceCandidate[] => {
    if (!column.sourceObjects?.length) return [];
    return relations.filter((relation) => relationSources(relation).some((source) => column.sourceObjects!.includes(source)));
  };
  const questionTokens = new Set(substantiveLexicalTokens(question).map(singularize));
  const candidateTokens = (candidate: AgentEvidenceCandidate): Set<string> => new Set(
    candidateIdentityTerms(candidate)
      .flatMap((identity) => identity.split(' '))
      .map(singularize)
      .filter(Boolean),
  );
  const matchesQuestion = (candidate: AgentEvidenceCandidate): string[] =>
    [...candidateTokens(candidate)].filter((token) => questionTokens.has(token));
  const displayColumns = columns.filter((column) => {
    const name = normalizeMetricPhrase(column.name);
    return /(?:^| )(?:name|label|title)(?:$| )/.test(name)
      && matchesQuestion(column).length > 0
      && relationForColumn(column).length > 0;
  });
  if (displayColumns.length === 0) return undefined;
  const displayTokens = new Set(displayColumns.flatMap(matchesQuestion));
  const predicateColumns = columns.filter((column) => {
    const name = normalizeMetricPhrase(column.name);
    // Predicate shape is required. A text field such as `supply_name` may be
    // lexically close to "supplies", but it is not proof of the requested
    // condition and must keep the ordinary clarification behavior.
    const predicateShape = /(?:^| )(?:is|has|flag|status|active|enabled)(?: |$)/.test(name);
    return predicateShape
      && matchesQuestion(column).some((token) => !displayTokens.has(token))
      && relationForColumn(column).length > 0;
  });
  if (predicateColumns.length === 0) return undefined;

  const columnJoinKeys = (column: AgentEvidenceCandidate): string[] => uniqueNormalizedTerms([
    column.name,
    ...(column.aliases ?? []),
  ]).filter((term) => /(?:^| )id$/.test(term));

  for (const displayColumn of displayColumns) {
    for (const displayRelation of relationForColumn(displayColumn)) {
      for (const predicateColumn of predicateColumns) {
        for (const predicateRelation of relationForColumn(predicateColumn)) {
          const displaySources = new Set(relationSources(displayRelation));
          if (relationSources(predicateRelation).some((source) => displaySources.has(source))) continue;
          const displayColumnsOnRelation = columns.filter((column) => relationForColumn(column).some((relation) => relation.id === displayRelation.id));
          const predicateColumnsOnRelation = columns.filter((column) => relationForColumn(column).some((relation) => relation.id === predicateRelation.id));
          const predicateJoinKeys = new Set(predicateColumnsOnRelation.flatMap(columnJoinKeys));
          const joinKey = displayColumnsOnRelation.flatMap(columnJoinKeys).find((key) => predicateJoinKeys.has(key));
          if (!joinKey) continue;
          const sharedRelationshipProofIds = [...safeRelationshipProofsForPair(
            displayRelation,
            predicateRelation,
            joinKey,
            'exploratory',
          ).keys()];
          if (sharedRelationshipProofIds.length === 0) continue;
          const selectedPhysical = [
            displayRelation,
            predicateRelation,
            ...displayColumnsOnRelation,
            ...predicateColumnsOnRelation,
          ].filter((candidate, index, all) => all.findIndex((other) => other.id === candidate.id) === index);
          const baseRequirements = buildAnalyticalRequirementSet({ question });
          const requirements = {
            ...baseRequirements,
            dimensions: uniqueNormalizedTerms([...baseRequirements.dimensions, displayColumn.name]),
            entityTerms: uniqueNormalizedTerms([...baseRequirements.entityTerms, ...matchesQuestion(displayColumn)]),
            entityDisplayTerms: uniqueNormalizedTerms([...baseRequirements.entityDisplayTerms, ...matchesQuestion(displayColumn)]),
            memberTerms: uniqueNormalizedTerms([...baseRequirements.memberTerms, predicateColumn.name]),
          };
          const physicalPath = hasSafeExploratoryPhysicalPath(
            requirements,
            selectedPhysical,
            [],
            [displayColumn.name, predicateColumn.name, joinKey],
          );
          if (!physicalPath.ok) continue;
          const relationshipCandidates = candidates.filter((candidate) =>
            sharedRelationshipProofIds.includes(candidate.id)
            || Boolean(candidate.qualifiedId && sharedRelationshipProofIds.includes(candidate.qualifiedId)));
          return {
            requirements,
            candidateIds: [...new Set([
              ...physicalPath.candidateIds,
              ...sharedRelationshipProofIds,
              ...relationshipCandidates.map((candidate) => candidate.qualifiedId ?? candidate.id),
            ])].slice(0, 32),
            displayColumn,
            predicateColumn,
            joinKey,
            relationshipProofIds: sharedRelationshipProofIds,
            reason: `Qualified ${displayRelation.name}.${displayColumn.name} and ${predicateRelation.name}.${predicateColumn.name} are complementary requirements joined by ${joinKey}; the shared relationship proof permits review-required exploration.`,
          };
        }
      }
    }
  }
  return undefined;
}

/** Build the router-owned cascade for a safe raw relational composition. */
function complementaryExploratoryDecision(
  base: IntentDecision,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
  question: string,
): IntentDecision | undefined {
  // Use all already-retrieved cards from the same snapshot. The bounded meaning
  // package can omit a supporting raw join column, but no new retrieval/domain
  // scope is opened here.
  const snapshotCandidates = immutableSnapshotCandidates(evidence, candidates);
  const composition = findSafeComplementaryPhysicalComposition(question, snapshotCandidates);
  if (!composition) return undefined;
  const coverage = sourceCoverageFromEvidence(evidence, snapshotCandidates);
  const exploratoryMeaning: MeaningResolution = {
    interpretedQuestion: question,
    questionType: questionTypeFromText(question),
    selectedConceptIds: composition.candidateIds,
    recommendedExecutionId: composition.displayColumn.qualifiedId ?? composition.displayColumn.id,
    queryIntent: {
      measures: [],
      dimensions: [composition.displayColumn.qualifiedId ?? composition.displayColumn.id],
      filters: [{
        field: composition.predicateColumn.qualifiedId ?? composition.predicateColumn.id,
        value: 'true',
      }],
    },
    rejectedCandidates: [],
    confidence: 'high',
    missingInformation: [],
    recommendedRoute: 'exploratory',
    compatibilityOutcome: 'modeling_gap',
  };
  const resolvedAnalyticalPlan = buildResolvedAnalyticalPlan({
    question,
    resolution: exploratoryMeaning,
    evidence,
    candidates: snapshotCandidates,
    mode: 'authoritative',
  });
  const exploratoryPlanFrozen = resolvedAnalyticalPlan.capability === 'bounded_exploration';
  if (!exploratoryPlanFrozen) return undefined;
  const coverageFor = (source: ContextSourceCoverageV1['source']) => coverage.find((item) => item.source === source);
  const skippedAttempt = (
    tier: CascadeTierAttemptV1['tier'],
    source: ContextSourceCoverageV1['source'],
    reason: string,
  ): CascadeTierAttemptV1 => {
    const item = coverageFor(source);
    return {
      version: 1,
      tier,
      outcome: item?.status === 'available' ? 'ineligible' : 'unavailable',
      candidateIds: item?.candidateIds ?? [],
      reason,
      planFrozen: false,
    };
  };
  const attempts: CascadeTierAttemptV1[] = [
    skippedAttempt('certified', 'certified', 'No certified candidate proved the composed display and predicate tuple.'),
    skippedAttempt('semantic', 'semantic', 'No semantic candidate proved the composed display and predicate tuple.'),
    {
      version: 1,
      tier: 'governed_relational',
      outcome: 'ineligible',
      candidateIds: [...new Set([
        ...(coverageFor('governed_relational')?.candidateIds ?? []),
        ...composition.relationshipProofIds,
      ])].slice(0, 32),
      reason: 'The same-snapshot relationship proof closes the physical path, but no complete governed relational execution tuple was retrieved.',
      planFrozen: false,
    },
    {
      version: 1,
      tier: 'exploratory_sql',
      outcome: 'executable',
      candidateIds: composition.candidateIds,
      reason: composition.reason,
      planFrozen: exploratoryPlanFrozen,
    },
  ];
  const analyticalCascadeDecision = buildAnalyticalCascadeDecision({
    requirements: composition.requirements,
    sourceCoverage: coverage,
    attempts,
    selectedTier: 'exploratory_sql',
    planFrozen: exploratoryPlanFrozen,
    stopReason: 'selected',
  });
  return {
    ...base,
    action: 'answer',
    confidence: 0.55,
    source: 'heuristic',
    category: 'data_lookup',
    depth: 'quick',
    reason: `${composition.reason} Certified and semantic execution did not freeze; generated SQL remains review_required.`,
    requiresClarification: false,
    retrievalEvidence: retrievalTrace(evidence, snapshotCandidates),
    analyticalCascadeDecision,
    resolvedAnalyticalPlan,
    meaningResolution: exploratoryMeaning,
  };
}

function cascadeForResolution(input: {
  evidence: AgentRetrievalEvidence;
  candidates: AgentEvidenceCandidate[];
  resolution: MeaningResolution;
  plan: ResolvedAnalyticalPlan;
  reconciliation: ReconciledPlanOutcome;
  question: string;
  terminalGap?: AnalyticalCascadeTerminalGapV1;
}): AnalyticalCascadeDecisionV1 {
  const coverage = sourceCoverageFromEvidence(input.evidence, input.candidates);
  const coverageFor = (source: ContextSourceCoverageV1['source']) => coverage.find((item) => item.source === source);
  const selectedTier = input.plan.capability === 'certified_execution' ? 'certified' as const
    : input.plan.capability === 'semantic_execution' ? 'semantic' as const
      : input.plan.capability === 'governed_relational' ? 'governed_relational' as const
        : input.plan.capability === 'bounded_exploration' ? 'exploratory_sql' as const
          : undefined;
  const frozen = input.reconciliation.outcome === 'ready' && input.plan.mode === 'authoritative';
  const tier = (name: CascadeTierAttemptV1['tier'], source: ContextSourceCoverageV1['source'], selected: boolean): CascadeTierAttemptV1 => {
    const item = coverageFor(source);
    return {
      version: 1,
      tier: name,
      outcome: selected ? 'executable' : item?.status === 'available' ? 'ineligible' : 'unavailable',
      candidateIds: item?.candidateIds ?? [],
      reason: selected ? `The ${name} tier proved the complete requested tuple and froze the plan.` : item?.status === 'available' ? `The ${name} tier was retrieved but did not prove the complete tuple.` : `The ${name} source was ${item?.status ?? 'unavailable'} in this snapshot.`,
      planFrozen: frozen && selected,
    };
  };
  const attempts = [
    tier('certified', 'certified', selectedTier === 'certified'),
    tier('semantic', 'semantic', selectedTier === 'semantic'),
    tier('governed_relational', 'governed_relational', selectedTier === 'governed_relational'),
    tier('exploratory_sql', 'exploratory', selectedTier === 'exploratory_sql'),
  ];
  if (!selectedTier) {
    attempts.push({ version: 1, tier: 'clarify_or_gap', outcome: input.reconciliation.outcome === 'clarify' ? 'ambiguous' : input.reconciliation.outcome === 'policy_blocked' ? 'denied' : 'unavailable', candidateIds: [], reason: input.reconciliation.reason, planFrozen: false });
  }
  return buildAnalyticalCascadeDecision({
    requirements: buildAnalyticalRequirementSet({ question: input.question, parsedIntent: input.evidence.parsedIntent }),
    sourceCoverage: coverage,
    attempts,
    ...(selectedTier ? { selectedTier } : {}),
    planFrozen: frozen,
    ...(input.terminalGap ? { terminalGap: input.terminalGap } : {}),
    stopReason: input.reconciliation.outcome === 'ready' ? 'selected' : input.reconciliation.outcome === 'clarify' ? 'ambiguous' : input.reconciliation.outcome === 'policy_blocked' ? 'denied' : 'coverage_gap',
  });
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
  // Treat an LLM/direct selection as a nomination, never as permission to
  // let a certified block borrow a metric from neighboring semantic cards.
  // This check runs immediately before plan construction so every fast lane,
  // cached selection, explicit choice, and provider response shares it.
  let planBoundResolution = withDeclaredFiscalBinding(
    repairIncompleteCertifiedMeasureSelection(resolution, evidence, candidates),
    evidence,
    candidates,
    question,
  );
  if (resolution.analyticalFrame && resolution.recommendedRoute === 'semantic') {
    const sourceFrame = resolution.analyticalFrame;
    const bindingPlan = buildResolvedAnalyticalPlan({
      question,
      // Keep the frame available while binding its time-axis roles.  A
      // time dimension lives in `capability.timeDimensions`, not the ordinary
      // group-by list; stripping the frame first made a valid report_date
      // binding look unresolved after a certified→semantic recovery.
      resolution,
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
  const terminalGap = reconciliation.outcome === 'modeling_gap'
    ? terminalGapWitnessForResolutionFailure(resolvedAnalyticalPlan)
    : undefined;
  const analyticalCascadeDecision = cascadeForResolution({
    evidence,
    candidates,
    resolution: routedResolution,
    plan: resolvedAnalyticalPlan,
    reconciliation,
    question,
    ...(terminalGap ? { terminalGap: cascadeTerminalRelationshipGap(terminalGap) } : {}),
  });
  const declaredDimensionAssumptions = assumptionsForDeclaredDimensionAlternatives({
    question,
    evidence,
    candidates,
    plan: resolvedAnalyticalPlan,
  });
  // The deterministic pre-router may attach a generic soft clarification
  // while retrieval is still incomplete. Once this same turn has bound and
  // frozen a plan, that stale prompt must not leak into a completed answer or
  // its trace. Keep a clarification only when reconciliation itself says the
  // final immutable tuple is genuinely ambiguous.
  const {
    clarifyingQuestion: _staleClarifyingQuestion,
    clarificationOptions: _staleClarificationOptions,
    clarifySoft: _staleClarifySoft,
    ...baseWithoutStaleClarification
  } = base;
  return {
    ...baseWithoutStaleClarification,
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
    analyticalCascadeDecision,
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
            ...(terminalGap ? { gap: terminalGap } : {}),
          },
        }
      : {}),
    ...(needsClarification
      ? { clarificationOptions: reconciliation.options }
      : {}),
    ...(needsClarification
      ? {
          clarifyingQuestion: reconciliation.question,
          ...(_staleClarifySoft ? { clarifySoft: true } : {}),
        }
      : {}),
    ...(declaredDimensionAssumptions.length > 0
      ? { assumptions: declaredDimensionAssumptions }
      : {}),
  };
}

/**
 * A block may be relevant to a metric without returning that metric. When a
 * stale catalog result or provider selection nominates such a block, continue
 * with one exact semantic definition when it exists; otherwise preserve the
 * genuine metric ambiguity as stable semantic choices. Never construct a
 * certified plan whose output contract merely borrows a neighbor's identity.
 */
function repairIncompleteCertifiedMeasureSelection(
  resolution: MeaningResolution,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
): MeaningResolution {
  if (resolution.recommendedRoute !== 'certified') return resolution;
  const selected = resolution.recommendedExecutionId
    ? candidates.find((candidate) => candidate.id === resolution.recommendedExecutionId)
    : candidates.find((candidate) => resolution.selectedConceptIds.includes(candidate.id));
  const requestedMeasures = evidence.parsedIntent?.measures?.length
    ? evidence.parsedIntent.measures
    : resolution.queryIntent.measures;
  if (!selected || selected.kind !== 'certified_block'
    || certifiedCandidateExplicitlyCoversMeasures(selected, requestedMeasures)) return resolution;

  const compatibleMetrics = candidates.filter((candidate) =>
    candidate.kind === 'semantic_metric'
    && candidate.compatibility === 'compatible'
    && requestedMeasures.length > 0
    && requestedMeasures.every((requested) => candidateProvesMetricTerm(candidate, requested))
    && Boolean(normalizeEvidenceAnalyticalCapability(candidate).capability));
  const exactMetrics = compatibleMetrics.filter((candidate) =>
    requestedMeasures.every((requested) => semanticMetricIdentityExactlyMatches(candidate, requested)));
  if (exactMetrics.length === 1) {
    const metric = exactMetrics[0]!;
    return {
      ...resolution,
      selectedConceptIds: [metric.id],
      recommendedExecutionId: metric.id,
      recommendedRoute: 'semantic',
      confidence: resolution.confidence === 'low' ? 'medium' : resolution.confidence,
      // The frame is a typed interpretation of the requested tuple, not a
      // claim that the rejected certified block can execute it.  Preserve it
      // when the exact semantic metric owns the same request so the frozen
      // plan retains its V2 time/comparison/ranking contract.  Clearing it
      // here downgraded a safe semantic recovery into a legacy V1 blocked
      // plan solely because the original certified nomination was incomplete.
      analyticalFrame: resolution.analyticalFrame,
      missingInformation: [...new Set([
        ...resolution.missingInformation,
        `${selected.name} does not declare ${requestedMeasures.join(', ')} as an output; continued with the exact semantic metric ${metric.name}.`,
      ])],
    };
  }
  const choices = compatibleMetrics.map((candidate) => candidate.id);
  return {
    ...resolution,
    selectedConceptIds: [],
    recommendedExecutionId: undefined,
    recommendedRoute: 'clarify',
    confidence: 'low',
    analyticalFrame: undefined,
    compatibilityOutcome: 'clarify',
    compatibilityFailures: [{
      code: 'CERTIFIED_MEASURE_OUTPUT_MISSING',
      field: 'measure',
      message: `${selected.name} does not declare ${requestedMeasures.join(', ')} as an output.`,
      candidateIds: choices,
    }],
    missingInformation: [...new Set([
      ...resolution.missingInformation,
      choices.length > 1
        ? `The selected certified block does not declare ${requestedMeasures.join(', ')}. Choose among the compatible semantic metric definitions.`
        : `The selected certified block does not declare ${requestedMeasures.join(', ')} as an output.`,
    ])],
    clarifyingQuestion: choices.length > 1
      ? 'Which compatible semantic metric should DQL use?'
      : resolution.clarifyingQuestion,
  };
}

function semanticMetricIdentityExactlyMatches(
  candidate: AgentEvidenceCandidate,
  requested: string,
): boolean {
  const requestedIdentity = normalizeMetricPhrase(requested);
  if (!requestedIdentity) return false;
  return [candidate.name, ...(candidate.aliases ?? []), candidate.qualifiedId ?? candidate.id]
    .map((identity) => normalizeMetricPhrase(identity.split(/[.:/]/).at(-1) ?? identity))
    .some((identity) => identity === requestedIdentity);
}

type ReconciledPlanOutcome = {
  outcome: 'ready' | 'clarify' | 'modeling_gap' | 'policy_blocked';
  reason: string;
  question?: string;
  options?: NonNullable<IntentDecision['clarificationOptions']>;
};

/**
 * Clarification is an execution-affecting choice, not a generic search result
 * picker.  In particular, a block tagged with revenue may be useful context
 * but cannot be offered for an explicit revenue request unless that block's
 * own output contract declares revenue.  Applying this at the option boundary
 * keeps a stale pooled candidate from becoming a later structured bypass.
 */
function clarificationRequirementsForResolution(
  resolution: MeaningResolution,
): AnalyticalRequirementSetV1 {
  const question = resolution.interpretedQuestion;
  const questionTerms = normalizeMetricPhrase(question);
  // A parser/result frame can carry inherited technical hints that do not
  // belong to the user's current wording.  They are useful to planning, but
  // must not turn an unrelated structured option into an invalid selection.
  // Keep only parser measures the question actually says, then add the
  // resolver's own typed metric frame when it exists.
  const mentionedMeasures = resolution.queryIntent.measures.filter((measure) => {
    const normalized = normalizeMetricPhrase(measure);
    const tokens = normalized.split(' ').filter((token) => token.length >= 3);
    return tokens.length > 0 && tokens.every((token) => questionTerms.includes(token));
  });
  const frameMeasures = resolution.analyticalFrame?.metricConceptIds.map((id) =>
    id.split(/[.:/]/).filter(Boolean).at(-1) ?? id) ?? [];
  return buildAnalyticalRequirementSet({
    question,
    parsedIntent: {
      ...resolution.queryIntent,
      measures: [...new Set([...mentionedMeasures, ...frameMeasures])],
    },
  });
}

function explicitMeasureTermsForClarification(
  requirements: AnalyticalRequirementSetV1 | undefined,
): string[] {
  return [...new Set([
    ...(requirements?.measures ?? []),
    ...(requirements?.ranking?.metricTerms ?? []),
  ].map((term) => normalizeMetricPhrase(term.split(/[.:/]/).at(-1) ?? term)).filter(Boolean))];
}

function candidateOwnsExplicitClarificationRoles(
  candidate: AgentEvidenceCandidate,
  requirements: AnalyticalRequirementSetV1 | undefined,
): boolean {
  if (candidate.eligible === false || candidate.compatibility === 'incompatible') return false;
  const measures = explicitMeasureTermsForClarification(requirements);
  if (measures.length === 0) return true;
  if (candidate.kind === 'certified_block') {
    return certifiedCandidateExplicitlyCoversMeasures(candidate, measures);
  }
  // A structured choice for a measure must be the metric itself.  An entity,
  // member, model, or physical relation can help compile the chosen metric but
  // cannot become its meaning merely because it happened to rank highly.
  // A semantic metric is a valid *meaning* choice when it owns at least one
  // explicitly requested metric. Multi-metric plans still cannot freeze until
  // every requested measure is bound by the immutable plan; this narrower
  // option check lets a user choose between the revenue/refunds definitions
  // without pretending the single metric already answers the whole tuple.
  return candidate.kind === 'semantic_metric'
    && measures.some((measure) => candidateProvesMetricTerm(candidate, measure));
}

function compatibleClarificationCandidates(
  candidates: AgentEvidenceCandidate[],
  requirements?: AnalyticalRequirementSetV1,
): AgentEvidenceCandidate[] {
  return candidates.filter((candidate) =>
    candidateOwnsExplicitClarificationRoles(candidate, requirements));
}

function withoutMeasureClarificationRequirements(
  requirements: AnalyticalRequirementSetV1,
): AnalyticalRequirementSetV1 {
  const { ranking: _ranking, ...withoutRanking } = requirements;
  return {
    ...withoutRanking,
    measures: [],
  };
}

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
    ...(plan.outputContract.requiredOutputs ?? []).map((binding) => ({ kind: 'output', binding })),
  ].filter(({ binding }) => binding.status !== 'resolved');
  const qualifiedChoiceIds = [...new Set(bindings.flatMap(({ binding }) => binding.candidateIds))].sort();
  const userResolvableBinding = bindings.some(({ binding }) =>
    binding.candidateIds.length > 0);
  const clarificationRequirements = clarificationRequirementsForResolution(resolution);

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
    const unresolvedMeasure = bindings.some(({ kind }) => kind === 'measure');
    const optionRequirements = unresolvedMeasure
      ? clarificationRequirements
      : withoutMeasureClarificationRequirements(clarificationRequirements);
    const options = optionIds.length > 0
      ? clarificationOptionsForQualifiedIds(optionIds, candidates, optionRequirements)
      : buildClarificationOptions(candidates, optionRequirements);
    if (options.length === 0) {
      return {
        outcome: 'modeling_gap',
        reason: 'No retrieved artifact owns every explicitly requested analytical role, so DQL did not offer an incompatible structured selection.',
      };
    }
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
    const options = buildClarificationOptions(candidates, clarificationRequirements);
    if (options.length === 0) {
      return {
        outcome: 'modeling_gap',
        reason: 'No retrieved artifact owns every explicitly requested analytical role, so DQL did not offer an incompatible structured selection.',
      };
    }
    return {
      outcome: 'clarify',
      reason: `The retrieved evidence needs one governed meaning choice: ${plan.missingInformation.join(' ') || resolution.interpretedQuestion}`,
      question: resolution.clarifyingQuestion ?? buildEvidenceClarification(candidates, plan.missingInformation),
      options,
    };
  }
  return {
    outcome: 'modeling_gap',
    reason: `The selected analytical plan is not executable from the governed model: ${plan.missingInformation.join(' ') || 'review its capability and relationship proof.'}`,
  };
}

/**
 * Keep a specific terminal gap only when its producer supplied a typed reason.
 * A generic modeling gap must never become a relationship-gap claim because a
 * later renderer happened to mention joins in its repair copy.
 */
function terminalGapWitnessForResolutionFailure(
  plan: ResolvedAnalyticalPlan,
): AnalyticalTerminalGapWitness | undefined {
  const failure = plan.resolutionFailure;
  if (!failure || failure.outcome !== 'modeling_gap') return undefined;
  const codes = new Set(failure.codes);
  const unresolved = [...new Set(failure.bindings
    .filter((binding) => binding.status !== 'resolved')
    .map((binding) => binding.requested)
    .filter(Boolean))];
  const witnessCandidateIds = [...new Set([
    ...failure.candidateIds,
    ...(failure.selectedCapabilityId ? [failure.selectedCapabilityId] : []),
    ...(failure.selectedExecutionId ? [failure.selectedExecutionId] : []),
  ])].sort();
  if (codes.has('RELATIONSHIP_PROOF_MISSING')) {
    return {
      code: 'MISSING_RELATIONSHIP',
      missing: ['a certified, validated, fanout-safe relationship proof'],
      witnessCandidateIds,
    };
  }
  if (codes.has('METRIC_CAPABILITY_MISSING') || codes.has('MISSING_MEASURE')) {
    return {
      code: 'MISSING_MEASURE',
      missing: unresolved.length > 0 ? unresolved : ['the requested governed measure'],
      witnessCandidateIds,
    };
  }
  if (codes.has('MEMBER_FILTER_UNSUPPORTED') || codes.has('MISSING_ATTRIBUTE')) {
    return {
      code: 'MISSING_ATTRIBUTE',
      missing: unresolved.length > 0 ? unresolved : ['the requested governed attribute or member filter'],
      witnessCandidateIds,
    };
  }
  if ([
    'DIMENSION_ROLE_UNSUPPORTED',
    'TIME_DIMENSION_REQUIRED',
    'TIME_DIMENSION_AMBIGUOUS',
    'TIME_ROLE_UNSUPPORTED',
    'TIME_GRAIN_UNSUPPORTED',
    'MISSING_DIMENSION',
  ].some((code) => codes.has(code))) {
    return {
      code: 'MISSING_DIMENSION',
      missing: unresolved.length > 0 ? unresolved : ['the requested governed dimension or time role'],
      witnessCandidateIds,
    };
  }
  return {
    code: 'MISSING_RUNTIME_CAPABILITY',
    missing: unresolved.length > 0 ? unresolved : ['the complete requested analytical tuple'],
    witnessCandidateIds,
  };
}

function clarificationOptionsForQualifiedIds(
  ids: string[],
  candidates: AgentEvidenceCandidate[],
  requirements?: AnalyticalRequirementSetV1,
): NonNullable<IntentDecision['clarificationOptions']> {
  const requireArtifactLocalMeasureProof = explicitMeasureTermsForClarification(requirements).length > 0;
  return ids
    .map((id) => ({
      id,
      candidate: candidates.find((item) => item.id === id || item.qualifiedId === id),
    }))
    .filter(({ candidate }) =>
      candidate
        ? candidateOwnsExplicitClarificationRoles(candidate, requirements)
        // Qualified capability dimensions are synthesized by the resolved
        // plan, not necessarily returned as standalone retrieval cards. They
        // remain valid choices for a dimension/filter clarification, but never
        // for an explicit metric role whose local artifact proof is missing.
        : !requireArtifactLocalMeasureProof)
    .slice(0, 3)
    .map(({ id, candidate }) => {
    return {
      id: candidate?.id ?? id,
      label: candidate?.name || qualifiedIdLabel(candidate?.qualifiedId ?? id),
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
  question: string,
  selectedConceptIds: string[] = [selected.id],
): IntentDecision {
  // Preserve the exact stable ID emitted by the clarification option. A
  // candidate may also carry a source-qualified execution alias, but replacing
  // the clicked ID here makes the persisted ambiguity contract and the later
  // diagnostic receipt disagree even though the user chose a legitimate item.
  const selectedId = selected.id;
  // A server-issued display-key click has already passed the snapshot and
  // metric-capability checks. If its tuple is pre-freeze-ineligible, preserve
  // both the metric authority and the exact clicked ID through the typed gap
  // or same-snapshot exploratory continuation. Reconstructing only the
  // metric made restart receipts falsely look as though no choice was made.
  const preservedSelectionIds = [...new Set([
    ...selectedConceptIds.filter((id) => Boolean(id?.trim())),
    selectedId,
  ])];
  // A structured choice is validated against its exact stable identity, but an
  // incomplete selected capability must evaluate physical eligibility against
  // the entire immutable snapshot—not the compact model package that happened
  // to carry the clarification. This is one same-snapshot extension only.
  const snapshotCandidates = immutableSnapshotCandidates(evidence, candidates);
  const requirements = buildAnalyticalRequirementSet({ question, parsedIntent: evidence.parsedIntent });
  const requiredPhysicalFieldTerms = [
    ...(evidence.parsedIntent?.dimensions ?? []),
    ...(evidence.parsedIntent?.filters ?? []).map((filter) => filter.field),
  ];
  const physicalPath = hasSafeExploratoryPhysicalPath(
    requirements,
    snapshotCandidates,
    requirements.dimensions,
    requiredPhysicalFieldTerms,
  );
  // A structured clarification consumes the exact selected ID once, but an
  // incomplete governed capability is not a post-freeze terminal.  Reuse the
  // router-owned physical cascade so the same-snapshot exploratory closure is
  // resolved and frozen *before* SQL is generated.  The host may later attach
  // only an authorization receipt for that frozen plan; it must not select or
  // freeze another plan after SQL exists.
  if (physicalPath.ok) {
    return preFreezePhysicalCascadeDecision({
      base,
      evidence,
      candidates: snapshotCandidates,
      question,
      requirements,
      missingTerms: [...new Set([
        ...requirements.dimensions,
        ...requirements.entityTerms,
        ...requirements.entityDisplayTerms,
      ])],
      requiredPhysicalFieldTerms,
      messagePrefix: `The selected governed meaning ${selectedId} did not prove the complete requested tuple. DQL consumed that selection once and did not substitute a correlated metric or execute a different artifact;`,
      terminalCandidateIds: preservedSelectionIds,
      requireRankingMetric: Boolean(requirements.ranking),
    });
  }
  const coverage = sourceCoverageFromEvidence(evidence, snapshotCandidates);
  const governedCoverage = coverage.find((item) => item.source === 'governed_relational');
  const attempts: CascadeTierAttemptV1[] = [
    {
      version: 1,
      tier: 'certified',
      outcome: 'ineligible',
      candidateIds: coverage.find((item) => item.source === 'certified')?.candidateIds ?? [],
      reason: `The explicit selection ${selectedId} did not prove a complete certified tuple.`,
      planFrozen: false,
    },
    {
      version: 1,
      tier: 'semantic',
      outcome: 'ineligible',
      candidateIds: [...new Set([...preservedSelectionIds, ...(coverage.find((item) => item.source === 'semantic')?.candidateIds ?? [])])],
      reason: `The explicit selection ${selectedId} was consumed once but did not prove the complete semantic tuple.`,
      planFrozen: false,
    },
    {
      version: 1,
      tier: 'governed_relational',
      outcome: governedCoverage?.status === 'available' ? 'ineligible' : 'unavailable',
      candidateIds: governedCoverage?.candidateIds ?? [],
      reason: governedCoverage?.status === 'available'
        ? 'Retrieved governed relationship evidence did not prove a complete relational plan.'
        : `The governed relational source was ${governedCoverage?.status ?? 'unavailable'}; exploratory eligibility is evaluated independently.`,
      planFrozen: false,
    },
    {
      version: 1,
      tier: 'exploratory_sql',
      outcome: physicalPath.ok ? 'executable' : 'unavailable',
      candidateIds: physicalPath.candidateIds,
      reason: physicalPath.reason,
      planFrozen: false,
    },
  ];
  const message = physicalPath.ok
    ? `The selected governed meaning ${selectedId} does not prove the complete requested metric, dimension, filter, and grain tuple. DQL consumed that selection once and did not substitute a correlated metric or execute a different artifact; a same-snapshot qualified physical path is available for review-required exploratory SQL.`
    : `The selected governed meaning ${selectedId} does not prove the complete requested metric, dimension, filter, and grain tuple. DQL consumed that selection once and will not substitute a correlated metric or execute generated SQL because ${physicalPath.reason}`;
  const analyticalCascadeDecision = buildAnalyticalCascadeDecision({
    requirements,
    sourceCoverage: coverage,
    attempts: physicalPath.ok
      ? attempts
      : [...attempts, { version: 1, tier: 'clarify_or_gap', outcome: 'unavailable', candidateIds: preservedSelectionIds, reason: message, planFrozen: false }],
    ...(physicalPath.ok ? { selectedTier: 'exploratory_sql' as const } : {}),
    planFrozen: false,
    stopReason: physicalPath.ok ? 'selected' : 'coverage_gap',
  });
  const meaningResolution: MeaningResolution = {
    interpretedQuestion: question,
    questionType: 'value',
    selectedConceptIds: preservedSelectionIds,
    queryIntent: defaultQueryIntent(evidence),
    rejectedCandidates: [],
    confidence: 'low',
    missingInformation: [message],
    recommendedRoute: physicalPath.ok ? 'exploratory' : 'clarify',
    compatibilityOutcome: 'modeling_gap',
    compatibilityFailures: [{
      code: 'INCOMPLETE_SELECTED_CAPABILITY',
      field: 'selected capability',
      message,
      candidateIds: preservedSelectionIds,
    }],
  };
  if (!physicalPath.ok) {
    return {
      ...base,
      action: 'block',
      confidence: 1,
      reason: message,
      source: 'heuristic',
      category: 'data_lookup',
      depth: 'quick',
      retrievalEvidence: retrievalTrace(evidence, snapshotCandidates),
      requiresClarification: false,
      resolvedAnalyticalPlan: undefined,
      meaningResolution,
      analyticalCascadeDecision,
      terminalOutcome: {
        kind: 'modeling_gap',
        code: 'ANALYTICAL_MODELING_GAP',
        message,
        candidateIds: preservedSelectionIds,
        ...(physicalPath.gap ? { gap: physicalPath.gap } : {}),
      },
    };
  }
  return {
    ...base,
    action: 'answer',
    confidence: 0.55,
    reason: message,
    source: 'heuristic',
    category: 'data_lookup',
    depth: 'quick',
    retrievalEvidence: retrievalTrace(evidence, snapshotCandidates),
    requiresClarification: false,
    resolvedAnalyticalPlan: undefined,
    meaningResolution,
    analyticalCascadeDecision,
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
    // Preserve an already validated semantic member when the resulting frame
    // proves that the selected metric owns that exact dimension. This is how a
    // server-issued “Account Name” clarification continues alongside the
    // explicit Revenue metric; stripping it here made trace meaning IDs and
    // durable continuation state look empty even though the frame was valid.
    const selectedFrameMembers = resolution.selectedConceptIds.flatMap((id) => {
      const member = candidates.find((candidate) => candidate.id === id);
      if (member?.kind !== 'semantic_member') return [];
      const resolvesIntoFrame = metricEvidence.some((metric) => {
        const identities = [
          member.qualifiedId,
          member.id,
          member.name,
          ...(member.aliases ?? []),
        ].filter((identity): identity is string => Boolean(identity));
        return identities.some((identity) => {
          const dimension = resolveMetricCapabilityDimension(metric, identity);
          return Boolean(dimension && result.frame.dimensions.some((binding) => binding.dimensionId === dimension.dimensionId));
        });
      });
      return resolvesIntoFrame ? [member.id] : [];
    });
    return {
      ...resolution,
      analyticalFrame: result.frame,
      analyticalPolicyIds: result.policyIds,
      ...(metricEvidence.length > 0
        ? { selectedConceptIds: [...new Set([
            ...metricEvidence.map((candidate) => candidate.id),
            ...selectedFrameMembers,
          ])] }
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
    // A compatibility block is a pre-freeze failure of the nominated tier,
    // not a new model decision to route somewhere else. Retain the semantic
    // nomination so the authoritative cascade can inspect the complete
    // same-snapshot qualified physical closure. Only genuine multi-option
    // ambiguity changes the route to clarification.
    recommendedRoute: result.status === 'clarify' ? 'clarify' : resolution.recommendedRoute,
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
  requirements?: AnalyticalRequirementSetV1,
): NonNullable<IntentDecision["clarificationOptions"]> {
  const roleCompatible = compatibleClarificationCandidates(candidates, requirements);
  const governed = roleCompatible.filter(
    (candidate) =>
      candidate.compatibility !== "incompatible" &&
      (candidate.kind === "certified_block" ||
        candidate.kind === "semantic_metric" ||
        candidate.kind === "semantic_member"),
  );
  const pool = governed.length > 1
    ? governed
    : roleCompatible;
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

type PersistedClarificationSelectionContext = {
  optionIds: string[];
  ambiguityCandidateIds: string[];
  requirements?: AnalyticalRequirementSetV1;
  snapshotId?: string;
  sourceTurnId?: string;
  /**
   * Original analytical wording retained by the server conversation snapshot.
   * A clicked label is presentation data, never a replacement question.
   */
  sourceQuestion?: string;
  threadId?: string;
  /**
   * Only the local runtime can add this host-only binding after it reads the
   * persisted conversation thread.  It is deliberately separate from the
   * JSON envelope, which a browser client could otherwise replay or forge.
   */
  serverIssued: boolean;
  invalidReason?: string;
};

/**
 * The server envelope persists the option/requirement contract that rendered a
 * clarification.  Browser context is never authority: the local runtime adds
 * a host-only binding only after reading the persisted thread. Current snapshot
 * compatibility remains mandatory, so a client cannot forge an old option list
 * to admit an unrelated artifact.
 */
function persistedClarificationSelectionContext(
  request: AgentRunRequest,
): PersistedClarificationSelectionContext | undefined {
  const context = request.conversationContext;
  const envelope = context?.conversationEnvelope && typeof context.conversationEnvelope === 'object'
    ? context.conversationEnvelope as Record<string, unknown>
    : context?.serverSnapshot && typeof context.serverSnapshot === 'object'
      ? context.serverSnapshot as Record<string, unknown>
      : undefined;
  const pending = envelope?.pendingClarification;
  if (!pending || typeof pending !== 'object') return undefined;
  const pendingRecord = pending as Record<string, unknown>;
  const selection = pendingRecord.selection;
  if (!selection || typeof selection !== 'object') return undefined;
  const record = selection as Record<string, unknown>;
  const ids = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()))]
    : [];
  const requirements = normalizePersistedClarificationRequirements(record.requirements);
  const optionIds = ids(record.optionIds);
  const ambiguityCandidateIds = ids(record.ambiguityCandidateIds);
  const snapshotId = typeof record.snapshotId === 'string' && record.snapshotId.trim()
    ? record.snapshotId.trim()
    : undefined;
  const sourceTurnId = typeof pendingRecord.sourceTurnId === 'string' && pendingRecord.sourceTurnId.trim()
    ? pendingRecord.sourceTurnId.trim()
    : undefined;
  const sourceQuestion = typeof pendingRecord.sourceQuestion === 'string' && pendingRecord.sourceQuestion.trim()
    ? pendingRecord.sourceQuestion.trim()
    : undefined;
  const threadId = typeof envelope?.threadId === 'string' && envelope.threadId.trim()
    ? envelope.threadId.trim()
    : undefined;
  const authority = context?.serverIssuedClarificationSelection;
  const authorityRecord = authority && typeof authority === 'object' && !Array.isArray(authority)
    ? authority as Record<string, unknown>
    : undefined;
  const authorityMatches = Boolean(
    authorityRecord?.version === 1
    && typeof authorityRecord.threadId === 'string'
    && authorityRecord.threadId === threadId
    && typeof authorityRecord.sourceTurnId === 'string'
    && authorityRecord.sourceTurnId === sourceTurnId
    && typeof authorityRecord.snapshotId === 'string'
    && authorityRecord.snapshotId === snapshotId,
  );
  const invalidReason = record.version !== 1
    ? 'The structured selection envelope has an unsupported version.'
    : !request.threadId || !threadId || threadId !== request.threadId
      ? 'The structured selection is not bound to the active server conversation thread.'
      : !sourceTurnId
        ? 'The structured selection is missing its server turn binding.'
        : optionIds.length === 0
          ? 'The structured selection is missing the options rendered by the server.'
          : !requirements
            ? 'The structured selection is missing its typed analytical requirements.'
            : !snapshotId
              ? 'The structured selection is missing its retrieval snapshot binding.'
              : !authorityMatches
                ? 'The structured selection was not issued by the active server conversation.'
                : undefined;
  return {
    optionIds,
    ambiguityCandidateIds,
    ...(requirements ? { requirements } : {}),
    ...(snapshotId ? { snapshotId } : {}),
    ...(sourceTurnId ? { sourceTurnId } : {}),
    ...(sourceQuestion ? { sourceQuestion } : {}),
    ...(threadId ? { threadId } : {}),
    serverIssued: !invalidReason,
    ...(invalidReason ? { invalidReason } : {}),
  };
}

/**
 * The persisted envelope crosses a client/server boundary.  It is only a
 * reject-only continuity hint, but it must still be parsed as data rather than
 * cast as an executable typed requirement set.  In particular, a malformed
 * string must never be spread into one-character "measures" and weaken the
 * selected-ID validation path.
 */
function normalizePersistedClarificationRequirements(
  value: unknown,
): AnalyticalRequirementSetV1 | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  const terms = (input: unknown): string[] => Array.isArray(input)
    ? [...new Set(input.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()))]
    : [];
  const rankingRecord = record.ranking && typeof record.ranking === 'object' && !Array.isArray(record.ranking)
    ? record.ranking as Record<string, unknown>
    : undefined;
  const timeRecord = record.time && typeof record.time === 'object' && !Array.isArray(record.time)
    ? record.time as Record<string, unknown>
    : undefined;
  const direction = rankingRecord?.direction === 'bottom' ? 'bottom' : rankingRecord?.direction === 'top' ? 'top' : undefined;
  const limit = typeof rankingRecord?.limit === 'number' && Number.isFinite(rankingRecord.limit) && rankingRecord.limit > 0
    ? Math.floor(rankingRecord.limit)
    : undefined;
  const grain = timeRecord?.grain;
  const safeGrain = grain === 'day' || grain === 'week' || grain === 'month' || grain === 'quarter' || grain === 'year'
    ? grain
    : undefined;
  const timeRole = timeRecord?.role === 'time_axis' || timeRecord?.role === 'time_filter'
    ? timeRecord.role
    : undefined;
  const fiscalPeriod = typeof timeRecord?.fiscalPeriod === 'string' && timeRecord.fiscalPeriod.trim()
    ? timeRecord.fiscalPeriod.trim()
    : undefined;
  return {
    version: 1,
    measures: terms(record.measures),
    dimensions: terms(record.dimensions),
    entityTerms: terms(record.entityTerms),
    entityDisplayTerms: terms(record.entityDisplayTerms),
    memberTerms: terms(record.memberTerms),
    ...(direction && limit !== undefined
      ? {
          ranking: {
            metricTerms: terms(rankingRecord?.metricTerms),
            entityTerms: terms(rankingRecord?.entityTerms),
            direction,
            limit,
            defaultedLimit: rankingRecord?.defaultedLimit === true,
          },
        }
      : {}),
    ...(timeRole
      ? {
          time: {
            role: timeRole,
            ...(safeGrain ? { grain: safeGrain } : {}),
            ...(fiscalPeriod ? { fiscalPeriod } : {}),
            requiresDeclaredFiscalCalendar: timeRecord?.requiresDeclaredFiscalCalendar === true,
          },
        }
      : {}),
  };
}

function mergeClarificationRequirements(
  current: AnalyticalRequirementSetV1,
  persisted: AnalyticalRequirementSetV1 | undefined,
): AnalyticalRequirementSetV1 {
  if (!persisted) return current;
  // Persisted requirements are only a reject-only continuity check.  Unioning
  // explicitly requested roles means an old selection cannot weaken the new
  // typed interpretation even if a caller fabricated its envelope.
  return {
    ...current,
    measures: [...new Set([...current.measures, ...(persisted.measures ?? [])])],
    dimensions: [...new Set([...current.dimensions, ...(persisted.dimensions ?? [])])],
    entityTerms: [...new Set([...current.entityTerms, ...(persisted.entityTerms ?? [])])],
    entityDisplayTerms: [...new Set([...current.entityDisplayTerms, ...(persisted.entityDisplayTerms ?? [])])],
    memberTerms: [...new Set([...current.memberTerms, ...(persisted.memberTerms ?? [])])],
    ...(current.ranking || persisted.ranking
      ? {
          ranking: current.ranking && persisted.ranking
            ? {
                ...current.ranking,
                metricTerms: [...new Set([...current.ranking.metricTerms, ...persisted.ranking.metricTerms])],
                entityTerms: [...new Set([...current.ranking.entityTerms, ...persisted.ranking.entityTerms])],
              }
            : current.ranking ?? persisted.ranking,
        }
      : {}),
    ...(current.time || persisted.time
      ? {
          time: current.time && persisted.time
            ? {
                ...current.time,
                grain: current.time.grain ?? persisted.time.grain,
                fiscalPeriod: current.time.fiscalPeriod ?? persisted.time.fiscalPeriod,
                requiresDeclaredFiscalCalendar: current.time.requiresDeclaredFiscalCalendar
                  || persisted.time.requiresDeclaredFiscalCalendar,
              }
            : current.time ?? persisted.time,
        }
      : {}),
  };
}

/**
 * A structured choice continues the server-rendered analytical frame.  The
 * browser may echo `clarificationSourceQuestion`, but the persisted server
 * envelope wins whenever it is available so a choice label cannot be parsed as
 * a new question on reload or restart.
 */
function structuredClarificationRequirements(
  request: AgentRunRequest,
  persisted: PersistedClarificationSelectionContext | undefined,
): AnalyticalRequirementSetV1 {
  const sourceQuestion = persisted?.serverIssued && persisted.sourceQuestion
    ? persisted.sourceQuestion
    : request.clarificationSourceQuestion?.trim() || request.question;
  return mergeClarificationRequirements(
    buildAnalyticalRequirementSet({ question: sourceQuestion }),
    persisted?.serverIssued ? persisted.requirements : undefined,
  );
}

type StructuredDimensionSelection = {
  kind: 'dimension';
  /** The one exact metric that continues to own the explicit measure role. */
  metricCandidate: AgentEvidenceCandidate;
  /** Stable router identity of the server-issued display/grouping choice. */
  selectedDimensionId: string;
  /** Declared metric-capability identifier used to bind the immutable frame. */
  dimensionId: string;
};

type StructuredSelectionValidation =
  | {
      ok: true;
      requirements: AnalyticalRequirementSetV1;
      choiceIds: string[];
      selection: { kind: 'metric' } | StructuredDimensionSelection;
    }
  | { ok: false; requirements: AnalyticalRequirementSetV1; choiceIds: string[]; reason: string };

/**
 * A dimension clarification is not an alternate definition of the measure.
 * Find the exact semantic metric that owns the persisted explicit measure
 * before accepting a server-issued semantic member as a display/grouping
 * selection.  Multiple metrics remain a real ambiguity; we never use a
 * dimension click to guess one of them.
 */
function uniqueStructuredSelectionMetric(
  candidates: AgentEvidenceCandidate[],
  requirements: AnalyticalRequirementSetV1,
): AgentEvidenceCandidate | undefined {
  const measures = explicitMeasureTermsForClarification(requirements);
  if (measures.length !== 1) return undefined;
  const byMetricId = new Map<string, AgentEvidenceCandidate>();
  for (const candidate of canonicalizeMetricMeasureCandidates(candidates)) {
    if (candidate.kind !== 'semantic_metric'
      || candidate.eligible === false
      // The first clarification deliberately exists because the metric's
      // display/entity role was not yet fully bound. A partial fit can still
      // be the unique, complete semantic capability for the explicit measure;
      // after the server-issued dimension choice binds it, the ordinary
      // immutable-plan compatibility checks remain authoritative. Only a
      // proven incompatible metric is disqualified at this identity boundary.
      || candidate.compatibility === 'incompatible'
      || candidateConflictsWithExplicitRankingMeasure(candidate, requirements)
      || !candidateProvesMetricTerm(candidate, measures[0]!)) continue;
    const normalized = normalizeEvidenceAnalyticalCapability(candidate);
    if (normalized.status !== 'complete' || !normalized.capability) continue;
    const current = byMetricId.get(normalized.capability.metricId);
    if (!current
      || candidate.exactMatch && !current.exactMatch
      || candidate.relevanceScore > current.relevanceScore) {
      byMetricId.set(normalized.capability.metricId, candidate);
    }
  }
  return byMetricId.size === 1 ? [...byMetricId.values()][0] : undefined;
}

/**
 * A resolver can offer a qualified semantic capability dimension without a
 * standalone retrieval card.  That is expected: the option is an authored
 * child of a metric capability, not an independently ranked candidate.  On a
 * later click, restore that child only when the active server-issued
 * clarification contract names the exact option and the *same immutable
 * snapshot* still proves it through one exact metric capability.
 *
 * This is deliberately not a fuzzy retrieval fallback.  A malformed,
 * foreign, stale, or client-invented ID never reaches this helper because the
 * host-only envelope/snapshot checks occur before the capability projection.
 */
function rehydrateServerIssuedCapabilityDimensionSelection(input: {
  request: AgentRunRequest;
  evidence: AgentRetrievalEvidence;
  candidates: AgentEvidenceCandidate[];
}): AgentEvidenceCandidate | undefined {
  const selectedId = input.request.selectedEvidenceId?.trim();
  if (!selectedId) return undefined;
  const persisted = persistedClarificationSelectionContext(input.request);
  if (!persisted?.serverIssued || persisted.snapshotId !== input.evidence.snapshotId) return undefined;
  const offeredIds = new Set([...persisted.optionIds, ...persisted.ambiguityCandidateIds]);
  if (!offeredIds.has(selectedId)) return undefined;

  const requirements = structuredClarificationRequirements(input.request, persisted);
  const metricCandidate = uniqueStructuredSelectionMetric(input.candidates, requirements);
  if (!metricCandidate) return undefined;
  const dimension = resolveMetricCapabilityDimension(metricCandidate, selectedId);
  if (!dimension) return undefined;
  if (requirements.ranking && !dimension.supportedRoles.includes('rank_entity')) return undefined;
  if (!requirements.ranking
    && !dimension.supportedRoles.includes('group_by')
    && !dimension.supportedRoles.includes('filter')) return undefined;

  return {
    // Keep the exact server-issued ID as the router identity and persistable
    // choice binding. The metric capability's authored ID stays available as
    // provenance for semantic-frame construction.
    id: selectedId,
    qualifiedId: dimension.dimensionId,
    kind: 'semantic_member',
    semanticObjectType: 'dimension',
    trustTier: 'semantic',
    name: dimension.label || qualifiedIdLabel(dimension.dimensionId),
    ...(dimension.aliases?.length ? { aliases: dimension.aliases } : {}),
    ...(metricCandidate.domain ? { domain: metricCandidate.domain } : {}),
    ...(metricCandidate.semanticModel ? { semanticModel: metricCandidate.semanticModel } : {}),
    relevanceScore: metricCandidate.relevanceScore,
    matchReasons: ['server-issued snapshot capability binding'],
    compatibility: 'compatible',
    eligible: true,
  };
}

/**
 * Validate a selected display/grouping member against the selected metric's
 * physical semantic capability.  The candidate must already have been offered
 * by the server; this only determines which typed role it can complete.
 */
function structuredDimensionSelection(
  selected: AgentEvidenceCandidate,
  candidates: AgentEvidenceCandidate[],
  requirements: AnalyticalRequirementSetV1,
): StructuredDimensionSelection | undefined {
  if (selected.kind !== 'semantic_member'
    || selected.eligible === false
    || selected.compatibility === 'incompatible') return undefined;
  const roles = evidenceCandidateRoles(selected);
  if (!roles.some((role) => role === 'entity_label'
    || role === 'categorical_dimension'
    || role === 'time_dimension')) return undefined;
  const metricCandidate = uniqueStructuredSelectionMetric(candidates, requirements);
  if (!metricCandidate) return undefined;
  const dimension = resolveMetricCapabilityDimension(
    metricCandidate,
    selected.qualifiedId ?? selected.id,
  );
  if (!dimension) return undefined;
  // A top/bottom clarification must select an authored rankable entity, not a
  // filter-only field. For ordinary dimensional requests, grouping is enough.
  if (requirements.ranking && !dimension.supportedRoles.includes('rank_entity')) return undefined;
  if (!requirements.ranking
    && !dimension.supportedRoles.includes('group_by')
    && !dimension.supportedRoles.includes('filter')) return undefined;
  return {
    kind: 'dimension',
    metricCandidate,
    selectedDimensionId: selected.id,
    dimensionId: dimension.dimensionId,
  };
}

function compatibleStructuredClarificationCandidates(
  candidates: AgentEvidenceCandidate[],
  requirements: AnalyticalRequirementSetV1,
): AgentEvidenceCandidate[] {
  return candidates.filter((candidate) =>
    candidateOwnsExplicitClarificationRoles(candidate, requirements)
    || Boolean(structuredDimensionSelection(candidate, candidates, requirements)));
}

function validateStructuredClarificationSelection(input: {
  request: AgentRunRequest;
  evidence: AgentRetrievalEvidence;
  candidates: AgentEvidenceCandidate[];
  selected?: AgentEvidenceCandidate;
}): StructuredSelectionValidation {
  const persisted = persistedClarificationSelectionContext(input.request);
  // A click/reload continuation is an identity action. Use the original user
  // question and server-persisted typed contract, not arbitrary inherited
  // parser hints or the rendered option label.
  const requirements = structuredClarificationRequirements(input.request, persisted);
  const compatible = compatibleStructuredClarificationCandidates(input.candidates, requirements);
  const choiceIds = compatible.map((candidate) => candidate.id);
  if (!persisted?.serverIssued) {
    return {
      ok: false,
      requirements,
      choiceIds,
      reason: persisted?.invalidReason
        ?? 'A structured selection requires a server-issued clarification envelope.',
    };
  }
  if (persisted.snapshotId !== input.evidence.snapshotId) {
    return {
      ok: false,
      requirements,
      choiceIds,
      reason: 'The structured selection belongs to a stale retrieval snapshot and must be chosen again.',
    };
  }
  if (!input.selected) {
    return { ok: false, requirements, choiceIds, reason: 'The selected governed identifier is no longer present in the retrieved snapshot.' };
  }
  const selection = candidateOwnsExplicitClarificationRoles(input.selected, requirements)
    ? { kind: 'metric' as const }
    : structuredDimensionSelection(input.selected, input.candidates, requirements);
  if (!selection) {
    return {
      ok: false,
      requirements,
      choiceIds,
      reason: `The selected artifact ${input.selected.id} does not own every explicitly requested analytical role.`,
    };
  }
  const persistedChoices = new Set([
    ...(persisted?.optionIds ?? []),
    ...(persisted?.ambiguityCandidateIds ?? []),
  ]);
  if (!persistedChoices.has(input.selected.id)
    && !persistedChoices.has(input.selected.qualifiedId ?? '')) {
    return {
      ok: false,
      requirements,
      choiceIds,
      reason: 'The selected governed identifier was not one of the persisted ambiguity choices for this question.',
    };
  }
  if (choiceIds.length > 0 && !choiceIds.includes(input.selected.id)) {
    return {
      ok: false,
      requirements,
      choiceIds,
      reason: 'The selected governed identifier is incompatible with the current typed requirement set.',
    };
  }
  return { ok: true, requirements, choiceIds, selection };
}

function invalidStructuredSelectionDecision(input: {
  base: IntentDecision;
  request: AgentRunRequest;
  evidence: AgentRetrievalEvidence;
  candidates: AgentEvidenceCandidate[];
  selectedId: string;
  validation: Extract<StructuredSelectionValidation, { ok: false }>;
}): IntentDecision {
  const coverage = sourceCoverageFromEvidence(input.evidence, input.candidates);
  const persisted = persistedClarificationSelectionContext(input.request);
  const persistedOptionIds = [...new Set([
    ...(persisted?.serverIssued ? persisted.optionIds : []),
    ...(persisted?.serverIssued ? persisted.ambiguityCandidateIds : []),
  ])];
  // Re-render only the original server-persisted ambiguity set when it exists.
  // A rejected click cannot silently widen into a fresh block/metric choice
  // that was never offered for this question; each remaining item is still
  // filtered against current snapshot eligibility and artifact-local roles.
  const options = persistedOptionIds.length > 0
    ? clarificationOptionsForQualifiedIds(
        persistedOptionIds,
        input.candidates,
        input.validation.requirements,
      )
    : buildClarificationOptions(input.candidates, input.validation.requirements);
  const candidateIds = input.validation.choiceIds;
  const message = `${input.validation.reason} DQL did not freeze or execute a plan for that selection.`;
  const decision = buildAnalyticalCascadeDecision({
    requirements: input.validation.requirements,
    sourceCoverage: coverage,
    attempts: [
      { version: 1, tier: 'certified', outcome: 'ineligible', candidateIds: coverage.find((item) => item.source === 'certified')?.candidateIds ?? [], reason: 'No selected certified artifact proved the requested tuple.', planFrozen: false },
      { version: 1, tier: 'semantic', outcome: 'ambiguous', candidateIds, reason: 'The selected identifier was rejected before semantic ambiguity could be resolved.', planFrozen: false },
      { version: 1, tier: 'governed_relational', outcome: 'unavailable', candidateIds: coverage.find((item) => item.source === 'governed_relational')?.candidateIds ?? [], reason: 'A structured selection cannot authorize relational execution while its meaning is invalid.', planFrozen: false },
      { version: 1, tier: 'exploratory_sql', outcome: 'unavailable', candidateIds: coverage.find((item) => item.source === 'exploratory')?.candidateIds ?? [], reason: 'A structured selection cannot authorize exploratory execution while its meaning is invalid.', planFrozen: false },
      { version: 1, tier: 'clarify_or_gap', outcome: options.length > 0 ? 'ambiguous' : 'unavailable', candidateIds, reason: message, planFrozen: false },
    ],
    planFrozen: false,
    stopReason: options.length > 0 ? 'ambiguous' : 'coverage_gap',
  });
  if (options.length === 0) {
    return {
      ...input.base,
      action: 'block',
      confidence: 1,
      source: 'heuristic',
      category: 'data_lookup',
      depth: 'quick',
      reason: message,
      requiresClarification: false,
      retrievalEvidence: retrievalTrace(input.evidence, input.candidates),
      terminalOutcome: { kind: 'modeling_gap', code: 'ANALYTICAL_MODELING_GAP', message, candidateIds },
      analyticalCascadeDecision: decision,
      resolvedAnalyticalPlan: undefined,
      meaningResolution: undefined,
    };
  }
  return {
    ...input.base,
    action: 'clarify',
    confidence: 1,
    source: 'heuristic',
    category: 'unclear',
    depth: 'quick',
    reason: message,
    requiresClarification: true,
    clarifyingQuestion: 'That selection does not match the requested analytical meaning. Which compatible governed metric should DQL use?',
    clarificationOptions: options,
    retrievalEvidence: retrievalTrace(input.evidence, input.candidates),
    analyticalCascadeDecision: decision,
    resolvedAnalyticalPlan: undefined,
    meaningResolution: {
      interpretedQuestion: input.request.question,
      questionType: questionTypeFromText(input.request.question),
      selectedConceptIds: [],
      queryIntent: defaultQueryIntent(input.evidence),
      rejectedCandidates: [{ id: input.selectedId, reason: input.validation.reason }],
      confidence: 'low',
      missingInformation: [message],
      recommendedRoute: 'clarify',
      compatibilityOutcome: 'clarify',
      compatibilityFailures: [{
        code: 'INVALID_STRUCTURED_SELECTION',
        field: 'selection',
        message: input.validation.reason,
        candidateIds,
      }],
    },
  };
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
  if (options.length === 0) {
    return unanswerableClarificationFallback(
      base,
      retrievalTrace(evidence, candidates),
      `${selected.name} counts customers and cannot rank them, and no alternative governed measure was retrieved, so DQL continued into the review-required generated lane instead of asking a question with no selectable answer.`,
    );
  }
  const labels = options.map((candidate) => renderCandidateChoice(candidate)).join(' or ');
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
    clarificationOptions: buildClarificationOptions(options),
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

function isSameSnapshotCategoricalExtensionForMetric(
  candidate: AgentEvidenceCandidate,
  metricCandidate: AgentEvidenceCandidate,
): boolean {
  const extension = candidate.sameSnapshotRoleExtension;
  if (!extension
    || extension.version !== 1
    || extension.role !== 'categorical_dimension'
    || (extension.basis !== 'sole_metricflow_grouping_dimension'
      && extension.basis !== 'exact_metricflow_grouping_dimension')
    || candidate.kind !== 'semantic_member'
    || (candidate.qualifiedId ?? candidate.id) !== extension.dimensionId) return false;
  const metricIds = new Set([
    metricCandidate.id,
    metricCandidate.qualifiedId,
    normalizeEvidenceAnalyticalCapability(metricCandidate).capability?.metricId,
  ].filter((id): id is string => Boolean(id)));
  if (!metricIds.has(extension.metricId)) return false;
  const capability = normalizeEvidenceAnalyticalCapability(metricCandidate).capability;
  return Boolean(capability?.dimensions.some((dimension) =>
    dimension.dimensionId === extension.dimensionId
    && dimension.supportedRoles.includes('group_by')));
}

/**
 * A model chooses from the bounded package, but it cannot remove a unique
 * host-required categorical grouping whose exact qualified field is already
 * declared by the selected metric's immutable capability. This is a binding,
 * not a semantic guess: zero or multiple capability-backed cards leave the
 * requirement unresolved for the normal clarify/gap path.
 */
function hostBoundCategoricalExtensions(input: {
  metricCandidate: AgentEvidenceCandidate;
  candidates: AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
}): AgentEvidenceCandidate[] {
  const bound: AgentEvidenceCandidate[] = [];
  for (const requested of categoricalDimensionRequirementTerms(input.requirements)) {
    const matches = input.candidates.filter((candidate) =>
      isSameSnapshotCategoricalExtensionForMetric(candidate, input.metricCandidate)
      && normalizeMetricPhrase(candidate.sameSnapshotRoleExtension!.requestedTerm)
        === normalizeMetricPhrase(requested));
    if (matches.length === 1) bound.push(matches[0]!);
  }
  return bound.filter((candidate, index, all) =>
    all.findIndex((item) => item.id === candidate.id) === index);
}

function directResolution(
  request: AgentRunRequest,
  evidence: AgentRetrievalEvidence,
  candidate: AgentEvidenceCandidate,
  candidates: AgentEvidenceCandidate[],
  selectedDimensionIds: string[] = [],
  selectedDimensionConceptIds: string[] = selectedDimensionIds,
): MeaningResolution {
  // Keep deterministic/direct routing on the same host-owned tuple as the
  // model path. Raw parser terms are retrieval hints only: they may not turn a
  // normalized business alias back into a phantom metric or dimension after
  // the meaning boundary has been intentionally skipped.
  const requirementSeed = buildAnalyticalRequirementSeedV1({
    question: request.question,
    parsedIntent: evidence.parsedIntent,
    fiscalCalendar: declaredFiscalCalendar(evidence, candidates),
  });
  const hostOwnedEvidence: AgentRetrievalEvidence = {
    ...evidence,
    parsedIntent: {
      ...evidence.parsedIntent,
      measures: requirementSeed.queryIntent.measures,
      dimensions: requirementSeed.queryIntent.dimensions,
      filters: requirementSeed.queryIntent.filters,
      ...(requirementSeed.queryIntent.timeRange ? { timeRange: requirementSeed.queryIntent.timeRange } : {}),
      ...(requirementSeed.queryIntent.timeGrain ? { timeGrain: requirementSeed.queryIntent.timeGrain } : {}),
      ...(requirementSeed.queryIntent.order ? { order: requirementSeed.queryIntent.order } : {}),
      ...(requirementSeed.queryIntent.limit !== undefined ? { limit: requirementSeed.queryIntent.limit } : {}),
    },
  };
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
    hostOwnedEvidence,
    candidate,
    candidates,
  );
  const requirements = requirementSeed.requirements;
  const hostBoundExtensions = hostBoundCategoricalExtensions({
    metricCandidate: candidate,
    candidates,
    requirements,
  });
  const resolvedSelectedDimensionIds = [...new Set([
    ...selectedDimensionIds,
    ...hostBoundExtensions.map((item) => item.qualifiedId ?? item.id),
  ])];
  const analyticalFrame = buildDeterministicAnalyticalFrame({
    question: request.question,
    questionType,
    evidence: hostOwnedEvidence,
    metricCandidate: candidate,
    metricCandidates,
    entityTerms: requirements.entityTerms,
    entityDisplayTerms: requirements.entityDisplayTerms,
    selectedDimensionIds: resolvedSelectedDimensionIds,
    candidates,
  });
  const defaultIntent = defaultQueryIntent(hostOwnedEvidence);
  // `top` without a count is a deterministic product convention, not a
  // missing business meaning.  Bind the default into the direct execution
  // nomination while the typed requirements retain `defaultedLimit: true` for
  // the answer/receipt to disclose the assumption.
  const rankedDefaultIntent = requirements.ranking
    ? {
        ...defaultIntent,
        order: defaultIntent.order ?? (requirements.ranking.direction === 'bottom' ? 'asc' as const : 'desc' as const),
        limit: defaultIntent.limit ?? requirements.ranking.limit,
      }
    : defaultIntent;
  // An exact authored certified example has already proved this block's own
  // output contract. Parser wording such as "food and drink" describes the
  // values of the block's declared `category` output; it must not manufacture
  // two literal dimensions and overrule that local contract. Only replace
  // dimensions when the selected block explicitly declares them, while the
  // strict requested-measure check remains unchanged.
  const exactCertifiedExample = candidate.kind === 'certified_block'
    && candidate.exactMatch
    && candidate.compatibility === 'compatible'
    && candidate.analyticalFitClass === 'exact'
    && certifiedCandidateExplicitlyCoversMeasures(candidate, defaultIntent.measures)
    && (candidate.dimensions?.length ?? 0) > 0;
  const queryIntent = exactCertifiedExample
    ? { ...rankedDefaultIntent, dimensions: candidate.dimensions ?? [] }
    : rankedDefaultIntent;
  // Preserve a selected semantic field as a typed dimension binding rather
  // than folding its label into the question. The ID comes from the selected
  // metric's capability contract, so the immutable plan will revalidate it
  // against the same snapshot before it can freeze.
  const selectedQueryDimensions = analyticalFrame?.dimensions
    // Server-issued structured selections may add their qualified identity to
    // the intent carrier. A host-bound same-snapshot extension instead binds
    // through the V2 frame below; adding its ID as a second text dimension
    // would create a duplicate request (`region` plus its qualified field).
    .filter((binding) => selectedDimensionIds.includes(binding.dimensionId))
    .map((binding) => binding.dimensionId) ?? [];
  // A direct host resolution can bind a categorical capability dimension from
  // the current question without a model-selected member card. Carry the
  // *actual* same-snapshot card into the resolution as well, otherwise the
  // immutable solver sees a valid V2 frame but cannot prove the selected
  // MetricFlow grouping evidence and incorrectly marks the tuple partial.
  // This is not a fuzzy name lookup: the candidate must be the dimension's
  // own qualified identity or the already-recorded same-snapshot extension.
  const hostBoundDimensionConceptIds = analyticalFrame?.dimensions.flatMap((binding) =>
    hostBoundExtensions
      .filter((item) => (item.qualifiedId ?? item.id) === binding.dimensionId)
      .map((item) => item.id),
  ) ?? [];
  const queryIntentWithSelectedDimensions = selectedQueryDimensions.length > 0
    ? {
        ...queryIntent,
        dimensions: [...new Set([
          ...queryIntent.dimensions,
          ...selectedQueryDimensions,
        ])],
      }
    : queryIntent;
  const memberCandidates = candidates.filter((item) => {
    if (item.kind !== 'semantic_member' || item.compatibility === 'incompatible') return false;
    const identities = [item.name, ...(item.aliases ?? [])].map(normalizeMetricPhrase).filter(Boolean);
    return queryIntentWithSelectedDimensions.filters.some((filter) => identities.includes(normalizeMetricPhrase(filter.value)));
  });
  const canonicalFilters = queryIntentWithSelectedDimensions.filters.map((filter) => {
    const member = memberCandidates.find((item) =>
      [item.name, ...(item.aliases ?? [])]
        .map(normalizeMetricPhrase)
        .includes(normalizeMetricPhrase(filter.value)));
    return member ? { ...filter, value: member.name } : filter;
  });
  return {
    interpretedQuestion: request.question,
    questionType,
    selectedConceptIds: [...metricCandidates, ...memberCandidates]
      .map((item) => item.id)
      .concat(selectedDimensionConceptIds, hostBoundDimensionConceptIds)
      .filter((id, index, all) => all.indexOf(id) === index),
    recommendedExecutionId: candidate.id,
    queryIntent: { ...queryIntentWithSelectedDimensions, filters: canonicalFilters },
    rejectedCandidates: [],
    confidence: "high",
    missingInformation: [],
    recommendedRoute: routeForEvidenceCandidate(candidate),
    // Direct/exact routing deliberately bypasses the model, not the host
    // meaning boundary.  Carry the same immutable seed into plan binding so
    // display-key projection and downstream receipts cannot fall back to raw
    // parser wording.
    hostRequirementSeed: requirementSeed,
    ...(selectedDimensionIds.length > 0
      ? { structuredDimensionIds: [...new Set(selectedDimensionIds)] }
      : {}),
    ...(analyticalFrame ? { analyticalFrame } : {}),
  };
}

/**
 * Build the V2 execution frame after the one candidate-ID meaning call.
 *
 * The model's response has already passed package membership validation.  It
 * may therefore identify a supplied semantic metric and supplied semantic
 * members, but it is never allowed to author the frame itself.  This helper
 * rebuilds the frame from the immutable host seed plus those qualified
 * identities, exactly as {@link directResolution} does for a zero-call path.
 *
 * Keeping this boundary here is important: a candidate-only model response
 * used to bind a perfectly valid semantic tuple into a V1 plan.  V1 plans
 * bypass the immutable analytical execution graph and fall into the legacy
 * semantic SQL path, where generic aggregation validation cannot prove a
 * MetricFlow capability.  A host-built V2 frame keeps the selected semantic
 * route compiler-owned without letting the model change the requested tuple.
 */
function attachHostOwnedAnalyticalFrame(input: {
  request: AgentRunRequest;
  evidence: AgentRetrievalEvidence;
  candidates: AgentEvidenceCandidate[];
  requirementSeed: AnalyticalRequirementSeedV1;
  resolution: MeaningResolution;
}): MeaningResolution {
  const { request, evidence, candidates, requirementSeed, resolution } = input;
  if (resolution.recommendedRoute !== 'semantic' || resolution.questionType === 'definition') {
    return resolution;
  }
  const matchesIdentity = (candidate: AgentEvidenceCandidate, identity: string | undefined): boolean =>
    Boolean(identity && (candidate.id === identity || candidate.qualifiedId === identity));
  const metricCandidate = candidates.find((candidate) =>
    candidate.kind === 'semantic_metric'
    && matchesIdentity(candidate, resolution.recommendedExecutionId))
    ?? candidates.find((candidate) =>
      candidate.kind === 'semantic_metric'
      && resolution.selectedConceptIds.some((identity) => matchesIdentity(candidate, identity)));
  if (!metricCandidate || normalizeEvidenceAnalyticalCapability(metricCandidate).status !== 'complete') {
    return resolution;
  }

  // Parsed intent is retrieval evidence only.  The deterministic frame reads
  // the same host-owned seed that the plan will later bind, so stale retrieval
  // terms cannot re-enter as a metric, dimension, filter, output, or time
  // constraint merely because the model selected an otherwise valid card.
  const hostOwnedEvidence: AgentRetrievalEvidence = {
    ...evidence,
    parsedIntent: {
      ...evidence.parsedIntent,
      measures: [...requirementSeed.queryIntent.measures],
      dimensions: [...requirementSeed.queryIntent.dimensions],
      filters: requirementSeed.queryIntent.filters.map((filter) => ({ ...filter })),
      ...(requirementSeed.queryIntent.timeRange
        ? { timeRange: requirementSeed.queryIntent.timeRange }
        : {}),
      ...(requirementSeed.queryIntent.timeGrain
        ? { timeGrain: requirementSeed.queryIntent.timeGrain }
        : {}),
      ...(requirementSeed.queryIntent.order
        ? { order: requirementSeed.queryIntent.order }
        : {}),
      ...(requirementSeed.queryIntent.limit !== undefined
        ? { limit: requirementSeed.queryIntent.limit }
        : {}),
    },
  };
  const modelSelectedDimensionIds = resolution.selectedConceptIds.flatMap((identity) => {
    const candidate = candidates.find((item) => matchesIdentity(item, identity));
    return candidate?.kind === 'semantic_member'
      ? [candidate.qualifiedId ?? candidate.id]
      : [];
  });
  const hostBoundExtensions = hostBoundCategoricalExtensions({
    metricCandidate,
    candidates,
    requirements: requirementSeed.requirements,
  });
  const selectedDimensionIds = [...new Set([
    ...modelSelectedDimensionIds,
    ...hostBoundExtensions.map((candidate) => candidate.qualifiedId ?? candidate.id),
  ])];
  const analyticalFrame = buildDeterministicAnalyticalFrame({
    question: requirementSeed.sourceQuestion,
    questionType: resolution.questionType,
    evidence: hostOwnedEvidence,
    metricCandidate,
    metricCandidates: explicitlyRequestedMetricCandidates(
      requirementSeed.sourceQuestion,
      hostOwnedEvidence,
      metricCandidate,
      candidates,
    ),
    entityTerms: requirementSeed.requirements.entityTerms,
    entityDisplayTerms: requirementSeed.requirements.entityDisplayTerms,
    selectedDimensionIds,
    candidates,
  });
  if (!analyticalFrame) return resolution;
  const hostBoundConceptIds = hostBoundExtensions.map((candidate) => candidate.id);
  const selectedConceptIds = [...new Set([
    ...resolution.selectedConceptIds,
    ...hostBoundConceptIds,
  ])];
  const overrideReceipts = hostBoundConceptIds.length > 0
    ? [
        ...(resolution.overrideReceipts ?? []),
        {
          version: 1 as const,
          field: 'candidate_selection' as const,
          action: 'host_preserved' as const,
          reason: 'A unique, same-snapshot MetricFlow grouping field is required by the host-owned categorical dimension and cannot be removed by a model omission.',
          candidateIds: hostBoundConceptIds,
        },
      ]
    : resolution.overrideReceipts;
  return {
    ...resolution,
    selectedConceptIds,
    analyticalFrame,
    ...(overrideReceipts?.length ? { overrideReceipts } : {}),
  };
}

function explicitlyRequestedMetricCandidates(
  question: string,
  evidence: AgentRetrievalEvidence,
  primary: AgentEvidenceCandidate,
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate[] {
  const requirements = buildAnalyticalRequirementSet({ question, parsedIntent: evidence.parsedIntent });
  const requested = requirements.ranking?.metricTerms.length
    ? requirements.ranking.metricTerms
    : requirements.measures;
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
    if (candidateConflictsWithExplicitRankingMeasure(candidate, requirements)) return false;
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
    // Assume the measure where one is clearly indicated, and BIND it through the
    // same resolution path an explicit selection takes — an assumption that
    // cannot freeze a plan is refused downstream and surfaces as `blocked` with
    // no options, which is worse than the question it replaced.
    const assumed = mayAssumeInterpretation
      ? assumableRankingMeasure(request.question, rankingCandidates)
      : undefined;
    if (assumed) {
      return {
        ...routeDecisionForResolution(
          base,
          evidence,
          candidates,
          directResolution(request, evidence, assumed.candidate, candidates),
          'heuristic',
          request.question,
          planMode,
        ),
        assumptions: [assumed.assumption],
      };
    }
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
      && rankingCandidates.includes(candidate)
      && candidateMayTerminateCertifiedForMeasures(candidate, evidence.parsedIntent?.measures ?? []),
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
    ? bestGovernedInterpretation(
        request.question,
        rankingCandidates,
        evidence.parsedIntent?.measures ?? [],
      )
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

/**
 * A bounded meaning call may return malformed JSON or a syntactically valid
 * low-confidence response with no candidate binding.  It must not override a
 * plan the host can prove from one exact current-turn semantic identity.  The
 * predicate deliberately requires a frozen executable plan: ordinary metric
 * ambiguity, a coverage gap, policy denial, and every unfrozen candidate still
 * take their existing clarification/block paths.
 */
function isFrozenExecutableHostFallback(decision: IntentDecision): boolean {
  return decision.analyticalCascadeDecision?.planFrozen === true
    && Boolean(decision.resolvedAnalyticalPlan)
    && !decision.requiresClarification
    && !decision.terminalOutcome;
}

function meaningResolutionHasNoBinding(resolution: MeaningResolution): boolean {
  return resolution.selectedConceptIds.length === 0
    && !resolution.recommendedExecutionId
    && (resolution.emptyCandidateBinding === true || (
      !resolution.clarifyingQuestion
      && resolution.recommendedRoute !== 'clarify'
      && resolution.compatibilityOutcome !== 'clarify'
      && resolution.missingInformation.length === 0
      && resolution.rejectedCandidates.length === 0
    ));
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

  // An entity is a JOIN KEY. It is a reading of "how many customers", but never
  // of "what customer type is <member>" — there the reader named a field and a
  // member, and the entity cannot answer either. The trigger used to be a
  // four-word list (name/label/title/description), so "customer type", "region",
  // and "when did X first order" all left the entity competing and turned an
  // ordinary attribute lookup into a bind-interrogation. Recognise the
  // interrogative FORM as well as the vocabulary; `hasDimension` below still
  // requires that a real attribute was actually retrieved.
  const wantsAttribute = /\b(names?|labels?|titles?|descriptions?|types?|status(?:es)?|categor(?:y|ies)|segments?|tiers?|regions?|emails?|addresses?)\b/i.test(question)
    || /\b(what|which|when|where)\b[^?]*\b(is|are|was|were|does|do|did|belongs?)\b/i.test(question);
  const hasDimension = byScore.some((candidate) => candidate.semanticObjectType === 'dimension');
  // An entity arrives as a semantic-layer entity OR as a DQL modeling entity
  // (`dql:entity:…`, kind `dql_modeling`). Testing only `semanticObjectType`
  // left the DQL one competing, so the interrogation survived the fix above.
  // Check BOTH identities: a DQL entity's `qualifiedId` is the bare
  // `commerce::entity::customer`, so testing the qualified id alone still let
  // it through.
  const isEntityCandidate = (candidate: AgentEvidenceCandidate): boolean =>
    candidate.semanticObjectType === 'entity'
    || [candidate.id, candidate.qualifiedId ?? ''].some((identity) =>
      /(^|:)entity(:|::)/i.test(identity));
  const entityFiltered = wantsAttribute && hasDimension
    ? byScore.filter((candidate) => !isEntityCandidate(candidate))
    : byScore;

  // Within an attribute question, a candidate matching only a SUB-TOKEN of the
  // requested field is a lexical decoy, not a competing reading. "What customer
  // type is <member>?" dragged in `raw_products.type` and
  // `orders.new_customer_orders` purely because they contain "type" and
  // "customer", and two decoys are enough to trip the ambiguity gate and turn
  // the lookup into an interrogation. Score how much of the question each
  // candidate actually accounts for — including the fields a block declares,
  // which is how the block that OUTPUTS `customer_type` outranks a column
  // merely named `type` — and keep only the most specific matches.
  const normalizedQuestion = normalizeMetricPhrase(question);
  const phraseSpecificity = (candidate: AgentEvidenceCandidate): number => {
    const terms = [
      candidate.name,
      ...(candidate.aliases ?? []),
      ...(candidate.dimensions ?? []),
      ...(candidate.compatibilityFacts ?? [])
        .filter((fact) => fact.startsWith('output: '))
        .map((fact) => fact.slice('output: '.length)),
    ].map((term) => normalizeMetricPhrase(String(term ?? '').split(/[.:/]/).at(-1) ?? ''));
    let best = 0;
    for (const term of terms) {
      if (!term) continue;
      const matches = normalizedQuestion === term
        || normalizedQuestion.startsWith(`${term} `)
        || normalizedQuestion.endsWith(` ${term}`)
        || normalizedQuestion.includes(` ${term} `);
      if (matches) best = Math.max(best, term.split(' ').length);
    }
    return best;
  };
  const specificity = new Map(entityFiltered.map((candidate) => [candidate.id, phraseSpecificity(candidate)]));
  const bestSpecificity = Math.max(0, ...specificity.values());
  // Only prune when something matched a MULTI-word field name. A single shared
  // token is not enough evidence to call the others decoys.
  const kindFiltered = wantsAttribute && hasDimension && bestSpecificity >= 2
    ? entityFiltered.filter((candidate) => (specificity.get(candidate.id) ?? 0) === bestSpecificity)
    : entityFiltered;

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
  requestedMeasures: string[] = [],
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
      || candidate.kind === 'semantic_member')
    && (candidate.kind !== 'certified_block'
      || certifiedCandidateExplicitlyCoversMeasures(candidate, requestedMeasures)));
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
  // This generic fallback has no provider/plan-issued role target yet. Build
  // its strict option roles from the user's words only; inherited parsed-intent
  // hints can still guide later plan construction but must not hide every
  // valid compositional or dimension choice.
  const clarificationRequirements = buildAnalyticalRequirementSet({ question });
  const physicalRequirements = buildAnalyticalRequirementSet({
    question,
    parsedIntent: evidence?.parsedIntent,
  });
  const fallbackToPhysicalCascade = (): IntentDecision | undefined => {
    if (!evidence) return undefined;
    const requiredPhysicalFieldTerms = [
      ...physicalRequirements.dimensions,
      ...physicalRequirements.entityTerms,
      ...physicalRequirements.entityDisplayTerms,
      ...(evidence.parsedIntent?.filters ?? []).map((filter) => filter.field),
    ];
    return preFreezePhysicalCascadeDecision({
      base,
      evidence,
      candidates,
      question,
      requirements: physicalRequirements,
      missingTerms: physicalRequirements.dimensions,
      requiredPhysicalFieldTerms,
      messagePrefix: 'No certified, semantic, or governed relational candidate proved the complete requested tuple before plan freeze.',
      terminalCandidateIds: eligible.map((candidate) => candidate.qualifiedId ?? candidate.id),
    });
  };
  if (eligible.length > 1) {
    // Raw candidates can be complementary rather than competing. Do not ask a
    // person to pick between the table that supplies the display value and the
    // table that supplies the requested predicate when their qualified,
    // same-snapshot relationship proof already closes a safe exploration path.
    // The helper is deliberately stricter than generic retrieval: missing a
    // display/predicate role, a shared key, or relationship/fanout proof keeps
    // this exact clarification path intact.
    const composition = evidence
      ? complementaryExploratoryDecision(base, evidence, candidates, question)
      : undefined;
    if (composition) return composition;
    const choices = compatibleClarificationCandidates(eligible, clarificationRequirements).slice(0, 3);
    if (choices.length === 0) {
      return fallbackToPhysicalCascade() ?? (() => {
        const message = 'No retrieved artifact owns every explicitly requested analytical role, so DQL did not offer an incompatible structured selection.';
        return {
          ...base,
          action: 'block' as const,
          confidence: 1,
          source: 'heuristic' as const,
          category: 'data_lookup' as const,
          depth: 'quick' as const,
          reason: message,
          requiresClarification: false,
          retrievalEvidence: trace,
          terminalOutcome: { kind: 'modeling_gap' as const, code: 'ANALYTICAL_MODELING_GAP' as const, message, candidateIds: eligible.map((candidate) => candidate.qualifiedId ?? candidate.id) },
          resolvedAnalyticalPlan: undefined,
          meaningResolution: undefined,
        };
      })();
    }
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
      clarificationOptions: buildClarificationOptions(choices, clarificationRequirements),
      retrievalEvidence: trace,
      resolvedAnalyticalPlan: undefined,
      meaningResolution: undefined,
    };
  }

  const candidateIds = eligible.map((candidate) => candidate.qualifiedId ?? candidate.id);
  const message = candidateIds.length === 1
    ? `The retrieved governed candidate ${candidateIds[0]} did not prove the complete requested metric, grain, filters, ordering, and outputs. Model the missing capability before retrying.`
    : 'No governed candidate proved the complete requested metric, grain, filters, ordering, and outputs. Model the missing capability or choose a governed identifier before retrying.';
  const physicalFallback = fallbackToPhysicalCascade();
  if (physicalFallback) return physicalFallback;
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
  const requirements = buildAnalyticalRequirementSet({
    question: request.question,
    parsedIntent: evidence.parsedIntent,
  });
  const requestedMeasures = (evidence.parsedIntent?.measures ?? [])
    .map(normalizeMetricPhrase)
    .filter(Boolean);
  const hasExplicitRankingMetric = requestedMeasures.length > 0
    && requestedMeasures.every((requested) =>
      candidates.some((candidate) => candidateProvesMetricTerm(candidate, requested)))
    || hasStrongQualifiedMetricEvidence(candidates)
    || hasQuestionQualifiedMetricEvidence(request.question, evidence, candidates);
  const retrievalEvidence = retrievalTrace(evidence, candidates);

  // “by month” is a time role/grain, and FY26 is a fiscal-period filter. They
  // are not requests for literal `month`/`year` columns. A fiscal token still
  // requires a declared calendar at compilation time; this router simply must
  // not manufacture one or report an absence before relational/runtime context
  // has had a chance to bind the declared date role.
  // The host-owned requirements are the canonical reader tuple. Parsed intent
  // is only a retrieval seed: carrying its raw phrase here made "sales based
  // on the region" look like a literal physical dimension even after the
  // requirement seed had correctly normalized it to `region`.
  const requestedDimensions = requirements.dimensions
    .filter((dimension) => !/^(?:date|day|week|month|quarter|year|fiscal year|fy\d{2,4})$/.test(dimension));
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
      // Bare rankings need a measure choice, not a dimension gap. Retain the
      // no-options escape hatch only when the snapshot does not also expose a
      // typed structural request. For "top customers for perishable products",
      // a no-option ranking response previously hid the missing safe
      // customer→order→item→supply closure behind an answer-shaped dead end.
      // Record that pre-freeze gap instead; this still never invents a ranking
      // measure or a relationship.
      if (asksForRanking && !hasExplicitRankingMetric) {
        const rankingClarification = bareRankingClarification(
          base,
          retrievalEvidence,
          request.question,
          evidence,
          candidates,
        );
        if (rankingClarification.action === 'clarify'
          && (rankingClarification.clarificationOptions?.length ?? 0) > 0) {
          return rankingClarification;
        }
        return preFreezePhysicalCascadeDecision({
          base,
          evidence,
          candidates,
          question: request.question,
          requirements,
          missingTerms: missingDimensions,
          requiredPhysicalFieldTerms: (evidence.parsedIntent?.filters ?? []).map((filter) => filter.field),
          messagePrefix: `No governed ranking measure and no complete governed tuple proved ${missingDimensions.map((term) => `“${term}”`).join(' and ')} before plan freeze.`,
          requireRankingMetric: true,
        });
      }
      // Parsed-intent hints can include inherited/default dimensions that the
      // user never asked for. Only turn a missing field into a product-facing
      // modeling gap when its wording is present in this turn; otherwise let
      // bounded meaning resolution preserve its own ambiguity contract.
      const normalizedQuestion = normalizeMetricPhrase(request.question);
      if (!missingDimensions.every((dimension) => normalizedQuestion.includes(dimension))) return undefined;
      const requestedLabel = missingDimensions.map((term) => `“${term}”`).join(' and ');
      const temporalNote = requirements.time?.fiscalPeriod
        ? ` ${requirements.time.fiscalPeriod} remains an unbound fiscal-period token until a declared calendar is available; DQL will not guess one.`
        : '';
      return preFreezePhysicalCascadeDecision({
        base,
        evidence,
        candidates,
        question: request.question,
        requirements,
        missingTerms: missingDimensions,
        requiredPhysicalFieldTerms: (evidence.parsedIntent?.filters ?? []).map((filter) => filter.field),
        messagePrefix: `The certified and semantic candidates did not prove ${requestedLabel}.${temporalNote}`,
      });
    }
    // A single declared alternative can only be assumed when an executable
    // metric capability in this same snapshot explicitly contains it. A bare
    // standalone semantic member (for example `location_name` marked as an
    // alternative for `region`) is evidence of a possible wording, not proof
    // that it can safely answer this tuple. Without that closure, retain the
    // concise modeled-gap clarification rather than letting a later meaning
    // path substitute an unrelated field or metric.
    if (alternatives.length === 1
      && declaredDimensionAlternativeCompletesExecutableTuple(
        alternatives[0]!,
        candidates,
        requirements,
      )) return undefined;
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
 * The broad router terminal witness can carry reader-safe missing-role prose
 * for several gap classes.  Observability persists only the relationship
 * variant, and only as an enumerated proof requirement, so an export cannot
 * accidentally turn an unresolved question term into trace content.
 */
function cascadeTerminalRelationshipGap(
  gap: AnalyticalTerminalGapWitness | undefined,
): AnalyticalCascadeTerminalGapV1 | undefined {
  if (!gap || gap.code !== 'MISSING_RELATIONSHIP') return undefined;
  return {
    version: 1,
    code: 'MISSING_RELATIONSHIP',
    requirement: 'certified_relationship_or_allocation_proof',
    witnessCandidateIds: [...new Set(gap.witnessCandidateIds)].sort().slice(0, 32),
  };
}

/**
 * A clarification with NO selectable options is unanswerable, and asking it is a
 * dead end rather than a safety measure.
 *
 * Reported from production: "who are the top customers for BCM" returned
 * "Top by which governed metric?" with zero choices. Answering it in prose
 * ("...who have top revenue") produced the IDENTICAL question again, because the
 * reply carries no `selectedEvidenceId` and re-enters the same path with the
 * same evidence. A question that can only be answered by clicking a button that
 * was never rendered loops forever.
 *
 * When the option list is empty the failure is in RETRIEVAL, not in the user's
 * phrasing, so continue into the review-required generated lane and let the
 * answer carry the caveat. `requiresClarification` is cleared deliberately:
 * leaving it set would make `answerAnywayRoute` treat this as material ambiguity
 * and re-block the turn.
 */
function unanswerableClarificationFallback(
  base: IntentDecision,
  retrievalEvidence: IntentDecision['retrievalEvidence'],
  reason: string,
): IntentDecision {
  return {
    ...base,
    action: 'answer',
    confidence: Math.min(base.confidence, 0.5),
    source: 'heuristic',
    category: 'data_lookup',
    requiresClarification: false,
    clarifyingQuestion: undefined,
    clarificationOptions: undefined,
    reason,
    ...(retrievalEvidence ? { retrievalEvidence } : {}),
    resolvedAnalyticalPlan: undefined,
    meaningResolution: undefined,
  };
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
/**
 * Generic measure vocabulary: words that say HOW MUCH, never WHICH SUBSET.
 * A candidate built only from these adds no scope the asker did not state.
 */
const GENERIC_MEASURE_TOKENS = new Set([
  'revenue', 'spend', 'spending', 'sale', 'amount', 'value', 'total', 'sum',
  'count', 'number', 'order', 'quantity', 'qty', 'price', 'cost', 'profit',
  'margin', 'gross', 'net', 'lifetime', 'avg', 'average', 'mean', 'median', 'score',
  'rate', 'ratio', 'percent', 'share', 'volume', 'unit', 'balance', 'pretax', 'ltv',
  'top', 'rank', 'ranking', 'by', 'per', 'the', 'of', 'and',
]);

/**
 * Crude, symmetric singularization. Applied to BOTH sides, so the only thing
 * that matters is that it agrees with itself — `address` becoming `addres` is
 * harmless when the question's `address` becomes `addres` too. Without it a
 * candidate named `customers.customer_value` is rejected against the question
 * "who are the top customers", because the singular `customer` is neither a
 * question word nor generic measure vocabulary. That is a morphology accident,
 * not an unrequested scope, and it silently refused good assumptions.
 */
function singularize(token: string): string {
  if (token.length > 3 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && (token.endsWith('ses') || token.endsWith('xes') || token.endsWith('zes'))) {
    return token.slice(0, -2);
  }
  if (token.length > 2 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/**
 * Pick the measure a bare ranking should assume, or nothing.
 *
 * Returns the CANDIDATE, not a decision, because the assumption is only useful
 * where it can be bound: an `action: 'answer'` with no frozen analytical plan is
 * refused by the plan boundary and reaches the user as `blocked` with no
 * options, which is strictly worse than the clarification it replaced. Measured
 * exactly that way before this was moved to a caller that can bind it.
 */
export function assumableRankingMeasure(
  question: string,
  candidates: AgentEvidenceCandidate[],
): { candidate: AgentEvidenceCandidate; assumption: AnswerAssumption } | undefined {
  // Only a MEASURE can be assumed. A certified block is a whole authored query,
  // not a ranking measure, so treating one as the answer to "by which metric?"
  // silently selects someone else's entire analysis.
  const assumable = candidates.filter((candidate) =>
    (candidate.kind === 'semantic_metric' || candidate.kind === 'semantic_member')
    && candidate.compatibility !== 'incompatible'
    && rankingCandidateFitsBareQuestion(question, candidate));
  if (assumable.length === 0) return undefined;
  const assumption = assumeDominantCandidate({
    about: 'metric',
    candidates: assumable.map((candidate) => ({
      id: candidate.qualifiedId ?? candidate.id,
      label: candidate.name,
      score: candidate.relevanceScore,
    })),
    because: (chosen) => `"${chosen.label ?? chosen.id}" was the highest-ranked governed measure that can rank this entity, and it adds no filter the question did not ask for.`,
  });
  if (!assumption) return undefined;
  const chosen = assumable.find((candidate) =>
    (candidate.qualifiedId ?? candidate.id) === assumption.chose);
  return chosen ? { candidate: chosen, assumption } : undefined;
}

/**
 * Does this ranking measure fit a question that named no measure?
 *
 * "Top customers" must not be silently answered by `top_beverage_customers`:
 * that candidate carries a scope — beverages — the asker never asked for, and
 * answering with it returns a confidently wrong list under a different question
 * than the one posed. `assumeDominantCandidate` deliberately leaves this check
 * to the caller, because dominance is about ranking and this is about meaning.
 *
 * The rule: every substantive token in the candidate's name must be either
 * something the question already said, or generic measure vocabulary. Any
 * leftover token is an unrequested qualifier, and the turn keeps asking.
 */
export function rankingCandidateFitsBareQuestion(question: string, candidate: AgentEvidenceCandidate): boolean {
  const questionTokens = new Set(substantiveLexicalTokens(question).map(singularize));
  // Identities arrive source-qualified (`semantic:metric:orders.revenue`). The
  // `semantic`/`metric` prefix is plumbing, not vocabulary — tokenizing it would
  // make every candidate look scoped and refuse every assumption.
  const identity = (candidate.qualifiedId ?? candidate.id ?? '').split(':').at(-1) ?? '';
  const nameTokens = substantiveLexicalTokens([candidate.name, identity].join(' '));
  if (nameTokens.length === 0) return false;
  return nameTokens.map(singularize).every((token) =>
    questionTokens.has(token) || GENERIC_MEASURE_TOKENS.has(token));
}

function bareRankingClarification(
  base: IntentDecision,
  retrievalEvidence: NonNullable<IntentDecision['retrievalEvidence']>,
  question?: string,
  evidence?: AgentRetrievalEvidence,
  candidates?: AgentEvidenceCandidate[],
  /**
   * May this turn settle the measure by assumption rather than by asking?
   * False wherever the step whose job is to judge ambiguity has positively
   * reported some — assuming past a finding overrides it rather than filling a
   * gap, and AGT-017 already establishes that lexical rank alone must not
   * settle meaning when semantic judgment is unavailable.
   */
  mayAssume = true,
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
  if (rankingChoices.length === 0) {
    return unanswerableClarificationFallback(
      base,
      retrievalEvidence,
      'No retrieved governed measure can rank this entity, so DQL continued into the review-required generated lane instead of asking a question with no selectable answer.',
    );
  }
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
    clarificationOptions: buildClarificationOptions(rankingChoices),
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
    // A block's relevance/tag/example must never impersonate one of its
    // outputs.  Only a declared block output may prove an explicit requested
    // metric (AGT-009/AGT-010).
    return candidate.compatibility === 'compatible'
      && certifiedCandidateExplicitlyCoversMeasures(candidate, [requested]);
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
  const extension = candidate.sameSnapshotRoleExtension;
  if (extension?.role === 'categorical_dimension'
    && (extension.basis === 'sole_metricflow_grouping_dimension'
      || extension.basis === 'exact_metricflow_grouping_dimension')
    && missingDimensions.some((requested) =>
      normalizeMetricPhrase(requested) === normalizeMetricPhrase(extension.requestedTerm))) return true;
  const facts = candidate.compatibilityFacts?.map(normalizeMetricPhrase) ?? [];
  return missingDimensions.some((requested) =>
    facts.includes(`alternative for ${requested}`)
    || facts.includes(`dimension alternative for ${requested}`));
}

function declaredDimensionAlternativeCompletesExecutableTuple(
  alternative: AgentEvidenceCandidate,
  candidates: AgentEvidenceCandidate[],
  requirements: AnalyticalRequirementSetV1,
): boolean {
  // A substitution is executable only when a metric capability in the same
  // snapshot names this exact qualified dimension.  Do not treat a lone
  // semantic-member card as an authorization to change the reader's request.
  if (requirements.measures.length === 0) return false;
  const alternativeId = alternative.qualifiedId ?? alternative.id;
  return candidates.some((candidate) => {
    if (candidate.kind !== 'semantic_metric' || candidate.compatibility === 'incompatible') return false;
    if (!requirements.measures.every((measure) => candidateProvesMetricTerm(candidate, measure))) return false;
    const normalized = normalizeEvidenceAnalyticalCapability(candidate);
    return normalized.status === 'complete'
      && Boolean(normalized.capability?.dimensions.some((dimension) => dimension.dimensionId === alternativeId));
  });
}

/**
 * A declared dimension alternative is safe only after the immutable plan has
 * bound that exact qualified field. This makes the one permitted vocabulary
 * substitution visible to the reader without letting a raw parser phrase or
 * model response authorize it.
 */
function assumptionsForDeclaredDimensionAlternatives(input: {
  question: string;
  evidence: AgentRetrievalEvidence;
  candidates: AgentEvidenceCandidate[];
  plan: ResolvedAnalyticalPlan;
}): AnswerAssumption[] {
  const requirements = buildAnalyticalRequirementSet({
    question: input.question,
    parsedIntent: input.evidence.parsedIntent,
  });
  const boundDimensionIds = new Set(input.plan.query.dimensions
    .filter((binding) => binding.status === 'resolved' && binding.qualifiedId)
    .map((binding) => binding.qualifiedId!));
  const assumptions: AnswerAssumption[] = [];
  for (const requested of requirements.dimensions) {
    const alternatives = input.candidates
      .filter(isCompatibleQualifiedMember)
      .filter((candidate) => candidateIsDeclaredDimensionAlternative(candidate, [requested]))
      .filter((candidate) => boundDimensionIds.has(candidate.qualifiedId ?? candidate.id));
    if (alternatives.length !== 1) continue;
    const alternative = alternatives[0]!;
    const extension = alternative.sameSnapshotRoleExtension;
    const assumption = assumeDominantCandidate({
      about: 'dimension',
      candidates: [{
        id: alternative.qualifiedId ?? alternative.id,
        label: alternative.name,
        score: alternative.relevanceScore,
      }],
      because: (chosen) => extension
        ? `“${requested}” is bound to ${chosen.label ?? chosen.id}, the sole same-snapshot MetricFlow grouping field shared by the selected metric.`
        : `“${requested}” is not modeled directly; ${chosen.label ?? chosen.id} is the sole compatible, declared alternative in this snapshot.`,
    });
    if (assumption) assumptions.push(assumption);
  }
  return assumptions;
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
  const requestedMeasures = [...new Set((evidence.parsedIntent?.measures ?? [])
    .map(normalizeMetricPhrase)
    .filter(Boolean))];
  const requestedTokens = metricTokens(requestedMeasures);
  if (requestedTokens.size === 0) return undefined;
  // Do this before capability normalization. Local metadata can retain an
  // executable semantic metric card while its pre-plan compatibility hint is
  // still partial/unknown; a selected provider binding correctly reaches the
  // capability solver in that state. The exact leaf identity is nevertheless
  // a real, qualified current-snapshot meaning. Dedupe only representations
  // of the same qualified metric, never two same-named metrics from different
  // models, and let the immutable cascade prove execution afterwards.
  if (requestedMeasures.length === 1) {
    const requested = requestedMeasures[0]!;
    const exactByMetricIdentity = new Map<string, AgentEvidenceCandidate>();
    for (const candidate of candidates) {
      if (candidate.kind !== 'semantic_metric'
        || candidate.compatibility === 'incompatible'
        || candidate.eligible === false
        || !candidateMetricLeafIdentities(candidate).includes(requested)) continue;
      const normalized = normalizeEvidenceAnalyticalCapability(candidate);
      const metricIdentity = normalized.capability?.metricId
        ?? candidate.qualifiedId
        ?? candidate.id;
      const current = exactByMetricIdentity.get(metricIdentity);
      if (!current || candidate.relevanceScore > current.relevanceScore) {
        exactByMetricIdentity.set(metricIdentity, candidate);
      }
    }
    if (exactByMetricIdentity.size === 1) {
      return [...exactByMetricIdentity.values()][0];
    }
  }
  const byMetricId = new Map<string, AgentEvidenceCandidate>();
  for (const candidate of candidates) {
    // Retrieval compatibility is a pre-plan hint. A current snapshot can mark
    // a MetricFlow metric `unknown`/`partial` until its selected grouping is
    // bound, even though the capability itself is complete. The direct route
    // below still solves the full tuple before freeze, so exclude only an
    // explicitly incompatible metric here rather than turning exact `revenue`
    // into an artificial choice against `product_revenue`.
    if (candidate.kind !== "semantic_metric" || candidate.compatibility === "incompatible") continue;
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
  // A malformed/empty candidate-ID meaning response may also safely fall back
  // when a complete capability proves one exact semantic metric identity from
  // the current-turn requirement seed. This is intentionally stricter than
  // the token fallback below: `order_items.revenue` has the leaf identity
  // `revenue`, whereas `order_items.product_revenue` is a different meaning
  // and must not force a clarification when the reader asked only for
  // revenue. Multi-metric questions retain their dedicated exact tuple path.
  if (requestedMeasures.length === 1) {
    const requested = requestedMeasures[0]!;
    const exactMatches = [...byMetricId.values()].filter((candidate) =>
      candidateMetricLeafIdentities(candidate).includes(requested));
    if (exactMatches.length === 1) return exactMatches[0];
  }
  return byMetricId.size === 1 ? [...byMetricId.values()][0] : undefined;
}

function candidateMetricLeafIdentities(candidate: AgentEvidenceCandidate): string[] {
  return [...new Set([
    candidate.id,
    candidate.qualifiedId ?? '',
    candidate.name,
    ...(candidate.aliases ?? []),
  ].flatMap((identity) => {
    const normalized = normalizeMetricPhrase(identity);
    const leaf = normalizeMetricPhrase(identity.split(/[.:/]/).at(-1) ?? identity);
    return [normalized, leaf].filter(Boolean);
  }))];
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
  requestedMeasures: string[] = [],
): AgentEvidenceCandidate | undefined {
  const compatible = candidates.filter((candidate) =>
    candidate.compatibility === "compatible"
    && (candidate.kind === "certified_block" || candidate.kind === "semantic_metric" || candidate.kind === "semantic_member")
    && candidateMayTerminateCertifiedForMeasures(candidate, requestedMeasures)
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
  requestedMeasures: string[] = [],
): AgentEvidenceCandidate | undefined {
  const exact = candidates.filter((candidate) =>
    candidate.kind === 'certified_block'
    && candidate.exactMatch
    && candidate.compatibility === 'compatible'
    && candidate.analyticalFitClass === 'exact'
    && certifiedCandidateExplicitlyCoversMeasures(candidate, requestedMeasures));
  return exact.length === 1 ? exact[0] : undefined;
}

/** Certified output coverage is a Tier-1 invariant; other routes pass through. */
function candidateMayTerminateCertifiedForMeasures(
  candidate: AgentEvidenceCandidate,
  requestedMeasures: string[],
): boolean {
  return candidate.kind !== 'certified_block'
    || certifiedCandidateExplicitlyCoversMeasures(candidate, requestedMeasures);
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
 * Admit the one narrowly typed extension produced by metadata only when it
 * closes an actually unmet requested categorical role and its source metric is
 * already in the compact meaning package.  The extension was derived from the
 * same immutable metric capability snapshot; this function does not search,
 * infer a join, or create an alias.  Multiple candidates for a role stay an
 * ambiguity instead of being silently ranked into a new business meaning.
 */
function sameSnapshotRoleTargetedMeaningExtensions(input: {
  candidates: AgentEvidenceCandidate[];
  clarificationCandidates: AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
}): AgentEvidenceCandidate[] {
  const extensionsByRole = new Map<string, AgentEvidenceCandidate[]>();
  const requestedCategoricalTerms = categoricalDimensionRequirementTerms(input.requirements);
  for (const candidate of input.clarificationCandidates) {
    const extension = candidate.sameSnapshotRoleExtension;
    if (!extension
      || extension.version !== 1
      || extension.role !== 'categorical_dimension'
      || (extension.basis !== 'sole_metricflow_grouping_dimension'
        && extension.basis !== 'exact_metricflow_grouping_dimension')
      || candidate.kind !== 'semantic_member'
      || (candidate.qualifiedId ?? candidate.id) !== extension.dimensionId) continue;
    if (!requestedCategoricalTerms.some((requested) =>
      normalizeMetricPhrase(requested) === normalizeMetricPhrase(extension.requestedTerm))) continue;
    // A raw/dbt column can lexically satisfy "product category", but it is
    // not a MetricFlow binding for this semantic metric.  Do not let that
    // broad retrieval hit suppress the exact same-snapshot semantic member:
    // otherwise a package contains only the raw column, the model cannot bind
    // the metric-native grouping, and the cascade falsely reports absence.
    // An already-admitted semantic member remains sufficient and keeps this
    // extension bounded to genuinely unmet semantic roles.
    if (input.candidates.some((admitted) =>
      admitted.kind === 'semantic_member'
      && candidateMatchesCategoricalDimensionRequirement(admitted, [extension.requestedTerm]))) continue;
    const sourceMetricAdmitted = input.candidates.some((admitted) =>
      admitted.kind === 'semantic_metric'
      && (admitted.id === extension.metricId || admitted.qualifiedId === extension.metricId));
    if (!sourceMetricAdmitted) continue;
    const role = normalizeMetricPhrase(extension.requestedTerm);
    const values = extensionsByRole.get(role) ?? [];
    if (!values.some((value) => value.id === candidate.id)) values.push(candidate);
    extensionsByRole.set(role, values);
  }
  return [...extensionsByRole.values()]
    .flatMap((values) => values.length === 1 ? values : [])
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Keep the role-targeted form of a qualified candidate when retrieval has
 * emitted both the ordinary catalog card and a same-snapshot extension with
 * the identical stable ID.  The extension is not a second object or a new
 * join: it is the metadata proof explaining why that exact qualified object
 * closes a currently unmet role for a selected metric.  Dropping it merely
 * because the less-specific catalog card appeared first makes the compact
 * meaning package lose a declared MetricFlow grouping and can manufacture a
 * false coverage gap.
 */
function consolidateClarificationCandidates(input: {
  candidates: AgentEvidenceCandidate[];
  requirements: AnalyticalRequirementSetV1;
}): AgentEvidenceCandidate[] {
  const byId = new Map<string, AgentEvidenceCandidate>();
  for (const candidate of input.candidates) {
    if (candidate.eligible === false
      || candidateConflictsWithExplicitRankingMeasure(candidate, input.requirements)) continue;
    const existing = byId.get(candidate.id);
    if (!existing || (!existing.sameSnapshotRoleExtension && candidate.sameSnapshotRoleExtension)) {
      // Map replacement preserves the original stable ordering while retaining
      // the stricter same-snapshot proof for this exact candidate identity.
      byId.set(candidate.id, candidate);
    }
  }
  return [...byId.values()];
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
      if (!request.selectedEvidenceId && (base.action === "converse" || base.action === "compose_app")) {
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
        // The retrieval parser may carry broad search phrases such as
        // `count_for_each_customer`. They are useful before retrieval, but
        // they are not executable measures. Normalize once at the router
        // boundary so every downstream plan/meaning path consumes the same
        // typed measure + entity/dimension requirements.
        evidence = withNormalizedAnalyticalRequirements(evidence, request.question);
        // Keep the complete snapshot result for trace-only lifecycle evidence
        // before canonicalization and bounded meaning-package admission prune it.
        const retrievedCandidates = evidence.candidates;
        traceRetrievalLanesBeforePruning(request, evidence, retrievedCandidates);
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
        // Ranking measure identity is resolved from the same immutable
        // request/evidence frame that drives package reservation.  A metric
        // may remain in broad retrieval context, but it cannot become a
        // clarification or meaning-selection alternative after an explicit
        // comparator already bound a different ranking measure.
        const persistedSelection = request.selectedEvidenceId
          ? persistedClarificationSelectionContext(request)
          : undefined;
        // A structured click is a continuation of the original server turn,
        // not a new parse of its display label. Retain the typed partial frame
        // (ranking/time included) before candidate pruning can affect it.
        const continuationQuestion = persistedSelection?.serverIssued && persistedSelection.sourceQuestion
          ? persistedSelection.sourceQuestion
          // A free-text turn is always a new source question. A browser may
          // retain clarificationSourceQuestion for display, but it must never
          // make stale retrieval intent or a previous result authoritative.
          : request.question;
        // Retrieval parser output is never an independent source of request
        // authority, but it can refine a host-owned source question when every
        // business term is demonstrably present in that question.  In
        // particular, "active seats" is a legitimate current-turn metric
        // refinement for "Which workspaces have the most active seats?";
        // omitting it altogether forced the seed to erase an explicit metric
        // before the model had a chance only to bind it.  The shared
        // requirement builder rejects stale parser terms (for example a prior
        // rollover balance, member filter, or top-N), so this remains a
        // source-question-plus-server-selection tuple rather than retrieval
        // intent becoming plan authority.
        // A server-composed child Ask (currently a Research hypothesis) may
        // carry an exact host-owned seed.  Planner prose is not user wording:
        // reparsing it can turn an asset namespace or explanatory phrase into
        // a second requested measure.  Accept the seed only when it belongs
        // to this exact source question and there is no structured
        // continuation to merge; public request parsers never hydrate this
        // host-only field.
        const hostSeed = !request.selectedEvidenceId
          && request.hostRequirementSeed?.version === 1
          && request.hostRequirementSeed.sourceQuestion === continuationQuestion
          ? request.hostRequirementSeed
          : undefined;
        const sourceQuestionRequirements = hostSeed?.requirements
          ?? buildAnalyticalRequirementSet({
            question: continuationQuestion,
            parsedIntent: evidence.parsedIntent,
          });
        const analyticalRequirements = request.selectedEvidenceId
          ? mergeClarificationRequirements(
              sourceQuestionRequirements,
              persistedSelection?.serverIssued ? persistedSelection.requirements : undefined,
            )
          : sourceQuestionRequirements;
        // The host freezes the reader's requested tuple before the bounded
        // meaning call. A model may bind only supplied candidate identities;
        // it cannot erase explicit outputs, ranking, time, or a new question's
        // independent scope by rephrasing the request.
        const requirementSeed = hostSeed
          ? hostSeed
          : buildAnalyticalRequirementSeedV1({
              question: continuationQuestion,
              parsedIntent: evidence.parsedIntent,
              requirements: analyticalRequirements,
              fiscalCalendar: declaredFiscalCalendar(evidence, evidence.candidates),
            });
        // Retrieval can retain more context internally; only this compact,
        // role-balanced package reaches the one meaning call. The question is
        // supplied so explicit revenue, entity labels, and time roles cannot be
        // pruned by unrelated lexical matches.
        let candidates = buildMeaningEvidencePackage(evidence, options.maxMeaningCandidates ?? 16, continuationQuestion);
        traceCandidateLifecycleBeforePruning(request, evidence, retrievedCandidates, candidates);
        // The complete already-retrieved set is retained only to validate a
        // server-issued stable selection before any route can fall through to
        // a generic/generated answer. New free-text choices are constrained to
        // the admitted package below, so a pruned candidate cannot reappear as
        // an unrelated clarification option.
        const clarificationCandidates = consolidateClarificationCandidates({
          candidates: [
            ...evidence.candidates,
            ...(evidence.clarificationCandidates ?? []),
          ],
          requirements: analyticalRequirements,
        });
        // A structured clarification selection is identity input, not a new
        // fuzzy-search phrase. Look in BOTH lists: ranking-measure choices are
        // supplemental clarification candidates, not execution candidates.
        let selectedEvidence = request.selectedEvidenceId
          ? clarificationCandidates.find((candidate) => candidate.id === request.selectedEvidenceId)
          : undefined;
        if (!selectedEvidence && request.selectedEvidenceId) {
          selectedEvidence = rehydrateServerIssuedCapabilityDimensionSelection({
            request,
            evidence,
            candidates: clarificationCandidates,
          });
          if (selectedEvidence) clarificationCandidates.push(selectedEvidence);
        }
        const structuredSelection = request.selectedEvidenceId
          ? validateStructuredClarificationSelection({
              request,
              evidence,
              candidates: clarificationCandidates,
              selected: selectedEvidence,
            })
          : undefined;
        if (structuredSelection && !structuredSelection.ok) {
          return invalidStructuredSelectionDecision({
            base,
            request,
            evidence,
            candidates: clarificationCandidates,
            selectedId: request.selectedEvidenceId!,
            validation: structuredSelection,
          });
        }
        const selectedDimensionBinding = structuredSelection?.ok
          && structuredSelection.selection.kind === 'dimension'
          ? structuredSelection.selection
          : undefined;
        const stableSelectionCandidates = [
          ...(selectedDimensionBinding ? [selectedDimensionBinding.metricCandidate] : []),
          ...(selectedEvidence ? [selectedEvidence] : []),
        ].filter((candidate, index, all) => all.findIndex((item) => item.id === candidate.id) === index);
        // One host-authored, role-targeted extension may enter the same
        // snapshot package before absence is declared. It is eligible only
        // when a selected/retrieved semantic metric itself proves one unique
        // MetricFlow grouping dimension for the unmet business role. This is
        // not a lexical location→region rule and never creates a raw join.
        const roleTargetedExtensions = sameSnapshotRoleTargetedMeaningExtensions({
          candidates,
          clarificationCandidates,
          requirements: analyticalRequirements,
        });
        const extensions = [
          ...stableSelectionCandidates,
          ...roleTargetedExtensions,
        ].filter((candidate, index, all) =>
          all.findIndex((item) => item.id === candidate.id) === index
          // A role-targeted card may intentionally share the stable ID of an
          // unscoped catalog card already admitted by generic relevance. In
          // that case replace the card in-place below so the provider sees the
          // same qualified object plus the immutable role proof; do not drop
          // the proof just because its base record was admitted first.
          && (() => {
            const existing = candidates.find((item) => item.id === candidate.id);
            return !existing || (!existing.sameSnapshotRoleExtension && candidate.sameSnapshotRoleExtension);
          })());
        if (extensions.length > 0) {
          // Keep the exact metric and the separately selected semantic member
          // together. The choice never becomes a synthetic metric merely to
          // fit the bounded meaning package.
          candidates = [...extensions, ...candidates.filter((candidate) =>
            !extensions.some((extension) => extension.id === candidate.id))]
            .slice(0, Math.max(1, Math.min(16, options.maxMeaningCandidates ?? 16)));
          const observer = askTraceObserverForV1(request);
          for (const extension of extensions) {
            const roles = evidenceCandidateRoles(extension);
            for (const role of roles) {
              observer.recordCandidateDecision({
                // This must stay on the router's stable resolver identity. The
                // qualifiedId is display/provenance data and can differ from the
                // candidate id used by meaning validation and model selection.
                candidateId: extension.id,
                role,
                source: traceSourceForCandidate(extension),
                decision: 'extended',
                reasonCode: 'same_snapshot_extension',
                compatibilityCode: 'unknown',
              });
            }
          }
        }
        // Only package-admitted, role-compatible candidates may become a new
        // free-text clarification option. The complete snapshot is retained
        // above exclusively to validate a server-issued stable selection or
        // to prove a terminal safety boundary; it must never let a pruned,
        // unrelated metric re-enter the answer flow as a choice.
        const admittedClarificationCandidates = candidates.filter((candidate) =>
          candidate.eligible !== false
          && candidate.compatibility !== 'incompatible'
          && !candidateConflictsWithExplicitRankingMeasure(candidate, analyticalRequirements));
        const attributionGap = attributionRequiredRelationshipGapDecision({
          request,
          base,
          evidence,
          requirements: analyticalRequirements,
        });
        if (attributionGap) return attributionGap;
        // The compact meaning package can be empty when every ranked card was
        // reserved for a role that the parser marked missing. A unique authored
        // certified example is still an authoritative snapshot fact, so it
        // must be considered before the package-length guard and before any
        // deterministic missing-dimension cascade.
        if (!request.selectedEvidenceId) {
          const authoredExample = authoritativeExactCertifiedExample(
            clarificationCandidates,
            evidence?.parsedIntent?.measures ?? [],
          );
          if (authoredExample) {
            const candidatesForResolution = candidates.some((candidate) => candidate.id === authoredExample.id)
              ? candidates
              : [authoredExample, ...candidates];
            return routeDecisionForResolution(
              base,
              evidence,
              candidatesForResolution,
              directResolution(request, evidence, authoredExample, candidatesForResolution),
              'heuristic',
              request.question,
              options.resolvedPlanMode ?? 'authoritative',
            );
          }
        }
        if (candidates.length > 0) {
          // Fiscal tokens are execution requirements, not a semantic guess.
          // Ask exactly once before a meaning call or plan freeze when the
          // snapshot has no declared fiscal calendar/date-role binding.
          const fiscalClarification = fiscalCalendarClarification(request, base, evidence, candidates);
          if (fiscalClarification) return fiscalClarification;
          // A selected display/grouping field completes a persisted frame; the
          // matched semantic metric remains the only execution/measure
          // authority. A selected dimension must therefore never flow through
          // the metric-only direct-resolution path as the primary candidate.
          const explicit = selectedDimensionBinding?.metricCandidate
            ?? selectedEvidence
            ?? findExplicitEvidenceReference(request.question, candidates);
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
              admittedClarificationCandidates,
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
              directResolution(
                request,
                evidence,
                explicit,
                candidates,
                selectedDimensionBinding ? [selectedDimensionBinding.dimensionId] : [],
                selectedDimensionBinding ? [selectedDimensionBinding.selectedDimensionId] : [],
              ),
              "heuristic",
              request.question,
              options.resolvedPlanMode ?? 'authoritative',
            );
            // A valid stable semantic choice may still be pre-freeze-ineligible
            // in this local snapshot (for example, the semantic adapter cannot
            // execute the selected tuple). That is a normal cascade condition:
            // keep the chosen meaning, then consider the same-snapshot safe
            // exploratory path. An invalid/stale choice never reaches here, and
            // a frozen plan/policy denial is deliberately not downgraded.
            const selectedPreFreezeModelingGap = decision.terminalOutcome?.kind === 'modeling_gap'
              && decision.resolvedAnalyticalPlan?.capability === 'blocked'
              && decision.analyticalCascadeDecision?.planFrozen === false;
            return explicit
              && structuredSelection?.ok
              && (decision.requiresClarification || selectedPreFreezeModelingGap)
              ? continueCascadeAfterIncompleteSelection(
                  base,
                  evidence,
                  candidates,
                  // Preserve the display-key identity the user clicked in
                  // user-facing gap/continuation evidence; the paired metric
                  // remains recorded below as execution provenance.
                  selectedEvidence ?? explicit,
                  request.question,
                  selectedDimensionBinding
                    ? [selectedDimensionBinding.metricCandidate.id, selectedDimensionBinding.selectedDimensionId]
                    : [explicit.id],
                )
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


          const exactCompatible = !shouldUseMeaningCall ? candidates.filter((candidate) =>
            candidate.exactMatch
            && candidate.compatibility !== "incompatible"
            && candidateMayTerminateCertifiedForMeasures(candidate, evidence?.parsedIntent?.measures ?? [])
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
            ? dominantCompatibleGovernedCandidate(candidates, evidence.parsedIntent?.measures ?? [])
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
            let resolution: MeaningResolution | undefined;
            try {
              resolution = options.resolveMeaning
                ? await options.resolveMeaning({
                  question: requirementSeed.sourceQuestion,
                  history: request.conversationBinding && request.conversationBinding !== 'none'
                    ? effectiveConversationHistory(request)
                    : undefined,
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
                  requirementSeed,
                  signal: request.signal ?? options.signal,
                })
                : options.complete
                  ? parseMeaningResolution(await options.complete({
                    system: buildMeaningSystemPrompt(),
                    user: buildMeaningUserPrompt(request, evidence, candidates, requirementSeed),
                    signal: request.signal ?? options.signal,
                    request,
                    phase: 'meaning_resolution',
                  }), requirementSeed)
                  : undefined;
            } catch (error) {
              throw error;
            }
            if (resolution) {
              // A model is allowed to say that it cannot bind any supplied
              // card, but that is not a new business ambiguity by itself. If
              // the host can prove one exact current-turn semantic identity,
              // take the ordinary direct/cascade path instead of preserving an
              // empty selection as a clarification. This is intentionally
              // evaluated before merge/validation so the host never treats an
              // empty provider response as an authoritative analytical frame.
              if (meaningResolutionHasNoBinding(resolution)) {
                const hostFallback = routeWithoutMeaningModel(
                  request,
                  base,
                  evidence,
                  candidates,
                  options.resolvedPlanMode ?? 'authoritative',
                  true,
                );
                if (isFrozenExecutableHostFallback(hostFallback)) {
                  return remember(key, hostFallback);
                }
              }
              // Merge exactly once at the model boundary. Candidate IDs remain
              // subject to the bounded-package validator below; model route,
              // SQL-adjacent frame, rephrased question, and query intent never
              // become downstream authority.
              resolution = mergeMeaningResolutionWithRequirementSeed({
                seed: requirementSeed,
                resolution,
                candidates,
              });
              // Repair an incomplete certified nomination before generic
              // evidence validation. This preserves the real semantic choices
              // instead of turning a false certified selection into an opaque
              // invalid-evidence gap.
              const certifiedSafeResolution = repairIncompleteCertifiedMeasureSelection(
                resolution,
                evidence,
                candidates,
              );
              const validated = validateMeaningResolution(
                certifiedSafeResolution,
                candidates,
                evidence.parsedIntent?.measures ?? certifiedSafeResolution.queryIntent.measures,
                { requirements: analyticalRequirements },
              );
              if (validated.ok) {
                // The meaning model may select only supplied candidate IDs.  It
                // intentionally cannot return an analytical frame, because a
                // model-owned frame could add a metric, dimension, output, or
                // prior-turn scope after the host froze the requirement seed.
                //
                // Do not leave that candidate-only result on the legacy V1
                // path, though: a valid selected semantic metric plus its
                // selected supplied members must receive the same *host-built*
                // V2 frame as a zero-call/direct resolution.  Otherwise the
                // router freezes a V1 semantic plan, the answer loop skips the
                // immutable semantic execution graph, and legacy SQL is
                // incorrectly checked against generic aggregation metadata.
                const frameBoundResolution = attachHostOwnedAnalyticalFrame({
                  request,
                  evidence,
                  candidates,
                  requirementSeed,
                  resolution: validated.resolution,
                });
                const safeResolution = preventDegenerateRankingResolution(
                  frameBoundResolution,
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
                // An explicit SELECTION answers this gate as well as words in
                // the question do. `hasExplicitRankingMeasure` reads the
                // question TEXT, and clicking a choice never changes the text —
                // so picking `customers.average_order_value` re-asked "Top by
                // which governed metric?" with the same three options, forever.
                // A degenerate pick is still refused above, so anything
                // arriving here is a measure the reader chose from governed
                // evidence.
                const explicitRankingSelection = Boolean(request.selectedEvidenceId)
                  && Boolean(selectedEvidence)
                  && !isDegenerateRankingMetric(request.question, evidence, selectedEvidence!);
                if (
                  safeResolution.questionType === 'ranking'
                  && !hasExplicitRankingMeasure(request.question, evidence)
                  && !resolutionResolvedRanking
                  && !explicitRankingSelection
                ) {
                  // Meaning resolution ran here. If it named the ranking
                  // measure as the missing piece, that is its judgment and the
                  // turn asks rather than guessing past it. Otherwise a clearly
                  // indicated measure is assumed and BOUND through the same
                  // resolution path an explicit selection takes — an assumption
                  // that cannot freeze a plan is refused downstream and reaches
                  // the reader as `blocked` with no options.
                  const resolverFlagged = (safeResolution.missingInformation ?? [])
                    .some((item) => /measure|metric/i.test(item));
                  const assumedRanking = resolverFlagged
                    ? undefined
                    : assumableRankingMeasure(request.question, admittedClarificationCandidates);
                  if (assumedRanking) {
                    return {
                      ...routeDecisionForResolution(
                        base,
                        evidence,
                        candidates,
                        directResolution(request, evidence, assumedRanking.candidate, candidates),
                        'heuristic',
                        request.question,
                      ),
                      assumptions: [assumedRanking.assumption],
                    };
                  }
                  return bareRankingClarification(
                    base,
                    retrievalTrace(evidence, candidates),
                    request.question,
                    evidence,
                    admittedClarificationCandidates,
                    !resolverFlagged,
                  );
                }
                const deterministicGap = deterministicPrePlanClarification(
                  request,
                  base,
                  evidence,
                  admittedClarificationCandidates,
                );
                if (deterministicGap && safeResolution.recommendedRoute === 'clarify') {
                  return deterministicGap;
                }
                const meaningDecision = routeDecisionForResolution(
                  base,
                  evidence,
                  candidates,
                  safeResolution,
                  "llm",
                  request.question,
                  options.resolvedPlanMode ?? 'authoritative',
                );
                return remember(
                  key,
                  continuePreFreezeModelingGapThroughPhysicalSnapshot({
                    decision: meaningDecision,
                    base,
                    evidence,
                    candidates,
                    question: request.question,
                  }),
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
          if (isFrozenExecutableHostFallback(fallbackDecision)) {
            return fallbackDecision;
          }
          // The provider was unavailable or returned malformed JSON. Apply the
          // deterministic clarification only after the bounded meaning attempt
          // has been exhausted; this preserves a precise recovery path without
          // allowing the generic governed error to terminate the question.
          return deterministicPrePlanClarification(request, base, evidence, admittedClarificationCandidates)
            ?? fallbackDecision;
        }
      }

      // A structured selection cannot enter the legacy/no-evidence classifier.
      // Without a fresh retrieval snapshot it has no proof that the server
      // option still exists, so fail closed before any provider dispatch or
      // generated-SQL fallback.
      if (request.selectedEvidenceId) {
        const unavailableEvidence: AgentRetrievalEvidence = {
          snapshotId: 'unavailable:structured-selection',
          sourceFingerprint: 'unavailable:structured-selection',
          candidates: [],
        };
        const validation = validateStructuredClarificationSelection({
          request,
          evidence: unavailableEvidence,
          candidates: [],
          selected: undefined,
        });
        return invalidStructuredSelectionDecision({
          base,
          request,
          evidence: unavailableEvidence,
          candidates: [],
          selectedId: request.selectedEvidenceId,
          validation: validation.ok
            ? {
                ok: false,
                requirements: validation.requirements,
                choiceIds: validation.choiceIds,
                reason: 'The selected governed identifier could not be revalidated because retrieval is unavailable.',
              }
            : validation,
        });
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
          request,
          phase: 'classification',
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
