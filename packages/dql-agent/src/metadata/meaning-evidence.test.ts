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
        payload: { qualifiedId: 'semantic:locations:dimension:location_name' },
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
        fullName: 'semantic:locations:dimension:location_name', payload: { qualifiedId: 'semantic:locations:dimension:location_name' },
      },
    ] });

    expect(evidence.clarificationCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'semantic:metric:orders.order_total' }),
      expect.objectContaining({ id: 'semantic:metric:order_items.drink_revenue' }),
      expect.objectContaining({ id: 'semantic:dimension:locations.location_name' }),
    ]));
    expect(evidence.clarificationCandidates?.length).toBeLessThanOrEqual(12);
    expect(buildProviderMeaningEvidencePackage(evidence)).toEqual([]);
  });
});
