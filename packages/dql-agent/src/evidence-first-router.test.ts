import { describe, expect, it, vi } from "vitest";
import { answerAnywayRoute, selectRoute, type AgentRunRequest } from "./agent-run-engine.js";
import type { AgentEvidenceCandidate, AgentRetrievalEvidence, MeaningResolution } from "./meaning-resolution.js";
import { collapseRedundantGovernedCandidates, createHybridRouter } from "./router.js";
import { buildAnalysisQuestionPlan } from './metadata/analysis-planner.js';

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
          relevanceScore: 1, compatibility: 'compatible', compatibilityFacts: ['measure, customer grain, beverage filter, and ranking all match'],
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

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      action: 'clarify',
      requiresClarification: true,
      clarifyingQuestion: 'Top by which governed metric?',
    });
    expect(decision.resolvedAnalyticalPlan).toBeUndefined();
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

    expect(resolveMeaning).toHaveBeenCalledTimes(1);
    expect(decision.action).toBe('answer');
    expect(decision.resolvedAnalyticalPlan?.selectedConceptIds).toContain('dql:block:top_beverage_customers');
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

    const decision = await router.decide({
      question: "Total CCU Count",
      selectedEvidenceId: selected.id,
    });

    expect(resolveMeaning).not.toHaveBeenCalled();
    expect(decision.action).toBe("answer");
    expect(decision.meaningResolution).toMatchObject({
      recommendedExecutionId: selected.id,
      selectedConceptIds: [selected.id],
      confidence: "high",
    });
    expect(selectRoute({ question: "Total CCU Count", selectedEvidenceId: selected.id }, decision)).toBe("semantic_answer");
  });

  it("consumes an incomplete structured choice once and continues through the governed cascade", async () => {
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
    const ask = {
      question: "Lost opportunities count and lost amount by fiscal month where competitor is Splunk",
      selectedEvidenceId: selected.id,
    };

    const decision = await router.decide(ask);

    expect(decision.action).toBe("answer");
    expect(decision.requiresClarification).toBe(false);
    expect(decision.clarificationOptions).toBeUndefined();
    expect(decision.meaningResolution).toBeUndefined();
    expect(decision.reason).toContain("selection is consumed once");
    expect(selectRoute(ask, decision)).toBe("generated_answer");
  });

  it("uses the recommended compatible certified executor only after meaning resolution", async () => {
    const block = candidate({
      id: "block:consumption:customer_rollover_report",
      kind: "certified_block",
      trustTier: "certified",
      name: "Customer Rollover Report",
      relevanceScore: 0.93,
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
          measures: ["spend"],
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
