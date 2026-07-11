import { describe, expect, it } from 'vitest';
import type { DQLManifest } from '@duckcodeailabs/dql-core';
import { evaluateDbtFirstGeneratedSql } from './dbt-first-safety.js';

describe('evaluateDbtFirstGeneratedSql', () => {
  it('allows a certified fanout-safe relationship path', () => {
    const decision = evaluateDbtFirstGeneratedSql(
      'select sum(o.order_total) from fct_orders o join dim_customers c on o.customer_id = c.customer_id',
      manifest(),
    );

    expect(decision).toMatchObject({ safe: true, relationshipIds: ['order_to_customer'] });
  });

  it('requires attribution policy for a many-touch path', () => {
    const decision = evaluateDbtFirstGeneratedSql(
      'select sum(o.order_total) from fct_campaign_touches t join fct_orders o on t.customer_id = o.customer_id',
      manifest(),
    );

    expect(decision).toMatchObject({ safe: false, code: 'attribution_policy_required', relationshipIds: ['touch_to_order'] });
    expect(decision.message).toContain('attribution policy');
  });

  it('withdraws automatic proof when a certification is stale', () => {
    const value = manifest();
    value.modeling!.relationships.order_to_customer.staleCertification = true;
    value.modeling!.relationships.order_to_customer.automaticJoinAllowed = false;

    const decision = evaluateDbtFirstGeneratedSql(
      'select * from fct_orders o join dim_customers c on o.customer_id = c.customer_id',
      value,
    );

    expect(decision).toMatchObject({ safe: false, code: 'stale_certification' });
  });
});

function manifest(): DQLManifest {
  return {
    manifestVersion: 3,
    dqlVersion: '2.0.0',
    generatedAt: '2026-07-10T00:00:00.000Z',
    project: 'commerce',
    projectRoot: '/fixture',
    blocks: {},
    businessViews: {},
    terms: {},
    notebooks: {},
    metrics: {},
    dimensions: {},
    sources: {},
    lineage: { nodes: [], edges: [], domains: [], crossDomainFlows: [], domainTrust: {} },
    dbtProvenance: {
      manifestPath: '/fixture/target/manifest.json',
      manifestFingerprint: 'manifest',
      nodes: {
        'model.commerce.fct_orders': node('model.commerce.fct_orders', 'fct_orders'),
        'model.commerce.dim_customers': node('model.commerce.dim_customers', 'dim_customers'),
        'model.growth.fct_campaign_touches': node('model.growth.fct_campaign_touches', 'fct_campaign_touches'),
      },
      metricFlow: {},
    },
    modeling: {
      mode: 'dbt-first',
      packages: {},
      entities: {
        order: entity('order', 'model.commerce.fct_orders', 'commerce'),
        customer: entity('customer', 'model.commerce.dim_customers', 'commerce'),
        campaign_touch: entity('campaign_touch', 'model.growth.fct_campaign_touches', 'growth'),
      },
      relationships: {
        order_to_customer: relationship('order_to_customer', 'order', 'customer', { status: 'certified', automaticJoinAllowed: true }),
        touch_to_order: relationship('touch_to_order', 'campaign_touch', 'order', {
          cardinality: 'many_to_many',
          fanout: 'attribution_required',
          status: 'draft',
        }),
      },
      contracts: {},
      conformance: {},
      rules: {},
      domainLineage: [],
    },
  };
}

function node(uniqueId: string, name: string) {
  return {
    uniqueId,
    resourceType: 'model' as const,
    name,
    relation: `analytics.marts.${name}`,
    identityFingerprint: uniqueId,
    available: { description: true, columns: true, tests: true, catalogTypes: true, dqlMeta: true },
  };
}

function entity(id: string, dbtUniqueId: string, domain: string) {
  return { id, dbtUniqueId, domain, grain: `${id}_id`, keys: ['customer_id'], sourcePath: 'entities.dql.yaml', identityFingerprint: id };
}

function relationship(
  id: string,
  from: string,
  to: string,
  overrides: Partial<DQLManifest['modeling'] extends infer T ? T extends { relationships: Record<string, infer R> } ? R : never : never> = {},
) {
  return {
    id,
    from,
    to,
    keys: [{ from: 'customer_id', to: 'customer_id' }],
    cardinality: 'many_to_one' as const,
    fanout: 'safe' as const,
    status: 'certified' as const,
    crossDomain: false,
    sourcePath: 'relationships.dql.yaml',
    fingerprint: id,
    staleCertification: false,
    automaticJoinAllowed: false,
    ...overrides,
  };
}
