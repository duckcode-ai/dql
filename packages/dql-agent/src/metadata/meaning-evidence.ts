import {
  scoreMetadataObjectWithAnalysisPlan,
  type AnalysisQuestionPlan,
} from "./analysis-planner.js";
import {
  normalizeMetricCapabilityContract,
  type AnalyticalPolicyContract,
  type MetricCapabilityContract,
} from "@duckcodeailabs/dql-core";
import type { LocalContextPack, MetadataObject } from "./catalog.js";
import type {
  AgentEvidenceCandidate,
  AgentEvidenceKind,
  AgentRetrievalEvidence,
} from '../meaning-resolution.js';
import type { KnowledgeLens } from '../domain-context.js';

export type MetadataEvidenceClass = 'certified' | 'semantic' | 'sql';
export type MetadataEvidenceTrust = 'certified' | 'semantic' | 'governed_sql' | 'exploratory';

export interface MetadataMeaningCandidate {
  objectKey: string;
  qualifiedId: string;
  evidenceClass: MetadataEvidenceClass;
  trustTier: MetadataEvidenceTrust;
  classRank: number;
  relevanceScore: number;
  name: string;
  aliases: string[];
  objectType: string;
  domain?: string;
  status?: string;
  definition?: string;
  formula?: string;
  semanticModel?: string;
  relevanceReasons: string[];
  compatibilityFacts: string[];
  businessShape: {
    aggregation?: string;
    grain?: string;
    entities: string[];
    dimensions: string[];
    timeGrains: string[];
    parameters: string[];
    filters: string[];
    outputs: string[];
    sourceRelations: string[];
  };
  /** Snapshot-normalized execution truth; absent means capability is incomplete. */
  analyticalCapability?: MetricCapabilityContract;
  provenance?: string;
  ambiguityPeerIds: string[];
}

export interface MetadataMeaningEvidencePackage {
  candidates: MetadataMeaningCandidate[];
  byEvidenceClass: Record<MetadataEvidenceClass, MetadataMeaningCandidate[]>;
  ambiguousGroups: Array<{ candidateIds: string[]; reason: string }>;
}

export interface AgentRetrievalEvidenceAdapterOptions {
  snapshotId?: string;
  sourceFingerprint?: string;
  durationMs?: number;
  truncated?: boolean;
  knowledgeLens?: KnowledgeLens;
  /** Exact policies compiled from the already-selected, fingerprinted Skills. */
  analyticalPolicies?: AnalyticalPolicyContract[];
  /** Same immutable context-pack objects used to prove member/value bindings. */
  contextObjects?: MetadataObject[];
}

export interface MeaningEvidenceInputCandidate {
  row: MetadataObject;
  rank: number;
  score: number;
  reason: string;
  priorityTier: string;
}

const GENERIC_MEANING_TOKENS = new Set([
  'amount', 'value', 'metric', 'measure', 'total', 'overall', 'monthly', 'daily',
  'weekly', 'quarterly', 'yearly', 'annual', 'count', 'number', 'rate', 'ratio',
]);
const MAX_CANDIDATES_PER_CLASS = 4;
const ANALYTICAL_TIME_GRAINS = new Set(['day', 'week', 'month', 'quarter', 'year', 'season', 'period']);

/**
 * Produce compact meaning-rich cards for an AI resolver. Relevance and trust
 * intentionally remain separate: certification labels an execution lane but
 * never makes an unrelated candidate more relevant to the question.
 */
