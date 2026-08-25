import { describe, expect, it } from 'vitest';
import { buildDeterministicAnalyticalFrame, resolveMetricCapabilityDimension } from './analytical-frame.js';
import type { AgentEvidenceCandidate, AgentRetrievalEvidence } from './meaning-resolution.js';

function bcmMetric(overrides: Partial<AgentEvidenceCandidate> = {}): AgentEvidenceCandidate {
  return {
    id: 'semantic:metric:account_revenue.bcm_run_rate',
    qualifiedId: 'semantic:metric:account_revenue.bcm_run_rate',
    kind: 'semantic_metric',
    semanticObjectType: 'metric',
    trustTier: 'semantic',
    name: 'BCM Run Rate',
    aliases: ['BCM', 'run rate'],
    definition: 'Synthetic current BCM run-rate metric.',
    relevanceScore: 1,
    matchReasons: ['fixture metric'],
    compatibility: 'compatible',
    analyticalCapability: {
      metricId: 'semantic:account_revenue:bcm_run_rate',
      measureIds: ['semantic:account_revenue:bcm_run_rate_measure'],
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
      }],
      timeDimensions: [],
      operations: ['group', 'rank'],
      supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
      executionCapabilities: [{ route: 'semantic', adapterId: 'fixture-semantic' }],
      sourceFingerprint: 'sha256:fixture-bcm',
    },
    ...overrides,
  };
}

function evidence(overrides: Partial<AgentRetrievalEvidence['parsedIntent']> = {}): AgentRetrievalEvidence {
  return {
    candidates: [],
    parsedIntent: {
      measures: ['bcm', 'run rate'],
      dimensions: ['account'],
      filters: [],
      order: 'desc',
      limit: 10,
      ...overrides,
    },
  };
}

