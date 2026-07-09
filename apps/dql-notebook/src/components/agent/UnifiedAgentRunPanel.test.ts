import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildConversationContext, type ConversationThreadItem } from './agentConversationContext';
import type * as UnifiedAgentRunPanelModule from './UnifiedAgentRunPanel';

let resolveArtifactDqlView: typeof UnifiedAgentRunPanelModule.resolveArtifactDqlView;
let artifactSqlDisclosureLabel: typeof UnifiedAgentRunPanelModule.artifactSqlDisclosureLabel;
let deriveResultChartConfig: typeof UnifiedAgentRunPanelModule.deriveResultChartConfig;

describe('UnifiedAgentRunPanel DQL-first artifact display helpers', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    const module = await import('./UnifiedAgentRunPanel');
    resolveArtifactDqlView = module.resolveArtifactDqlView;
    artifactSqlDisclosureLabel = module.artifactSqlDisclosureLabel;
    deriveResultChartConfig = module.deriveResultChartConfig;
  });

  it('charts an arbitrary 3-column result whose names do not match the strict auto-detector', () => {
    const { config, chartable } = deriveResultChartConfig({
      columns: ['product_name', 'total_value', 'order_count'],
      rows: [
        { product_name: 'Widget', total_value: 100, order_count: 4 },
        { product_name: 'Gadget', total_value: 80, order_count: 2 },
      ],
      rowCount: 2,
    });
    expect(chartable).toBe(true);
    expect(config.chart).toBe('grouped-bar');
    expect(config.x).toBe('product_name');
    expect(config.y).toBe('total_value');
  });

  it('picks a line chart when the category column is time-like', () => {
    const { config, chartable } = deriveResultChartConfig({
      columns: ['month', 'revenue'],
      rows: [{ month: '2026-01', revenue: 10 }, { month: '2026-02', revenue: 20 }],
      rowCount: 2,
    });
    expect(chartable).toBe(true);
    expect(config.chart).toBe('line');
    expect(config.x).toBe('month');
  });

  it('uses a KPI for one returned aggregate instead of a bar chart', () => {
    const { config, chartable } = deriveResultChartConfig({
      columns: ['total_revenue'],
      rows: [{ total_revenue: 42000 }],
      rowCount: 1,
    });
    expect(chartable).toBe(true);
    expect(config.chart).toBe('kpi');
  });

  it('uses grouped bars for one category with multiple numeric measures', () => {
    const { config } = deriveResultChartConfig({
      columns: ['region', 'revenue', 'orders'],
      rows: [{ region: 'North', revenue: 420, orders: 23 }, { region: 'South', revenue: 390, orders: 18 }],
      rowCount: 2,
    });
    expect(config.chart).toBe('grouped-bar');
  });

  it('uses a business label rather than an adjacent technical identifier for the chart axis', () => {
    const { config } = deriveResultChartConfig({
      columns: ['customer_id', 'customer_name', 'revenue'],
      rows: [{ customer_id: 'c_1', customer_name: 'Acme', revenue: 420 }],
      rowCount: 1,
    });
    expect(config.x).toBe('customer_name');
  });

  it('overrides an incompatible agent bar preference for a time series', () => {
    const { config } = deriveResultChartConfig(
      {
        columns: ['month', 'revenue'],
        rows: [{ month: '2026-01', revenue: 10 }, { month: '2026-02', revenue: 20 }],
        rowCount: 2,
      },
      { chart: 'bar', decisionSource: 'agent' },
    );
    expect(config.chart).toBe('line');
    expect(config.decisionSource).toBe('data');
  });

  it('is not chartable when there is no numeric column', () => {
    const { chartable } = deriveResultChartConfig({
      columns: ['status', 'owner'],
      rows: [{ status: 'open', owner: 'a' }, { status: 'closed', owner: 'b' }],
      rowCount: 2,
    });
    expect(chartable).toBe(false);
  });

  it('honors an authored chart config over the heuristic', () => {
    const { config } = deriveResultChartConfig(
      {
        columns: ['region', 'sales'],
        rows: [{ region: 'NA', sales: 5 }],
        rowCount: 1,
      },
      { chart: 'pie', x: 'region', y: 'sales', decisionSource: 'authored' },
    );
    expect(config.chart).toBe('pie');
  });

  it('treats a returned DQL artifact as the primary inspectable artifact', () => {
    const artifact = resolveArtifactDqlView({
      sqlPreview: 'SELECT date_trunc(\'month\', order_date) AS month, SUM(revenue) AS total_revenue FROM orders GROUP BY 1',
      dqlArtifact: {
        kind: 'semantic_block',
        name: 'monthly_revenue',
        sourcePath: 'semantic-layer/blocks/revenue/monthly_revenue.yaml',
        source: '  block "monthly_revenue" {\n    type = "semantic"\n    metric = "total_revenue"\n  }\n',
      },
    });

    expect(artifact).toMatchObject({
      kind: 'semantic_block',
      name: 'monthly_revenue',
      sourcePath: 'semantic-layer/blocks/revenue/monthly_revenue.yaml',
      source: 'block "monthly_revenue" {\n    type = "semantic"\n    metric = "total_revenue"\n  }',
    });
    expect(artifactSqlDisclosureLabel(Boolean(artifact))).toBe('View compiled SQL preview');
  });

  it('can resolve a nested research-run DQL artifact before falling back to SQL preview language', () => {
    const artifact = resolveArtifactDqlView({
      researchRun: {
        reviewedSql: 'SELECT 1',
        dqlArtifact: {
          kind: 'sql_block',
          name: 'product_supply_top_value',
          source: 'block "product_supply_top_value" {\n  status = "draft"\n}',
        },
      },
    });

    expect(artifact).toMatchObject({
      kind: 'sql_block',
      name: 'product_supply_top_value',
    });
    expect(artifactSqlDisclosureLabel(Boolean(artifact))).toBe('View compiled SQL preview');
  });

  it('labels SQL-only output as a preview instead of the default query artifact', () => {
    expect(resolveArtifactDqlView({ sql: 'SELECT 1' })).toBeUndefined();
    expect(artifactSqlDisclosureLabel(false)).toBe('View SQL preview');
  });
});