export function buildMeaningEvidencePackage(
  question: string,
  questionPlan: AnalysisQuestionPlan,
  ranked: MeaningEvidenceInputCandidate[],
): MetadataMeaningEvidencePackage {
  const questionText = normalizeText(question);
  const questionTokens = tokenSet(questionText);
  const eligible = ranked.flatMap((item) => {
    const evidenceClass = evidenceClassFor(item.row);
    if (!evidenceClass) return [];
    const aliases = aliasesFor(item.row);
    const lexical = lexicalRelevance(questionText, questionTokens, item.row, aliases);
    const planned = scoreMetadataObjectWithAnalysisPlan(item.row, questionPlan);
    const searchSignal = Math.max(0, Math.min(1, item.row.score ?? 0));
    const relevanceScore = roundScore(
      lexical.score + Math.min(32, Math.max(0, planned.score)) + searchSignal * 24,
    );
    if (relevanceScore <= 0) return [];
    return [{
      item,
      evidenceClass,
      aliases,
      relevanceScore,
      relevanceReasons: uniqueStrings([
        ...lexical.reasons,
        ...planned.reasons,
        searchSignal > 0 ? `ranked lexical search match (${searchSignal.toFixed(3)})` : '',
      ]).slice(0, 6),
    }];
  });

  eligible.sort((left, right) =>
    right.relevanceScore - left.relevanceScore
    || left.item.rank - right.item.rank
    || left.item.row.objectKey.localeCompare(right.item.row.objectKey));

  const requiredSemanticMetricKey = questionPlan.requestedShape.measures.length > 0
    ? eligible.find((candidate) =>
      candidate.evidenceClass === 'semantic'
      && candidate.item.row.objectType === 'semantic_metric')?.item.row.objectKey
    : undefined;

  const selectedByClass: Record<MetadataEvidenceClass, typeof eligible> = {
    certified: [], semantic: [], sql: [],
  };
  const semanticMeaningIndexes = new Map<string, number>();
  for (const candidate of eligible) {
    const lane = selectedByClass[candidate.evidenceClass];
    if (candidate.evidenceClass === 'semantic') {
      // Dimensions and metrics share the semantic trust class. Preserve one
      // retrieved metric for a measure-bearing question before member matches
      // consume the bounded lane; deterministic compatibility still decides
      // whether that metric is executable.
      if (
        requiredSemanticMetricKey
        && candidate.item.row.objectKey !== requiredSemanticMetricKey
        && lane.length >= MAX_CANDIDATES_PER_CLASS - 1
        && !lane.some((selectedCandidate) =>
          selectedCandidate.item.row.objectKey === requiredSemanticMetricKey)
      ) continue;
      const definitionKey = normalizeText(candidate.item.row.description ?? '');
      const meaningKey = definitionKey ? `${candidate.item.row.domain ?? ''}|${definitionKey}` : '';
      const existingIndex = meaningKey ? semanticMeaningIndexes.get(meaningKey) : undefined;
      if (existingIndex !== undefined) {
        const existing = lane[existingIndex];
        if (existing && semanticExecutionPriority(candidate.item.row) < semanticExecutionPriority(existing.item.row)) {
          lane[existingIndex] = candidate;
        }
        continue;
      }
      if (lane.length < MAX_CANDIDATES_PER_CLASS) {
        if (meaningKey) semanticMeaningIndexes.set(meaningKey, lane.length);
        lane.push(candidate);
      }
      continue;
    }
    if (lane.length < MAX_CANDIDATES_PER_CLASS) lane.push(candidate);
  }
  const selected = (['certified', 'semantic', 'sql'] as const)
    .flatMap((evidenceClass) => selectedByClass[evidenceClass]);
  const peerMap = buildAmbiguityPeers(selected.map((candidate) => ({
    objectKey: candidate.item.row.objectKey,
    aliases: candidate.aliases,
  })));

  const byEvidenceClass: MetadataMeaningEvidencePackage['byEvidenceClass'] = {
    certified: [], semantic: [], sql: [],
  };
  for (const candidate of selected) {
    const lane = byEvidenceClass[candidate.evidenceClass];
    lane.push(candidateCard(
      candidate.item.row,
      candidate.evidenceClass,
      lane.length + 1,
      candidate.relevanceScore,
      candidate.aliases,
      candidate.relevanceReasons,
      peerMap.get(candidate.item.row.objectKey) ?? [],
    ));
  }
  return {
    candidates: (['certified', 'semantic', 'sql'] as const)
      .flatMap((evidenceClass) => byEvidenceClass[evidenceClass]),
    byEvidenceClass,
    ambiguousGroups: ambiguityGroups(peerMap),
  };
}

/**
 * Adapter boundary used by evidence-first routing. Metadata keeps richer lane
 * diagnostics, while the router receives the single provider-agnostic contract
 * shared by CLI, notebook, MCP, and native agent hosts.
 */
/**
 * Attach the governed relationships that touch each candidate's relations.
 *
 * `AgentEvidenceCandidate.relationshipEvidence` was declared, rendered into the
 * meaning-resolution prompt, and read by `compileGovernedRelationalPlan` via
 * `plan.relationshipPathIds` — but nothing ever populated it. The compiler
 * gates joins on that list, so every multi-relation governed compile returned
 * `RELATIONSHIP_PROOF_REQUIRED` and the path was unreachable in production.
 *
 * This only *offers* the identities. `compileGovernedRelationalPlan` still
 * enforces certified, fresh, automatic-join-safe (`REL-002`) before it emits a
 * join, so surfacing a draft relationship here cannot authorize one.
 */
function attachRelationshipEvidence(
  candidates: AgentEvidenceCandidate[],
  contextObjects: MetadataObject[],
): void {
  const relationships = contextObjects.filter((object) => object.objectType === 'relationship');
  if (relationships.length === 0) return;

  const identitiesByEntity = new Map<string, Set<string>>();
  for (const object of relationships) {
    const payload = (object.payload ?? {}) as { from?: string; to?: string; qualifiedId?: string; id?: string; localId?: string };
    const identities = [payload.qualifiedId, payload.id, payload.localId, object.objectKey, object.fullName, object.name]
      .filter((value): value is string => Boolean(value));
    if (identities.length === 0) continue;
    for (const endpoint of [payload.from, payload.to]) {
      if (!endpoint) continue;
      for (const alias of entityAliasesForRelationshipMatch(endpoint)) {
        const existing = identitiesByEntity.get(alias) ?? new Set<string>();
        for (const identity of identities) existing.add(identity);
        identitiesByEntity.set(alias, existing);
      }
    }
  }
  if (identitiesByEntity.size === 0) return;

  for (const candidate of candidates) {
    for (const dimension of candidate.analyticalCapability?.dimensions ?? []) {
      const pathRelationships = new Set(dimension.relationshipPathIds ?? []);
      for (const reference of [dimension.entityId, ...(dimension.nativeGroupingPath ?? [])]) {
        for (const alias of entityAliasesForRelationshipMatch(reference)) {
          for (const identity of identitiesByEntity.get(alias) ?? []) pathRelationships.add(identity);
        }
      }
      if (pathRelationships.size > 0) dimension.relationshipPathIds = [...pathRelationships].sort();
    }
    const touched = new Set<string>();
    const capabilityPathEntities = candidate.analyticalCapability?.dimensions.flatMap((dimension) => [
      dimension.entityId,
      ...(dimension.nativeGroupingPath ?? []),
    ]) ?? [];
    for (const reference of [
      candidate.primaryEntity,
      candidate.analyticalCapability?.primaryEntityId,
      ...capabilityPathEntities,
      ...(candidate.sourceObjects ?? []),
    ]) {
      if (!reference) continue;
      for (const alias of entityAliasesForRelationshipMatch(reference)) {
        for (const identity of identitiesByEntity.get(alias) ?? []) touched.add(identity);
      }
    }
    if (touched.size > 0) candidate.relationshipEvidence = [...touched].sort();
  }
}

