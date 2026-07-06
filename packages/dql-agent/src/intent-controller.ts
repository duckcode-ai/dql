/**
 * Intent controller (P0) — the deciding front door of the agent.
 *
 * Instead of "always generate SQL", the controller looks at each turn and DECIDES
 * what it deserves: answer it now, ask one sharp clarifying question, run a
 * multi-step investigation, or compose an app/dashboard. It maps the existing
 * fine-grained `MetadataAgentIntent` taxonomy + retrieval signals into a small set
 * of high-level ACTIONS the rest of the system routes on, and it carries a
 * human-facing rationale (show-your-work) and follow-up awareness so a turn like
 * "why?" or "break that down" is understood in context rather than re-generated
 * from scratch.
 *
 * Deterministic + offline by design: heuristics over the question, the classified
 * intent, and match scores — no extra model call. A caller may refine with an LLM,
 * but the default is fast, testable, and reliable.
 */

import type { MetadataAgentIntent } from './metadata/catalog.js';

/** The high-level action the agent will take for a turn. */
export type AgentAction = 'answer' | 'clarify' | 'investigate' | 'compose_app' | 'converse';

/**
 * Conversational turn kinds that deserve a plain, warm reply instead of the data
 * routing cascade. Deliberately narrow — anything with data vocabulary falls
 * through to the analytics cascade so we never chit-chat a real question away.
 */
export type ConversationalKind = 'greeting' | 'gratitude' | 'meta_capability' | 'smalltalk';

export interface IntentSignals {
  /** Best certified-artifact match score (0..1), if any. */
  certifiedScore?: number;
  /** Best governed-metric match score (0..1), if any. */
  metricScore?: number;
  /** Whether KG retrieval surfaced relevant governed context at all. */
  hasRetrieval?: boolean;
  /** Missing-context messages from the catalog route (drives clarify). */
  missingContext?: string[];
}

export interface IntentDecisionInput {
  question: string;
  /** The fine-grained intent already classified upstream. */
  intent: MetadataAgentIntent;
  signals?: IntentSignals;
  /** True when this turn is a follow-up (e.g. a drilldown carrier was present). */
  isFollowUp?: boolean;
  /** Recent turns (most recent last) — used to resolve deictic follow-ups. */
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
}

export interface IntentDecision {
  action: AgentAction;
  /** Confidence in the action choice, 0..1. */
  confidence: number;
  /** One-sentence, business-facing rationale for the choice. */
  reason: string;
  /** Present when action is clarify: the single question to ask. */
  clarifyingQuestion?: string;
  /**
   * True when this clarify is a SOFT fallback ("nothing governed matched") rather
   * than a genuine missing-context / explicit-clarify / trust-review ask. A soft
   * clarify may be answered anyway (best-effort, labeled) for any audience instead
   * of dead-ending; the answer loop can still clarify if it truly can't proceed.
   */
  clarifySoft?: boolean;
  /** True when the turn references prior context ("it", "that", "why", "more"). */
  followsUp: boolean;
  /** For converse: which conversational kind was detected. */
  conversationalKind?: ConversationalKind;
  /** Requested analysis depth — set by the hybrid router; drives quick vs deep. */
  depth?: 'quick' | 'deep';
  /** Fine-grained category from the hybrid router (superset of AgentAction intent). */
  category?:
    | 'conversational'
    | 'capability'
    | 'general_knowledge'
    | 'data_lookup'
    | 'data_analysis'
    | 'authoring'
    | 'app'
    | 'unclear';
  /** Where the decision came from: fast heuristics, the LLM router, or its cache. */
  source?: 'heuristic' | 'llm' | 'cache';
}

/** A confident match means a certified block or governed metric clearly fits. */
const STRONG_MATCH = 0.5;

/** Build-an-app phrasing: an explicit verb on a dashboard/app noun. */
const COMPOSE_APP_RE =
  /\b(build|create|make|set ?up|put ?together|assemble|design|generate|spin ?up|give me)\b[^.?!]*\b(dashboard|dashboards|app|apps|cockpit|scorecard|overview|workspace|monitor|report)\b/i;
