import type { AgentRunRequest } from '../agent-run-engine.js';

/**
 * THE turn classifier.
 *
 * Six predicates used to decide what kind of turn a question was — one in the
 * V1 router, one in the V1 analyst runtime, one in the intent controller, two
 * in the engine, one in the V2 runtime — and they disagreed about whether
 * "why did it drop?" continued an answered turn. This module is the one
 * owner: conversational turns first (a greeting, thanks, a question about the
 * assistant, a recap, a question about the last answer), then the analytical
 * classes the V2 kernel plans against. Everything else imports from here.
 */

export type ConversationalKind =
  | 'greeting'
  | 'gratitude'
  | 'meta_capability'
  | 'smalltalk'
  | 'answer_explanation';

export type AskTurnClassV2 =
  | 'analytics'
  | 'definition'
  | 'business_context'
  | 'prior_result'
  | 'general'
  | 'clarification_response'
  | 'research';

/** Does this request continue a turn that already has an answer on screen? */
export function continuesAnsweredTurn(request: Pick<AgentRunRequest, 'conversationContext' | 'history'>): boolean {
  return Boolean(request.conversationContext || request.history?.length);
}

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
  /\b(?:what\s+(?:(?:are|were|have)\s+we|we\s+(?:are|were|have))\s+(?:been\s+)?talking\s+about|what\s+(?:(?:are|were)\s+we|we\s+(?:are|were))\s+(?:(?:reviewing|discussing|covering)(?:\s+and\s+(?:reviewing|discussing|covering))*|working\s+on)(?:\s+(?:here|so\s+far|in\s+(?:(?:this|the|our|whole)\s+)?(?:chat|conversation|discussion|thread)))?|what\s+(?:is|was)\s+(?:this|the|our|whole)\s+(?:chat|conversation|discussion|thread)\s+about|what\s+is\s+this\s+about|where\s+were\s+we|remind\s+me(?:\s+what\s+we\s+were\s+(?:talking|reviewing|discussing)\s+about)?|(?:can\s+you\s+)?walk\s+me\s+through\s+what\s+we\s+(?:just\s+)?looked\s+at|recap(?:\s+(?:this|our|the|whole))?(?:\s+(?:chat|conversation|discussion|thread))?|summari[sz]e\s+(?:this|our|the|whole)(?:\s+(?:chat|conversation|discussion|thread))?)\b/;
/**
 * Questions about the meaning or scope of the latest successful answer. These
 * must be answered from the persisted artifact contract rather than interpreted
 * as a request to calculate another metric. Keep this deliberately deictic and
 * explanation-shaped so "show it monthly" still runs the governed data loop.
 */
const PRIOR_ANSWER_EXPLANATION_PATTERNS = [
  /\b(?:is|was|are|were)\s+(?:it|(?:this|that)(?:\s+(?:answer|result|number|amount|metric))?|the\s+(?:answer|result|number|amount|metric))\s+(?:daily|monthly|weekly|quarterly|yearly|annual|cumulative|total)\b/i,
  /\bwhat\s+(?:(?:time|date)\s*)?(?:grain|period|range|timeframe)\s+(?:(?:is|was)\s+(?:it|this|that)|(?:did|does)\s+(?:it|this\s+(?:answer|result)|this|that|the\s+(?:answer|result))\s+(?:use|cover))\b/i,
  /\bwhich\s+(?:metric|measure|source|table|filter|period|timeframe|grain)\s+(?:did|does|was|is)\s+(?:it|this|that|you)\b/i,
  /\bwhat\s+does\s+(?:it|this\s+(?:answer|result|number|amount|metric)|this|that|the\s+(?:answer|result|number|amount|metric))\s+(?:mean|represent|include|exclude|cover)\b/i,
  /\b(?:is|was|are|were)\s+(?:it|this|that|the\s+(?:answer|result))\s+(?:filtered|grouped|aggregated)\b/i,
];
const PRIOR_ANSWER_MUTATION_RE =
  /\b(?:show|display|break|group|rerun|re-run|recalculate|calculate|change|switch|convert|compare|add|remove)\b/i;

/**
 * Normalize only a few high-frequency chat-recap typos. This is intentionally
 * not general fuzzy matching: analytical questions must not be diverted away
 * from governed data routing merely because they contain a vaguely similar word.
 */
