import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AskTraceDataV1, AskTraceSpanV1 } from '../../api/client';
import { themes } from '../../themes/notebook-theme';
import type * as AskTracePageModule from './AskTracePage';

let buildSpanTree: typeof AskTracePageModule.buildSpanTree;
let flattenVisibleTree: typeof AskTracePageModule.flattenVisibleTree;
let stageLabel: typeof AskTracePageModule.stageLabel;
let traceInitialExpanded: typeof AskTracePageModule.traceInitialExpanded;
let incidentSummaryForTrace: typeof AskTracePageModule.incidentSummaryForTrace;
let incidentSummaryFromDecisionSummary: typeof AskTracePageModule.incidentSummaryFromDecisionSummary;
let traceGraph: typeof AskTracePageModule.traceGraph;
let traceTimelinePresentation: typeof AskTracePageModule.traceTimelinePresentation;
let formatMs: typeof AskTracePageModule.formatMs;
let TraceTimeline: typeof AskTracePageModule.TraceTimeline;
let askTraceFocusFromSearch: typeof AskTracePageModule.askTraceFocusFromSearch;
let researchFocusSpanForTrace: typeof AskTracePageModule.researchFocusSpanForTrace;
let TraceDecisionStory: typeof AskTracePageModule.TraceDecisionStory;
let traceLegacySummaryNotice: typeof AskTracePageModule.CANONICAL_DECISION_SUMMARY_UNAVAILABLE;

beforeAll(async () => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost', pathname: '/ask/traces/run-local' } });
  ({ buildSpanTree, flattenVisibleTree, stageLabel, traceInitialExpanded, incidentSummaryForTrace, incidentSummaryFromDecisionSummary, traceGraph, traceTimelinePresentation, formatMs, TraceTimeline, askTraceFocusFromSearch, researchFocusSpanForTrace, TraceDecisionStory, CANONICAL_DECISION_SUMMARY_UNAVAILABLE: traceLegacySummaryNotice } = await import('./AskTracePage'));
});

const root = (overrides: Partial<AskTraceSpanV1> = {}): AskTraceSpanV1 => ({
  version: 1, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), ordinal: 0,
  name: 'ask.run', stage: 'request', startedAt: '2026-08-22T12:00:00.000Z',
  outcome: 'ok', reasonCode: 'started', payload: { kind: 'stage' },
  ...overrides,
});

