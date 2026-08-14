import { describe, expect, it } from 'vitest';
import type { LocalContextPack } from './metadata/catalog.js';
import {
  buildAggregationSafetyProof,
  buildSemanticCompilationAggregationSafetyProof,
} from './aggregation-safety-proof.js';
import { buildResolvedRelationshipProofsV1 } from './relationship-proof.js';

const additiveCapability = {
  metricId: 'semantic:sales:revenue',
  semanticModelId: 'semantic:sales:model:orders',
  measureIds: ['semantic:sales:measure:revenue'],
  primaryEntityId: 'semantic:sales:entity:order',
  defaultResultGrainId: 'semantic:sales:entity:order',
  resultGrainIds: ['semantic:sales:entity:order'],
  aggregation: 'sum',
  additivity: { entities: 'additive', time: 'additive' },
  dimensions: [],
  timeDimensions: [],
  operations: [],
  supportedOutputKinds: ['metric_value'],
  executionCapabilities: [{ route: 'governed_sql' }],
  sourceFingerprint: 'sha256:metric',
};

function context(objects: LocalContextPack['objects']): LocalContextPack {
  return {
    objects,
    routeDecision: {},
    questionPlan: { requestedShape: { grain: 'semantic:sales:entity:order', dimensions: [] } },
  } as unknown as LocalContextPack;
}

