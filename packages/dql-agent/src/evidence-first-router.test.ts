import { describe, expect, it, vi } from "vitest";
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerAnywayRoute, selectRoute, type AgentRunRequest } from "./agent-run-engine.js";
import type {
  AgentEvidenceCandidate,
  AgentRelationshipSafetyEvidence,
  AgentRetrievalEvidence,
  MeaningResolution,
} from "./meaning-resolution.js";
import { collapseRedundantGovernedCandidates, createHybridRouter } from "./router.js";
import { attachAskTraceObserverV1, type AskTraceObserverV1 } from './ask-observability/index.js';
import { buildAnalysisQuestionPlan } from './metadata/analysis-planner.js';
import { applyContextPackCompatibility, buildLocalContextPack, toAgentRetrievalEvidence } from './metadata/catalog.js';
import {
  buildAnalyticalRequirementSet,
  type AnalyticalRequirementSetV1,
} from './analytical-orchestration.js';

const jaffleSemanticFixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../apps/cli/test/fixtures/jaffle-semantic',
);
const jaffleSupplyChainFixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../apps/cli/test/fixtures/jaffle-supply-chain',
);
const askObservabilityOfficeFixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../apps/cli/test/fixtures/ask-observability-office',
);

const request = (question: string): AgentRunRequest => ({ question });

function candidateTraceObserver() {
  const decisions: Array<Record<string, unknown>> = [];
  const spans: Array<Record<string, unknown>> = [];
  const observer = {
    enabled: true,
    recordingStatus: 'recording',
    startSpan: (span: Record<string, unknown>) => {
      spans.push(span);
      return '1111111111111111';
    },
    finishSpan: () => {},
    recordCandidateDecision: (decision: Record<string, unknown>) => decisions.push(decision),
    recordLink: () => {},
    finalize: () => undefined,
    markPartial: () => {},
    reference: () => undefined,
  } as unknown as AskTraceObserverV1;
  return { observer, decisions, spans };
}

function candidate(overrides: Partial<AgentEvidenceCandidate> = {}): AgentEvidenceCandidate {
  return {
    id: "semantic:consumption:rollover_balance_amount",
    kind: "semantic_metric",
    trustTier: "semantic",
    name: "Rollover Balance Amount",
    aliases: ["rollover_balance_amount"],
    definition: "Remaining eligible balance carried into the next month.",
    dimensions: ["customer", "month"],
    timeGrains: ["month"],
    relevanceScore: 0.95,
    matchReasons: ["phrase match"],
    compatibility: "compatible",
    ...overrides,
  };
}

function evidence(candidates: AgentEvidenceCandidate[]): AgentRetrievalEvidence {
  return {
    snapshotId: "snapshot-1",
    sourceFingerprint: "fingerprint-1",
    candidates,
    parsedIntent: { measures: ["rollover balance amount"], dimensions: ["customer"], timeGrain: "month", order: "desc", limit: 10 },
  };
}

/**
 * A real clarification click is a server-issued continuation, not arbitrary
 * client identity input. Keep direct-router tests on the same bound envelope
 * that local-runtime reconstructs from the conversation store.
 */
function serverIssuedSelectionRequest(input: {
  question: string;
  selectedEvidenceId: string;
  snapshotId?: string;
  optionIds?: string[];
  requirements?: AnalyticalRequirementSetV1;
  threadId?: string;
  sourceTurnId?: string;
}): AgentRunRequest {
  const threadId = input.threadId ?? 'thread-router-selection';
  const sourceTurnId = input.sourceTurnId ?? 'turn-router-clarification';
  const snapshotId = input.snapshotId ?? 'snapshot-1';
  const optionIds = input.optionIds ?? [input.selectedEvidenceId];
  const requirements = input.requirements ?? {
    version: 1 as const,
    measures: [],
    dimensions: [],
    entityTerms: [],
    entityDisplayTerms: [],
    memberTerms: [],
  };
  return {
    question: input.question,
    selectedEvidenceId: input.selectedEvidenceId,
    clarificationSourceQuestion: input.question,
    threadId,
    conversationContext: {
      conversationEnvelope: {
        version: 1,
        threadId,
        recentTurns: [],
        pendingClarification: {
          sourceTurnId,
          sourceQuestion: input.question,
          question: 'Which compatible governed meaning should DQL use?',
          selection: {
            version: 1,
            optionIds,
            ambiguityCandidateIds: optionIds,
            requirements,
            snapshotId,
          },
        },
      },
      // Local-runtime injects this after loading the persisted thread. A
      // direct router test must model that host-only boundary explicitly.
      serverIssuedClarificationSelection: {
        version: 1,
        threadId,
        sourceTurnId,
        snapshotId,
      },
    },
  };
}

function jaffleMetric(
  id: string,
  name: string,
  aliases: string[],
  exactMatch: boolean,
  compatibility: AgentEvidenceCandidate['compatibility'] = 'compatible',
): AgentEvidenceCandidate {
  return candidate({
    id,
    qualifiedId: id,
    kind: 'semantic_metric',
    trustTier: 'semantic',
    name,
    aliases,
    dimensions: ['semantic:dimension:customer'],
    exactMatch,
    relevanceScore: exactMatch ? 1 : 0.9,
    compatibility,
    analyticalCapability: {
      metricId: id,
      measureIds: [`${id}:measure`],
      primaryEntityId: 'order',
      defaultResultGrainId: 'scalar',
      resultGrainIds: ['scalar', 'customer'],
      aggregation: name.endsWith('_pct') ? 'ratio' : 'sum',
      additivity: { entities: 'additive', time: 'additive' },
      dimensions: [{
        dimensionId: 'semantic:dimension:customer',
        entityId: 'customer',
        supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
        relationshipPathIds: ['relationship:order_to_customer'],
        // This fixture represents a real semantic traversal, not a generic
        // DQL relationship that MetricFlow could not compile after freeze.
        nativeGroupingReference: 'order__customer',
        nativeGroupingPath: ['order'],
      }],
      timeDimensions: [],
      operations: ['filter', 'group', 'rank'],
      supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
      executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
      sourceFingerprint: `sha256:${id.replace(/[^a-z0-9]/gi, '')}`,
    },
  });
}

/**
 * Tests that assert a frozen semantic execution must model the same minimum
 * typed capability that production semantic indexing provides. A bare
 * retrieval card is useful for ambiguity tests, but cannot prove a semantic
 * compiler tuple.
 */
function executableSemanticCandidate(
  overrides: Partial<AgentEvidenceCandidate> = {},
): AgentEvidenceCandidate {
  const id = overrides.qualifiedId ?? overrides.id ?? 'semantic:consumption:rollover_balance_amount';
  return candidate({
    ...overrides,
    id: overrides.id ?? id,
    qualifiedId: overrides.qualifiedId ?? id,
    kind: overrides.kind ?? 'semantic_metric',
    trustTier: overrides.trustTier ?? 'semantic',
    analyticalCapability: overrides.analyticalCapability ?? {
      metricId: id,
      semanticModelId: 'semantic:consumption:model:customer_usage',
      measureIds: [`${id}:measure`],
      primaryEntityId: 'semantic:consumption:entity:customer',
      defaultResultGrainId: 'semantic:consumption:entity:customer',
      resultGrainIds: ['semantic:consumption:entity:customer'],
      aggregation: 'sum',
      additivity: { entities: 'additive', time: 'additive' },
      dimensions: [{
        dimensionId: 'semantic:consumption:dimension:customer',
        entityId: 'semantic:consumption:entity:customer',
        label: 'Customer',
        aliases: ['customer', 'customers'],
        supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
      }],
      timeDimensions: [{
        dimensionId: 'semantic:consumption:dimension:customer_usage.report_date',
        role: 'event_time',
        supportedGrains: ['day', 'month', 'year'],
      }],
      operations: ['filter', 'group', 'rank'],
      supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
      executionCapabilities: [{ route: 'semantic', adapterId: 'fixture-semantic' }],
      sourceFingerprint: `sha256:${id.replace(/[^a-z0-9]/gi, '')}:typed-fixture`,
    },
  });
}

function resolved(overrides: Partial<MeaningResolution> = {}): MeaningResolution {
  return {
    interpretedQuestion: "Rank customers by actual monthly rollover balance",
    questionType: "ranking",
    selectedConceptIds: ["semantic:consumption:rollover_balance_amount"],
    recommendedExecutionId: "semantic:consumption:rollover_balance_amount",
    queryIntent: { measures: ["semantic:consumption:rollover_balance_amount"], dimensions: ["customer"], filters: [], timeGrain: "month", order: "desc", limit: 10 },
    rejectedCandidates: [],
    confidence: "high",
    missingInformation: [],
    recommendedRoute: "semantic",
    ...overrides,
  };
}

