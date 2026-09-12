/**
 * RESEARCH AS AN INVESTIGATION. The route opens one request's Ask context,
 * frames the change from the question (or from the answer being investigated),
 * and runs every query of the investigation as a settled reading through the
 * same pipeline as Ask. The run keeps one receipt: the reading, Research's own
 * story, and a pipeline receipt per query.
 */
import {
  runInvestigation,
  type AgentRouteExecutor,
  type AgentRouteExecutorResult,
  type AgentRun,
  type AgentRunArtifact,
  type AgentRunEvaluation,
  type AgentRunNextAction,
  type AgentRunRequest,
  type AnalyticalIntentV1,
  type AskStoryStepV1,
  type InvestigationContextSource,
  type InvestigationFrameSource,
  type InvestigationOutcome,
  type InvestigationReportV1,
  type PipelineOutcome,
  type PipelineReceipt,
} from '@duckcodeailabs/dql-agent';
import { toExecutorResult, type AskPipelineHost, type AskRequestScope } from '../ask-pipeline-host/host.js';

/** Held back at the end of the run for the report and persistence. */
export const INVESTIGATION_FINALIZE_RESERVE_MS = 15_000;
/** Without a run budget (tests, embeddings), the investigation's own soft deadline. */
export const INVESTIGATION_SOFT_DEADLINE_MS = 150_000;

export interface InvestigationExecutorDeps {
  host: Pick<AskPipelineHost, 'openScope'>;
  /** A stored run of this project, by id. */
  loadRun(runId: string): Promise<AgentRun | null | undefined>;
  contextSources?: InvestigationContextSource[];
  now?: () => Date;
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined);

const isAnalyticsIntent = (value: unknown): value is AnalyticalIntentV1 => {
  const intent = recordOf(value);
  return intent?.kind === 'analytics' && Array.isArray(intent.measures) && intent.measures.length > 0;
};

/**
 * The reading an earlier answer settled, when that run finished with one. Only
 * the server's stored run counts: whatever SQL or rows the client sends along
 * with "Research deeper" are never read.
 */
export function investigationSourceIntent(run: AgentRun): AnalyticalIntentV1 | undefined {
  if (run.status !== 'completed' && run.status !== 'needs_review') return undefined;
  for (const artifact of run.artifacts) {
    const intent = recordOf(artifact.payload)?.askIntentV1;
    if (isAnalyticsIntent(intent)) return intent;
  }
  const receipted = run.diagnosticReceiptV9?.intent;
  return isAnalyticsIntent(receipted) ? receipted : undefined;
}

/** One query's own deadline: room for a draft and a warehouse call, never the whole remaining run. */
const queryDeadlineMs = (remainingMs: number) => Math.max(5_000, Math.min(45_000, remainingMs - 20_000));