describe('deterministic analytical frame temporal intent', () => {
  it('treats bare current as a snapshot metric modifier, not a missing time-axis request', () => {
    const metric = bcmMetric();
    const frame = buildDeterministicAnalyticalFrame({
      question: 'What is the current BCM run rate across top accounts?',
      evidence: evidence(),
      metricCandidate: metric,
      candidates: [metric],
    });

    expect(frame).toMatchObject({
      metricConceptIds: ['semantic:account_revenue:bcm_run_rate'],
      dimensions: expect.arrayContaining([
        { dimensionId: 'semantic:dimension:account_revenue.account_name', role: 'group_by' },
        { dimensionId: 'semantic:dimension:account_revenue.account_name', role: 'rank_entity' },
      ]),
      ranking: {
        entityDimensionId: 'semantic:dimension:account_revenue.account_name',
        byMetricId: 'semantic:account_revenue:bcm_run_rate',
        direction: 'desc',
        limit: 10,
      },
    });
    expect(frame?.timeContext).toBeUndefined();
    expect(frame?.dimensions.some((dimension) => dimension.role === 'time_axis')).toBe(false);
    expect(frame?.ambiguity).toEqual([]);
  });

  it('keeps a real by-month request in the declared time-role contract', () => {
    const metric = bcmMetric({
      analyticalCapability: {
        ...bcmMetric().analyticalCapability!,
        timeDimensions: [{
          dimensionId: 'semantic:dimension:account_revenue.fiscal_period',
          role: 'fiscal_period',
          supportedGrains: ['month'],
        }],
      },
    });
    const frame = buildDeterministicAnalyticalFrame({
      question: 'Show BCM run rate by month across top accounts.',
      evidence: evidence({ dimensions: ['account'], timeGrain: 'month' }),
      metricCandidate: metric,
      candidates: [metric],
    });

    expect(frame?.timeContext).toMatchObject({
      timeDimensionId: 'semantic:dimension:account_revenue.fiscal_period',
      timeRole: 'fiscal_period',
      grain: 'month',
    });
    expect(frame?.dimensions).toEqual(expect.arrayContaining([
      { dimensionId: 'semantic:dimension:account_revenue.fiscal_period', role: 'time_axis' },
    ]));
  });

  it('AGT-034 binds a ranking entity only to the unique metric-native display/rank field', () => {
    const metric = bcmMetric({
      analyticalCapability: {
        ...bcmMetric().analyticalCapability!,
        dimensions: [
          {
            dimensionId: 'semantic:dimension:customers.customer_name',
            entityId: 'semantic:entity:customers.customer',
            label: 'Customer Name',
            aliases: ['customer', 'customer name'],
            supportedRoles: ['group_by', 'display', 'rank_entity'],
          },
          {
            dimensionId: 'semantic:dimension:customers.customer_type',
            entityId: 'semantic:entity:customers.customer',
            label: 'Customer Type',
            aliases: ['customer'],
            supportedRoles: ['group_by', 'display', 'rank_entity'],
          },
          {
            dimensionId: 'semantic:dimension:orders.customer_order_number',
            entityId: 'semantic:entity:orders.order',
            label: 'Customer Order Number',
            aliases: ['customer'],
            supportedRoles: ['group_by', 'display', 'rank_entity'],
          },
          {
            dimensionId: 'semantic:dimension:products.product_type',
            entityId: 'semantic:entity:products.product',
          label: 'Product Type',
          aliases: ['product category'],
          // Some adapter/index versions advertise a broad rankable role for
          // every group-by field. That capability does not supersede the
          // host-resolved customer display/rank role.
          supportedRoles: ['group_by', 'display', 'rank_entity'],
          },
        ],
      },
    });
    const entityCard: AgentEvidenceCandidate = {
      id: 'semantic:entity:customers.customer',
      qualifiedId: 'semantic:entity:customers.customer',
      kind: 'semantic_member',
      semanticObjectType: 'entity',
      trustTier: 'semantic',
      name: 'Customer',
      definition: 'Customer entity.',
      relevanceScore: 1,
      matchReasons: ['fixture entity'],
      compatibility: 'compatible',
    };
    const frame = buildDeterministicAnalyticalFrame({
      question: 'who are the top customers who have revenue by product category?',
      evidence: evidence({
        measures: ['revenue'],
        dimensions: ['customer name', 'product category'],
        filters: [],
        order: 'desc',
        limit: 10,
      }),
      metricCandidate: metric,
      // The bounded meaning result selected the entity ID, not the display
      // field. It may not lexical-fallback to the first `customer*` member.
      selectedDimensionIds: [entityCard.id],
      entityTerms: ['customer'],
      entityDisplayTerms: ['customer name'],
      candidates: [metric, entityCard],
    });

    expect(frame?.ambiguity).toEqual([]);
    expect(frame?.dimensions).toEqual(expect.arrayContaining([
      { dimensionId: 'semantic:dimension:customers.customer_name', role: 'group_by' },
      { dimensionId: 'semantic:dimension:customers.customer_name', role: 'rank_entity' },
      { dimensionId: 'semantic:dimension:products.product_type', role: 'group_by' },
    ]));
    expect(frame?.dimensions).not.toContainEqual({
      dimensionId: 'semantic:dimension:products.product_type',
      role: 'rank_entity',
    });
    expect(frame?.dimensions.some((dimension) => /customer_(?:type|order_number)$/.test(dimension.dimensionId))).toBe(false);
    expect(frame?.ranking).toMatchObject({
      entityDimensionId: 'semantic:dimension:customers.customer_name',
      direction: 'desc',
      limit: 10,
    });

    // Older semantic capability indexes can describe the native customer
    // display role simply as `customer` and omit the newer explicit display
    // flag. It remains valid only because it is the unique exact native
    // entity identity; the similarly scoped attribute fields cannot win.
    const legacyMetric = bcmMetric({
      analyticalCapability: {
        ...bcmMetric().analyticalCapability!,
        dimensions: [{
          dimensionId: 'semantic:dimension:customers.customer',
          entityId: 'semantic:entity:customers.customer',
          label: 'Customer',
          aliases: ['customers'],
          supportedRoles: ['group_by', 'rank_entity'],
        }, {
          dimensionId: 'semantic:dimension:customers.customer_type',
          entityId: 'semantic:entity:customers.customer',
          label: 'Customer Type',
          aliases: ['customer'],
          supportedRoles: ['group_by', 'display', 'rank_entity'],
        }, {
          dimensionId: 'semantic:dimension:orders.customer_order_number',
          entityId: 'semantic:entity:orders.order',
          label: 'Customer Order Number',
          aliases: ['customer'],
          supportedRoles: ['group_by', 'display', 'rank_entity'],
        }],
      },
    });
    const legacyFrame = buildDeterministicAnalyticalFrame({
      question: 'who are the top customers by revenue?',
      evidence: evidence({ measures: ['revenue'], dimensions: ['customer name'], filters: [], order: 'desc', limit: 10 }),
      metricCandidate: legacyMetric,
      entityTerms: ['customer'],
      entityDisplayTerms: ['customer name'],
      candidates: [legacyMetric],
    });
    expect(legacyFrame?.ambiguity).toEqual([]);
    expect(legacyFrame?.ranking?.entityDimensionId).toBe('semantic:dimension:customers.customer');
    expect(legacyFrame?.dimensions).toEqual(expect.arrayContaining([
      { dimensionId: 'semantic:dimension:customers.customer', role: 'rank_entity' },
    ]));
    expect(legacyFrame?.dimensions.some((dimension) => /customer_(?:type|order_number)$/.test(dimension.dimensionId))).toBe(false);
  });

  it('AGT-034 retains an exact same-snapshot unclassified namespace dimension for semantic extension proof', () => {
    const metric = bcmMetric({
      analyticalCapability: {
        ...bcmMetric().analyticalCapability!,
        dimensions: [{
          dimensionId: 'semantic:uncategorized:dimension:locations.location_name',
          entityId: 'semantic:uncategorized:entity:locations.location',
          label: 'Location Name',
          aliases: ['region'],
          supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
          nativeGroupingReference: 'order_id__location__location_name',
          nativeGroupingPath: ['order_id', 'location'],
        }],
      },
    });

    expect(resolveMetricCapabilityDimension(
      metric,
      'semantic:uncategorized:dimension:locations.location_name',
    )?.dimensionId).toBe('semantic:uncategorized:dimension:locations.location_name');
    // This is the one documented protocol alias. It is still an exact
    // namespace identity, not a leaf-name match that could cross models.
    expect(resolveMetricCapabilityDimension(
      metric,
      'semantic:dimension:locations.location_name',
    )?.dimensionId).toBe('semantic:uncategorized:dimension:locations.location_name');
    expect(resolveMetricCapabilityDimension(
      metric,
      'semantic:uncategorized:dimension:other_locations.location_name',
    )).toBeUndefined();
  });
});
