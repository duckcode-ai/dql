/**
 * Compact, provider-agnostic evidence contracts for retrieval-first routing.
 *
 * Retrieval owns recall and ranking. The meaning resolver sees only this bounded
 * package and may reference only IDs contained in it. Execution remains owned by
 * the host after it validates the selected candidates and route.
 */

export type AgentEvidenceKind =
  | "certified_block"
  | "semantic_metric"
  | "semantic_member"
  | "dql_modeling"
  | "dbt_model"
  | "dbt_source"
  | "sql_table"
  | "sql_column";

export type AgentEvidenceTrustTier = "certified" | "semantic" | "governed_sql" | "exploratory";
export type AgentEvidenceCompatibility = "compatible" | "partial" | "incompatible" | "unknown";

export interface AgentEvidenceCandidate {
  /** Stable, source-qualified ID. Leaf names are not valid identities. */
  id: string;
  kind: AgentEvidenceKind;
  trustTier: AgentEvidenceTrustTier;
  name: string;
  aliases?: string[];
  definition?: string;
  formula?: string;
  aggregation?: string;
  domain?: string;
  semanticModel?: string;
  primaryEntity?: string;
  dimensions?: string[];
  timeGrains?: string[];
  requiredParameters?: string[];
  sourceObjects?: string[];
  relationshipEvidence?: string[];
  /** Cross-source relevance score normalized to 0..1 by the retriever. */
  relevanceScore: number;
  matchReasons: string[];
  compatibility: AgentEvidenceCompatibility;
  compatibilityFacts?: string[];
  /** False means the object must not be shown to the resolver. */
  eligible?: boolean;
  /** True only for an exact qualified/name/approved-alias match. */
  exactMatch?: boolean;
}

export interface AgentRetrievalEvidence {
  snapshotId?: string;
  sourceFingerprint?: string;
  candidates: AgentEvidenceCandidate[];
  parsedIntent?: Partial<MeaningQueryIntent>;
  diagnostics?: {
    searchedKinds?: AgentEvidenceKind[];
    durationMs?: number;
    truncated?: boolean;
  };
}

export interface MeaningQueryIntent {
  measures: string[];
  dimensions: string[];
  filters: Array<{ field: string; value: string }>;
  timeRange?: string;
  timeGrain?: string;
  order?: "asc" | "desc";
  limit?: number;
}

export type MeaningQuestionType =
  | "definition"
  | "value"
  | "ranking"
  | "trend"
  | "comparison"
  | "diagnosis"
  | "research";

export type MeaningExecutionRoute = "certified" | "semantic" | "governed_sql" | "exploratory" | "clarify";
export type MeaningConfidence = "high" | "medium" | "low";

export interface MeaningResolution {
  interpretedQuestion: string;
  questionType: MeaningQuestionType;
  selectedConceptIds: string[];
  recommendedExecutionId?: string;
  queryIntent: MeaningQueryIntent;
  rejectedCandidates: Array<{ id: string; reason: string }>;
  confidence: MeaningConfidence;
  missingInformation: string[];
  recommendedRoute: MeaningExecutionRoute;
  clarifyingQuestion?: string;
}

export interface MeaningResolutionInput {
  question: string;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  evidence: AgentRetrievalEvidence;
  candidates: AgentEvidenceCandidate[];
  signal?: AbortSignal;
}

export type AgentMeaningResolver = (input: MeaningResolutionInput) => Promise<MeaningResolution>;

const TRUST_ORDER: Record<AgentEvidenceTrustTier, number> = {
  certified: 4,
  semantic: 3,
  governed_sql: 2,
  exploratory: 1,
};

const COMPATIBILITY_ORDER: Record<AgentEvidenceCompatibility, number> = {
  compatible: 4,
  partial: 3,
  unknown: 2,
  incompatible: 1,
};

/**
 * Produce the bounded evidence package sent to the resolver. Relevance remains
 * primary; trust is only a tie-breaker, so an unrelated certified block cannot
 * displace a materially better semantic match.
 */
export function buildMeaningEvidencePackage(
  evidence: AgentRetrievalEvidence,
  maxCandidates = 12,
): AgentEvidenceCandidate[] {
  const limit = Math.max(1, Math.min(20, Math.floor(maxCandidates)));
  const perTierLimit = Math.max(2, Math.ceil(limit / 2));
  const tierCounts = new Map<AgentEvidenceTrustTier, number>();
  return evidence.candidates
    .filter((candidate) => candidate.eligible !== false)
    .sort(compareCandidates)
    .filter((candidate) => {
      const count = tierCounts.get(candidate.trustTier) ?? 0;
      if (count >= perTierLimit) return false;
      tierCounts.set(candidate.trustTier, count + 1);
      return true;
    })
    .slice(0, limit);
}