export function createInvestigationExecutor(deps: InvestigationExecutorDeps): AgentRouteExecutor {
  return async (context) => {
    const { runId, request, routeDecision, emit } = context;
    const startedAt = Date.now();
    const opened = await deps.host.openScope(context, { route: 'research' });
    if ('blocked' in opened) return opened.blocked;
    const { scope } = opened;

    const steps: AskStoryStepV1[] = [];
    const onStep = (step: AskStoryStepV1) => {
      steps.push(step);
      emit({ type: 'executor.started', message: step.title, route: 'research', payload: { askStep: step } });
    };
    const source = await frameSource(deps, request, onStep);
    let reading: PipelineOutcome | undefined;
    const remainingMs = () => (request.runBudget
      ? Math.max(0, request.runBudget.remainingMs() - INVESTIGATION_FINALIZE_RESERVE_MS)
      : Math.max(0, INVESTIGATION_SOFT_DEADLINE_MS - (Date.now() - startedAt)));

    const outcome = await runInvestigation({
      question: request.question,
      source,
      runtime: {
        read: async (question) => { reading = await scope.read(question); return reading; },
        runIntent: (intent, { allowAiSql }) => scope.runIntent(intent, { allowAiSql, origin: 'research_program', deadlineMs: queryDeadlineMs(remainingMs()) }),
        vocabulary: () => scope.vocabulary(),
        remainingMs,
        onStep,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(deps.contextSources?.length ? { contextSources: deps.contextSources } : {}),
      },
      ...(deps.now ? { now: deps.now } : {}),
    });

    const frameIntent = source.kind === 'run' ? source.intent : reading?.kind === 'reading' ? reading.intent : undefined;
    const receipt = investigationRootReceipt({ scope, reading, outcome, steps, startedAt, ...(frameIntent ? { intent: frameIntent } : {}) });
    const telemetry = investigationTelemetry(receipt, outcome, scope, startedAt);

    if (outcome.kind === 'reading_ended') {
      return { ...toExecutorResult(runId, outcome.outcome, startedAt), askPipelineReceipt: receipt };
    }
    if (outcome.kind === 'clarify') {
      const label = (ref: string) => { const entry = scope.vocabulary().get(ref); return (entry?.label ?? entry?.name ?? ref).replace(/_/g, ' '); };
      return {
        summary: outcome.question, answer: outcome.question, status: 'needs_clarification', trustState: 'not_applicable', stopReason: 'needs_clarification',
        resolvedRoute: 'clarify', answerRefusalCode: 'ambiguous',
        clarificationOptions: outcome.options.map((ref) => ({ id: ref, label: label(ref), kind: 'vocabulary' as const })),
        artifacts: [{ id: `${runId}:clarify`, kind: 'answer', title: 'One question before investigating', trustState: 'not_applicable', payload: { kind: 'no_answer', text: outcome.question, answer: outcome.question } }],
        evaluations: [], nextActions: [{ id: 'clarify', label: 'Clarify question', route: 'research' }],
        telemetry, askPipelineReceipt: receipt,
      };
    }
    if (outcome.kind === 'not_investigable') {
      const text = `${outcome.reason} Ask the question instead, or name the measure and the period to investigate.`;
      return {
        summary: outcome.reason, answer: text, status: 'blocked', trustState: 'blocked', stopReason: 'blocked', resolvedRoute: 'research',
        artifacts: [{ id: `${runId}:not-investigable`, kind: 'answer', title: 'Not something Research can investigate', trustState: 'blocked', payload: { kind: 'no_answer', text, answer: text } }],
        evaluations: [], nextActions: [{ id: 'ask-instead', label: 'Ask it instead', route: 'generated_answer' }],
        telemetry, askPipelineReceipt: receipt,
      };
    }
    return reportResult({ runId, report: outcome.report, receipt, telemetry, routeReason: routeDecision?.reason });
  };
}

async function frameSource(deps: InvestigationExecutorDeps, request: AgentRunRequest, onStep: (step: AskStoryStepV1) => void): Promise<InvestigationFrameSource> {
  const runId = recordOf(request.workspaceContext?.researchSource)?.runId;
  if (typeof runId !== 'string' || !runId.trim()) return { kind: 'question' };
  const run = await deps.loadRun(runId).catch(() => undefined);
  const intent = run ? investigationSourceIntent(run) : undefined;
  if (intent) return { kind: 'run', runId, intent };
  onStep({
    version: 1, phase: 'frame', title: 'Could not start from the earlier answer', state: 'missed', at: Date.now(),
    detail: run ? 'That answer has no settled reading to start from, so the question is read again.' : 'That answer is no longer stored, so the question is read again.',
  });
  return { kind: 'question' };
}

