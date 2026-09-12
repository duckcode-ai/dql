import { describe, expect, it } from 'vitest';
import {
  buildVocabularyIndex,
  type AgentRouteExecutorResult,
  type AgentRun,
  type AgentRunRequest,
  type AnalyticalIntentV1,
  type AskStoryStepV1,
  type InvestigationReportV1,
  type PipelineOutcome,
  type PipelineReceipt,
} from '@duckcodeailabs/dql-agent';
import type { AskPipelineHost, AskRequestScope } from '../ask-pipeline-host/host.js';
import { createInvestigationExecutor, investigationSourceIntent } from './investigation-executor.js';

const TIME = 'dimension:orders.ordered_at';
const REVENUE = 'metric:orders.revenue';
const vocabulary = buildVocabularyIndex({
  metrics: [{ name: 'revenue', model: 'orders', label: 'Revenue', aggregation: 'sum' }],
  dimensions: [{ name: 'ordered_at', model: 'orders', dataType: 'timestamp', isTime: true, timeGrains: ['day', 'month'] }],
});

/** Revenue is 100 a day from July 2024 to July 2025 and 70 a day in August 2025. */
const DAYS: Array<{ day: string; revenue: number }> = [];
for (let at = Date.UTC(2024, 6, 1); at < Date.UTC(2025, 8, 1); at += 86_400_000) {
  const day = new Date(at).toISOString().slice(0, 10);
  DAYS.push({ day, revenue: day >= '2025-08-01' ? 70 : 100 });
}

const receipt = (extra: Partial<PipelineReceipt> = {}): PipelineReceipt => ({
  version: 1, vocabularyFingerprint: 'test', dispatches: [], candidates: [], refusals: [], tiers: [], timings: {}, ...extra,
} as PipelineReceipt);

/** What the pipeline would answer for a settled reading of revenue over DAYS. */
function answer(intent: AnalyticalIntentV1): PipelineOutcome {
  const window = intent.time?.window;
  const rows = DAYS.filter((row) => !window || (row.day >= window.start && row.day < window.end));
  const time = intent.groupBy.find((group) => group.role === 'time');
  const column = `ordered_at__${time?.grain}`;
  const groups = new Map<string, number>();
  for (const row of rows) {
    const key = time ? (time.grain === 'day' ? row.day : `${row.day.slice(0, 7)}-01`) : 'all';
    groups.set(key, (groups.get(key) ?? 0) + row.revenue);
  }
  const result = {
    columns: [...(time ? [column] : []), 'value'],
    rows: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ ...(time ? { [column]: key } : {}), value })),
    rowCount: groups.size,
    executionTimeMs: 1,
    columnsMeta: [...(time ? [{ name: column, kind: 'date' as const, ref: TIME }] : []), { name: 'value', kind: 'currency' as const, unit: 'USD', ref: REVENUE }],
  };
  return {
    kind: 'answered', intent, text: '', result,
    candidate: { tier: 'semantic', trust: 'governed', sql: 'SELECT revenue FROM orders', proof: [] } as unknown as Extract<PipelineOutcome, { kind: 'answered' }>['candidate'],
    receipt: receipt({ warehouse: { attempts: 1, failures: 0, executions: 1 } }),
  };
}

const august = {
  version: 1, kind: 'analytics', reading: 'Revenue in August 2025.',
  measures: [{ ref: REVENUE }], groupBy: [], display: [], filters: [], expectedShape: 'scalar', unresolved: [], provenance: {},
  time: { ref: TIME, grain: 'month', window: { start: '2025-08-01', end: '2025-09-01' } },
} as AnalyticalIntentV1;

function fakeHost(options: { read?: PipelineOutcome; blocked?: AgentRouteExecutorResult } = {}) {
  const calls = { reads: 0, intents: [] as AnalyticalIntentV1[], readOptions: [] as unknown[] };
  const scope = {
    route: 'research', contextMs: 12, hasConnection: true,
    contextSteps: [{ version: 1, phase: 'context', title: 'Searched the project', state: 'done', at: 1 }] as AskStoryStepV1[],
    vocabulary: () => vocabulary,
    semanticLayer: () => undefined,
    read: async (_question: string, readOptions?: unknown) => {
      calls.reads += 1;
      calls.readOptions.push(readOptions);
      if (!options.read) throw new Error('an investigation started from an answer must not read the question again');
      return options.read;
    },
    runIntent: async (intent: AnalyticalIntentV1) => { calls.intents.push(intent); return answer(intent); },
    dispatch: async () => '',
  } as unknown as AskRequestScope;
  const host: Pick<AskPipelineHost, 'openScope'> = { openScope: async () => (options.blocked ? { blocked: options.blocked } : { scope }) };
  return { host, calls };
}