function clarifyingRanking(overrides: Partial<MeaningResolution> = {}): MeaningResolution {
  return resolved({
    interpretedQuestion: 'The ranking measure is not specified.',
    questionType: 'ranking',
    selectedConceptIds: [],
    recommendedExecutionId: undefined,
    queryIntent: { measures: [], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
    confidence: 'low',
    missingInformation: ['Top by which governed metric?'],
    recommendedRoute: 'clarify',
    compatibilityOutcome: 'clarify',
    ...overrides,
  });
}

function automaticRelationshipProof(
  id: string,
  overrides: Partial<AgentRelationshipSafetyEvidence> = {},
): AgentRelationshipSafetyEvidence {
  return {
    id,
    from: 'commerce::entity::order_items',
    to: 'commerce::entity::supplies',
    keys: [{ from: 'product_id', to: 'product_id' }],
    status: 'certified',
    cardinality: 'many_to_one',
    fanout: 'safe',
    staleCertification: false,
    automaticJoinAllowed: true,
    certificationFingerprint: 'sha256:certified-product-supply-proof',
    validation: {
      status: 'passed',
      checkedAt: '2026-08-20T00:00:00.000Z',
      queryFingerprint: 'sha256:product-supply-query',
      proofFingerprint: 'sha256:product-supply-validation',
    },
    ...overrides,
  };
}

function perishableSuppliesCompositionCandidates(
  relationship: AgentRelationshipSafetyEvidence | undefined,
  endpoints: {
    display: string;
    predicate: string;
  } = {
    display: 'commerce::entity::order_items',
    predicate: 'commerce::entity::supplies',
  },
): AgentEvidenceCandidate[] {
  const relationshipId = relationship?.id ?? 'dql:relationship:product_supply_lookup';
  const raw = (
    id: string,
    name: string,
    kind: AgentEvidenceCandidate['kind'],
    sourceObjects: string[],
    relationshipEvidence?: string[],
    relationshipSafety?: AgentRelationshipSafetyEvidence[],
  ): AgentEvidenceCandidate => candidate({
    id,
    qualifiedId: id,
    kind,
    trustTier: kind === 'dql_modeling' ? 'governed_sql' : 'exploratory',
    name,
    aliases: [name],
    sourceObjects,
    relationshipEvidence,
    relationshipSafety,
    dimensions: [],
    timeGrains: [],
    relevanceScore: 0.95,
    compatibility: 'unknown',
  });
  const relationshipEvidence = relationship ? [relationshipId] : undefined;
  const relationshipSafety = relationship ? [relationship] : undefined;
  return [
    {
      ...raw('dbt:model:order_items', 'order_items', 'dbt_model', ['runtime:relation:order_items'], relationshipEvidence, relationshipSafety),
      relationshipEndpointIds: [endpoints.display],
    },
    {
      ...raw('dbt:model:supplies', 'supplies', 'dbt_model', ['runtime:relation:supplies'], relationshipEvidence, relationshipSafety),
      relationshipEndpointIds: [endpoints.predicate],
    },
    raw('dbt:column:order_items.product_id', 'product_id', 'sql_column', ['runtime:relation:order_items']),
    raw('dbt:column:supplies.product_id', 'product_id', 'sql_column', ['runtime:relation:supplies']),
    raw('dbt:column:order_items.product_name', 'product_name', 'sql_column', ['runtime:relation:order_items']),
    raw('dbt:column:supplies.is_perishable_supply', 'is_perishable_supply', 'sql_column', ['runtime:relation:supplies']),
    raw(relationshipId, 'order_items product_id to supplies product_id', 'dql_modeling', [], relationshipEvidence, relationshipSafety),
    { ...raw('block:top_products', 'top_products', 'certified_block', [], undefined), compatibility: 'partial' },
  ];
}

describe("AGT-009/AGT-010 evidence-first hybrid routing", () => {
  it.each([
    {
      question: 'what is the food revenue percentage?',
      parsedIntent: { measures: ['food revenue percentage'], dimensions: [], filters: [] },
      selectedId: 'semantic:metric:order_item.food_revenue_pct',
      rejectedId: 'semantic:metric:revenue_growth_mom',
      candidates: [
        jaffleMetric('semantic:metric:order_item.food_revenue_pct', 'order_item.food_revenue_pct', ['food revenue percentage', 'food_revenue_pct'], true),
        jaffleMetric('semantic:metric:revenue_growth_mom', 'revenue_growth_mom', ['revenue growth'], false, 'incompatible'),
      ],
    },
    {
      question: 'what is the food revenue by customers?',
      parsedIntent: { measures: ['food revenue'], dimensions: ['customer'], filters: [] },
      selectedId: 'semantic:metric:order_item.food_revenue',
      rejectedId: 'block:customer_profile',
      candidates: [
        jaffleMetric('semantic:metric:order_item.food_revenue', 'order_item.food_revenue', ['food revenue'], true),
        candidate({
          id: 'block:customer_profile', kind: 'certified_block', trustTier: 'certified', name: 'customer_profile',
          aliases: ['customer profile'], dimensions: ['customer'], exactMatch: false,
          relevanceScore: 0.92, compatibility: 'incompatible', compatibilityFacts: ['missing food revenue measure'],
        }),
      ],
    },
    {
      question: 'who are the top customers by revenue',
      parsedIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [], order: 'desc' as const, limit: 10 },
      selectedId: 'semantic:metric:order.total_revenue',
      rejectedId: 'block:top_beverage_customers',
      candidates: [
        jaffleMetric('semantic:metric:order.total_revenue', 'order.total_revenue', ['total revenue', 'revenue'], true),
        candidate({
          id: 'block:top_beverage_customers', kind: 'certified_block', trustTier: 'certified', name: 'top_beverage_customers',
          aliases: ['top customers by revenue'], dimensions: ['customer'], exactMatch: false,
          relevanceScore: 0.99, compatibility: 'incompatible', compatibilityFacts: ['beverage filter was not requested'],
        }),
      ],
    },
    {
      question: 'who are the top customers have a highest revenue',
      parsedIntent: { measures: ['total revenue'], dimensions: ['customer'], filters: [], order: 'desc' as const, limit: 10 },
      selectedId: 'semantic:metric:order.total_revenue',
      rejectedId: 'block:top_beverage_customers',
      candidates: [
        jaffleMetric('semantic:metric:order.total_revenue', 'order.total_revenue', ['total revenue', 'revenue'], true),
        candidate({
          id: 'block:top_beverage_customers', kind: 'certified_block', trustTier: 'certified', name: 'top_beverage_customers',
          aliases: ['top customers', 'highest revenue'], dimensions: ['customer'], exactMatch: false,
          relevanceScore: 0.96, compatibility: 'incompatible', compatibilityFacts: ['beverage filter was not requested'],
        }),
      ],
    },
    {
      question: 'who are the customers with the explicit highest beverage revenue?',
      parsedIntent: { measures: ['beverage revenue'], dimensions: ['customer'], filters: [{ field: 'category', value: 'beverage' }], order: 'desc' as const, limit: 10 },
      selectedId: 'block:top_beverage_customers',
      rejectedId: 'semantic:metric:order.total_revenue',
      candidates: [
        candidate({
          id: 'block:top_beverage_customers', kind: 'certified_block', trustTier: 'certified', name: 'top_beverage_customers',
          aliases: ['highest beverage revenue'], dimensions: ['customer', 'category'], exactMatch: true,
          relevanceScore: 1, compatibility: 'compatible', compatibilityFacts: ['output: customer_name', 'output: beverage_revenue'],
        }),
        jaffleMetric('semantic:metric:order.total_revenue', 'order.total_revenue', ['total revenue'], false, 'incompatible'),
      ],
    },
  ])('jaffle golden: $question freezes the compatible identity, never the lexical decoy', async ({ question, parsedIntent, selectedId, rejectedId, candidates }) => {
    const resolveMeaning = vi.fn(async ({ candidates, evidence }: { candidates: AgentEvidenceCandidate[]; evidence: AgentRetrievalEvidence }) => {
      const selected = candidates.find((item) => item.compatibility !== 'incompatible') ?? candidates[0];
      return resolved({
        interpretedQuestion: question,
        selectedConceptIds: selected ? [selected.id] : [],
        recommendedExecutionId: selected?.id,
        queryIntent: {
          measures: evidence.parsedIntent?.measures ?? (selected ? [selected.name] : []),
          dimensions: evidence.parsedIntent?.dimensions ?? [],
          filters: evidence.parsedIntent?.filters ?? [],
          order: evidence.parsedIntent?.order,
          limit: evidence.parsedIntent?.limit,
        },
        recommendedRoute: selected?.kind === 'certified_block' ? 'certified' : 'semantic',
      });
    });
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-jaffle-goldens',
        sourceFingerprint: 'sha256:jaffle-goldens',
        candidates,
        parsedIntent,
      }),
    });

    const decision = await router.decide(request(question));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision.resolvedAnalyticalPlan).toMatchObject({
      mode: 'authoritative',
      selectedConceptIds: expect.arrayContaining([selectedId]),
    });
    expect(
      decision.resolvedAnalyticalPlan?.capability,
      JSON.stringify({
        question,
        route: decision.resolvedAnalyticalPlan?.recommendedRoute,
        missing: decision.resolvedAnalyticalPlan?.missingInformation,
        frame: decision.resolvedAnalyticalPlan?.analyticalFrame,
        meaning: decision.meaningResolution,
        selectedCandidate: candidates.find((candidate) => candidate.id === selectedId)?.analyticalCapability,
        query: decision.resolvedAnalyticalPlan?.query,
      }),
    ).not.toBe('blocked');
    expect(decision.resolvedAnalyticalPlan?.selectedConceptIds).not.toContain(rejectedId);
  });

  it('freezes the actual parsed customer-revenue ranking without treating the sort metric as grain', async () => {
    const question = 'who are the top customers by revenue';
    const parsed = buildAnalysisQuestionPlan(question);
    const revenue = jaffleMetric(
      'semantic:metric:order_item.revenue',
      'order_item.revenue',
      ['revenue'],
      true,
    );
    revenue.analyticalCapability = {
      ...revenue.analyticalCapability!,
      executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow-cli' }],
      dimensions: [{
        dimensionId: 'semantic:uncategorized:dimension:customers.customer_name',
        entityId: 'customer',
        label: 'Customer name',
        aliases: ['customer'],
        supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
        nativeGroupingReference: 'order_id__customer__customer_name',
        nativeGroupingPath: ['order_id', 'customer'],
      }, {
        dimensionId: 'semantic:uncategorized:dimension:customers.customer_type',
        entityId: 'customer',
        label: 'Customer type',
        aliases: ['customer'],
        supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
        nativeGroupingReference: 'order_id__customer__customer_type',
        nativeGroupingPath: ['order_id', 'customer'],
      }, {
        dimensionId: 'semantic:uncategorized:dimension:customers.customer_order_number',
        entityId: 'customer',
        label: 'Customer order number',
        aliases: ['customer'],
        supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
        nativeGroupingReference: 'order_id__customer__customer_order_number',
        nativeGroupingPath: ['order_id', 'customer'],
      }],
    };
    const rawCustomerDimensions = revenue.analyticalCapability.dimensions.map((dimension) => candidate({
      id: dimension.dimensionId,
      qualifiedId: dimension.dimensionId,
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: dimension.label!,
      aliases: dimension.aliases,
      compatibility: 'compatible',
      relevanceScore: 0.8,
    }));
    const resolveMeaning = vi.fn(async () => {
      throw new Error('meaning resolver unavailable after the bounded call');
    });
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-jaffle-actual-parser',
        sourceFingerprint: 'sha256:jaffle-actual-parser',
        candidates: [revenue, ...rawCustomerDimensions],
        parsedIntent: {
          measures: parsed.requestedShape.measures,
          dimensions: parsed.requestedShape.dimensions,
          filters: [],
          order: parsed.requestedShape.rankingDirection === 'bottom' ? 'asc' : 'desc',
          limit: parsed.requestedShape.topN?.n ?? 10,
        },
      }),
    });

    const decision = await router.decide(request(question));

    expect(parsed.metricTerms).toEqual(['revenue']);
    expect(parsed.dimensionTerms).toEqual(['customer']);
    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(selectRoute(request(question), decision)).toBe('semantic_answer');
    expect(decision.resolvedAnalyticalPlan).toMatchObject({
      mode: 'authoritative',
      selectedConceptIds: [revenue.id],
      query: {
        measures: [expect.objectContaining({ qualifiedId: revenue.id })],
        dimensions: [expect.objectContaining({ requested: 'customer name' })],
        order: 'desc',
        limit: 10,
      },
      relationshipPathIds: [],
      relationshipProofs: [expect.objectContaining({
        kind: 'semantic_native_grouping',
        dimensionId: 'semantic:uncategorized:dimension:customers.customer_name',
        nativeGroupingReference: 'order_id__customer__customer_name',
        nativeGroupingPath: ['order_id', 'customer'],
        route: 'semantic',
        adapterId: 'metricflow-cli',
        snapshotId: 'snapshot-jaffle-actual-parser',
        capabilityFingerprint: revenue.analyticalCapability!.sourceFingerprint,
        authorityFingerprint: expect.any(String),
      })],
      analyticalFrame: {
        dimensions: expect.arrayContaining([
          expect.objectContaining({
            dimensionId: 'semantic:uncategorized:dimension:customers.customer_name',
            role: 'group_by',
          }),
        ]),
        ambiguity: [],
      },
    });
    expect(decision.resolvedAnalyticalPlan?.analyticalFrame?.dimensions
      .some((dimension) => /customer_(?:type|order_number)$/.test(dimension.dimensionId))).toBe(false);
  });

  it('jaffle golden preserves both measures and the canonical Joy Lam member for typo input', async () => {
    const food = jaffleMetric('semantic:metric:order.total_revenue', 'order.total_revenue', ['total revenue'], true);
    const beverage = jaffleMetric('semantic:metric:order.beverage_revenue', 'order.beverage_revenue', ['beverage revenue'], true);
    const joy: AgentEvidenceCandidate = candidate({
      id: 'semantic:member:customer.joy_lam',
      qualifiedId: 'semantic:member:customer.joy_lam',
      kind: 'semantic_member',
      trustTier: 'semantic',
      name: 'Joy Lam',
      aliases: ['Joy ram'],
      exactMatch: false,
      relevanceScore: 0.99,
      compatibility: 'compatible',
    });
    const resolveMeaning = vi.fn(async () => ({
      interpretedQuestion: 'Total revenue and beverage revenue for Joy Lam in West.',
      questionType: 'value' as const,
      selectedConceptIds: [food.id, beverage.id, joy.id],
      recommendedExecutionId: food.id,
      queryIntent: {
        measures: ['total revenue', 'beverage revenue'],
        dimensions: ['customer'],
        filters: [{ field: 'customer', value: 'Joy Lam' }, { field: 'region', value: 'West' }],
      },
      rejectedCandidates: [],
      confidence: 'high' as const,
      missingInformation: [],
      recommendedRoute: 'semantic' as const,
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-jaffle-joy',
        sourceFingerprint: 'sha256:jaffle-joy',
        candidates: [food, beverage, joy],
        parsedIntent: {
          measures: ['total revenue', 'beverage revenue'],
          dimensions: ['customer'],
          filters: [{ field: 'customer', value: 'Joy ram' }, { field: 'region', value: 'West' }],
        },
      }),
    });

    const decision = await router.decide(request('Joy ram in West total revenue and beverage revenue'));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision.resolvedAnalyticalPlan?.selectedConceptIds).toEqual(expect.arrayContaining([food.id, beverage.id, joy.id]));
    expect(decision.resolvedAnalyticalPlan?.query.measures.map((measure) => measure.qualifiedId)).toEqual(expect.arrayContaining([food.id, beverage.id]));
    expect(decision.resolvedAnalyticalPlan?.query.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'Joy Lam' }),
      expect.objectContaining({ value: 'West' }),
    ]));
  });

  it('AGT-009/012 reconciles the exact reported phrase after one meaning call without a generic blocked outcome', async () => {
    const revenue = jaffleMetric('semantic:metric:order_item.revenue', 'order_item.revenue', ['revenue'], false);
    const genericCustomer = candidate({
      id: 'semantic:commerce:member:customer',
      qualifiedId: 'semantic:commerce:member:customer',
      kind: 'semantic_member',
      trustTier: 'semantic',
      name: 'customer',
      aliases: ['customers'],
      compatibility: 'compatible',
      relevanceScore: 0.97,
    });
    const beverageBlock = candidate({
      id: 'block:top_beverage_customers',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'top_beverage_customers',
      compatibility: 'incompatible',
      compatibilityFacts: ['beverage filter was not requested'],
      relevanceScore: 0.96,
    });
    const resolveMeaning = vi.fn(async () => resolved({
      interpretedQuestion: 'Rank customers by revenue.',
      selectedConceptIds: [revenue.id, genericCustomer.id],
      recommendedExecutionId: revenue.id,
      queryIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
      recommendedRoute: 'semantic',
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-exact-reported-phrase',
        sourceFingerprint: 'sha256:exact-reported-phrase',
        parsedIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
        candidates: [revenue, genericCustomer, beverageBlock],
      }),
    });

    const decision = await router.decide(request('who are the top customers have a highest revenue'));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({ action: 'answer', requiresClarification: false });
    expect(decision.reason).not.toMatch(/generic|blocked/i);
    expect(decision.resolvedAnalyticalPlan).toMatchObject({
      capability: 'semantic_execution',
      selectedConceptIds: expect.arrayContaining([revenue.id]),
      query: {
        dimensions: [{
          requested: 'customer name',
          qualifiedId: 'semantic:dimension:customer',
          status: 'resolved',
          candidateIds: ['semantic:dimension:customer'],
        }],
      },
    });
    expect(decision.resolvedAnalyticalPlan?.selectedConceptIds).not.toContain(beverageBlock.id);
    expect(selectRoute(request('who are the top customers have a highest revenue'), decision)).toBe('semantic_answer');
  });

  it('AGT-009/PERF-002 clarifies a bare customer ranking before selecting the beverage block', async () => {
    const resolveMeaning = vi.fn(async () => clarifyingRanking());
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-jaffle-ranking',
        sourceFingerprint: 'sha256:jaffle-ranking',
        parsedIntent: { measures: [], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
        candidates: [candidate({
          id: 'dql:block:top_beverage_customers',
          kind: 'certified_block',
          trustTier: 'certified',
          name: 'top_beverage_customers',
          aliases: ['top customers by drink revenue'],
          dimensions: ['customer_name'],
          compatibility: 'compatible',
          compatibilityFacts: ['output: customer_name', 'output: beverage_revenue'],
          exactMatch: true,
          relevanceScore: 1,
        })],
      }),
    });

    const decision = await router.decide(request('who are the top customers'));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      action: 'clarify',
      requiresClarification: true,
      clarifyingQuestion: 'Top by which governed metric?',
    });
    expect(decision.resolvedAnalyticalPlan).toBeUndefined();
  });

  it('does not ask an unanswerable clarification when every ranking candidate is filtered out', async () => {
    // The reported BCM loop. Retrieval returns only objects that cannot BE a
    // ranking measure (a semantic model, a dbt node), so all five candidate
    // filters strip them and the choice list is empty. Emitting
    // "Top by which governed metric?" with no options is unanswerable: the reply
    // carries no selectedEvidenceId, re-enters the same path with the same
    // evidence, and reproduces the identical question forever.
    const router = createHybridRouter({
      resolveMeaning: vi.fn(async () => clarifyingRanking()),
      getEvidence: async () => ({
        snapshotId: 'snapshot-bcm',
        sourceFingerprint: 'sha256:bcm',
        parsedIntent: { measures: [], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
        candidates: [
          candidate({
            id: 'semantic:model:customers',
            kind: 'semantic_model',
            name: 'customers',
            compatibility: 'compatible',
            relevanceScore: 0.7,
          }),
          candidate({
            id: 'dbt:model:stg_billed_consumption',
            kind: 'dbt_model',
            name: 'stg_billed_consumption',
            compatibility: 'compatible',
            relevanceScore: 0.6,
          }),
        ],
      }),
    });

    const decision = await router.decide(request('who are the top customers for BCM'));

    expect(decision.clarificationOptions ?? []).toHaveLength(0);
    expect(decision.action).not.toBe('clarify');
    expect(decision.requiresClarification).not.toBe(true);
    expect(decision.clarifyingQuestion).toBeUndefined();
  });

  it('AGT-031 collapses lower-trust copies of a field a certified block already publishes', () => {
    // The same field arrives three ways: the block's declared output, the
    // semantic dimension, and the raw dbt/warehouse column. Treating them as
    // three governed MEANINGS turned an attribute lookup into a "which meaning
    // should DQL bind" interrogation.
    const survivors = collapseRedundantGovernedCandidates('what customer type is joe', [
      candidate({
        id: 'dql:block:customer_profile',
        kind: 'certified_block',
        trustTier: 'certified',
        name: 'customer_profile',
        relevanceScore: 0.9,
        dimensions: ['customer_name', 'customer', 'customer_type'],
        compatibilityFacts: ['output: customer_name', 'output: customer_type'],
      }),
      // A column's qualified identity points at its PARENT RELATION, so this
      // one only matches on its own name.
      candidate({
        id: 'dbt:column:customers.customer_type',
        qualifiedId: 'customers',
        kind: 'sql_column',
        name: 'customer_type',
        relevanceScore: 0.8,
      }),
      candidate({
        id: 'semantic:dimension:customers.customer_type',
        kind: 'semantic_member',
        semanticObjectType: 'dimension',
        name: 'customer_type',
        relevanceScore: 0.7,
      }),
    ]).map((entry) => entry.id);

    expect(survivors).toContain('dql:block:customer_profile');
    expect(survivors).not.toContain('dbt:column:customers.customer_type');
    expect(survivors).not.toContain('semantic:dimension:customers.customer_type');
  });

  it('supersedes only what a block actually publishes, leaving unrelated fields alone', () => {
    // Guards the coverage rule against over-collapsing. The question is not an
    // attribute lookup, so decoy pruning is inactive and this isolates coverage.
    const survivors = collapseRedundantGovernedCandidates('show me revenue', [
      candidate({
        id: 'dql:block:customer_profile',
        kind: 'certified_block',
        trustTier: 'certified',
        name: 'customer_profile',
        relevanceScore: 0.9,
        dimensions: ['customer_name', 'customer_type'],
        compatibilityFacts: ['output: customer_name', 'output: customer_type'],
      }),
      candidate({
        id: 'dbt:column:raw_products.type',
        qualifiedId: 'raw_products',
        kind: 'sql_column',
        name: 'type',
        relevanceScore: 0.6,
      }),
    ]).map((entry) => entry.id);

    // `type` is not a field the block publishes, so coverage must not touch it.
    expect(survivors).toContain('dbt:column:raw_products.type');
    expect(survivors).toContain('dql:block:customer_profile');
  });

  it('AGT-031 drops lexical decoys that match only a sub-token of the requested field', () => {
    // "customer type" pulled in a products column named `type` and a metric
    // named `new_customer_orders`. Two decoys are enough to trip the ambiguity
    // gate and turn an ordinary lookup into an interrogation.
    const survivors = collapseRedundantGovernedCandidates('what customer type is joe', [
      candidate({
        id: 'dql:block:customer_profile',
        kind: 'certified_block',
        trustTier: 'certified',
        name: 'customer_profile',
        relevanceScore: 0.9,
        dimensions: ['customer_name', 'customer_type'],
        compatibilityFacts: ['output: customer_type'],
      }),
      candidate({
        id: 'semantic:dimension:customers.customer_type',
        kind: 'semantic_member',
        semanticObjectType: 'dimension',
        name: 'customer_type',
        relevanceScore: 0.85,
      }),
      candidate({ id: 'dbt:column:raw_products.type', qualifiedId: 'raw_products', kind: 'sql_column', name: 'type', relevanceScore: 0.6 }),
      candidate({ id: 'semantic:metric:orders.new_customer_orders', kind: 'semantic_metric', semanticObjectType: 'metric', name: 'new_customer_orders', relevanceScore: 0.55 }),
    ]).map((entry) => entry.id);

    // The block accounts for the full requested field; the decoys account for
    // one shared word each.
    expect(survivors).toEqual(['dql:block:customer_profile']);
  });

  it('AGT-031 does not preempt an attribute lookup that merely contains the word "top"', async () => {
    const region = candidate({
      id: 'semantic:dimension:customers.region',
      kind: 'semantic_member',
      name: 'region',
      dimensions: ['customer'],
      compatibility: 'compatible',
      relevanceScore: 0.95,
    });
    // The meaning model classifies this as a value lookup, not a ranking.
    const resolveMeaning = vi.fn(async () => resolved({
      interpretedQuestion: 'Look up the region attribute of the named customer.',
      questionType: 'value',
      selectedConceptIds: [region.id],
      recommendedExecutionId: region.id,
      queryIntent: { measures: [], dimensions: ['region'], filters: [], order: 'desc', limit: 10 },
      recommendedRoute: 'semantic',
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-attribute-lookup',
        sourceFingerprint: 'sha256:attribute-lookup',
        parsedIntent: { measures: [], dimensions: ['region'], filters: [] },
        candidates: [region],
      }),
    });

    const decision = await router.decide(request('what region does the top customer belong to'));

    // The text heuristic sees "top" and used to send this to the ranking
    // clarification, so an attribute lookup could never route.
    expect(decision.action).not.toBe('clarify');
    expect(decision.clarifyingQuestion).not.toBe('Top by which governed metric?');
  });

  it('AGT-030 honors a ranking resolution that already named a governed measure', async () => {
    const revenue = candidate({
      id: 'semantic:metric:revenue',
      kind: 'semantic_metric',
      name: 'revenue',
      aggregation: 'sum',
      dimensions: ['customer'],
      compatibility: 'compatible',
      relevanceScore: 0.9,
    });
    const resolveMeaning = vi.fn(async () => resolved({
      questionType: 'ranking',
      selectedConceptIds: [revenue.id],
      recommendedExecutionId: revenue.id,
      queryIntent: { measures: [revenue.id], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
      recommendedRoute: 'semantic',
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-resolved-ranking',
        sourceFingerprint: 'sha256:resolved-ranking',
        parsedIntent: { measures: [], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
        candidates: [revenue],
      }),
    });

    const decision = await router.decide(request('who are the top customers'));

    // A measure the model selected from qualified candidates is not thrown away.
    expect(decision.action).not.toBe('clarify');
    expect(decision.resolvedAnalyticalPlan?.selectedConceptIds).toContain(revenue.id);
  });

  it('AGT-030 offers the compatible ranking measures and never the same-grain entity count', async () => {
    const resolveMeaning = vi.fn(async () => clarifyingRanking());
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-jaffle-ranking-options',
        sourceFingerprint: 'sha256:jaffle-ranking-options',
        parsedIntent: { measures: [], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
        candidates: [
          candidate({
            id: 'semantic:measure:customers.customers',
            kind: 'semantic_metric',
            name: 'customers',
            primaryEntity: 'customers',
            aggregation: 'count_distinct',
            dimensions: ['customers'],
            compatibility: 'compatible',
            relevanceScore: 0.9,
          }),
          candidate({
            id: 'semantic:metric:revenue',
            kind: 'semantic_metric',
            name: 'revenue',
            aggregation: 'sum',
            dimensions: ['customer'],
            compatibility: 'compatible',
            relevanceScore: 0.8,
          }),
          candidate({
            id: 'semantic:metric:lifetime_spend_pretax',
            kind: 'semantic_metric',
            name: 'lifetime_spend_pretax',
            aggregation: 'sum',
            dimensions: ['customer'],
            compatibility: 'compatible',
            relevanceScore: 0.7,
          }),
        ],
      }),
    });

    const decision = await router.decide(request('who are the top customers'));

    expect(decision).toMatchObject({
      action: 'clarify',
      requiresClarification: true,
      clarifyingQuestion: 'Top by which governed metric?',
    });
    // The dead end was a clarification with nothing to choose from.
    const optionIds = (decision.clarificationOptions ?? []).map((option) => option.id);
    expect(optionIds.length).toBeGreaterThan(0);
    expect(optionIds).toContain('semantic:metric:revenue');
    // Ranking individual customers by a distinct count of customers is degenerate.
    expect(optionIds).not.toContain('semantic:measure:customers.customers');
    expect(decision.resolvedAnalyticalPlan).toBeUndefined();
  });

  it('AGT-009/PERF-002 clarifies a bare ranking for an arbitrary entity without domain wording', async () => {
    const resolveMeaning = vi.fn(async () => clarifyingRanking({ queryIntent: { measures: [], dimensions: ['workspace'], filters: [], order: 'desc', limit: 10 } }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-bare-ranking-generic',
        sourceFingerprint: 'sha256:bare-ranking-generic',
        parsedIntent: { measures: [], dimensions: ['workspace'], filters: [], order: 'desc', limit: 10 },
        candidates: [candidate({
          id: 'semantic:workforce:dimension:workspace',
          qualifiedId: 'semantic:workforce:dimension:workspace',
          kind: 'semantic_member',
          trustTier: 'semantic',
          name: 'Workspace',
          aliases: ['workspaces'],
          compatibility: 'compatible',
          relevanceScore: 1,
        })],
      }),
    });

    const decision = await router.decide(request('Which workspaces are top?'));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      action: 'clarify',
      requiresClarification: true,
      clarifyingQuestion: 'Top by which governed metric?',
    });
    expect(decision.reason).not.toMatch(/customer|revenue|beverage|drink|food|region/i);
  });

  it('AGT-009/PERF-002 does not treat unrelated qualified metric presence as a bare-ranking choice', async () => {
    const decoy = jaffleMetric(
      'semantic:workforce:metric:licensed_seats',
      'Licensed seat count',
      [],
      false,
    );
    const resolveMeaning = vi.fn(async () => clarifyingRanking({ queryIntent: { measures: [], dimensions: ['workspace'], filters: [], order: 'desc', limit: 10 } }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-bare-ranking-qualified-decoy',
        sourceFingerprint: 'sha256:bare-ranking-qualified-decoy',
        parsedIntent: { measures: [], dimensions: ['workspace'], filters: [], order: 'desc', limit: 10 },
        candidates: [decoy],
      }),
    });

    const decision = await router.decide(request('Which workspaces are top?'));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      action: 'clarify',
      requiresClarification: true,
      clarifyingQuestion: 'Top by which governed metric?',
    });
  });

  it('AGT-009 allows one bounded meaning call for an arbitrary implicit substantive metric', async () => {
    const pressure = jaffleMetric(
      'semantic:operations:metric:saturation_pressure_amount',
      'semantic_model_00421.saturation_pressure_amount',
      [],
      false,
    );
    pressure.analyticalCapability = {
      ...pressure.analyticalCapability!,
      primaryEntityId: 'semantic:operations:entity:reading',
      resultGrainIds: ['semantic:operations:grain:scalar', 'semantic:operations:entity:reactor'],
      dimensions: [{
        dimensionId: 'semantic:operations:dimension:reactor',
        entityId: 'semantic:operations:entity:reactor',
        supportedRoles: ['group_by', 'rank_entity'],
        relationshipPathIds: ['semantic:operations:relationship:reading_to_reactor'],
        nativeGroupingReference: 'reading__reactor',
        nativeGroupingPath: ['reading'],
      }],
    };
    const resolveMeaning = vi.fn(async () => resolved({
      interpretedQuestion: 'Rank reactors by saturation pressure.',
      selectedConceptIds: [pressure.id],
      recommendedExecutionId: pressure.id,
      queryIntent: {
        measures: ['saturation pressure'],
        dimensions: ['reactor'],
        filters: [],
        order: 'desc',
        limit: 10,
      },
      recommendedRoute: 'semantic',
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-implicit-operations-metric',
        sourceFingerprint: 'sha256:implicit-operations-metric',
        parsedIntent: { measures: [], dimensions: ['reactor'], filters: [], order: 'desc', limit: 10 },
        candidates: [pressure],
      }),
    });

    const decision = await router.decide(request('Which reactors have the highest saturation pressure?'));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      action: 'answer',
      resolvedAnalyticalPlan: {
        capability: 'semantic_execution',
        selectedConceptIds: [pressure.id],
      },
    });
  });

  it('does not accept a client-carried plan ID as ranking-metric authority', async () => {
    const resolveMeaning = vi.fn(async () => clarifyingRanking());
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-forged-carried-plan',
        candidates: [candidate({
          id: 'dql:block:top_customers',
          kind: 'certified_block',
          trustTier: 'certified',
          name: 'top_customers',
        aliases: ['top customers'],
        compatibility: 'compatible',
        dimensions: ['customer_name'],
        compatibilityFacts: ['output: customer_name'],
        exactMatch: true,
          analyticalFitClass: 'exact',
          relevanceScore: 1,
        })],
      }),
    });

    const decision = await router.decide({
      question: 'who are the top customers',
      conversationContext: {
        priorResolvedAnalyticalPlan: {
          analyticalFrame: { metricConceptIds: ['semantic:metric:forged'] },
        },
      },
    });

    // The certified fast lane answers this before any meaning call: the fixture's
    // block is an exact authored-example match, the strictest shortcut precondition
    // available.
    //
    // The security property this test exists for is UNCHANGED, and now asserted more
    // directly: the forged `priorResolvedAnalyticalPlan` never becomes authority. The
    // plan binds the RETRIEVED certified block, and the forged concept id appears
    // nowhere in it.
    expect(decision.action).toBe('answer');
    expect(decision.resolvedAnalyticalPlan?.selectedConceptIds).toContain('dql:block:top_customers');
    expect(JSON.stringify(decision.resolvedAnalyticalPlan ?? {})).not.toContain('semantic:metric:forged');
  });

  it('uses one bounded meaning call for a substantive ranking metric when parsed intent is absent', async () => {
    const risk = executableSemanticCandidate({
      id: 'semantic:consumption:rollover_risk_amount',
      qualifiedId: 'semantic:consumption:rollover_risk_amount',
      name: 'semantic_model_00000.rollover_risk_amount',
      aliases: [],
      exactMatch: false,
    });
    const balance = jaffleMetric(
      'semantic:consumption:rollover_balance_amount',
      'Rollover Balance Amount',
      ['rollover balance'],
      false,
    );
    const resolveMeaning = vi.fn(async () => resolved({
      interpretedQuestion: 'Rank customers by rollover risk this month.',
      selectedConceptIds: [risk.id],
      recommendedExecutionId: risk.id,
      queryIntent: {
        measures: ['rollover risk'],
        dimensions: ['customer'],
        filters: [],
        timeRange: 'this month',
        order: 'desc',
      },
      recommendedRoute: 'semantic',
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-substantive-risk-ranking',
        parsedIntent: {
          measures: [],
          dimensions: ['customer'],
          filters: [],
          timeRange: 'this month',
          order: 'desc',
          limit: 10,
        },
        candidates: [risk, balance],
      }),
    });

    const decision = await router.decide(request('Which customers have the highest rollover risk this month?'));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision.action).toBe('answer');
    expect(decision.meaningResolution?.selectedConceptIds).toEqual([risk.id]);
    expect(decision.resolvedAnalyticalPlan).toMatchObject({
      capability: 'semantic_execution',
      selectedConceptIds: [risk.id],
    });
  });

  it('AGT-012/013 reconciles a provider-selected metric to its unique qualified capability dimension', async () => {
    const activeSeats = jaffleMetric(
      'semantic:workforce:metric:active_seats',
      'Active seats',
      ['active seats', 'seat count'],
      false,
    );
    activeSeats.analyticalCapability = {
      ...activeSeats.analyticalCapability!,
      primaryEntityId: 'semantic:workforce:entity:subscription',
      resultGrainIds: ['semantic:workforce:grain:scalar', 'semantic:workforce:entity:workspace'],
      dimensions: [{
        dimensionId: 'semantic:workforce:dimension:workspace',
        entityId: 'semantic:workforce:entity:workspace',
        supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
        relationshipPathIds: ['semantic:workforce:relationship:subscription_to_workspace'],
        nativeGroupingReference: 'subscription__workspace',
        nativeGroupingPath: ['subscription'],
      }],
    };
    const genericWorkspace = candidate({
      id: 'semantic:member:workspace',
      qualifiedId: 'semantic:catalog:member:workspace',
      kind: 'semantic_member',
      trustTier: 'semantic',
      name: 'Workspace',
      aliases: ['workspaces'],
      compatibility: 'compatible',
      exactMatch: false,
    });
    const decoy = jaffleMetric(
      'semantic:workforce:metric:licensed_seats',
      'Licensed seats',
      ['seat count'],
      false,
      'partial',
    );
    const resolveMeaning = vi.fn(async () => resolved({
      interpretedQuestion: 'Rank workspaces by active seats.',
      selectedConceptIds: [activeSeats.id, genericWorkspace.id],
      recommendedExecutionId: activeSeats.id,
      queryIntent: { measures: ['active seats'], dimensions: ['workspace'], filters: [], order: 'desc', limit: 10 },
      recommendedRoute: 'semantic',
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-workforce',
        sourceFingerprint: 'sha256:workforce',
        parsedIntent: { measures: ['active seats'], dimensions: ['workspace'], filters: [], order: 'desc', limit: 10 },
        candidates: [activeSeats, genericWorkspace, decoy],
      }),
    });

    const decision = await router.decide(request('Which workspaces have the most active seats?'));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({ action: 'answer', requiresClarification: false });
    expect(decision.resolvedAnalyticalPlan).toMatchObject({
      capability: 'semantic_execution',
      query: {
        dimensions: [{
          requested: 'workspace',
          qualifiedId: 'semantic:workforce:dimension:workspace',
          status: 'resolved',
          candidateIds: ['semantic:workforce:dimension:workspace'],
        }],
      },
    });
    expect(selectRoute(request('Which workspaces have the most active seats?'), decision)).toBe('semantic_answer');
  });

  it('AGT-012/UI-010 turns two qualified selected-capability dimensions into one hard identifier-bound clarification', async () => {
    const caseVolume = jaffleMetric(
      'semantic:support:metric:case_volume',
      'Case volume',
      ['cases', 'case volume'],
      false,
    );
    caseVolume.analyticalCapability = {
      ...caseVolume.analyticalCapability!,
      primaryEntityId: 'semantic:support:entity:case',
      resultGrainIds: ['semantic:support:grain:scalar', 'semantic:support:entity:account'],
      dimensions: [
        {
          dimensionId: 'semantic:support:dimension:billing_account',
          entityId: 'semantic:support:entity:account',
          supportedRoles: ['group_by', 'rank_entity'],
          relationshipPathIds: ['semantic:support:relationship:case_to_billing_account'],
          nativeGroupingReference: 'case__billing_account',
          nativeGroupingPath: ['case'],
        },
        {
          dimensionId: 'semantic:support:dimension:service_account',
          entityId: 'semantic:support:entity:account',
          supportedRoles: ['group_by', 'rank_entity'],
          relationshipPathIds: ['semantic:support:relationship:case_to_service_account'],
          nativeGroupingReference: 'case__service_account',
          nativeGroupingPath: ['case'],
        },
      ],
    };
    const decoy = jaffleMetric(
      'semantic:support:metric:case_resolution_time',
      'Case resolution time',
      ['cases'],
      false,
      'partial',
    );
    const resolveMeaning = vi.fn(async () => resolved({
      interpretedQuestion: 'Rank accounts by case volume.',
      selectedConceptIds: [caseVolume.id],
      recommendedExecutionId: caseVolume.id,
      queryIntent: { measures: ['case volume'], dimensions: ['account'], filters: [], order: 'desc', limit: 10 },
      recommendedRoute: 'semantic',
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-support',
        sourceFingerprint: 'sha256:support',
        parsedIntent: { measures: ['case volume'], dimensions: ['account'], filters: [], order: 'desc', limit: 10 },
        candidates: [caseVolume, decoy],
      }),
    });

    const decision = await router.decide(request('Which accounts have the most cases?'));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      action: 'clarify',
      requiresClarification: true,
      clarificationOptions: [
        { id: 'semantic:support:dimension:billing_account' },
        { id: 'semantic:support:dimension:service_account' },
      ],
    });
    expect(decision.clarifyingQuestion).toMatch(/billing account.*service account/i);
    expect(decision.resolvedAnalyticalPlan).toMatchObject({
      capability: 'blocked',
      query: { dimensions: [expect.objectContaining({ status: 'ambiguous' })] },
    });
    expect(decision.resolvedAnalyticalPlan?.missingInformation).not.toEqual([]);
    expect(selectRoute(request('Which accounts have the most cases?'), decision)).toBe('clarify');
  });

  it('AGT-010/012 blocks an unresolved arbitrary dimension without offering unrelated capability members', async () => {
    const deploymentCount = jaffleMetric(
      'semantic:delivery:metric:deployment_count',
      'Deployment count',
      ['deployments'],
      false,
    );
    deploymentCount.analyticalCapability = {
      ...deploymentCount.analyticalCapability!,
      primaryEntityId: 'semantic:delivery:entity:deployment',
      resultGrainIds: ['semantic:delivery:grain:scalar', 'semantic:delivery:entity:team'],
      dimensions: [
        {
          dimensionId: 'semantic:delivery:dimension:owning_team',
          entityId: 'semantic:delivery:entity:team',
          supportedRoles: ['group_by', 'rank_entity'],
          relationshipPathIds: ['semantic:delivery:relationship:deployment_to_owner'],
        },
        {
          dimensionId: 'semantic:delivery:dimension:operating_team',
          entityId: 'semantic:delivery:entity:team',
          supportedRoles: ['group_by', 'rank_entity'],
          relationshipPathIds: ['semantic:delivery:relationship:deployment_to_operator'],
        },
      ],
    };
    const decoy = jaffleMetric('semantic:delivery:metric:change_failure_rate', 'Change failure rate', ['deployments'], false, 'partial');
    const resolveMeaning = vi.fn(async () => resolved({
      interpretedQuestion: 'Rank crews by deployment count.',
      selectedConceptIds: [deploymentCount.id],
      recommendedExecutionId: deploymentCount.id,
      queryIntent: { measures: ['deployment count'], dimensions: ['crew'], filters: [], order: 'desc', limit: 10 },
      recommendedRoute: 'semantic',
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-unresolved-dimension',
        sourceFingerprint: 'sha256:unresolved-dimension',
        parsedIntent: { measures: ['deployment count'], dimensions: ['crew'], filters: [], order: 'desc', limit: 10 },
        candidates: [deploymentCount, decoy],
      }),
    });

    const decision = await router.decide(request('Which crews have the most deployments?'));

    expect(decision).toMatchObject({
      action: 'block',
      requiresClarification: false,
      terminalOutcome: {
        kind: 'modeling_gap',
        code: 'ANALYTICAL_MODELING_GAP',
      },
      resolvedAnalyticalPlan: {
        capability: 'blocked',
        query: { dimensions: [expect.objectContaining({ status: 'unresolved', candidateIds: [] })] },
        resolutionFailure: {
          outcome: 'modeling_gap',
          candidateIds: [],
        },
      },
    });
    expect(decision.clarificationOptions ?? []).toEqual([]);
  });

  it('AGT-010/013 emits an explicit typed terminal action for a relationship modeling gap', async () => {
    const unsupported = jaffleMetric('semantic:delivery:metric:deployment_count', 'Deployment count', ['deployments'], false);
    unsupported.analyticalCapability = {
      ...unsupported.analyticalCapability!,
      dimensions: [],
      resultGrainIds: ['semantic:delivery:grain:scalar'],
    };
    const decoy = jaffleMetric('semantic:delivery:metric:change_failure_rate', 'Change failure rate', ['deployments'], false, 'partial');
    const unsupportedWorkspace = candidate({
      id: 'semantic:delivery:dimension:workspace',
      qualifiedId: 'semantic:delivery:dimension:workspace',
      kind: 'semantic_member',
      trustTier: 'semantic',
      name: 'Workspace',
      compatibility: 'compatible',
    });
    const unsupportedEntity = candidate({
      id: 'semantic:delivery:entity:workspace',
      qualifiedId: 'semantic:delivery:entity:workspace',
      kind: 'semantic_member',
      trustTier: 'semantic',
      name: 'Workspace entity',
      compatibility: 'compatible',
    });
    const resolveMeaning = vi.fn(async () => resolved({
      interpretedQuestion: 'Rank workspaces by deployment count.',
      selectedConceptIds: [unsupported.id],
      recommendedExecutionId: unsupported.id,
      queryIntent: { measures: ['deployment count'], dimensions: ['workspace'], filters: [], order: 'desc', limit: 10 },
      recommendedRoute: 'semantic',
      analyticalFrame: {
        version: 2,
        interpretedQuestion: 'Rank workspaces by deployment count.',
        questionType: 'ranking',
        metricConceptIds: [unsupported.analyticalCapability.metricId],
        entityGrainIds: ['semantic:delivery:entity:workspace'],
        dimensions: [{ dimensionId: 'semantic:delivery:dimension:workspace', role: 'group_by' }],
        memberBindings: [],
        ranking: {
          entityDimensionId: 'semantic:delivery:dimension:workspace',
          byMetricId: unsupported.analyticalCapability.metricId,
          direction: 'desc',
          limit: 10,
          tiePolicy: 'stable_secondary_key',
        },
        requestedOutputs: [{ id: 'deployment_count', kind: 'metric_value', metricId: unsupported.analyticalCapability.metricId }],
        ambiguity: [],
      },
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-modeling-gap-action',
        sourceFingerprint: 'sha256:modeling-gap-action',
        parsedIntent: { measures: ['deployment count'], dimensions: ['workspace'], filters: [], order: 'desc', limit: 10 },
        candidates: [unsupported, unsupportedWorkspace, unsupportedEntity, decoy],
      }),
    });

    const decision = await router.decide(request('Which workspaces have the most deployments?'));

    expect(decision).toMatchObject({
      action: 'block',
      requiresClarification: false,
      terminalOutcome: {
        kind: 'modeling_gap',
        code: 'ANALYTICAL_MODELING_GAP',
      },
      resolvedAnalyticalPlan: {
        capability: 'blocked',
        resolutionFailure: {
          outcome: 'modeling_gap',
          selectedCapabilityId: unsupported.analyticalCapability.metricId,
        },
      },
    });
    expect(decision.reason).not.toHaveLength(0);
    expect(decision.resolvedAnalyticalPlan?.missingInformation).not.toEqual([]);
    expect(selectRoute(request('Which workspaces have the most deployments?'), decision)).toBe('blocked');
  });

  it('AGT-034 ignores a legacy provider frame dimension outside the host-owned capability', async () => {
    const activeSeats = jaffleMetric('semantic:workforce:metric:active_seats', 'Active seats', ['active seats'], false);
    activeSeats.analyticalCapability = {
      ...activeSeats.analyticalCapability!,
      primaryEntityId: 'semantic:workforce:entity:subscription',
      resultGrainIds: ['semantic:workforce:grain:scalar', 'semantic:workforce:entity:workspace'],
      dimensions: [{
        dimensionId: 'semantic:workforce:dimension:workspace',
        entityId: 'semantic:workforce:entity:workspace',
        supportedRoles: ['group_by', 'rank_entity'],
        relationshipPathIds: ['semantic:workforce:relationship:subscription_to_workspace'],
        nativeGroupingReference: 'subscription__workspace',
        nativeGroupingPath: ['subscription'],
      }],
    };
    const unrelatedDimension = candidate({
      id: 'semantic:finance:dimension:cost_center',
      qualifiedId: 'semantic:finance:dimension:cost_center',
      kind: 'semantic_member',
      trustTier: 'semantic',
      name: 'Workspace',
      compatibility: 'compatible',
      relevanceScore: 0.9,
    });
    const decoy = jaffleMetric('semantic:workforce:metric:licensed_seats', 'Licensed seats', ['active seats'], false, 'partial');
    const resolveMeaning = vi.fn(async () => resolved({
      interpretedQuestion: 'Rank workspaces by active seats.',
      selectedConceptIds: [activeSeats.id, unrelatedDimension.id],
      recommendedExecutionId: activeSeats.id,
      queryIntent: { measures: ['active seats'], dimensions: ['workspace'], filters: [], order: 'desc', limit: 10 },
      recommendedRoute: 'semantic',
      analyticalFrame: {
        version: 2,
        interpretedQuestion: 'Rank workspaces by active seats.',
        questionType: 'ranking',
        metricConceptIds: [activeSeats.analyticalCapability.metricId],
        entityGrainIds: ['semantic:workforce:entity:workspace'],
        dimensions: [{ dimensionId: unrelatedDimension.qualifiedId!, role: 'group_by' }],
        memberBindings: [],
        ranking: {
          entityDimensionId: unrelatedDimension.qualifiedId!,
          byMetricId: activeSeats.analyticalCapability.metricId,
          direction: 'desc', limit: 10, tiePolicy: 'stable_secondary_key',
        },
        requestedOutputs: [{ id: 'active_seats', kind: 'metric_value', metricId: activeSeats.analyticalCapability.metricId }],
        ambiguity: [],
      },
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-adversarial-frame',
        sourceFingerprint: 'sha256:adversarial-frame',
        parsedIntent: { measures: ['active seats'], dimensions: ['workspace'], filters: [], order: 'desc', limit: 10 },
        candidates: [activeSeats, unrelatedDimension, decoy],
      }),
    });

    const decision = await router.decide(request('Which workspaces have the most active seats?'));

    // The old wire field remains readable for compatibility but is never an
    // authority. The host seed resolves the requested workspace requirement
    // against the selected metric's capability instead of treating a model
    // frame as a second plan.
    expect(decision.action).toBe('answer');
    expect(decision.resolvedAnalyticalPlan?.query.dimensions[0]?.qualifiedId).not.toBe(unrelatedDimension.qualifiedId);
    expect(JSON.stringify(decision.resolvedAnalyticalPlan)).toContain(activeSeats.analyticalCapability.metricId);
    expect(decision.meaningResolution).toMatchObject({
      hostRequirementSeed: {
        sourceQuestion: 'Which workspaces have the most active seats?',
        requirements: expect.objectContaining({ measures: ['active seats'] }),
      },
      overrideReceipts: expect.arrayContaining([
        expect.objectContaining({ field: 'analytical_frame', action: 'host_preserved' }),
      ]),
    });
  });

  it('AGT-009 keeps explicit drink-revenue customer ranking on the certified fast path', async () => {
    const resolveMeaning = vi.fn(async ({ candidates, evidence }: { candidates: AgentEvidenceCandidate[]; evidence: AgentRetrievalEvidence }) => {
      const selected = candidates.find((item) => item.id === 'dql:block:top_beverage_customers') ?? candidates[0];
      return resolved({
        selectedConceptIds: selected ? [selected.id] : [],
        recommendedExecutionId: selected?.id,
        queryIntent: { measures: evidence.parsedIntent?.measures ?? ['drink_revenue'], dimensions: evidence.parsedIntent?.dimensions ?? ['customer_name'], filters: [], order: 'desc', limit: 10 },
        recommendedRoute: 'certified',
      });
    });
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-jaffle-ranking-explicit',
        sourceFingerprint: 'sha256:jaffle-ranking-explicit',
        parsedIntent: { measures: ['drink_revenue'], dimensions: ['customer_name'], filters: [], order: 'desc', limit: 10 },
        candidates: [candidate({
          id: 'dql:block:top_beverage_customers',
          kind: 'certified_block',
          trustTier: 'certified',
          name: 'top_beverage_customers',
          aliases: ['top customers by beverage revenue', 'top customers by drink revenue'],
          dimensions: ['customer_name'],
          compatibility: 'compatible',
          compatibilityFacts: ['output: customer_name', 'output: beverage_revenue'],
          exactMatch: true,
          analyticalFitClass: 'exact',
          relevanceScore: 1,
        }), candidate({
          id: 'semantic:metric:order_item.revenue',
          kind: 'semantic_metric',
          trustTier: 'semantic',
          name: 'order_item.revenue',
          compatibility: 'partial',
          exactMatch: false,
          relevanceScore: 0.95,
        })],
      }),
    });

    const decision = await router.decide(request('top customers by beverage revenue'));

    // The outcome this test protects is unchanged; the meaning call is not made.
    // An exact certified match is the cheapest and most certain answer DQL can give,
    // and it used to be one of the slowest because this shortcut only applied when
    // the call was already being skipped.
    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(decision.action).toBe('answer');
    expect(decision.resolvedAnalyticalPlan?.selectedConceptIds).toContain('dql:block:top_beverage_customers');
  });

  it('routes a complete monthly certified fit before a compatible semantic competitor without relying on an authored example string', async () => {
    const completeCertified = candidate({
      id: 'dql:block:monthly_revenue',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'monthly_revenue',
      aliases: ['monthly revenue'],
      dimensions: ['month'],
      relevanceScore: 0.91,
      compatibility: 'compatible',
      compatibilityFacts: ['output: month', 'output: revenue'],
      exactMatch: true,
      analyticalFitClass: 'exact',
    });
    const semanticCompetitor = jaffleMetric(
      'semantic:metric:orders.revenue',
      'orders.revenue',
      ['revenue'],
      true,
    );
    const resolveMeaning = vi.fn(async () => {
      throw new Error('A catalog-proven complete certified artifact must route before the meaning call.');
    });
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-monthly-certification',
        sourceFingerprint: 'sha256:monthly-certification',
        parsedIntent: { measures: ['revenue'], dimensions: ['month'], filters: [], timeGrain: 'month' },
        candidates: [completeCertified, semanticCompetitor],
      }),
    });
    const ask = request('What is monthly revenue?');

    const decision = await router.decide(ask);

    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(selectRoute(ask, decision)).toBe('certified_answer');
    expect(decision.resolvedAnalyticalPlan?.selectedConceptIds).toEqual(['dql:block:monthly_revenue']);
  });

  it('AGT-013 asks exactly once for a declared fiscal calendar before any plan freeze', async () => {
    const resolveMeaning = vi.fn(async () => resolved());
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-fiscal-unbound',
        sourceFingerprint: 'sha256:fiscal-unbound',
        parsedIntent: { measures: ['revenue'], dimensions: ['month'], filters: [], timeGrain: 'month' },
        candidates: [jaffleMetric('semantic:metric:revenue', 'Revenue', ['revenue'], true)],
      }),
    });
    const decision = await router.decide(request('Show revenue by month for FY26'));

    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ action: 'clarify', requiresClarification: true, analyticalCascadeDecision: { planFrozen: false, stopReason: 'ambiguous' } });
    expect(decision.clarifyingQuestion).toMatch(/declared fiscal calendar.*FY26/i);
  });

  it('AGT-013 binds FY26 to an explicitly declared fiscal field without guessing a calendar', async () => {
    const metric = jaffleMetric('semantic:metric:revenue', 'Revenue', ['revenue'], true);
    const fiscalField = candidate({
      id: 'semantic:dimension:date.fiscal_period', qualifiedId: 'semantic:dimension:date.fiscal_period',
      kind: 'semantic_member', trustTier: 'semantic', name: 'Fiscal Period', aliases: ['fy'], compatibility: 'compatible',
    });
    const calendar = candidate({
      id: 'semantic:calendar:corporate', qualifiedId: 'semantic:calendar:corporate', kind: 'dql_modeling', trustTier: 'governed_sql', name: 'Corporate Fiscal Calendar', compatibility: 'compatible',
    });
    const dateRole = candidate({
      id: 'semantic:dimension:date.order_date', qualifiedId: 'semantic:dimension:date.order_date',
      kind: 'semantic_member', trustTier: 'semantic', name: 'Order Date', compatibility: 'compatible', timeGrains: ['month'],
    });
    const resolveMeaning = vi.fn(async () => resolved({
      selectedConceptIds: [metric.id], recommendedExecutionId: metric.id,
      queryIntent: { measures: ['revenue'], dimensions: [], filters: [], order: 'desc' },
      recommendedRoute: 'governed_sql',
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-fiscal-declared', sourceFingerprint: 'sha256:fiscal-declared',
        parsedIntent: { measures: ['revenue'], dimensions: [], filters: [], timeGrain: 'month' },
        fiscalCalendar: { id: calendar.id, fiscalPeriodFieldId: fiscalField.id, dateRoleId: 'semantic:dimension:date.order_date' },
        candidates: [metric, fiscalField, dateRole, calendar],
      }),
    });
    const decision = await router.decide(request('Show revenue by month for FY26'));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision.meaningResolution?.queryIntent).toMatchObject({
      fiscalCalendarId: calendar.id,
      fiscalDateRoleId: dateRole.id,
      timeGrain: 'month',
      filters: expect.arrayContaining([{ field: fiscalField.id, value: 'FY26' }]),
    });
  });

  it.each([
    'who are the top customers by region',
    'what is the region by each customer',
  ])('AGT-010/PERF-002 clarifies the unmodeled customer region immediately: %s', async (question) => {
    const resolveMeaning = vi.fn(async () => resolved({
      selectedConceptIds: [],
      recommendedExecutionId: undefined,
      queryIntent: { measures: [], dimensions: ['customer_name', 'region'], filters: [] },
      recommendedRoute: 'clarify',
      confidence: 'low',
      missingInformation: ['region is not modeled'],
      compatibilityOutcome: 'clarify',
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-jaffle-location',
        sourceFingerprint: 'sha256:jaffle-location',
        parsedIntent: { measures: [], dimensions: ['customer_name', 'region'], filters: [] },
        candidates: [
          candidate({ id: 'semantic:dimension:customer.customer_name', kind: 'semantic_member', name: 'customer_name', primaryEntity: 'customer', compatibility: 'compatible' }),
          candidate({ id: 'semantic:dimension:order.location_name', kind: 'semantic_member', name: 'location_name', primaryEntity: 'order', compatibility: 'compatible', compatibilityFacts: ['alternative-for:region'] }),
        ],
      }),
    });

    const decision = await router.decide(request(question));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision.action).toBe('clarify');
    expect(decision.clarifyingQuestion).toContain('“region” is not modeled');
    expect(decision.clarifyingQuestion).toContain('location_name');
    expect(decision.resolvedAnalyticalPlan).toBeUndefined();
  });

  it('AGT-034 normalizes sales to revenue and binds one declared region alternative with a visible assumption', async () => {
    const revenue = jaffleMetric(
      'semantic:metric:orders.revenue',
      'orders.revenue',
      ['revenue', 'sales'],
      true,
    );
    revenue.analyticalCapability = {
      ...revenue.analyticalCapability!,
      dimensions: [{
        dimensionId: 'semantic:dimension:orders.location_name',
        entityId: 'order',
        label: 'Location Name',
        aliases: ['region'],
        supportedRoles: ['group_by', 'display'],
        relationshipPathIds: [],
      }],
    };
    const location = candidate({
      id: 'semantic:dimension:orders.location_name',
      qualifiedId: 'semantic:dimension:orders.location_name',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'Location Name',
      aliases: ['location name'],
      primaryEntity: 'order',
      relevanceScore: 0.91,
      compatibility: 'compatible',
      compatibilityFacts: ['alternative-for:region'],
    });
    const router = createHybridRouter({
      requireMeaningCallForNaturalLanguage: false,
      getEvidence: async () => ({
        snapshotId: 'snapshot-region-alternative',
        sourceFingerprint: 'sha256:region-alternative',
        parsedIntent: {
          measures: ['sales based on the region'],
          dimensions: ['sales based on the region'],
          filters: [],
        },
        candidates: [revenue, location],
      }),
    });

    const ask = request('Show revenue by sales based on the region');
    const decision = await router.decide(ask);

    expect(selectRoute(ask, decision)).toBe('semantic_answer');
    expect(decision.requiresClarification).toBe(false);
    expect(decision.analyticalCascadeDecision).toMatchObject({
      selectedTier: 'semantic',
      planFrozen: true,
    });
    expect(decision.resolvedAnalyticalPlan?.query).toMatchObject({
      measures: [expect.objectContaining({ requested: 'revenue', status: 'resolved' })],
      dimensions: [expect.objectContaining({
        requested: 'region',
        qualifiedId: 'semantic:dimension:orders.location_name',
        status: 'resolved',
      })],
    });
    expect(decision.assumptions).toEqual([
      expect.objectContaining({
        about: 'dimension',
        chose: 'semantic:dimension:orders.location_name',
        choseLabel: 'Location Name',
      }),
    ]);
  });

  it('AGT-034 recovers from an empty provider meaning binding only through the exact current-turn revenue metric', async () => {
    const revenue = jaffleMetric(
      'semantic:metric:order_items.revenue',
      'order_items.revenue',
      ['revenue', 'sales'],
      true,
    );
    revenue.analyticalCapability = {
      ...revenue.analyticalCapability!,
      dimensions: [{
        dimensionId: 'semantic:dimension:order_items.location_name',
        entityId: 'order',
        label: 'Location Name',
        aliases: ['region'],
        supportedRoles: ['group_by', 'display'],
        relationshipPathIds: [],
      }],
    };
    // This is a real competing metric in the package. It shares the token
    // "revenue" but is not the exact requested leaf identity, so a missing
    // model selection may not force the reader to choose it.
    const productRevenue = jaffleMetric(
      'semantic:metric:order_items.product_revenue',
      'order_items.product_revenue',
      ['product revenue'],
      false,
    );
    const location = candidate({
      id: 'semantic:dimension:order_items.location_name',
      qualifiedId: 'semantic:dimension:order_items.location_name',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'Location Name',
      aliases: ['location name'],
      primaryEntity: 'order',
      relevanceScore: 0.91,
      compatibility: 'compatible',
      compatibilityFacts: ['alternative-for:region'],
      sameSnapshotRoleExtension: {
        version: 1,
        role: 'categorical_dimension',
        requestedTerm: 'region',
        metricId: revenue.id,
        dimensionId: 'semantic:dimension:order_items.location_name',
        basis: 'sole_metricflow_grouping_dimension',
      },
    });
    const resolveMeaning = vi.fn(async () => resolved({
      selectedConceptIds: [],
      recommendedExecutionId: undefined,
      queryIntent: { measures: [], dimensions: [], filters: [] },
      confidence: 'low',
      missingInformation: [],
      recommendedRoute: 'clarify',
      emptyCandidateBinding: true,
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-region-empty-provider-binding',
        sourceFingerprint: 'sha256:region-empty-provider-binding',
        parsedIntent: {
          measures: ['sales based on the region'],
          dimensions: ['sales based on the region'],
          filters: [],
        },
        candidates: [revenue, productRevenue, location],
      }),
    });

    const ask = request('Show revenue by sales based on the region');
    const decision = await router.decide(ask);

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(selectRoute(ask, decision)).toBe('semantic_answer');
    expect(decision).toMatchObject({
      requiresClarification: false,
      analyticalCascadeDecision: { selectedTier: 'semantic', planFrozen: true },
      meaningResolution: {
        recommendedExecutionId: revenue.id,
        selectedConceptIds: expect.arrayContaining([revenue.id]),
      },
    });
    expect(decision.meaningResolution?.selectedConceptIds).not.toContain(productRevenue.id);
    expect(decision.clarifyingQuestion).toBeUndefined();
    expect(decision.clarifySoft).toBeUndefined();
    expect(decision.resolvedAnalyticalPlan?.query).toMatchObject({
      measures: [expect.objectContaining({ requested: 'revenue', qualifiedId: revenue.id, status: 'resolved' })],
      dimensions: [expect.objectContaining({ requested: 'region', qualifiedId: 'semantic:dimension:order_items.location_name', status: 'resolved' })],
    });
  });

  it('AGT-034 admits only the exact current MetricFlow grouping from targeted clarification cards', async () => {
    const revenue = jaffleMetric(
      'semantic:metric:order_items.revenue',
      'order_items.revenue',
      ['revenue'],
      true,
    );
    const productDimensionId = 'semantic:dimension:order_items.product_type';
    const productCategoryDimensionId = 'semantic:dimension:order_items.product_category';
    revenue.analyticalCapability = {
      ...revenue.analyticalCapability!,
      dimensions: [{
        dimensionId: productDimensionId,
        entityId: 'order_item',
        label: 'Product Type',
        aliases: ['product category'],
        // The field exists in this capability but is not a MetricFlow
        // grouping. Matching extension/metric strings alone must not admit it.
        supportedRoles: ['filter'],
      }, {
        dimensionId: productCategoryDimensionId,
        entityId: 'order_item',
        label: 'Product Category',
        aliases: ['product category'],
        supportedRoles: ['group_by'],
        nativeGroupingReference: 'order_item__product_category',
        nativeGroupingPath: ['order_item'],
      }],
    };
    const nonGroupable = candidate({
      id: 'semantic:extension:non_groupable_product_type',
      qualifiedId: productDimensionId,
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'Product Type',
      aliases: ['product category'],
      relevanceScore: 0.9,
      sameSnapshotRoleExtension: {
        version: 1,
        role: 'categorical_dimension',
        requestedTerm: 'product category',
        metricId: revenue.id,
        dimensionId: productDimensionId,
        basis: 'exact_metricflow_grouping_dimension',
      },
    });
    const mismatched = candidate({
      id: 'semantic:extension:mismatched_product_type',
      qualifiedId: 'semantic:dimension:other.product_type',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'Other Product Type',
      aliases: ['product category'],
      relevanceScore: 0.89,
      sameSnapshotRoleExtension: {
        version: 1,
        role: 'categorical_dimension',
        requestedTerm: 'product category',
        metricId: revenue.id,
        dimensionId: 'semantic:dimension:other.product_type',
        basis: 'exact_metricflow_grouping_dimension',
      },
    });
    const exactGrouping = candidate({
      id: 'semantic:extension:exact_product_category',
      qualifiedId: productCategoryDimensionId,
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'Product Category',
      aliases: ['product category'],
      relevanceScore: 0.88,
      sameSnapshotRoleExtension: {
        version: 1,
        role: 'categorical_dimension',
        requestedTerm: 'product category',
        metricId: revenue.id,
        dimensionId: productCategoryDimensionId,
        basis: 'exact_metricflow_grouping_dimension',
      },
    });
    const resolveMeaning = vi.fn(async () => resolved({
      selectedConceptIds: [],
      recommendedExecutionId: undefined,
      queryIntent: { measures: [], dimensions: [], filters: [] },
      confidence: 'low',
      missingInformation: ['Product category is not groupable for revenue.'],
      recommendedRoute: 'clarify',
      emptyCandidateBinding: true,
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-targeted-extension-proof',
        sourceFingerprint: 'sha256:targeted-extension-proof',
        parsedIntent: { measures: ['revenue'], dimensions: ['product category'], filters: [] },
        candidates: [revenue],
        clarificationCandidates: [nonGroupable, mismatched, exactGrouping],
      }),
    });

    await router.decide(request('Show revenue by product category'));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    const packageIds = resolveMeaning.mock.calls[0]?.[0].candidates.map((candidate) => candidate.id) ?? [];
    expect(packageIds).toContain(revenue.id);
    expect(packageIds).toContain(exactGrouping.id);
    expect(packageIds).not.toContain(nonGroupable.id);
    expect(packageIds).not.toContain(mismatched.id);
  });

  it('AGT-034 keeps a new customer/product-category question self-contained and freezes complete semantic roles', async () => {
    const revenue = jaffleMetric(
      'semantic:metric:orders.revenue',
      'orders.revenue',
      ['revenue'],
      true,
    );
    revenue.analyticalCapability = {
      ...revenue.analyticalCapability!,
      primaryEntityId: 'customer',
      defaultResultGrainId: 'customer',
      resultGrainIds: ['customer', 'customer_product_type'],
      dimensions: [
        {
          dimensionId: 'semantic:dimension:customers.customer_name',
          entityId: 'customer',
          label: 'Customer Name',
          aliases: ['customer', 'customers'],
          supportedRoles: ['group_by', 'display', 'rank_entity'],
          relationshipPathIds: ['relationship:orders_to_customers'],
        },
        {
          dimensionId: 'semantic:dimension:order_items.product_type',
          entityId: 'order_item',
          label: 'Product Type',
          aliases: ['product category', 'category'],
          supportedRoles: ['group_by', 'display'],
          relationshipPathIds: ['relationship:orders_to_order_items'],
          nativeGroupingReference: 'customer__order_item__product_type',
          nativeGroupingPath: ['customer', 'order_item'],
        },
      ],
    };
    const customer = candidate({
      id: 'semantic:dimension:customers.customer_name', qualifiedId: 'semantic:dimension:customers.customer_name',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Customer Name', aliases: ['customer', 'customers'], primaryEntity: 'customer', relevanceScore: 0.92,
    });
    const category = candidate({
      id: 'semantic:dimension:order_items.product_type', qualifiedId: 'semantic:dimension:order_items.product_type',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'Product Type', aliases: ['product category', 'category'], primaryEntity: 'order_item', relevanceScore: 0.91,
    });
    const router = createHybridRouter({
      requireMeaningCallForNaturalLanguage: false,
      getEvidence: async () => ({
        snapshotId: 'snapshot-customer-product-category',
        sourceFingerprint: 'sha256:customer-product-category',
        parsedIntent: { measures: ['revenue'], dimensions: ['product category'], filters: [], order: 'desc' },
        candidates: [revenue, customer, category],
      }),
    });
    const ask = request('who are the top customers who have revenue by product category?');
    const decision = await router.decide(ask);

    expect(selectRoute(ask, decision)).toBe('semantic_answer');
    expect(decision.analyticalCascadeDecision).toMatchObject({ selectedTier: 'semantic', planFrozen: true });
    expect(decision.meaningResolution?.queryIntent).toMatchObject({
      measures: ['revenue'],
      dimensions: expect.arrayContaining(['customer name', 'product category']),
      order: 'desc',
      limit: 10,
    });
    expect(decision.resolvedAnalyticalPlan?.query).toMatchObject({
      order: 'desc', limit: 10,
      measures: [expect.objectContaining({ requested: 'revenue', status: 'resolved' })],
      dimensions: expect.arrayContaining([
        expect.objectContaining({ requested: 'customer name', qualifiedId: 'semantic:dimension:customers.customer_name', status: 'resolved' }),
        expect.objectContaining({ requested: 'product category', qualifiedId: 'semantic:dimension:order_items.product_type', status: 'resolved' }),
      ]),
    });
  });

  it('AGT-034 preserves a unique capability-backed product category when the one meaning call omits it', async () => {
    const revenue = jaffleMetric(
      'semantic:metric:order_item.revenue',
      'order_item.revenue',
      ['revenue', 'sales'],
      true,
    );
    // This mirrors the local Jaffle MetricFlow shape: revenue is measured at
    // order item grain, customer is reachable via order_id, and product type
    // is its own native grouping.  The category card is deliberately absent
    // from the initial retrieval package and arrives only as a same-snapshot,
    // metric-declared extension.
    revenue.analyticalCapability = {
      ...revenue.analyticalCapability!,
      primaryEntityId: 'order_item',
      defaultResultGrainId: 'order_item',
      resultGrainIds: ['customer', 'customer_product_type'],
      dimensions: [
        {
          dimensionId: 'semantic:uncategorized:dimension:customers.customer_name',
          entityId: 'customer',
          label: 'Customer Name',
          aliases: ['customer', 'customers'],
          supportedRoles: ['group_by', 'display', 'rank_entity'],
          relationshipPathIds: ['relationship:order_item_to_orders', 'relationship:orders_to_customers'],
          nativeGroupingReference: 'order_id__customer__customer_name',
          nativeGroupingPath: ['order_id', 'customer'],
        },
        // These are the live Jaffle decoys that used to make a bare
        // `customer` parsed term ambiguous. They are authored categorical
        // fields, but they are not the requested customer display/rank key.
        {
          dimensionId: 'semantic:uncategorized:dimension:customers.customer_type',
          entityId: 'customer',
          label: 'Customer Type',
          aliases: ['customer'],
          supportedRoles: ['group_by', 'display', 'rank_entity'],
          relationshipPathIds: ['relationship:order_item_to_orders', 'relationship:orders_to_customers'],
          nativeGroupingReference: 'order_id__customer__customer_type',
          nativeGroupingPath: ['order_id', 'customer'],
        },
        {
          dimensionId: 'semantic:uncategorized:dimension:orders.customer_order_number',
          entityId: 'order',
          label: 'Customer Order Number',
          aliases: ['customer'],
          supportedRoles: ['group_by', 'display', 'rank_entity'],
          relationshipPathIds: ['relationship:order_item_to_orders'],
          nativeGroupingReference: 'order_id__customer_order_number',
          nativeGroupingPath: ['order_id'],
        },
        {
          dimensionId: 'semantic:uncategorized:dimension:products.product_type',
          entityId: 'product',
          label: 'Product Type',
          aliases: ['product type'],
          supportedRoles: ['group_by', 'display'],
          relationshipPathIds: ['relationship:order_item_to_products'],
          nativeGroupingReference: 'product__product_type',
          nativeGroupingPath: ['product'],
        },
      ],
    };
    const customerEntity = candidate({
      id: 'semantic:entity:customers.customer',
      qualifiedId: 'semantic:entity:customers.customer',
      kind: 'semantic_member',
      semanticObjectType: 'entity',
      trustTier: 'semantic',
      name: 'Customer',
      aliases: ['customer'],
      primaryEntity: 'customer',
      relevanceScore: 0.99,
    });
    const customerName = candidate({
      id: 'semantic:uncategorized:dimension:customers.customer_name',
      qualifiedId: 'semantic:uncategorized:dimension:customers.customer_name',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'Customer Name',
      aliases: ['customer', 'customer name'],
      primaryEntity: 'customer',
      relevanceScore: 0.94,
    });
    const customerType = candidate({
      id: 'semantic:uncategorized:dimension:customers.customer_type',
      qualifiedId: 'semantic:uncategorized:dimension:customers.customer_type',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'Customer Type',
      aliases: ['customer'],
      primaryEntity: 'customer',
      relevanceScore: 0.93,
    });
    const customerOrderNumber = candidate({
      id: 'semantic:uncategorized:dimension:orders.customer_order_number',
      qualifiedId: 'semantic:uncategorized:dimension:orders.customer_order_number',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'Customer Order Number',
      aliases: ['customer'],
      primaryEntity: 'order',
      relevanceScore: 0.92,
    });
    const categoryExtension = candidate({
      id: 'semantic:uncategorized:dimension:products.product_type',
      qualifiedId: 'semantic:uncategorized:dimension:products.product_type',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'Product Type',
      aliases: ['product type', 'product category'],
      primaryEntity: 'product',
      relevanceScore: 0.72,
      sameSnapshotRoleExtension: {
        version: 1,
        role: 'categorical_dimension',
        requestedTerm: 'product category',
        metricId: revenue.id,
        dimensionId: 'semantic:uncategorized:dimension:products.product_type',
        basis: 'exact_metricflow_grouping_dimension',
      },
    });
    // Real metadata can first yield a generic catalog record for the same
    // qualified dimension and later enrich it with the metric-declared
    // same-snapshot role proof.  The generic card does not itself prove that
    // product type is the requested categorical role, so it must not win the
    // duplicate-ID merge merely because it was retrieved first.
    const unscopedCategoryCatalogCard = candidate({
      id: categoryExtension.id,
      qualifiedId: categoryExtension.qualifiedId,
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'Native grouping field',
      aliases: ['grouping field'],
      primaryEntity: 'product',
      relevanceScore: 0.01,
    });
    const resolveMeaning = vi.fn(async () => resolved({
      // The one candidate-ID meaning call identifies only the metric and
      // entity. The host must bind the metric-native Customer Name display
      // key, not customer_type/order_number, and preserve product category.
      selectedConceptIds: [revenue.id, customerEntity.id],
      recommendedExecutionId: revenue.id,
      queryIntent: { measures: [revenue.id], dimensions: [customerEntity.id], filters: [], order: 'desc', limit: 10 },
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-customer-product-model-omission',
        sourceFingerprint: 'sha256:customer-product-model-omission',
        parsedIntent: { measures: ['revenue'], dimensions: ['product category'], filters: [], order: 'desc' },
        candidates: [revenue, customerEntity, customerName, customerType, customerOrderNumber, unscopedCategoryCatalogCard],
        clarificationCandidates: [categoryExtension],
      }),
    });

    const decision = await router.decide(request('who are the top customers who have revenue by product category?'));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(resolveMeaning.mock.calls[0]?.[0].candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: categoryExtension.id,
        sameSnapshotRoleExtension: expect.objectContaining({
          basis: 'exact_metricflow_grouping_dimension',
          requestedTerm: 'product category',
        }),
      }),
    ]));
    expect(selectRoute(request('who are the top customers who have revenue by product category?'), decision)).toBe('semantic_answer');
    expect(decision.analyticalCascadeDecision).toMatchObject({ selectedTier: 'semantic', planFrozen: true });
    // The provider did not select this ID.  It is host-preserved only because
    // the selected metric declares this exact native grouping in the same
    // snapshot, so a model omission cannot erase the explicit user role.
    // The model did not select this field, but the host must retain the exact
    // same-snapshot extension in the frozen evidence set. A partial metric
    // reaches semantic execution only when the selected capability and the
    // extension together prove the native MetricFlow grouping; dropping the
    // extension here would recreate a false pre-freeze coverage gap.
    expect(decision.meaningResolution?.selectedConceptIds).toEqual(expect.arrayContaining([
      revenue.id,
      categoryExtension.id,
    ]));
    expect(decision).toMatchObject({ requiresClarification: false });
    expect(decision.meaningResolution?.overrideReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'host_preserved',
        candidateIds: [categoryExtension.id],
      }),
    ]));
    expect(decision.resolvedAnalyticalPlan?.query.dimensions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requested: 'customer name',
        qualifiedId: customerName.qualifiedId,
        status: 'resolved',
      }),
      expect.objectContaining({
        requested: 'product category',
        qualifiedId: categoryExtension.qualifiedId,
        status: 'resolved',
      }),
    ]));
    expect(decision.resolvedAnalyticalPlan?.query.dimensions.some((dimension) =>
      dimension.qualifiedId === customerType.qualifiedId || dimension.qualifiedId === customerOrderNumber.qualifiedId,
    )).toBe(false);
    expect(decision.resolvedAnalyticalPlan?.evidenceIds).toEqual(expect.arrayContaining([
      customerName.id,
      categoryExtension.id,
    ]));
  });

  it('AGT-034 falls through a forced-unavailable semantic customer/category tuple to one safe exploratory closure', async () => {
    const source = 'runtime:relation:order_items';
    const semanticUnavailable = jaffleMetric(
      'semantic:metric:orders.revenue',
      'orders.revenue',
      ['revenue'],
      true,
      'incompatible',
    );
    const physical = [
      candidate({
        id: 'dbt:model:order_items', qualifiedId: 'dbt:model:order_items', kind: 'dbt_model', trustTier: 'exploratory',
        name: 'order_items', dimensions: [], timeGrains: [], sourceObjects: [source], relevanceScore: 0.91,
      }),
      candidate({
        id: 'dbt:column:order_items.customer_name', qualifiedId: 'dbt:column:order_items.customer_name', kind: 'sql_column', trustTier: 'exploratory',
        name: 'customer_name', aliases: ['customer', 'customer name'], dimensions: [], timeGrains: [], sourceObjects: [source], relevanceScore: 0.90,
      }),
      candidate({
        id: 'dbt:column:order_items.product_type', qualifiedId: 'dbt:column:order_items.product_type', kind: 'sql_column', trustTier: 'exploratory',
        name: 'product_type', aliases: ['product category', 'category'], dimensions: [], timeGrains: [], sourceObjects: [source], relevanceScore: 0.90,
      }),
      candidate({
        id: 'dbt:column:order_items.product_price', qualifiedId: 'dbt:column:order_items.product_price', kind: 'sql_column', trustTier: 'exploratory',
        name: 'product_price', aliases: ['product price'], dimensions: [], timeGrains: [], sourceObjects: [source], relevanceScore: 0.90,
      }),
    ];
    const router = createHybridRouter({
      requireMeaningCallForNaturalLanguage: false,
      getEvidence: async () => ({
        snapshotId: 'snapshot-customer-product-category-exploratory',
        sourceFingerprint: 'sha256:customer-product-category-exploratory',
        parsedIntent: { measures: ['revenue'], dimensions: ['product category'], filters: [], order: 'desc' },
        candidates: [semanticUnavailable, ...physical],
      }),
    });
    const ask = request('who are the top customers who have revenue by product category?');

    const decision = await router.decide(ask);
    const exploratory = decision.analyticalCascadeDecision?.attempts.find((attempt) => attempt.tier === 'exploratory_sql');

    expect(decision.action).toBe('answer');
    expect(decision.requiresClarification).not.toBe(true);
    expect(decision.clarifyingQuestion).toBeUndefined();
    expect(selectRoute(ask, decision)).toBe('generated_answer');
    expect(decision.analyticalCascadeDecision).toMatchObject({
      selectedTier: 'exploratory_sql',
      planFrozen: true,
    });
    expect(decision.meaningResolution?.queryIntent).toMatchObject({
      measures: ['revenue'],
      dimensions: expect.arrayContaining(['customer name', 'product category']),
      order: 'desc',
      limit: 10,
    });
    expect(exploratory).toMatchObject({
      outcome: 'executable',
      candidateIds: expect.arrayContaining([
        'dbt:model:order_items',
        'dbt:column:order_items.customer_name',
        'dbt:column:order_items.product_type',
        'dbt:column:order_items.product_price',
      ]),
    });
    expect(decision.analyticalCascadeDecision?.attempts.find((attempt) => attempt.tier === 'semantic')?.outcome)
      .toMatch(/ineligible|unavailable/);
  });

  it('AGT-034 freezes the exact individual order-item tuple before one exploratory SQL execution', async () => {
    const source = 'runtime:relation:order_items';
    const physical = [
      candidate({
        id: 'dbt:model:order_items', qualifiedId: 'dbt:model:order_items', kind: 'dbt_model', trustTier: 'exploratory',
        name: 'order_items', dimensions: [], timeGrains: [], sourceObjects: [source], relevanceScore: 0.93,
      }),
      candidate({
        id: 'dbt:column:order_items.order_id', qualifiedId: 'dbt:column:order_items.order_id', kind: 'sql_column', trustTier: 'exploratory',
        name: 'order_id', aliases: ['order id'], dimensions: [], timeGrains: [], sourceObjects: [source], relevanceScore: 0.92,
      }),
      candidate({
        id: 'dbt:column:order_items.product_id', qualifiedId: 'dbt:column:order_items.product_id', kind: 'sql_column', trustTier: 'exploratory',
        name: 'product_id', aliases: ['product id'], dimensions: [], timeGrains: [], sourceObjects: [source], relevanceScore: 0.92,
      }),
      candidate({
        id: 'dbt:column:order_items.product_price', qualifiedId: 'dbt:column:order_items.product_price', kind: 'sql_column', trustTier: 'exploratory',
        name: 'product_price', aliases: ['product price'], dimensions: [], timeGrains: [], sourceObjects: [source], relevanceScore: 0.94,
      }),
    ];
    const router = createHybridRouter({
      requireMeaningCallForNaturalLanguage: false,
      getEvidence: async () => ({
        snapshotId: 'snapshot-individual-order-items',
        sourceFingerprint: 'sha256:individual-order-items',
        parsedIntent: { measures: ['product price'], dimensions: [], filters: [], order: 'desc', limit: 5 },
        candidates: physical,
      }),
    });
    const ask = request('Show the five most expensive individual order items with order ID, product ID, and product price.');

    const decision = await router.decide(ask);
    const exploratory = decision.analyticalCascadeDecision?.attempts.find((attempt) => attempt.tier === 'exploratory_sql');

    expect(selectRoute(ask, decision)).toBe('generated_answer');
    expect(decision.analyticalCascadeDecision).toMatchObject({
      selectedTier: 'exploratory_sql',
      planFrozen: true,
    });
    expect(decision.meaningResolution?.hostRequirementSeed?.requirements).toMatchObject({
      grain: 'individual',
      outputTerms: ['order id', 'product id', 'product price'],
      ranking: { metricTerms: ['product price'], direction: 'top', limit: 5, defaultedLimit: false },
    });
    expect(decision.meaningResolution?.queryIntent).toMatchObject({
      measures: ['product price'],
      order: 'desc',
      limit: 5,
    });
    // These are a host-owned projection, not inferred grouping dimensions.
    // The frozen plan must retain the exact column bindings before a provider
    // can write SQL or an executor can return a "closest" partial table.
    expect(decision.resolvedAnalyticalPlan?.outputContract.requiredOutputs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requested: 'order id',
        qualifiedId: 'dbt:column:order_items.order_id',
        outputName: 'order_id',
        status: 'resolved',
      }),
      expect.objectContaining({
        requested: 'product id',
        qualifiedId: 'dbt:column:order_items.product_id',
        outputName: 'product_id',
        status: 'resolved',
      }),
      expect.objectContaining({
        requested: 'product price',
        qualifiedId: 'dbt:column:order_items.product_price',
        outputName: 'product_price',
        status: 'resolved',
      }),
    ]));
    expect(exploratory).toMatchObject({
      outcome: 'executable',
      candidateIds: expect.arrayContaining([
        'dbt:model:order_items',
        'dbt:column:order_items.order_id',
        'dbt:column:order_items.product_id',
        'dbt:column:order_items.product_price',
      ]),
    });
  });

  it('AGT-029 keeps a pre-freeze missing dimension recoverable only with qualified physical coverage', async () => {
    const revenue = jaffleMetric(
      'semantic:metric:orders.revenue',
      'orders.revenue',
      ['revenue'],
      true,
    );
    const router = createHybridRouter({
      requireMeaningCallForNaturalLanguage: false,
      getEvidence: async () => ({
        snapshotId: 'snapshot-missing-sales-channel',
        sourceFingerprint: 'sha256:missing-sales-channel',
        parsedIntent: { measures: ['revenue'], dimensions: ['sales_channel'], filters: [] },
        candidates: [
          revenue,
          candidate({ id: 'runtime:table:analytics.opportunities', qualifiedId: 'runtime:table:analytics.opportunities', kind: 'sql_table', trustTier: 'governed_sql', name: 'analytics.opportunities', sourceObjects: ['analytics.opportunities'], relevanceScore: 0.8 }),
          candidate({ id: 'runtime:column:analytics.opportunities.revenue', qualifiedId: 'runtime:column:analytics.opportunities.revenue', kind: 'sql_column', trustTier: 'governed_sql', name: 'revenue', sourceObjects: ['analytics.opportunities'], relevanceScore: 0.8 }),
          candidate({ id: 'runtime:column:analytics.opportunities.sales_channel', qualifiedId: 'runtime:column:analytics.opportunities.sales_channel', kind: 'sql_column', trustTier: 'governed_sql', name: 'sales_channel', sourceObjects: ['analytics.opportunities'], relevanceScore: 0.8 }),
        ],
      }),
    });

    const decision = await router.decide(request('Show revenue by sales channel'));

    expect(decision).toMatchObject({
      action: 'answer',
      meaningResolution: {
        compatibilityOutcome: 'modeling_gap',
        recommendedRoute: 'exploratory',
        compatibilityFailures: [expect.objectContaining({ code: 'MISSING_DIMENSION', field: 'sales channel' })],
      },
    });
    expect(decision.reason).toContain('sales channel');
    expect(decision.reason).toMatch(/relational|exploratory/i);
    expect(decision.terminalOutcome).toBeUndefined();
    expect(decision.analyticalCascadeDecision).toMatchObject({
      selectedTier: 'exploratory_sql',
      // The router freezes the selected physical closure before SQL is
      // generated; the host attaches a SQL/target authorization receipt later.
      planFrozen: true,
      attempts: expect.arrayContaining([expect.objectContaining({ tier: 'exploratory_sql', outcome: 'executable' })]),
    });
    expect(selectRoute(request('Show revenue by sales channel'), decision)).toBe('generated_answer');
  });

  it('AGT-029 extends a normal semantic modeling gap to the full immutable snapshot after the 16-card meaning cap', async () => {
    const revenue = jaffleMetric('semantic:metric:orders.revenue', 'orders.revenue', ['revenue'], true);
    const decoyBlocks = Array.from({ length: 8 }, (_, index) => candidate({
      id: `dql:block:decoy_${index}`,
      qualifiedId: `dql:block:decoy_${index}`,
      kind: 'certified_block',
      trustTier: 'certified',
      name: `Decoy governed block ${index}`,
      aliases: [`decoy ${index}`],
      dimensions: [],
      timeGrains: [],
      relevanceScore: 0.99 - index / 100,
      compatibility: 'partial',
    }));
    const decoyMembers = Array.from({ length: 8 }, (_, index) => candidate({
      id: `semantic:dimension:decoy_${index}`,
      qualifiedId: `semantic:dimension:decoy_${index}`,
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      name: `Decoy dimension ${index}`,
      aliases: [`decoy ${index}`],
      dimensions: [],
      timeGrains: [],
      relevanceScore: 0.98 - index / 100,
    }));
    // This member satisfies the compact role reservation, but the selected
    // metric does not declare it in its own semantic capability. The raw
    // relation is intentionally below the 16-card package cutoff.
    const semanticSalesChannel = candidate({
      id: 'semantic:dimension:orders.sales_channel',
      qualifiedId: 'semantic:dimension:orders.sales_channel',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      name: 'Sales Channel',
      aliases: ['sales channel'],
      dimensions: [],
      timeGrains: [],
      relevanceScore: 0.97,
    });
    const source = 'runtime:relation:analytics.orders';
    const relation = candidate({
      id: 'runtime:table:analytics.orders',
      qualifiedId: 'runtime:table:analytics.orders',
      kind: 'sql_table',
      trustTier: 'governed_sql',
      name: 'analytics.orders',
      aliases: ['orders'],
      dimensions: [],
      timeGrains: [],
      sourceObjects: [source],
      relevanceScore: 0.01,
      compatibility: 'unknown',
    });
    const rawRevenue = candidate({
      id: 'runtime:column:analytics.orders.revenue',
      qualifiedId: 'runtime:column:analytics.orders.revenue',
      kind: 'sql_column',
      trustTier: 'governed_sql',
      name: 'revenue',
      aliases: ['revenue'],
      dimensions: [],
      timeGrains: [],
      sourceObjects: [source],
      relevanceScore: 0.02,
      compatibility: 'unknown',
    });
    const rawSalesChannel = candidate({
      id: 'runtime:column:analytics.orders.sales_channel',
      qualifiedId: 'runtime:column:analytics.orders.sales_channel',
      kind: 'sql_column',
      trustTier: 'governed_sql',
      name: 'sales_channel',
      aliases: ['sales channel'],
      dimensions: [],
      timeGrains: [],
      sourceObjects: [source],
      relevanceScore: 0.02,
      compatibility: 'unknown',
    });
    const router = createHybridRouter({
      maxMeaningCandidates: 16,
      getEvidence: async () => ({
        snapshotId: 'snapshot-normal-llm-full-physical-extension',
        sourceFingerprint: 'sha256:normal-llm-full-physical-extension',
        parsedIntent: { measures: ['revenue'], dimensions: ['sales channel'], filters: [] },
        candidates: [revenue, semanticSalesChannel, ...decoyBlocks, ...decoyMembers, rawRevenue, rawSalesChannel, relation],
      }),
      resolveMeaning: async (input) => {
        expect(input.candidates).toHaveLength(16);
        expect(input.candidates.map((candidate) => candidate.id)).not.toContain(relation.id);
        return resolved({
          interpretedQuestion: 'Show revenue by sales channel.',
          questionType: 'breakdown',
          selectedConceptIds: [revenue.id],
          recommendedExecutionId: revenue.id,
          queryIntent: { measures: ['revenue'], dimensions: ['sales channel'], filters: [] },
          recommendedRoute: 'semantic',
        });
      },
    });

    const decision = await router.decide(request('Show revenue by sales channel.'));

    expect(decision).toMatchObject({
      action: 'answer',
      requiresClarification: false,
      analyticalCascadeDecision: {
        selectedTier: 'exploratory_sql',
        planFrozen: true,
      },
    });
    expect(decision.analyticalCascadeDecision?.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tier: 'exploratory_sql', outcome: 'executable', candidateIds: expect.arrayContaining([relation.id, rawRevenue.id, rawSalesChannel.id]) }),
    ]));
  });

  it('AGT-029 retains a semantic modeling gap when the full snapshot physical closure is unsafe', async () => {
    const revenue = jaffleMetric('semantic:metric:orders.revenue', 'orders.revenue', ['revenue'], true);
    const source = 'runtime:relation:analytics.orders';
    const customerSource = 'runtime:relation:analytics.customers';
    const router = createHybridRouter({
      maxMeaningCandidates: 1,
      getEvidence: async () => ({
        snapshotId: 'snapshot-normal-llm-unsafe-physical-extension',
        sourceFingerprint: 'sha256:normal-llm-unsafe-physical-extension',
        parsedIntent: { measures: ['revenue'], dimensions: ['sales channel', 'customer segment'], filters: [] },
        candidates: [
          revenue,
          candidate({ id: 'runtime:table:analytics.orders', qualifiedId: 'runtime:table:analytics.orders', kind: 'sql_table', trustTier: 'governed_sql', name: 'analytics.orders', aliases: ['orders'], dimensions: [], timeGrains: [], sourceObjects: [source], compatibility: 'unknown' }),
          candidate({ id: 'runtime:column:analytics.orders.revenue', qualifiedId: 'runtime:column:analytics.orders.revenue', kind: 'sql_column', trustTier: 'governed_sql', name: 'revenue', aliases: ['revenue'], dimensions: [], timeGrains: [], sourceObjects: [source], compatibility: 'unknown' }),
          candidate({ id: 'runtime:column:analytics.orders.sales_channel', qualifiedId: 'runtime:column:analytics.orders.sales_channel', kind: 'sql_column', trustTier: 'governed_sql', name: 'sales_channel', aliases: ['sales channel'], dimensions: [], timeGrains: [], sourceObjects: [source], compatibility: 'unknown' }),
          candidate({ id: 'runtime:table:analytics.customers', qualifiedId: 'runtime:table:analytics.customers', kind: 'sql_table', trustTier: 'governed_sql', name: 'analytics.customers', aliases: ['customers'], dimensions: [], timeGrains: [], sourceObjects: [customerSource], compatibility: 'unknown' }),
          candidate({ id: 'runtime:column:analytics.customers.customer_segment', qualifiedId: 'runtime:column:analytics.customers.customer_segment', kind: 'sql_column', trustTier: 'governed_sql', name: 'customer_segment', aliases: ['customer segment'], dimensions: [], timeGrains: [], sourceObjects: [customerSource], compatibility: 'unknown' }),
        ],
      }),
      resolveMeaning: async () => resolved({
        interpretedQuestion: 'Show revenue by sales channel and customer segment.',
        questionType: 'breakdown',
        selectedConceptIds: [revenue.id],
        recommendedExecutionId: revenue.id,
        queryIntent: { measures: ['revenue'], dimensions: ['sales channel', 'customer segment'], filters: [] },
        recommendedRoute: 'semantic',
      }),
    });

    const decision = await router.decide(request('Show revenue by sales channel and customer segment.'));

    expect(decision).toMatchObject({ action: 'block', terminalOutcome: { kind: 'modeling_gap' } });
    expect(decision.analyticalCascadeDecision).toMatchObject({
      planFrozen: false,
      attempts: expect.arrayContaining([expect.objectContaining({ tier: 'exploratory_sql', outcome: 'unavailable' })]),
    });
    expect(decision.analyticalCascadeDecision?.selectedTier).toBeUndefined();
    expect(decision.reason).toMatch(/relationship|safe|physical/i);
  });

  it('CTX-007 preserves real stale/error/skipped lane coverage and distinguishes exploratory from governed relational', async () => {
    const revenue = jaffleMetric('semantic:metric:orders.revenue', 'orders.revenue', ['revenue'], true);
    const router = createHybridRouter({
      requireMeaningCallForNaturalLanguage: false,
      getEvidence: async () => ({
        snapshotId: 'snapshot-exploratory-only', sourceFingerprint: 'sha256:exploratory-only',
        parsedIntent: { measures: ['revenue'], dimensions: ['sales_channel'], filters: [] },
        diagnostics: {
          sourceCoverage: [
            { version: 1, source: 'certified', status: 'stale', candidateIds: ['dql:block:stale'] },
            { version: 1, source: 'semantic', status: 'errored', candidateIds: ['semantic:metric:orders.revenue'] },
            { version: 1, source: 'governed_relational', status: 'skipped', candidateIds: [] },
            { version: 1, source: 'exploratory', status: 'available', candidateIds: ['runtime:table:analytics.opportunities'] },
            { version: 1, source: 'runtime_schema', status: 'available', candidateIds: ['runtime:column:analytics.opportunities.sales_channel'] },
          ],
        },
        candidates: [
          revenue,
          candidate({ id: 'runtime:table:analytics.opportunities', qualifiedId: 'runtime:table:analytics.opportunities', kind: 'sql_table', trustTier: 'governed_sql', name: 'analytics.opportunities', sourceObjects: ['analytics.opportunities'] }),
          candidate({ id: 'runtime:column:analytics.opportunities.revenue', qualifiedId: 'runtime:column:analytics.opportunities.revenue', kind: 'sql_column', trustTier: 'governed_sql', name: 'revenue', sourceObjects: ['analytics.opportunities'] }),
          candidate({ id: 'runtime:column:analytics.opportunities.sales_channel', qualifiedId: 'runtime:column:analytics.opportunities.sales_channel', kind: 'sql_column', trustTier: 'governed_sql', name: 'sales_channel', sourceObjects: ['analytics.opportunities'] }),
        ],
      }),
    });

    const decision = await router.decide(request('Show revenue by sales channel'));
    const cascade = decision.analyticalCascadeDecision!;
    expect(cascade.sourceCoverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'certified', status: 'stale' }),
      expect.objectContaining({ source: 'semantic', status: 'errored' }),
      expect.objectContaining({ source: 'governed_relational', status: 'skipped' }),
      expect.objectContaining({ source: 'exploratory', status: 'available' }),
    ]));
    expect(cascade.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tier: 'governed_relational', outcome: 'unavailable' }),
      expect.objectContaining({ tier: 'exploratory_sql', outcome: 'executable' }),
    ]));
  });

  it('AGT-029 leaves a generic coverage terminal when semantic evidence has no safe raw relation and column path', async () => {
    const revenue = jaffleMetric('semantic:metric:orders.revenue', 'orders.revenue', ['revenue'], true);
    const router = createHybridRouter({
      requireMeaningCallForNaturalLanguage: false,
      getEvidence: async () => ({
        snapshotId: 'snapshot-no-physical-path',
        sourceFingerprint: 'sha256:no-physical-path',
        parsedIntent: { measures: ['revenue'], dimensions: ['sales_channel'], filters: [] },
        candidates: [revenue],
      }),
    });

    const decision = await router.decide(request('Show revenue by sales channel'));

    expect(decision).toMatchObject({
      action: 'block',
      terminalOutcome: {
        kind: 'modeling_gap',
        code: 'ANALYTICAL_MODELING_GAP',
      },
      analyticalCascadeDecision: { planFrozen: false, stopReason: 'coverage_gap' },
    });
    // This fixture has only semantic revenue evidence. It never reached a
    // physical relationship-closure attempt, so it must not manufacture a
    // relationship-specific producer witness.
    expect(decision.terminalOutcome?.gap).toBeUndefined();
    expect(decision.reason).toMatch(/qualified raw relation|physical path/i);
    expect(selectRoute(request('Show revenue by sales channel'), decision)).toBe('blocked');
  });

  it('AGT-009/AGT-029 binds sales to the certified category-revenue output without a meaning call', async () => {
    const block = candidate({
      id: 'dql:block:food_vs_drink_revenue',
      qualifiedId: 'dql:block:food_vs_drink_revenue',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'food_vs_drink_revenue',
      aliases: ['sales by category', 'food versus drink revenue'],
      dimensions: ['category'],
      compatibility: 'compatible',
      compatibilityFacts: ['output: category', 'output: revenue'],
      exactMatch: true,
      analyticalFitClass: 'exact',
      relevanceScore: 1,
    });
    const resolveMeaning = vi.fn(async () => {
      throw new Error('The complete certified sales output must not require a meaning call.');
    });
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-sales-category',
        sourceFingerprint: 'sha256:sales-category',
        parsedIntent: { measures: ['sales'], dimensions: ['category'], filters: [] },
        candidates: [block],
      }),
    });
    const ask = request('show me sales by category');
    const decision = await router.decide(ask);

    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(selectRoute(ask, decision)).toBe('certified_answer');
    expect(decision.resolvedAnalyticalPlan?.selectedConceptIds).toEqual([block.id]);
    expect(decision.analyticalCascadeDecision).toMatchObject({
      selectedTier: 'certified',
      planFrozen: true,
    });
  });

  it('routes one authored food-and-drink revenue example before a compact missing-dimension cascade', async () => {
    const block = candidate({
      id: 'dql:block:food_vs_drink_revenue',
      qualifiedId: 'dql:block:food_vs_drink_revenue',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'food_vs_drink_revenue',
      aliases: ['revenue by food and drink'],
      dimensions: ['category'],
      compatibility: 'compatible',
      compatibilityFacts: ['output: category', 'output: revenue'],
      exactMatch: true,
      analyticalFitClass: 'exact',
      relevanceScore: 1,
    });
    const resolveMeaning = vi.fn(async () => {
      throw new Error('An authored exact certified example must be resolved before missing-dimension handling.');
    });
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-food-drink-authored-example',
        sourceFingerprint: 'sha256:food-drink-authored-example',
        // The retrieval package has literal food/drink role terms rather than
        // a physical category card. That absence is not allowed to overrule a
        // complete authored certified answer.
        parsedIntent: { measures: ['revenue'], dimensions: ['food', 'drink'], filters: [] },
        candidates: [block],
      }),
    });
    const ask = request('What is revenue by food and drink?');

    const decision = await router.decide(ask);

    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(selectRoute(ask, decision)).toBe('certified_answer');
    expect(decision.resolvedAnalyticalPlan?.selectedConceptIds).toEqual([block.id]);
    expect(decision.analyticalCascadeDecision).toMatchObject({
      selectedTier: 'certified',
      planFrozen: true,
    });
  });

  it('AGT-009 carries one exact authored food-and-drink block contract from the local context pack through catalog evidence and router freeze', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-food-drink-catalog-router-'));
    cpSync(jaffleSupplyChainFixture, projectRoot, { recursive: true });
    try {
      const question = 'What is revenue by food and drink?';
      const pack = await buildLocalContextPack(projectRoot, { question, limit: 40 });
      expect(pack.routeDecision).toMatchObject({
        route: 'certified',
        exactObjectKey: 'dql:block:food_vs_drink_revenue',
      });
      const fit = pack.retrievalDiagnostics.certifiedCandidateFits.find(
        (candidate) => candidate.objectKey === 'dql:block:food_vs_drink_revenue',
      );
      expect(fit).toMatchObject({
        action: 'certified_answer',
        fit: expect.objectContaining({ kind: 'exact', missingDimensions: [] }),
      });
      expect(fit?.fit.missingMeasures).toBeUndefined();

      const retrieval = applyContextPackCompatibility(
        toAgentRetrievalEvidence(
          pack.retrievalDiagnostics.meaningEvidence!,
          pack.questionPlan,
          {
            snapshotId: pack.freshness.fingerprint,
            sourceFingerprint: pack.freshness.fingerprint,
            contextObjects: pack.objects,
            sourceCoverage: pack.retrievalDiagnostics.sourceCoverage,
          },
        ),
        pack,
      );
      expect(retrieval.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'dql:block:food_vs_drink_revenue',
          compatibility: 'compatible',
          compatibilityFacts: expect.arrayContaining(['output: category', 'output: revenue']),
        }),
      ]));
      const resolveMeaning = vi.fn(async () => {
        throw new Error('A unique authored exact certified example must use zero meaning calls.');
      });
      const router = createHybridRouter({ getEvidence: async () => retrieval, resolveMeaning });
      const ask = request(question);
      const decision = await router.decide(ask);

      expect(resolveMeaning).not.toHaveBeenCalled();
      expect(selectRoute(ask, decision)).toBe('certified_answer');
      expect(decision.resolvedAnalyticalPlan?.selectedConceptIds).toEqual([
        'orders::block::food_vs_drink_revenue',
      ]);
      expect(decision.analyticalCascadeDecision).toMatchObject({
        selectedTier: 'certified',
        planFrozen: true,
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('AGT-009 keeps an exact certified title on the zero-call Tier 1 path when its catalog output contract is inferred', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-certified-title-router-'));
    cpSync(askObservabilityOfficeFixture, projectRoot, { recursive: true });
    try {
      const question = 'Top Customers by Revenue';
      const pack = await buildLocalContextPack(projectRoot, { question, limit: 80 });
      expect(pack.routeDecision).toMatchObject({
        route: 'certified',
        exactObjectKey: 'dql:block:Top Customers by Revenue',
      });
      const retrieval = applyContextPackCompatibility(
        toAgentRetrievalEvidence(pack.retrievalDiagnostics.meaningEvidence!, pack.questionPlan, {
          snapshotId: pack.knowledgeLens.snapshotId,
          sourceFingerprint: pack.freshness.fingerprint,
          contextObjects: pack.objects,
          retrievalLanes: pack.retrievalDiagnostics.lanes,
        }),
        pack,
      );
      expect(retrieval.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'dql:block:Top Customers by Revenue',
          compatibility: 'compatible',
          exactMatch: true,
          analyticalFitClass: 'exact',
          compatibilityFacts: expect.arrayContaining(['catalog-proven-output: revenue']),
        }),
      ]));
      const resolveMeaning = vi.fn(async () => {
        throw new Error('An exact certified title must not invoke the meaning resolver.');
      });
      const router = createHybridRouter({ getEvidence: async () => retrieval, resolveMeaning });

      const decision = await router.decide(request(question));

      expect(resolveMeaning).not.toHaveBeenCalled();
      expect(selectRoute(request(question), decision)).toBe('certified_answer');
      expect(decision.resolvedAnalyticalPlan?.selectedConceptIds).toEqual([
        'revenue_operations::block::Top Customers by Revenue',
      ]);
      expect(decision.resolvedAnalyticalPlan?.query).toMatchObject({
        measures: [{ requested: 'revenue', outputName: 'revenue', status: 'resolved' }],
        dimensions: [{ requested: 'customer name', outputName: 'customer_name', status: 'resolved' }],
        limit: 10,
      });
      expect(decision.analyticalCascadeDecision).toMatchObject({
        selectedTier: 'certified',
        planFrozen: true,
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('AGT-029 normalizes customer-count grammar and selects the one-relation exploratory closure', async () => {
    const requirements = buildAnalyticalRequirementSet({
      question: 'what is the order count for each customer?',
      parsedIntent: {
        measures: ['count', 'count for each customer', 'for each customer'],
        dimensions: ['customer'],
        filters: [],
      },
    });
    // Keep the authored business measure intact. Collapsing this to generic
    // `count` makes an unfiltered order-count metric indistinguishable from
    // scoped count metrics during the provider-free semantic fast path.
    expect(requirements.measures).toEqual(['order count']);

    const physical = [
      candidate({
        id: 'dbt:model:dim_customers', qualifiedId: 'dbt:model:dim_customers', kind: 'dbt_model', trustTier: 'exploratory',
        name: 'dim_customers', aliases: ['customers'], dimensions: [], timeGrains: [], sourceObjects: ['runtime:relation:dim_customers'],
      }),
      candidate({
        id: 'dbt:column:dim_customers.customer_name', qualifiedId: 'dbt:column:dim_customers.customer_name', kind: 'sql_column', trustTier: 'exploratory',
        name: 'customer_name', aliases: ['customer'], dimensions: [], timeGrains: [], sourceObjects: ['runtime:relation:dim_customers'],
      }),
      candidate({
        id: 'dbt:column:dim_customers.count_lifetime_orders', qualifiedId: 'dbt:column:dim_customers.count_lifetime_orders', kind: 'sql_column', trustTier: 'exploratory',
        name: 'count_lifetime_orders', aliases: ['order count', 'count'], dimensions: [], timeGrains: [], sourceObjects: ['runtime:relation:dim_customers'],
      }),
      candidate({
        id: 'dql:block:top_customers', qualifiedId: 'dql:block:top_customers', kind: 'certified_block', trustTier: 'certified',
        name: 'top_customers', compatibility: 'partial', compatibilityFacts: ['output: customer_name', 'output: lifetime_spend', 'output: order_count'],
      }),
    ];
    const router = createHybridRouter({
      requireMeaningCallForNaturalLanguage: false,
      getEvidence: async () => ({
        snapshotId: 'snapshot-order-count-each-customer',
        sourceFingerprint: 'sha256:order-count-each-customer',
        parsedIntent: {
          measures: ['count', 'count for each customer', 'for each customer'],
          dimensions: ['customer'],
          filters: [],
        },
        candidates: physical,
      }),
    });
    const ask = request('what is the order count for each customer?');
    const decision = await router.decide(ask);

    expect(selectRoute(ask, decision)).toBe('generated_answer');
    expect(decision.requiresClarification).toBe(false);
    expect(decision.clarificationOptions).toBeUndefined();
    expect(decision.analyticalCascadeDecision).toMatchObject({
      selectedTier: 'exploratory_sql',
      planFrozen: true,
      attempts: expect.arrayContaining([
        expect.objectContaining({
          tier: 'exploratory_sql',
          outcome: 'executable',
          candidateIds: expect.arrayContaining([
            'dbt:model:dim_customers',
            'dbt:column:dim_customers.customer_name',
            'dbt:column:dim_customers.count_lifetime_orders',
          ]),
        }),
      ]),
    });
    expect(decision.analyticalCascadeDecision?.attempts.find((attempt) => attempt.tier === 'exploratory_sql')?.candidateIds)
      .not.toContain('dql:block:top_customers');
  });

  it('AGT-029 selects one supplies relation for total supply cost per product without duplicate component roles', async () => {
    const source = 'runtime:relation:supplies';
    const raw = [
      candidate({ id: 'dbt:model:supplies', qualifiedId: 'dbt:model:supplies', kind: 'dbt_model', trustTier: 'exploratory', name: 'supplies', dimensions: [], timeGrains: [], sourceObjects: [source] }),
      candidate({ id: 'dbt:column:supplies.product_id', qualifiedId: 'dbt:column:supplies.product_id', kind: 'sql_column', trustTier: 'exploratory', name: 'product_id', aliases: ['product'], dimensions: [], timeGrains: [], sourceObjects: [source] }),
      candidate({ id: 'dbt:column:supplies.supply_cost', qualifiedId: 'dbt:column:supplies.supply_cost', kind: 'sql_column', trustTier: 'exploratory', name: 'supply_cost', aliases: ['supply cost'], dimensions: [], timeGrains: [], sourceObjects: [source] }),
    ];
    const router = createHybridRouter({
      requireMeaningCallForNaturalLanguage: false,
      getEvidence: async () => ({
        snapshotId: 'snapshot-supply-cost-product',
        sourceFingerprint: 'sha256:supply-cost-product',
        parsedIntent: { measures: ['total', 'total supply cost', 'supply cost'], dimensions: ['supply', 'product'], filters: [] },
        candidates: raw,
      }),
    });
    const ask = request('what is the total supply cost per product?');

    const decision = await router.decide(ask);
    const exploratory = decision.analyticalCascadeDecision?.attempts.find((attempt) => attempt.tier === 'exploratory_sql');

    expect(selectRoute(ask, decision)).toBe('generated_answer');
    expect(decision.requiresClarification).toBe(false);
    expect(exploratory).toMatchObject({
      outcome: 'executable',
      candidateIds: [
        'dbt:model:supplies',
        'dbt:column:supplies.product_id',
        'dbt:column:supplies.supply_cost',
      ],
    });
    expect(exploratory?.candidateIds).not.toContain('dbt:column:supplies.supply');
  });

  it('AGT-029 uses the same-snapshot product-category and revenue role aliases on one order_items relation', async () => {
    const source = 'runtime:relation:order_items';
    const raw = [
      candidate({ id: 'dbt:model:order_items', qualifiedId: 'dbt:model:order_items', kind: 'dbt_model', trustTier: 'exploratory', name: 'order_items', dimensions: [], timeGrains: [], sourceObjects: [source] }),
      candidate({ id: 'dbt:column:order_items.product_type', qualifiedId: 'dbt:column:order_items.product_type', kind: 'sql_column', trustTier: 'exploratory', name: 'product_type', aliases: ['product type'], dimensions: [], timeGrains: [], sourceObjects: [source] }),
      candidate({ id: 'dbt:column:order_items.product_price', qualifiedId: 'dbt:column:order_items.product_price', kind: 'sql_column', trustTier: 'exploratory', name: 'product_price', aliases: ['product price'], dimensions: [], timeGrains: [], sourceObjects: [source] }),
    ];
    const router = createHybridRouter({
      requireMeaningCallForNaturalLanguage: false,
      getEvidence: async () => ({
        snapshotId: 'snapshot-revenue-product-category',
        sourceFingerprint: 'sha256:revenue-product-category',
        parsedIntent: { measures: ['revenue'], dimensions: ['product category', 'product', 'category'], filters: [] },
        candidates: raw,
      }),
    });
    const ask = request('show revenue by product category');

    const decision = await router.decide(ask);
    const exploratory = decision.analyticalCascadeDecision?.attempts.find((attempt) => attempt.tier === 'exploratory_sql');

    expect(selectRoute(ask, decision)).toBe('generated_answer');
    expect(decision.requiresClarification).toBe(false);
    expect(exploratory).toMatchObject({
      outcome: 'executable',
      candidateIds: [
        'dbt:model:order_items',
        'dbt:column:order_items.product_price',
        'dbt:column:order_items.product_type',
      ],
    });
  });

  it('AGT-029 proves filter fields without treating Datadog, FY26, or true as physical columns', async () => {
    const raw = [
      candidate({
        id: 'dbt:model:fact_revenue', qualifiedId: 'dbt:model:fact_revenue', kind: 'dbt_model', trustTier: 'exploratory',
        name: 'fact_revenue', dimensions: [], timeGrains: [], sourceObjects: ['runtime:relation:fact_revenue'],
      }),
      candidate({
        id: 'dbt:column:fact_revenue.revenue_amount', qualifiedId: 'dbt:column:fact_revenue.revenue_amount', kind: 'sql_column', trustTier: 'exploratory',
        name: 'revenue_amount', dimensions: [], timeGrains: [], sourceObjects: ['runtime:relation:fact_revenue'],
      }),
      candidate({
        id: 'dbt:column:fact_revenue.competitor', qualifiedId: 'dbt:column:fact_revenue.competitor', kind: 'sql_column', trustTier: 'exploratory',
        name: 'competitor', dimensions: [], timeGrains: [], sourceObjects: ['runtime:relation:fact_revenue'],
      }),
      candidate({
        id: 'dbt:column:fact_revenue.fiscal_period', qualifiedId: 'dbt:column:fact_revenue.fiscal_period', kind: 'sql_column', trustTier: 'exploratory',
        name: 'fiscal_period', dimensions: [], timeGrains: [], sourceObjects: ['runtime:relation:fact_revenue'],
      }),
      candidate({
        id: 'dbt:column:fact_revenue.is_active', qualifiedId: 'dbt:column:fact_revenue.is_active', kind: 'sql_column', trustTier: 'exploratory',
        name: 'is_active', dimensions: [], timeGrains: [], sourceObjects: ['runtime:relation:fact_revenue'],
      }),
      candidate({
        id: 'dbt:column:fact_revenue.order_date', qualifiedId: 'dbt:column:fact_revenue.order_date', kind: 'sql_column', trustTier: 'exploratory',
        name: 'order_date', dimensions: [], timeGrains: [], sourceObjects: ['runtime:relation:fact_revenue'],
      }),
      candidate({
        id: 'dql:calendar:corporate', qualifiedId: 'dql:calendar:corporate', kind: 'dql_modeling', trustTier: 'governed_sql',
        name: 'Corporate Fiscal Calendar', dimensions: [], timeGrains: [],
      }),
    ];
    const router = createHybridRouter({
      requireMeaningCallForNaturalLanguage: false,
      getEvidence: async () => ({
        snapshotId: 'snapshot-member-values-are-not-fields',
        sourceFingerprint: 'sha256:member-values-are-not-fields',
        parsedIntent: {
          measures: ['revenue'],
          dimensions: ['competitor'],
          filters: [
            { field: 'competitor', value: 'Datadog' },
            { field: 'fiscal_period', value: 'FY26' },
            { field: 'is_active', value: 'true' },
          ],
        },
        fiscalCalendar: {
          id: 'dql:calendar:corporate',
          fiscalPeriodFieldId: 'dbt:column:fact_revenue.fiscal_period',
          dateRoleId: 'dbt:column:fact_revenue.order_date',
        },
        candidates: raw,
      }),
    });
    const ask = request('show revenue by competitor where competitor is Datadog in FY26 and active is true');
    const decision = await router.decide(ask);
    const exploratory = decision.analyticalCascadeDecision?.attempts.find((attempt) => attempt.tier === 'exploratory_sql');

    expect(selectRoute(ask, decision)).toBe('generated_answer');
    expect(exploratory).toMatchObject({ outcome: 'executable' });
    expect(exploratory?.candidateIds).toEqual(expect.arrayContaining([
      'dbt:model:fact_revenue',
      'dbt:column:fact_revenue.revenue_amount',
      'dbt:column:fact_revenue.competitor',
      'dbt:column:fact_revenue.fiscal_period',
      'dbt:column:fact_revenue.is_active',
    ]));
    expect(decision.reason).not.toMatch(/physical columns did not cover.*(?:datadog|fy26|true)/i);
  });

  it('OBS-012 records office-shaped roles and real pre-pruning source decisions', async () => {
    const customerTrace = candidateTraceObserver();
    const officeMetric = (
      id: string,
      name: string,
      aliases: string[],
      relevanceScore: number,
      exactMatch: boolean,
    ): AgentEvidenceCandidate => {
      const metric = jaffleMetric(id, name, aliases, exactMatch);
      return {
        ...metric,
        relevanceScore,
        dimensions: ['semantic:dimension:customer.customer_name'],
        timeGrains: ['month'],
        relationshipEvidence: ['dql:relationship:account_to_customer'],
        analyticalCapability: {
          ...metric.analyticalCapability!,
          primaryEntityId: 'semantic:entity:account_revenue',
          defaultResultGrainId: 'semantic:entity:customer',
          resultGrainIds: ['semantic:entity:customer'],
          dimensions: [{
            dimensionId: 'semantic:dimension:customer.customer_name',
            entityId: 'semantic:entity:customer',
            label: 'Customer Name',
            aliases: ['customer', 'customer name'],
            supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
            relationshipPathIds: ['dql:relationship:account_to_customer'],
            nativeGroupingReference: 'account__customer__customer_name',
            nativeGroupingPath: ['account', 'customer'],
          }],
          sourceFingerprint: `sha256:office-${id.replace(/[^a-z0-9]/gi, '')}`,
        },
      };
    };
    const revenue = {
      ...officeMetric('semantic:metric:revenue', 'Revenue', ['revenue'], 0.75, true),
      retrievalLanes: [{ lane: 'lexical' as const, rank: 1 }],
    };
    const bcm = {
      ...officeMetric('semantic:metric:bcm_run_rate', 'BCM Run Rate', ['BCM'], 0.98, true),
      // The real metadata card carries its source-model fiscal dimension. It
      // includes `account_revenue`, but that must not turn BCM into Revenue at
      // the metric reservation boundary.
      dimensions: [
        'semantic:dimension:customer.customer_name',
        'semantic:dimension:account_revenue.fiscal_period',
      ],
      retrievalLanes: [{ lane: 'lexical' as const, rank: 2 }],
    };
    const customerRouter = createHybridRouter({
      requireMeaningCallForNaturalLanguage: false,
      maxMeaningCandidates: 3,
      getEvidence: async () => ({
        snapshotId: 'fixture:office-ask-ai:v1',
        sourceFingerprint: 'sha256:office-top-customers',
        parsedIntent: { measures: ['BCM', 'revenue'], dimensions: ['customer'], filters: [] },
        candidates: [
          revenue,
          bcm,
          candidate({ id: 'semantic:entity:customer', qualifiedId: 'semantic:entity:customer', kind: 'semantic_member', semanticObjectType: 'entity', name: 'Customer', relevanceScore: 0.8, retrievalLanes: [{ lane: 'graph', rank: 1 }] }),
          candidate({ id: 'semantic:dimension:customer.customer_name', qualifiedId: 'semantic:dimension:customer.customer_name', kind: 'semantic_member', semanticObjectType: 'dimension', name: 'Customer Name', relevanceScore: 0.7, retrievalLanes: [{ lane: 'vector', rank: 1 }] }),
          candidate({ id: 'semantic:dimension:account.owner_email', qualifiedId: 'semantic:dimension:account.owner_email', kind: 'semantic_member', semanticObjectType: 'dimension', name: 'Account Owner Email', relevanceScore: 0.99 }),
          candidate({ id: 'semantic:dimension:account.sentiment', qualifiedId: 'semantic:dimension:account.sentiment', kind: 'semantic_member', semanticObjectType: 'dimension', name: 'Account Sentiment Rating', relevanceScore: 0.97 }),
        ],
      }),
    });
    const customerAsk = attachAskTraceObserverV1(
      request('Who are the top BCM customers who have highest revenue?'),
      customerTrace.observer,
    );
    const customerDecision = await customerRouter.decide(customerAsk);

    expect(customerDecision.requiresClarification).not.toBe(true);
    expect(selectRoute(customerAsk, customerDecision)).toBe('semantic_answer');
    expect(customerDecision.meaningResolution).toMatchObject({
      selectedConceptIds: ['semantic:metric:revenue'],
      recommendedExecutionId: 'semantic:metric:revenue',
      queryIntent: {
        measures: ['revenue'],
        order: 'desc',
        limit: 10,
      },
    });
    expect(customerDecision.analyticalCascadeDecision).toMatchObject({
      selectedTier: 'semantic',
      planFrozen: true,
      requirements: {
        ranking: {
          metricTerms: ['revenue'],
          limit: 10,
          defaultedLimit: true,
        },
      },
    });
    expect(customerDecision.resolvedAnalyticalPlan).toMatchObject({
      query: {
        measures: [expect.objectContaining({ qualifiedId: 'semantic:metric:revenue' })],
        limit: 10,
      },
      relationshipProofs: [expect.objectContaining({
        kind: 'semantic_native_grouping',
        dimensionId: 'semantic:dimension:customer.customer_name',
        relationshipPathIds: ['dql:relationship:account_to_customer'],
      })],
    });

    expect(customerTrace.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: 'semantic:metric:revenue', role: 'metric', source: 'semantic', decision: 'admitted' }),
      expect.objectContaining({ candidateId: 'semantic:dimension:customer.customer_name', role: 'entity_label', source: 'semantic', decision: 'admitted' }),
      expect.objectContaining({ candidateId: 'semantic:dimension:account.owner_email', role: 'categorical_dimension', source: 'semantic', decision: 'excluded', reasonCode: 'entity_label_mismatch' }),
      expect.objectContaining({ candidateId: 'semantic:dimension:account.sentiment', role: 'categorical_dimension', source: 'semantic', decision: 'excluded', reasonCode: 'entity_label_mismatch' }),
    ]));
    expect(customerTrace.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: 'semantic:metric:bcm_run_rate', role: 'metric', decision: 'excluded', reasonCode: 'explicit_measure_conflict' }),
      expect.objectContaining({ candidateId: 'semantic:entity:customer', role: 'entity_key', source: 'semantic', decision: 'retrieved' }),
    ]));
    expect(customerTrace.decisions.filter((decision) =>
      decision.candidateId === 'semantic:metric:bcm_run_rate'
      && (decision.decision === 'admitted' || decision.decision === 'reserved' || decision.decision === 'model_selected'),
    )).toEqual([]);
    expect(customerTrace.decisions.filter((decision) => decision.candidateId === 'semantic:metric:bcm_run_rate')
      .map((decision) => [decision.decision, decision.reasonCode]))
      .toEqual(expect.arrayContaining([
        ['retrieved', 'exact_name_match'],
        ['excluded', 'explicit_measure_conflict'],
      ]));
    expect(customerTrace.decisions.filter((decision) =>
      decision.candidateId === 'semantic:metric:revenue'
      && ['entity_label', 'time_dimension', 'relationship'].includes(String(decision.role)),
    )).toEqual([]);
    expect(customerTrace.decisions.filter((decision) =>
      decision.candidateId === 'semantic:metric:bcm_run_rate'
      && ['entity_label', 'time_dimension', 'relationship'].includes(String(decision.role)),
    )).toEqual([]);
    // The trace retains actual snapshot memberships. Revenue/BCM are lexical,
    // Customer Name is vector-only, and owner/sentiment remain unlabelled
    // rather than being reconstructed as lexical after fusion.
    expect(customerTrace.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'retrieval.lexical', payload: expect.objectContaining({ candidateCount: 2 }) }),
      expect.objectContaining({ name: 'retrieval.vector', payload: expect.objectContaining({ candidateCount: 1 }) }),
      expect.objectContaining({ name: 'retrieval.graph', payload: expect.objectContaining({ candidateCount: 1 }) }),
    ]));
    expect(customerTrace.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: 'semantic:metric:revenue', lane: 'lexical', lanes: [{ lane: 'lexical', rank: 1 }] }),
      expect.objectContaining({ candidateId: 'semantic:dimension:customer.customer_name', lane: 'vector', lanes: [{ lane: 'vector', rank: 1 }] }),
    ]));
    expect(customerTrace.decisions.filter((decision) => (
      (decision.candidateId === 'semantic:dimension:account.owner_email' || decision.candidateId === 'semantic:dimension:account.sentiment')
      && decision.lane === 'lexical'
    ))).toEqual([]);

    const timeTrace = candidateTraceObserver();
    const timeRouter = createHybridRouter({
      requireMeaningCallForNaturalLanguage: false,
      getEvidence: async () => ({
        snapshotId: 'fixture:office-ask-ai:v1',
        sourceFingerprint: 'sha256:office-fiscal-month',
        parsedIntent: {
          measures: ['lost opportunities count', 'lost amount'],
          dimensions: ['competitor'],
          filters: [{ field: 'competitor', value: 'Datadog' }, { field: 'fiscal_period', value: 'FY26' }],
          timeGrain: 'month',
        },
        fiscalCalendar: {
          id: 'semantic:calendar:fiscal',
          fiscalPeriodFieldId: 'dbt:column:opportunities.fiscal_period',
          dateRoleId: 'dbt:column:opportunities.close_date',
        },
        candidates: [
          candidate({ id: 'dbt:model:opportunities', qualifiedId: 'dbt:model:opportunities', kind: 'dbt_model', trustTier: 'exploratory', name: 'opportunities', relevanceScore: 0.9, dimensions: [], timeGrains: [], retrievalLanes: [{ lane: 'lexical', rank: 1 }] }),
          candidate({ id: 'dbt:column:opportunities.lost_amount', qualifiedId: 'dbt:column:opportunities.lost_amount', kind: 'sql_column', trustTier: 'exploratory', name: 'lost_amount', relevanceScore: 0.9, dimensions: [], timeGrains: [], retrievalLanes: [{ lane: 'vector', rank: 1 }] }),
          candidate({ id: 'dbt:column:opportunities.competitor', qualifiedId: 'dbt:column:opportunities.competitor', kind: 'sql_column', trustTier: 'exploratory', name: 'competitor', relevanceScore: 0.9, dimensions: [], timeGrains: [], retrievalLanes: [{ lane: 'exact', rank: 1 }] }),
          candidate({ id: 'dbt:column:opportunities.fiscal_period', qualifiedId: 'dbt:column:opportunities.fiscal_period', kind: 'sql_column', trustTier: 'exploratory', name: 'fiscal_period', relevanceScore: 0.9, dimensions: [], timeGrains: [], retrievalLanes: [{ lane: 'exact', rank: 2 }] }),
          candidate({ id: 'dbt:column:opportunities.close_date', qualifiedId: 'dbt:column:opportunities.close_date', kind: 'sql_column', trustTier: 'exploratory', name: 'close_date', relevanceScore: 0.9, dimensions: [], timeGrains: [], retrievalLanes: [{ lane: 'graph', rank: 1 }] }),
        ],
      }),
    });
    const timeAsk = attachAskTraceObserverV1(
      request('Lost opportunities count and lost amount by month for fiscal year FY26 with competitor Datadog'),
      timeTrace.observer,
    );
    await timeRouter.decide(timeAsk);

    expect(timeTrace.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: 'dbt:column:opportunities.competitor', source: 'dbt_manifest', role: 'categorical_dimension' }),
      expect.objectContaining({ candidateId: 'dbt:column:opportunities.fiscal_period', source: 'dbt_manifest', role: 'time_dimension' }),
      expect.objectContaining({ candidateId: 'dbt:column:opportunities.close_date', source: 'dbt_manifest', role: 'time_dimension' }),
      expect.objectContaining({ candidateId: 'dbt:column:opportunities.competitor', lane: 'exact', lanes: [{ lane: 'exact', rank: 1 }] }),
      expect.objectContaining({ candidateId: 'dbt:column:opportunities.close_date', lane: 'graph', lanes: [{ lane: 'graph', rank: 1 }] }),
    ]));
    expect(timeTrace.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'retrieval.graph', payload: expect.objectContaining({ candidateCount: 1 }) }),
      expect.objectContaining({ name: 'retrieval.vector', payload: expect.objectContaining({ candidateCount: 1 }) }),
    ]));
  });

  it('AGT-029 keeps a wide one-relation closure minimal so required fields survive the evidence cap', async () => {
    const source = 'runtime:relation:fact_metrics';
    const noise = Array.from({ length: 36 }, (_, index) => candidate({
      id: `dbt:column:fact_metrics.noise_${index}`,
      qualifiedId: `dbt:column:fact_metrics.noise_${index}`,
      kind: 'sql_column',
      trustTier: 'exploratory',
      name: `noise_${index}`,
      dimensions: [],
      timeGrains: [],
      sourceObjects: [source],
    }));
    const raw = [
      candidate({
        id: 'dbt:model:fact_metrics', qualifiedId: 'dbt:model:fact_metrics', kind: 'dbt_model', trustTier: 'exploratory',
        name: 'fact_metrics', dimensions: [], timeGrains: [], sourceObjects: [source],
      }),
      ...noise,
      candidate({
        id: 'dbt:column:fact_metrics.revenue_amount', qualifiedId: 'dbt:column:fact_metrics.revenue_amount', kind: 'sql_column', trustTier: 'exploratory',
        name: 'revenue_amount', dimensions: [], timeGrains: [], sourceObjects: [source],
      }),
      candidate({
        id: 'dbt:column:fact_metrics.customer_name', qualifiedId: 'dbt:column:fact_metrics.customer_name', kind: 'sql_column', trustTier: 'exploratory',
        name: 'customer_name', aliases: ['customer'], dimensions: [], timeGrains: [], sourceObjects: [source],
      }),
    ];
    const router = createHybridRouter({
      requireMeaningCallForNaturalLanguage: false,
      getEvidence: async () => ({
        snapshotId: 'snapshot-wide-physical-closure',
        sourceFingerprint: 'sha256:wide-physical-closure',
        parsedIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [] },
        candidates: raw,
      }),
    });
    const ask = request('show revenue by customer');
    const decision = await router.decide(ask);
    const candidateIds = decision.analyticalCascadeDecision?.attempts
      .find((attempt) => attempt.tier === 'exploratory_sql')?.candidateIds ?? [];

    expect(selectRoute(ask, decision)).toBe('generated_answer');
    expect(candidateIds).toEqual([
      'dbt:model:fact_metrics',
      'dbt:column:fact_metrics.customer_name',
      'dbt:column:fact_metrics.revenue_amount',
    ]);
    expect(candidateIds).toHaveLength(3);
    expect(candidateIds.some((id) => id.includes('noise_'))).toBe(false);
  });

  it('AGT-029 records the missing structured customer-to-perishable relationship closure as a pre-freeze gap', async () => {
    const physical = [
      candidate({ id: 'dbt:model:dim_customers', qualifiedId: 'dbt:model:dim_customers', kind: 'dbt_model', trustTier: 'exploratory', name: 'dim_customers', dimensions: [], timeGrains: [], sourceObjects: ['runtime:relation:dim_customers'] }),
      candidate({ id: 'dbt:model:order_items', qualifiedId: 'dbt:model:order_items', kind: 'dbt_model', trustTier: 'exploratory', name: 'order_items', dimensions: [], timeGrains: [], sourceObjects: ['runtime:relation:order_items'] }),
      candidate({ id: 'dbt:model:supplies', qualifiedId: 'dbt:model:supplies', kind: 'dbt_model', trustTier: 'exploratory', name: 'supplies', dimensions: [], timeGrains: [], sourceObjects: ['runtime:relation:supplies'] }),
      candidate({ id: 'dbt:column:dim_customers.customer_name', qualifiedId: 'dbt:column:dim_customers.customer_name', kind: 'sql_column', trustTier: 'exploratory', name: 'customer_name', aliases: ['customer'], dimensions: [], timeGrains: [], sourceObjects: ['runtime:relation:dim_customers'] }),
      candidate({ id: 'dbt:column:order_items.product_name', qualifiedId: 'dbt:column:order_items.product_name', kind: 'sql_column', trustTier: 'exploratory', name: 'product_name', aliases: ['product'], dimensions: [], timeGrains: [], sourceObjects: ['runtime:relation:order_items'] }),
      candidate({ id: 'dbt:column:supplies.is_perishable_supply', qualifiedId: 'dbt:column:supplies.is_perishable_supply', kind: 'sql_column', trustTier: 'exploratory', name: 'is_perishable_supply', aliases: ['perishable'], dimensions: [], timeGrains: [], sourceObjects: ['runtime:relation:supplies'] }),
    ];
    const router = createHybridRouter({
      requireMeaningCallForNaturalLanguage: false,
      getEvidence: async () => ({
        snapshotId: 'snapshot-perishable-customer-gap',
        sourceFingerprint: 'sha256:perishable-customer-gap',
        parsedIntent: { measures: [], dimensions: ['customer', 'product'], filters: [] },
        candidates: physical,
      }),
    });
    const ask = request('who are the top customers for perishable products');
    const decision = await router.decide(ask);

    expect(decision).toMatchObject({
      action: 'block',
      terminalOutcome: { kind: 'modeling_gap', code: 'ANALYTICAL_MODELING_GAP' },
      analyticalCascadeDecision: { planFrozen: false, stopReason: 'coverage_gap' },
    });
    expect(decision.reason).toMatch(/structured, fanout-safe exploratory join path/i);
    expect(decision.analyticalCascadeDecision?.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tier: 'certified', planFrozen: false }),
      expect.objectContaining({ tier: 'semantic', planFrozen: false }),
      expect.objectContaining({ tier: 'governed_relational', planFrozen: false }),
      expect.objectContaining({ tier: 'exploratory_sql', outcome: 'unavailable', planFrozen: false }),
    ]));
    expect(selectRoute(ask, decision)).toBe('blocked');
  });

  it('AGT-012-014 keeps the typed member filter while asking for a qualified dimension', async () => {
    const orderTotal = jaffleMetric('semantic:metric:order.order_total', 'order_total', ['total revenue', 'order total'], false);
    const productRevenue = jaffleMetric('semantic:metric:order_item.revenue', 'revenue', ['product revenue'], false);
    const drinkRevenue = jaffleMetric('semantic:metric:order_item.drink_revenue', 'drink_revenue', ['beverage revenue', 'drink revenue'], true);
    const resolveMeaning = vi.fn(async () => resolved({
      selectedConceptIds: [],
      recommendedExecutionId: undefined,
      queryIntent: { measures: ['total revenue', 'beverage revenue'], dimensions: ['customer', 'region'], filters: [{ field: 'customer', value: 'Joy Lam' }] },
      recommendedRoute: 'clarify',
      confidence: 'low',
      missingInformation: ['region is not modeled'],
      compatibilityOutcome: 'clarify',
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-jaffle-joy-clarify',
        sourceFingerprint: 'sha256:jaffle-joy-clarify',
        parsedIntent: {
          measures: ['total revenue', 'beverage revenue'],
          dimensions: ['customer_name', 'region'],
          filters: [{ field: 'customer_name', value: 'Joy Lam' }],
        },
        candidates: [
          orderTotal,
          productRevenue,
          drinkRevenue,
          candidate({ id: 'semantic:member:customer.joy_lam', kind: 'semantic_member', name: 'Joy Lam', aliases: ['Joy ram'], compatibility: 'compatible' }),
          candidate({ id: 'semantic:dimension:order.location_name', kind: 'semantic_member', name: 'location_name', primaryEntity: 'order', compatibility: 'compatible', compatibilityFacts: ['alternative-for:region'] }),
        ],
      }),
    });

    const decision = await router.decide(request(
      'what is the region for Joy lam customer? what is total revenue along with beverage revenue',
    ));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision.action).toBe('clarify');
    expect(decision.clarifyingQuestion).toContain('“region” is not modeled');
    expect(decision.clarifyingQuestion).toContain('location_name');
    expect(decision.clarificationOptions).toEqual([
      expect.objectContaining({ id: 'semantic:dimension:order.location_name' }),
    ]);
    expect(decision.resolvedAnalyticalPlan).toBeUndefined();
  });

  it('jaffle golden keeps duplicate display names qualified and clarifies gross/net/lifetime ambiguity', async () => {
    const gross = jaffleMetric('semantic:metric:orders.gross_revenue', 'Revenue', ['gross revenue'], false);
    const net = jaffleMetric('semantic:metric:orders.net_revenue', 'Revenue', ['net revenue'], false);
    const lifetime = jaffleMetric('semantic:metric:customers.lifetime_revenue', 'Revenue', ['lifetime revenue'], false);
    const resolveMeaning = vi.fn(async () => ({
      interpretedQuestion: 'Revenue.',
      questionType: 'value' as const,
      selectedConceptIds: [],
      queryIntent: { measures: ['revenue'], dimensions: [], filters: [] },
      rejectedCandidates: [
        { id: gross.id, reason: 'Gross was not specified.' },
        { id: net.id, reason: 'Net was not specified.' },
        { id: lifetime.id, reason: 'Lifetime was not specified.' },
      ],
      confidence: 'low' as const,
      missingInformation: ['Choose gross, net, or lifetime revenue.'],
      recommendedRoute: 'clarify' as const,
      clarifyingQuestion: 'Which revenue do you mean: gross, net, or customer lifetime revenue?',
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-jaffle-duplicate-names',
        sourceFingerprint: 'sha256:jaffle-duplicate-names',
        candidates: [gross, net, lifetime],
        parsedIntent: { measures: ['revenue'], dimensions: [], filters: [] },
      }),
    });

    const decision = await router.decide(request('what is revenue?'));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision.requiresClarification).toBe(true);
    expect(decision.clarifyingQuestion).toMatch(/gross, net, or customer lifetime/i);
    expect(decision.resolvedAnalyticalPlan?.selectedConceptIds).toEqual([]);
    expect(decision.meaningResolution?.rejectedCandidates.map((item) => item.id)).toEqual([gross.id, net.id, lifetime.id]);
  });

  it("retrieves before routing and sends a bounded evidence package to meaning resolution", async () => {
    const getEvidence = vi.fn(async () => evidence([
      executableSemanticCandidate(),
      candidate({
        id: "semantic:consumption:rollover_risk_amount",
        name: "Rollover Risk Amount",
        definition: "Forecasted balance at risk of expiry.",
        relevanceScore: 0.8,
      }),
    ]));
    const resolveMeaning = vi.fn(async () => resolved({
      rejectedCandidates: [{ id: "semantic:consumption:rollover_risk_amount", reason: "Risk is not actual balance." }],
    }));
    const complete = vi.fn(async () => JSON.stringify({ category: "general_knowledge" }));
    const router = createHybridRouter({ getEvidence, resolveMeaning, complete });

    const decision = await router.decide(request("Who are the top customers by monthly rollover amount?"));

    expect(getEvidence).toHaveBeenCalledTimes(1);
    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(resolveMeaning.mock.calls[0][0].candidates).toHaveLength(2);
    expect(complete).not.toHaveBeenCalled();
    expect(decision.action).toBe("answer");
    expect(decision.category).toBe("data_lookup");
    expect(decision.meaningResolution?.selectedConceptIds).toEqual(["semantic:consumption:rollover_balance_amount"]);
    expect(decision.resolvedAnalyticalPlan).toMatchObject({
      mode: 'authoritative',
      snapshotId: 'snapshot-1',
      selectedConceptIds: ['semantic:consumption:rollover_balance_amount'],
      capability: 'semantic_execution',
      query: { dimensions: [expect.objectContaining({ requested: 'customer name', status: 'resolved' })] },
    });
    expect(Object.isFrozen(decision.resolvedAnalyticalPlan)).toBe(true);
    expect(decision.retrievalEvidence?.candidateIds).toHaveLength(2);
  });

  it("keeps supplemental clarification cards out of every provider meaning carrier", async () => {
    const hostOnly = candidate({
      id: "semantic:dimension:location.location_name",
      kind: "semantic_member",
      name: "location_name",
      dimensions: ["semantic:dimension:location.location_name"],
      relevanceScore: 1,
    });
    const resolveMeaning = vi.fn(async () => resolved({
      rejectedCandidates: [{ id: "semantic:consumption:rollover_risk_amount", reason: "Risk is not actual balance." }],
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        ...evidence([
          candidate(),
          candidate({
            id: "semantic:consumption:rollover_risk_amount",
            name: "Rollover Risk Amount",
            relevanceScore: 0.8,
          }),
        ]),
        clarificationCandidates: [hostOnly],
      }),
    });

    await router.decide(request("Who are the top customers by monthly rollover amount?"));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    const input = resolveMeaning.mock.calls[0][0];
    expect(input.candidates.map((item) => item.id)).not.toContain(hostOnly.id);
    expect(input.evidence.candidates.map((item) => item.id)).not.toContain(hostOnly.id);
    expect(input.evidence.clarificationCandidates).toBeUndefined();
  });

  it("propagates the request cancellation signal into meaning resolution", async () => {
    const controller = new AbortController();
    const resolveMeaning = vi.fn(async (input: { signal?: AbortSignal }) => {
      expect(input.signal).toBe(controller.signal);
      return resolved();
    });
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => evidence([
        candidate(),
        candidate({
          id: "semantic:billing:monthly_rollover_amount",
          name: "Monthly Rollover Amount",
          relevanceScore: 0.84,
        }),
      ]),
    });

    await router.decide({ ...request("monthly rollover amount"), signal: controller.signal });

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
  });

  it("does not swallow cancellation and continue through a fallback route", async () => {
    const controller = new AbortController();
    const router = createHybridRouter({
      resolveMeaning: async () => {
        controller.abort(new Error("Stopped by user."));
        throw controller.signal.reason;
      },
      getEvidence: async () => evidence([
        candidate(),
        candidate({
          id: "semantic:billing:monthly_rollover_amount",
          name: "Monthly Rollover Amount",
          relevanceScore: 0.84,
        }),
      ]),
    });

    await expect(router.decide({
      ...request("monthly rollover amount"),
      signal: controller.signal,
    })).rejects.toThrow("Stopped by user.");
  });

  it("bypasses AI for a unique explicit qualified reference", async () => {
    const complete = vi.fn(async () => "{}");
    const resolveMeaning = vi.fn(async () => resolved());
    const router = createHybridRouter({
      complete,
      resolveMeaning,
      getEvidence: async () => evidence([executableSemanticCandidate()]),
    });
    const decision = await router.decide(request("show @metric(rollover_balance_amount) by customer"));
    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(decision.meaningResolution?.confidence).toBe("high");
    expect(selectRoute(request("q"), decision)).toBe("semantic_answer");
  });

  it("reuses the provider completion as a single bounded meaning resolver", async () => {
    const complete = vi.fn(async () => JSON.stringify(resolved({
      rejectedCandidates: [{ id: "semantic:consumption:rollover_risk_amount", reason: "Risk is a forecast." }],
    })));
    const router = createHybridRouter({
      complete,
      getEvidence: async () => evidence([
        executableSemanticCandidate({ definition: `Actual balance ${"detail ".repeat(2_000)}` }),
        candidate({
          id: "semantic:consumption:rollover_risk_amount",
          name: "Rollover Risk Amount",
          definition: `Forecasted risk ${"noise ".repeat(2_000)}`,
          relevanceScore: 0.85,
        }),
      ]),
    });
    const decision = await router.decide(request("top customers by monthly rollover balance"));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].system).toMatch(/resolve business meaning/i);
    expect(complete.mock.calls[0][0].user.length).toBeLessThan(10_000);
    expect(decision.meaningResolution?.confidence).toBe("high");
    expect(decision.action).toBe("answer");
  });

  it("uses AI when one exact name still has a materially related competing meaning", async () => {
    const resolveMeaning = vi.fn(async () => resolved());
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => evidence([
        candidate({ exactMatch: true }),
        candidate({
          id: "semantic:billing:monthly_rollover_amount",
          name: "Monthly Rollover Amount",
          definition: "New amount rolled over during the month rather than ending balance.",
          relevanceScore: 0.84,
        }),
      ]),
    });
    await router.decide(request("monthly rollover balance amount"));
    expect(resolveMeaning).toHaveBeenCalledTimes(1);
  });

  it("AGT-017/AGT-018 keeps one authored semantic metric on the v2 route when meaning resolution is unavailable", async () => {
    const semanticCapability = {
      metricId: "semantic:metric:orders.gross_revenue",
      semanticModelId: "semantic:model:orders",
      measureIds: ["semantic:measure:gross_revenue_measure"],
      primaryEntityId: "semantic:entity:order",
      defaultResultGrainId: "semantic:grain:scalar",
      resultGrainIds: ["semantic:grain:scalar"],
      aggregation: "sum" as const,
      additivity: { entities: "additive" as const, time: "additive" as const },
      dimensions: [],
      timeDimensions: [{
        dimensionId: "semantic:dimension:report_date",
        role: "report_as_of",
        supportedGrains: ["day"],
        defaultFor: ["scalar" as const],
      }],
      operations: ["filter" as const, "trend" as const],
      supportedOutputKinds: ["metric_value" as const],
      executionCapabilities: [{ route: "semantic" as const, adapterId: "metricflow" }],
      sourceFingerprint: "metric-capability-v1",
    };
    const authoredMetric = candidate({
      id: "semantic:metric:orders.gross_revenue",
      name: "orders.gross_revenue",
      aliases: ["gross_revenue", "revenue"],
      provenance: "dbt metric",
      analyticalCapability: semanticCapability,
      relevanceScore: 0.56,
    });
    const router = createHybridRouter({
      getEvidence: async () => ({
        snapshotId: "snapshot-semantic-fallback",
        parsedIntent: { measures: ["revenue"], dimensions: [], filters: [] },
        analyticalPolicies: [{
          policyId: "commerce::skill::revenue_reporting#analytical",
          sourceHash: "commerce-revenue-policy-v1",
          metricIds: [semanticCapability.metricId],
          timeRole: "report_as_of",
          calendarId: "calendar:gregorian",
          timezone: "America/Chicago",
          completenessPolicy: "latest_complete",
        }],
        candidates: [
          candidate({
            id: "dql:block:revenue_by_channel",
            kind: "certified_block",
            trustTier: "certified",
            name: "Revenue by channel",
            compatibility: "compatible",
            relevanceScore: 1,
          }),
          authoredMetric,
          candidate({
            id: "semantic:measure:orders.gross_revenue_measure",
            kind: "semantic_member",
            name: "orders.gross_revenue_measure",
            compatibility: "unknown",
            relevanceScore: 0.55,
          }),
          candidate({
            id: "semantic:metric:orders.gross_revenue_measure",
            name: "orders.gross_revenue_measure",
            aliases: ["gross_revenue_measure"],
            provenance: "dbt measure",
            analyticalCapability: {
              ...semanticCapability,
              metricId: "semantic:metric:gross_revenue_measure",
              sourceFingerprint: "measure-shim-v1",
            },
            relevanceScore: 0.54,
          }),
          candidate({
            id: "semantic:metric:gross_revenue",
            name: "gross_revenue",
            analyticalCapability: undefined,
            relevanceScore: 0.53,
          }),
        ],
      }),
      resolveMeaning: async () => {
        throw new Error("meaning provider deadline exceeded");
      },
    });

    const decision = await router.decide(request("What is revenue today?"));

    expect(decision.source).toBe("heuristic");
    expect(decision.meaningResolution?.recommendedExecutionId).toBe(authoredMetric.id);
    expect(decision.resolvedAnalyticalPlan).toMatchObject({
      schemaVersion: 2,
      executionId: authoredMetric.id,
      capability: "semantic_execution",
    });
    expect(selectRoute(request("What is revenue today?"), decision)).toBe("semantic_answer");
  });

  it("AGT-017 keeps two authored semantic metrics ambiguous when the resolver is unavailable", async () => {
    const executableMetric = (id: string, name: string): AgentEvidenceCandidate => candidate({
      id,
      name,
      aliases: ["revenue"],
      provenance: "dbt metric",
      analyticalCapability: {
        metricId: id.replace("semantic:metric:", "semantic:"),
        semanticModelId: `semantic:model:${name}`,
        measureIds: [`semantic:measure:${name}`],
        primaryEntityId: "semantic:entity:order",
        defaultResultGrainId: "semantic:grain:scalar",
        resultGrainIds: ["semantic:grain:scalar"],
        aggregation: "sum",
        additivity: { entities: "additive", time: "additive" },
        dimensions: [],
        timeDimensions: [],
        operations: ["filter"],
        supportedOutputKinds: ["metric_value"],
        executionCapabilities: [{ route: "semantic", adapterId: "metricflow" }],
        sourceFingerprint: `${name}-v1`,
      },
    });
    const router = createHybridRouter({
      getEvidence: async () => ({
        ...evidence([
          executableMetric("semantic:metric:finance.booked_revenue", "booked_revenue"),
          executableMetric("semantic:metric:billing.billed_revenue", "billed_revenue"),
        ]),
        parsedIntent: { measures: ["revenue"], dimensions: [], filters: [] },
      }),
      resolveMeaning: async () => {
        throw new Error("meaning provider unavailable");
      },
    });

    const decision = await router.decide(request("What is revenue today?"));

    expect(decision.resolvedAnalyticalPlan).toBeUndefined();
    expect(decision.meaningResolution).toBeUndefined();
  });

  it("AGT-010 avoids a duplicate meaning call and asks an identifier-bound compositional clarification", async () => {
    const resolveMeaning = vi.fn(async () => {
      throw new Error('The bounded meaning call did not add a stable product binding.');
    });
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => evidence([
        candidate({
          id: 'dql:block:top_beverage_customers',
          kind: 'certified_block',
          trustTier: 'certified',
          compatibility: 'partial',
        }),
        candidate({
          id: 'semantic:order_item:product',
          kind: 'semantic_member',
          compatibility: 'partial',
        }),
      ]),
    });

    const decision = await router.decide({
      question: 'what product they bought for this amount?',
      history: [
        { role: 'user', text: 'top beverage customers' },
        { role: 'assistant', text: 'Melissa Lopez leads beverage revenue.' },
      ],
      conversationContext: { priorResultValues: { customer_name: ['Melissa Lopez'] } },
    });

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision.action).toBe('clarify');
    expect(decision.resolvedAnalyticalPlan).toBeUndefined();
    expect(decision.clarificationOptions?.map((option) => option.id)).toEqual([
      'dql:block:top_beverage_customers',
      'semantic:order_item:product',
    ]);
    expect(decision.followsUp).toBe(true);
    expect(decision.retrievalEvidence?.candidateIds).toHaveLength(2);
  });

  it('AGT-029/EXP-001 composes the jaffle-semantic perishable-supplies fixture only after qualified relationship closure', async () => {
    const relationshipId = 'dql:relationship:product_supply_lookup';
    const relationship = automaticRelationshipProof(relationshipId);
    // These identifiers and columns are the checked-in jaffle-semantic fixture
    // shape: `order_items.product_name` is the requested display, while
    // `supplies.is_perishable_supply` is the predicate. Neither table is an
    // alternative answer to the other.
    const candidates = perishableSuppliesCompositionCandidates(relationship);
    const ask = request('which products come from perishable supplies?');
    const router = createHybridRouter({
      getEvidence: async () => ({
        snapshotId: 'snapshot-jaffle-semantic-perishable-products',
        sourceFingerprint: 'sha256:jaffle-semantic-perishable-products',
        parsedIntent: { measures: [], dimensions: [], filters: [] },
        candidates,
        diagnostics: {
          sourceCoverage: [
            { version: 1, source: 'certified', status: 'available', candidateIds: ['block:top_products'] },
            { version: 1, source: 'semantic', status: 'empty', candidateIds: [] },
            { version: 1, source: 'governed_relational', status: 'available', candidateIds: [relationshipId] },
            { version: 1, source: 'exploratory', status: 'available', candidateIds: candidates.filter((item) => item.trustTier === 'exploratory').map((item) => item.id) },
            { version: 1, source: 'dbt_manifest', status: 'available', candidateIds: ['dbt:model:order_items', 'dbt:model:supplies'] },
            { version: 1, source: 'runtime_schema', status: 'available', candidateIds: candidates.filter((item) => item.kind === 'sql_column').map((item) => item.id) },
          ],
        },
      }),
    });

    const decision = await router.decide(ask);

    expect(decision.action).toBe('answer');
    expect(decision.requiresClarification).toBe(false);
    expect(selectRoute(ask, decision)).toBe('generated_answer');
    expect(decision.analyticalCascadeDecision).toMatchObject({
      selectedTier: 'exploratory_sql',
      planFrozen: true,
      stopReason: 'selected',
    });
    expect(decision.resolvedAnalyticalPlan).toMatchObject({
      capability: 'bounded_exploration',
      mode: 'authoritative',
    });
    expect(decision.analyticalCascadeDecision?.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tier: 'governed_relational', outcome: 'ineligible' }),
      expect.objectContaining({
        tier: 'exploratory_sql',
        outcome: 'executable',
        candidateIds: expect.arrayContaining([
          'dbt:model:order_items',
          'dbt:model:supplies',
          'dbt:column:order_items.product_name',
          'dbt:column:supplies.is_perishable_supply',
          relationshipId,
        ]),
      }),
    ]));
    expect(decision.analyticalCascadeDecision?.sourceCoverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'exploratory', status: 'available' }),
      expect.objectContaining({ source: 'governed_relational', status: 'available' }),
    ]));
  });

  it('AGT-029 keeps a result-grain-only cross-entity governed capability pre-freeze and continues through the same safe physical closure', async () => {
    const relationshipId = 'dql:relationship:product_supply_lookup';
    const relationship = automaticRelationshipProof(relationshipId);
    const physical = perishableSuppliesCompositionCandidates(relationship);
    const governedRevenue = candidate({
      id: 'semantic:metric:order_items.governed_revenue',
      qualifiedId: 'semantic:metric:order_items.governed_revenue',
      kind: 'semantic_metric',
      trustTier: 'governed_sql',
      name: 'Revenue',
      aliases: ['revenue'],
      compatibility: 'compatible',
      analyticalCapability: {
        metricId: 'semantic:metric:order_items.governed_revenue',
        measureIds: ['semantic:metric:order_items.governed_revenue'],
        primaryEntityId: 'commerce::entity::order_items',
        // This broad result-grain membership was the defect: it describes a
        // possible row shape, not a selected governed relationship proof.
        resultGrainIds: ['commerce::entity::order_items', 'commerce::entity::supplies'],
        defaultResultGrainId: 'commerce::entity::order_items',
        aggregation: 'sum',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [{
          dimensionId: 'semantic:dimension:order_items.product_name',
          entityId: 'commerce::entity::order_items',
          label: 'Product Name',
          aliases: ['product name'],
          supportedRoles: ['group_by', 'display'],
        }, {
          dimensionId: 'semantic:dimension:supplies.is_perishable_supply',
          entityId: 'commerce::entity::supplies',
          label: 'Is Perishable Supply',
          aliases: ['perishable supply'],
          supportedRoles: ['filter'],
          // Deliberately no path. `resultGrainIds` must not bridge this.
          relationshipPathIds: [],
        }],
        timeDimensions: [],
        operations: ['filter', 'group'],
        supportedOutputKinds: ['dimension', 'metric_value'],
        // A raw declaration is useful catalog context, but it is not a DQL
        // compiler projection for the explicit product-name result contract.
        declaredOutputIds: ['dbt:column:order_items.product_name'],
        executionCapabilities: [{ route: 'governed_sql', adapterId: 'dql-compiler-v1' }],
        sourceFingerprint: 'sha256:result-grain-without-proof',
      },
    });
    const productName = physical.find((candidate) => candidate.id === 'dbt:column:order_items.product_name')!;
    const candidates = [governedRevenue, ...physical];
    const resolveMeaning = vi.fn(async () => ({
      interpretedQuestion: 'Show product name where perishable supply is true.',
      questionType: 'value' as const,
      selectedConceptIds: [governedRevenue.id, productName.id],
      recommendedExecutionId: governedRevenue.id,
      queryIntent: {
        measures: [],
        dimensions: ['product name'],
        filters: [{ field: 'perishable supply', value: 'true' }],
      },
      rejectedCandidates: [],
      confidence: 'high' as const,
      missingInformation: [],
      recommendedRoute: 'governed_sql' as const,
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-governed-result-grain-without-path',
        sourceFingerprint: 'sha256:governed-result-grain-without-path',
        parsedIntent: {
          measures: [],
          dimensions: ['product name'],
          filters: [{ field: 'perishable supply', value: 'true' }],
        },
        candidates,
      }),
    });

    const ask = request('Show product name where perishable supply is true.');
    const decision = await router.decide(ask);

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      action: 'answer',
      analyticalCascadeDecision: { selectedTier: 'exploratory_sql', planFrozen: true },
      resolvedAnalyticalPlan: { capability: 'bounded_exploration', recommendedRoute: 'exploratory' },
    });
    expect(decision.analyticalCascadeDecision?.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tier: 'governed_relational', outcome: 'ineligible', planFrozen: false }),
      expect.objectContaining({ tier: 'exploratory_sql', outcome: 'executable', planFrozen: true }),
    ]));
    expect(decision.resolvedAnalyticalPlan?.relationshipProofs).toEqual([]);

    // The same result-grain-only capability remains a typed pre-freeze gap
    // when its snapshot has no safe physical relationship closure. It must
    // never reach the governed compiler and fail after freeze.
    const noSafeCandidates = candidates.map((candidate) => ({
      ...candidate,
      relationshipEvidence: undefined,
      relationshipSafety: undefined,
    }));
    const noSafeProductName = noSafeCandidates.find((candidate) =>
      candidate.id === 'dbt:column:order_items.product_name')!;
    const noSafeRouter = createHybridRouter({
      resolveMeaning: async () => ({
        interpretedQuestion: ask.question,
        questionType: 'value',
        selectedConceptIds: [governedRevenue.id, noSafeProductName.id],
        recommendedExecutionId: governedRevenue.id,
        queryIntent: { measures: [], dimensions: ['product name'], filters: [{ field: 'perishable supply', value: 'true' }] },
        rejectedCandidates: [],
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'governed_sql',
      }),
      getEvidence: async () => ({
        snapshotId: 'snapshot-governed-result-grain-no-safe-path',
        sourceFingerprint: 'sha256:governed-result-grain-no-safe-path',
        parsedIntent: { measures: [], dimensions: ['product name'], filters: [{ field: 'perishable supply', value: 'true' }] },
        candidates: noSafeCandidates,
      }),
    });
    const noSafeDecision = await noSafeRouter.decide(ask);
    expect(noSafeDecision).toMatchObject({
      action: 'block',
      terminalOutcome: { kind: 'modeling_gap' },
      analyticalCascadeDecision: { planFrozen: false, stopReason: 'coverage_gap' },
    });
    expect(noSafeDecision.analyticalCascadeDecision?.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tier: 'governed_relational', outcome: 'ineligible', planFrozen: false }),
      expect.objectContaining({ tier: 'exploratory_sql', outcome: 'unavailable', planFrozen: false }),
    ]));

    // The declared path itself also has to be fresh, certified, automatic,
    // and fanout-safe. Draft is allowed only for review-required exploration;
    // stale and non-automatic records cannot authorize either frozen route.
    const governedWithDeclaredPath: AgentEvidenceCandidate = {
      ...governedRevenue,
      analyticalCapability: {
        ...governedRevenue.analyticalCapability!,
        dimensions: governedRevenue.analyticalCapability!.dimensions.map((dimension) =>
          dimension.entityId === 'commerce::entity::supplies'
            ? { ...dimension, relationshipPathIds: [relationshipId] }
            : dimension),
      },
    };
    for (const [name, proof, expectedTier] of [
      ['draft', automaticRelationshipProof(relationshipId, { status: 'draft', certificationFingerprint: undefined }), 'exploratory_sql'],
      ['stale', automaticRelationshipProof(relationshipId, { staleCertification: true }), undefined],
      ['nonautomatic', automaticRelationshipProof(relationshipId, { automaticJoinAllowed: false }), undefined],
    ] as const) {
      const invalidPhysical = perishableSuppliesCompositionCandidates(proof);
      const invalidProductName = invalidPhysical.find((candidate) => candidate.id === 'dbt:column:order_items.product_name')!;
      const invalidCandidates = [governedWithDeclaredPath, ...invalidPhysical];
      const invalidRouter = createHybridRouter({
        resolveMeaning: async () => ({
          interpretedQuestion: ask.question,
          questionType: 'value',
          selectedConceptIds: [governedWithDeclaredPath.id, invalidProductName.id],
          recommendedExecutionId: governedWithDeclaredPath.id,
          queryIntent: { measures: [], dimensions: ['product name'], filters: [{ field: 'perishable supply', value: 'true' }] },
          rejectedCandidates: [],
          confidence: 'high',
          missingInformation: [],
          recommendedRoute: 'governed_sql',
        }),
        getEvidence: async () => ({
          snapshotId: `snapshot-governed-${name}-relationship`,
          sourceFingerprint: `sha256:governed-${name}-relationship`,
          parsedIntent: { measures: [], dimensions: ['product name'], filters: [{ field: 'perishable supply', value: 'true' }] },
          candidates: invalidCandidates,
        }),
      });
      const invalidDecision = await invalidRouter.decide(ask);
      expect(invalidDecision.analyticalCascadeDecision?.attempts).toEqual(expect.arrayContaining([
        expect.objectContaining({ tier: 'governed_relational', outcome: 'ineligible', planFrozen: false }),
      ]));
      expect(invalidDecision.analyticalCascadeDecision?.selectedTier).not.toBe('governed_relational');
      expect(invalidDecision.analyticalCascadeDecision?.selectedTier).toBe(expectedTier);
      if (expectedTier === undefined) {
        expect(invalidDecision).toMatchObject({
          action: 'block',
          analyticalCascadeDecision: { planFrozen: false },
        });
      } else {
        expect(invalidDecision).toMatchObject({
          action: 'answer',
          analyticalCascadeDecision: { selectedTier: 'exploratory_sql', planFrozen: true },
        });
      }
    }
  });

  it('AGT-029 keeps an omitted governed metric output pre-freeze and continues only through the same safe physical closure', async () => {
    const question = 'Show revenue by customer with product price.';
    const source = 'runtime:relation:orders';
    // This is a deliberately complete governed capability: Product Price is
    // an authored metric the capability *could* project. The model omits it
    // from queryIntent, so the frozen query contains only Revenue. Capability
    // membership must not make the omitted output look projected by the
    // governed compiler.
    const governedRevenue = candidate({
      id: 'dql:metric:orders.revenue',
      qualifiedId: 'dql:metric:orders.revenue',
      kind: 'dql_modeling',
      trustTier: 'governed_sql',
      name: 'Revenue',
      aliases: ['revenue'],
      compatibility: 'compatible',
      analyticalCapability: {
        metricId: 'dql:metric:orders.revenue',
        measureIds: ['dql:metric:orders.revenue', 'dql:metric:orders.product_price'],
        primaryEntityId: 'commerce::entity::order',
        defaultResultGrainId: 'commerce::entity::order',
        resultGrainIds: ['commerce::entity::order'],
        aggregation: 'sum',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [{
          dimensionId: 'dql:dimension:orders.customer_name',
          entityId: 'commerce::entity::order',
          label: 'Customer Name',
          aliases: ['customer'],
          supportedRoles: ['group_by', 'display', 'rank_entity'],
        }],
        timeDimensions: [],
        operations: ['group'],
        supportedOutputKinds: ['dimension', 'metric_value'],
        executionCapabilities: [{ route: 'governed_sql', adapterId: 'dql-compiler-v1' }],
        sourceFingerprint: 'sha256:governed-omitted-product-price',
      },
    });
    const customer = candidate({
      id: 'dql:dimension:orders.customer_name',
      qualifiedId: 'dql:dimension:orders.customer_name',
      kind: 'semantic_member',
      trustTier: 'governed_sql',
      name: 'Customer Name',
      aliases: ['customer'],
      compatibility: 'compatible',
    });
    // The member shares the authored metric identity. It is the host-owned
    // output binding, not a second selected measure.
    const productPriceOutput = candidate({
      id: 'semantic:member:orders.product_price',
      qualifiedId: 'dql:metric:orders.product_price',
      kind: 'semantic_member',
      trustTier: 'governed_sql',
      name: 'Product Price',
      aliases: ['product price'],
      compatibility: 'compatible',
    });
    const physical = [
      candidate({
        id: 'dbt:model:orders', qualifiedId: 'dbt:model:orders', kind: 'dbt_model', trustTier: 'exploratory',
        name: 'orders', sourceObjects: [source], dimensions: [], timeGrains: [], relevanceScore: 0.94,
      }),
      candidate({
        id: 'dbt:column:orders.revenue', qualifiedId: 'dbt:column:orders.revenue', kind: 'sql_column', trustTier: 'exploratory',
        name: 'revenue', aliases: ['revenue'], sourceObjects: [source], dimensions: [], timeGrains: [], relevanceScore: 0.93,
      }),
      candidate({
        id: 'dbt:column:orders.customer_name', qualifiedId: 'dbt:column:orders.customer_name', kind: 'sql_column', trustTier: 'exploratory',
        name: 'customer_name', aliases: ['customer', 'customer name'], sourceObjects: [source], dimensions: [], timeGrains: [], relevanceScore: 0.92,
      }),
      candidate({
        id: 'dbt:column:orders.product_price', qualifiedId: 'dbt:column:orders.product_price', kind: 'sql_column', trustTier: 'exploratory',
        name: 'product_price', aliases: ['product price'], sourceObjects: [source], dimensions: [], timeGrains: [], relevanceScore: 0.93,
      }),
    ];
    const candidates = [governedRevenue, customer, productPriceOutput, ...physical];
    const resolveMeaning = vi.fn(async () => ({
      interpretedQuestion: question,
      questionType: 'breakdown' as const,
      // The exact adverse condition: the provider bound Revenue but omitted
      // the explicit Product Price projection.
      selectedConceptIds: [governedRevenue.id],
      recommendedExecutionId: governedRevenue.id,
      queryIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [] },
      rejectedCandidates: [],
      confidence: 'high' as const,
      missingInformation: [],
      recommendedRoute: 'governed_sql' as const,
    }));
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-governed-omitted-metric-output',
        sourceFingerprint: 'sha256:governed-omitted-metric-output',
        parsedIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [] },
        candidates,
      }),
    });

    const decision = await router.decide(request(question));

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      action: 'answer',
      analyticalCascadeDecision: { selectedTier: 'exploratory_sql', planFrozen: true },
      resolvedAnalyticalPlan: { capability: 'bounded_exploration', recommendedRoute: 'exploratory' },
    });
    expect(decision.analyticalCascadeDecision?.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tier: 'governed_relational', outcome: 'ineligible', planFrozen: false }),
      expect.objectContaining({
        tier: 'exploratory_sql',
        outcome: 'executable',
        candidateIds: expect.arrayContaining([
          'dbt:model:orders',
          'dbt:column:orders.revenue',
          'dbt:column:orders.customer_name',
          'dbt:column:orders.product_price',
        ]),
      }),
    ]));

    // No safe physical closure means the same missing frozen projection stays
    // a typed pre-freeze gap; it must never compile a partial governed query.
    const noPhysicalRouter = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        snapshotId: 'snapshot-governed-omitted-metric-output-no-physical',
        sourceFingerprint: 'sha256:governed-omitted-metric-output-no-physical',
        parsedIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [] },
        candidates: [governedRevenue, customer, productPriceOutput],
      }),
    });
    const noPhysical = await noPhysicalRouter.decide(request(question));
    expect(noPhysical).toMatchObject({
      action: 'block',
      analyticalCascadeDecision: { planFrozen: false, stopReason: 'coverage_gap' },
    });
    expect(noPhysical.analyticalCascadeDecision?.selectedTier).not.toBe('governed_relational');
    expect(noPhysical.analyticalCascadeDecision?.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tier: 'governed_relational', outcome: 'ineligible', planFrozen: false }),
      expect.objectContaining({ tier: 'exploratory_sql', outcome: 'unavailable', planFrozen: false }),
    ]));
  });

  it('AGT-029/EXP-001 permits an explicitly allowed validated draft relationship only for review-required exploration', async () => {
    // A draft relationship is not eligible for governed relational execution,
    // but the raw fallback may inspect it when the exact endpoints, keys,
    // fanout disposition, and validation proof are all present. The selected
    // tier is the contract boundary: this must never become a certified answer.
    const relationship = automaticRelationshipProof('dql:relationship:reviewed_product_supply_lookup', {
      status: 'draft',
      certificationFingerprint: undefined,
    });
    const candidates = perishableSuppliesCompositionCandidates(relationship);
    const router = createHybridRouter({
      getEvidence: async () => ({
        snapshotId: 'snapshot-reviewed-draft-relationship',
        sourceFingerprint: 'sha256:reviewed-draft-relationship',
        parsedIntent: { measures: [], dimensions: [], filters: [] },
        candidates,
      }),
    });

    const decision = await router.decide(request('which products come from perishable supplies?'));

    expect(decision).toMatchObject({
      action: 'answer',
      requiresClarification: false,
      analyticalCascadeDecision: {
        selectedTier: 'exploratory_sql',
        planFrozen: true,
      },
    });
    expect(decision.resolvedAnalyticalPlan).toMatchObject({
      capability: 'bounded_exploration',
      mode: 'authoritative',
    });
    expect(decision.analyticalCascadeDecision?.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tier: 'governed_relational', outcome: 'ineligible' }),
      expect.objectContaining({
        tier: 'exploratory_sql',
        outcome: 'executable',
        candidateIds: expect.arrayContaining([relationship.id]),
      }),
    ]));
    expect(selectRoute(request('which products come from perishable supplies?'), decision)).toBe('generated_answer');
  });

  it('AGT-029/EXP-001 indexes the checked-in jaffle-semantic proof before routing the eval question to review-required exploration', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-jaffle-semantic-router-'));
    cpSync(jaffleSemanticFixture, projectRoot, { recursive: true });
    try {
      const question = 'which products come from perishable supplies?';
      const pack = await buildLocalContextPack(projectRoot, { question, limit: 40 });
      const retrieval = toAgentRetrievalEvidence(
        pack.retrievalDiagnostics.meaningEvidence!,
        pack.questionPlan,
        {
          snapshotId: pack.freshness.fingerprint,
          sourceFingerprint: pack.freshness.fingerprint,
          contextObjects: pack.objects,
          sourceCoverage: pack.retrievalDiagnostics.sourceCoverage,
        },
      );
      const relationshipId = 'commerce::relationship::supplies_to_order_items_by_product';
      expect(retrieval.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          relationshipSafety: expect.arrayContaining([
            expect.objectContaining({
              id: relationshipId,
              from: 'commerce::entity::supplies',
              to: 'commerce::entity::order_items',
              keys: [{ from: 'product_id', to: 'product_id' }],
              status: 'certified',
              cardinality: 'one_to_many',
              fanout: 'safe',
              automaticJoinAllowed: true,
              staleCertification: false,
              validation: expect.objectContaining({ status: 'passed' }),
            }),
          ]),
        }),
      ]));

      const router = createHybridRouter({ getEvidence: async () => retrieval });
      const decision = await router.decide(request(question));

      // The router's selected `exploratory_sql` tier is deliberately mapped by
      // the engine to generated_answer/review_required; it is never presented
      // as a governed automatic answer.
      expect(decision.action).toBe('answer');
      expect(decision.requiresClarification).toBe(false);
      expect(selectRoute(request(question), decision)).toBe('generated_answer');
      expect(decision.analyticalCascadeDecision).toMatchObject({
        selectedTier: 'exploratory_sql',
        planFrozen: true,
        stopReason: 'selected',
      });
      expect(decision.analyticalCascadeDecision?.attempts).toEqual(expect.arrayContaining([
        expect.objectContaining({ tier: 'governed_relational', outcome: 'ineligible' }),
        expect.objectContaining({ tier: 'exploratory_sql', outcome: 'executable', planFrozen: true }),
      ]));
      expect(decision.analyticalCascadeDecision?.sourceCoverage).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'governed_relational', status: 'available' }),
        expect.objectContaining({ source: 'exploratory', status: 'available' }),
      ]));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('AGT-009 uses the fixture block output contract instead of falsely certifying top_customers for bare revenue', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-jaffle-semantic-certified-output-'));
    cpSync(jaffleSemanticFixture, projectRoot, { recursive: true });
    try {
      const question = 'show me revenue';
      const pack = await buildLocalContextPack(projectRoot, { question, limit: 40 });
      const retrieval = toAgentRetrievalEvidence(
        pack.retrievalDiagnostics.meaningEvidence!,
        pack.questionPlan,
        {
          snapshotId: pack.freshness.fingerprint,
          sourceFingerprint: pack.freshness.fingerprint,
          contextObjects: pack.objects,
          sourceCoverage: pack.retrievalDiagnostics.sourceCoverage,
        },
      );
      const topCustomers = retrieval.candidates.find((candidate) => candidate.id === 'dql:block:top_customers');
      const topCustomersCanonicalId = topCustomers?.qualifiedId ?? topCustomers?.id;
      expect(topCustomers?.compatibilityFacts).toEqual(expect.arrayContaining([
        'output: customer_name',
        'output: lifetime_spend',
        'output: order_count',
      ]));
      expect(topCustomers?.compatibilityFacts).not.toContain('output: revenue');

      // Simulate a stale/incorrect resolver nomination. The router must repair
      // it from the same snapshot, never borrow a neighbouring revenue metric
      // to certify the block.
      const router = createHybridRouter({
        getEvidence: async () => retrieval,
        resolveMeaning: async () => resolved({
          interpretedQuestion: question,
          questionType: 'value',
          selectedConceptIds: ['dql:block:top_customers'],
          recommendedExecutionId: 'dql:block:top_customers',
          queryIntent: { measures: ['revenue'], dimensions: [], filters: [] },
          recommendedRoute: 'certified',
        }),
      });
      const decision = await router.decide(request(question));

      expect(decision.meaningResolution?.recommendedExecutionId).not.toBe('dql:block:top_customers');
      expect(decision.resolvedAnalyticalPlan?.selectedConceptIds).not.toContain('dql:block:top_customers');
      expect(decision.resolvedAnalyticalPlan?.query.measures).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ requested: 'revenue', qualifiedId: 'dql:block:top_customers' }),
      ]));
      expect(selectRoute(request(question), decision)).not.toBe('certified_answer');
      expect(decision.analyticalCascadeDecision?.selectedTier).not.toBe('certified');
      expect(decision.analyticalCascadeDecision?.attempts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          tier: 'certified',
          outcome: 'ineligible',
          candidateIds: expect.arrayContaining([topCustomersCanonicalId]),
        }),
      ]));
      if (decision.action === 'clarify') {
        expect(decision.clarificationOptions?.map((option) => option.id)).not.toContain('dql:block:top_customers');
        expect(decision.clarificationOptions?.map((option) => option.id)).toEqual([
          'semantic:metric:order_items.product_revenue',
          'semantic:metric:orders.revenue',
        ]);
        expect(decision.clarificationOptions?.every((option) => option.id.startsWith('semantic:'))).toBe(true);
      } else {
        expect(decision.resolvedAnalyticalPlan?.recommendedRoute).toBe('semantic');
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('AGT-009/AGT-011 rejects an incompatible persisted revenue choice before plan freeze or provider dispatch', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-jaffle-semantic-structured-revenue-'));
    cpSync(jaffleSemanticFixture, projectRoot, { recursive: true });
    try {
      const question = 'show me revenue';
      const pack = await buildLocalContextPack(projectRoot, { question, limit: 40 });
      const retrieval = toAgentRetrievalEvidence(
        pack.retrievalDiagnostics.meaningEvidence!,
        pack.questionPlan,
        {
          snapshotId: pack.freshness.fingerprint,
          sourceFingerprint: pack.freshness.fingerprint,
          contextObjects: pack.objects,
          sourceCoverage: pack.retrievalDiagnostics.sourceCoverage,
        },
      );
      const revenueOptionIds = [
        'semantic:metric:order_items.product_revenue',
        'semantic:metric:orders.revenue',
      ];
      const clarificationSelection = {
        version: 1 as const,
        optionIds: revenueOptionIds,
        ambiguityCandidateIds: revenueOptionIds,
        requirements: {
          version: 1 as const,
          measures: ['revenue'],
          dimensions: [],
          entityTerms: [],
          entityDisplayTerms: [],
          memberTerms: [],
        },
        snapshotId: retrieval.snapshotId,
      };
      const resolveMeaning = vi.fn(async () => resolved());
      const router = createHybridRouter({ getEvidence: async () => retrieval, resolveMeaning });

      const rejected = await router.decide(serverIssuedSelectionRequest({
        question,
        selectedEvidenceId: 'dql:block:top_customers',
        snapshotId: retrieval.snapshotId,
        optionIds: revenueOptionIds,
        requirements: clarificationSelection.requirements,
      }));

      expect(resolveMeaning).not.toHaveBeenCalled();
      expect(rejected).toMatchObject({
        action: 'clarify',
        requiresClarification: true,
        resolvedAnalyticalPlan: undefined,
        analyticalCascadeDecision: {
          planFrozen: false,
          stopReason: 'ambiguous',
        },
        meaningResolution: {
          selectedConceptIds: [],
          compatibilityFailures: [expect.objectContaining({ code: 'INVALID_STRUCTURED_SELECTION' })],
        },
      });
      expect(rejected.analyticalCascadeDecision?.selectedTier).toBeUndefined();
      expect(rejected.clarificationOptions?.map((option) => option.id)).toEqual(revenueOptionIds);
      expect(rejected.clarificationOptions?.map((option) => option.id)).not.toContain('dql:block:top_customers');
      expect(rejected.analyticalCascadeDecision?.attempts).toEqual(expect.arrayContaining([
        expect.objectContaining({ tier: 'exploratory_sql', outcome: 'unavailable', planFrozen: false }),
      ]));

      const accepted = await router.decide(serverIssuedSelectionRequest({
        question,
        selectedEvidenceId: 'semantic:metric:orders.revenue',
        snapshotId: retrieval.snapshotId,
        optionIds: revenueOptionIds,
        requirements: clarificationSelection.requirements,
      }));

      expect(resolveMeaning).not.toHaveBeenCalled();
      expect(accepted).toMatchObject({
        action: 'block',
        requiresClarification: false,
        resolvedAnalyticalPlan: undefined,
        meaningResolution: {
          selectedConceptIds: ['semantic:metric:orders.revenue'],
          recommendedRoute: 'clarify',
        },
        analyticalCascadeDecision: {
          planFrozen: false,
          stopReason: 'coverage_gap',
        },
      });
      expect(accepted.analyticalCascadeDecision?.selectedTier).toBeUndefined();
      expect(accepted.terminalOutcome).toMatchObject({
        kind: 'modeling_gap',
        code: 'ANALYTICAL_MODELING_GAP',
      });
      expect(accepted.analyticalCascadeDecision?.attempts).toEqual(expect.arrayContaining([
        expect.objectContaining({ tier: 'semantic', outcome: 'ineligible', planFrozen: false }),
        expect.objectContaining({ tier: 'exploratory_sql', outcome: 'unavailable', planFrozen: false }),
      ]));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('AGT-010 keeps genuinely competing raw meanings as a clarification without a shared safe relationship proof', async () => {
    const raw = (id: string, name: string, kind: AgentEvidenceCandidate['kind'], sourceObjects: string[]): AgentEvidenceCandidate => candidate({
      id,
      qualifiedId: id,
      kind,
      trustTier: 'exploratory',
      name,
      aliases: [name],
      sourceObjects,
      dimensions: [],
      timeGrains: [],
      relevanceScore: 0.95,
      compatibility: 'unknown',
    });
    const candidates = [
      raw('dbt:model:order_items', 'order_items', 'dbt_model', ['runtime:relation:order_items']),
      raw('dbt:model:supplies', 'supplies', 'dbt_model', ['runtime:relation:supplies']),
      raw('dbt:column:order_items.product_id', 'product_id', 'sql_column', ['runtime:relation:order_items']),
      raw('dbt:column:supplies.product_id', 'product_id', 'sql_column', ['runtime:relation:supplies']),
      raw('dbt:column:order_items.product_name', 'product_name', 'sql_column', ['runtime:relation:order_items']),
      raw('dbt:column:supplies.is_perishable_supply', 'is_perishable_supply', 'sql_column', ['runtime:relation:supplies']),
    ];
    const ask = request('which products come from perishable supplies?');
    const router = createHybridRouter({
      getEvidence: async () => ({
        snapshotId: 'snapshot-no-relationship-proof',
        sourceFingerprint: 'sha256:no-relationship-proof',
        parsedIntent: { measures: [], dimensions: [], filters: [] },
        candidates,
      }),
    });

    const decision = await router.decide(ask);

    expect(decision.action).toBe('clarify');
    expect(decision.requiresClarification).toBe(true);
    expect(decision.analyticalCascadeDecision).toBeUndefined();
    expect(selectRoute(ask, decision)).toBe('clarify');
  });

  it('AGT-029 keeps a neutral-ID many-to-many relationship as a clarification', async () => {
    const relationship = automaticRelationshipProof('dql:relationship:product_supply_association', {
      cardinality: 'many_to_many',
    });
    const ask = request('which products come from perishable supplies?');
    const router = createHybridRouter({
      getEvidence: async () => ({
        snapshotId: 'snapshot-neutral-many-to-many',
        sourceFingerprint: 'sha256:neutral-many-to-many',
        parsedIntent: { measures: [], dimensions: [], filters: [] },
        candidates: perishableSuppliesCompositionCandidates(relationship),
      }),
    });

    const decision = await router.decide(ask);

    expect(decision.action).toBe('clarify');
    expect(decision.requiresClarification).toBe(true);
    expect(decision.analyticalCascadeDecision).toBeUndefined();
    expect(selectRoute(ask, decision)).toBe('clarify');
  });

  it('AGT-029 keeps a neutral-ID attribution-required relationship as a clarification', async () => {
    const relationship = automaticRelationshipProof('dql:relationship:product_supply_link', {
      fanout: 'attribution_required',
    });
    const ask = request('which products come from perishable supplies?');
    const router = createHybridRouter({
      getEvidence: async () => ({
        snapshotId: 'snapshot-neutral-attribution-required',
        sourceFingerprint: 'sha256:neutral-attribution-required',
        parsedIntent: { measures: [], dimensions: [], filters: [] },
        candidates: perishableSuppliesCompositionCandidates(relationship),
      }),
    });

    const decision = await router.decide(ask);

    expect(decision.action).toBe('clarify');
    expect(decision.requiresClarification).toBe(true);
    expect(decision.analyticalCascadeDecision).toBeUndefined();
    expect(selectRoute(ask, decision)).toBe('clarify');
  });

  it('AGT-029 returns a typed modeling gap for an explicitly un-attributed signal instead of unrelated ranking choices', async () => {
    const unsafeAttribution = automaticRelationshipProof('dql:relationship:competitor_observation_to_lost_opportunity', {
      from: 'revenue_operations::entity::competitor_observation',
      to: 'revenue_operations::entity::lost_opportunity',
      status: 'draft',
      cardinality: 'many_to_many',
      fanout: 'attribution_required',
      automaticJoinAllowed: false,
    });
    const safeAccountPath = automaticRelationshipProof('dql:relationship:lost_opportunity_to_account', {
      from: 'revenue_operations::entity::lost_opportunity',
      to: 'revenue_operations::entity::account',
    });
    const ask = request('Rank accounts by un-attributed competitor observation signal');
    const router = createHybridRouter({
      getEvidence: async () => ({
        snapshotId: 'snapshot-unattributed-competitor-observation',
        sourceFingerprint: 'sha256:unattributed-competitor-observation',
        parsedIntent: {
          measures: [],
          dimensions: ['account', 'un-attributed competitor observation signal'],
          filters: [],
        },
        candidates: [
          candidate({
            id: 'dql:entity:revenue_operations::entity::competitor_observation',
            qualifiedId: 'dql:entity:revenue_operations::entity::competitor_observation',
            kind: 'dql_modeling',
            trustTier: 'governed_sql',
            name: 'Competitor Observation',
            aliases: ['competitor observation'],
            relationshipEndpointIds: ['revenue_operations::entity::competitor_observation'],
            relationshipEvidence: [unsafeAttribution.id],
            relationshipSafety: [unsafeAttribution],
          }),
          candidate({
            id: 'dql:entity:revenue_operations::entity::lost_opportunity',
            qualifiedId: 'dql:entity:revenue_operations::entity::lost_opportunity',
            kind: 'dql_modeling',
            trustTier: 'governed_sql',
            name: 'Lost Opportunity',
            aliases: ['lost opportunity'],
            relationshipEndpointIds: ['revenue_operations::entity::lost_opportunity'],
            relationshipEvidence: [unsafeAttribution.id, safeAccountPath.id],
            relationshipSafety: [unsafeAttribution, safeAccountPath],
          }),
          candidate({
            id: 'dql:entity:revenue_operations::entity::account',
            qualifiedId: 'dql:entity:revenue_operations::entity::account',
            kind: 'dql_modeling',
            trustTier: 'governed_sql',
            name: 'Account',
            aliases: ['account'],
            relationshipEndpointIds: ['revenue_operations::entity::account'],
            relationshipEvidence: [safeAccountPath.id],
            relationshipSafety: [safeAccountPath],
          }),
          candidate({
            id: 'semantic:account_revenue:revenue',
            qualifiedId: 'semantic:account_revenue:revenue',
            name: 'Revenue',
            aliases: ['revenue'],
          }),
          candidate({
            id: 'dql:block:top_customers_by_revenue',
            qualifiedId: 'dql:block:top_customers_by_revenue',
            kind: 'certified_block',
            trustTier: 'certified',
            name: 'Top Customers by Revenue',
            aliases: ['top customers'],
          }),
        ],
      }),
    });

    const decision = await router.decide(ask);

    expect(decision).toMatchObject({
      action: 'block',
      requiresClarification: false,
      clarificationOptions: undefined,
      terminalOutcome: {
        kind: 'modeling_gap',
        code: 'ANALYTICAL_MODELING_GAP',
        gap: {
          code: 'MISSING_RELATIONSHIP',
          witnessCandidateIds: ['dql:relationship:competitor_observation_to_lost_opportunity'],
        },
      },
      analyticalCascadeDecision: {
        stopReason: 'denied',
        planFrozen: false,
      },
    });
    expect(decision.terminalOutcome?.gap?.missing.join(' ')).toContain('certified attribution relationship');
    expect(decision.reason).toContain('did not infer a relationship or execute a query');
    expect(decision.analyticalCascadeDecision?.attempts.map((attempt) => attempt.tier)).toEqual([
      'certified',
      'semantic',
      'governed_relational',
    ]);
    expect(decision.analyticalCascadeDecision?.attempts.at(-1)).toMatchObject({
      outcome: 'denied',
      candidateIds: ['dql:relationship:competitor_observation_to_lost_opportunity'],
    });
    expect(selectRoute(ask, decision)).toBe('blocked');
  });

  it('AGT-029 keeps cross-domain duplicate-leaf relationship evidence as a clarification', async () => {
    const relationship = automaticRelationshipProof('dql:relationship:commerce_product_supply');
    const ask = request('which products come from perishable supplies?');
    const router = createHybridRouter({
      getEvidence: async () => ({
        snapshotId: 'snapshot-cross-domain-duplicate-leaf',
        sourceFingerprint: 'sha256:cross-domain-duplicate-leaf',
        parsedIntent: { measures: [], dimensions: [], filters: [] },
        // The proof is for commerce::entity::*; the physical candidates are
        // equally named sales::entity::* endpoints. Leaf names are therefore
        // not a relationship binding and must not suppress clarification.
        candidates: perishableSuppliesCompositionCandidates(relationship, {
          display: 'sales::entity::order_items',
          predicate: 'sales::entity::supplies',
        }),
      }),
    });

    const decision = await router.decide(ask);

    expect(decision.action).toBe('clarify');
    expect(decision.requiresClarification).toBe(true);
    expect(decision.analyticalCascadeDecision).toBeUndefined();
    expect(selectRoute(ask, decision)).toBe('clarify');
  });

  it("rejects invented resolver IDs as a stable system block", async () => {
    const candidates = [candidate(), candidate({
      id: "semantic:billing:monthly_rollover_amount",
      name: "Monthly Rollover Amount",
      definition: "New balance rolled over during the month.",
      relevanceScore: 0.9,
    })];
    const router = createHybridRouter({
      getEvidence: async () => evidence(candidates),
      resolveMeaning: async () => resolved({ selectedConceptIds: ["semantic:invented"] }),
    });
    const ask = request("monthly rollover amount");
    const decision = await router.decide(ask);
    expect(decision.action).toBe("block");
    expect(decision.requiresClarification).toBe(false);
    expect(decision.meaningResolutionErrorCode).toBe('invalid_evidence_reference');
    expect(answerAnywayRoute(selectRoute(ask, decision), ask, "stakeholder", decision)).toBe("blocked");
  });

  it("keeps a low-confidence business ambiguity out of generated SQL", async () => {
    const router = createHybridRouter({
      getEvidence: async () => evidence([candidate(), candidate({
        id: "semantic:billing:monthly_rollover_amount",
        name: "Monthly Rollover Amount",
        relevanceScore: 0.9,
      })]),
      resolveMeaning: async () => resolved({
        selectedConceptIds: [],
        recommendedExecutionId: undefined,
        confidence: "low",
        recommendedRoute: "clarify",
        clarifyingQuestion: "Do you mean ending balance or newly rolled-over amount?",
      }),
    });
    const ask = request("monthly rollover amount");
    const decision = await router.decide(ask);
    expect(decision.clarifyingQuestion).toBe("Do you mean ending balance or newly rolled-over amount?");
    expect(decision.clarificationOptions).toEqual([
      expect.objectContaining({
        id: "semantic:consumption:rollover_balance_amount",
        label: "Rollover Balance Amount",
      }),
      expect.objectContaining({
        id: "semantic:billing:monthly_rollover_amount",
        label: "Monthly Rollover Amount",
      }),
    ]);
    expect(selectRoute(ask, decision)).toBe("clarify");
  });

  it('AGT-013 prohibits answer plus blocked capability from routing as an answer', () => {
    const blockedPlan = {
      mode: 'authoritative',
      capability: 'blocked',
      missingInformation: ['Requested dimension “account” is ambiguous.'],
    } as NonNullable<import('./intent-controller.js').IntentDecision['resolvedAnalyticalPlan']>;
    const impossible = {
      action: 'answer',
      confidence: 0.9,
      reason: 'legacy inconsistent decision',
      followsUp: false,
      requiresClarification: false,
      resolvedAnalyticalPlan: blockedPlan,
    } as import('./intent-controller.js').IntentDecision;

    expect(selectRoute(request('Which accounts have the most cases?'), impossible)).toBe('blocked');
    expect(answerAnywayRoute(
      selectRoute(request('Which accounts have the most cases?'), impossible),
      request('Which accounts have the most cases?'),
      'stakeholder',
      impossible,
    )).toBe('blocked');
  });

  it("AGT-011 resolves a structured clarification by stable evidence ID without another AI planning call", async () => {
    const selected = executableSemanticCandidate({
      id: "semantic:consumption:total_ccu_count",
      qualifiedId: "semantic:consumption:total_ccu_count",
      name: "Total CCU Count",
      relevanceScore: 0.7,
    });
    const resolveMeaning = vi.fn(async () => resolved());
    const router = createHybridRouter({
      maxMeaningCandidates: 2,
      resolveMeaning,
      getEvidence: async () => evidence([
        candidate(),
        candidate({
          id: "semantic:billing:monthly_rollover_amount",
          name: "Monthly Rollover Amount",
          relevanceScore: 0.9,
        }),
        selected,
      ]),
    });

    const structuredRequest = serverIssuedSelectionRequest({
      question: "Total CCU Count",
      selectedEvidenceId: selected.id,
    });
    const decision = await router.decide(structuredRequest);

    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(decision.action).toBe("answer");
    expect(decision.meaningResolution).toMatchObject({
      recommendedExecutionId: selected.id,
      selectedConceptIds: [selected.id],
      confidence: "high",
    });
    expect(selectRoute(structuredRequest, decision)).toBe("semantic_answer");
  });

  it('AGT-011 rehydrates a server-issued capability display choice into the persisted Revenue/top-10 frame without another meaning call', async () => {
    const revenue = candidate({
      id: 'semantic:metric:account_revenue.revenue',
      // Metadata object keys retain the legacy registry spelling while the
      // capability itself owns the domain-qualified metric identity. The
      // frozen plan binds the latter, as the local index does.
      qualifiedId: 'semantic:account_revenue:revenue',
      kind: 'semantic_metric',
      semanticObjectType: 'metric',
      trustTier: 'semantic',
      name: 'Revenue',
      aliases: ['revenue'],
      exactMatch: true,
      relevanceScore: 1,
      compatibility: 'compatible',
      analyticalCapability: {
        metricId: 'semantic:account_revenue:revenue',
        measureIds: ['semantic:account_revenue:revenue_measure'],
        primaryEntityId: 'semantic:entity:account',
        defaultResultGrainId: 'semantic:entity:account',
        resultGrainIds: ['semantic:entity:account'],
        aggregation: 'sum',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [{
          dimensionId: 'semantic:dimension:account_revenue.account_name',
          entityId: 'semantic:entity:account',
          label: 'Account Name',
          aliases: ['account', 'account name'],
          supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
          relationshipPathIds: ['dql:relationship:account_revenue_to_account'],
        }, {
          dimensionId: 'semantic:dimension:account_revenue.customer_name',
          entityId: 'semantic:entity:account',
          label: 'Customer Name',
          aliases: ['customer', 'customer name'],
          supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
          relationshipPathIds: ['dql:relationship:account_revenue_to_account'],
        }],
        timeDimensions: [],
        operations: ['group', 'rank'],
        supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
        executionCapabilities: [{ route: 'semantic', adapterId: 'fixture-semantic' }],
        sourceFingerprint: 'sha256:structured-dimension-revenue',
      },
    });
    const accountName = candidate({
      // This is the raw retrieval card. The resolver may instead render the
      // capability-derived `semantic:uncategorized:` option below.
      id: 'semantic:dimension:account_revenue.account_name',
      qualifiedId: 'semantic:dimension:account_revenue.account_name',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'Account Name',
      aliases: ['account name'],
      relevanceScore: 0.9,
      compatibility: 'compatible',
    });
    const customerName = candidate({
      id: 'semantic:dimension:account_revenue.customer_name',
      qualifiedId: 'semantic:dimension:account_revenue.customer_name',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'Customer Name',
      aliases: ['customer name'],
      relevanceScore: 0.89,
      compatibility: 'compatible',
    });
    const resolveMeaning = vi.fn(async () => resolved());
    const retrieval = {
      snapshotId: 'snapshot-structured-dimension',
      sourceFingerprint: 'sha256:structured-dimension',
      parsedIntent: { measures: ['revenue'], dimensions: [], filters: [], order: 'desc' as const, limit: 10 },
      candidates: [revenue, accountName, customerName],
    } satisfies AgentRetrievalEvidence;
    const router = createHybridRouter({ getEvidence: async () => retrieval, resolveMeaning });
    const question = 'Show the top names by revenue';
    const offeredAccountNameId = 'semantic:uncategorized:dimension:account_revenue.account_name';
    const offeredCustomerNameId = 'semantic:uncategorized:dimension:account_revenue.customer_name';
    const structuredRequest = serverIssuedSelectionRequest({
      question,
      // Reproduce the built-CLI shape: this freshly offered stable option is
      // not itself a raw retrieval card, but it is an authored child of the
      // Revenue capability in the same snapshot.
      selectedEvidenceId: offeredCustomerNameId,
      snapshotId: retrieval.snapshotId,
      optionIds: [offeredAccountNameId, offeredCustomerNameId],
      requirements: {
        version: 1,
        measures: ['revenue'],
        dimensions: [],
        entityTerms: [],
        entityDisplayTerms: [],
        memberTerms: [],
        ranking: {
          metricTerms: ['revenue'],
          entityTerms: [],
          direction: 'top',
          limit: 10,
          defaultedLimit: true,
        },
      },
    });

    const decision = await router.decide(structuredRequest);

    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(decision.requiresClarification).toBe(false);
    expect(decision.meaningResolution).toMatchObject({
      recommendedExecutionId: revenue.id,
      recommendedRoute: 'semantic',
      selectedConceptIds: expect.arrayContaining([revenue.id, offeredCustomerNameId]),
      queryIntent: { measures: ['revenue'], limit: 10 },
    });
    expect(decision.resolvedAnalyticalPlan).toMatchObject({
      recommendedRoute: 'semantic',
      analyticalFrame: expect.objectContaining({
        ranking: expect.objectContaining({
          entityDimensionId: 'semantic:dimension:account_revenue.customer_name',
          byMetricId: 'semantic:account_revenue:revenue',
          limit: 10,
        }),
      }),
    });
    expect(selectRoute(structuredRequest, decision)).toBe('semantic_answer');

    // The capability happens to define Customer Name, but a server-issued
    // Account Name-only selection cannot be broadened by a forged browser ID.
    const foreign = await router.decide(serverIssuedSelectionRequest({
      question,
      selectedEvidenceId: offeredCustomerNameId,
      snapshotId: retrieval.snapshotId,
      optionIds: [offeredAccountNameId],
      requirements: {
        version: 1,
        measures: ['revenue'],
        dimensions: [],
        entityTerms: [],
        entityDisplayTerms: [],
        memberTerms: [],
      },
    }));
    // Invalid choices fail closed. A renderer may offer a fresh choice only
    // when it can still reconstruct that original option set safely.
    expect(foreign.action).not.toBe('answer');
    expect(foreign.resolvedAnalyticalPlan).toBeUndefined();
    expect(foreign.reason).toMatch(/no longer present|not one of the persisted ambiguity choices/i);
    expect(foreign.analyticalCascadeDecision).toMatchObject({ planFrozen: false });

    // The exact same server-issued option cannot be reused after its snapshot
    // boundary changes, even if the current capability would otherwise match.
    const stale = await router.decide(serverIssuedSelectionRequest({
      question,
      selectedEvidenceId: offeredCustomerNameId,
      snapshotId: 'snapshot-structured-dimension-stale',
      optionIds: [offeredAccountNameId, offeredCustomerNameId],
      requirements: {
        version: 1,
        measures: ['revenue'],
        dimensions: [],
        entityTerms: [],
        entityDisplayTerms: [],
        memberTerms: [],
      },
    }));
    expect(stale.action).not.toBe('answer');
    expect(stale.resolvedAnalyticalPlan).toBeUndefined();
    expect(stale.reason).toMatch(/stale retrieval snapshot/i);
    expect(stale.analyticalCascadeDecision).toMatchObject({ planFrozen: false });
  });

  it('AGT-011 fails closed for no-thread, malformed, and stale structured selections before meaning or execution', async () => {
    const selected = candidate({
      id: 'semantic:metric:total_ccu_count',
      qualifiedId: 'semantic:metric:total_ccu_count',
      name: 'Total CCU Count',
      aliases: ['total ccu count'],
    });
    const resolveMeaning = vi.fn(async () => resolved());
    const router = createHybridRouter({
      getEvidence: async () => evidence([selected]),
      resolveMeaning,
    });
    const requirements = {
      version: 1 as const,
      measures: ['total ccu count'],
      dimensions: [],
      entityTerms: [],
      entityDisplayTerms: [],
      memberTerms: [],
    };
    const noThread = await router.decide({
      question: 'show total CCU count',
      selectedEvidenceId: selected.id,
    });
    const malformed = await router.decide({
      question: 'show total CCU count',
      selectedEvidenceId: selected.id,
      threadId: 'thread-structured-selection',
      conversationContext: {
        conversationEnvelope: {
          version: 1,
          threadId: 'thread-structured-selection',
          recentTurns: [],
          pendingClarification: {
            sourceTurnId: 'turn-structured-selection',
            question: 'Which CCU metric?',
            selection: {
              version: 1,
              optionIds: [selected.id],
              ambiguityCandidateIds: [selected.id],
              // Deliberately no requirements/snapshot/host authority.
            },
          },
        },
      },
    });
    const forged = await router.decide({
      ...serverIssuedSelectionRequest({
        question: 'show total CCU count',
        selectedEvidenceId: selected.id,
        requirements,
      }),
      conversationContext: {
        ...serverIssuedSelectionRequest({
          question: 'show total CCU count',
          selectedEvidenceId: selected.id,
          requirements,
        }).conversationContext,
        serverIssuedClarificationSelection: {
          version: 1,
          threadId: 'thread-router-selection',
          // A client can write JSON shaped like an authority record, but it
          // cannot bind it to the server's persisted clarification turn.
          sourceTurnId: 'forged-turn',
          snapshotId: 'snapshot-1',
        },
      },
    });
    const stale = await router.decide({
      ...serverIssuedSelectionRequest({
        question: 'show total CCU count',
        selectedEvidenceId: selected.id,
        snapshotId: 'snapshot-stale',
        requirements,
      }),
    });

    for (const decision of [noThread, malformed, forged, stale]) {
      expect(decision.action).toBe('clarify');
      expect(decision.requiresClarification).toBe(true);
      expect(decision.analyticalCascadeDecision).toMatchObject({ planFrozen: false });
      expect(decision.analyticalCascadeDecision?.selectedTier).toBeUndefined();
      expect(decision.analyticalCascadeDecision?.attempts).toEqual(expect.arrayContaining([
        expect.objectContaining({ tier: 'exploratory_sql', outcome: 'unavailable', planFrozen: false }),
      ]));
      expect(selectRoute({ question: 'show total CCU count' }, decision)).not.toBe('generated_answer');
    }
    expect(resolveMeaning).not.toHaveBeenCalled();
  });

  it("keeps an incomplete structured choice bound but blocks without a qualified physical path", async () => {
    const selected = candidate({
      id: "semantic:sales:lost_opportunities_count",
      name: "Lost Opportunities Count",
      aliases: ["lost_opportunities_count"],
      dimensions: ["fiscal_month"],
    });
    const router = createHybridRouter({
      getEvidence: async () => ({
        ...evidence([selected]),
        parsedIntent: {
          measures: ["lost opportunities count", "lost amount"],
          dimensions: ["fiscal month"],
          filters: [{ field: "competitor", value: "Splunk" }],
        },
      }),
    });
    const ask = serverIssuedSelectionRequest({
      question: "Lost opportunities count and lost amount by fiscal month where competitor is Splunk",
      selectedEvidenceId: selected.id,
    });

    const decision = await router.decide(ask);

    expect(decision.action).toBe("block");
    expect(decision.requiresClarification).toBe(false);
    expect(decision.clarificationOptions).toBeUndefined();
    expect(decision.meaningResolution).toMatchObject({
      selectedConceptIds: [selected.id],
      compatibilityOutcome: 'modeling_gap',
    });
    expect(decision.reason).toMatch(/will not substitute|qualified raw relation/i);
    expect(decision.terminalOutcome).toMatchObject({ kind: 'modeling_gap', code: 'ANALYTICAL_MODELING_GAP' });
    expect(decision.analyticalCascadeDecision).toMatchObject({
      stopReason: 'coverage_gap',
      attempts: expect.arrayContaining([expect.objectContaining({ tier: 'exploratory_sql', outcome: 'unavailable' })]),
    });
    expect(selectRoute(ask, decision)).toBe("blocked");
  });

  it("continues an incomplete structured choice only through a qualified review-required exploratory cascade", async () => {
    const selected = candidate({
      id: "semantic:sales:lost_opportunities_count",
      name: "Lost Opportunities Count",
      aliases: ["lost_opportunities_count"],
      dimensions: ["fiscal_month"],
    });
    const raw = [
      candidate({ id: 'runtime:table:analytics.opportunities', qualifiedId: 'runtime:table:analytics.opportunities', kind: 'sql_table', trustTier: 'governed_sql', name: 'analytics.opportunities', sourceObjects: ['analytics.opportunities'] }),
      candidate({ id: 'runtime:column:analytics.opportunities.lost_opportunities_count', qualifiedId: 'runtime:column:analytics.opportunities.lost_opportunities_count', kind: 'sql_column', trustTier: 'governed_sql', name: 'lost_opportunities_count', sourceObjects: ['analytics.opportunities'] }),
      candidate({ id: 'runtime:column:analytics.opportunities.lost_amount', qualifiedId: 'runtime:column:analytics.opportunities.lost_amount', kind: 'sql_column', trustTier: 'governed_sql', name: 'lost_amount', sourceObjects: ['analytics.opportunities'] }),
      candidate({ id: 'runtime:column:analytics.opportunities.fiscal_month', qualifiedId: 'runtime:column:analytics.opportunities.fiscal_month', kind: 'sql_column', trustTier: 'governed_sql', name: 'fiscal_month', sourceObjects: ['analytics.opportunities'] }),
      candidate({ id: 'runtime:column:analytics.opportunities.competitor', qualifiedId: 'runtime:column:analytics.opportunities.competitor', kind: 'sql_column', trustTier: 'governed_sql', name: 'competitor', sourceObjects: ['analytics.opportunities'] }),
    ];
    const router = createHybridRouter({
      getEvidence: async () => ({
        ...evidence([selected, ...raw]),
        parsedIntent: {
          measures: ["lost opportunities count", "lost amount"],
          dimensions: ["fiscal month"],
          filters: [{ field: "competitor", value: "Splunk" }],
        },
      }),
    });
    const ask = serverIssuedSelectionRequest({
      question: "Lost opportunities count and lost amount by fiscal month where competitor is Splunk",
      selectedEvidenceId: selected.id,
    });

    const decision = await router.decide(ask);

    expect(decision).toMatchObject({
      action: 'answer',
      requiresClarification: false,
      meaningResolution: {
        selectedConceptIds: expect.arrayContaining([
          'runtime:table:analytics.opportunities',
          'runtime:column:analytics.opportunities.lost_opportunities_count',
          'runtime:column:analytics.opportunities.lost_amount',
        ]),
        recommendedRoute: 'exploratory',
        compatibilityOutcome: 'modeling_gap',
      },
      // A safe physical closure freezes before SQL generation. Only the
      // matching SQL authorization receipt may execute that frozen plan.
      analyticalCascadeDecision: { selectedTier: 'exploratory_sql', planFrozen: true },
    });
    expect(decision.analyticalCascadeDecision?.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tier: 'semantic', outcome: 'ineligible', candidateIds: expect.arrayContaining([selected.id]) }),
      expect.objectContaining({
        tier: 'exploratory_sql',
        outcome: 'executable',
        // The closure is intentionally its relation plus exact required field
        // witnesses; unrelated schema columns are not compiler authority.
        candidateIds: [
          'runtime:table:analytics.opportunities',
          'runtime:column:analytics.opportunities.competitor',
          'runtime:column:analytics.opportunities.lost_amount',
          'runtime:column:analytics.opportunities.lost_opportunities_count',
        ],
      }),
    ]));
    expect(selectRoute(ask, decision)).toBe("generated_answer");
  });

  it('AGT-011 continues an incomplete server-issued selection through the full snapshot after the 16-card package cap', async () => {
    const selected = candidate({
      id: 'semantic:sales:lost_opportunities_count',
      qualifiedId: 'semantic:sales:lost_opportunities_count',
      name: 'Lost Opportunities Count',
      aliases: ['lost opportunities count'],
      dimensions: ['fiscal month'],
      timeGrains: [],
    });
    const source = 'analytics.opportunities';
    const raw = [
      candidate({ id: 'runtime:table:analytics.opportunities', qualifiedId: 'runtime:table:analytics.opportunities', kind: 'sql_table', trustTier: 'governed_sql', name: 'analytics.opportunities', aliases: ['opportunities'], dimensions: [], timeGrains: [], sourceObjects: [source], relevanceScore: 0.01, compatibility: 'unknown' }),
      candidate({ id: 'runtime:column:analytics.opportunities.lost_opportunities_count', qualifiedId: 'runtime:column:analytics.opportunities.lost_opportunities_count', kind: 'sql_column', trustTier: 'governed_sql', name: 'lost_opportunities_count', aliases: ['lost opportunities count'], dimensions: [], timeGrains: [], sourceObjects: [source], relevanceScore: 0.02, compatibility: 'unknown' }),
      candidate({ id: 'runtime:column:analytics.opportunities.lost_amount', qualifiedId: 'runtime:column:analytics.opportunities.lost_amount', kind: 'sql_column', trustTier: 'governed_sql', name: 'lost_amount', aliases: ['lost amount'], dimensions: [], timeGrains: [], sourceObjects: [source], relevanceScore: 0.02, compatibility: 'unknown' }),
      candidate({ id: 'runtime:column:analytics.opportunities.fiscal_month', qualifiedId: 'runtime:column:analytics.opportunities.fiscal_month', kind: 'sql_column', trustTier: 'governed_sql', name: 'fiscal_month', aliases: ['fiscal month'], dimensions: [], timeGrains: [], sourceObjects: [source], relevanceScore: 0.02, compatibility: 'unknown' }),
      candidate({ id: 'runtime:column:analytics.opportunities.competitor', qualifiedId: 'runtime:column:analytics.opportunities.competitor', kind: 'sql_column', trustTier: 'governed_sql', name: 'competitor', aliases: ['competitor'], dimensions: [], timeGrains: [], sourceObjects: [source], relevanceScore: 0.02, compatibility: 'unknown' }),
    ];
    const decoys = Array.from({ length: 18 }, (_, index) => candidate({
      id: `dql:block:structured_selection_decoy_${index}`,
      qualifiedId: `dql:block:structured_selection_decoy_${index}`,
      kind: 'certified_block',
      trustTier: 'certified',
      name: `Structured selection decoy ${index}`,
      aliases: [`decoy ${index}`],
      dimensions: [],
      timeGrains: [],
      relevanceScore: 0.99 - index / 100,
      compatibility: 'partial',
    }));
    const router = createHybridRouter({
      maxMeaningCandidates: 16,
      getEvidence: async () => ({
        snapshotId: 'snapshot-structured-full-physical-extension',
        sourceFingerprint: 'sha256:structured-full-physical-extension',
        parsedIntent: {
          measures: ['lost opportunities count', 'lost amount'],
          dimensions: ['fiscal month'],
          filters: [{ field: 'competitor', value: 'Splunk' }],
        },
        candidates: [selected, ...decoys, ...raw],
      }),
    });
    const ask = serverIssuedSelectionRequest({
      question: 'Lost opportunities count and lost amount by fiscal month where competitor is Splunk',
      selectedEvidenceId: selected.id,
      snapshotId: 'snapshot-structured-full-physical-extension',
      optionIds: [selected.id],
    });

    const decision = await router.decide(ask);

    expect(decision).toMatchObject({
      action: 'answer',
      requiresClarification: false,
      meaningResolution: {
        selectedConceptIds: expect.arrayContaining([
          raw[0]!.id,
          raw[1]!.id,
          raw[2]!.id,
          raw[3]!.id,
          raw[4]!.id,
        ]),
        recommendedRoute: 'exploratory',
      },
      analyticalCascadeDecision: {
        selectedTier: 'exploratory_sql',
        planFrozen: true,
      },
    });
    expect(decision.analyticalCascadeDecision?.attempts.find((attempt) => attempt.tier === 'exploratory_sql')).toMatchObject({
      outcome: 'executable',
      candidateIds: expect.arrayContaining([raw[0]!.id, raw[1]!.id, raw[2]!.id, raw[3]!.id, raw[4]!.id]),
    });
    expect(selectRoute(ask, decision)).toBe('generated_answer');
  });

  it("does not let a model-selected certified block add an unspoken metric qualifier", async () => {
    const block = candidate({
      id: "block:consumption:customer_rollover_report",
      kind: "certified_block",
      trustTier: "certified",
      name: "Customer Rollover Report",
      relevanceScore: 0.93,
      compatibilityFacts: ['output: rollover_balance_amount'],
    });
    const router = createHybridRouter({
      getEvidence: async () => evidence([candidate(), block]),
      resolveMeaning: async () => resolved({
        recommendedExecutionId: block.id,
        recommendedRoute: "certified",
      }),
    });
    const ask = request("top customers by monthly rollover amount");
    const decision = await router.decide(ask);
    // The host frame preserves the literal request.  The model may select a
    // supplied block, but it may not silently turn "rollover amount" into the
    // more specific `rollover_balance_amount` that only the block asserted.
    // That would make the model's full query frame authoritative again.
    expect(selectRoute(ask, decision)).toBe("blocked");
    expect(decision.action).toBe("block");
    expect(decision.analyticalCascadeDecision?.planFrozen).toBe(false);
  });

  it("routes a uniquely compatible high-relevance certified ranking without an AI planning call (AGT-009, AGT-010, PERF-002)", async () => {
    const topCustomers = candidate({
      id: "dql:block:top_beverage_customers",
      kind: "certified_block",
      trustTier: "certified",
      name: "top_beverage_customers",
      definition: "Top customers ranked by beverage revenue. One row per customer.",
      dimensions: [
        "semantic:beverage:dimension:customer",
        "semantic:beverage:dimension:category",
      ],
      relevanceScore: 1,
      compatibility: "compatible",
      compatibilityFacts: ['output: customer_name', 'output: beverage_revenue'],
      exactMatch: false,
    });
    const productRanking = candidate({
      id: "dql:block:beverage_revenue_by_product",
      kind: "certified_block",
      trustTier: "certified",
      name: "beverage_revenue_by_product",
      definition: "Beverage revenue by product. One row per product.",
      dimensions: ["product"],
      relevanceScore: 0.91,
      compatibility: "incompatible",
    });
    const rawProducts = candidate({
      id: "warehouse:table:dev.products",
      kind: "sql_table",
      trustTier: "exploratory",
      name: "dev.products",
      dimensions: [],
      relevanceScore: 0.88,
      compatibility: "unknown",
    });
    const resolveMeaning = vi.fn(async ({ candidates, evidence }: { candidates: AgentEvidenceCandidate[]; evidence: AgentRetrievalEvidence }) => {
      const selected = candidates.find((item) => item.id === topCustomers.id) ?? candidates[0];
      return resolved({
        selectedConceptIds: selected ? [selected.id] : [],
        recommendedExecutionId: selected?.id,
        queryIntent: { measures: evidence.parsedIntent?.measures ?? ['spend'], dimensions: evidence.parsedIntent?.dimensions ?? ['customer'], filters: evidence.parsedIntent?.filters ?? [], order: 'desc', limit: 10 },
        recommendedRoute: 'certified',
      });
    });
    const router = createHybridRouter({
      resolveMeaning,
      getEvidence: async () => ({
        ...evidence([topCustomers, productRanking, rawProducts]),
        parsedIntent: {
          measures: ["beverage_revenue"],
          dimensions: ["customer"],
          filters: [{ field: "category", value: "beverage" }],
          order: "desc",
          limit: 10,
        },
      }),
    });

    const ask = request("who are the top customers who spent on beverage category products?");
    const decision = await router.decide(ask);

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision.action).toBe("answer");
    expect(decision.meaningResolution?.recommendedExecutionId).toBe(topCustomers.id);
    expect(decision.meaningResolution?.recommendedRoute).toBe("certified");
    expect(selectRoute(ask, decision)).toBe("certified_answer");
  });

  it("can still classify true general knowledge only after retrieval returns no evidence", async () => {
    const calls: string[] = [];
    const router = createHybridRouter({
      getEvidence: async () => {
        calls.push("retrieval");
        return evidence([]);
      },
      complete: async () => {
        calls.push("classification");
        return JSON.stringify({ category: "general_knowledge", depth: "quick", needsClarification: false, rationale: "world knowledge" });
      },
    });
    const decision = await router.decide(request("what is a data mesh"));
    expect(calls).toEqual(["retrieval", "classification"]);
    expect(decision.category).toBe("general_knowledge");
    expect(decision.action).toBe("converse");
  });
});
describe("AGT-017 multi-metric questions require one frozen execution tuple", () => {
  const revenueId = "semantic:orders:revenue";
  const refundsId = "semantic:orders:refunds";
  const monthGrain = "semantic:grain:month";

  const metricCandidate = (id: string, name: string): AgentEvidenceCandidate => candidate({
    id,
    name,
    aliases: [name.toLowerCase()],
    primaryEntity: monthGrain,
    relevanceScore: 0.9,
  });

  const multiMetricFrame = {
    version: 2 as const,
    interpretedQuestion: "Revenue and refunds by month",
    questionType: "trend" as const,
    metricConceptIds: [revenueId, refundsId],
    entityGrainIds: [monthGrain],
    dimensions: [],
    memberBindings: [],
    requestedOutputs: [],
    ambiguity: { status: "resolved" as const, competingConceptIds: [] },
  };

  it("retains a typed un-frozen tuple instead of handing it to a second semantic planner", async () => {
    const router = createHybridRouter({
      getEvidence: async () => evidence([
        metricCandidate(revenueId, "Revenue"),
        metricCandidate(refundsId, "Refunds"),
      ]),
      resolveMeaning: async () => resolved({
        interpretedQuestion: "Revenue and refunds by month",
        questionType: "trend",
        selectedConceptIds: [revenueId, refundsId],
        recommendedExecutionId: revenueId,
        analyticalFrame: multiMetricFrame,
      } as Partial<MeaningResolution>),
    });

    const decision = await router.decide(request("show revenue and refunds by month"));

    expect(decision.action).toBe("clarify");
    expect(decision.requiresClarification).toBe(true);
    // The host-owned seed keeps both requested measures and the month grain in
    // the diagnostic receipt.  This is deliberately not an executable plan:
    // preserving the partial tuple enables an honest clarification without a
    // second agent reinterpreting the question.
    expect(decision.resolvedAnalyticalPlan).toMatchObject({
      capability: 'blocked',
      query: {
        measures: expect.arrayContaining([
          expect.objectContaining({ requested: 'revenue' }),
          expect.objectContaining({ requested: 'refunds' }),
        ]),
        timeGrain: 'month',
      },
      outputContract: { timeGrain: 'month' },
      resolutionFailure: { outcome: 'clarify' },
    });
    expect(decision.meaningResolution?.hostRequirementSeed).toMatchObject({
      sourceQuestion: 'show revenue and refunds by month',
      requirements: {
        measures: expect.arrayContaining(['revenue', 'refunds']),
        time: { grain: 'month' },
      },
    });
    expect(decision.analyticalCascadeDecision).toMatchObject({
      planFrozen: false,
      stopReason: 'ambiguous',
    });
    expect(decision.clarificationOptions?.map((option) => option.id)).toEqual([
      refundsId,
      revenueId,
    ]);
  });
});
