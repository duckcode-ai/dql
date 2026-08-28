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

import type { AnswerAssumption } from './agentic/assumptions.js';
import type { MetadataAgentIntent } from './metadata/catalog.js';
import type { MeaningResolution } from './meaning-resolution.js';
import type { ResolvedAnalyticalPlan } from './resolved-analytical-plan.js';
import type {
  AnalyticalCascadeDecisionV1,
  AnalyticalCoverageGapV1,
  AnalyticalProgram,
  AskAnalystState,
  BusinessAnswer,
  ProviderFailureDiagnosticV1,
  ResolvedAnalyticalPlanV2,
} from './analytical-orchestration.js';
import type { AgentRunPlan } from './agent-run-engine.js';

/** The high-level action the agent will take for a turn. */
export type AgentAction = 'answer' | 'clarify' | 'investigate' | 'compose_app' | 'converse' | 'block';

/**
 * A narrow, producer-owned witness for a terminal analytical coverage gap.
 *
 * The high-level terminal kind remains intentionally small (`modeling_gap` or
 * `policy_blocked`) for backwards-compatible route handling.  This nested
 * receipt is the only authority for showing a more specific repair such as a
 * missing relationship.  Callers must not infer it from prose or from the
 * broad `modeling_gap` kind.
 */
export interface AnalyticalTerminalGapWitness {
  code: Extract<
    AnalyticalCoverageGapV1['code'],
    | 'MISSING_MEASURE'
    | 'MISSING_DIMENSION'
    | 'MISSING_ATTRIBUTE'
    | 'MISSING_RELATIONSHIP'
    | 'MISSING_RUNTIME_CAPABILITY'
    | 'RESULT_CONTRACT_MISMATCH'
  >;
  /** Reader-safe description of the missing analytical role or proof. */
  missing: string[];
  /** Qualified evidence IDs that caused this category; never inferred by consumers. */
  witnessCandidateIds: string[];
}

/**
 * Conversational turn kinds that deserve a plain, warm reply instead of the data
 * routing cascade. Deliberately narrow — anything with data vocabulary falls
 * through to the analytics cascade so we never chit-chat a real question away.
 */
export type ConversationalKind =
  | 'greeting'
  | 'gratitude'
  | 'meta_capability'
  | 'smalltalk'
  | 'answer_explanation';

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
  /**
   * Bindings the router chose without proving, so the turn could answer instead
   * of asking a question with one sensible reply. Always user-visible: an
   * assumption the user cannot see is indistinguishable from a wrong answer.
   */
  assumptions?: AnswerAssumption[];
  /**
   * Retrieval-first meaning decision. Executors may use the selected qualified
   * IDs as a query specification, but must still validate/authorize execution.
   */
  meaningResolution?: MeaningResolution;
  /** R3 shadow plan; R4 promotes this exact fingerprint to execution authority. */
  resolvedAnalyticalPlan?: ResolvedAnalyticalPlan;
  /** The router's immutable authority order; executors consume rather than rebuild it. */
  analyticalCascadeDecision?: AnalyticalCascadeDecisionV1;
  /** Stable system failure from qualified meaning validation; never a user ambiguity. */
  meaningResolutionErrorCode?: 'invalid_evidence_reference';
  /** Redacted retrieval trace; deliberately excludes definitions and raw values. */
  retrievalEvidence?: {
    snapshotId?: string;
    sourceFingerprint?: string;
    /** Opaque restart-safe continuity proof; never contains candidate content. */
    continuityFingerprint?: string;
    candidateCount: number;
    candidateIds: string[];
    /** Qualified, content-free role/source witnesses for trace projection. */
    candidateTraceMetadata?: Array<{
      candidateId: string;
      role: import('./analytical-orchestration.js').EvidenceCandidateRoleV1;
      source: import('./analytical-orchestration.js').ContextSourceCoverageV1['source'];
      lanes?: Array<{ lane: 'exact' | 'lexical' | 'vector' | 'graph' | 'conversation'; rank?: number }>;
    }>;
  };
  /** A hard ambiguity must remain a clarification; answer-anyway must not bypass it. */
  requiresClarification?: boolean;
  /** Stable, identifier-bound choices rendered by clients for a hard ambiguity. */
  clarificationOptions?: Array<{
    id: string;
    label: string;
    description?: string;
    kind?: string;
  }>;
  /** Explicit non-answer terminal authority for policy/modeling failures. */
  terminalOutcome?: {
    kind: 'modeling_gap' | 'policy_blocked';
    code: 'ANALYTICAL_MODELING_GAP' | 'ANALYTICAL_POLICY_BLOCKED';
    message: string;
    candidateIds: string[];
    /** Exact analytical coverage category, when the router/producer proved one. */
    gap?: AnalyticalTerminalGapWitness;
  };
  /** Provider failures are terminal infrastructure evidence, never modeling gaps. */
  providerFailure?: ProviderFailureDiagnosticV1;
  /**
   * V1.15 Ask runtime receipt.  The runtime owns the business frame, evidence
   * workspace, and route-neutral program; the old router may only compile it.
   * It is additive so persisted pre-runtime decisions remain readable.
   */
  askAnalystDecision?: {
    version: 1;
    mode: 'legacy' | 'shadow' | 'authoritative';
    state: AskAnalystState;
    resolvedPlan?: ResolvedAnalyticalPlanV2;
    /** Runtime-built immutable task plan; engine executes it without replanning meaning. */
    frozenPlan?: AgentRunPlan;
    businessAnswer?: BusinessAnswer;
    /**
     * A compound ordinary Ask freezes one independently verified compiler
     * program per accepted task.  The engine consumes this server-owned list
     * verbatim; it may not reuse task-1's meaning/cascade for task-2.
     */
    taskExecutions?: AskAnalystTaskExecutionV1[];
  };
}