function normalizeConversationRecapText(question: string): string {
  return question
    .toLowerCase()
    .replace(/\bconversaion\b|\bconversaton\b|\bconverstation\b/g, 'conversation')
    .replace(/\brevewing\b|\breviwing\b/g, 'reviewing')
    .replace(/\bdiscusing\b|\bdisucssing\b/g, 'discussing')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeConversationRecap(question: string): boolean {
  return CONTEXT_RECAP_RE.test(normalizeConversationRecapText(question));
}

/** True only for a read-only question about the latest analytical artifact. */
export function looksLikePriorAnswerExplanation(question: string, hasHistory: boolean): boolean {
  if (!hasHistory) return false;
  const normalized = question.trim();
  if (!normalized || PRIOR_ANSWER_MUTATION_RE.test(normalized)) return false;
  return PRIOR_ANSWER_EXPLANATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

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
  // A strong conversation-meta phrase wins even when it mentions "results",
  // "SQL", or a metric by name. It summarizes the existing thread; it must not
  // replay the prior analytical route as a new data request.
  if (hasHistory && looksLikeConversationRecap(trimmed)) return 'smalltalk';
  // A deictic question about the previous answer's metric, filters, or grain is
  // also conversational. The persisted artifact is the evidence source; do not
  // reinterpret it as a fresh analytics request merely because it says revenue,
  // month, day, metric, or filter.
  if (looksLikePriorAnswerExplanation(trimmed, hasHistory)) return 'answer_explanation';
  // Any real data ask wins, regardless of a polite opener.
  if (DATA_VOCAB_RE.test(trimmed)) return undefined;
  const words = trimmed.split(/\s+/).length;

  if (META_CAPABILITY_RE.test(trimmed)) return 'meta_capability';
  // Short openers/closers only — a long sentence starting with "hi" is likely a real ask.
  if (words <= 6 && GREETING_RE.test(trimmed)) return 'greeting';
  if (words <= 6 && GRATITUDE_RE.test(trimmed)) return 'gratitude';
  // Deliberately no generic "small talk" catch-all: a vague-but-real data ask
  // ("show me the numbers", "widgets") must still fall through to the data cascade
  // and clarify. The `smalltalk` kind is reserved for the LLM router (Phase 2).
  return undefined;
}


function analyticalTurnClass(request: AgentRunRequest): AskTurnClassV2 {
  if (request.requestedMode === 'research') return 'research';
  if (request.selectedEvidenceId || request.clarificationSourceQuestion) return 'clarification_response';
  // An AMBIGUOUS prior-result reference is still a prior-result turn. The host
  // resolves candidates it cannot choose between into this gap; classifying
  // the turn as fresh analytics would frame the clarification as a brand-new
  // question and lose the very result it is asking about.
  if (request.selectedResultBinding || request.priorResultMemberBinding || request.selectedResultBindingGap) {
    return 'prior_result';
  }
  const question = request.question.toLowerCase();
  // "What is revenue for each customer?" is a grouped analytical request,
  // not a metadata definition. Definition routing stays warehouse-free only
  // when the wording has no aggregate, grouping, ranking, or entity shape.
  const analyticalShape = /\b(top|bottom|highest|lowest|total|count|sum|average|avg|revenue|sales|orders?|customers?|products?|regions?|by|per|each|every|for each|group(?:ed)?|trend|compare|rank)\b/.test(question);
  if (/\b(what is|define|definition|meaning of|explain)\b/.test(question)
    && /\b(metric|measure|dimension|model|block|revenue|customer)\b/.test(question)
    && !analyticalShape) return 'definition';
  // "Why did it drop?" asked about an answer already on screen is a question
  // about DATA, and the contextual class forbids execution — so the one
  // follow-up a person most naturally asks could never be answered. Business
  // context is for a question asked cold, with no result to explain.
  const continuesAnAnsweredTurn = continuesAnsweredTurn(request);
  if (/\b(why|business context|background|how does|tell me about)\b/.test(question)
    && !continuesAnAnsweredTurn
    && !/\b(top|by |revenue|count|sum|average|sales|customer|product|region)\b/.test(question)) return 'business_context';
  if (/^(hi|hello|thanks|thank you|what can you do)\b/.test(question.trim())) return 'general';
  return 'analytics';
}


export function isAskRequestV2(request: AgentRunRequest): boolean {
  return request.requestedMode === undefined
    || request.requestedMode === 'auto'
    || request.requestedMode === 'ask'
    || request.requestedMode === 'research';
}

/**
 * One classification per turn: a conversational kind when the turn wants a
 * plain reply (its analytical class is then `general`), else the class the
 * kernel plans against.
 */
export function classifyAskTurn(request: AgentRunRequest): { turnClass: AskTurnClassV2; conversationalKind?: ConversationalKind } {
  const conversationalKind = classifyConversationalTurn(request.question, continuesAnsweredTurn(request));
  if (conversationalKind) return { turnClass: 'general', conversationalKind };
  return { turnClass: analyticalTurnClass(request) };
}