describe('AskTracePage presentation model', () => {
  it('OBS-014 renders a stable old-run notice instead of reconstructing a decision story from spans', () => {
    const rootSpan = root({ outcome: 'error', reasonCode: 'unknown' });
    const provider = root({
      spanId: 'c'.repeat(16), ordinal: 1, parentSpanId: rootSpan.spanId,
      name: 'provider.attempt', stage: 'provider', outcome: 'error', reasonCode: 'provider_failure',
      payload: { kind: 'provider', attempt: { cause: 'gateway', safeAction: 'retry_same_plan' } },
    });
    const trace: AskTraceDataV1 = {
      envelope: {
        version: 1, traceId: 'a'.repeat(32), rootSpanId: rootSpan.spanId, runId: 'run-legacy', surface: 'browser', mode: 'ask', questionFingerprint: 'sha256:question',
        status: 'blocked', recordingStatus: 'complete', startedAt: rootSpan.startedAt, firstIssueSpanId: provider.spanId, spanCount: 2, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [rootSpan, provider], candidateDecisions: [], links: [],
    };

    const markup = renderToStaticMarkup(createElement(TraceDecisionStory, { trace, t: themes.paper, onSelectSpan: () => undefined }));
    expect(markup).toContain(traceLegacySummaryNotice);
    expect(markup).toContain('Raw stages remain available only in Advanced evidence.');
    expect(markup).not.toContain('A provider-dependent stage did not complete.');
  });

  it('OBS-014 renders stored compiler recovery actions instead of generic inspection copy', () => {
    const summary = {
      version: 1,
      summaryFingerprint: 'f'.repeat(64),
      understoodRequest: {
        measures: 1,
        dimensions: 1,
        entityRequested: false,
        outputCount: 0,
        conversationBinding: 'none',
      },
      evidenceByRole: [],
      tierDecisions: [{ tier: 'semantic', outcome: 'executable', planFrozen: true }],
      selectedPlan: { tier: 'semantic', planFrozen: true, reviewRequired: false },
      terminalIncident: {
        version: 1,
        code: 'COMPILATION_FAILED',
        boundary: 'semantic.compile',
        origin: 'semantic_compiler',
        impact: 'execution_not_attempted',
        safeAction: 'edit_dql',
      },
      safeNextAction: 'edit_dql',
    } as const;

    const editDql = incidentSummaryFromDecisionSummary(summary as never);
    expect(editDql.howToFix).toBe('Edit the recorded governed DQL or semantic mapping, then retry the same Ask.');
    expect(editDql.howToFix).not.toContain('Inspect the recorded decision');

    const notebook = incidentSummaryFromDecisionSummary({
      ...summary,
      terminalIncident: { ...summary.terminalIncident, safeAction: 'open_sql_notebook' },
      safeNextAction: 'open_sql_notebook',
    } as never);
    expect(notebook.howToFix).toBe('Open a SQL notebook to inspect the compiler-ready plan, correct it, then retry the same Ask.');
    expect(notebook.howToFix).not.toContain('Inspect the recorded decision');
  });

  it('renders the recorded limited-Research incident with its branch-focused recovery action', () => {
    const incident = incidentSummaryFromDecisionSummary({
      version: 1,
      summaryFingerprint: 'r'.repeat(64),
      understoodRequest: {
        measures: 1,
        dimensions: 2,
        entityRequested: true,
        outputCount: 1,
        conversationBinding: 'none',
      },
      evidenceByRole: [],
      tierDecisions: [],
      terminalIncident: {
        version: 1,
        code: 'RESEARCH_BRANCH_TIMEOUT',
        boundary: 'run',
        origin: 'governance_gate',
        impact: 'answer_not_produced',
        safeAction: 'inspect_research_failures',
      },
      safeNextAction: 'inspect_research_failures',
    } as never);

    expect(incident).toMatchObject({
      state: 'attention',
      whatHappened: 'The Ask stopped at run.',
      howToFix: 'Inspect the failed or timed-out Research branches, then retry a narrower Research question if the missing evidence still matters.',
    });
    expect(incident.howToFix).not.toContain('No recovery action');
  });

  it('OBS-012 keeps a successful partial Research root while rendering stored branch limitations and recovery evidence', () => {
    const summary = {
      version: 1,
      summaryFingerprint: 'p'.repeat(64),
      understoodRequest: {
        measures: 1,
        dimensions: 2,
        entityRequested: true,
        outputCount: 1,
        ranking: { direction: 'top', limit: 10, defaultedLimit: true },
        conversationBinding: 'none',
      },
      evidenceByRole: [
        { role: 'metric', candidateCount: 2 },
        { role: 'categorical_dimension', candidateCount: 3 },
        { role: 'entity_label', candidateCount: 1 },
      ],
      tierDecisions: [],
      researchBranchSummary: {
        version: 1,
        totalBranches: 5,
        completedBranches: 1,
        receiptBackedBranches: 1,
        failedBranches: 4,
        timedOutBranches: 0,
        skippedBranches: 0,
        partialSuccess: true,
        failureReasons: [{ code: 'execution_failed', branchCount: 4 }],
        availableChildPlans: [{ tier: 'semantic', frozenPlanCount: 1, branchCount: 1, reviewRequired: false }],
        linkedChildRunCount: 5,
        safeAction: 'inspect_research_failures',
      },
      safeNextAction: 'inspect_research_failures',
    } as const;
    const incident = incidentSummaryFromDecisionSummary(summary as never);
    expect(incident).toMatchObject({
      state: 'attention',
      whatHappened: 'Research completed with 1 receipt-backed finding and 4 limited branches.',
      impact: 'The completed receipt-backed finding remains available; failed, timed-out, or skipped branches are limitations, not discarded evidence.',
      howToFix: 'Inspect the failed or timed-out Research branches, then retry a narrower Research question if the missing evidence still matters.',
    });

    const rootSpan = root();
    const trace: AskTraceDataV1 = {
      envelope: {
        version: 1, traceId: 'p'.repeat(32), rootSpanId: rootSpan.spanId, runId: 'run-partial-research', surface: 'browser', mode: 'research', questionFingerprint: 'sha256:question',
        status: 'completed', terminalOutcome: 'needs_review', recordingStatus: 'complete', startedAt: rootSpan.startedAt, spanCount: 1, candidateDecisionCount: 6, droppedRecordCount: 0,
      },
      spans: [rootSpan], candidateDecisions: [], links: [], decisionSummary: summary as never,
    };
    const markup = renderToStaticMarkup(createElement(TraceDecisionStory, { trace, t: themes.paper, onSelectSpan: () => undefined }));
    expect(markup).toContain('Research branch evidence');
    expect(markup).toContain('execution failed: 4');
    expect(markup).toContain('semantic frozen ×1 for 1 branch');
    expect(markup).toContain('5 linked child runs');
    expect(markup).toContain('Research limitations: 4 child branches did not complete');
    expect(markup).toContain('Inspect the failed or timed-out Research branches');
    expect(markup).not.toContain('No terminal incident was recorded.');
  });

  it('expands the root, first-level work, and the terminal failure path without expanding leaves', () => {
    const rootSpan = root();
    const retrieval = root({ spanId: 'c'.repeat(16), ordinal: 1, parentSpanId: rootSpan.spanId, name: 'retrieval.vector', stage: 'retrieval' });
    const failure = root({ spanId: 'd'.repeat(16), ordinal: 2, parentSpanId: retrieval.spanId, name: 'sql.execute', stage: 'sql', outcome: 'error', reasonCode: 'sql_failure' });
    const trace: AskTraceDataV1 = {
      envelope: {
        version: 1, traceId: 'a'.repeat(32), rootSpanId: rootSpan.spanId, runId: 'run-local', surface: 'browser', mode: 'ask', questionFingerprint: 'sha256:question',
        status: 'failed', recordingStatus: 'complete', startedAt: rootSpan.startedAt, firstIssueSpanId: failure.spanId, spanCount: 3, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [rootSpan, retrieval, failure], candidateDecisions: [], links: [],
    };
    expect([...traceInitialExpanded(trace)]).toEqual(expect.arrayContaining([rootSpan.spanId, retrieval.spanId, failure.spanId]));
  });

  it('keeps parent-child ordering keyboard-visible and allows stage/reason search labels', () => {
    const rootSpan = root();
    const retrieval = root({ spanId: 'c'.repeat(16), ordinal: 1, parentSpanId: rootSpan.spanId, name: 'retrieval.semantic', stage: 'retrieval' });
    const sql = root({ spanId: 'd'.repeat(16), ordinal: 2, parentSpanId: retrieval.spanId, name: 'sql.execute', stage: 'sql', outcome: 'denied', reasonCode: 'sql_denied' });
    const tree = buildSpanTree([rootSpan, retrieval, sql], rootSpan.spanId);
    expect(flattenVisibleTree(tree, new Set([rootSpan.spanId, retrieval.spanId]))).toEqual([rootSpan.spanId, retrieval.spanId, sql.spanId]);
    expect(flattenVisibleTree(tree, new Set([rootSpan.spanId, retrieval.spanId]), new Set([sql.spanId]))).toEqual([rootSpan.spanId, retrieval.spanId, sql.spanId]);
    expect(stageLabel('retrieval.semantic')).toBe('retrieval · semantic');
  });

  it('keeps a persisted zero duration exact in Timeline labels and accessibility text while drawing a visible bar', () => {
    // This crosses the same JSON boundary as the local trace API. The detail
    // pane formats `span.durationMs` with `formatMs`, so comparing the shared
    // formatter to the Timeline row asserts API/detail/Timeline parity.
    const trace = JSON.parse(JSON.stringify({
      envelope: {
        version: 1, traceId: 'a'.repeat(32), rootSpanId: 'b'.repeat(16), runId: 'run-zero-duration', surface: 'browser', mode: 'ask', questionFingerprint: 'sha256:question',
        status: 'completed', recordingStatus: 'complete', startedAt: '2026-08-22T12:00:00.000Z', completedAt: '2026-08-22T12:00:00.000Z', durationMs: 0,
        spanCount: 1, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [{
        version: 1, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), ordinal: 0, name: 'provider.attempt', stage: 'provider',
        startedAt: '2026-08-22T12:00:00.000Z', completedAt: '2026-08-22T12:00:00.000Z', durationMs: 0,
        outcome: 'ok', reasonCode: 'provider_completed', payload: { kind: 'provider', attempt: { cause: 'unknown' } },
      }],
      candidateDecisions: [], links: [],
    })) as AskTraceDataV1;

    const timeline = traceTimelinePresentation(trace, Date.parse('2026-08-22T12:00:00.000Z'));
    const row = timeline.rows[0]!;

    expect(trace.spans[0]!.durationMs).toBe(0);
    expect(formatMs(trace.spans[0]!.durationMs)).toBe('0 ms');
    expect(row.recordedDurationMs).toBe(0);
    expect(row.durationLabel).toBe(formatMs(trace.spans[0]!.durationMs));
    expect(row.accessibleLabel).toContain('0 ms');
    expect(timeline.totalLabel).toBe(formatMs(trace.envelope.durationMs));
    // The minimum exists only in the visual scale; it never changes truth.
    expect(row.visualDurationMs).toBe(1);
    expect(row.widthPercent).toBeGreaterThan(0);

    const markup = renderToStaticMarkup(createElement(TraceTimeline, { trace, t: themes.paper, selection: null, onSelect: () => undefined }));
    expect(markup).toContain('aria-label="provider · attempt. ok. 0 ms."');
    expect(markup).toMatch(new RegExp(`data-trace-timeline-bar="${trace.spans[0]!.spanId}"[^>]*width:100%`));
  });

  it('keeps missing or invalid running durations unavailable while retaining a safe visible Timeline bar', () => {
    const running = root({
      name: 'provider.attempt', stage: 'provider', outcome: 'skipped', reasonCode: 'recording',
      durationMs: undefined, completedAt: undefined,
    });
    const invalid = root({
      spanId: 'c'.repeat(16), ordinal: 1, name: 'sql.execute', stage: 'sql', outcome: 'skipped', reasonCode: 'recording',
      durationMs: -50, completedAt: undefined,
    });
    const trace: AskTraceDataV1 = {
      envelope: {
        version: 1, traceId: 'a'.repeat(32), rootSpanId: running.spanId, runId: 'run-running', surface: 'browser', mode: 'ask', questionFingerprint: 'sha256:question',
        status: 'running', recordingStatus: 'recording', startedAt: running.startedAt,
        spanCount: 2, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [running, invalid], candidateDecisions: [], links: [],
    };

    const timeline = traceTimelinePresentation(trace, Date.parse(running.startedAt));
    expect(timeline.totalLabel).toBe('—');
    expect(formatMs(invalid.durationMs)).toBe('—');
    for (const row of timeline.rows) {
      expect(row.recordedDurationMs).toBeUndefined();
      expect(row.durationLabel).toBe('—');
      expect(row.accessibleLabel).toContain('—');
      expect(row.visualDurationMs).toBeGreaterThan(0);
      expect(row.widthPercent).toBeGreaterThan(0);
    }
  });

  it('derives an answer-first provider recovery summary from typed evidence only', () => {
    const rootSpan = root();
    const provider = root({
      spanId: 'c'.repeat(16), ordinal: 1, parentSpanId: rootSpan.spanId, name: 'provider.attempt', stage: 'provider', outcome: 'error', reasonCode: 'provider_failure',
      payload: { kind: 'provider', attempt: { cause: 'rate_limited', safeAction: 'wait_and_retry' } },
    });
    const trace: AskTraceDataV1 = {
      envelope: {
        version: 1, traceId: 'a'.repeat(32), rootSpanId: rootSpan.spanId, runId: 'run-local', surface: 'browser', mode: 'ask', questionFingerprint: 'sha256:question',
        status: 'failed', recordingStatus: 'complete', startedAt: rootSpan.startedAt, firstIssueSpanId: provider.spanId, spanCount: 2, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [rootSpan, provider], candidateDecisions: [], links: [],
    };

    expect(incidentSummaryForTrace(trace)).toMatchObject({
      state: 'attention', spanId: provider.spanId,
      whatHappened: 'A provider-dependent stage did not complete.',
      why: expect.stringContaining('rate limit'),
      howToFix: expect.stringContaining('Wait'),
    });
    expect(JSON.stringify(incidentSummaryForTrace(trace))).not.toContain('provider response');
  });

  it('OBS-014 uses the stored V4 authorization incident instead of reconstructing the root unknown span', () => {
    const rootSpan = root({ outcome: 'error', reasonCode: 'unknown' });
    const trace: AskTraceDataV1 = {
      envelope: {
        version: 1, traceId: 'a'.repeat(32), rootSpanId: rootSpan.spanId, runId: 'run-authorization-mismatch', surface: 'browser', mode: 'ask', questionFingerprint: 'sha256:question',
        status: 'blocked', recordingStatus: 'complete', startedAt: rootSpan.startedAt, firstIssueSpanId: rootSpan.spanId, spanCount: 1, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [rootSpan], candidateDecisions: [], links: [],
      decisionSummary: {
        version: 1,
        summaryFingerprint: 'sha256:stored-v4-story',
        understoodRequest: { measures: 1, dimensions: 1, entityRequested: true, outputCount: 2, conversationBinding: 'none' },
        evidenceByRole: [{ role: 'metric', candidateCount: 1 }],
        tierDecisions: [{ tier: 'exploratory_sql', outcome: 'executable', planFrozen: true }],
        selectedPlan: { tier: 'exploratory_sql', planFrozen: true, reviewRequired: true },
        terminalIncident: {
          version: 1,
          code: 'INTERNAL_EXPLORATORY_AUTHORIZATION_STATE_MISMATCH',
          boundary: 'sql.authorize',
          origin: 'internal_invariant',
          impact: 'execution_not_attempted',
          safeAction: 'export_redacted_trace',
        },
        safeNextAction: 'export_redacted_trace',
      },
    };

    expect(incidentSummaryForTrace(trace)).toEqual({
      state: 'attention',
      whatHappened: 'DQL rejected an inconsistent exploratory SQL authorization receipt before execution.',
      why: 'Recorded origin: internal invariant; impact: execution not attempted.',
      impact: 'No SQL execution was attempted for this Ask run.',
      howToFix: 'Export the redacted trace and share the recorded SQL authorization incident with DQL support.',
    });
  });

  it('prioritizes the selected fiscal clarification in the actual API trace shape over generic unavailable coverage', () => {
    // Deliberately cross the JSON boundary used by GET /api/ask-traces/:id.
    // This is the persisted API wire shape, including the separate generic
    // coverage terminal that would be selected by ordinal-only logic.
    const trace = JSON.parse(JSON.stringify({
      envelope: {
        version: 1, traceId: 'a'.repeat(32), rootSpanId: 'b'.repeat(16), runId: 'run-fiscal', surface: 'browser', mode: 'ask', questionFingerprint: 'sha256:question',
        status: 'completed', terminalOutcome: 'needs_clarification', recordingStatus: 'complete', startedAt: '2026-08-22T12:00:00.000Z', completedAt: '2026-08-22T12:00:01.000Z',
        // The observer selected this fiscal clarification as the first real issue.
        firstIssueSpanId: 'c'.repeat(16), spanCount: 3, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [
        { version: 1, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), ordinal: 0, name: 'ask.run', stage: 'request', startedAt: '2026-08-22T12:00:00.000Z', completedAt: '2026-08-22T12:00:01.000Z', durationMs: 1, outcome: 'ok', reasonCode: 'completed', payload: { kind: 'stage', requestedMode: 'ask' } },
        {
          version: 1, traceId: 'a'.repeat(32), spanId: 'c'.repeat(16), parentSpanId: 'b'.repeat(16), ordinal: 1, name: 'cascade.clarify_or_gap', stage: 'cascade', startedAt: '2026-08-22T12:00:00.100Z', completedAt: '2026-08-22T12:00:00.200Z', durationMs: 100, outcome: 'skipped', reasonCode: 'cascade_ambiguous',
          payload: { kind: 'cascade', decision: {
            planFrozen: false, stopReason: 'ambiguous', requiresDeclaredFiscalCalendar: true,
            sourceCoverage: [
              { source: 'certified', status: 'unavailable', candidateIds: [], reasonFingerprint: 'sha256:certified' },
              { source: 'semantic', status: 'unavailable', candidateIds: [], reasonFingerprint: 'sha256:semantic' },
              { source: 'dbt_manifest', status: 'unavailable', candidateIds: [], reasonFingerprint: 'sha256:manifest' },
              { source: 'runtime_schema', status: 'unavailable', candidateIds: [], reasonFingerprint: 'sha256:runtime' },
            ],
            attempts: [{ tier: 'clarify_or_gap', outcome: 'ambiguous', candidateIds: [], planFrozen: false, reasonFingerprint: 'sha256:fiscal-ambiguity' }],
          } },
        },
        {
          version: 1, traceId: 'a'.repeat(32), spanId: 'd'.repeat(16), parentSpanId: 'b'.repeat(16), ordinal: 2, name: 'cascade.clarify_or_gap', stage: 'cascade', startedAt: '2026-08-22T12:00:00.300Z', completedAt: '2026-08-22T12:00:00.400Z', durationMs: 100, outcome: 'skipped', reasonCode: 'cascade_unavailable',
          payload: { kind: 'cascade', decision: {
            planFrozen: false, stopReason: 'coverage_gap',
            sourceCoverage: [{ source: 'certified', status: 'unavailable', candidateIds: [], reasonFingerprint: 'sha256:certified' }],
            attempts: [{ tier: 'clarify_or_gap', outcome: 'unavailable', candidateIds: [], planFrozen: false, reasonFingerprint: 'sha256:coverage' }],
          } },
        },
      ],
      candidateDecisions: [], links: [],
    })) as AskTraceDataV1;

    expect(incidentSummaryForTrace(trace)).toMatchObject({
      state: 'attention',
      spanId: 'c'.repeat(16),
      whatHappened: 'The Ask needs a declared fiscal calendar and date role before it can answer.',
      why: expect.stringContaining('fiscal calendar and date role'),
      impact: 'No query executed; DQL is waiting for a choice that changes the analytical plan.',
      howToFix: 'Select or declare the fiscal calendar and date role, then retry the Ask.',
    });
    expect(incidentSummaryForTrace(trace).why).not.toContain('incomplete coverage');
    expect(incidentSummaryForTrace(trace).howToFix).not.toContain('Refresh or restore');
    expect([...traceInitialExpanded(trace)]).toEqual(expect.arrayContaining(['b'.repeat(16), 'c'.repeat(16)]));
  });

  it('prioritizes a frozen semantic compilation failure over a recoverable certified attempt in the serialized API shape', () => {
    // Cross the exact local API JSON boundary: this intentionally retains the
    // historical early firstIssue pointer to prove the UI recomputes the real
    // terminal incident instead of trusting span order or source coverage.
    const trace = JSON.parse(JSON.stringify({
      envelope: {
        version: 1, traceId: 'a'.repeat(32), rootSpanId: 'b'.repeat(16), runId: 'run-frozen-semantic-failure', surface: 'browser', mode: 'ask', questionFingerprint: 'sha256:question',
        status: 'blocked', terminalOutcome: 'blocked', recordingStatus: 'complete', startedAt: '2026-08-22T12:00:00.000Z', completedAt: '2026-08-22T12:00:01.000Z',
        firstIssueSpanId: 'c'.repeat(16), spanCount: 5, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [
        { version: 1, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), ordinal: 0, name: 'ask.run', stage: 'request', startedAt: '2026-08-22T12:00:00.000Z', completedAt: '2026-08-22T12:00:01.000Z', durationMs: 1_000, outcome: 'ok', reasonCode: 'completed', payload: { kind: 'stage', requestedMode: 'ask' } },
        {
          version: 1, traceId: 'a'.repeat(32), spanId: 'c'.repeat(16), parentSpanId: 'b'.repeat(16), ordinal: 1, name: 'cascade.certified', stage: 'cascade', startedAt: '2026-08-22T12:00:00.100Z', completedAt: '2026-08-22T12:00:00.150Z', durationMs: 50, outcome: 'unavailable', reasonCode: 'cascade_unavailable',
          payload: { kind: 'cascade', decision: { selectedTier: 'semantic', planFrozen: true, stopReason: 'selected', sourceCoverage: [{ source: 'certified', status: 'unavailable', candidateIds: [] }, { source: 'semantic', status: 'available', candidateIds: ['semantic:metric:revenue'] }], attempts: [{ tier: 'certified', outcome: 'unavailable', candidateIds: [], planFrozen: false, reasonFingerprint: 'sha256:certified' }] } },
        },
        {
          version: 1, traceId: 'a'.repeat(32), spanId: 'd'.repeat(16), parentSpanId: 'b'.repeat(16), ordinal: 2, name: 'cascade.semantic', stage: 'cascade', startedAt: '2026-08-22T12:00:00.160Z', completedAt: '2026-08-22T12:00:00.200Z', durationMs: 40, outcome: 'ok', reasonCode: 'cascade_selected',
          payload: { kind: 'cascade', decision: { selectedTier: 'semantic', planFrozen: true, stopReason: 'selected', sourceCoverage: [{ source: 'certified', status: 'unavailable', candidateIds: [] }, { source: 'semantic', status: 'available', candidateIds: ['semantic:metric:revenue'] }], attempts: [{ tier: 'semantic', outcome: 'executable', candidateIds: ['semantic:metric:revenue'], planFrozen: true, reasonFingerprint: 'sha256:semantic' }] } },
        },
        {
          version: 1, traceId: 'a'.repeat(32), spanId: 'e'.repeat(16), parentSpanId: 'b'.repeat(16), ordinal: 3, name: 'plan.freeze', stage: 'plan', startedAt: '2026-08-22T12:00:00.210Z', completedAt: '2026-08-22T12:00:00.220Z', durationMs: 10, outcome: 'ok', reasonCode: 'plan_frozen',
          payload: { kind: 'cascade', decision: { selectedTier: 'semantic', planFrozen: true, stopReason: 'selected', sourceCoverage: [], attempts: [] } },
        },
        {
          version: 1, traceId: 'a'.repeat(32), spanId: 'f'.repeat(16), parentSpanId: 'b'.repeat(16), ordinal: 4, name: 'result.normalize', stage: 'result', startedAt: '2026-08-22T12:00:00.230Z', completedAt: '2026-08-22T12:00:00.240Z', durationMs: 10, outcome: 'error', reasonCode: 'post_freeze_failure',
          payload: { kind: 'result', trustState: 'blocked', failureCode: 'COMPILATION_FAILED', safeAction: 'edit_dql' },
        },
      ],
      candidateDecisions: [], links: [],
    })) as AskTraceDataV1;

    expect(incidentSummaryForTrace(trace)).toEqual(expect.objectContaining({
      state: 'attention', spanId: 'f'.repeat(16),
      whatHappened: 'The frozen semantic plan did not complete.',
      why: 'The semantic plan was frozen, then semantic compilation failed (COMPILATION_FAILED).',
      impact: 'No data result or query completed after the frozen semantic plan failed.',
      howToFix: 'Configure or restore the required semantic compiler, semantic layer, or execution target, then retry. Recorded safe action: edit the governed DQL or semantic mapping.',
    }));
    expect(incidentSummaryForTrace(trace).why).not.toContain('incomplete coverage');
    expect(incidentSummaryForTrace(trace).howToFix).not.toContain('Refresh or restore');
    expect([...traceInitialExpanded(trace)]).toEqual(expect.arrayContaining(['b'.repeat(16), 'f'.repeat(16)]));
  });

  it('explains a frozen certified connection setup failure from the persisted API shape without claiming SQL ran', () => {
    // Simulate the exact JSON returned by GET /api/ask-traces/:traceId. The
    // stale root pointer reproduces the built-CLI symptom; incident projection
    // must prefer the typed post-freeze result failure.
    const trace = JSON.parse(JSON.stringify({
      envelope: {
        version: 1, traceId: 'a'.repeat(32), rootSpanId: 'b'.repeat(16), runId: 'run-frozen-certified-connection', surface: 'browser', mode: 'ask', questionFingerprint: 'sha256:question',
        status: 'blocked', terminalOutcome: 'blocked', recordingStatus: 'complete', startedAt: '2026-08-22T12:00:00.000Z', completedAt: '2026-08-22T12:00:01.000Z',
        firstIssueSpanId: 'b'.repeat(16), spanCount: 4, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [
        { version: 1, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), ordinal: 0, name: 'ask.run', stage: 'request', startedAt: '2026-08-22T12:00:00.000Z', completedAt: '2026-08-22T12:00:01.000Z', durationMs: 1_000, outcome: 'error', reasonCode: 'unknown', payload: { kind: 'stage', requestedMode: 'ask' } },
        {
          version: 1, traceId: 'a'.repeat(32), spanId: 'c'.repeat(16), parentSpanId: 'b'.repeat(16), ordinal: 1, name: 'cascade.certified', stage: 'cascade', startedAt: '2026-08-22T12:00:00.100Z', completedAt: '2026-08-22T12:00:00.150Z', durationMs: 50, outcome: 'ok', reasonCode: 'cascade_selected',
          payload: { kind: 'cascade', decision: { selectedTier: 'certified', planFrozen: true, stopReason: 'selected', sourceCoverage: [{ source: 'certified', status: 'available', candidateIds: ['revenue_operations::block::Top Customers by Revenue'] }], attempts: [{ tier: 'certified', outcome: 'executable', candidateIds: ['revenue_operations::block::Top Customers by Revenue'], planFrozen: true, reasonFingerprint: 'sha256:certified' }] } },
        },
        {
          version: 1, traceId: 'a'.repeat(32), spanId: 'd'.repeat(16), parentSpanId: 'b'.repeat(16), ordinal: 2, name: 'plan.freeze', stage: 'plan', startedAt: '2026-08-22T12:00:00.160Z', completedAt: '2026-08-22T12:00:00.170Z', durationMs: 10, outcome: 'ok', reasonCode: 'plan_frozen',
          payload: { kind: 'cascade', decision: { selectedTier: 'certified', planFrozen: true, stopReason: 'selected', sourceCoverage: [], attempts: [] } },
        },
        {
          version: 1, traceId: 'a'.repeat(32), spanId: 'e'.repeat(16), parentSpanId: 'b'.repeat(16), ordinal: 3, name: 'result.normalize', stage: 'result', startedAt: '2026-08-22T12:00:00.180Z', completedAt: '2026-08-22T12:00:00.190Z', durationMs: 10, outcome: 'error', reasonCode: 'post_freeze_failure',
          payload: { kind: 'result', trustState: 'blocked', failureCode: 'CONNECTION_NOT_CONFIGURED', safeAction: 'configure_connection' },
        },
      ],
      candidateDecisions: [], links: [],
    })) as AskTraceDataV1;

    expect(incidentSummaryForTrace(trace)).toEqual(expect.objectContaining({
      state: 'attention',
      spanId: 'e'.repeat(16),
      whatHappened: 'The frozen certified plan could not reach a database connection.',
      why: 'The certified plan was frozen, but no database connection was configured before DQL could compile or execute its block.',
      impact: 'No query or data result executed after the frozen certified plan.',
      howToFix: 'Open Connections, add or select a warehouse or local DuckDB/file connection, then retry the Ask. Recorded safe action: configure a database connection.',
    }));
    expect(incidentSummaryForTrace(trace).impact).not.toContain('Data result completed');
    expect(incidentSummaryForTrace(trace).howToFix).not.toContain('Refresh or restore');
    expect([...traceInitialExpanded(trace)]).toEqual(expect.arrayContaining(['b'.repeat(16), 'e'.repeat(16)]));
  });

  it('keeps post-freeze provider and SQL failures ahead of a stale pre-freeze issue', () => {
    const serialized = {
      envelope: {
        version: 1, traceId: 'a'.repeat(32), rootSpanId: 'b'.repeat(16), runId: 'run-post-freeze-physical', surface: 'browser', mode: 'ask', questionFingerprint: 'sha256:question',
        status: 'blocked', terminalOutcome: 'blocked', recordingStatus: 'complete', startedAt: '2026-08-22T12:00:00.000Z', firstIssueSpanId: 'c'.repeat(16), spanCount: 4, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [
        { version: 1, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), ordinal: 0, name: 'ask.run', stage: 'request', startedAt: '2026-08-22T12:00:00.000Z', outcome: 'ok', reasonCode: 'started', payload: { kind: 'stage' } },
        { version: 1, traceId: 'a'.repeat(32), spanId: 'c'.repeat(16), parentSpanId: 'b'.repeat(16), ordinal: 1, name: 'cascade.certified', stage: 'cascade', startedAt: '2026-08-22T12:00:00.010Z', outcome: 'unavailable', reasonCode: 'cascade_unavailable', payload: { kind: 'cascade', decision: { selectedTier: 'semantic', planFrozen: true, stopReason: 'selected', sourceCoverage: [{ source: 'certified', status: 'unavailable', candidateIds: [] }], attempts: [{ tier: 'certified', outcome: 'unavailable', candidateIds: [], planFrozen: false, reasonFingerprint: 'sha256:certified' }] } } },
        { version: 1, traceId: 'a'.repeat(32), spanId: 'd'.repeat(16), parentSpanId: 'b'.repeat(16), ordinal: 2, name: 'plan.freeze', stage: 'plan', startedAt: '2026-08-22T12:00:00.020Z', outcome: 'ok', reasonCode: 'plan_frozen', payload: { kind: 'cascade', decision: { selectedTier: 'semantic', planFrozen: true, stopReason: 'selected', sourceCoverage: [], attempts: [] } } },
      ],
      candidateDecisions: [], links: [],
    };
    const provider = JSON.parse(JSON.stringify({
      ...serialized,
      spans: [...serialized.spans, { version: 1, traceId: 'a'.repeat(32), spanId: 'e'.repeat(16), parentSpanId: 'b'.repeat(16), ordinal: 3, name: 'provider.attempt', stage: 'provider', startedAt: '2026-08-22T12:00:00.030Z', outcome: 'error', reasonCode: 'provider_failure', payload: { kind: 'provider', attempt: { cause: 'gateway', safeAction: 'inspect_run' } } }],
    })) as AskTraceDataV1;
    const sql = JSON.parse(JSON.stringify({
      ...serialized,
      spans: [...serialized.spans, { version: 1, traceId: 'a'.repeat(32), spanId: 'f'.repeat(16), parentSpanId: 'b'.repeat(16), ordinal: 3, name: 'sql.execute', stage: 'sql', startedAt: '2026-08-22T12:00:00.030Z', outcome: 'error', reasonCode: 'sql_failure', payload: { kind: 'sql', execution: { reviewRequired: true } } }],
    })) as AskTraceDataV1;

    expect(incidentSummaryForTrace(provider)).toMatchObject({ spanId: 'e'.repeat(16), whatHappened: 'A provider-dependent stage did not complete.' });
    expect(incidentSummaryForTrace(sql)).toMatchObject({ spanId: 'f'.repeat(16), whatHappened: 'The sql · execute stage did not complete.' });
    expect(incidentSummaryForTrace(sql).why).not.toContain('incomplete coverage');
  });

  it('keeps true coverage-gap recovery messaging when no fiscal-calendar flag is present', () => {
    const rootSpan = root();
    const coverageGap = root({
      spanId: 'c'.repeat(16), ordinal: 1, parentSpanId: rootSpan.spanId,
      name: 'cascade.clarify_or_gap', stage: 'cascade', outcome: 'skipped', reasonCode: 'cascade_unavailable',
      payload: { kind: 'cascade', decision: {
        planFrozen: false, stopReason: 'coverage_gap',
        sourceCoverage: [
          { source: 'certified', status: 'unavailable', candidateIds: [] },
          { source: 'semantic', status: 'stale', candidateIds: [] },
        ],
        attempts: [{ tier: 'clarify_or_gap', outcome: 'unavailable', candidateIds: [], planFrozen: false, reasonFingerprint: 'sha256:coverage' }],
      } },
    });
    const trace: AskTraceDataV1 = {
      envelope: {
        version: 1, traceId: 'a'.repeat(32), rootSpanId: rootSpan.spanId, runId: 'run-coverage-gap', surface: 'browser', mode: 'ask', questionFingerprint: 'sha256:question',
        status: 'completed', recordingStatus: 'complete', startedAt: rootSpan.startedAt,
        firstIssueSpanId: coverageGap.spanId, spanCount: 2, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [rootSpan, coverageGap], candidateDecisions: [], links: [],
    };

    expect(incidentSummaryForTrace(trace)).toMatchObject({
      state: 'attention',
      spanId: coverageGap.spanId,
      whatHappened: 'The Ask flow stopped before it could freeze an executable analytical plan.',
      why: expect.stringContaining('incomplete coverage from certified blocks, semantic models'),
      howToFix: 'Refresh or restore the listed local sources, then retry the Ask.',
    });
  });

  it('presents an API-serialized denied relationship boundary as a terminal Ask, not a metric clarification', () => {
    const trace = JSON.parse(JSON.stringify({
      envelope: {
        version: 1, traceId: 'a'.repeat(32), rootSpanId: 'b'.repeat(16), runId: 'run-unattributed-relationship-gap', surface: 'browser', mode: 'ask', questionFingerprint: 'sha256:question',
        status: 'blocked', terminalOutcome: 'blocked', recordingStatus: 'complete', startedAt: '2026-08-22T12:00:00.000Z', completedAt: '2026-08-22T12:00:00.040Z',
        firstIssueSpanId: 'd'.repeat(16), spanCount: 4, candidateDecisionCount: 1, droppedRecordCount: 0,
      },
      spans: [
        { version: 1, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), ordinal: 0, name: 'ask.run', stage: 'request', startedAt: '2026-08-22T12:00:00.000Z', completedAt: '2026-08-22T12:00:00.040Z', durationMs: 40, outcome: 'ok', reasonCode: 'completed', payload: { kind: 'stage', requestedMode: 'ask' } },
        { version: 1, traceId: 'a'.repeat(32), spanId: 'c'.repeat(16), parentSpanId: 'b'.repeat(16), ordinal: 1, name: 'cascade.evaluate', stage: 'cascade', startedAt: '2026-08-22T12:00:00.010Z', completedAt: '2026-08-22T12:00:00.030Z', durationMs: 20, outcome: 'denied', reasonCode: 'cascade_denied', payload: { kind: 'cascade', decision: { planFrozen: false, stopReason: 'denied', terminalGap: { code: 'MISSING_RELATIONSHIP', requirement: 'certified_relationship_or_allocation_proof', witnessCandidateIds: ['revenue_operations::relationship::competitor_observation_to_lost_opportunity'] }, sourceCoverage: [{ source: 'governed_relational', status: 'available', candidateIds: ['revenue_operations::relationship::competitor_observation_to_lost_opportunity'] }], attempts: [{ tier: 'governed_relational', outcome: 'denied', candidateIds: ['revenue_operations::relationship::competitor_observation_to_lost_opportunity'], planFrozen: false, reasonFingerprint: 'sha256:attribution-required' }] } } },
        { version: 1, traceId: 'a'.repeat(32), spanId: 'd'.repeat(16), parentSpanId: 'c'.repeat(16), ordinal: 2, name: 'cascade.governed_relational', stage: 'cascade', startedAt: '2026-08-22T12:00:00.020Z', completedAt: '2026-08-22T12:00:00.030Z', durationMs: 10, outcome: 'denied', reasonCode: 'cascade_denied', payload: { kind: 'cascade', decision: { planFrozen: false, stopReason: 'denied', terminalGap: { code: 'MISSING_RELATIONSHIP', requirement: 'certified_relationship_or_allocation_proof', witnessCandidateIds: ['revenue_operations::relationship::competitor_observation_to_lost_opportunity'] }, sourceCoverage: [{ source: 'governed_relational', status: 'available', candidateIds: ['revenue_operations::relationship::competitor_observation_to_lost_opportunity'] }], attempts: [{ tier: 'governed_relational', outcome: 'denied', candidateIds: ['revenue_operations::relationship::competitor_observation_to_lost_opportunity'], planFrozen: false, reasonFingerprint: 'sha256:attribution-required' }] } } },
      ],
      candidateDecisions: [{ version: 1, traceId: 'a'.repeat(32), sequence: 1, candidateId: 'dql:relationship:revenue_operations::relationship::competitor_observation_to_lost_opportunity', role: 'relationship', source: 'governed_relational', decision: 'excluded', reasonCode: 'policy_denied', compatibilityCode: 'policy_denied' }],
      links: [],
    })) as AskTraceDataV1;

    expect(incidentSummaryForTrace(trace)).toMatchObject({
      state: 'attention',
      // The aggregate cascade decision is the authority that stopped the
      // Ask; the child tier remains visible immediately beneath it.
      spanId: 'c'.repeat(16),
      whatHappened: 'The Ask stopped because the requested relationship is not certified.',
      why: 'The cascade recorded MISSING_RELATIONSHIP: this request needs a certified relationship or approved allocation proof.',
      impact: 'No query executed; DQL did not infer a relationship or allocation for the requested ranking.',
      howToFix: 'Add or certify the required relationship or approved allocation proof, then retry the Ask.',
    });
    expect(incidentSummaryForTrace(trace).whatHappened).not.toContain('clarification');
    expect(incidentSummaryForTrace(trace).impact).not.toContain('Data result completed');
  });

  it('treats an expected skipped stage with no terminal issue as a healthy completed trace', () => {
    const rootSpan = root();
    const skippedMeaning = root({
      spanId: 'c'.repeat(16), ordinal: 1, parentSpanId: rootSpan.spanId,
      name: 'meaning.resolve', stage: 'meaning', outcome: 'skipped', reasonCode: 'unknown',
      payload: { kind: 'meaning', selectedCandidateIds: [], rejectedCandidateIds: [], source: 'heuristic' },
    });
    const trace: AskTraceDataV1 = {
      envelope: {
        version: 1, traceId: 'a'.repeat(32), rootSpanId: rootSpan.spanId, runId: 'run-expected-skip', surface: 'browser', mode: 'ask', questionFingerprint: 'sha256:question',
        status: 'completed', terminalOutcome: 'completed', recordingStatus: 'complete', startedAt: rootSpan.startedAt,
        spanCount: 2, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [rootSpan, skippedMeaning], candidateDecisions: [], links: [],
    };

    expect(incidentSummaryForTrace(trace)).toMatchObject({
      state: 'healthy',
      whatHappened: 'The recorded Ask flow completed without a terminal trace issue.',
    });
  });

  it('renders typed trace-link direction alongside physical parent-child edges', () => {
    const rootSpan = root();
    const child = root({ spanId: 'c'.repeat(16), ordinal: 1, parentSpanId: rootSpan.spanId, name: 'research.plan', stage: 'research' });
    const trace: AskTraceDataV1 = {
      envelope: {
        version: 1, traceId: 'a'.repeat(32), rootSpanId: rootSpan.spanId, runId: 'run-local', surface: 'browser', mode: 'research', questionFingerprint: 'sha256:question',
        status: 'completed', recordingStatus: 'complete', startedAt: rootSpan.startedAt, spanCount: 2, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [rootSpan, child], candidateDecisions: [],
      links: [{ version: 1, kind: 'research_branch', sourceTraceId: 'a'.repeat(32), sourceRunId: 'run-local', targetTraceId: 'd'.repeat(32), targetRunId: 'run-branch', createdAt: rootSpan.startedAt }],
    };
    const graph = traceGraph(trace.spans, trace.envelope.rootSpanId, trace.envelope.traceId, trace.links, {
      appBg: '#000', cellBg: '#111', cellBorderActive: '#333', accent: '#abc', textPrimary: '#fff', textMuted: '#aaa', tableHeaderBg: '#222',
    } as never);

    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: rootSpan.spanId, target: 'trace-link-0', label: 'research branch' }),
    ]));
    expect(graph.spanIds).toEqual(new Set([rootSpan.spanId, child.spanId]));
  });

  it('focuses the receipt-bound Research branch from the Ask open-research URL state', () => {
    const rootSpan = root();
    const plan = root({ spanId: 'c'.repeat(16), ordinal: 1, parentSpanId: rootSpan.spanId, name: 'research.plan', stage: 'research' });
    const branch = root({ spanId: 'd'.repeat(16), ordinal: 2, parentSpanId: plan.spanId, name: 'research.validate', stage: 'research', outcome: 'error', reasonCode: 'execution_failed', payload: { kind: 'research', branchId: 'h1', verdict: 'failed', branchStopReason: 'execution_failed' } });
    const trace: AskTraceDataV1 = {
      envelope: {
        version: 1, traceId: 'a'.repeat(32), rootSpanId: rootSpan.spanId, runId: 'ask-research-run', surface: 'browser', mode: 'research', questionFingerprint: 'sha256:question',
        status: 'completed', recordingStatus: 'complete', startedAt: rootSpan.startedAt, spanCount: 3, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [rootSpan, plan, branch], candidateDecisions: [],
      links: [{ version: 1, kind: 'research_branch', sourceTraceId: 'a'.repeat(32), sourceRunId: 'ask-research-run', targetRunId: 'research-child-1', createdAt: rootSpan.startedAt }],
    };
    expect(askTraceFocusFromSearch('?focus=research')).toBe('research');
    expect(askTraceFocusFromSearch('?focus=provider')).toBeUndefined();
    expect(researchFocusSpanForTrace(trace)?.spanId).toBe(branch.spanId);
    expect(incidentSummaryForTrace(trace)).toMatchObject({ state: 'attention', spanId: branch.spanId });
    // The graph remains the same trace-local UI surface and renders the
    // durable branch relationship as a dashed link, not an invented payload.
    expect(traceGraph(trace.spans, trace.envelope.rootSpanId, trace.envelope.traceId, trace.links, {
      appBg: '#000', cellBg: '#111', cellBorderActive: '#333', accent: '#abc', textPrimary: '#fff', textMuted: '#aaa', tableHeaderBg: '#222',
    } as never).edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'research branch' }),
    ]));
  });
});