function run(request: Partial<AgentRunRequest>) {
  const events: Array<{ message: string; route?: string; payload?: unknown }> = [];
  const context = {
    runId: 'run-investigation', route: 'research' as const, maxRepairAttempts: 0, attempt: 0,
    emit: (event: { message: string; route?: string; payload?: unknown }) => { events.push(event); },
    request: { question: 'Why did revenue drop in August 2025?', requestedMode: 'research', ...request } as AgentRunRequest,
  };
  return { context, events };
}

const storedRun = (overrides: Partial<AgentRun> = {}): AgentRun => ({
  id: 'run-source', question: 'revenue in August 2025', requestedMode: 'ask', route: 'semantic_answer', status: 'completed', trustState: 'governed',
  stopReason: 'governed_semantic_answer', startedAt: '', completedAt: '', steps: [], summary: '', events: [], evaluations: [], nextActions: [], repairAttempts: 0,
  artifacts: [{ id: 'answer', kind: 'answer', title: 'Semantic answer', trustState: 'governed', payload: { askIntentV1: august } }],
  ...overrides,
} as AgentRun);

const readingOf = (intent: AnalyticalIntentV1): PipelineOutcome => ({
  kind: 'reading', intent, lane: 'governed', text: intent.reading,
  receipt: receipt({ intent, dispatches: [{ purpose: 'intent:resolve', ms: 5 }], story: [{ version: 1, phase: 'read', title: 'Read the question', state: 'done', at: 2 }] }),
});

const reportOf = (result: AgentRouteExecutorResult) => (result.artifacts?.[0]?.payload as { investigation: InvestigationReportV1 }).investigation;