function investigationRootReceipt(input: {
  scope: AskRequestScope;
  reading?: PipelineOutcome;
  outcome: InvestigationOutcome;
  steps: AskStoryStepV1[];
  startedAt: number;
  intent?: AnalyticalIntentV1;
}): PipelineReceipt {
  const base: PipelineReceipt = input.reading?.receipt ?? {
    version: 1, vocabularyFingerprint: input.scope.vocabulary().fingerprint, dispatches: [], candidates: [], refusals: [], tiers: [], timings: {}, reuse: 'interpretation',
  };
  const queries = input.outcome.receipt.queries.map((query) => query.receipt);
  const sum = (pick: (receipt: PipelineReceipt) => number) => queries.reduce((total, receipt) => total + pick(receipt), 0);
  return {
    ...base,
    ...(input.intent ? { intent: input.intent, reading: input.intent.reading } : {}),
    timings: { ...base.timings, context: input.scope.contextMs, total: Date.now() - input.startedAt },
    ...(queries.length ? {
      warehouse: {
        attempts: sum((receipt) => receipt.warehouse?.attempts ?? 0),
        failures: sum((receipt) => receipt.warehouse?.failures ?? 0),
        executions: sum((receipt) => receipt.warehouse?.executions ?? (receipt.executed ? 1 : 0)),
      },
    } : {}),
    story: [...input.scope.contextSteps, ...(base.story ?? []), ...input.steps].sort((left, right) => left.at - right.at),
    investigation: input.outcome.receipt,
  };
}

