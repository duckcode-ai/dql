import { describe, expect, it } from "vitest";
import {
  buildMeaningEvidencePackage,
  certifiedCandidateExplicitlyCoversMeasures,
  certifiedCandidateGrainDimensionOutputs,
  findExplicitEvidenceReference,
  mergeMeaningResolutionWithRequirementSeed,
  questionTypeFromText,
  validateMeaningResolution,
  type AgentEvidenceCandidate,
  type MeaningResolution,
} from "./meaning-resolution.js";
import { buildAnalyticalRequirementSeedV1, buildAnalyticalRequirementSet } from "./analytical-orchestration.js";

function candidate(overrides: Partial<AgentEvidenceCandidate> = {}): AgentEvidenceCandidate {
  return {
    id: "semantic:consumption:rollover_balance_amount",
    kind: "semantic_metric",
    trustTier: "semantic",
    name: "Rollover Balance Amount",
    definition: "Remaining eligible balance carried into the next month.",
    relevanceScore: 0.95,
    matchReasons: ["business phrase"],
    compatibility: "compatible",
    ...overrides,
  };
}

function resolution(overrides: Partial<MeaningResolution> = {}): MeaningResolution {
  return {
    interpretedQuestion: "Rank customers by actual rollover balance",
    questionType: "ranking",
    selectedConceptIds: ["semantic:consumption:rollover_balance_amount"],
    recommendedExecutionId: "semantic:consumption:rollover_balance_amount",
    queryIntent: { measures: ["rollover_balance_amount"], dimensions: ["customer"], filters: [], order: "desc", limit: 10 },
    rejectedCandidates: [],
    confidence: "high",
    missingInformation: [],
    recommendedRoute: "semantic",
    ...overrides,
  };
}

