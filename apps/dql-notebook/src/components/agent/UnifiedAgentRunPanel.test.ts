import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildConversationContext, type ConversationThreadItem } from './agentConversationContext';
import type { AgentRunEvent } from '../../api/client';
import type * as UnifiedAgentRunPanelModule from './UnifiedAgentRunPanel';

let resolveArtifactDqlView: typeof UnifiedAgentRunPanelModule.resolveArtifactDqlView;
let artifactSqlDisclosureLabel: typeof UnifiedAgentRunPanelModule.artifactSqlDisclosureLabel;
let deriveResultChartConfig: typeof UnifiedAgentRunPanelModule.deriveResultChartConfig;
let artifactReadyPayloadFromRun: typeof UnifiedAgentRunPanelModule.artifactReadyPayloadFromRun;
let longRunGuidanceFor: typeof UnifiedAgentRunPanelModule.longRunGuidanceFor;
let completedRunGuidanceFor: typeof UnifiedAgentRunPanelModule.completedRunGuidanceFor;
let trustExplainer: typeof UnifiedAgentRunPanelModule.trustExplainer;
let askArtifactMeta: typeof UnifiedAgentRunPanelModule.askArtifactMeta;
let preferredAskInspectorTab: typeof UnifiedAgentRunPanelModule.preferredAskInspectorTab;
let inlineAskChartConfig: typeof UnifiedAgentRunPanelModule.inlineAskChartConfig;
let agentRunHistoryFromItems: typeof UnifiedAgentRunPanelModule.agentRunHistoryFromItems;
let liveAgentActivityFor: typeof UnifiedAgentRunPanelModule.liveAgentActivityFor;
let clarificationSelectionInput: typeof UnifiedAgentRunPanelModule.clarificationSelectionInput;
let isAgentRunPinnable: typeof UnifiedAgentRunPanelModule.isAgentRunPinnable;