/** Match `commerce::entity::order`, `order`, and `entity:order` as one entity. */
function entityAliasesForRelationshipMatch(reference: string): string[] {
  const normalized = reference.toLowerCase().replace(/^entity:/, '');
  return [...new Set([normalized, normalized.split('::').at(-1) ?? normalized])];
}

export function toAgentRetrievalEvidence(
  evidence: MetadataMeaningEvidencePackage,
  questionPlan: AnalysisQuestionPlan,
  options: AgentRetrievalEvidenceAdapterOptions = {},
): AgentRetrievalEvidence {
  const maxRelevance = Math.max(
    1,
    ...evidence.candidates.map((candidate) => candidate.relevanceScore),
  );
  const candidates: AgentEvidenceCandidate[] = evidence.candidates.map(
    (candidate) => agentCandidateFromMeaning(candidate, maxRelevance),
  );
  const trustedBindings = trustedMemberBindingEvidence(
    questionPlan,
    candidates,
    options.contextObjects ?? [],
  );
  for (const member of trustedBindings.candidates) {
    if (!candidates.some((candidate) => candidate.id === member.id)) candidates.push(member);
  }
  const clarificationCandidates = supplementalClarificationEvidence(
    questionPlan,
    options.contextObjects ?? [],
    candidates,
  );
  attachRelationshipEvidence(candidates, options.contextObjects ?? []);
  attachRelationshipEvidence(clarificationCandidates, options.contextObjects ?? []);
  const groundedFilters = [
    ...trustedBindings.filters,
    ...groundedMemberFilters(questionPlan, candidates, options.contextObjects ?? []),
  ].filter((filter, index, all) => all.findIndex((other) =>
    other.field === filter.field && other.value === filter.value) === index);
  return {
    snapshotId: options.snapshotId,
    sourceFingerprint: options.sourceFingerprint,
    knowledgeLens: options.knowledgeLens,
    analyticalPolicies: options.analyticalPolicies,
    candidates,
    ...(clarificationCandidates.length > 0 ? { clarificationCandidates } : {}),
    parsedIntent: {
      measures: questionPlan.requestedShape.measures,
      dimensions: questionPlan.requestedShape.dimensions,
      filters: groundedFilters,
      ...(analysisTimeGrain(questionPlan)
        ? { timeGrain: analysisTimeGrain(questionPlan) }
        : {}),
      ...(questionPlan.requestedShape.rankingDirection
        ? { order: questionPlan.requestedShape.rankingDirection === 'top' ? 'desc' as const : 'asc' as const }
        : {}),
      ...(questionPlan.requestedShape.topN ? { limit: questionPlan.requestedShape.topN.n } : {}),
    },
    diagnostics: {
      searchedKinds: [...new Set([...candidates, ...clarificationCandidates].map((candidate) => candidate.kind))],
      durationMs: options.durationMs,
      truncated: options.truncated ?? false,
    },
  };
}

function agentCandidateFromMeaning(candidate: MetadataMeaningCandidate, maxRelevance = 1): AgentEvidenceCandidate {
  return {
      id: candidate.objectKey,
      qualifiedId: candidate.qualifiedId,
      kind: agentEvidenceKind(candidate),
      ...(semanticObjectType(candidate.objectType)
        ? { semanticObjectType: semanticObjectType(candidate.objectType) }
        : {}),
      trustTier: candidate.trustTier,
      name: candidate.name,
      aliases: candidate.aliases,
      definition: candidate.definition,
      formula: candidate.formula,
      aggregation: candidate.businessShape.aggregation,
      provenance: candidate.provenance,
      domain: candidate.domain,
      semanticModel: candidate.semanticModel,
      primaryEntity: candidate.businessShape.entities[0],
      dimensions: dimensionLookupAliases(candidate.businessShape.dimensions),
      timeGrains: candidate.businessShape.timeGrains,
      requiredParameters: candidate.businessShape.parameters,
      sourceObjects: candidate.businessShape.sourceRelations,
      relevanceScore: Number(
        (candidate.relevanceScore / maxRelevance).toFixed(6),
      ),
      matchReasons: candidate.relevanceReasons,
      // Fit validation remains host-owned. Metadata only reports facts here and
      // must not claim executable compatibility prematurely.
      compatibility: "unknown",
      compatibilityFacts: candidate.compatibilityFacts,
      analyticalCapability: candidate.analyticalCapability,
      eligible: true,
      exactMatch: candidate.relevanceReasons.includes("exact name or alias"),
  };
}

