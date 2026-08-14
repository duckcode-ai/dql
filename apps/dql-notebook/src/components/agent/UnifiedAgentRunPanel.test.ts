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
let resolvedParameterValues: typeof UnifiedAgentRunPanelModule.resolvedParameterValues;
let agentRunHistoryFromItems: typeof UnifiedAgentRunPanelModule.agentRunHistoryFromItems;
let liveAgentActivityFor: typeof UnifiedAgentRunPanelModule.liveAgentActivityFor;
let clarificationSelectionInput: typeof UnifiedAgentRunPanelModule.clarificationSelectionInput;
let researchSourceFromRun: typeof UnifiedAgentRunPanelModule.researchSourceFromRun;
let isAgentRunPinnable: typeof UnifiedAgentRunPanelModule.isAgentRunPinnable;
let hasAnalyticalInspectorContract: typeof UnifiedAgentRunPanelModule.hasAnalyticalInspectorContract;
let analyticalInspectorContract: typeof UnifiedAgentRunPanelModule.analyticalInspectorContract;
let analyticalInspectorSections: typeof UnifiedAgentRunPanelModule.analyticalInspectorSections;
let analyticalRepairActionLabels: typeof UnifiedAgentRunPanelModule.analyticalRepairActionLabels;
let askInspectorTabsForState: typeof UnifiedAgentRunPanelModule.askInspectorTabsForState;
let threadItemsFromTurns: typeof UnifiedAgentRunPanelModule.threadItemsFromTurns;
let replacePresentedAgentRun: typeof UnifiedAgentRunPanelModule.replacePresentedAgentRun;
let selectAgentExecutionConnection: typeof UnifiedAgentRunPanelModule.selectAgentExecutionConnection;
let appPinDestinationLabel: typeof UnifiedAgentRunPanelModule.appPinDestinationLabel;
let askAppDestinations: typeof UnifiedAgentRunPanelModule.askAppDestinations;
let askAppWriteErrorMessage: typeof UnifiedAgentRunPanelModule.askAppWriteErrorMessage;
let askRunAllowsExecutionRepair: typeof UnifiedAgentRunPanelModule.askRunAllowsExecutionRepair;
let agentRunPerformanceRows: typeof UnifiedAgentRunPanelModule.agentRunPerformanceRows;
let askRunCaptureWarning: typeof UnifiedAgentRunPanelModule.askRunCaptureWarning;
let askFailureOriginTyped: typeof UnifiedAgentRunPanelModule.askFailureOrigin;
let askFailurePresentation: typeof UnifiedAgentRunPanelModule.ASK_FAILURE_PRESENTATION;

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
    resolvedParameterValues = module.resolvedParameterValues;
    agentRunHistoryFromItems = module.agentRunHistoryFromItems;
    liveAgentActivityFor = module.liveAgentActivityFor;
    clarificationSelectionInput = module.clarificationSelectionInput;
    researchSourceFromRun = module.researchSourceFromRun;
    isAgentRunPinnable = module.isAgentRunPinnable;
    hasAnalyticalInspectorContract = module.hasAnalyticalInspectorContract;
    analyticalInspectorContract = module.analyticalInspectorContract;
    analyticalInspectorSections = module.analyticalInspectorSections;
    analyticalRepairActionLabels = module.analyticalRepairActionLabels;
    askInspectorTabsForState = module.askInspectorTabsForState;
    threadItemsFromTurns = module.threadItemsFromTurns;
    replacePresentedAgentRun = module.replacePresentedAgentRun;
    selectAgentExecutionConnection = module.selectAgentExecutionConnection;
    appPinDestinationLabel = module.appPinDestinationLabel;
    askAppDestinations = module.askAppDestinations;
    askAppWriteErrorMessage = module.askAppWriteErrorMessage;
    askRunAllowsExecutionRepair = module.askRunAllowsExecutionRepair;
    agentRunPerformanceRows = module.agentRunPerformanceRows;
    askRunCaptureWarning = module.askRunCaptureWarning;
    askFailureOriginTyped = module.askFailureOrigin;
    askFailurePresentation = module.ASK_FAILURE_PRESENTATION;
  });

  it('names the exact App page used by the added-result confirmation', () => {
    expect(appPinDestinationLabel('Customer Health', 'Executive overview')).toBe('Customer Health › Executive overview');
    expect(appPinDestinationLabel('Customer Health')).toBe('Customer Health');
  });

  it('turns an Ask-to-App 405 into a safe runtime compatibility recovery', () => {
    expect(askAppWriteErrorMessage(Object.assign(new Error('Method not allowed'), { status: 405 }), 'Could not create the app.')).toContain('Restart dql notebook');
    expect(askAppWriteErrorMessage(new Error('Draft conflict'), 'Could not create the app.')).toBe('Draft conflict');
    expect(askAppWriteErrorMessage(null, 'Could not create the app.')).toBe('Could not create the app.');
  });

  it('lists editable drafts once and turns an unedited Project App into a safe draft destination', () => {
    const editDraft = {
      id: 'draft-edit', appId: 'project-app', name: 'Project App edits', state: 'local_draft',
      baseApp: { appId: 'project-app' }, pages: [{ id: 'overview', metadata: { title: 'Overview' } }],
    } as never;
    const localDraft = {
      id: 'draft-local', appId: 'local-app', name: 'Local App', state: 'local_draft',
      pages: [{ id: 'page-1', metadata: { title: 'Analysis' } }],
    } as never;
    const destinations = askAppDestinations([
      { id: 'project-app', name: 'Project App', dashboards: [{ id: 'overview', title: 'Overview' }] },
      { id: 'other-project', name: 'Other Project', dashboards: [{ id: 'main', title: 'Main' }] },
    ] as never, [editDraft, localDraft]);

    expect(destinations.map((destination) => destination.id)).toEqual([
      'draft:draft-edit',
      'draft:draft-local',
      'project:other-project',
    ]);
    expect(destinations[0]).toMatchObject({ kind: 'draft', pageId: 'overview' });
    expect(destinations[2]).toMatchObject({ kind: 'project', pageId: 'main', pageTitle: 'Main' });
  });

  it('keeps Ask on an explicit valid connection and falls back to the server default', () => {
    const names = ['analytics', 'reporting'];
    expect(selectAgentExecutionConnection(names, 'analytics', 'reporting')).toBe('reporting');
    expect(selectAgentExecutionConnection(names, 'analytics', 'deleted-connection')).toBe('analytics');
    expect(selectAgentExecutionConnection(names, 'missing-default')).toBe('analytics');
    expect(selectAgentExecutionConnection([], 'analytics')).toBeUndefined();
  });

  it('shows automatic Ask repair only from the retained server capability', () => {
    const inferredLegacyRun = {
      status: 'blocked',
      artifacts: [{ payload: { sql: 'select 1', warehouseFailure: { category: 'syntax' } } }],
    };
    expect(askRunAllowsExecutionRepair(inferredLegacyRun as never)).toBe(false);
    expect(askRunAllowsExecutionRepair({
      ...inferredLegacyRun,
      repairCapability: {
        version: 1,
        automatic: { eligible: true, action: 'repair_embedded_sql', correctionCode: 'SQL_EXECUTION_REPAIR', attemptsRemaining: 1 },
        routeLocked: true,
        targetLocked: true,
        sourceImmutable: true,
      },
    } as never)).toBe(true);
    expect(askRunAllowsExecutionRepair({
      ...inferredLegacyRun,
      repairCapability: {
        version: 1,
        automatic: { eligible: false, action: 'none', correctionCode: 'MANUAL_REVIEW_REQUIRED', attemptsRemaining: 0 },
        routeLocked: true,
        targetLocked: true,
        sourceImmutable: true,
      },
    } as never)).toBe(false);
  });

  it('promotes a repaired run into the presented transcript for inspector and follow-up actions', () => {
    const failed = { id: 'run_failed', status: 'blocked', artifacts: [] } as never;
    const repaired = {
      id: 'run_failed:repair:1',
      question: 'Top customers',
      status: 'needs_review',
      artifacts: [{ id: 'repaired_artifact', kind: 'answer', payload: { result: { columns: ['name'], rows: [{ name: 'Ada' }], rowCount: 1 } } }],
    } as never;
    const items = replacePresentedAgentRun([
      { kind: 'user', id: 'question', text: 'Top customers' },
      { kind: 'run', id: 'run_failed', run: failed },
    ], 'run_failed', repaired);
    expect(items[1]).toMatchObject({ kind: 'run', id: 'run_failed:repair:1', run: repaired });
    expect(buildConversationContext(items as ConversationThreadItem[])).toMatchObject({
      activeTurnId: 'run_failed:repair:1',
      sourceAnswerId: 'run_failed:repair:1',
      resultColumns: ['name'],
      resultRowsSample: [{ name: 'Ada' }],
    });
  });

  it('collapses the immutable failed turn when a persisted repair derivation exists', () => {
    const turns = [
      { id: 'turn_failed', threadId: 'thread', agentRunId: 'run_failed', seq: 1, question: 'Top customers', createdAt: '2026-08-03T00:00:00Z' },
      { id: 'turn_repaired', threadId: 'thread', agentRunId: 'run_repaired', seq: 2, question: 'Top customers', createdAt: '2026-08-03T00:00:01Z' },
    ] as never;
    const runs = [
      { id: 'run_failed', artifacts: [] },
      { id: 'run_repaired', artifacts: [], derivation: { kind: 'analytical_repair', sourceRunId: 'run_failed' } },
    ] as never;
    const items = threadItemsFromTurns(turns, runs);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'user', text: 'Top customers' });
    expect(items[1]).toMatchObject({ kind: 'run', id: 'run_repaired' });
  });

  it('UI-012 exposes the complete seven-section analytical inspector for success and failure payloads', () => {
    expect(hasAnalyticalInspectorContract({
      resolvedAnalyticalPlan: { planId: 'plan-1' },
      analyticalExecutionGraph: { graphId: 'graph-1' },
    })).toBe(true);
    expect(hasAnalyticalInspectorContract({
      analyticalFailure: { code: 'PERMISSION_DENIED', phase: 'execution' },
    })).toBe(true);
    expect(hasAnalyticalInspectorContract({
      semanticExecutionTrace: {
        version: 1,
        adapter: 'dbt-cloud',
        status: 'ambiguous',
      },
    })).toBe(true);
    const repaired = {
      diagnosticReceipt: {
        phase: 'run.completed',
        repair: { sourceRunId: 'failed-run', targetPreserved: true },
        execution: { rowCount: 2, resultFingerprint: 'result-2' },
      },
      result: { columns: ['name'], rows: [{ name: 'Ada' }, { name: 'Grace' }] },
    };
    expect(hasAnalyticalInspectorContract(repaired)).toBe(true);
    expect(analyticalInspectorContract(repaired)).toMatchObject({
      diagnostic: { phase: 'run.completed', execution: { rowCount: 2 } },
      failure: undefined,
    });
    expect(hasAnalyticalInspectorContract({
      diagnosticReceipt: {
        version: 1,
        runId: 'run-failed',
        phase: 'executor.started',
        failure: { code: 'EXECUTOR_FAILURE' },
      },
    })).toBe(true);
    expect(analyticalInspectorSections()).toEqual([
      'Performance & provider egress',
      'Plan',
      'DQL',
      'Compiled SQL',
      'Lineage',
      'Trust & evidence',
      'Actual steps',
      'Failure & repair',
    ]);
  });

  it('shows content-free timing/call/egress evidence and leaves legacy runs unrecorded', () => {
    const run = {
      telemetry: {
        version: 1,
        stageDurationsMs: { retrieval: 20, total: 1500 },
        providerRoundTrips: 1,
        toolCalls: 2,
        sqlExecutions: 1,
        repairs: 0,
        egressReceipts: 1,
        warehouseDurationMs: 10,
      },
      providerEgressReceipts: [{ resultRowCount: 0 }],
      artifacts: [{ id: 'artifact-1', payload: { resolvedAnalyticalPlan: { planId: 'plan-1' } } }],
    } as unknown as Parameters<typeof agentRunPerformanceRows>[0];
    expect(agentRunPerformanceRows(run)).toEqual(expect.arrayContaining([
      ['Total', '1.5s'],
      ['Warehouse', '10ms'],
      ['Orchestration', '1.5s'],
      ['Calls', '1 provider · 2 tool · 1 SQL · 0 repair'],
      ['Provider rows', '0 result rows sent to providers (1 content-free receipt)'],
      ['Plan ID', 'plan-1'],
      ['Artifact IDs', 'artifact-1'],
    ]));
    expect(agentRunPerformanceRows({} as Parameters<typeof agentRunPerformanceRows>[0])).toBeUndefined();
  });

  it.each([
    [{ analyticalFailure: { code: 'POLICY_DENIED' } }, 'policy'],
    [{ analyticalFailure: { code: 'PERMISSION_DENIED' } }, 'policy'],
    [{ analyticalFailure: { code: 'RESULT_CONTRACT_MISMATCH' } }, 'result_contract'],
    [{ analyticalFailure: { code: 'TIMEOUT' } }, 'timeout'],
    [{ analyticalFailure: { code: 'EXECUTION_CANCELLED' } }, 'cancel'],
    [{ analyticalFailure: { code: 'COMPILATION_FAILED' } }, 'compile'],
    [{ analyticalFailure: { code: 'IDENTIFIER_SCOPE_INVALID' } }, 'identity_integrity'],
    [{ aggregationSafetyProof: { status: 'blocked' } }, 'proof_integrity'],
    [{ refusalCode: 'modeling_gap' }, 'modeling_gap'],
    [{ warehouseFailure: { origin: 'warehouse' } }, 'warehouse'],
  ])('renders a truthful typed failure state for %j', (payload, expected) => {
    expect((askFailureOriginTyped as (run: unknown) => string)({
      status: 'blocked', artifacts: [{ payload }],
    })).toBe(expected);
  });

  it('separates post-execution capture warnings from query failure', () => {
    expect(askRunCaptureWarning({
      status: 'needs_review',
      artifacts: [{ payload: { validationWarnings: ['This answer could not be captured as a reusable DQL block: parser error'] } }],
    } as never)).toMatch(/captured as a reusable DQL block/);
    expect(askRunCaptureWarning({ status: 'blocked', artifacts: [] } as never)).toBeUndefined();
  });

  it('uses proof-specific not-executed copy for blocked semantic authority', () => {
    expect(askFailurePresentation.proof_integrity).toEqual({
      title: 'Not executed: exact semantic proof was not established',
      hint: 'DQL could not establish the exact metric, requested grain, join keys, and fanout proof. Warehouse success cannot create that authority.',
    });
  });

  it('UI-012 never interprets the orchestration step plan as an analytical ranking plan', () => {
    const contract = analyticalInspectorContract({
      diagnosticReceipt: {
        version: 1,
        runId: 'run-failed-before-planning',
        phase: 'run.failed',
        plan: {
          source: 'deterministic',
          rationale: 'Top customer request.',
          steps: [{ id: 'answer', route: 'generated_answer' }],
        },
        failure: { code: 'AI_PROVIDER_FAILURE' },
      },
    });
    expect(contract?.plan).toBeUndefined();
    expect(contract?.frame).toBeUndefined();

    const resolved = analyticalInspectorContract({
      diagnosticReceipt: {
        version: 1,
        runId: 'run-ranked',
        phase: 'run.failed',
        resolvedAnalyticalPlan: {
          analyticalFrame: {
            ranking: { direction: 'top', limit: 10, tiePolicy: 'include_ties' },
          },
        },
      },
    });
    expect(resolved?.frame?.ranking).toMatchObject({ direction: 'top', limit: 10 });
  });

  it('UI-013 capability-gates repair actions without offering a permission bypass', () => {
    expect(analyticalRepairActionLabels(['refresh_snapshot', 'edit_dql', 'open_sql_notebook', 'reapply_semantic_runtime'])).toEqual([
      'Refresh snapshot and prepare retry',
      'Open DQL to repair',
      'Open SQL in Notebook',
      'Reapply semantic runtime settings',
    ]);
    expect(analyticalRepairActionLabels(['request_access', 'change_authorized_connection'])).toEqual([
      'Change connection or request access',
    ]);
    expect(analyticalRepairActionLabels(['request_access', 'change_authorized_connection'])).not.toContain('Open SQL in Notebook');
  });

  it('UI-012/UI-013 keeps DQL, SQL, plan, and trust tabs visible after terminal compilation failure', () => {
    expect(askInspectorTabsForState({
      analytical: true,
      blocked: true,
      hasDql: true,
      hasSql: true,
      hasLineage: false,
    }).map((tab) => tab.id)).toEqual(['how', 'dql', 'sql', 'trust']);

    expect(askInspectorTabsForState({
      analytical: true,
      blocked: true,
      hasDql: false,
      hasSql: false,
      hasLineage: false,
    }).map((tab) => tab.id)).toEqual(['how', 'dql', 'sql', 'trust']);
  });

  it('UI-011 restores applied certified-block inputs in the inline Ask result', () => {
    expect(resolvedParameterValues({
      result: {
        rows: [{ product_name: 'Flame Impala', revenue: 38800 }],
        parameters: [
          { name: 'product_name', value: 'Flame Impala', source: 'question' },
          { name: 'top_n', value: 5, source: 'question' },
        ],
      },
    })).toEqual({ product_name: 'Flame Impala', top_n: 5 });
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

  it('UI-012 resubmits the original question while a semantic path option carries stable identity', () => {
    expect(clarificationSelectionInput({
      id: 'semantic-path:report_date:bcm_ccu_pc',
      label: 'Use Report Date via bcm_ccu_pc',
      question: 'Who are the top customers and what is their BCM this month?',
      kind: 'semantic_entity_path',
    })).toEqual({
      question: 'Who are the top customers and what is their BCM this month?',
      selectedEvidenceId: 'semantic-path:report_date:bcm_ccu_pc',
    });
  });

  it('keeps the exact successful Ask baseline for an explicit Research-deeper run', () => {
    expect(researchSourceFromRun({
      id: 'run-answer-1',
      question: 'Show revenue by region',
      trustState: 'review_required',
      executionTarget: { target: 'connection', connectionName: 'reporting' },
      artifacts: [{
        id: 'answer-1',
        kind: 'answer',
        title: 'Answer',
        trustState: 'review_required',
        ref: 'regional_revenue',
        payload: {
          result: {
            columns: ['region', 'revenue'],
            rows: [{ region: 'West', revenue: 120 }],
            rowCount: 1,
            sql: 'SELECT region, SUM(revenue) AS revenue FROM analytics.orders GROUP BY region',
          },
          dqlArtifact: {
            kind: 'sql_block',
            name: 'regional_revenue',
            source: 'block "regional_revenue" {}',
            persistence: 'transient',
            trustState: 'review_required',
          },
        },
      }],
    } as any)).toMatchObject({
      runId: 'run-answer-1',
      executionTarget: { target: 'connection', connectionName: 'reporting' },
      sourceCertifiedBlock: 'regional_revenue',
      sql: 'SELECT region, SUM(revenue) AS revenue FROM analytics.orders GROUP BY region',
      result: {
        columns: ['region', 'revenue'],
        rows: [{ region: 'West', revenue: 120 }],
        rowCount: 1,
      },
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

  it('shows durable background continuation instead of reconnecting when a view remounts', () => {
    expect(liveAgentActivityFor([], true)).toEqual([{
      id: 'background',
      label: 'Continuing this request in the background',
      state: 'active',
    }]);
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
      source: '  block "monthly_revenue" {\n    type = "semantic"\n    metric = "total_revenue"\n  }\n',
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
      executionTarget: { target: 'connection', connectionName: 'reporting' },
      artifacts: [{ kind: 'answer', payload: { sql: 'SELECT region, SUM(revenue) AS revenue FROM orders GROUP BY region' } }],
    } as any)).toMatchObject({
      sql: expect.stringContaining('SELECT region'),
      executionTarget: { target: 'connection', connectionName: 'reporting' },
    });

    expect(artifactReadyPayloadFromRun({
      id: 'block-run',
      question: 'build revenue and margin by region',
      status: 'needs_review',
      route: 'dql_block_draft',
      artifacts: [{
        kind: 'dql_block_draft',
        trustState: 'review_required',
        payload: {
          dqlArtifact: {
            kind: 'semantic_block',
            name: 'revenue_and_margin_by_region',
            source: 'block "revenue_and_margin_by_region" {\n  type = "semantic"\n  metrics = ["revenue", "margin"]\n  dimensions = ["region"]\n}',
          },
          sql: 'SELECT region, revenue, margin FROM semantic_result',
        },
      }],
    } as any)).toMatchObject({
      sourceRunId: 'block-run',
      dqlArtifact: {
        name: 'revenue_and_margin_by_region',
      },
    });

    expect(artifactReadyPayloadFromRun({
      id: 'blocked',
      question: 'failed analysis',
      status: 'blocked',
      route: 'generated_answer',
      artifacts: [{ kind: 'answer', payload: { sql: 'SELECT broken FROM missing_table' } }],
    } as any)).toBeUndefined();
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

  it('UI-012 keeps a multi-metric table so no requested measure is hidden', () => {
    expect(inlineAskChartConfig({
      result: {
        chartConfig: {
          chart: 'table',
          decisionSource: 'data',
          metrics: ['revenue', 'refunds', 'gross_margin'],
        },
      },
    }, {
      columns: ['customer_name', 'revenue', 'refunds', 'gross_margin'],
      rows: [{ customer_name: 'Zoom', revenue: 1200, refunds: 100, gross_margin: 0.42 }],
      rowCount: 1,
    })).toMatchObject({
      chart: 'table',
      decisionSource: 'data',
      metrics: ['revenue', 'refunds', 'gross_margin'],
    });
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

  it('does not feed a failed SQL turn into the following fallback prompt', () => {
    expect(agentRunHistoryFromItems([
      { kind: 'user', id: 'q1', text: 'Show revenue by source.' },
      {
        kind: 'run',
        id: 'r1',
        run: {
          status: 'blocked',
          summary: 'The warehouse rejected the query.',
          artifacts: [{ payload: { executionError: 'syntax error near source::' } }],
        } as any,
      },
      { kind: 'user', id: 'q2', text: 'Show total revenue.' },
    ])).toEqual([{ role: 'user', text: 'Show total revenue.' }]);
  });
});

describe('persisted conversation hydration', () => {
  it('preserves blocked lifecycle truth instead of fabricating a completed run', () => {
    const items = threadItemsFromTurns([{
      id: 'turn_blocked',
      threadId: 'thread_1',
      seq: 1,
      question: 'show restricted payroll',
      answerSummary: 'Access was denied.',
      route: 'blocked',
      trustLabel: 'blocked',
      runStatus: 'blocked',
      stopReason: 'blocked',
      createdAt: '2026-07-29T00:00:00.000Z',
    }]);
    const run = items.find((item) => item.kind === 'run');
    expect(run?.kind === 'run' ? run.run : undefined).toMatchObject({
      status: 'blocked',
      stopReason: 'blocked',
      trustState: 'blocked',
    });
  });

  it('preserves review-required lifecycle truth after reload', () => {
    const items = threadItemsFromTurns([{
      id: 'turn_review',
      threadId: 'thread_1',
      seq: 2,
      question: 'forecast next quarter',
      answerSummary: 'Generated forecast draft.',
      route: 'generated_answer',
      trustLabel: 'review_required',
      runStatus: 'needs_review',
      stopReason: 'human_review_required',
      createdAt: '2026-07-29T00:01:00.000Z',
    }]);
    const run = items.find((item) => item.kind === 'run');
    expect(run?.kind === 'run' ? run.run : undefined).toMatchObject({
      status: 'needs_review',
      stopReason: 'human_review_required',
      trustState: 'review_required',
    });
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

describe('a refusal is still inspectable', () => {
  let hasContract: typeof UnifiedAgentRunPanelModule.hasAnalyticalInspectorContract;
  let contractOf: typeof UnifiedAgentRunPanelModule.analyticalInspectorContract;

  beforeAll(async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    const module = await import('./UnifiedAgentRunPanel');
    hasContract = module.hasAnalyticalInspectorContract;
    contractOf = module.analyticalInspectorContract;
  });

  it('opens "How it was answered" for a bare refusal with no analytical contract', () => {
    // Regression: these refusals rendered as a plain sentence with only Copy —
    // no DQL, no SQL, no "How it was answered" — so the user could not see why
    // the query stopped or carry it into a notebook to research.
    const groundingGap = {
      refusalCode: 'grounding_gap',
      answer: 'I could not compose a governed query for this from the available tables and metrics.',
    };
    expect(hasContract(groundingGap)).toBe(true);
    expect(contractOf(groundingGap)?.failure).toMatchObject({ stage: 'answer', code: 'grounding_gap' });

    const unretrievedTable = {
      refusalCode: 'ungrounded_table',
      refusalDetails: { message: 'It uses a table that was not part of the metadata retrieved for this question.' },
    };
    expect(hasContract(unretrievedTable)).toBe(true);
    expect(contractOf(unretrievedTable)?.failure).toMatchObject({ code: 'ungrounded_table' });

    // A raw execution error is a failure too, even outside the v2 lane.
    expect(hasContract({ executionError: 'Binder Error: column "revenu" not found' })).toBe(true);

    // A healthy answer is unchanged — no phantom failure section.
    expect(hasContract({ sql: 'select 1', result: { columns: [], rows: [] } })).toBe(false);
  });
});

/**
 * Every failure used to render as one grey paragraph, so a warehouse rejection,
 * a governance refusal and a DQL block-compile problem looked identical — and
 * the most common line, "could not compile its immutable analytical plan", is
 * the DEFAULT for anything unclassified. The card keys off the origin recorded
 * at the throw site.
 */
describe('failure card origin and detail', () => {
  let askFailureOrigin: typeof UnifiedAgentRunPanelModule.askFailureOrigin;
  let askFailureDetail: typeof UnifiedAgentRunPanelModule.askFailureDetail;
  let ASK_FAILURE_PRESENTATION: typeof UnifiedAgentRunPanelModule.ASK_FAILURE_PRESENTATION;

  beforeAll(async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    const module = await import('./UnifiedAgentRunPanel');
    askFailureOrigin = module.askFailureOrigin;
    askFailureDetail = module.askFailureDetail;
    ASK_FAILURE_PRESENTATION = module.ASK_FAILURE_PRESENTATION;
  });

  function runWith(payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return {
      id: 'r', question: 'q', summary: 'safe headline. real cause from summary',
      artifacts: [{ id: 'a', kind: 'answer', title: 'Answer', payload }],
      ...extra,
    } as never;
  }

  it('reads the origin recorded on the run', () => {
    for (const origin of ['warehouse', 'dql_compilation', 'governance_gate', 'retrieval_gap', 'provider', 'host']) {
      expect(askFailureOrigin(runWith({ warehouseFailure: { origin } }))).toBe(origin);
    }
  });

  it('recognizes provider failures even when an older run has no warehouse attribution', () => {
    expect(askFailureOrigin(runWith({ providerFailure: { code: 'AI_PROVIDER_FAILURE' } }))).toBe('provider');
    expect(askFailureOrigin(runWith({ refusalCode: 'provider_error' }))).toBe('provider');
    expect(askFailureOrigin(runWith({}, {
      diagnosticReceipt: { failure: { code: 'AI_PROVIDER_FAILURE', message: 'provider unavailable' } },
    }))).toBe('provider');
  });

  it('UI-011 distinguishes an internal dispatch budget from a provider outage', () => {
    expect(askFailureOrigin(runWith({
      providerFailure: { code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' },
      refusalCode: 'model_declined',
    }))).toBe('orchestration_budget');
    expect(askFailureOrigin(runWith({
      providerFailure: { code: 'orchestration_budget_exhausted' },
      refusalCode: 'orchestration_budget_exhausted',
    }))).toBe('orchestration_budget');
    expect(askFailureOrigin(runWith({}, {
      diagnosticReceipt: {
        failure: { code: 'orchestration_budget_exhausted', message: 'bounded orchestration exhausted' },
      },
    }))).toBe('orchestration_budget');
    expect(ASK_FAILURE_PRESENTATION.orchestration_budget.title).not.toMatch(/provider failed/i);
    expect(ASK_FAILURE_PRESENTATION.orchestration_budget.hint).not.toMatch(/settings/i);
  });

  it('keeps an unknown or missing origin unattributed', () => {
    expect(askFailureOrigin(runWith({}))).toBe('unknown');
    expect(askFailureOrigin(runWith({ warehouseFailure: { origin: 'not_a_real_origin' } }))).toBe('unknown');
  });

  it('gives every origin its own title and guidance', () => {
    const titles = Object.values(ASK_FAILURE_PRESENTATION).map((p) => p.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(Object.values(ASK_FAILURE_PRESENTATION).every((p) => p.hint.trim().length > 0)).toBe(true);
  });

  // A block-compile failure happens AFTER the query ran, so it must not read as
  // a query failure.
  it('does not describe a DQL block failure as a query failure', () => {
    const p = ASK_FAILURE_PRESENTATION.dql_compilation;
    expect(p.title).not.toMatch(/warehouse|rejected/i);
    expect(p.hint).toMatch(/query itself is fine/i);
  });

  it('prefers the producer message over the canned headline', () => {
    const detail = askFailureDetail(runWith({
      warehouseFailure: { origin: 'warehouse', redactedMessage: 'Binder Error: no such column: amt' },
    }, { diagnosticReceipt: { failure: { message: 'could not compile its immutable analytical plan' } } }));
    expect(detail).toBe('Binder Error: no such column: amt');
  });

  it('falls back through executionError, then summary', () => {
    expect(askFailureDetail(runWith({ executionError: 'exec blew up' }))).toBe('exec blew up');
    expect(askFailureDetail(runWith({}))).toBe('safe headline. real cause from summary');
  });

  it('UI-010/012 explains a legacy generic blocked run from its retained qualified bindings', () => {
    const run = runWith({
      resolvedAnalyticalPlan: {
        capability: 'blocked',
        query: {
          measures: [{ requested: 'case volume', status: 'resolved', candidateIds: ['semantic:support:metric:case_volume'] }],
          dimensions: [{
            requested: 'account',
            status: 'ambiguous',
            candidateIds: [
              'semantic:support:dimension:billing_account',
              'semantic:support:dimension:service_account',
            ],
          }],
          filters: [],
        },
      },
    }, {
      status: 'blocked',
      summary: 'Agent run is blocked.',
      diagnosticReceipt: { failure: { message: 'Agent run is blocked.' } },
    });

    expect(askFailureDetail(run)).toBe(
      'I found more than one governed dimension for “account”: Billing Account or Service Account. Choose one before I run the query.',
    );
    expect(askFailureDetail(run)).not.toBe('Agent run is blocked.');
  });
});