/**
 * Immutable per-task compiler handoff owned by AskAnalystRuntimeV1.  It is
 * intentionally additive so pre-V2 persisted decisions remain readable.
 */
export interface AskAnalystTaskExecutionV1 {
  version: 1;
  taskId: string;
  state: AskAnalystState;
  program: AnalyticalProgram;
  meaningResolution: MeaningResolution;
  /** Verified task-local compiler bindings; never hydrated from public ingress. */
  requirementSeed: import('./analytical-orchestration.js').AnalyticalRequirementSeedV1;
  tierReadiness: {
    connector: 'ready' | 'unavailable' | 'unknown';
    activeTarget: 'ready' | 'unavailable' | 'unknown';
    semanticCompiler: 'ready' | 'unavailable' | 'unknown';
    semanticCandidateReadiness?: Array<{
      candidateId: string;
      status: 'ready' | 'unavailable' | 'unknown';
    }>;
    physicalSchema: 'ready' | 'unavailable' | 'unknown';
    targetFingerprint?: string;
  };
  compilerDecision: Omit<IntentDecision, 'askAnalystDecision'>;
  resolvedPlan: ResolvedAnalyticalPlanV2;
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
/**
 * SOFT analytical phrasing — only investigate when no confident direct answer fits.
 * A plain "by <dimension>" grouping is deliberately NOT here: that's an ordinary
 * descriptive breakdown the generated-SQL lane answers directly and fast, not a
 * root-cause investigation. Investigation stays reserved for genuinely analytical
 * phrasing (breakdown / compare / trend) and investigative intents — sending a
 * simple "average X by A by B" to the research lane cost a 40s deep vote.
 */
const SOFT_INVESTIGATE_RE =
  /\b(break ?down|breakdown|compare|vs\.?|versus|trend over|over time)\b/i;
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

/**
 * A question in DEFINITIONAL form about a governed artifact it names.
 *
 * `buildAnalysisQuestionPlan` reads the ARTIFACT'S OWN NAME as analytical intent:
 * `food_vs_drink_revenue` contains "vs" so the plan comes back `comparison`, and
 * `top_customers` contains "top" so it comes back `ranking`. Neither is ever
 * `definition`, so "what is food_vs_drink_revenue?" is routed as an analytical
 * question, hits the ambiguity gate, and is answered with "Which governed meaning
 * should DQL bind…" — about the single artifact the user just named.
 *
 * Both conditions are required, and deliberately so. The definitional FORM alone
 * would swallow "what is our revenue"; a named artifact alone would swallow
 * "top_customers by region", which is a real query. Together they identify a
 * question that wants an explanation, not an execution.
 */
/**
 * Wording that expressly asks for an explanation of a concept rather than its
 * current analytical value.  A bare "what is" is intentionally excluded: in
 * ordinary analytics language, "What is monthly revenue?" asks for the value
 * of a metric and can have a compatible certified execution contract.
 */
const EXPLICIT_DEFINITIONAL_FORM_RE =
  /\b(?:what\s+does\b[^?.!]{1,160}\bmean\b|define\b|definition(?:\s+of)?\b|explain\b|describe\b|tell\s+me\s+about\b|meaning\s+of\b|how\s+is\b[^?.!]{1,160}\bdefined\b)/i;

/**
 * A literal DQL/dbt-style identifier is still a reasonable definition request
 * with a bare "what is" opener.  Keep this separate from natural-language
 * metric wording so `what is monthly_revenue?` may explain an artifact while
 * `What is monthly revenue?` reaches its certified execution path.
 */
const BARE_WHAT_IS_RE = /^\s*what\s+(?:is|are)\b/i;
const FULLY_QUALIFIED_OBJECT_ID_RE = /^(?:[a-z][a-z0-9_-]*:){2,}[a-z0-9_./-]+$/i;

/** Trailing verbs that turn a definitional opener back into a data request. */
const DEFINITIONAL_EXECUTION_RE =
  /\b(?:by\s+[a-z_]|for\s+(?:the\s+)?(?:last|next|this|past)\b|group(?:ed)?\s+by\b|filter(?:ed)?\s+by\b|top\s+\d|show\s+me\b|list\b|compare\b)/i;

export function looksLikeDefinitionalAboutNamedObject(
  question: string,
  objectNames: readonly string[],
): boolean {
  const trimmed = question.trim();
  const explicitDefinition = EXPLICIT_DEFINITIONAL_FORM_RE.test(trimmed);
  const bareWhatIs = BARE_WHAT_IS_RE.test(trimmed);
  if (!trimmed || (!explicitDefinition && !bareWhatIs)) return false;
  // "what is revenue by region" is a query wearing a definitional opener.
  if (DEFINITIONAL_EXECUTION_RE.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  return objectNames.some((raw) => {
    const rawId = String(raw).trim().toLowerCase();
    // Names arrive qualified (`dql:block:top_customers`); the leaf is what a
    // person types.
    const leaf = rawId.split(':').pop()?.trim() ?? '';
    if (leaf.length < 3) return false;
    const spaced = leaf.replace(/[_.]+/g, ' ');
    if (explicitDefinition) return lower.includes(leaf) || (spaced.length > 3 && lower.includes(spaced));
    // A raw, fully-qualified object ID is unambiguously a request about the
    // object, even when its leaf is a plain metric name such as `revenue`.
    // This stays narrow: ordinary wording like "monthly revenue" does not
    // contain the qualified identifier and remains eligible for execution.
    if (FULLY_QUALIFIED_OBJECT_ID_RE.test(rawId) && lower.includes(rawId)) return true;
    // A bare "what is" only takes the definition lane when the user wrote the
    // identifier itself (rather than its words as an analytical metric). This
    // preserves direct execution for a complete certified metric block while
    // retaining the technical-artifact explanation path.
    return /[_./-]/.test(leaf) && lower.includes(leaf);
  });
}

/**
 * A selected certified block can answer its own explicit definition grammar
 * from authored metadata. Keep this narrower than the broad definition lane:
 * a natural-language metric definition remains conversational unless the user
 * names the selected block/artifact itself.
 */
export function looksLikeNamedCertifiedArtifactMetadataRequest(
  question: string,
  objectNames: readonly string[],
): boolean {
  const match = /^\s*what\s+does\s+(?:the\s+)?(.+?)\s+(?:measure|mean|define|represent)\s*[?.!]*\s*$/i.exec(question);
  if (!match?.[1]) return false;
  // Require the artifact noun in natural-language form. Without it, a phrase
  // such as "what does monthly revenue mean?" is a metric definition, not a
  // request to stamp a similarly named block's metadata as certified.
  if (!/\b(?:certified\s+)?(?:block|artifact)\b/i.test(match[1])) return false;
  const subject = match[1]
    .replace(/\b(?:certified\s+)?(?:block|artifact)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!subject) return false;
  return objectNames.some((raw) => {
    const id = String(raw).trim().toLowerCase();
    if (!/^(?:dql:)?block:/.test(id)) return false;
    const leaf = id.split(':').pop()?.trim() ?? '';
    return leaf.length > 0 && (subject === leaf || subject === leaf.replace(/[_.]+/g, ' '));
  });
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
  // Analytical references are often full sentences ("what product did they
  // buy for this amount?"). Do not limit pronoun resolution to four words.
  return /\b(it|its|they|their|them|he|him|his|she|her|hers|that|this|those|these|same|previous|prior)\b/i.test(trimmed)
    && trimmed.split(/\s+/).length <= 24;
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
  //    This is an UNAMBIGUOUS answerable question that already has governed context
  //    — not the paraphrased/implicit case the LLM router exists to disambiguate —
  //    so it clears the router's confidence threshold and skips the classify call
  //    (Pillar 1: fewer LLM calls). The answer loop's own cascade still decides
  //    certified-vs-generated; this only settles that it's an answer, not a clarify.
  if (DIRECT_ANSWER_INTENTS.has(intent) && (signals.hasRetrieval ?? false)) {
    return {
      action: 'answer',
      confidence: 0.72,
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