describe('UnifiedAgentRunPanel DQL-first artifact display helpers', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    const module = await import('./UnifiedAgentRunPanel');
    resolveArtifactDqlView = module.resolveArtifactDqlView;
    artifactSqlDisclosureLabel = module.artifactSqlDisclosureLabel;
    deriveResultChartConfig = module.deriveResultChartConfig;
    artifactReadyPayloadFromRun = module.artifactReadyPayloadFromRun;
    longRunGuidanceFor = module.longRunGuidanceFor;
    completedRunGuidanceFor = module.completedRunGuidanceFor;
    trustExplainer = module.trustExplainer;
    askArtifactMeta = module.askArtifactMeta;
    preferredAskInspectorTab = module.preferredAskInspectorTab;
    inlineAskChartConfig = module.inlineAskChartConfig;
    agentRunHistoryFromItems = module.agentRunHistoryFromItems;
    liveAgentActivityFor = module.liveAgentActivityFor;
    clarificationSelectionInput = module.clarificationSelectionInput;
    isAgentRunPinnable = module.isAgentRunPinnable;
  });

  it('UI-010 preserves a governed clarification choice as stable identity input', () => {
    expect(clarificationSelectionInput({
      id: 'semantic:metric:dbt_core_models.total_ccu_count',
      label: 'Total CCU Count',
      description: 'Billable CCU consumption.',
      kind: 'semantic_metric',
    })).toEqual({
      question: 'Total CCU Count',
      selectedEvidenceId: 'semantic:metric:dbt_core_models.total_ccu_count',
    });
  });

  it('UI-010 does not expose failed grounding drafts as reusable answers', () => {
    const failedRun = {
      status: 'blocked',
      artifacts: [{
        id: 'draft-1',
        kind: 'dql_block_draft',
        title: 'Invalid draft',
        trustState: 'blocked',
        payload: {},
      }],
    } as Parameters<typeof isAgentRunPinnable>[0];
    expect(isAgentRunPinnable(failedRun)).toBe(false);

    const completedRun = {
      status: 'completed',
      artifacts: [{
        id: 'answer-1',
        kind: 'answer',
        title: 'Executed answer',
        trustState: 'review_required',
        payload: {},
      }],
    } as Parameters<typeof isAgentRunPinnable>[0];
    expect(isAgentRunPinnable(completedRun)).toBe(true);
  });

  it('shows a lightweight search → match → query activity trail instead of planning phases', () => {
    const event = (type: AgentRunEvent['type'], route?: AgentRunEvent['route']): AgentRunEvent => ({
      id: type,
      runId: 'run-1',
      type,
      at: '2026-07-18T00:00:00.000Z',
      message: type,
      route,
    });
    const searching = liveAgentActivityFor([event('run.started')]);
    expect(searching).toEqual([expect.objectContaining({ id: 'search', state: 'active' })]);

    const matched = liveAgentActivityFor([
      event('run.started'),
      event('route.decided', 'semantic_answer'),
    ]);
    expect(matched.map((item) => item.label)).toEqual([
      'Resolving governed evidence and business meaning',
      'Found a compatible semantic metric',
    ]);
    expect(matched[1]?.state).toBe('active');

    const querying = liveAgentActivityFor([
      event('run.started'),
      event('route.decided', 'semantic_answer'),
      event('executor.started', 'semantic_answer'),
    ]);
    expect(querying.at(-1)).toMatchObject({ id: 'execute', label: 'Running the governed query', state: 'active' });
    expect(querying.some((item) => /plan|validate/i.test(item.label))).toBe(false);
  });

  it('finishes the transient activity trail by checking governed evidence', () => {
    const base = {
      runId: 'run-1',
      at: '2026-07-18T00:00:00.000Z',
      message: 'event',
      route: 'generated_answer' as const,
    };
    const activity = liveAgentActivityFor([
      { ...base, id: 'start', type: 'run.started' },
      { ...base, id: 'route', type: 'route.decided' },
      { ...base, id: 'execute', type: 'executor.started' },
      { ...base, id: 'verify', type: 'evaluation.recorded' },
    ]);
    expect(activity.at(-1)).toMatchObject({
      id: 'verify',
      label: 'Checking the result against governed evidence',
      state: 'active',
    });
    expect(activity.slice(0, -1).every((item) => item.state === 'complete')).toBe(true);
  });

  it('UI-003 progressively explains long SQL generation and its durable optimization path', () => {
    expect(longRunGuidanceFor(11, 'generated_answer')).toBeNull();
    expect(longRunGuidanceFor(15)).toMatchObject({ title: 'Still resolving the governed evidence' });
    expect(longRunGuidanceFor(15, 'generated_answer')?.title).toContain('Finishing');
    expect(longRunGuidanceFor(25, 'generated_answer')?.detail).toContain('stops at its deadline');
    expect(longRunGuidanceFor(25, 'research')?.title).toContain('Deep research');
  });

  it('UI-003 shows completed guidance only for long, non-certified reusable work', () => {
    expect(completedRunGuidanceFor(28, 'generated_answer', 'review_required', 0)?.detail).toContain('review it, then certify it');
    expect(completedRunGuidanceFor(28, 'generated_answer', 'certified', 0)).toBeNull();
    expect(completedRunGuidanceFor(8, 'generated_answer', 'review_required', 0)).toBeNull();
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

  it('keeps a validated Sankey recommendation and its source/target/value bindings', () => {
    const { config, chartable } = deriveResultChartConfig(
      {
        columns: ['product_category', 'product_name', 'product_revenue'],
        rows: [
          { product_category: 'Beverage', product_name: 'Coffee', product_revenue: 1200 },
          { product_category: 'Beverage', product_name: 'Tea', product_revenue: 900 },
        ],
        rowCount: 2,
      },
      { chart: 'sankey', x: 'product_category', color: 'product_name', y: 'product_revenue', decisionSource: 'agent' },
    );
    expect(chartable).toBe(true);
    expect(config).toMatchObject({
      chart: 'sankey',
      x: 'product_category',
      color: 'product_name',
      y: 'product_revenue',
      decisionSource: 'agent',
    });
  });

  it('rejects Sankey when the result has no target dimension', () => {
    const { config } = deriveResultChartConfig(
      {
        columns: ['product_name', 'product_revenue'],
        rows: [{ product_name: 'Coffee', product_revenue: 1200 }],
        rowCount: 1,
      },
      { chart: 'sankey', decisionSource: 'agent' },
    );
    expect(config.chart).toBe('kpi');
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

  it('EXP-002 does not claim an exploratory query ran when bounded execution failed', () => {
    expect(trustExplainer({
      trustState: 'review_required',
      artifacts: [{
        kind: 'answer',
        payload: {
          exploratoryCandidate: { kind: 'dbt_grounded_exploration' },
          executionError: 'DQL could not parse the exploratory SQL.',
        },
      }],
    } as any)).toContain('bounded execution failed');
  });

  it('EXP-002 describes an exploratory answer as executed only when result evidence exists', () => {
    expect(trustExplainer({
      trustState: 'review_required',
      artifacts: [{
        kind: 'answer',
        payload: {
          exploratoryCandidate: { kind: 'dbt_grounded_exploration' },
          result: { columns: ['customer_name'], rows: [{ customer_name: 'Melissa' }], rowCount: 1 },
        },
      }],
    } as any)).toContain('query and bounded join probes ran');
  });

  it('hands semantic and generated SQL artifacts to Block Studio but never duplicates a certified answer', () => {
    expect(artifactReadyPayloadFromRun({
      id: 'certified',
      question: 'revenue',
      route: 'certified_answer',
      artifacts: [{ kind: 'answer', payload: { sql: 'SELECT 1' } }],
    } as any)).toBeUndefined();

    expect(artifactReadyPayloadFromRun({
      id: 'semantic',
      question: 'revenue by region',
      artifacts: [{ kind: 'answer', payload: { dqlArtifact: { kind: 'semantic_block', name: 'revenue_by_region', source: 'block "revenue_by_region" {\n  type = "semantic"\n  metric = "revenue"\n}' } } }],
    } as any)).toMatchObject({ dqlArtifact: { kind: 'semantic_block', name: 'revenue_by_region' } });

    expect(artifactReadyPayloadFromRun({
      id: 'generated',
      question: 'unmatched analysis',
      artifacts: [{ kind: 'answer', payload: { sql: 'SELECT region, SUM(revenue) AS revenue FROM orders GROUP BY region' } }],
    } as any)).toMatchObject({ sql: expect.stringContaining('SELECT region') });
  });

  it('describes the full executed result count even when only a row sample is present', () => {
    expect(askArtifactMeta({ kind: 'answer', trustState: 'certified' } as any, {
      result: {
        columns: ['customer_name', 'revenue'],
        rows: Array.from({ length: 8 }, (_, index) => ({ customer_name: `C${index}`, revenue: 10 - index })),
        rowCount: 10,
        executionTime: 2100,
      },
    })).toBe('Table · 10 rows · 2.1s · certified block');
  });

  it('opens the technical inspector on DQL before SQL, lineage, or trust', () => {
    const artifact = {
      id: 'answer-1',
      kind: 'answer',
      title: 'Certified answer',
      trustState: 'certified',
      payload: {
        sql: 'SELECT 1',
        dqlArtifact: { kind: 'certified_block', name: 'top_customers', source: 'block "top_customers" {}' },
      },
    } as any;
    expect(preferredAskInspectorTab({ artifacts: [artifact] } as any, artifact)).toBe('dql');
  });

  it('keeps Visualization available when the backend merely recommends a table', () => {
    expect(inlineAskChartConfig({ result: { chartConfig: { chart: 'table' } } }, {
      columns: ['customer_name', 'revenue'],
      rows: [{ customer_name: 'A', revenue: 10 }, { customer_name: 'B', revenue: 8 }],
      rowCount: 2,
    })).toMatchObject({ chart: undefined, decisionSource: 'agent' });
  });

  it('sends the actual clarification question in client fallback history', () => {
    expect(agentRunHistoryFromItems([
      { kind: 'user', id: 'q1', text: 'Who are the top beverage customers?' },
      {
        kind: 'run',
        id: 'r1',
        run: {
          summary: 'Needs clarification before a governed answer can be produced.',
          answer: 'Rank by total beverage spend or by individual product?',
        } as any,
      },
    ])).toEqual([
      { role: 'user', text: 'Who are the top beverage customers?' },
      { role: 'assistant', text: 'Rank by total beverage spend or by individual product?' },
    ]);
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
