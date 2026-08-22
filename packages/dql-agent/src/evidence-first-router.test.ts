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
import { buildAnalysisQuestionPlan } from './metadata/analysis-planner.js';
import { buildLocalContextPack, toAgentRetrievalEvidence } from './metadata/catalog.js';
import type { AnalyticalRequirementSetV1 } from './analytical-orchestration.js';

const jaffleSemanticFixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../apps/cli/test/fixtures/jaffle-semantic',
);

const request = (question: string): AgentRunRequest => ({ question });

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
      }],
      timeDimensions: [],
      operations: ['filter', 'group', 'rank'],
      supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
      executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
      sourceFingerprint: `sha256:${id.replace(/[^a-z0-9]/gi, '')}`,
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
        dimensions: [expect.objectContaining({ requested: 'customer' })],
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
          requested: 'customer',
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
    const risk = jaffleMetric(
      'semantic:consumption:rollover_risk_amount',
      'semantic_model_00000.rollover_risk_amount',
      [],
      false,
    );
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
        },
        {
          dimensionId: 'semantic:support:dimension:service_account',
          entityId: 'semantic:support:entity:account',
          supportedRoles: ['group_by', 'rank_entity'],
          relationshipPathIds: ['semantic:support:relationship:case_to_service_account'],
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

  it('AGT-010/013 rejects a provider frame dimension outside the selected capability', async () => {
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

    expect(decision.action).toBe('block');
    expect(decision.resolvedAnalyticalPlan?.query.dimensions[0]?.qualifiedId).not.toBe(unrelatedDimension.qualifiedId);
    expect(decision.resolvedAnalyticalPlan?.resolutionFailure).toMatchObject({ outcome: 'modeling_gap' });
    expect(JSON.stringify(decision.resolvedAnalyticalPlan)).toContain(activeSeats.analyticalCapability.metricId);
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
      planFrozen: false,
      attempts: expect.arrayContaining([expect.objectContaining({ tier: 'exploratory_sql', outcome: 'executable' })]),
    });
    expect(selectRoute(request('Show revenue by sales channel'), decision)).toBe('generated_answer');
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

  it('AGT-029 leaves a missing dimension terminal when semantic evidence has no safe raw relation and column path', async () => {
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
      terminalOutcome: { kind: 'modeling_gap', code: 'ANALYTICAL_MODELING_GAP' },
      analyticalCascadeDecision: { planFrozen: false, stopReason: 'coverage_gap' },
    });
    expect(decision.reason).toMatch(/qualified raw relation|physical path/i);
    expect(selectRoute(request('Show revenue by sales channel'), decision)).toBe('blocked');
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
      candidate(),
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
      query: { dimensions: [expect.objectContaining({ requested: 'customer', status: 'resolved' })] },
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
      getEvidence: async () => evidence([candidate()]),
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
        candidate({ definition: `Actual balance ${"detail ".repeat(2_000)}` }),
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
      metricId: "semantic:orders:gross_revenue",
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
      planFrozen: false,
      stopReason: 'selected',
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
    const selected = candidate({
      id: "semantic:consumption:total_ccu_count",
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
      meaningResolution: { selectedConceptIds: [selected.id], recommendedRoute: 'exploratory', compatibilityOutcome: 'modeling_gap' },
      analyticalCascadeDecision: { selectedTier: 'exploratory_sql', planFrozen: false },
    });
    expect(decision.analyticalCascadeDecision?.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tier: 'semantic', outcome: 'ineligible', candidateIds: expect.arrayContaining([selected.id]) }),
      expect.objectContaining({ tier: 'exploratory_sql', outcome: 'executable', candidateIds: expect.arrayContaining(raw.map((item) => item.id)) }),
    ]));
    expect(selectRoute(ask, decision)).toBe("generated_answer");
  });

  it("uses the recommended compatible certified executor only after meaning resolution", async () => {
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
    expect(selectRoute(ask, decision)).toBe("certified_answer");
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

  it("fails closed instead of handing an unresolved tuple to a second semantic planner", async () => {
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
    expect(decision.resolvedAnalyticalPlan).toBeUndefined();
    expect(decision.meaningResolution).toBeUndefined();
    expect(decision.clarificationOptions?.map((option) => option.id)).toEqual([
      refundsId,
      revenueId,
    ]);
  });
});