describe('buildConversationContext', () => {
  it('carries prior result columns and low-cardinality dimension values for follow-ups', () => {
    const items: ConversationThreadItem[] = [
      { kind: 'user', id: 'u1', text: 'revenue by category' },
      {
        kind: 'run',
        id: 'r1',
        run: {
          id: 'run_1',
          question: 'Can you give me food vs drink revenue?',
          completedAt: '2026-07-03T00:00:01.000Z',
          artifacts: [{
            kind: 'answer',
            ref: 'food_vs_drink_revenue',
            payload: {
              sourceCertifiedBlock: 'food_vs_drink_revenue',
              reviewStatus: 'certified',
              certification: 'certified',
              route: { tier: 'certified_block', label: 'Answered from certified block food_vs_drink_revenue' },
              contextPack: {
                questionPlan: {
                  requestedShape: {
                    dimensions: ['category'],
                    measures: ['revenue'],
                    filters: ['last month'],
                    topN: { n: 2, scope: 'overall' },
                  },
                },
              },
              result: {
                columns: ['category', 'revenue'],
                rows: [
                  { category: 'Food', revenue: 240877 },
                  { category: 'Drink', revenue: 396567 },
                ],
              },
            },
          }],
          summary: 'Food and Drink revenue split.',
          answer: 'Certified answer from food_vs_drink_revenue.',
        },
      },
    ];

    expect(buildConversationContext(items)).toMatchObject({
      activeSurface: 'notebook',
      sourceAnswerId: 'run_1',
      sourceCertifiedBlock: 'food_vs_drink_revenue',
      sourceQuestion: 'Can you give me food vs drink revenue?',
      sourceAnswerSummary: 'Certified answer from food_vs_drink_revenue.',
      resultColumns: ['category', 'revenue'],
      resultDimensionValues: { category: ['Food', 'Drink'] },
      outputColumns: ['category', 'revenue'],
      requestedFilters: ['last month'],
      requestedDimensions: ['category'],
      priorLimit: 2,
      priorMeasures: ['revenue'],
      reviewStatus: 'certified',
      certification: 'certified',
    });
  });

  it('carries the prior DQL artifact for DQL-first follow-up grounding', () => {
    const items: ConversationThreadItem[] = [
      {
        kind: 'run',
        id: 'r1',
        run: {
          id: 'run_semantic',
          question: 'monthly revenue by channel',
          completedAt: '2026-07-03T00:00:01.000Z',
          artifacts: [{
            kind: 'answer',
            payload: {
              cascade: {
                terminalLane: 'semantic',
                routeTier: 'semantic_metric',
                label: 'Lane 2 semantic DQL artifact was terminal',
                artifactKind: 'semantic_block',
                outcome: {
                  lane: 'semantic',
                  routeTier: 'semantic_metric',
                  metrics: ['total_revenue'],
                  dimensions: ['channel'],
                  rowCount: 1,
                },
              },
              dqlArtifact: {
                kind: 'semantic_block',
                name: 'monthly_revenue_by_channel',
                sourcePath: 'semantic-layer/blocks/revenue/monthly_revenue_by_channel.yaml',
                source: 'block "monthly_revenue_by_channel" {\n  type = "semantic"\n  metric = "total_revenue"\n}',
                metrics: ['total_revenue'],
                dimensions: ['channel'],
                filters: [{ dimension: 'channel', operator: 'equals', values: ['Online'] }],
                timeDimension: { name: 'order_date', granularity: 'month' },
              },
              result: {
                columns: ['month', 'channel', 'total_revenue'],
                rows: [{ month: '2026-06-01', channel: 'Online', total_revenue: 1200 }],
                rowCount: 1,
              },
            },
          }],
          summary: 'Monthly revenue by channel.',
          answer: 'Online revenue was 1200.',
        },
      },
    ];

    expect(buildConversationContext(items)).toMatchObject({
      dqlArtifact: {
        kind: 'semantic_block',
        name: 'monthly_revenue_by_channel',
        metrics: ['total_revenue'],
        dimensions: ['channel'],
        filters: [{ dimension: 'channel', operator: 'equals', values: ['Online'] }],
        timeDimension: { name: 'order_date', granularity: 'month' },
      },
      cascade: {
        terminalLane: 'semantic',
        routeTier: 'semantic_metric',
        outcome: {
          lane: 'semantic',
          metrics: ['total_revenue'],
          dimensions: ['channel'],
        },
      },
      turns: [
        {
          id: 'run_semantic',
          dqlArtifact: {
            kind: 'semantic_block',
            source: expect.stringContaining('metric = "total_revenue"'),
          },
          cascade: {
            terminalLane: 'semantic',
            routeTier: 'semantic_metric',
          },
        },
      ],
    });
  });

  it('extracts result context from research-run previews for follow-ups', () => {
    const items: ConversationThreadItem[] = [
      {
        kind: 'run',
        id: 'r1',
        run: {
          id: 'run_products',
          question: 'Top products by revenue with product name, category, and revenue',
          completedAt: '2026-07-03T00:00:02.000Z',
          artifacts: [{
            kind: 'research_run',
            ref: 'nbr_123',
            payload: {
              researchRun: {
                resultPreview: {
                  columns: ['product_name', 'category', 'revenue', 'units'],
                  rows: [
                    { product_name: 'for richer or pourover', category: 'Drink', revenue: 100275, units: 14325 },
                    { product_name: 'vanilla ice', category: 'Drink', revenue: 84474, units: 14079 },
                  ],
                  rowCount: 10,
                },
              },
              resultPreview: {
                columns: ['product_name', 'category', 'revenue', 'units'],
                rows: [
                  { product_name: 'for richer or pourover', category: 'Drink', revenue: 100275, units: 14325 },
                ],
                rowCount: 10,
              },
            },
          }],
          summary: 'Top products by revenue.',
          answer: 'Revenue is concentrated in top drink products.',
        },
      },
    ];

    expect(buildConversationContext(items)).toMatchObject({
      sourceAnswerId: 'run_products',
      sourceQuestion: 'Top products by revenue with product name, category, and revenue',
      resultColumns: ['product_name', 'category', 'revenue', 'units'],
      resultDimensionValues: {
        product_name: ['for richer or pourover', 'vanilla ice'],
        category: ['Drink'],
      },
      priorMeasures: ['revenue', 'units'],
    });
  });

  it('builds a bounded structured turn history and marks the active analytical turn', () => {
    const items: ConversationThreadItem[] = [
      {
        kind: 'run',
        id: 'r1',
        run: {
          id: 'run_products',
          question: 'Top products by revenue',
          completedAt: '2026-07-03T00:00:01.000Z',
          artifacts: [{
            kind: 'answer',
            payload: {
              result: {
                columns: ['product_name', 'category', 'revenue'],
                rows: [{ product_name: 'for richer or pourover', category: 'Drink', revenue: 100275 }],
                rowCount: 10,
              },
            },
          }],
          summary: 'Top products by revenue.',
          answer: 'The top product is for richer or pourover.',
        },
      },
      {
        kind: 'run',
        id: 'r2',
        run: {
          id: 'run_customers',
          question: 'who are the customers for this product?',
          completedAt: '2026-07-03T00:00:02.000Z',
          artifacts: [{
            kind: 'answer',
            payload: {
              result: {
                columns: ['customer_name', 'product_name', 'revenue'],
                rows: [
                  { customer_name: 'Mr. Matthew Meyer', product_name: 'for richer or pourover', revenue: 70 },
                  { customer_name: 'Aaron Gardner', product_name: 'for richer or pourover', revenue: 63 },
                ],
                rowCount: 2,
              },
            },
          }],
          summary: 'Customers for the top product.',
          answer: 'Mr. Matthew Meyer and Aaron Gardner bought the product.',
        },
      },
    ];

    expect(buildConversationContext(items)).toMatchObject({
      conversationStateVersion: 1,
      activeTurnId: 'run_customers',
      activeTopic: 'who are the customers for this product?',
      resultDimensionValues: {
        customer_name: ['Mr. Matthew Meyer', 'Aaron Gardner'],
        product_name: ['for richer or pourover'],
      },
      turns: [
        {
          id: 'run_products',
          question: 'Top products by revenue',
          result: {
            columns: ['product_name', 'category', 'revenue'],
            dimensionValues: {
              product_name: ['for richer or pourover'],
              category: ['Drink'],
            },
          },
        },
        {
          id: 'run_customers',
          question: 'who are the customers for this product?',
          result: {
            columns: ['customer_name', 'product_name', 'revenue'],
            dimensionValues: {
              customer_name: ['Mr. Matthew Meyer', 'Aaron Gardner'],
              product_name: ['for richer or pourover'],
            },
          },
        },
      ],
    });
  });
});