describe('Research runs an investigation on the Ask pipeline', () => {
  it('"Research deeper" starts from the stored answer\'s reading, never the client\'s SQL, and keeps one receipt', async () => {
    const { host, calls } = fakeHost();
    const executor = createInvestigationExecutor({ host, loadRun: async (id) => (id === 'run-source' ? storedRun() : undefined) });
    const { context, events } = run({ workspaceContext: { researchSource: { runId: 'run-source', sql: 'DROP TABLE orders', result: { rows: [{ revenue: 999 }] } } } });
    const result = await executor(context);

    expect(calls.reads).toBe(0);
    expect(JSON.stringify(calls.intents)).not.toContain('DROP');
    expect(result).toMatchObject({ status: 'needs_review', trustState: 'review_required', resolvedRoute: 'research' });
    const artifact = result.artifacts![0]!;
    expect(artifact).toMatchObject({ kind: 'research_run', trustState: 'review_required', payload: { kind: 'investigation' } });
    const report = reportOf(result);
    expect(report.headline.verdict).toBe('change');
    expect(Number(report.headline.current!.value)).toBe(31 * 70);
    expect(Number(report.headline.prior!.value)).toBe(31 * 100);
    expect((artifact.payload as { result: unknown }).result).toMatchObject({
      columns: ['period', 'revenue'],
      rows: [{ period: 'August 2025', revenue: 2170 }, { period: 'July 2025', revenue: 3100 }, { period: 'August 2024', revenue: 3100 }],
    });
    const headline = report.queries.find((query) => query.purpose === 'headline')!;
    expect((artifact.payload as { askIntentV1: unknown }).askIntentV1).toEqual(headline.intent);

    const root = result.askPipelineReceipt!;
    expect(root).toMatchObject({ reuse: 'interpretation', intent: august, warehouse: { attempts: 2, executions: 2 } });
    expect(root.investigation?.budget).toMatchObject({ statementsUsed: 2, aiCalls: 0 });
    expect(root.investigation?.queries).toHaveLength(2);
    expect(root.story?.[0]?.title).toBe('Searched the project');
    expect(root.story?.map((step) => step.title)).toContain('Started from the answer being investigated');
    expect(result.telemetry).toMatchObject({ sqlExecutions: 2, providerRoundTrips: 0 });
    expect(result.evaluations?.find((evaluation) => evaluation.id === 'catalog-grounding')).toMatchObject({ passed: true });
    expect(events.some((event) => event.route === 'research' && Boolean((event.payload as { askStep?: unknown } | undefined)?.askStep))).toBe(true);
  });

  it('a question is read once, and the reading\'s AI call stays on the run\'s receipt', async () => {
    const { host, calls } = fakeHost({ read: readingOf(august) });
    const result = await createInvestigationExecutor({ host, loadRun: async () => undefined })(run({}).context);
    expect(calls.reads).toBe(1);
    // A why-question is read for what can be measured, not declined as a cause.
    expect(calls.readOptions[0]).toMatchObject({ guidance: expect.stringContaining('THIS QUESTION IS BEING INVESTIGATED BY RESEARCH') });
    expect(result.askPipelineReceipt?.dispatches).toHaveLength(1);
    expect(result.askPipelineReceipt?.investigation?.budget.aiCalls).toBe(1);
    expect(result.telemetry?.providerRoundTrips).toBe(1);
    expect(result.askPipelineReceipt?.story?.map((step) => step.title).slice(0, 2)).toEqual(['Searched the project', 'Read the question']);
  });

  it('an earlier answer that did not finish is not a starting point: the question is read again, and the story says so', async () => {
    const { host, calls } = fakeHost({ read: readingOf(august) });
    const result = await createInvestigationExecutor({ host, loadRun: async () => storedRun({ status: 'blocked' }) })(run({ workspaceContext: { researchSource: { runId: 'run-source' } } }).context);
    expect(calls.reads).toBe(1);
    expect(result.askPipelineReceipt?.story).toContainEqual(expect.objectContaining({ title: 'Could not start from the earlier answer', state: 'missed' }));
  });

  it('a reading that ends the turn is answered as Ask would, still with the investigation receipt', async () => {
    const conversation: PipelineOutcome = { kind: 'conversation', reply: 'Hello!', text: 'Hello!', receipt: receipt() };
    const result = await createInvestigationExecutor({ host: fakeHost({ read: conversation }).host, loadRun: async () => undefined })(run({ question: 'hi' }).context);
    expect(result).toMatchObject({ answer: 'Hello!', answerKind: 'conversational' });
    expect(result.askPipelineReceipt?.investigation).toBeDefined();
  });

  it('asks for a measure when the reading has none, and explains what is not a change over time', async () => {
    const clarify = await createInvestigationExecutor({ host: fakeHost({ read: readingOf({ ...august, measures: [] }) }).host, loadRun: async () => undefined })(run({}).context);
    expect(clarify).toMatchObject({ status: 'needs_clarification', resolvedRoute: 'clarify' });

    const notData = await createInvestigationExecutor({ host: fakeHost({ read: readingOf({ ...august, kind: 'conversation' } as AnalyticalIntentV1) }).host, loadRun: async () => undefined })(run({}).context);
    expect(notData).toMatchObject({ status: 'blocked', resolvedRoute: 'research' });
    expect(notData.answer).toContain('not a question about data');
  });

  it('a request without an AI model gets the host\'s blocked result', async () => {
    const blocked: AgentRouteExecutorResult = { status: 'blocked', answer: 'No AI model is configured.' };
    const result = await createInvestigationExecutor({ host: fakeHost({ blocked }).host, loadRun: async () => undefined })(run({}).context);
    expect(result).toBe(blocked);
  });

  it('the starting reading is the stored answer\'s own, or its receipt\'s', () => {
    expect(investigationSourceIntent(storedRun())).toEqual(august);
    expect(investigationSourceIntent(storedRun({ artifacts: [], diagnosticReceiptV9: receipt({ intent: august }) }))).toEqual(august);
    expect(investigationSourceIntent(storedRun({ status: 'blocked' }))).toBeUndefined();
    expect(investigationSourceIntent(storedRun({ artifacts: [{ id: 'x', kind: 'answer', title: 'x', trustState: 'governed', payload: { askIntentV1: { kind: 'analytics', measures: [] } } }] }))).toBeUndefined();
  });
});
