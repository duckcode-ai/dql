import { describe, expect, it } from 'vitest';
import { buildAnalysisQuestionPlan } from './analysis-planner.js';
import {
  applyContextPackCompatibility,
  buildMeaningEvidencePackage,
  toAgentRetrievalEvidence,
  type MeaningEvidenceInputCandidate,
} from './meaning-evidence.js';
import {
  buildMeaningEvidencePackage as buildProviderMeaningEvidencePackage,
  canonicalizeMetricMeasureCandidates,
} from '../meaning-resolution.js';
import type { MetadataObject } from './catalog.js';

function ranked(row: MetadataObject, rank: number, score: number): MeaningEvidenceInputCandidate {
  return {
    row,
    rank,
    score,
    reason: 'deterministic fixture relevance',
    priorityTier: 'semantic',
  };
}

describe('AGT-010 metadata meaning evidence lanes', () => {
  it('marks a catalog-proven complete certified fit as exact without requiring literal example wording', () => {
    const evidence = {
      candidates: [{
        id: 'dql:block:monthly_revenue', kind: 'certified_block' as const,
        trustTier: 'certified' as const, name: 'monthly_revenue', aliases: ['monthly revenue'],
        relevanceScore: 0.91, matchReasons: ['monthly revenue'], compatibility: 'partial' as const,
        compatibilityFacts: ['output: month', 'output: revenue'],
      }],
    };
    const pack = {
      routeDecision: { exactObjectKey: 'dql:block:monthly_revenue' },
      questionPlan: { timeTerms: ['month'], requestedShape: { measures: ['revenue'], dimensions: ['month'] } },
      retrievalDiagnostics: { certifiedCandidateFits: [{
        objectKey: 'dql:block:monthly_revenue', name: 'monthly_revenue',
        applicabilityKind: 'safe_parameterized', applicabilityScore: 0.88, action: 'certified_answer',
        fit: {
          kind: 'exact', confidence: 'high', reasons: ['exact or trim-safe fit at high confidence'],
          missingOutputs: [], missingDimensions: [], unsupportedFilters: [], topNAction: 'none', inferredContract: false,
        },
      }] },
    };

    const candidate = applyContextPackCompatibility(evidence, pack as never).candidates[0]!;

    expect(candidate).toMatchObject({
      id: 'dql:block:monthly_revenue',
      compatibility: 'compatible',
      exactMatch: true,
      analyticalFitClass: 'exact',
    });
  });

  it('carries catalog-proven output coverage only for an exact certified title when old block metadata omits declared outputs', () => {
    const evidence = {
      candidates: [{
        id: 'dql:block:top_customers_by_revenue', kind: 'certified_block' as const,
        trustTier: 'certified' as const, name: 'Top Customers by Revenue', aliases: ['Top Customers by Revenue'],
        relevanceScore: 1, matchReasons: ['exact name or alias'], compatibility: 'partial' as const,
        compatibilityFacts: ['grain: customer_name', 'parameter: top_n'], exactMatch: true,
      }],
    };
    const pack = {
      routeDecision: { route: 'certified', exactObjectKey: 'dql:block:top_customers_by_revenue' },
      questionPlan: {
        question: 'Top Customers by Revenue', timeTerms: [],
        requestedShape: { measures: ['revenue'], dimensions: ['customer'] },
      },
      retrievalDiagnostics: { certifiedCandidateFits: [{
        objectKey: 'dql:block:top_customers_by_revenue', name: 'Top Customers by Revenue',
        applicabilityKind: 'safe_parameterized', applicabilityScore: 1, action: 'certified_answer',
        fit: {
          kind: 'exact', confidence: 'high', reasons: ['catalog inferred the certified SQL output contract'],
          missingOutputs: [], missingDimensions: [], unsupportedFilters: [], topNAction: 'none', inferredContract: true,
        },
      }] },
    };

    const exact = applyContextPackCompatibility(evidence, pack as never).candidates[0]!;
    const nonExact = applyContextPackCompatibility(evidence, {
      ...pack,
      questionPlan: { ...pack.questionPlan, question: 'Show customers ranked by revenue' },
    } as never).candidates[0]!;

    expect(exact).toMatchObject({
      compatibility: 'compatible', exactMatch: true, analyticalFitClass: 'exact',
      compatibilityFacts: expect.arrayContaining(['catalog-proven-output: revenue', 'catalog-proven-output: customer_name']),
    });
    expect(nonExact).toMatchObject({ compatibility: 'partial', exactMatch: false, analyticalFitClass: undefined });
    expect(nonExact.compatibilityFacts).not.toContain('catalog-proven-output: revenue');
  });

  it('AGT-009 never upgrades a tagged top-customers block to a certified revenue answer without its own output', () => {
    const evidence = {
      candidates: [{
        id: 'dql:block:top_customers', kind: 'certified_block' as const,
        trustTier: 'certified' as const, name: 'top_customers', aliases: ['top customers'],
        relevanceScore: 0.99, matchReasons: ['revenue tag'], compatibility: 'partial' as const,
        compatibilityFacts: ['output: customer_name', 'output: lifetime_spend', 'output: order_count'],
      }],
    };
    const pack = {
      routeDecision: { exactObjectKey: 'dql:block:top_customers' },
      questionPlan: { timeTerms: [], requestedShape: { measures: ['revenue'], dimensions: [] } },
      retrievalDiagnostics: { certifiedCandidateFits: [{
        objectKey: 'dql:block:top_customers', name: 'top_customers',
        applicabilityKind: 'exact_answer', applicabilityScore: 1, action: 'certified_answer',
        fit: {
          kind: 'exact', confidence: 'high', reasons: ['legacy relevance assertion'],
          missingOutputs: [], missingDimensions: [], unsupportedFilters: [], topNAction: 'none', inferredContract: false,
        },
      }] },
    };

    const candidate = applyContextPackCompatibility(evidence, pack as never).candidates[0]!;

    expect(candidate).toMatchObject({ compatibility: 'partial', exactMatch: false, analyticalFitClass: undefined });
  });

  it('excludes unrequested certified static scope before resolution and canonicalizes a metric backing measure', () => {
    const revenueCapability = {
      metricId: 'semantic:metric:order_item.revenue',
      measureIds: ['semantic:measure:order_item.revenue'],
      primaryEntityId: 'order_item',
      defaultResultGrainId: 'order_item',
      resultGrainIds: ['order_item', 'customer'],
      aggregation: 'sum',
      additivity: { entities: 'additive' as const, time: 'additive' as const },
      dimensions: [], timeDimensions: [], operations: ['group', 'rank'],
      supportedOutputKinds: ['dimension', 'metric_value'],
      executionCapabilities: [{ route: 'semantic' as const, adapterId: 'native' }],
      sourceFingerprint: 'sha256:revenue',
    };
    const evidence = {
      candidates: [{
        id: 'dql:block:top_beverage_customers', kind: 'certified_block' as const,
        trustTier: 'certified' as const, name: 'top_beverage_customers', aliases: ['top customers'],
        relevanceScore: 0.99, matchReasons: ['ranking match'], compatibility: 'partial' as const,
      }, {
        id: revenueCapability.metricId, qualifiedId: revenueCapability.metricId,
        kind: 'semantic_metric' as const, semanticObjectType: 'metric' as const,
        trustTier: 'semantic' as const, name: 'revenue', aliases: ['revenue'], exactMatch: true,
        relevanceScore: 1, matchReasons: ['exact metric'], compatibility: 'compatible' as const,
        analyticalCapability: revenueCapability,
      }, {
        id: revenueCapability.measureIds[0], qualifiedId: revenueCapability.measureIds[0],
        kind: 'semantic_member' as const, semanticObjectType: 'measure' as const,
        trustTier: 'semantic' as const, name: 'revenue', aliases: ['revenue'], exactMatch: true,
        relevanceScore: 1, matchReasons: ['backing measure'], compatibility: 'compatible' as const,
      }],
    };
    const pack = {
      routeDecision: {},
      questionPlan: { timeTerms: [], requestedShape: { measures: ['revenue'], dimensions: ['customer'] } },
      retrievalDiagnostics: { certifiedCandidateFits: [{
        objectKey: 'dql:block:top_beverage_customers', name: 'top_beverage_customers',
        applicabilityKind: 'conditional', applicabilityScore: 0.7, action: 'eligible_not_selected',
        fit: {
          kind: 'context_only', score: 0.5,
          reasons: ['certified static scope is not requested: beverage'],
          missingOutputs: [], missingDimensions: [], unsupportedFilters: [], topNAction: 'none',
        },
      }] },
    };

    const compatible = applyContextPackCompatibility(evidence, pack as never);
    expect(compatible.candidates.find((candidate) => candidate.kind === 'certified_block')?.eligible).toBe(false);
    expect(canonicalizeMetricMeasureCandidates(compatible.candidates).map((candidate) => candidate.id)).toEqual([
      'dql:block:top_beverage_customers',
      revenueCapability.metricId,
    ]);
    expect(buildProviderMeaningEvidencePackage(compatible).map((candidate) => candidate.id)).toEqual([
      revenueCapability.metricId,
    ]);
  });

  it('retains the semantic entity object class for host-owned identity binding', () => {
    const question = 'Which assets have the highest open cost?';
    const plan = buildAnalysisQuestionPlan(question);
    const semanticEntity = ranked({
      objectKey: 'semantic:entity:operations.asset',
      objectType: 'semantic_entity',
      name: 'operations.asset',
      fullName: 'semantic:entity:operations.asset',
      payload: {
        qualifiedId: 'semantic:entity:operations.asset',
        label: 'Asset',
        aliases: ['Asset'],
      },
      score: 1,
    }, 1, 1);
    const pack = buildMeaningEvidencePackage(question, plan, [semanticEntity]);
    const evidence = toAgentRetrievalEvidence(pack, plan);

    expect(evidence.candidates).toContainEqual(expect.objectContaining({
      qualifiedId: 'semantic:entity:operations.asset',
      kind: 'semantic_member',
      semanticObjectType: 'entity',
      aliases: expect.arrayContaining(['Asset']),
    }));
  });

  it('keeps dbt column identities distinct from their shared parent model (AGT-034)', () => {
    const question = 'Show the five most expensive individual order items with order ID, product ID, and product price.';
    const plan = buildAnalysisQuestionPlan(question);
    const relation = ranked({
      objectKey: 'dbt:model:order_items',
      objectType: 'dbt_model',
      name: 'order_items',
      fullName: '"jaffle_shop"."dev"."order_items"',
      payload: {
        qualifiedId: 'dbt::model.jaffle_shop.order_items',
        uniqueId: 'model.jaffle_shop.order_items',
        relation: '"jaffle_shop"."dev"."order_items"',
      },
      score: 1,
    }, 1, 1);
    const columns = ['order_id', 'product_id', 'product_price'].map((name, index) => ranked({
      objectKey: `dbt:column:order_items.${name}`,
      objectType: 'dbt_column',
      name,
      fullName: `order_items.${name}`,
      // dbt's node unique ID is deliberately shared by all of these fields.
      payload: {
        uniqueId: 'model.jaffle_shop.order_items',
        relation: '"jaffle_shop"."dev"."order_items"',
      },
      score: 0.99 - index / 100,
    }, index + 2, 0.99 - index / 100));

    const evidence = toAgentRetrievalEvidence(
      buildMeaningEvidencePackage(question, plan, [relation, ...columns]),
      plan,
    );

    expect(evidence.candidates.filter((candidate) => candidate.kind === 'sql_column')
      .map((candidate) => candidate.qualifiedId)
      .sort()).toEqual([
        'order_items.order_id',
        'order_items.product_id',
        'order_items.product_price',
      ]);
    expect(new Set(evidence.candidates.map((candidate) => candidate.qualifiedId ?? candidate.id)).size)
      .toBe(evidence.candidates.length);
  });

  it('preserves actual vector and graph memberships from the snapshot through provider evidence', () => {
    const question = 'Which customer accounts have the highest revenue?';
    const plan = buildAnalysisQuestionPlan(question);
    const account = ranked({
      objectKey: 'semantic:dimension:accounts.account_name',
      objectType: 'semantic_dimension',
      name: 'Account Name',
      fullName: 'semantic:dimension:accounts.account_name',
      payload: { qualifiedId: 'semantic:dimension:accounts.account_name' },
      score: 0.9,
    }, 1, 0.9);
    const pack = buildMeaningEvidencePackage(question, plan, [account], [
      { lane: 'vector', candidates: [{ objectKey: account.row.objectKey, objectType: 'semantic_dimension', name: 'Account Name', rank: 1, score: 0.9, reason: 'vector-only fixture' }] },
      { lane: 'graph', candidates: [{ objectKey: account.row.objectKey, objectType: 'semantic_dimension', name: 'Account Name', rank: 2, score: 0.6, reason: 'graph neighbor fixture' }] },
    ]);
    const evidence = toAgentRetrievalEvidence(pack, plan);

    expect(evidence.candidates[0]).toMatchObject({
      retrievalLanes: [{ lane: 'vector', rank: 1 }, { lane: 'graph', rank: 2 }],
    });
  });

  it('preserves a retrieved semantic metric when exact dimensions fill the semantic class', () => {
    const question = 'Show actual rollover balance by region for last month.';
    const dimensions = Array.from({ length: 5 }, (_, index) => ranked({
      objectKey: `semantic:dimension:model_${index}.region`,
      objectType: 'semantic_dimension',
      name: 'region',
      fullName: `semantic:domain_${index}:dimension:model_${index}.region`,
      domain: `domain_${index}`,
      description: `Region dimension ${index}`,
      score: 1,
    }, index + 1, 1 - index / 100));
    const metric = ranked({
      objectKey: 'semantic:metric:consumption.rollover_balance_amount',
      objectType: 'semantic_metric',
      name: 'rollover_balance_amount',
      fullName: 'semantic:consumption:rollover_balance_amount',
      domain: 'consumption',
      description: 'Actual eligible balance carried into the next month.',
      score: 0.8,
    }, 6, 0.8);

    const evidence = buildMeaningEvidencePackage(
      question,
      buildAnalysisQuestionPlan(question),
      [...dimensions, metric],
    );

    expect(evidence.byEvidenceClass.semantic).toHaveLength(4);
    expect(evidence.byEvidenceClass.semantic.map((candidate) => candidate.objectKey)).toContain(
      metric.row.objectKey,
    );
  });

  it('CTX-005 retains role-critical candidates beyond the compact same-class cards before provider admission', () => {
    const question = 'Which top accounts have highest revenue?';
    const decoys = Array.from({ length: 12 }, (_, index) => ranked({
      objectKey: `semantic:dimension:account.decoy_${index}`,
      objectType: 'semantic_dimension',
      name: index % 2 === 0 ? `Account Owner Email ${index}` : `Account Sentiment Rating ${index}`,
      fullName: `semantic:dimension:account.decoy_${index}`,
      payload: { qualifiedId: `semantic:dimension:account.decoy_${index}` },
      score: 1,
    }, index + 1, 1 - index / 100));
    const revenue = ranked({
      objectKey: 'semantic:metric:revenue', objectType: 'semantic_metric', name: 'Revenue',
      fullName: 'semantic:metric:revenue', payload: { qualifiedId: 'semantic:metric:revenue' }, score: 0.7,
    }, 13, 0.7);
    const accountName = ranked({
      objectKey: 'semantic:dimension:account.name', objectType: 'semantic_dimension', name: 'Account Name',
      fullName: 'semantic:dimension:account.name', payload: { qualifiedId: 'semantic:dimension:account.name' }, score: 0.69,
    }, 14, 0.69);

    const pack = buildMeaningEvidencePackage(question, buildAnalysisQuestionPlan(question), [...decoys, revenue, accountName]);
    expect(pack.byEvidenceClass.semantic).toHaveLength(4);
    expect(pack.qualifiedCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ objectKey: revenue.row.objectKey }),
      expect.objectContaining({ objectKey: accountName.row.objectKey }),
    ]));
    const admitted = buildProviderMeaningEvidencePackage(toAgentRetrievalEvidence(pack, buildAnalysisQuestionPlan(question)), 8, question);
    expect(admitted.map((candidate) => candidate.id)).toEqual(expect.arrayContaining([revenue.row.objectKey, accountName.row.objectKey]));
    expect(admitted.some((candidate) => /owner|sentiment/i.test(candidate.name))).toBe(false);
  });

  it('AGT-029 carries structured safety through a canonical endpoint despite a duplicate leaf', () => {
    const relationshipId = 'dql:relationship:order_items_to_supplies';
    const evidence = toAgentRetrievalEvidence({
      candidates: [{
        objectKey: 'dbt:model:order_items',
        qualifiedId: 'dbt:model:order_items',
        evidenceClass: 'sql',
        trustTier: 'exploratory',
        classRank: 1,
        relevanceScore: 1,
        name: 'order_items',
        aliases: ['order_items'],
        objectType: 'dbt_model',
        relevanceReasons: ['exact model'],
        compatibilityFacts: [],
        businessShape: {
          entities: [], dimensions: [], timeGrains: [], parameters: [], filters: [], outputs: [],
          sourceRelations: ['runtime:relation:order_items'],
        },
        ambiguityPeerIds: [],
      }],
      byEvidenceClass: { certified: [], semantic: [], sql: [] },
      ambiguousGroups: [],
    }, buildAnalysisQuestionPlan('which products come from perishable supplies?'), {
      contextObjects: [{
        objectKey: 'commerce::entity::order_items',
        objectType: 'dql_entity',
        name: 'order_items',
        fullName: 'commerce::entity::order_items',
        payload: {
          qualifiedId: 'commerce::entity::order_items',
          dbtUniqueId: 'dbt:model:order_items',
          relation: 'runtime:relation:order_items',
        },
      }, {
        // A separate domain has a same-leaf physical relation. The canonical
        // entity-to-dbt binding above, not the leaf, must select the proof.
        objectKey: 'dbt:model:sales.order_items',
        objectType: 'dbt_model',
        name: 'order_items',
        fullName: 'dbt:model:sales.order_items',
        payload: { qualifiedId: 'dbt:model:sales.order_items' },
      }, {
        objectKey: relationshipId,
        objectType: 'relationship',
        name: 'order_items_to_supplies',
        fullName: relationshipId,
        status: 'certified',
        payload: {
          qualifiedId: relationshipId,
          from: 'commerce::entity::order_items',
          to: 'commerce::entity::supplies',
          keys: [{ from: 'product_id', to: 'product_id' }],
          status: 'certified',
          cardinality: 'many_to_one',
          fanout: 'safe',
          staleCertification: false,
          automaticJoinAllowed: true,
          certificationFingerprint: 'sha256:certified-product-supply',
          validation: {
            status: 'passed',
            checkedAt: '2026-08-20T00:00:00.000Z',
            queryFingerprint: 'sha256:query',
            proofFingerprint: 'sha256:proof',
          },
        },
      }],
    });

    expect(evidence.candidates[0]).toMatchObject({
      relationshipEvidence: expect.arrayContaining([relationshipId]),
      relationshipEndpointIds: ['commerce::entity::order_items'],
      relationshipSafety: [expect.objectContaining({
        id: relationshipId,
        status: 'certified',
        cardinality: 'many_to_one',
        fanout: 'safe',
        automaticJoinAllowed: true,
        validation: expect.objectContaining({ status: 'passed' }),
      })],
    });
  });

  it('AGT-029 does not attach a cross-domain proof through a duplicate raw-relation leaf', () => {
    const relationshipId = 'dql:relationship:commerce_orders_to_supplies';
    const evidence = toAgentRetrievalEvidence({
      candidates: [{
        objectKey: 'dbt:model:commerce.orders',
        qualifiedId: 'dbt:model:commerce.orders',
        evidenceClass: 'sql', trustTier: 'exploratory', classRank: 1, relevanceScore: 1,
        name: 'orders', aliases: ['orders'], objectType: 'dbt_model', relevanceReasons: ['exact model'], compatibilityFacts: [],
        businessShape: { entities: [], dimensions: [], timeGrains: [], parameters: [], filters: [], outputs: [], sourceRelations: ['runtime:relation:commerce.orders'] },
        ambiguityPeerIds: [],
      }],
      byEvidenceClass: { certified: [], semantic: [], sql: [] },
      ambiguousGroups: [],
    }, buildAnalysisQuestionPlan('which orders have perishable supplies?'), {
      contextObjects: [{
        objectKey: 'dbt:model:sales.orders', objectType: 'dbt_model', name: 'orders',
        fullName: 'dbt:model:sales.orders', payload: { qualifiedId: 'dbt:model:sales.orders' },
      }, {
        objectKey: relationshipId, objectType: 'relationship', name: 'commerce_orders_to_supplies', fullName: relationshipId,
        status: 'certified',
        payload: {
          qualifiedId: relationshipId,
          from: 'commerce::entity::orders', to: 'commerce::entity::supplies',
          keys: [{ from: 'supply_id', to: 'supply_id' }], status: 'certified', cardinality: 'many_to_one', fanout: 'safe',
          staleCertification: false, automaticJoinAllowed: true, certificationFingerprint: 'sha256:commerce-orders',
          validation: { status: 'passed', checkedAt: '2026-08-20T00:00:00.000Z', queryFingerprint: 'sha256:query', proofFingerprint: 'sha256:proof' },
        },
      }],
    });

    expect(evidence.candidates[0]?.relationshipEvidence).toBeUndefined();
    expect(evidence.candidates[0]?.relationshipEndpointIds).toBeUndefined();
    expect(evidence.candidates[0]?.relationshipSafety).toBeUndefined();
  });

  it('keeps qualified metric/geography alternatives host-only and binds only trusted prior members', () => {
    const question = 'what is the region for Joy Lam customer? what is total revenue along with beverage revenue';
    const objects: MetadataObject[] = [
      {
        objectKey: 'dql:term:Beverage', objectType: 'dql_term', name: 'Beverage',
        payload: { synonyms: ['drink', 'drinks'] },
      },
      {
        objectKey: 'semantic:metric:order_item.drink_revenue', objectType: 'semantic_metric',
        name: 'order_item.drink_revenue', fullName: 'semantic:order_item:drink_revenue',
        description: 'The revenue from drinks in each order; excludes tax.',
        payload: { qualifiedId: 'semantic:order_item:drink_revenue', aliases: ['drink_revenue'] },
      },
      {
        objectKey: 'semantic:metric:orders.order_total', objectType: 'semantic_metric',
        name: 'orders.order_total', fullName: 'semantic:orders:order_total',
        description: 'Sum of total order amount; includes tax.',
        payload: { qualifiedId: 'semantic:orders:order_total', aliases: ['order_total'] },
      },
      {
        objectKey: 'semantic:dimension:customers.customer_name', objectType: 'semantic_dimension',
        name: 'customer_name', fullName: 'semantic:customers:dimension:customer_name',
        payload: { qualifiedId: 'semantic:customers:dimension:customer_name' },
      },
      {
        objectKey: 'semantic:dimension:locations.location_name', objectType: 'semantic_dimension',
        name: 'location_name', fullName: 'semantic:locations:dimension:location_name',
        description: 'Modeled order fulfillment location.',
        payload: {
          qualifiedId: 'semantic:locations:dimension:location_name',
          compatibilityFacts: ['alternative-for:region'],
        },
      },
    ];
    const plan = buildAnalysisQuestionPlan(question, {
      kind: 'contextual',
      memberBindings: [{
        dimension: 'customer', values: ['Joy Lam'], source: 'prior_result', confidence: 'exact',
      }],
    });
    const evidence = toAgentRetrievalEvidence({
      candidates: [], byEvidenceClass: { certified: [], semantic: [], sql: [] }, ambiguousGroups: [],
    }, plan, { contextObjects: objects });

    expect(evidence.parsedIntent?.filters).toEqual([
      { field: 'semantic:customers:dimension:customer_name', value: 'Joy Lam' },
    ]);
    expect(evidence.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'semantic_member', name: 'Joy Lam', qualifiedId: expect.stringContaining('semantic:member:') }),
    ]));
    expect(evidence.clarificationCandidates?.map((candidate) => candidate.id)).toEqual(expect.arrayContaining([
      'semantic:metric:order_item.drink_revenue',
      'semantic:metric:orders.order_total',
      'semantic:dimension:locations.location_name',
    ]));
    expect(buildProviderMeaningEvidencePackage(evidence).map((candidate) => candidate.id)).not.toEqual(expect.arrayContaining([
      'semantic:metric:order_item.drink_revenue',
      'semantic:metric:orders.order_total',
      'semantic:dimension:locations.location_name',
    ]));

    const untrusted = toAgentRetrievalEvidence({
      candidates: [], byEvidenceClass: { certified: [], semantic: [], sql: [] }, ambiguousGroups: [],
    }, buildAnalysisQuestionPlan('show revenue for Joy Lam customer'), { contextObjects: objects });
    expect(untrusted.parsedIntent?.filters).toEqual([]);
    expect(untrusted.candidates.some((candidate) => candidate.name === 'Joy Lam')).toBe(false);
  });

  it('AGT-030 offers entity-grain ranking measures when a bare ranking requests none', () => {
    // "who are the top customers" names an entity and no measure, so every
    // requested-term lane comes back empty and the clarification used to have
    // nothing to offer.
    const evidence = toAgentRetrievalEvidence({
      candidates: [], byEvidenceClass: { certified: [], semantic: [], sql: [] }, ambiguousGroups: [],
    }, buildAnalysisQuestionPlan('who are the top customers'), { contextObjects: [
      {
        objectKey: 'semantic:measure:customers.lifetime_spend_pretax',
        objectType: 'semantic_measure',
        name: 'customers.lifetime_spend_pretax',
        fullName: 'semantic:customers:lifetime_spend_pretax',
        description: 'Lifetime spend before tax.',
        payload: {
          qualifiedId: 'semantic:customers:lifetime_spend_pretax',
          aggregation: 'sum',
          semanticModel: 'customers',
        },
      },
      {
        // A count of the ranked entity scores every customer 1.
        objectKey: 'semantic:measure:customers.customers',
        objectType: 'semantic_measure',
        name: 'customers.customers',
        fullName: 'semantic:customers:customers',
        description: 'Count of unique customers',
        payload: {
          qualifiedId: 'semantic:customers:customers',
          aggregation: 'count_distinct',
          semanticModel: 'customers',
          aliases: ['customers'],
        },
      },
      {
        // The registry's bare alias node: no aggregation, no grain, and a raw
        // dbt unique_id for prose. It can never be proven compatible.
        objectKey: 'semantic:metric:revenue',
        objectType: 'semantic_metric',
        name: 'revenue',
        fullName: 'semantic:revenue',
        description: 'metric.jaffle_shop.revenue',
        payload: { qualifiedId: 'semantic:revenue', aliases: ['revenue'] },
      },
    ] });

    const ids = (evidence.clarificationCandidates ?? []).map((candidate) => candidate.id);
    expect(ids).toContain('semantic:measure:customers.lifetime_spend_pretax');
    expect(ids).not.toContain('semantic:measure:customers.customers');
    expect(ids).not.toContain('semantic:metric:revenue');
  });

  it('reserves the requested geography lane when many revenue cards are relevant', () => {
    const question = 'show total revenue and beverage revenue by customer region';
    const noisyRevenue = Array.from({ length: 20 }, (_, index): MetadataObject => ({
      objectKey: `semantic:metric:orders.revenue_${index}`,
      objectType: 'semantic_metric',
      name: `revenue_${index}`,
      fullName: `semantic:orders:revenue_${index}`,
      payload: { qualifiedId: `semantic:orders:revenue_${index}`, aliases: ['revenue'] },
    }));
    const evidence = toAgentRetrievalEvidence({
      candidates: [], byEvidenceClass: { certified: [], semantic: [], sql: [] }, ambiguousGroups: [],
    }, buildAnalysisQuestionPlan(question), { contextObjects: [
      ...noisyRevenue,
      {
        objectKey: 'semantic:metric:orders.order_total', objectType: 'semantic_metric', name: 'order_total',
        fullName: 'semantic:orders:order_total', payload: { qualifiedId: 'semantic:orders:order_total', aliases: ['total revenue'] },
      },
      {
        objectKey: 'semantic:metric:order_items.drink_revenue', objectType: 'semantic_metric', name: 'drink_revenue',
        fullName: 'semantic:order_items:drink_revenue', payload: { qualifiedId: 'semantic:order_items:drink_revenue', aliases: ['beverage revenue'] },
      },
      {
        objectKey: 'semantic:dimension:locations.location_name', objectType: 'semantic_dimension', name: 'location_name',
        fullName: 'semantic:locations:dimension:location_name', payload: {
          qualifiedId: 'semantic:locations:dimension:location_name',
          compatibilityFacts: ['alternative-for:region'],
        },
      },
      {
        objectKey: 'semantic:dimension:accounts.owner_email', objectType: 'semantic_dimension', name: 'account_owner_email',
        fullName: 'semantic:accounts:dimension:owner_email', payload: { qualifiedId: 'semantic:accounts:dimension:owner_email' },
      },
      {
        objectKey: 'semantic:dimension:accounts.sentiment', objectType: 'semantic_dimension', name: 'account_sentiment_rating',
        fullName: 'semantic:accounts:dimension:sentiment', payload: { qualifiedId: 'semantic:accounts:dimension:sentiment' },
      },
      {
        objectKey: 'semantic:dimension:stores.location_name', objectType: 'semantic_dimension', name: 'location_name',
        fullName: 'semantic:stores:dimension:location_name', payload: { qualifiedId: 'semantic:stores:dimension:location_name' },
      },
    ] });

    expect(evidence.clarificationCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'semantic:metric:orders.order_total' }),
      expect.objectContaining({ id: 'semantic:metric:order_items.drink_revenue' }),
      expect.objectContaining({ id: 'semantic:dimension:locations.location_name' }),
    ]));
    expect(evidence.clarificationCandidates?.length).toBeLessThanOrEqual(12);
    expect(evidence.clarificationCandidates?.map((candidate) => candidate.id)).not.toEqual(expect.arrayContaining([
      'semantic:dimension:accounts.owner_email',
      'semantic:dimension:accounts.sentiment',
      'semantic:dimension:stores.location_name',
    ]));
    expect(buildProviderMeaningEvidencePackage(evidence)).toEqual([]);
  });

  it('AGT-034 keeps a same-snapshot geographic MetricFlow extension when the raw dimension has a different router ID', () => {
    const locationId = 'semantic:jaffle_shop:dimension:order_items.location_name';
    const metricId = 'semantic:jaffle_shop:metric:order_items.revenue';
    const evidence = toAgentRetrievalEvidence({
      candidates: [{
        objectKey: 'semantic:metric:order_items.revenue',
        qualifiedId: metricId,
        evidenceClass: 'semantic',
        trustTier: 'semantic',
        classRank: 1,
        relevanceScore: 1,
        name: 'order_items.revenue',
        aliases: ['revenue', 'sales'],
        objectType: 'semantic_metric',
        relevanceReasons: ['exact metric'],
        compatibilityFacts: [],
        businessShape: {
          aggregation: 'sum', entities: ['order_item'], dimensions: [locationId], timeGrains: [],
          parameters: [], filters: [], outputs: ['revenue'], sourceRelations: ['order_items'],
        },
        analyticalCapability: {
          metricId,
          semanticModelId: 'semantic:jaffle_shop:model:order_items',
          measureIds: ['semantic:jaffle_shop:measure:order_items.product_price'],
          primaryEntityId: 'semantic:jaffle_shop:entity:order_items.order_item',
          defaultResultGrainId: 'semantic:jaffle_shop:entity:order_items.order_item',
          resultGrainIds: ['semantic:jaffle_shop:entity:order_items.order_item'],
          aggregation: 'sum',
          additivity: { entities: 'additive', time: 'additive' },
          dimensions: [{
            dimensionId: locationId,
            entityId: 'semantic:jaffle_shop:entity:order_items.order_item',
            label: 'Location Name',
            aliases: ['location_name', 'Location Name'],
            supportedRoles: ['group_by', 'display'],
            relationshipPathIds: [],
          }],
          timeDimensions: [],
          operations: ['group'],
          supportedOutputKinds: ['dimension', 'metric_value'],
          executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow' }],
          sourceFingerprint: 'fixture:region-extension',
        },
        ambiguityPeerIds: [],
      }, {
        // This represents the real local catalog shape: the execution/router
        // identity is a legacy objectKey while its qualified identity is the
        // same MetricFlow dimension the extension binds. It must not suppress
        // the supplemental role card merely because their qualified IDs match.
        objectKey: 'semantic:dimension:order_items.location_name',
        qualifiedId: locationId,
        evidenceClass: 'semantic',
        trustTier: 'semantic',
        classRank: 2,
        relevanceScore: 0.8,
        name: 'order_items.location_name',
        aliases: ['location_name', 'Location Name'],
        objectType: 'semantic_dimension',
        relevanceReasons: ['retrieved local dimension'],
        compatibilityFacts: [],
        businessShape: {
          entities: [], dimensions: [], timeGrains: [], parameters: [], filters: [], outputs: [], sourceRelations: ['order_items'],
        },
        ambiguityPeerIds: [],
      }],
      byEvidenceClass: { certified: [], semantic: [], sql: [] },
      ambiguousGroups: [],
    }, buildAnalysisQuestionPlan('Show revenue by sales based on the region'));

    const extension = evidence.clarificationCandidates?.find((candidate) =>
      candidate.sameSnapshotRoleExtension?.dimensionId === locationId);
    expect(extension).toMatchObject({
      id: locationId,
      kind: 'semantic_member',
      aliases: expect.arrayContaining(['region']),
      sameSnapshotRoleExtension: {
        metricId,
        dimensionId: locationId,
        requestedTerm: 'region',
        basis: 'sole_metricflow_grouping_dimension',
      },
    });
  });

  it('AGT-034 surfaces the exact capability-backed product type for an explicit product-category role', () => {
    const metricId = 'semantic:jaffle_shop:metric:order_item.revenue';
    const productTypeId = 'semantic:jaffle_shop:dimension:products.product_type';
    const questionPlan = buildAnalysisQuestionPlan('who are the top customers who have revenue by product category?');
    expect(questionPlan.requestedShape.dimensions).toContain('product_category');
    const evidence = toAgentRetrievalEvidence({
      candidates: [{
        objectKey: 'semantic:metric:order_item.revenue',
        qualifiedId: metricId,
        evidenceClass: 'semantic',
        trustTier: 'semantic',
        classRank: 1,
        relevanceScore: 1,
        name: 'order_item.revenue',
        aliases: ['revenue', 'sales'],
        objectType: 'semantic_metric',
        relevanceReasons: ['exact metric'],
        compatibilityFacts: [],
        businessShape: {
          aggregation: 'sum', entities: ['order_item'], dimensions: [productTypeId], timeGrains: [],
          parameters: [], filters: [], outputs: ['revenue'], sourceRelations: ['order_items'],
        },
        analyticalCapability: {
          metricId,
          semanticModelId: 'semantic:jaffle_shop:model:order_item',
          measureIds: ['semantic:jaffle_shop:measure:order_item.revenue'],
          primaryEntityId: 'semantic:jaffle_shop:entity:order_item.order_item',
          defaultResultGrainId: 'semantic:jaffle_shop:entity:order_item.order_item',
          resultGrainIds: ['semantic:jaffle_shop:entity:order_item.order_item'],
          aggregation: 'sum',
          additivity: { entities: 'additive', time: 'additive' },
          dimensions: [{
            dimensionId: productTypeId,
            entityId: 'semantic:jaffle_shop:entity:products.product',
            label: 'product_type',
            aliases: ['product_type', 'products.product_type'],
            supportedRoles: ['group_by', 'display'],
            nativeGroupingReference: 'product__product_type',
            nativeGroupingPath: ['product'],
            relationshipPathIds: [],
          }],
          timeDimensions: [],
          operations: ['group', 'rank'],
          supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
          executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow' }],
          sourceFingerprint: 'fixture:product-category-extension',
        },
        ambiguityPeerIds: [],
      }],
      byEvidenceClass: { certified: [], semantic: [], sql: [] },
      ambiguousGroups: [],
    }, questionPlan);

    const extension = evidence.clarificationCandidates?.find((candidate) =>
      candidate.sameSnapshotRoleExtension?.dimensionId === productTypeId);
    expect(extension).toMatchObject({
      id: productTypeId,
      qualifiedId: productTypeId,
      kind: 'semantic_member',
      aliases: expect.arrayContaining(['product category']),
      sameSnapshotRoleExtension: {
        metricId,
        dimensionId: productTypeId,
        requestedTerm: 'product category',
        basis: 'exact_metricflow_grouping_dimension',
      },
    });
  });
});