describe('buildAggregationSafetyProof', () => {
  it('records safe aggregation only from positive additive metadata evidence', () => {
    const proof = buildAggregationSafetyProof(
      'SELECT SUM(orders.revenue) AS revenue FROM orders',
      context([{ objectKey: 'metric', objectType: 'semantic_metric', name: 'revenue', payload: { table: 'orders', formula: 'revenue', analyticalCapability: additiveCapability } }]),
    );
    expect(proof).toMatchObject({
      version: 1,
      status: 'safe',
      metricIds: ['semantic:sales:revenue'],
      additivity: 'additive',
      fanout: 'proven_absent',
      rounding: 'none',
      issueCodes: [],
    });
  });

  it('proves the exact native customer grouping path and rejects an arbitrary join key', () => {
    const capability = {
      ...additiveCapability,
      primaryEntityId: 'order_item',
      defaultResultGrainId: 'order_item',
      resultGrainIds: ['order_item', 'customer'],
      dimensions: [{
        dimensionId: 'semantic:dimension:customer.customer_name',
        entityId: 'customer',
        supportedRoles: ['group_by' as const, 'rank_entity' as const],
        relationshipPathIds: ['relationship:order_item_to_order', 'relationship:order_to_customer'],
        nativeGroupingPath: ['order_item', 'order', 'customer'],
      }],
    };
    const relationship = (
      objectKey: string,
      fromRelation: string,
      toRelation: string,
      from: string,
      to: string,
    ) => ({
      objectKey,
      objectType: 'dql_relationship',
      name: objectKey,
      payload: {
        fromRelation, toRelation, cardinality: 'many_to_one', keys: [{ from, to }],
        validation: {
          status: 'passed', fromRows: 11, toRows: 7, joinedRows: 11,
          fromNullKeys: 0, toNullKeys: 0, unmatchedFrom: 0, maxFromPerKey: 3, maxToPerKey: 1,
        },
      },
    });
    const safeContext = context([
      relationship('relationship:order_item_to_order', 'order_items', 'orders', 'order_id', 'order_id'),
      relationship('relationship:order_to_customer', 'orders', 'customers', 'customer_id', 'customer_id'),
    ]);
    safeContext.questionPlan.requestedShape = {
      grain: 'customer',
      dimensions: ['semantic:dimension:customer.customer_name'],
    } as never;
    const safeSql = [
      'SELECT customers.customer_name, SUM(order_items.product_price) AS revenue',
      'FROM order_items',
      'JOIN orders ON order_items.order_id = orders.order_id',
      'JOIN customers ON orders.customer_id = customers.customer_id',
      'GROUP BY customers.customer_name',
      'ORDER BY revenue DESC',
    ].join('\n');

    expect(buildSemanticCompilationAggregationSafetyProof({
      sql: safeSql, capability, contextPack: safeContext, planFingerprint: 'plan-revenue-customer',
    })).toMatchObject({
      status: 'safe', metricIds: [capability.metricId], fanout: 'proven_absent', issueCodes: [],
    });
    expect(buildSemanticCompilationAggregationSafetyProof({
      sql: safeSql.replace('orders.customer_id = customers.customer_id', 'orders.order_id = customers.customer_id'),
      capability, contextPack: safeContext, planFingerprint: 'plan-revenue-customer',
    })).toMatchObject({
      status: 'blocked',
      issueCodes: expect.arrayContaining(['JOIN_RELATIONSHIP_EXACT_MATCH_MISSING']),
    });
  });

  it('accepts native grouping only from the exact pinned semantic relationship authority', () => {
    const dimensionId = 'semantic:uncategorized:dimension:customers.customer_name';
    const capability = {
      ...additiveCapability,
      metricId: 'semantic:uncategorized:metric:order_item.revenue',
      primaryEntityId: 'semantic:uncategorized:entity:order_item',
      defaultResultGrainId: 'semantic:uncategorized:entity:order_item',
      resultGrainIds: ['semantic:uncategorized:entity:order_item', 'semantic:uncategorized:entity:customer'],
      executionCapabilities: [{ route: 'semantic' as const, adapterId: 'metricflow-cli' }],
      sourceFingerprint: 'sha256:jaffle-revenue',
      dimensions: [{
        dimensionId,
        entityId: 'semantic:uncategorized:entity:customer',
        supportedRoles: ['group_by' as const, 'rank_entity' as const],
        nativeGroupingReference: 'order_id__customer__customer_name',
        nativeGroupingPath: ['order_id', 'customer'],
      }],
    };
    const [relationshipProof] = buildResolvedRelationshipProofsV1({
      capability,
      dimensionIds: [dimensionId],
      route: 'semantic', adapterId: 'metricflow-cli',
      executionId: capability.metricId, snapshotId: 'snapshot-jaffle',
    });
    const nativeContext = context([]);
    nativeContext.routeDecision = {
      grainGate: { requestedGrain: 'customer', sourceId: 'dql:block:customer_profile' },
    } as never;
    nativeContext.questionPlan.requestedShape = {
      grain: 'semantic:uncategorized:entity:customer',
      dimensions: [dimensionId],
    } as never;
    const sql = [
      'SELECT customers.customer_name, SUM(order_items.revenue) AS revenue',
      'FROM order_items',
      'JOIN orders ON order_items.order_id = orders.order_id',
      'JOIN customers ON orders.customer_id = customers.customer_id',
      'GROUP BY customers.customer_name',
    ].join('\n');
    const exactInput = {
      sql, capability, contextPack: nativeContext, planFingerprint: 'plan-jaffle',
      relationshipProofs: [relationshipProof!], executionId: capability.metricId,
      snapshotId: 'snapshot-jaffle', capabilityFingerprint: capability.sourceFingerprint,
      route: 'semantic' as const, adapterId: 'metricflow-cli',
      semanticAuthority: {
        version: 1 as const,
        planId: 'rap:jaffle',
        planFingerprint: 'plan-jaffle',
        snapshotId: 'snapshot-jaffle',
        executionId: capability.metricId,
        capabilityFingerprint: capability.sourceFingerprint,
        metricIds: [capability.metricId],
        dimensionIds: [dimensionId],
        entityGrainIds: ['semantic:uncategorized:entity:customer'],
        filterDimensionIds: [],
        order: 'desc' as const,
        limit: 10,
        relationshipProofs: [relationshipProof!],
        relationshipObjects: [],
      },
    };
    expect(buildSemanticCompilationAggregationSafetyProof(exactInput)).toMatchObject({
      status: 'safe',
      requestedGrain: [
        dimensionId,
        'semantic:uncategorized:entity:customer',
      ],
      issueCodes: [],
      fanout: 'proven_absent',
    });
    expect(buildSemanticCompilationAggregationSafetyProof({
      ...exactInput,
      semanticAuthority: {
        ...exactInput.semanticAuthority,
        dimensionIds: ['semantic:uncategorized:dimension:customers.unsupported'],
      },
    })).toMatchObject({
      status: 'blocked',
      issueCodes: expect.arrayContaining(['REQUESTED_GRAIN_CAPABILITY_MISMATCH']),
    });
    expect(buildSemanticCompilationAggregationSafetyProof({
      ...exactInput,
      semanticAuthority: {
        ...exactInput.semanticAuthority,
        relationshipProofs: [{ ...relationshipProof!, nativeGroupingPath: ['customer'] }],
      },
    })).toMatchObject({
      status: 'blocked',
      issueCodes: expect.arrayContaining(['RELATIONSHIP_PROOF_AUTHORITY_MISMATCH']),
    });
    expect(buildSemanticCompilationAggregationSafetyProof({
      sql, capability, contextPack: nativeContext, planFingerprint: 'raw-generated-sql',
      relationshipProofs: [relationshipProof!],
    })).toMatchObject({
      status: 'blocked',
      issueCodes: expect.arrayContaining(['RELATIONSHIP_PROOF_AUTHORITY_MISMATCH']),
    });
  });

  it('blocks aggregate SQL when governed additivity evidence is missing', () => {
    expect(buildAggregationSafetyProof(
      'SELECT SUM(orders.revenue) AS revenue FROM orders',
      context([]),
    )).toMatchObject({
      status: 'blocked',
      issueCodes: expect.arrayContaining(['METRIC_CAPABILITY_MISSING', 'ADDITIVITY_EVIDENCE_MISSING']),
    });
  });

  it('blocks an exactly bound non-additive metric even at its native grain', () => {
    const capability = {
      ...additiveCapability,
      metricId: 'semantic:customer:lifetime_value',
      additivity: { entities: 'non_additive' as const, time: 'non_additive' as const },
    };
    const proof = buildAggregationSafetyProof(
      'SELECT SUM(customers.lifetime_value) FROM customers',
      context([{ objectKey: 'metric', objectType: 'semantic_metric', name: 'lifetime_value', payload: {
        table: 'customers', formula: 'lifetime_value', analyticalCapability: capability,
      } }]),
    );
    expect(proof).toMatchObject({
      status: 'blocked',
      metricIds: ['semantic:customer:lifetime_value'],
      additivity: 'non_additive',
      fanout: 'proven_absent',
      issueCodes: expect.arrayContaining(['NON_ADDITIVE_AGGREGATION_UNSUPPORTED']),
    });
  });

  it('distinguishes compiler-owned ratio calculation from rolling up a non-additive ratio output', () => {
    const ratioCapability = {
      ...additiveCapability,
      metricId: 'semantic:sales:food_revenue_pct',
      measureIds: ['semantic:sales:measure:food_revenue', 'semantic:sales:measure:revenue'],
      aggregation: 'ratio',
      additivity: { entities: 'non_additive' as const, time: 'non_additive' as const },
    };
    const compilerBinding = {
      compilerMetricExpressionSql: 'SUM(CASE WHEN is_food THEN amount ELSE 0 END) / SUM(amount)',
      compilerMetricId: ratioCapability.metricId,
      compilerMeasureIds: ratioCapability.measureIds,
      compilerRelation: 'orders',
    };
    expect(buildSemanticCompilationAggregationSafetyProof({
      sql: 'SELECT SUM(CASE WHEN is_food THEN amount ELSE 0 END) / SUM(amount) AS food_revenue_pct FROM orders',
      capability: ratioCapability,
      contextPack: context([]),
      planFingerprint: 'plan-ratio',
      ...compilerBinding,
    })).toMatchObject({ status: 'safe', metricIds: [ratioCapability.metricId], issueCodes: [] });
    expect(buildSemanticCompilationAggregationSafetyProof({
      sql: 'SELECT CAST(SUM(CASE WHEN is_food THEN amount ELSE 0 END) AS DOUBLE) / CAST(NULLIF(SUM(amount), 0) AS DOUBLE) AS food_revenue_pct FROM "analytics"."orders"',
      capability: ratioCapability,
      contextPack: context([]),
      planFingerprint: 'plan-ratio-quoted',
      ...compilerBinding,
      compilerRelation: '"analytics"."orders"',
    })).toMatchObject({ status: 'safe', metricIds: [ratioCapability.metricId], issueCodes: [] });
    for (const sql of [
      'SELECT SUM(secret_salary) / SUM(secret_tax) AS food_revenue_pct FROM orders',
      'SELECT SUM(CASE WHEN is_food THEN amount ELSE 0 END) + SUM(amount) AS food_revenue_pct FROM orders',
    ]) {
      expect(buildSemanticCompilationAggregationSafetyProof({
        sql,
        capability: ratioCapability,
        contextPack: context([]),
        planFingerprint: 'plan-ratio',
        ...compilerBinding,
      }), sql).toMatchObject({
        status: 'blocked',
        issueCodes: expect.arrayContaining([
          'SEMANTIC_RATIO_COMPILER_BINDING_REQUIRED',
          'NON_ADDITIVE_AGGREGATION_UNSUPPORTED',
        ]),
      });
    }
    expect(buildSemanticCompilationAggregationSafetyProof({
      sql: 'SELECT SUM(orders.food_revenue_pct) AS food_revenue_pct FROM orders',
      capability: ratioCapability,
      contextPack: context([]),
      planFingerprint: 'plan-ratio',
      ...compilerBinding,
    })).toMatchObject({
      status: 'blocked',
      issueCodes: expect.arrayContaining(['NON_ADDITIVE_AGGREGATION_UNSUPPORTED']),
    });
  });

  it('requires an explicit protected time/grain contract for semi-additive aggregation', () => {
    const snapshotDate = 'semantic:balance:dimension:snapshot_date';
    const capability = {
      ...additiveCapability,
      metricId: 'semantic:balance:ending_balance',
      additivity: {
        entities: 'additive' as const,
        time: 'semi_additive' as const,
        nonAdditiveDimensionIds: [snapshotDate],
      },
      timeDimensions: [{
        dimensionId: snapshotDate,
        role: 'snapshot_time',
        supportedGrains: ['day', 'month'],
        defaultFor: ['scalar' as const],
      }],
    };
    const objects = [{ objectKey: 'metric', objectType: 'semantic_metric', name: 'ending_balance', payload: {
      table: 'balances', formula: 'ending_balance', analyticalCapability: capability,
    } }];

    expect(buildAggregationSafetyProof(
      'SELECT SUM(balances.ending_balance) FROM balances', context(objects),
    )).toMatchObject({
      status: 'blocked',
      additivity: 'semi_additive',
      fanout: 'proven_absent',
      issueCodes: expect.arrayContaining(['SEMI_ADDITIVE_TIME_GRAIN_PROOF_REQUIRED']),
    });

    const safeContext = context(objects);
    safeContext.questionPlan = { requestedShape: {
      grain: 'semantic:sales:entity:order', dimensions: [snapshotDate],
    } } as never;
    expect(buildAggregationSafetyProof(
      'SELECT SUM(balances.ending_balance) FROM balances', safeContext,
    )).toMatchObject({ status: 'safe', additivity: 'semi_additive', issueCodes: [] });
  });

  it('does not borrow an unrelated additive capability or relationship', () => {
    const unrelated = context([
      { objectKey: 'metric', objectType: 'semantic_metric', name: 'revenue', payload: { table: 'orders', formula: 'revenue', analyticalCapability: additiveCapability } },
      { objectKey: 'relationship', objectType: 'dql_relationship', name: 'safe', payload: { fromRelation: 'orders', toRelation: 'customers', keys: [{ from: 'customer_id', to: 'id' }], cardinality: 'many_to_one', fanout: 'safe' } },
    ]);
    expect(buildAggregationSafetyProof('SELECT SUM(leaks.secret_amount) FROM leaks', unrelated)).toMatchObject({
      status: 'blocked',
      issueCodes: expect.arrayContaining(['AGGREGATE_CAPABILITY_EXACT_MATCH_MISSING']),
    });
    expect(buildAggregationSafetyProof('SELECT SUM(a.amount) FROM a JOIN b ON a.id = b.id', unrelated)).toMatchObject({
      status: 'blocked',
      issueCodes: expect.arrayContaining(['JOIN_RELATIONSHIP_EXACT_MATCH_MISSING']),
    });
  });

  it('requires requested grain and exact counted join provenance', () => {
    const joined = context([
      { objectKey: 'metric', objectType: 'semantic_metric', name: 'revenue', payload: { table: 'orders', formula: 'revenue', analyticalCapability: additiveCapability } },
      {
        objectKey: 'relationship', objectType: 'dql_relationship', name: 'order_customer', payload: {
          fromRelation: 'orders', toRelation: 'customers',
          keys: [{ from: 'customer_id', to: 'id' }], cardinality: 'many_to_one', fanout: 'safe',
          validation: { status: 'passed', fromRows: 10, toRows: 5, joinedRows: 10, fromNullKeys: 0, toNullKeys: 0, unmatchedFrom: 0, maxFromPerKey: 2, maxToPerKey: 1 },
        },
      },
    ]);
    expect(buildAggregationSafetyProof(
      'SELECT SUM(o.revenue) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.id',
      joined,
    )).toMatchObject({ status: 'safe', fanout: 'proven_absent', joinCardinalities: ['many_to_one'] });

    const noGrain = { ...joined, questionPlan: { requestedShape: { dimensions: [] } } } as LocalContextPack;
    expect(buildAggregationSafetyProof('SELECT SUM(orders.revenue) FROM orders', noGrain)).toMatchObject({
      status: 'blocked',
      issueCodes: expect.arrayContaining(['REQUESTED_GRAIN_EVIDENCE_MISSING']),
    });
  });

  it('blocks reversed/composite/ambiguous relationship mismatches', () => {
    const objects = context([
      { objectKey: 'metric', objectType: 'semantic_metric', name: 'revenue', payload: { table: 'orders', formula: 'revenue', analyticalCapability: additiveCapability } },
      { objectKey: 'relationship:a', objectType: 'relationship', name: 'a', payload: { fromRelation: 'orders', toRelation: 'customers', keys: [{ from: 'customer_id', to: 'id' }, { from: 'tenant_id', to: 'tenant_id' }], cardinality: 'many_to_one', fanout: 'safe' } },
    ]);
    expect(buildAggregationSafetyProof(
      'SELECT SUM(o.revenue) FROM orders o JOIN customers c ON o.customer_id = c.id', objects,
    )).toMatchObject({ status: 'blocked', issueCodes: expect.arrayContaining(['JOIN_RELATIONSHIP_EXACT_MATCH_MISSING']) });
  });

  it('proves fanout from the aggregate-owning side instead of trusting a global safe label', () => {
    const customerCapability = {
      ...additiveCapability,
      metricId: 'semantic:customers:lifetime_value',
      semanticModelId: 'semantic:customers:model',
      measureIds: ['semantic:customers:measure:lifetime_value'],
      primaryEntityId: 'semantic:customers:entity:customer',
      defaultResultGrainId: 'semantic:customers:entity:customer',
      resultGrainIds: ['semantic:customers:entity:customer'],
      sourceFingerprint: 'sha256:customer-lifetime-value',
    };
    const objects = context([
      { objectKey: 'customer_metric', objectType: 'semantic_metric', name: 'lifetime_value', payload: { table: 'customers', formula: 'lifetime_value', analyticalCapability: customerCapability } },
      { objectKey: 'order_metric', objectType: 'semantic_metric', name: 'revenue', payload: { table: 'orders', formula: 'revenue', analyticalCapability: additiveCapability } },
      {
        objectKey: 'orders_customer', objectType: 'dql_relationship', name: 'orders_customer', payload: {
          fromRelation: 'orders', toRelation: 'customers', keys: [{ from: 'customer_id', to: 'id' }],
          cardinality: 'many_to_one', fanout: 'safe',
          validation: { status: 'passed', fromRows: 100, toRows: 10, joinedRows: 100, fromNullKeys: 0, toNullKeys: 0, unmatchedFrom: 0, maxFromPerKey: 20, maxToPerKey: 1 },
        },
      },
    ]);
    objects.questionPlan = { requestedShape: { grain: 'semantic:customers:entity:customer', dimensions: [] } } as never;

    for (const sql of [
      'SELECT SUM(c.lifetime_value) FROM customers c JOIN orders o ON c.id = o.customer_id',
      'SELECT SUM(c.lifetime_value) FROM orders o JOIN customers c ON o.customer_id = c.id',
      'SELECT SUM(c.lifetime_value) FROM customers c LEFT JOIN orders o ON c.id = o.customer_id',
    ]) {
      expect(buildAggregationSafetyProof(sql, objects), sql).toMatchObject({
        status: 'blocked',
        fanout: 'unknown',
        issueCodes: expect.arrayContaining(['JOIN_FANOUT_DIRECTION_UNSAFE']),
      });
    }

    objects.questionPlan = { requestedShape: { grain: 'semantic:sales:entity:order', dimensions: [] } } as never;
    expect(buildAggregationSafetyProof(
      'SELECT SUM(o.revenue) FROM orders o LEFT JOIN customers c ON o.customer_id = c.id',
      objects,
    )).toMatchObject({ status: 'safe', fanout: 'proven_absent' });
  });

  it('requires directional count evidence across composite and multi-hop joins', () => {
    const objects = context([
      { objectKey: 'metric', objectType: 'semantic_metric', name: 'revenue', payload: { table: 'orders', formula: 'revenue', analyticalCapability: additiveCapability } },
      { objectKey: 'orders_customer', objectType: 'dql_relationship', name: 'orders_customer', payload: {
        fromRelation: 'orders', toRelation: 'customers',
        keys: [{ from: 'customer_id', to: 'id' }, { from: 'tenant_id', to: 'tenant_id' }], cardinality: 'many_to_one',
        validation: { status: 'passed', fromRows: 100, toRows: 10, joinedRows: 100, fromNullKeys: 0, toNullKeys: 0, unmatchedFrom: 0, maxFromPerKey: 20, maxToPerKey: 1 },
      } },
      { objectKey: 'customer_region', objectType: 'dql_relationship', name: 'customer_region', payload: {
        fromRelation: 'customers', toRelation: 'regions', keys: [{ from: 'region_id', to: 'id' }], cardinality: 'many_to_one',
        validation: { status: 'passed', fromRows: 10, toRows: 3, joinedRows: 10, fromNullKeys: 0, toNullKeys: 0, unmatchedFrom: 0, maxFromPerKey: 7, maxToPerKey: 1 },
      } },
    ]);
    expect(buildAggregationSafetyProof(`
      SELECT SUM(o.revenue)
      FROM orders o
      JOIN customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
      JOIN regions r ON r.id = c.region_id
    `, objects)).toMatchObject({ status: 'safe', fanout: 'proven_absent' });

    const unsafe = structuredClone(objects);
    const relationship = unsafe.objects.find((object) => object.objectKey === 'customer_region')!;
    (relationship.payload!.validation as Record<string, unknown>).maxToPerKey = 2;
    expect(buildAggregationSafetyProof(`
      SELECT SUM(o.revenue)
      FROM orders o
      JOIN customers c ON o.customer_id = c.id AND o.tenant_id = c.tenant_id
      JOIN regions r ON c.region_id = r.id
    `, unsafe)).toMatchObject({ status: 'blocked', issueCodes: expect.arrayContaining(['JOIN_FANOUT_DIRECTION_UNSAFE']) });
  });

  it('blocks inner rounding because the shared parser has no exact nested-expression rewrite proof', () => {
    const sql = 'SELECT SUM(ROUND(orders.revenue, 2)) AS revenue FROM orders';
    const proof = buildAggregationSafetyProof(
      sql,
      context([{ objectKey: 'metric', objectType: 'semantic_metric', name: 'revenue', payload: { table: 'orders', formula: 'revenue', analyticalCapability: additiveCapability } }]),
    );
    expect(proof).toMatchObject({
      status: 'blocked',
      rounding: 'inner',
      issueCodes: expect.arrayContaining(['PREMATURE_ROUNDING']),
      correctionCodes: ['AST_SAFE_ROUNDING_REWRITE_UNAVAILABLE'],
    });
    expect(proof).not.toHaveProperty('correctedSql');
  });
});
