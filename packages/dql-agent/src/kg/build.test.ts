import { describe, expect, it } from 'vitest';
import { SemanticLayer, type DQLManifest } from '@duckcodeailabs/dql-core';
import { buildKGFromManifest, buildKGFromSemanticLayer } from './build.js';

describe('buildKGFromManifest', () => {
  it('indexes business terms and business views as first-class KG context', () => {
    const manifest = {
      manifestVersion: 2,
      dqlVersion: 'test',
      generatedAt: '2026-06-12T00:00:00.000Z',
      project: 'test',
      projectRoot: '/tmp/dql',
      domains: {
        revenue: {
          name: 'revenue',
          filePath: 'domains/revenue/domain.dql',
          owner: 'revenue-analytics',
          businessOwner: 'Revenue Operations',
          boundedContext: 'Revenue bookings, recognition, refunds, and health.',
          sourceSystems: ['orders'],
          primaryTerms: ['Net Revenue'],
          reviewCadence: 'monthly',
          tags: ['revenue'],
        },
      },
      blocks: {
        'Revenue Total': {
          name: 'Revenue Total',
          filePath: 'blocks/revenue_total.dql',
          domain: 'revenue',
          owner: 'analytics',
          status: 'certified',
          blockType: 'custom',
          sql: 'select sum(amount) as revenue from fct_orders',
          rawTableRefs: ['fct_orders'],
          tableDependencies: ['fct_orders'],
          refDependencies: [],
          allDependencies: ['fct_orders'],
          tests: [],
          termRefs: ['Net Revenue'],
          description: 'Certified net revenue block.',
          datalexContract: 'commerce.Revenue.net_revenue@1',
        },
      },
      businessViews: {
        'Revenue Health': {
          name: 'Revenue Health',
          filePath: 'business-views/revenue_health.dql',
          domain: 'revenue',
          owner: 'revenue-ops',
          status: 'certified',
          tags: ['revenue', 'health'],
          description: 'Revenue scorecard for leadership review.',
          businessOutcome: 'Leadership can inspect revenue health in one place.',
          decisionUse: 'Weekly business review',
          reviewCadence: 'weekly',
          blockRefs: ['Revenue Total'],
          businessViewRefs: [],
          termRefs: ['Net Revenue'],
          declaredTermRefs: ['Net Revenue'],
          inheritedTermRefs: [],
          unresolvedTermRefs: [],
          unresolvedBlockRefs: [],
          unresolvedBusinessViewRefs: [],
        },
      },
      terms: {
        'Net Revenue': {
          name: 'Net Revenue',
          filePath: 'terms/net_revenue.dql',
          domain: 'revenue',
          owner: 'finance',
          status: 'certified',
          termType: 'metric',
          tags: ['revenue'],
          description: 'Revenue after refunds and test-account exclusions.',
          identifiers: ['order_id'],
          synonyms: ['recognized revenue'],
          businessOwner: 'finance-leadership',
        },
      },
      notebooks: {},
      metrics: {},
      dimensions: {},
      sources: {},
      apps: {},
      dashboards: {},
      lineage: { nodes: [], edges: [] },
      diagnostics: [],
    } as DQLManifest;

    const graph = buildKGFromManifest(manifest);

    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'domain:revenue',
          kind: 'domain',
          sourceTier: 'business_context',
          boundedContext: 'Revenue bookings, recognition, refunds, and health.',
          primaryTerms: ['Net Revenue'],
        }),
        expect.objectContaining({
          nodeId: 'term:Net Revenue',
          kind: 'term',
          sourceTier: 'business_context',
          certification: 'certified',
          llmContext: expect.stringContaining('synonyms: recognized revenue'),
        }),
        expect.objectContaining({
          nodeId: 'block:Revenue Total',
          datalexContract: 'commerce.Revenue.net_revenue@1',
          sql: 'select sum(amount) as revenue from fct_orders',
        }),
        expect.objectContaining({
          nodeId: 'business_view:Revenue Health',
          kind: 'business_view',
          sourceTier: 'business_context',
          certification: 'certified',
          businessOutcome: 'Leadership can inspect revenue health in one place.',
          llmContext: expect.stringContaining('blocks: Revenue Total'),
        }),
      ]),
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { src: 'term:Net Revenue', dst: 'block:Revenue Total', kind: 'defines' },
        { src: 'term:Net Revenue', dst: 'business_view:Revenue Health', kind: 'defines' },
        { src: 'block:Revenue Total', dst: 'business_view:Revenue Health', kind: 'composes' },
        { src: 'domain:revenue', dst: 'term:Net Revenue', kind: 'contains' },
        { src: 'domain:revenue', dst: 'block:Revenue Total', kind: 'contains' },
        { src: 'domain:revenue', dst: 'business_view:Revenue Health', kind: 'contains' },
      ]),
    );
  });

  it('indexes dbt model runtime relation names for SQL generation', () => {
    const manifest = {
      manifestVersion: 2,
      dqlVersion: 'test',
      generatedAt: '2026-06-12T00:00:00.000Z',
      project: 'test',
      projectRoot: '/tmp/dql',
      domains: {},
      blocks: {},
      businessViews: {},
      terms: {},
      notebooks: {},
      metrics: {},
      dimensions: {},
      sources: {
        customers: {
          name: 'customers',
          origin: 'dbt',
          referencedBy: [],
          dbtModel: {
            uniqueId: 'model.jaffle_shop.customers',
            database: 'jaffle_shop',
            schema: 'dev',
            materializedAs: 'table',
            description: 'Customer mart.',
            columns: {
              customer_type: {
                name: 'customer_type',
                description: 'New or returning customer.',
              },
            },
          },
        },
      },
      apps: {},
      dashboards: {},
      lineage: { nodes: [], edges: [] },
      diagnostics: [],
    } as DQLManifest;

    const graph = buildKGFromManifest(manifest);

    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'dbt_model:customers',
          kind: 'dbt_model',
          llmContext: expect.stringContaining('runtime relation: dev.customers'),
        }),
      ]),
    );
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'dbt_model:customers',
          llmContext: expect.stringContaining('customer_type'),
        }),
      ]),
    );
  });

  it('maps manifest semantic metric and dimension status into KG certification', () => {
    const manifest = {
      manifestVersion: 2,
      dqlVersion: 'test',
      generatedAt: '2026-06-12T00:00:00.000Z',
      project: 'test',
      projectRoot: '/tmp/dql',
      domains: {},
      blocks: {},
      businessViews: {},
      terms: {},
      notebooks: {},
      metrics: {
        total_revenue: {
          name: 'total_revenue',
          type: 'sum',
          table: 'orders',
          domain: 'finance',
          status: 'certified',
        },
      },
      dimensions: {
        channel: {
          name: 'channel',
          table: 'orders',
          type: 'string',
          status: 'review',
        },
      },
      sources: {},
      apps: {},
      dashboards: {},
      lineage: { nodes: [], edges: [] },
      diagnostics: [],
    } as DQLManifest;

    const graph = buildKGFromManifest(manifest);

    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'metric:total_revenue',
        status: 'certified',
        certification: 'certified',
      }),
      expect.objectContaining({
        nodeId: 'dimension:channel',
        status: 'review',
        certification: 'reviewed',
      }),
    ]));
  });

  it('maps semantic-layer metric and dimension status into KG certification', () => {
    const layer = new SemanticLayer({
      metrics: [{
        name: 'total_revenue',
        label: 'Total Revenue',
        description: 'Revenue metric.',
        domain: 'finance',
        status: 'certified',
        sql: 'amount',
        type: 'sum',
        table: 'orders',
      }],
      dimensions: [{
        name: 'channel',
        label: 'Channel',
        description: 'Sales channel.',
        domain: 'finance',
        status: 'draft',
        sql: 'channel',
        type: 'string',
        table: 'orders',
      }],
    });

    const graph = buildKGFromSemanticLayer(layer);

    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'metric:total_revenue',
        status: 'certified',
        certification: 'certified',
      }),
      expect.objectContaining({
        nodeId: 'dimension:channel',
        status: 'draft',
        certification: 'ai_generated',
      }),
    ]));
  });

  it('maps app and dashboard lifecycle into KG certification', () => {
    const manifest = {
      manifestVersion: 2,
      dqlVersion: 'test',
      generatedAt: '2026-06-12T00:00:00.000Z',
      project: 'test',
      projectRoot: '/tmp/dql',
      domains: {},
      blocks: {},
      businessViews: {},
      terms: {},
      notebooks: {},
      metrics: {},
      dimensions: {},
      sources: {},
      apps: {
        'growth-app': {
          id: 'growth-app',
          name: 'Growth App',
          domain: 'growth',
          visibility: 'shared',
          lifecycle: 'review',
          owners: ['analytics'],
          tags: [],
          filePath: 'apps/growth',
          members: [],
          roles: [],
          policies: [],
          rlsBindings: [],
          schedules: [],
          dashboards: ['overview'],
          notebooks: [],
        },
      },
      dashboards: {
        'growth-app/overview': {
          id: 'overview',
          appId: 'growth-app',
          qualifiedId: 'growth-app/overview',
          title: 'Overview',
          domain: 'growth',
          lifecycle: 'draft',
          tags: [],
          filePath: 'apps/growth/dashboards/overview.dqld',
          blockIds: [],
          blockPathRefs: [],
          unresolvedBlockRefs: [],
        },
      },
      lineage: { nodes: [], edges: [] },
      diagnostics: [],
    } as DQLManifest;

    const graph = buildKGFromManifest(manifest);

    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'app:growth-app',
        status: 'review',
        certification: 'reviewed',
      }),
      expect.objectContaining({
        nodeId: 'dashboard:growth-app/overview',
        status: 'draft',
        certification: 'ai_generated',
      }),
    ]));
  });
});