/** "Monitor / keep an eye on X over time" also implies a standing surface. */
const MONITOR_RE = /\b(monitor|keep an eye on|track .* over time|standing (view|report)|watch over time)\b/i;
/**
 * EXPLICIT investigation phrasing — a "why / root cause / what happened" question
 * is an investigation even when a governed metric matches, so this beats a direct
 * answer. Returning just the number would miss the point of the ask.
 */
const STRONG_INVESTIGATE_RE =
  /\b(why|what'?s driving|what is driving|root ?cause|diagnose|deep ?dive|investigate|what (happened|caused|changed)|drivers? of|contributed to|explain the|analy[sz]e|anomal)\b/i;
/** SOFT analytical phrasing — only investigate when no confident direct answer fits. */
const SOFT_INVESTIGATE_RE =
  /\b(break ?down|breakdown|compare|vs\.?|versus|trend over|over time|by (region|segment|month|day|week|category|product|location|type))\b/i;
/** Deictic / continuation phrasing that only makes sense against a prior turn. */
const FOLLOW_UP_RE =
  /^\s*(why|how come|and|but|what about|how about|ok|okay|so|then|more|show more|drill|dig|expand|same|that one|those|these|it|this)\b|\b(again|instead|by (region|segment|month|day|category|product|location))\b/i;

/** Truly diagnostic intents — investigate even when a metric matches. */
const DIAGNOSTIC_INTENTS = new Set<MetadataAgentIntent>([
  'diagnose_change',
  'anomaly_investigation',
]);
/** Softer analytical intents — investigate only when no confident answer fits. */
const SOFT_INVESTIGATIVE_INTENTS = new Set<MetadataAgentIntent>([
  'driver_breakdown',
  'segment_compare',
  'entity_drilldown',
]);

const DIRECT_ANSWER_INTENTS = new Set<MetadataAgentIntent>([
  'exact_certified_lookup',
  'definition_lookup',
  'ad_hoc_ranking',
]);

/**
 * Data vocabulary — if any of this shows up, the turn is about the warehouse and
 * must go through the governed cascade even if it opens with "hi" or "thanks".
 */
const DATA_VOCAB_RE =
  /\b(revenue|sales|orders?|customers?|users?|churn|retention|revenue|profit|margin|arpu|ltv|cac|mrr|arr|conversion|metric|kpi|dashboard|report|table|column|schema|dbt|model|query|sql|block|certified|rows?|count|sum|avg|average|total|top|bottom|rank|trend|breakdown|compare|segment|cohort|by (region|segment|month|day|week|category|product|location|type)|why|drivers?|anomal|forecast)\b/i;

/** Greetings / openers. */
const GREETING_RE =
  /^\s*(hi|hey|hello|yo|howdy|hiya|heya|good\s+(morning|afternoon|evening)|greetings|sup|what'?s\s+up|gm|hi\s+there|hello\s+there)\b[\s!.,]*$/i;
/** Gratitude / acknowledgement / closers. */
const GRATITUDE_RE =
  /^\s*(thanks?|thank\s+you|thx|ty|cheers|nice|cool|awesome|great|perfect|got\s+it|makes\s+sense|ok(ay)?|sounds?\s+good|bye|goodbye|see\s+ya|later)\b[\s!.,]*$/i;
/** Meta / capability questions about the assistant itself. */
const META_CAPABILITY_RE =
  /\b(what\s+can\s+you\s+do|what\s+do\s+you\s+do|how\s+do\s+(you|i)\s+(work|use)|who\s+are\s+you|what\s+are\s+you|what\s+is\s+dql|help\s+me\s+get\s+started|how\s+can\s+you\s+help|what\s+should\s+i\s+ask|how\s+does\s+this\s+work|are\s+you\s+(an?\s+)?(ai|bot|llm))\b/i;
const CONTEXT_RECAP_RE =
  /\b(what\s+(?:are|were)\s+we\s+talking\s+about|what\s+we\s+(?:are|were)\s+talking\s+about|what\s+is\s+this\s+about|where\s+were\s+we|remind\s+me|recap(?:\s+this)?|summari[sz]e\s+(?:this|our\s+conversation))\b/i;

/**
 * Classify a turn as conversational (greeting / gratitude / meta-capability /
 * light small talk) when it deserves a plain reply rather than data routing.
 * Deliberately narrow and offline: returns undefined the moment data vocabulary
 * appears, so "hi, what is total revenue?" flows to the analytics cascade.
 */
export function classifyConversationalTurn(
  question: string,
  hasHistory = false,
): ConversationalKind | undefined {
  const trimmed = question.trim();
  if (!trimmed) return undefined;
  // Any real data ask wins, regardless of a polite opener.
  if (DATA_VOCAB_RE.test(trimmed)) return undefined;
  const words = trimmed.split(/\s+/).length;

  if (META_CAPABILITY_RE.test(trimmed)) return 'meta_capability';
  if (hasHistory && CONTEXT_RECAP_RE.test(trimmed)) return 'smalltalk';
  // Short openers/closers only — a long sentence starting with "hi" is likely a real ask.
  if (words <= 6 && GREETING_RE.test(trimmed)) return 'greeting';
  if (words <= 6 && GRATITUDE_RE.test(trimmed)) return 'gratitude';
  // Deliberately no generic "small talk" catch-all: a vague-but-real data ask
  // ("show me the numbers", "widgets") must still fall through to the data cascade
  // and clarify. The `smalltalk` kind is reserved for the LLM router (Phase 2).
  return undefined;
}

/** Heuristic: does the question explicitly ask to build a dashboard/app? */
export function looksLikeComposeApp(question: string): boolean {
  return COMPOSE_APP_RE.test(question) || MONITOR_RE.test(question);
}

/** Heuristic: is this turn a follow-up that depends on prior context? */
export function looksLikeFollowUp(question: string, hasHistory: boolean): boolean {
  if (!hasHistory) return false;
  const trimmed = question.trim();
  // Short + deictic, or starts with a continuation word.
  if (FOLLOW_UP_RE.test(trimmed)) return true;
  return trimmed.split(/\s+/).length <= 4 && /\b(it|that|this|those|these|them)\b/i.test(trimmed);
}

/**
 * Decide the high-level action for a turn. Deterministic; returns the action plus
 * a rationale and (for clarify) a single sharp question.
 */
export function decideAgentAction(input: IntentDecisionInput): IntentDecision {
  const { question, intent } = input;
  const signals = input.signals ?? {};
  const certified = signals.certifiedScore ?? 0;
  const metric = signals.metricScore ?? 0;
  const bestMatch = Math.max(certified, metric);
  const hasMissing = (signals.missingContext?.length ?? 0) > 0;
  const followsUp = input.isFollowUp ?? looksLikeFollowUp(question, (input.history?.length ?? 0) > 0);

  // 0) Conversational turn (greeting / thanks / "what can you do?") → reply plainly,
  //    no data routing. Narrow by design: any data vocabulary skips this entirely.
  const conversationalKind = classifyConversationalTurn(question, (input.history?.length ?? 0) > 0);
  if (conversationalKind) {
    return {
      action: 'converse',
      confidence: 0.95,
      reason: 'Conversational turn — I will reply directly without running the data loop.',
      conversationalKind,
      category: conversationalKind === 'meta_capability' ? 'capability' : 'conversational',
      source: 'heuristic',
      followsUp,
    };
  }

  // 1) Explicit "build me a dashboard/app" → compose an app, regardless of match.
  if (looksLikeComposeApp(question)) {
    return {
      action: 'compose_app',
      confidence: 0.8,
      reason: 'This asks to assemble a standing view, so I will compose an app from the relevant certified blocks rather than answer a single question.',
      followsUp,
    };
  }

  // 1b) A turn that ANSWERS a prior clarifying question must proceed to a real
  //     answer — never clarify again. Short replies ("top 5", "yes") aren't deictic
  //     follow-ups, so without this the router re-clarifies every time and loops
  //     forever. The user gave the detail we asked for; the answer loop cascades
  //     (certified → semantic → generated) and can still clarify itself only if it
  //     genuinely cannot proceed.
  const priorAssistant = [...(input.history ?? [])].reverse().find((turn) => turn.role === 'assistant');
  if (priorAssistant && priorAssistant.text.trim().endsWith('?')) {
    return {
      action: 'answer',
      confidence: 0.6,
      reason: 'This answers a clarifying question, so I will produce a best-effort governed answer now instead of asking again.',
      followsUp: true,
    };
  }

  // 2) EXPLICIT investigation ("why / root cause / what happened") wins even over a
  //    metric match — returning a single number would miss the point of the ask.
  if (STRONG_INVESTIGATE_RE.test(question) || DIAGNOSTIC_INTENTS.has(intent)) {
    return {
      action: 'investigate',
      confidence: 0.75,
      reason: 'This is an open-ended analytical question, so I will investigate it across the governed metrics and lineage rather than return one number.',
      followsUp,
    };
  }

  // 3) A confident certified block or governed metric fits → answer it directly,
  //    even if the phrasing looks lightly analytical (don't over-investigate a lookup).
  if (bestMatch >= STRONG_MATCH && !hasMissing && intent !== 'clarify') {
    const via = certified >= metric ? 'a certified block' : 'a governed metric';
    return {
      action: 'answer',
      confidence: Math.min(0.95, 0.5 + bestMatch / 2),
      reason: `${via} answers this directly, so I will answer from the governed layer.`,
      followsUp,
    };
  }

  // 4) Softer analytical phrasing/intent (breakdown / compare / trend) with no
  //    confident direct answer → investigate.
  if (SOFT_INVESTIGATE_RE.test(question) || SOFT_INVESTIGATIVE_INTENTS.has(intent)) {
    return {
      action: 'investigate',
      confidence: 0.65,
      reason: 'This asks for a breakdown or comparison without a single governed answer, so I will investigate it.',
      followsUp,
    };
  }

  // 4) Missing context or an explicit clarify intent → ask ONE sharp question.
  if (hasMissing || intent === 'clarify' || intent === 'trust_gap_review') {
    return {
      action: 'clarify',
      confidence: 0.6,
      reason: 'The request is missing a business object, measure, or grain I need before answering safely.',
      clarifyingQuestion: buildClarifyingQuestion(question, signals),
      followsUp,
    };
  }

  // 5) Direct-answer intent with some retrieval → answer (generate grounded SQL).
  if (DIRECT_ANSWER_INTENTS.has(intent) && (signals.hasRetrieval ?? false)) {
    return {
      action: 'answer',
      confidence: 0.55,
      reason: 'A specific, answerable question with governed context available — I will answer it.',
      followsUp,
    };
  }

  // 6) Default: nothing governed matched and it is not clearly analytical → clarify
  //    honestly rather than guess. Marked SOFT so an analyst/stakeholder still gets a
  //    best-effort grounded answer instead of a dead-end (the answer loop re-grounds
  //    and can clarify itself if it genuinely can't proceed).
  return {
    action: 'clarify',
    confidence: 0.5,
    clarifySoft: true,
    reason: 'I could not match this to a certified block, governed metric, or clear analysis, so I will ask for the missing detail.',
    clarifyingQuestion: buildClarifyingQuestion(question, signals),
    followsUp,
  };
}

function buildClarifyingQuestion(question: string, signals: IntentSignals): string {
  const missing = signals.missingContext?.[0];
  if (missing) return missing;
  return `For "${question.trim().slice(0, 80)}", which business object and measure should I use, and at what grain (e.g. by day, by customer)?`;
}