function investigationTelemetry(receipt: PipelineReceipt, outcome: InvestigationOutcome, scope: AskRequestScope, startedAt: number): NonNullable<AgentRouteExecutorResult['telemetry']> {
  const queries = outcome.receipt.queries.map((query) => query.receipt);
  const calls = receipt.dispatches.length + queries.reduce((total, query) => total + query.dispatches.length, 0);
  return {
    version: 1,
    stageDurationsMs: { retrieval: scope.contextMs, total: Date.now() - startedAt },
    providerRoundTrips: calls,
    toolCalls: queries.length,
    sqlExecutions: receipt.warehouse?.executions ?? 0,
    ...(receipt.warehouse ? { sqlAttempts: receipt.warehouse.attempts, sqlFailures: receipt.warehouse.failures } : {}),
    repairs: 0,
    egressReceipts: calls,
  };
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The periods the headline compared, as a small table every existing reader can render. */
function periodTable(report: InvestigationReportV1) {
  const headlineQuery = report.queries.find((query) => query.purpose === 'headline' && query.outcome === 'answered');
  const column = report.frame.metric.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'value';
  const governedMeta = headlineQuery?.result?.columnsMeta?.find((meta) => meta.ref === report.frame.metric.ref);
  const valueMeta = governedMeta
    ? { ...governedMeta, name: column }
    : report.headline.current?.formatted.endsWith('%') ? { name: column, kind: 'percent' as const, unit: 'fraction' } : { name: column, kind: 'number' as const };
  const { windows } = report.frame;
  const periods = [
    [windows.current.label, report.headline.current],
    [windows.prior.label, report.headline.prior],
    [windows.yearAgo.label, report.headline.yearAgo],
  ] as const;
  const rows = periods.filter(([, figure]) => figure).map(([label, figure]) => ({ period: label, [column]: Number(figure!.value) }));
  return {
    headlineQuery,
    table: { columns: ['period', column], rows, rowCount: rows.length, columnsMeta: [{ name: 'period', kind: 'text' as const }, valueMeta] },
  };
}

function reportResult(input: {
  runId: string;
  report: InvestigationReportV1;
  receipt: PipelineReceipt;
  telemetry: NonNullable<AgentRouteExecutorResult['telemetry']>;
  routeReason?: string;
}): AgentRouteExecutorResult {
  const { runId, report, receipt, telemetry } = input;
  const { headlineQuery, table } = periodTable(report);
  const metric = report.frame.metric.label;
  const caveat = (code: string) => report.caveats.find((entry) => entry.code === code);
  const governedQueries = report.queries.filter((query) => query.outcome === 'answered' && (query.tier === 'certified' || query.tier === 'semantic'));
  const grounded = report.frame.lane === 'governed' && governedQueries.length > 0;
  const coverageNote = caveat('coverage_gap') ?? caveat('partial_period');
  const { level, reasons } = report.confidence;
  const evaluations: AgentRunEvaluation[] = [
    { id: 'route-decision', label: 'Route decision', passed: true, severity: 'info', message: input.routeReason ?? 'Routed the request to Research.' },
    {
      id: 'catalog-grounding', label: 'Catalog grounding', passed: grounded, severity: grounded ? 'info' : 'warning',
      message: grounded
        ? `${capitalize(metric)} is governed; ${governedQueries.length} of the investigation's queries ran on governed definitions.`
        : report.frame.lane === 'ai' ? `${capitalize(metric)} has no governed definition, so its figures come from SQL the AI wrote.` : 'No query of the investigation ran on a governed definition.',
    },
    {
      id: 'result-executed', label: 'Executed against data', passed: report.status === 'answered', severity: report.status === 'answered' ? 'info' : 'warning',
      message: report.status === 'answered'
        ? `The headline was measured from ${report.headline.queryIds.length} executed ${report.headline.queryIds.length === 1 ? 'query' : 'queries'}.`
        : report.status === 'no_data' ? 'The periods compared have no data.' : 'The investigation stopped before the headline was measured.',
    },
    { id: 'investigation-coverage', label: 'Data coverage', passed: !coverageNote, severity: coverageNote ? 'warning' : 'info', message: coverageNote?.text ?? 'Both periods are covered by data.' },
    { id: 'investigation-confidence', label: 'Confidence', passed: level !== 'low', severity: level === 'low' ? 'warning' : 'info', message: `${capitalize(level)} confidence${reasons.length ? `: ${reasons.join('; ')}` : ''}.` },
  ];
  const nextActions: AgentRunNextAction[] = [
    ...(report.status === 'incomplete' || receipt.investigation?.budget.stoppedBy ? [{ id: 'continue-investigation', label: 'Run the investigation again', route: 'research' as const }] : []),
    ...(report.status === 'no_data' ? [{ id: 'investigate-latest-period', label: 'Investigate the latest complete period', route: 'research' as const }] : []),
    ...(caveat('coverage_gap') ? [{ id: 'review-data-coverage', label: 'Review data coverage', route: 'generated_answer' as const }] : []),
    ...(headlineQuery?.sql ? [
      { id: 'create-block', label: 'Save the trend as a block', route: 'dql_block_draft' as const, artifactKind: 'dql_block_draft' as const },
      { id: 'insert-sql', label: 'Open the trend query as SQL', route: 'sql_cell' as const, artifactKind: 'sql_cell' as const },
    ] : []),
    ...(report.frame.lane === 'ai' ? [{ id: 'model-metric', label: 'Model this metric', route: 'modeling_draft' as const }] : []),
  ];
  const artifact: AgentRunArtifact = {
    id: `${runId}:investigation`,
    kind: 'research_run',
    title: report.status === 'answered' ? `Investigation of ${metric}` : 'Investigation',
    trustState: 'review_required',
    payload: {
      kind: 'investigation',
      investigation: report,
      text: report.text,
      answer: report.text,
      certification: 'review_required',
      reviewStatus: 'review_required',
      result: table,
      // The trend the headline came from is the reading a follow-up builds on.
      ...(headlineQuery ? {
        askIntentV1: headlineQuery.intent,
        ...(headlineQuery.sql ? { sql: headlineQuery.sql } : {}),
        ...(headlineQuery.dqlArtifact !== undefined ? { dqlArtifact: headlineQuery.dqlArtifact } : {}),
      } : {}),
    },
  };
  return {
    summary: report.headline.text,
    answer: report.text,
    status: 'needs_review',
    trustState: 'review_required',
    stopReason: 'human_review_required',
    resolvedRoute: 'research',
    artifacts: [artifact],
    evaluations,
    nextActions,
    telemetry,
    askPipelineReceipt: receipt,
  };
}
