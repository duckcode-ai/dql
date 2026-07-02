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

/** Normalize a question for cache keying (whitespace/case-insensitive). */
function cacheKey(request: AgentRunRequest): string {
  const q = request.question.trim().toLowerCase().replace(/\s+/g, " ");
  const last = request.history?.length ? request.history[request.history.length - 1].text.trim().toLowerCase() : "";
  return `${q} ${last}`;
}

/**
 * Build a hybrid router. Runs the deterministic cascade first and returns it
 * unchanged when confident; otherwise spends one cached LLM classification call,
 * falling back to the deterministic decision on any failure.
 */
export function createHybridRouter(options: HybridRouterOptions = {}): AgentRouter {
  const threshold = options.llmThreshold ?? DEFAULT_THRESHOLD;
  const cacheSize = options.cacheSize ?? DEFAULT_CACHE_SIZE;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();
  let tick = 0;
  const now = options.now ?? (() => { tick += 1; return tick; });

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
      // Confident heuristic (or no LLM available) → keep the fast, offline decision.
      if (base.confidence >= threshold || !options.complete) {
        return { ...base, source: base.source ?? "heuristic" };
      }

      const key = cacheKey(request);
      const cached = cache.get(key);
      if (cached && (options.cacheTtlMs === undefined || now() - cached.at < cacheTtlMs)) {
        return { ...cached.decision, source: "cache" };
      }

      try {
        const catalogContext = options.getCatalogContext ? await options.getCatalogContext(request) : undefined;
        const raw = await options.complete({
          system: buildSystemPrompt(),
          user: buildUserPrompt(request, catalogContext),
          signal: options.signal,
        });
        const classification = parseClassification(raw);
        if (classification) {
          const decision = classificationToDecision(classification, base);
          cache.set(key, { decision, at: now() });
          if (cache.size > cacheSize) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
          return decision;
        }
      } catch {
        // fall through to deterministic
      }
      return { ...base, source: "heuristic" };
    },
  };
}

export { intentForCategory };