function trustedMemberBindingEvidence(
  plan: AnalysisQuestionPlan,
  candidates: AgentEvidenceCandidate[],
  objects: MetadataObject[],
): { candidates: AgentEvidenceCandidate[]; filters: Array<{ field: string; value: string }> } {
  const dimensions = new Map<string, { id: string; entityId?: string; definition?: string }>();
  for (const object of objects) {
    if (object.objectType !== 'semantic_dimension') continue;
    const id = firstString(object.payload?.qualifiedId, object.fullName);
    if (!id) continue;
    dimensions.set(normalizeText(object.name), { id, definition: object.description });
    dimensions.set(normalizeDimensionRole(object.name), { id, definition: object.description });
  }
  for (const candidate of candidates) {
    const capability = normalizeMetricCapabilityContract(candidate.analyticalCapability);
    for (const dimension of capability?.dimensions ?? []) {
      const value = { id: dimension.dimensionId, entityId: dimension.entityId };
      dimensions.set(normalizeText(dimension.dimensionId), value);
      dimensions.set(normalizeDimensionRole(dimension.dimensionId), value);
    }
    for (const dimensionId of candidate.dimensions ?? []) {
      if (!/[:./]/.test(dimensionId)) continue;
      const value = { id: dimensionId, entityId: normalizeDimensionRole(dimensionId) };
      dimensions.set(normalizeText(dimensionId), value);
      dimensions.set(normalizeDimensionRole(dimensionId), value);
    }
  }
  const cards: AgentEvidenceCandidate[] = [];
  const filters: Array<{ field: string; value: string }> = [];
  for (const binding of plan.requestedShape.memberBindings ?? []) {
    if (binding.source !== 'prior_result' && binding.source !== 'clarification') continue;
    // A deictic binding used to be discarded outright, which threw away the
    // referent of every "this customer" follow-up and left the turn ungrounded.
    // Cardinality is what matters: exactly one candidate is unambiguous and
    // safe to bind; several must not be fanned into an OR'd filter, and are
    // surfaced as a clarification instead.
    if (binding.confidence === 'deictic' && binding.values.length !== 1) continue;
    const dimension = dimensions.get(normalizeText(binding.dimension))
      ?? dimensions.get(normalizeDimensionRole(binding.dimension));
    if (!dimension) continue;
    for (const value of binding.values) {
      filters.push({ field: dimension.id, value });
      const id = `semantic:member:${encodeURIComponent(dimension.id)}:${encodeURIComponent(normalizeText(value))}`;
      cards.push({
        id,
        qualifiedId: id,
        kind: 'semantic_member',
        trustTier: 'semantic',
        name: value,
        aliases: [value],
        definition: `Trusted ${binding.source.replace('_', ' ')} member for ${dimension.id}.`,
        primaryEntity: dimension.entityId,
        dimensions: [dimension.id],
        relevanceScore: 1,
        matchReasons: [`typed ${binding.source} member binding`],
        compatibility: 'compatible',
        eligible: true,
        exactMatch: true,
      });
    }
  }
  return { candidates: cards, filters };
}

function supplementalClarificationEvidence(
  plan: AnalysisQuestionPlan,
  objects: MetadataObject[],
  existing: AgentEvidenceCandidate[],
): AgentEvidenceCandidate[] {
  const MAX_SUPPLEMENTAL_CANDIDATES = 12;
  const MAX_PER_REQUESTED_ROLE = 3;
  const existingIds = new Set(existing.map((candidate) => candidate.id));
  const requestedMeasures = expandedRequestedTerms(plan.requestedShape.measures, objects);
  const requestedDimensions = expandedRequestedTerms(plan.requestedShape.dimensions, objects);
  const objectCards = objects.flatMap((object) => {
    if (existingIds.has(object.objectKey)) return [];
    if (!['semantic_metric', 'semantic_measure', 'semantic_dimension'].includes(object.objectType)) return [];
    const names = aliasesFor(object).map(normalizeText);
    const role = normalizeDimensionRole(object.name);
    const relevant = object.objectType === 'semantic_metric' || object.objectType === 'semantic_measure'
      ? requestedMeasures.some((term) => names.some((name) => phraseTermsMatch(term, name)))
      : requestedDimensions.some((term) =>
        names.some((name) => phraseTermsMatch(term, name))
        || (isGeographicRole(term) && isGeographicRole(role)));
    if (!relevant) return [];
    const card = candidateCard(object, 'semantic', 1, 1, aliasesFor(object), ['requested clarification capability'], []);
    return [agentCandidateFromMeaning(card)];
  });
  const declaredDimensionCards: AgentEvidenceCandidate[] = existing.flatMap((candidate) =>
    (candidate.dimensions ?? []).flatMap((dimensionId) => {
      if (!/[:./]/.test(dimensionId) || existingIds.has(dimensionId)) return [];
      const role = normalizeDimensionRole(dimensionId);
      const relevant = requestedDimensions.some((term) =>
        phraseTermsMatch(term, role) || (isGeographicRole(term) && isGeographicRole(role)));
      if (!relevant) return [];
      return [{
        id: dimensionId,
        qualifiedId: dimensionId,
        kind: 'semantic_member' as const,
        trustTier: 'semantic' as const,
        name: dimensionId.split(/[.:/]/).at(-1) ?? dimensionId,
        aliases: [role],
        definition: `Modeled ${role} dimension available through ${candidate.name}.`,
        primaryEntity: candidate.primaryEntity,
        dimensions: [dimensionId],
        relevanceScore: candidate.relevanceScore,
        matchReasons: ['requested clarification capability role'],
        compatibility: 'partial' as const,
        eligible: true,
        exactMatch: false,
      }];
    }));
  const unique = [...objectCards, ...declaredDimensionCards]
    .filter((candidate, index, all) => all.findIndex((other) =>
      (other.qualifiedId ?? other.id) === (candidate.qualifiedId ?? candidate.id)) === index);
  const roleLanes = [
    ...requestedDimensions.map((term) => ({ kind: 'dimension' as const, term })),
    ...requestedMeasures.map((term) => ({ kind: 'metric' as const, term })),
  ];
  const selected: AgentEvidenceCandidate[] = [];
  for (const lane of roleLanes) {
    const matches = unique.filter((candidate) => {
      const candidateTerms = [candidate.name, ...(candidate.aliases ?? [])].map(normalizeText);
      if (lane.kind === 'metric') {
        return candidate.kind === 'semantic_metric'
          && candidateTerms.some((term) => phraseTermsMatch(lane.term, term));
      }
      if (candidate.kind !== 'semantic_member') return false;
      return candidateTerms.some((term) => phraseTermsMatch(lane.term, term))
        || (isGeographicRole(lane.term) && candidateTerms.some(isGeographicRole));
    }).sort((left, right) => right.relevanceScore - left.relevanceScore || left.id.localeCompare(right.id));
    for (const candidate of matches.slice(0, MAX_PER_REQUESTED_ROLE)) {
      if (!selected.some((item) => (item.qualifiedId ?? item.id) === (candidate.qualifiedId ?? candidate.id))) {
        selected.push(candidate);
      }
    }
  }
  return selected.slice(0, MAX_SUPPLEMENTAL_CANDIDATES);
}