function compareCandidates(left: AgentEvidenceCandidate, right: AgentEvidenceCandidate): number {
  return Number(Boolean(right.exactMatch)) - Number(Boolean(left.exactMatch))
    || clamp01(right.relevanceScore) - clamp01(left.relevanceScore)
    || COMPATIBILITY_ORDER[right.compatibility] - COMPATIBILITY_ORDER[left.compatibility]
    || TRUST_ORDER[right.trustTier] - TRUST_ORDER[left.trustTier]
    || left.id.localeCompare(right.id);
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** Match only explicit qualified references; ordinary names still use resolution. */
export function findExplicitEvidenceReference(
  question: string,
  candidates: AgentEvidenceCandidate[],
): AgentEvidenceCandidate | undefined {
  const refs = new Set<string>();
  for (const match of question.matchAll(/@(metric|block|model|table|column)\(([^)]+)\)/gi)) {
    refs.add(normalizeRef(match[2]));
  }
  for (const candidate of candidates) {
    if (question.includes(candidate.id)) refs.add(normalizeRef(candidate.id));
  }
  if (refs.size === 0) return undefined;
  const matches = candidates.filter((candidate) => {
    const candidateRefs = [candidate.id, candidate.name, ...(candidate.aliases ?? [])].map(normalizeRef);
    return candidateRefs.some((ref) => refs.has(ref));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeRef(value: string): string {
  return value.trim().toLowerCase().replace(/[`"']/g, "");
}

/** Validate that a resolver cannot invent or select ineligible evidence. */
export function validateMeaningResolution(
  value: MeaningResolution,
  candidates: AgentEvidenceCandidate[],
): { ok: true; resolution: MeaningResolution } | { ok: false; reason: string } {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const referencedIds = [
    ...value.selectedConceptIds,
    ...(value.recommendedExecutionId ? [value.recommendedExecutionId] : []),
    ...value.rejectedCandidates.map((candidate) => candidate.id),
  ];
  const invented = referencedIds.find((id) => !byId.has(id));
  if (invented) return { ok: false, reason: `The resolver referenced evidence that was not retrieved: ${invented}` };
  if (value.confidence !== "low" && value.selectedConceptIds.length === 0) {
    return { ok: false, reason: "A medium/high-confidence resolution must select at least one retrieved concept." };
  }
  const selected = value.selectedConceptIds.map((id) => byId.get(id)!);
  if (selected.some((candidate) => candidate.eligible === false || candidate.compatibility === "incompatible")) {
    return { ok: false, reason: "The resolver selected ineligible or incompatible evidence." };
  }
  const rejectedIds = new Set(value.rejectedCandidates.map((candidate) => candidate.id));
  if (value.selectedConceptIds.some((id) => rejectedIds.has(id))) {
    return { ok: false, reason: "The resolver both selected and rejected the same evidence." };
  }
  const executionId = value.recommendedExecutionId ?? value.selectedConceptIds[0];
  if (executionId) {
    const execution = byId.get(executionId)!;
    if (execution.eligible === false || execution.compatibility === "incompatible") {
      return { ok: false, reason: "The recommended execution evidence is ineligible or incompatible." };
    }
    if (value.recommendedRoute === "certified" && execution.kind !== "certified_block") {
      return { ok: false, reason: "A certified route must reference a certified block." };
    }
    if (value.recommendedRoute === "certified" && execution.compatibility !== "compatible") {
      return { ok: false, reason: "A certified route requires a deterministically compatible block fit." };
    }
    if (value.recommendedRoute === "semantic" && execution.kind !== "semantic_metric" && execution.kind !== "semantic_member") {
      return { ok: false, reason: "A semantic route must reference semantic evidence." };
    }
    if (value.recommendedRoute === "semantic" && execution.compatibility !== "compatible") {
      return { ok: false, reason: "A semantic route requires deterministic measure, grain, and dimension compatibility." };
    }
  }
  return { ok: true, resolution: value };
}

export function routeForEvidenceCandidate(candidate: AgentEvidenceCandidate): MeaningExecutionRoute {
  if (candidate.kind === "certified_block" && candidate.compatibility === "compatible") return "certified";
  if ((candidate.kind === "semantic_metric" || candidate.kind === "semantic_member") && candidate.compatibility === "compatible") {
    return "semantic";
  }
  return candidate.trustTier === "governed_sql" ? "governed_sql" : "exploratory";
}

export function questionTypeFromText(question: string): MeaningQuestionType {
  if (/\b(why|root ?cause|diagnos|driver|what (?:caused|changed|happened)|anomal)\b/i.test(question)) return "diagnosis";
  if (/\b(research|investigate|deep ?dive)\b/i.test(question)) return "research";
  if (/\b(top|bottom|highest|lowest|rank)\b/i.test(question)) return "ranking";
  if (/\b(trend|over time|month over month|year over year|mom|yoy|by (?:day|week|month|quarter|year))\b/i.test(question)) return "trend";
  if (/\b(compare|versus|vs\.?|difference between)\b/i.test(question)) return "comparison";
  // "What is total revenue?" asks for a data value, not a definition. This
  // distinction matters because definition paths may intentionally bypass
  // execution-shape checks for glossary/certified descriptions.
  if (/\b(total|sum|count|number of|average|avg|minimum|maximum|across all|overall)\b/i.test(question)
    && /\b(what (?:is|was|were|are)|how (?:much|many)|show|report|calculate|give|tell)\b/i.test(question)) return "value";
  if (/^\s*(what (?:is|are|does)|define|definition|meaning of)\b/i.test(question)) return "definition";
  return "value";
}

export function defaultQueryIntent(evidence: AgentRetrievalEvidence): MeaningQueryIntent {
  return {
    measures: evidence.parsedIntent?.measures ?? [],
    dimensions: evidence.parsedIntent?.dimensions ?? [],
    filters: evidence.parsedIntent?.filters ?? [],
    ...(evidence.parsedIntent?.timeRange ? { timeRange: evidence.parsedIntent.timeRange } : {}),
    ...(evidence.parsedIntent?.timeGrain ? { timeGrain: evidence.parsedIntent.timeGrain } : {}),
    ...(evidence.parsedIntent?.order ? { order: evidence.parsedIntent.order } : {}),
    ...(evidence.parsedIntent?.limit !== undefined ? { limit: evidence.parsedIntent.limit } : {}),
  };
}