describe("AGT-010 meaning-resolution evidence boundary", () => {
  it('distinguishes a certified profile attribute from a grain-driving output', () => {
    const profile = candidate({
      id: 'dql:block:customer_profile',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'customer_profile',
      dimensions: ['customer_name', 'customer_type'],
      compatibilityFacts: [
        'grain: one row per customer',
        'output: customer_name',
        'output: customer_type',
      ],
    });

    // `customer_type` is a returned customer attribute. It does not create a
    // second row grain, so it cannot force a provider call for the otherwise
    // exact `who are the top customers?` certified path. The customer label
    // remains grain-driving and still protects scalar revenue requests.
    expect(certifiedCandidateGrainDimensionOutputs(profile)).toEqual(['customer_name']);
  });

  it("keeps relevance primary so unrelated certification cannot beat the right meaning", () => {
    const candidates = buildMeaningEvidencePackage({
      candidates: [
        candidate({
          id: "block:finance:certified_rollover_policy",
          kind: "certified_block",
          trustTier: "certified",
          name: "Certified rollover policy",
          relevanceScore: 0.35,
        }),
        candidate(),
      ],
    });
    expect(candidates.map((item) => item.id)).toEqual([
      "semantic:consumption:rollover_balance_amount",
      "block:finance:certified_rollover_policy",
    ]);
  });

  it("removes ineligible evidence and bounds noisy candidates per evidence lane", () => {
    const sql = Array.from({ length: 20 }, (_, index) => candidate({
      id: `sql:table:${index}`,
      kind: "sql_table",
      trustTier: "exploratory",
      relevanceScore: 0.99 - index / 100,
    }));
    const candidates = buildMeaningEvidencePackage({
      candidates: [candidate({ id: "secret", eligible: false }), candidate(), ...sql],
    }, 8);
    expect(candidates).toHaveLength(5);
    expect(candidates.some((item) => item.id === "secret")).toBe(false);
    expect(candidates.some((item) => item.id.includes("rollover_balance"))).toBe(true);
  });

  it("keeps an executable semantic metric when same-tier member matches fill the package", () => {
    const members = Array.from({ length: 8 }, (_, index) => candidate({
      id: `semantic:member:region_${index}`,
      kind: "semantic_member",
      name: `Region ${index}`,
      exactMatch: true,
      relevanceScore: 1 - index / 100,
    }));
    const metricCandidate = candidate({
      id: "semantic:metric:total_revenue",
      name: "Total Revenue",
      relevanceScore: 0.91,
    });

    const candidates = buildMeaningEvidencePackage({
      candidates: [...members, metricCandidate],
    }, 6);

    expect(candidates).toHaveLength(4);
    expect(candidates.some((item) => item.id === metricCandidate.id)).toBe(true);
    expect(candidates.filter((item) => item.kind === "semantic_member")).toHaveLength(3);
  });

  it('pins explicit revenue and the Account Name display role before more than eight same-kind decoys', () => {
    const decoys = Array.from({ length: 12 }, (_, index) => candidate({
      id: `semantic:dimension:account.owner_or_sentiment_${index}`,
      kind: 'semantic_member',
      name: index % 2 === 0 ? `Account Owner Email ${index}` : `Account Sentiment Rating ${index}`,
      relevanceScore: 0.99 - index / 100,
    }));
    const revenue = candidate({
      id: 'semantic:metric:revenue', kind: 'semantic_metric', name: 'Revenue', relevanceScore: 0.72,
    });
    const accountName = candidate({
      id: 'semantic:dimension:account.name', kind: 'semantic_member', name: 'Account Name', relevanceScore: 0.71,
    });

    const cards = buildMeaningEvidencePackage({ candidates: [...decoys, revenue, accountName] }, 8, 'Which top accounts have highest revenue?');

    expect(cards.map((item) => item.id)).toEqual(expect.arrayContaining([revenue.id, accountName.id]));
    expect(cards.filter((item) => /owner|sentiment/i.test(item.name)).map((item) => item.name)).toEqual([]);
  });

  it('keeps a BCM metric from an account_revenue model out of an explicit Revenue ranking package', () => {
    const revenue = candidate({
      id: 'semantic:metric:account_revenue.revenue',
      qualifiedId: 'semantic:metric:account_revenue.revenue',
      kind: 'semantic_metric',
      semanticObjectType: 'metric',
      name: 'Revenue',
      aliases: ['revenue'],
      relevanceScore: 0.76,
    });
    // The physical source/dimension path deliberately includes `revenue`.
    // It is execution context, not the intrinsic name of this BCM metric.
    const bcm = candidate({
      id: 'semantic:metric:account_revenue.bcm_run_rate',
      qualifiedId: 'semantic:metric:account_revenue.bcm_run_rate',
      kind: 'semantic_metric',
      semanticObjectType: 'metric',
      // This is the display label emitted by the real semantic metadata
      // adapter. The `account_revenue` prefix must not make BCM a Revenue
      // metric at the reservation boundary.
      name: 'account_revenue.bcm_run_rate',
      aliases: ['BCM', 'run rate'],
      dimensions: ['semantic:dimension:account_revenue.fiscal_period'],
      relevanceScore: 0.99,
    });
    const question = 'Who are the top BCM customers who have highest revenue?';
    const requirements = buildAnalyticalRequirementSet({
      question,
      parsedIntent: { measures: ['BCM', 'revenue'], dimensions: ['customer'], filters: [] },
    });

    expect(requirements.ranking).toMatchObject({ metricTerms: ['revenue'], limit: 10, defaultedLimit: true });
    expect(buildMeaningEvidencePackage({
      candidates: [revenue, bcm],
      parsedIntent: { measures: ['BCM', 'revenue'], dimensions: ['customer'], filters: [] },
    }, 8, question).map((item) => item.id)).toEqual([revenue.id]);

    const invalidSelection = resolution({
      selectedConceptIds: [bcm.id],
      recommendedExecutionId: bcm.id,
      queryIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
    });
    expect(validateMeaningResolution(invalidSelection, [revenue, bcm], ['revenue'], { requirements })).toEqual({
      ok: false,
      reason: `The resolver selected a metric that conflicts with the explicit ranking measure: ${bcm.id}`,
    });
  });

  it('keeps genuinely requested Revenue and BCM metrics eligible together', () => {
    const revenue = candidate({
      id: 'semantic:metric:account_revenue.revenue',
      qualifiedId: 'semantic:metric:account_revenue.revenue',
      kind: 'semantic_metric',
      semanticObjectType: 'metric',
      name: 'Revenue',
      aliases: ['revenue'],
      relevanceScore: 0.76,
    });
    const bcm = candidate({
      id: 'semantic:metric:account_revenue.bcm_run_rate',
      qualifiedId: 'semantic:metric:account_revenue.bcm_run_rate',
      kind: 'semantic_metric',
      semanticObjectType: 'metric',
      name: 'BCM Run Rate',
      aliases: ['BCM', 'run rate'],
      dimensions: ['semantic:dimension:account_revenue.fiscal_period'],
      relevanceScore: 0.99,
    });
    const question = 'Show Revenue and BCM run rate by customer.';
    const requirements = buildAnalyticalRequirementSet({
      question,
      parsedIntent: { measures: ['revenue', 'BCM run rate'], dimensions: ['customer'], filters: [] },
    });

    expect(requirements.ranking).toBeUndefined();
    expect(buildMeaningEvidencePackage({
      candidates: [revenue, bcm],
      parsedIntent: { measures: ['revenue', 'BCM run rate'], dimensions: ['customer'], filters: [] },
    }, 8, question).map((item) => item.id)).toEqual(expect.arrayContaining([revenue.id, bcm.id]));
  });

  it('reserves a declared region alternative before the meaning-card cap without treating location as a lexical synonym', () => {
    const revenueDecoys = Array.from({ length: 20 }, (_, index) => candidate({
      id: `semantic:metric:orders.revenue_${index}`,
      kind: 'semantic_metric',
      name: `Revenue ${index}`,
      relevanceScore: 0.99 - index / 100,
    }));
    const totalRevenue = candidate({
      id: 'semantic:metric:orders.order_total', kind: 'semantic_metric', name: 'Order Total',
      aliases: ['total revenue'], relevanceScore: 0.74,
    });
    const beverageRevenue = candidate({
      id: 'semantic:metric:order_items.drink_revenue', kind: 'semantic_metric', name: 'Drink Revenue',
      aliases: ['beverage revenue'], relevanceScore: 0.73,
    });
    const declaredRegionAlternative = candidate({
      id: 'semantic:dimension:locations.location_name', kind: 'semantic_member', semanticObjectType: 'dimension',
      name: 'Location Name', relevanceScore: 0.72, compatibilityFacts: ['alternative-for:region'],
    });
    const untypedLocation = candidate({
      id: 'semantic:dimension:stores.location_name', kind: 'semantic_member', semanticObjectType: 'dimension',
      name: 'Location Name', relevanceScore: 0.98,
    });
    const owner = candidate({
      id: 'semantic:dimension:accounts.owner_email', kind: 'semantic_member', semanticObjectType: 'dimension',
      name: 'Account Owner Email', relevanceScore: 0.97,
    });
    const sentiment = candidate({
      id: 'semantic:dimension:accounts.sentiment', kind: 'semantic_member', semanticObjectType: 'dimension',
      name: 'Account Sentiment Rating', relevanceScore: 0.96,
    });

    const cards = buildMeaningEvidencePackage({
      candidates: [
        ...revenueDecoys,
        totalRevenue,
        beverageRevenue,
        declaredRegionAlternative,
        untypedLocation,
        owner,
        sentiment,
      ],
      parsedIntent: {
        measures: ['total revenue', 'beverage revenue'],
        dimensions: ['customer region'],
        filters: [],
      },
    }, 3, 'show total revenue and beverage revenue by customer region');

    expect(cards.map((item) => item.id)).toEqual(expect.arrayContaining([
      totalRevenue.id,
      beverageRevenue.id,
      declaredRegionAlternative.id,
    ]));
    expect(cards.map((item) => item.id)).not.toEqual(expect.arrayContaining([
      untypedLocation.id,
      owner.id,
      sentiment.id,
    ]));
    expect(cards).toHaveLength(3);
  });

  it("recognizes a unique explicit reference without fuzzy guessing", () => {
    const found = findExplicitEvidenceReference(
      "show @metric(rollover_balance_amount) by customer",
      [candidate({ aliases: ["rollover_balance_amount"] })],
    );
    expect(found?.id).toBe("semantic:consumption:rollover_balance_amount");
  });

  it("rejects invented IDs and incompatible selections", () => {
    expect(validateMeaningResolution(
      resolution({ selectedConceptIds: ["semantic:invented"] }),
      [candidate()],
    )).toMatchObject({ ok: false });

    expect(validateMeaningResolution(
      resolution(),
      [candidate({ compatibility: "incompatible" })],
    )).toMatchObject({ ok: false });
  });

  it('keeps selected authority strict but prunes a rejected card outside the bounded meaning package', () => {
    const selected = candidate({ id: 'semantic:metric:actual_rollover_balance' });
    const result = validateMeaningResolution(
      resolution({
        selectedConceptIds: [selected.id],
        recommendedExecutionId: selected.id,
        rejectedCandidates: [{ id: 'semantic:metric:rollover_risk', reason: 'different business meaning' }],
      }),
      [selected],
    );

    expect(result).toMatchObject({
      ok: true,
      resolution: {
        selectedConceptIds: [selected.id],
        recommendedExecutionId: selected.id,
        rejectedCandidates: [],
      },
    });
    expect(validateMeaningResolution(
      resolution({ selectedConceptIds: ['semantic:metric:not_in_package'] }),
      [selected],
    )).toMatchObject({ ok: false });
  });

  it('AGT-009 keeps an incomplete certified nomination in the bounded package for the host cascade to reject or advance', () => {
    const topCustomers = candidate({
      id: 'dql:block:top_customers',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'top_customers',
      compatibilityFacts: ['output: customer_name', 'output: lifetime_spend', 'output: order_count'],
    });
    const selected = resolution({
      selectedConceptIds: [topCustomers.id],
      recommendedExecutionId: topCustomers.id,
      recommendedRoute: 'certified',
      queryIntent: { measures: ['revenue'], dimensions: [], filters: [] },
    });

    expect(certifiedCandidateExplicitlyCoversMeasures(topCustomers, ['revenue'])).toBe(false);
    expect(validateMeaningResolution(selected, [topCustomers])).toMatchObject({ ok: true });
  });

  it('AGT-009 accepts a certified execution only when its own output contract declares revenue', () => {
    const revenueBlock = candidate({
      id: 'dql:block:revenue_summary',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'revenue_summary',
      compatibilityFacts: ['output: revenue'],
    });
    const selected = resolution({
      selectedConceptIds: [revenueBlock.id],
      recommendedExecutionId: revenueBlock.id,
      recommendedRoute: 'certified',
      queryIntent: { measures: ['revenue'], dimensions: [], filters: [] },
    });

    expect(certifiedCandidateExplicitlyCoversMeasures(revenueBlock, ['revenue'])).toBe(true);
    expect(validateMeaningResolution(selected, [revenueBlock])).toMatchObject({ ok: true });
  });

  it("normalizes a compatible recommended execution into the selected plan scope", () => {
    const validated = validateMeaningResolution(
      resolution({ selectedConceptIds: [] }),
      [candidate()],
    );
    expect(validated).toMatchObject({
      ok: true,
      resolution: { selectedConceptIds: ['semantic:consumption:rollover_balance_amount'] },
    });
  });

  it("defers partial semantic nomination compatibility to the host-owned cascade", () => {
    expect(validateMeaningResolution(
      resolution(),
      [candidate({ compatibility: "partial" })],
    )).toMatchObject({ ok: true });
  });

  it("AGT-001 classifies aggregate asks as values instead of definitions", () => {
    expect(questionTypeFromText("What is total lifetime spend across all customers?")).toBe("value");
    expect(questionTypeFromText("What is customer lifetime value?")).toBe("definition");
    expect(questionTypeFromText("Show revenue by month")).toBe("trend");
  });

  it('AGT-034 keeps the host requirement seed when a model omits outputs or proposes a different route', () => {
    const question = 'Show the five most expensive individual order items with order ID, product ID, and product price.';
    const seed = buildAnalyticalRequirementSeedV1({
      question,
      parsedIntent: {
        measures: ['product price'],
        dimensions: ['order id', 'product id'],
        filters: [],
        order: 'desc',
        limit: 5,
      },
    });
    const productPrice = candidate({
      id: 'semantic:metric:order_items.product_price',
      name: 'Product Price',
      aliases: ['product price'],
    });
    const merged = mergeMeaningResolutionWithRequirementSeed({
      seed,
      candidates: [productPrice],
      resolution: resolution({
        interpretedQuestion: 'previous customer result instead',
        questionType: 'definition',
        selectedConceptIds: [productPrice.id],
        recommendedExecutionId: productPrice.id,
        // Deliberately malicious/legacy fields: the host must not lose its
        // product category/order outputs, ranking, or individual grain.
        queryIntent: { measures: ['bcm'], dimensions: [], filters: [{ field: 'customer_name', value: 'Brittany Barrera' }], limit: 100 },
        recommendedRoute: 'certified',
      }),
    });

    expect(merged.interpretedQuestion).toBe(question);
    expect(merged.queryIntent).toEqual(seed.queryIntent);
    expect(merged.hostRequirementSeed?.requirements).toMatchObject({
      grain: 'individual',
      outputTerms: expect.arrayContaining(['order id', 'product id', 'product price']),
      ranking: { direction: 'top', limit: 5, defaultedLimit: false },
    });
    expect(merged.recommendedRoute).toBe('semantic');
    expect(merged.overrideReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'interpreted_question', action: 'host_preserved' }),
      expect.objectContaining({ field: 'query_intent', action: 'host_preserved' }),
      expect.objectContaining({ field: 'recommended_route', action: 'host_preserved' }),
    ]));
    expect(validateMeaningResolution(merged, [productPrice], seed.queryIntent.measures, { requirements: seed.requirements })).toMatchObject({ ok: true });
  });

  it('AGT-034 keeps a selected semantic metric ahead of a legacy block recommendation', () => {
    const seed = buildAnalyticalRequirementSeedV1({
      question: 'Show revenue by customer.',
      parsedIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [] },
    });
    const revenue = candidate({
      id: 'semantic:metric:orders.revenue',
      qualifiedId: 'semantic:metric:orders.revenue',
      name: 'Revenue',
      aliases: ['revenue'],
    });
    const partialBlock = candidate({
      id: 'block:revenue_by_customer',
      qualifiedId: 'block:revenue_by_customer',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'Revenue by customer',
    });
    const merged = mergeMeaningResolutionWithRequirementSeed({
      seed,
      candidates: [revenue, partialBlock],
      resolution: resolution({
        selectedConceptIds: [revenue.id],
        recommendedExecutionId: partialBlock.id,
        recommendedRoute: 'certified',
      }),
    });

    expect(merged.recommendedExecutionId).toBe(revenue.id);
    expect(merged.recommendedRoute).toBe('semantic');
    expect(merged.overrideReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'recommended_route', action: 'host_preserved' }),
    ]));
  });

  it('AGT-034 rejects a model-invented candidate even after host seed merge', () => {
    const seed = buildAnalyticalRequirementSeedV1({
      question: 'who are the top customers who have revenue by product category?',
      parsedIntent: { measures: ['revenue'], dimensions: ['customer name', 'product category'], filters: [] },
    });
    const revenue = candidate({ id: 'semantic:metric:orders.revenue', name: 'Revenue' });
    const merged = mergeMeaningResolutionWithRequirementSeed({
      seed,
      candidates: [revenue],
      resolution: resolution({
        selectedConceptIds: ['semantic:metric:invented'],
        recommendedExecutionId: 'semantic:metric:invented',
        queryIntent: { measures: [], dimensions: [], filters: [{ field: 'customer_name', value: 'prior result' }] },
      }),
    });

    expect(merged.queryIntent).toEqual(seed.queryIntent);
    expect(validateMeaningResolution(merged, [revenue], seed.queryIntent.measures, { requirements: seed.requirements })).toEqual({
      ok: false,
      reason: 'The resolver referenced evidence that was not retrieved: semantic:metric:invented',
    });
  });
});