function expandedRequestedTerms(terms: string[], objects: MetadataObject[]): string[] {
  const vocabulary = new Map<string, Set<string>>();
  for (const object of objects) {
    if (object.objectType !== 'dql_term') continue;
    const words = [object.name, ...stringArray(object.payload?.synonyms)].map(normalizeText).filter(Boolean);
    for (const word of words) {
      const peers = vocabulary.get(word) ?? new Set<string>();
      for (const peer of words) peers.add(peer);
      vocabulary.set(word, peers);
    }
  }
  const expanded = new Set<string>();
  for (const term of terms.map(normalizeText)) {
    expanded.add(term);
    const tokens = term.split(' ');
    tokens.forEach((token, index) => {
      for (const peer of vocabulary.get(token) ?? []) {
        expanded.add(tokens.map((value, tokenIndex) => tokenIndex === index ? peer : value).join(' '));
      }
    });
  }
  return [...expanded];
}

function phraseTermsMatch(left: string, right: string): boolean {
  return left === right || left.endsWith(` ${right}`) || right.endsWith(` ${left}`);
}

function normalizeDimensionRole(value: string): string {
  const leaf = value.split(/[.:/]/).at(-1) ?? value;
  const normalized = normalizeText(leaf);
  if (/^customer(?: name| id| key| label)?$/.test(normalized)) return 'customer';
  if (/^location(?: name| id| key| label)?$/.test(normalized)) return 'location';
  if (/^region(?: name| id| key| label)?$/.test(normalized)) return 'region';
  if (/^product(?: name| id| key| label)?$/.test(normalized)) return 'product';
  return normalized;
}

function dimensionLookupAliases(dimensions: string[]): string[] {
  return uniqueStrings(dimensions.flatMap((dimension) => {
    const leaf = dimension.split(/[.:/]/).at(-1) ?? dimension;
    const role = leaf.replace(/(?:_name|_id|_key|_label)$/i, '');
    return role && role !== leaf ? [dimension, role] : [dimension];
  }));
}

function isGeographicRole(value: string): boolean {
  return /^(?:region|location|geography|territory|market|site|store)$/.test(normalizeDimensionRole(value));
}

/**
 * Bind current-turn values only when an authorized runtime-value observation
 * and a semantic dimension's exact physical table/column identity agree. Text
 * such as "Zoom customer" can nominate the value and dimension, but cannot by
 * itself create an executable member binding.
 *
 * Acceptance: AGT-012, AGT-017.
 */
