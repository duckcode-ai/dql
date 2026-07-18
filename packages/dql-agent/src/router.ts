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

function buildUserPrompt(request: AgentRunRequest, catalogContext?: string): string {
  const lines: string[] = [];
  lines.push(`Turn: ${request.question}`);
  if (request.history?.length) {
    const recent = request.history.slice(-4).map((turn) => `${turn.role}: ${turn.text}`).join("\n");
    lines.push(`Recent conversation:\n${recent}`);
  }
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
    '{"interpretedQuestion":string,"questionType":"definition"|"value"|"ranking"|"trend"|"comparison"|"diagnosis"|"research","selectedConceptIds":string[],"recommendedExecutionId"?:string,"queryIntent":{"measures":string[],"dimensions":string[],"filters":[{"field":string,"value":string}],"timeRange"?:string,"timeGrain"?:string,"order"?:"asc"|"desc","limit"?:number},"rejectedCandidates":[{"id":string,"reason":string}],"confidence":"high"|"medium"|"low","missingInformation":string[],"recommendedRoute":"certified"|"semantic"|"governed_sql"|"exploratory"|"clarify","clarifyingQuestion"?:string}',
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
  }));
  const lines = [
    `Question: ${compactText(request.question, 2_000)}`,
    `Parsed request hints: ${JSON.stringify(compactQueryIntent(defaultQueryIntent(evidence)))}`,
    `Candidate cards: ${JSON.stringify(cards)}`,
  ];
  if (request.history?.length) {
    lines.push(`Recent conversation: ${JSON.stringify(request.history.slice(-4).map((turn) => ({
      role: turn.role,
      text: compactText(turn.text, 1_200),
    })))}`);
  }
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
  if (rejectedCandidates.length !== record.rejectedCandidates.length) return undefined;
  const recommendedExecutionId = typeof record.recommendedExecutionId === "string"
    ? record.recommendedExecutionId
    : undefined;
  const clarifyingQuestion = typeof record.clarifyingQuestion === "string" && record.clarifyingQuestion.trim()
    ? record.clarifyingQuestion.trim()
    : undefined;
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
  const last = request.history?.length ? request.history[request.history.length - 1].text.trim().toLowerCase() : "";
  const evidenceVersion = evidence
    ? evidence.sourceFingerprint
      ?? evidence.snapshotId
      ?? evidence.candidates.map((candidate) => `${candidate.id}:${candidate.relevanceScore}:${candidate.compatibility}`).join("|")
    : catalogContext ?? "";
  return `${q} ${last} ${evidenceVersion}`;
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
): IntentDecision {
  const needsClarification = resolution.confidence === "low" || resolution.recommendedRoute === "clarify";
  const analytical = resolution.questionType === "diagnosis" || resolution.questionType === "research";
  const reason = needsClarification
    ? `The retrieved evidence supports multiple business meanings: ${resolution.interpretedQuestion}`
    : `Resolved the question against ${resolution.selectedConceptIds.join(", ")}: ${resolution.interpretedQuestion}`;
  return {
    ...base,
    action: needsClarification ? "clarify" : analytical ? "investigate" : "answer",
    confidence: resolution.confidence === "high" ? 0.9 : resolution.confidence === "medium" ? 0.72 : 0.45,
    reason,
    source,
    category: analytical ? "data_analysis" : needsClarification ? "unclear" : "data_lookup",
    depth: analytical ? "deep" : "quick",
    meaningResolution: resolution,
    retrievalEvidence: retrievalTrace(evidence, candidates),
    requiresClarification: needsClarification,
    ...(needsClarification
      ? { clarifyingQuestion: resolution.clarifyingQuestion ?? buildEvidenceClarification(candidates, resolution.missingInformation) }
      : {}),
  };
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

function directResolution(
  request: AgentRunRequest,
  evidence: AgentRetrievalEvidence,
  candidate: AgentEvidenceCandidate,
): MeaningResolution {
  return {
    interpretedQuestion: request.question,
    questionType: questionTypeFromText(request.question),
    selectedConceptIds: [candidate.id],
    recommendedExecutionId: candidate.id,
    queryIntent: defaultQueryIntent(evidence),
    rejectedCandidates: [],
    confidence: "high",
    missingInformation: [],
    recommendedRoute: routeForEvidenceCandidate(candidate),
  };
}

function routeWithoutMeaningModel(
  request: AgentRunRequest,
  base: IntentDecision,
  evidence: AgentRetrievalEvidence,
  candidates: AgentEvidenceCandidate[],
): IntentDecision {
  const exactCompatible = candidates.filter((candidate) => candidate.exactMatch && candidate.compatibility !== "incompatible");
  if (exactCompatible.length === 1 && !hasMateriallyRelatedCompetitor(exactCompatible[0], candidates)) {
    return routeDecisionForResolution(base, evidence, candidates, directResolution(request, evidence, exactCompatible[0]), "heuristic");
  }
  if (base.action === "investigate") {
    return {
      ...base,
      category: "data_analysis",
      retrievalEvidence: retrievalTrace(evidence, candidates),
    };
  }
  return {
    ...base,
    action: "answer",
    confidence: Math.max(base.confidence, 0.7),
    reason: `Retrieved ${candidates.length} governed candidate${candidates.length === 1 ? "" : "s"}; the answer executor will resolve them without a router general-knowledge fallback.`,
    category: "data_lookup",
    retrievalEvidence: retrievalTrace(evidence, candidates),
  };
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
  const competitorFloor = Math.max(0.7, best.relevanceScore - 0.12);
  const hasExecutableCompetitor = compatible.some((candidate) =>
    candidate.id !== best.id && candidate.relevanceScore >= competitorFloor
  );
  return hasExecutableCompetitor ? undefined : best;
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
    const conversationalKind = classifyConversationalTurn(request.question, (request.history?.length ?? 0) > 0);
    return decideAgentAction({
      question: request.question,
      intent: request.intent ?? (conversationalKind ? "clarify" : "ad_hoc_ranking"),
      signals: request.signals,
      history: request.history,
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
        const candidates = buildMeaningEvidencePackage(evidence, options.maxMeaningCandidates ?? 12);
        if (candidates.length > 0) {
          const explicit = findExplicitEvidenceReference(request.question, candidates);
          if (explicit && explicit.compatibility !== "incompatible") {
            return routeDecisionForResolution(
              base,
              evidence,
              candidates,
              directResolution(request, evidence, explicit),
              "heuristic",
            );
          }

          const exactCompatible = candidates.filter((candidate) =>
            candidate.exactMatch && candidate.compatibility !== "incompatible"
          );
          if (exactCompatible.length === 1 && !hasMateriallyRelatedCompetitor(exactCompatible[0], candidates)) {
            return routeDecisionForResolution(
              base,
              evidence,
              candidates,
              directResolution(request, evidence, exactCompatible[0]),
              "heuristic",
            );
          }

          const dominant = dominantCompatibleGovernedCandidate(candidates);
          if (dominant) {
            return routeDecisionForResolution(
              base,
              evidence,
              candidates,
              directResolution(request, evidence, dominant),
              "heuristic",
            );
          }

          const key = cacheKey(request, evidence);
          const cached = cache.get(key);
          if (cached && (options.cacheTtlMs === undefined || now() - cached.at < cacheTtlMs)) {
            return { ...cached.decision, source: "cache" };
          }

          try {
            const resolution = options.resolveMeaning
              ? await options.resolveMeaning({ question: request.question, history: request.history, evidence, candidates, signal: request.signal ?? options.signal })
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
                return remember(
                  key,
                  routeDecisionForResolution(base, evidence, candidates, validated.resolution, "llm"),
                );
              }
              const invalidResolution: MeaningResolution = {
                interpretedQuestion: request.question,
                questionType: questionTypeFromText(request.question),
                selectedConceptIds: [],
                queryIntent: defaultQueryIntent(evidence),
                rejectedCandidates: [],
                confidence: "low",
                missingInformation: [validated.reason],
                recommendedRoute: "clarify",
                clarifyingQuestion: buildEvidenceClarification(candidates, [validated.reason]),
              };
              return remember(key, routeDecisionForResolution(base, evidence, candidates, invalidResolution, "llm"));
            }
          } catch (error) {
            rethrowCancellation(error, request.signal, options.signal);
            // A resolver transport/parse failure falls back without losing the
            // retrieval signal or permitting a general-knowledge misroute.
          }
          return routeWithoutMeaningModel(request, base, evidence, candidates);
        }
      }

      // Legacy/no-evidence path. A confident analytical heuristic stays offline;
      // only the ambiguous middle pays the old classification call. Importantly,
      // load the catalog context before the model may choose general knowledge.
      if (base.confidence >= threshold || !options.complete) {
        return { ...base, source: base.source ?? "heuristic" };
      }
      let catalogContext: string | undefined;
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

export { intentForCategory, parseMeaningResolution };