function groundedMemberFilters(
  plan: AnalysisQuestionPlan,
  candidates: AgentEvidenceCandidate[],
  objects: MetadataObject[],
): Array<{ field: string; value: string }> {
  const mentions = plan.valueMentions.filter(
    (mention) => mention.syntacticRole === "filter_value",
  );
  if (mentions.length === 0) return [];
  const filterDimensions = new Set(
    candidates.flatMap((candidate) => {
      const capability = normalizeMetricCapabilityContract(
        candidate.analyticalCapability,
      );
      return (
        capability?.dimensions
          .filter((dimension) => dimension.supportedRoles.includes("filter"))
          .map((dimension) => dimension.dimensionId) ?? []
      );
    }),
  );
  if (filterDimensions.size === 0) return [];
  const dimensions = objects.flatMap((object) => {
    if (object.objectType !== "semantic_dimension") return [];
    const dimensionId = firstString(
      object.payload?.qualifiedId,
      object.fullName,
    );
    const table = firstString(object.payload?.table);
    const expression = simpleColumnName(
      firstString(object.payload?.expression),
    );
    if (
      !dimensionId ||
      !filterDimensions.has(dimensionId) ||
      !table ||
      !expression
    )
      return [];
    return [{ dimensionId, table, column: expression }];
  });
  const values = objects.flatMap((object) => {
    if (object.objectType !== "runtime_value") return [];
    const relation = firstString(object.payload?.relation);
    const column = firstString(object.payload?.column);
    const value = firstString(object.payload?.value);
    const normalizedValue =
      firstString(object.payload?.normalizedValue) ??
      (value ? normalizeText(value) : undefined);
    if (!relation || !column || !value || !normalizedValue) return [];
    return [{ relation, column, value, normalizedValue }];
  });
  return mentions.flatMap((mention) => {
    const observed = values.filter(
      (value) =>
        normalizeText(value.normalizedValue) ===
        normalizeText(mention.normalizedText),
    );
    const bindings = new Map<string, string>();
    for (const value of observed) {
      for (const dimension of dimensions) {
        if (
          !sameRelation(dimension.table, value.relation) ||
          normalizeIdentifier(dimension.column) !==
            normalizeIdentifier(value.column)
        )
          continue;
        bindings.set(dimension.dimensionId, value.value);
      }
    }
    return bindings.size === 1
      ? [{ field: [...bindings.keys()][0]!, value: [...bindings.values()][0]! }]
      : [];
  });
}

function simpleColumnName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/["`\[\]]/g, "").trim();
  return /^[a-zA-Z_][a-zA-Z0-9_$.]*$/.test(normalized)
    ? normalized.split(".").at(-1)
    : undefined;
}

function sameRelation(left: string, right: string): boolean {
  const a = normalizeRelation(left);
  const b = normalizeRelation(right);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function normalizeRelation(value: string): string {
  return value
    .replace(/["`\[\]]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeIdentifier(value: string): string {
  return (
    value
      .replace(/["`\[\]]/g, "")
      .split(".")
      .at(-1)
      ?.trim()
      .toLowerCase() ?? value.toLowerCase()
  );
}

/**
 * One host-neutral compatibility projection shared by CLI, Browser Ask, MCP,
 * Chat, Notebook, Preview, and Block Studio. Retrieval scores never grant
 * executability; certified fit and semantic shape facts from the same snapshot do.
 * Acceptance: AGT-013, API-003, API-006.
 */
export function applyContextPackCompatibility(
  evidence: AgentRetrievalEvidence,
  pack: LocalContextPack,
  selectedEvidenceId?: string,
): AgentRetrievalEvidence {
  const certifiedFits = new Map(pack.retrievalDiagnostics.certifiedCandidateFits.map((fit) => [fit.objectKey, fit]));
  return {
    ...evidence,
    candidates: evidence.candidates.map((candidate): AgentEvidenceCandidate => {
      if (candidate.kind === 'certified_block') {
        const fit = certifiedFits.get(candidate.id);
        const unrequestedStaticScope = fit?.fit.reasons.some((reason) =>
          reason.startsWith('certified static scope is not requested:')) ?? false;
        const exactAuthoredExample = fit?.action === 'certified_answer'
          && pack.routeDecision.exactObjectKey === candidate.id
          && fit.fit.reasons.includes('question matches a certified example');
        return {
          ...candidate,
          // Lexical equality to a block name/alias is useful retrieval signal,
          // but it is not exact analytical authority. Only the selected block's
          // authored exact-example fit may grant the router shortcut.
          exactMatch: exactAuthoredExample,
          ...(exactAuthoredExample
            ? { analyticalFitClass: 'exact' as const }
            : { analyticalFitClass: undefined }),
          // A statically scoped certified artifact is not an alternative for a
          // broader question. Exclude it before both meaning resolution and
          // identifier-bound clarification; later fit rejection is too late.
          eligible: unrequestedStaticScope ? false : candidate.eligible,
          compatibility: fit?.action === 'certified_answer'
            ? 'compatible'
            : fit?.action === 'rejected_for_fit'
              ? 'incompatible'
              : 'partial',
        };
      }
      if ((candidate.kind === 'semantic_metric' || candidate.kind === 'semantic_member')
        && (Boolean(candidate.analyticalCapability) || selectedEvidenceId === candidate.id)
        && (selectedEvidenceId === candidate.id
          || (pack.routeDecision.route !== 'clarify' && pack.routeDecision.route !== 'conflict'))) {
        const requestedDimensions = pack.questionPlan.requestedShape.dimensions.map((dimension) => normalizeText(dimension));
        const availableDimensions = (candidate.dimensions ?? []).map((dimension) => normalizeText(dimension));
        const dimensionsFit = requestedDimensions.length === 0 || requestedDimensions.every((requested) =>
          availableDimensions.some((available) => available === requested || available.endsWith(` ${requested}`))
        );
        const requestedTimeGrain = analysisTimeGrain(pack.questionPlan);
        const availableTimeGrains = (candidate.timeGrains ?? []).map((grain) => grain.toLowerCase());
        const timeGrainFits = !requestedTimeGrain || availableTimeGrains.includes(requestedTimeGrain);
        const requestedMeasures = pack.questionPlan.requestedShape.measures.map((measure) => normalizeText(measure));
        const metricPhrases = [candidate.name, ...(candidate.aliases ?? [])].map((value) => normalizeText(value));
        const measuresFit = requestedMeasures.length === 0 || requestedMeasures.every((measure) =>
          metricPhrases.some((phrase) => phrase === measure || phrase.includes(measure))
        );
        return { ...candidate, compatibility: dimensionsFit && timeGrainFits && measuresFit ? 'compatible' : 'partial' };
      }
      if (candidate.trustTier === 'governed_sql') return { ...candidate, compatibility: 'partial' };
      return candidate;
    }),
  };
}

function analysisTimeGrain(plan: AnalysisQuestionPlan): string | undefined {
  return plan.timeTerms
    .map((term) => normalizeText(term))
    .find((term) => ANALYTICAL_TIME_GRAINS.has(term));
}

function semanticExecutionPriority(object: MetadataObject): number {
  if (object.objectType === 'semantic_metric') return 0;
  if (object.objectType === 'semantic_measure') return 1;
  return 2;
}

function evidenceClassFor(object: MetadataObject): MetadataEvidenceClass | undefined {
  if (object.objectType === 'dql_block' && object.status === 'certified') return 'certified';
  if (object.objectType.startsWith('semantic_')) return 'semantic';
  if (
    object.objectType === 'dql_entity'
    || object.objectType === 'relationship'
    || object.objectType === 'contract'
    || object.objectType === 'model_area'
    || object.objectType.startsWith('dbt_')
    || object.objectType.startsWith('warehouse_')
    || object.objectType.startsWith('runtime_')
  ) return 'sql';
  return undefined;
}

function trustTierFor(object: MetadataObject, evidenceClass: MetadataEvidenceClass): MetadataEvidenceTrust {
  if (evidenceClass === 'certified') return 'certified';
  if (evidenceClass === 'semantic') return 'semantic';
  if (['dql_entity', 'relationship', 'contract'].includes(object.objectType)) return 'governed_sql';
  return 'exploratory';
}

function candidateCard(
  object: MetadataObject,
  evidenceClass: MetadataEvidenceClass,
  classRank: number,
  relevanceScore: number,
  aliases: string[],
  relevanceReasons: string[],
  ambiguityPeerIds: string[],
): MetadataMeaningCandidate {
  const payload = object.payload ?? {};
  const analyticalCapability = normalizeMetricCapabilityContract(
    payload.analyticalCapability,
  );
  const qualifiedId =
    firstString(
      payload.qualifiedId,
      payload.uniqueId,
      object.fullName,
      object.objectKey,
    ) ?? object.objectKey;
  const parameters = arrayNames(payload.parameters ?? payload.parameterPolicy);
  const outputs = uniqueStrings([
    ...stringArray(payload.declaredOutputs),
    ...arrayNames(payload.outputContract),
    ...arrayNames(payload.outputs),
  ]);
  const compatibilityFacts = uniqueStrings([
    firstString(payload.grain) ? `grain: ${firstString(payload.grain)}` : '',
    ...stringArray(payload.dimensions).slice(0, 8).map((value) => `dimension: ${value}`),
    ...parameters.slice(0, 8).map((value) => `parameter: ${value}`),
    ...stringArray(payload.allowedFilters).slice(0, 8).map((value) => `filter: ${value}`),
    ...outputs.slice(0, 8).map((value) => `output: ${value}`),
  ]).slice(0, 16);
  return {
    objectKey: object.objectKey,
    qualifiedId,
    evidenceClass,
    trustTier: trustTierFor(object, evidenceClass),
    classRank,
    relevanceScore,
    name: object.name,
    aliases,
    objectType: object.objectType,
    domain: object.domain,
    status: object.status,
    definition: truncate(firstString(object.description, payload.description, payload.llmContext), 640),
    formula: evidenceClass === 'semantic'
      ? truncate(firstString(payload.formula, payload.expr, payload.sql), 320)
      : undefined,
    semanticModel: firstString(payload.semanticModel, payload.cube),
    relevanceReasons,
    compatibilityFacts,
    businessShape: {
      aggregation: firstString(payload.aggregation, payload.agg, payload.metricType),
      grain: firstString(payload.grain),
      entities: stringArray(payload.entities).slice(0, 12),
      dimensions: stringArray(payload.dimensions).slice(0, 16),
      timeGrains: uniqueStrings([
        ...stringArray(payload.timeGrains),
        ...stringArray(payload.supportedTimeGrains),
      ]).slice(0, 8),
      parameters: parameters.slice(0, 12),
      filters: stringArray(payload.allowedFilters).slice(0, 12),
      outputs: outputs.slice(0, 16),
      sourceRelations: uniqueStrings([
        firstString(payload.relation, payload.table) ?? '',
        ...stringArray(payload.tableDependencies),
        ...stringArray(payload.sourceSystems),
      ]).slice(0, 12),
    },
    ...(analyticalCapability ? { analyticalCapability } : {}),
    provenance: firstString(payload.provenance, object.sourceSystem),
    ambiguityPeerIds,
  };
}

function agentEvidenceKind(candidate: MetadataMeaningCandidate): AgentEvidenceKind {
  if (candidate.evidenceClass === 'certified') return 'certified_block';
  if (candidate.objectType === 'semantic_metric') return 'semantic_metric';
  if (candidate.evidenceClass === 'semantic') return 'semantic_member';
  if (['dql_entity', 'relationship', 'contract', 'model_area'].includes(candidate.objectType)) return 'dql_modeling';
  if (candidate.objectType === 'dbt_model') return 'dbt_model';
  if (candidate.objectType === 'dbt_source') return 'dbt_source';
  if (candidate.objectType.endsWith('_column')) return 'sql_column';
  return 'sql_table';
}

function semanticObjectType(
  objectType: string,
): AgentEvidenceCandidate['semanticObjectType'] | undefined {
  if (objectType === 'semantic_metric') return 'metric';
  if (objectType === 'semantic_measure') return 'measure';
  if (objectType === 'semantic_dimension') return 'dimension';
  if (objectType === 'semantic_entity') return 'entity';
  if (objectType === 'semantic_model') return 'model';
  if (objectType === 'semantic_saved_query') return 'saved_query';
  return undefined;
}

function aliasesFor(object: MetadataObject): string[] {
  const payload = object.payload ?? {};
  return uniqueStrings([
    object.name,
    object.name.split('.').at(-1) ?? object.name,
    object.fullName ?? '',
    firstString(payload.localId) ?? '',
    firstString(payload.label) ?? '',
    ...stringArray(payload.aliases),
    ...stringArray(payload.synonyms),
    ...stringArray(payload.tags),
  ]).slice(0, 12);
}

function lexicalRelevance(
  normalizedQuestion: string,
  questionTokens: Set<string>,
  object: MetadataObject,
  aliases: string[],
): { score: number; reasons: string[] } {
  const normalizedAliases = aliases.map(normalizeText).filter(Boolean);
  const reasons: string[] = [];
  let score = 0;
  if (normalizedAliases.some((alias) => isExactAnalyticalPhrase(normalizedQuestion, alias))) {
    score += 80;
    reasons.push('exact name or alias');
  } else if (normalizedAliases.some((alias) => alias.length >= 3 && normalizedQuestion.includes(alias))) {
    score += 52;
    reasons.push('complete name or alias phrase');
  }
  const searchableTokens = tokenSet(normalizeText([...aliases, object.description ?? ''].join(' ')));
  const shared = [...questionTokens].filter((token) => searchableTokens.has(token));
  if (questionTokens.size > 0 && shared.length > 0) {
    score += (shared.length / questionTokens.size) * 44;
    reasons.push(`${shared.length}/${questionTokens.size} question terms matched`);
  }
  return { score, reasons };
}

function buildAmbiguityPeers(candidates: Array<{ objectKey: string; aliases: string[] }>): Map<string, string[]> {
  const peers = new Map<string, Set<string>>();
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex]!;
    const leftTokens = meaningTokens(left.aliases);
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex]!;
      const rightTokens = meaningTokens(right.aliases);
      const shared = [...leftTokens].filter((token) => rightTokens.has(token));
      const overlap = Math.min(leftTokens.size, rightTokens.size) > 0
        ? shared.length / Math.min(leftTokens.size, rightTokens.size)
        : 0;
      const exactAlias = left.aliases.some((leftAlias) =>
        right.aliases.some((rightAlias) => normalizeText(leftAlias) === normalizeText(rightAlias)));
      if (!exactAlias && (shared.length === 0 || overlap < 0.5)) continue;
      addPeer(peers, left.objectKey, right.objectKey);
      addPeer(peers, right.objectKey, left.objectKey);
    }
  }
  return new Map([...peers.entries()].map(([key, values]) => [key, [...values].sort()]));
}

function ambiguityGroups(peerMap: Map<string, string[]>): MetadataMeaningEvidencePackage['ambiguousGroups'] {
  const groups = new Map<string, string[]>();
  for (const [candidateId, peers] of peerMap) {
    const ids = [candidateId, ...peers].sort();
    groups.set(ids.join('\u0000'), ids);
  }
  return [...groups.values()].map((candidateIds) => ({
    candidateIds,
    reason: 'Candidates share the same alias or materially overlapping business-meaning terms.',
  }));
}

function meaningTokens(aliases: string[]): Set<string> {
  return new Set(aliases.flatMap((alias) => [...tokenSet(normalizeText(alias))])
    .filter((token) => !GENERIC_MEANING_TOKENS.has(token)));
}

function addPeer(peers: Map<string, Set<string>>, key: string, peer: string): void {
  const values = peers.get(key) ?? new Set<string>();
  values.add(peer);
  peers.set(key, values);
}

function normalizeText(value: string): string {
  return value.toLowerCase()
    .replace(/%/g, ' percentage ')
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isExactAnalyticalPhrase(question: string, alias: string): boolean {
  if (!alias) return false;
  if (alias === question) return true;
  const index = question.indexOf(alias);
  if (index < 0) return false;
  const remaining = `${question.slice(0, index)} ${question.slice(index + alias.length)}`
    .replace(/\s+/g, ' ')
    .trim();
  return remaining.length === 0 || remaining.split(' ').every((token) =>
    ['a', 'an', 'are', 'can', 'could', 'do', 'does', 'for', 'give', 'is', 'me', 'of', 'please', 'show', 'tell', 'the', 'what', 'which'].includes(token));
}

function tokenSet(value: string): Set<string> {
  return new Set(value.split(/\s+/).filter((token) => token.length >= 2));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : [];
}

function arrayNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) return [item];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const name = firstString(row.name, row.id, row.filter);
    return name ? [name] : [];
  });
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function truncate(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function roundScore(value: number): number {
  return Number(Math.max(0, value).toFixed(3));
}
