import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import {
  attachAskTraceObserverV1,
  completeProviderHttpDispatch,
  planResearchHypotheses,
  prepareProviderHttpDispatch,
  providerPayloadFingerprint,
  RESEARCH_ROW_EGRESS_POLICY,
  type AgentProvider,
  type AgentRunRequest,
  type AskTraceObserverV1,
} from '@duckcodeailabs/dql-agent';
import {
  agentRunProviderDispatchBudgetForMode,
  createProviderDispatchTrace,
  createResearchHypothesisPlanningProvider,
  RunScopedProviderDispatchEvidence,
  startLocalServer,
} from './local-runtime.js';
import { saveProviderSettings } from './settings/provider-settings.js';

afterEach(() => vi.unstubAllGlobals());

const dispatchEvent = {
  provider: 'ollama' as const,
  operation: 'generate' as const,
  attemptIndex: 1,
  envelope: { messages: [{ role: 'user', content: 'bounded research follow-up' }] },
};

/** A minimal in-memory observer for the local provider-boundary harness. */
function providerTraceRecorder() {
  const spans: Array<{
    id: string;
    start: Record<string, unknown>;
    finish?: Record<string, unknown>;
  }> = [];
  let sequence = 0;
  const observer: AskTraceObserverV1 = {
    recordingStatus: 'recording',
    enabled: true,
    startSpan: (input) => {
      const id = `span-${++sequence}`;
      spans.push({ id, start: input as unknown as Record<string, unknown> });
      return id;
    },
    finishSpan: (spanId, input) => {
      const span = spans.find((candidate) => candidate.id === spanId);
      if (span) span.finish = input as unknown as Record<string, unknown>;
    },
    recordCandidateDecision: () => {},
    recordLink: () => {},
    finalize: () => undefined,
    markPartial: () => {},
    reference: () => undefined,
  };
  return { observer, spans };
}

function providerAttempt(span: { start: Record<string, unknown>; finish?: Record<string, unknown> }) {
  const payload = (span.finish?.payload ?? span.start.payload) as {
    kind?: string;
    attempt?: Record<string, unknown>;
  } | undefined;
  return payload?.attempt;
}

const RESEARCH_HYPOTHESIS_ASSETS = {
  metrics: ['revenue'],
  blocks: ['revenue_by_region'],
  dimensions: ['region'],
};

const RESEARCH_HYPOTHESES = JSON.stringify({
  hypotheses: [
    {
      statement: 'Revenue changed because the revenue metric moved.',
      priorConfidence: 0.8,
      target: 'revenue',
      action: 'lookup_metric',
      expectation: 'The revenue observation changed.',
    },
    {
      statement: 'Revenue changed by region.',
      priorConfidence: 0.6,
      target: 'region',
      action: 'breakdown',
      expectation: 'One region accounts for the movement.',
    },
    {
      statement: 'The certified revenue block limits the observation.',
      priorConfidence: 0.4,
      target: 'revenue_by_region',
      action: 'lookup_block',
      expectation: 'The block definition qualifies the result.',
    },
  ],
});

function tracedHypothesisProvider(input: {
  onPhysicalSend?: () => void;
  cancelAfterAdmission?: () => void;
  failAfterAdmission?: boolean;
} = {}): AgentProvider {
  let attemptIndex = 0;
  return {
    name: 'ollama',
    available: async () => true,
    generate: async (messages, options) => {
      const attempt = ++attemptIndex;
      const dispatchOptions = options ?? {};
      prepareProviderHttpDispatch({
        provider: 'ollama',
        operation: 'generate',
        attemptIndex: attempt,
        envelope: { messages },
        options: dispatchOptions,
      });
      // An admission rejection above throws before this line. This counter is
      // therefore the real transport boundary rather than merely an adapter
      // invocation attempt.
      input.onPhysicalSend?.();
      input.cancelAfterAdmission?.();
      if (dispatchOptions.signal?.aborted) {
        const error = Object.assign(new Error('Research planner cancelled.'), { name: 'AbortError', code: 'ABORTED' });
        completeProviderHttpDispatch({
          provider: 'ollama', operation: 'generate', attemptIndex: attempt, options: dispatchOptions,
        }, { outcome: 'cancelled', settlement: 'transport', error });
        throw error;
      }
      if (input.failAfterAdmission) {
        const error = Object.assign(new Error('HTTP 502'), { code: 'HTTP_502' });
        completeProviderHttpDispatch({
          provider: 'ollama', operation: 'generate', attemptIndex: attempt, options: dispatchOptions,
        }, { outcome: 'error', settlement: 'transport', httpStatus: 502, error });
        throw error;
      }
      completeProviderHttpDispatch({
        provider: 'ollama', operation: 'generate', attemptIndex: attempt, options: dispatchOptions,
      }, { outcome: 'ok', settlement: 'transport', httpStatus: 200 });
      return RESEARCH_HYPOTHESES;
    },
  };
}

function researchPlannerRequest(signal?: AbortSignal): AgentRunRequest {
  return {
    runId: 'research-hypothesis-planner',
    question: 'Investigate revenue drivers by region.',
    requestedMode: 'research',
    ...(signal ? { signal } : {}),
  };
}

it('still narrates after generation has spent its whole budget', () => {
  // The regression this pins: narration used to share `generationGroup`, so a
  // run that used its generation attempts had nothing left to write the answer
  // and threw PROVIDER_DISPATCH_BUDGET_EXHAUSTED. The user saw the deterministic
  // draft instead of prose, with no error anywhere.
  const run = new RunScopedProviderDispatchEvidence({
    total: 6, meaningResolution: 1, generationGroup: 2, narration: 2, repair: 1,
  });
  run.observe(dispatchEvent, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  });
  run.observe({ ...dispatchEvent, attemptIndex: 2 }, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  });
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 3 }, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' }));

  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 4 }, {
    purpose: 'research_narration', dispatchPhase: 'narration', optIn: false,
  })).not.toThrow();
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 5 }, {
    purpose: 'research_narration', dispatchPhase: 'narration', optIn: false,
  })).not.toThrow();
  // Narration has its own ceiling; it is not unbounded.
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 6 }, {
    purpose: 'research_narration', dispatchPhase: 'narration', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' }));
});

it('rejects legacy ordinary narration result rows before it creates a receipt', () => {
  const withLimit = (maxNarrationRows: number) => new RunScopedProviderDispatchEvidence(
    { total: 6, meaningResolution: 1, generationGroup: 3, narration: 2, repair: 1 },
    undefined,
    { maxNarrationRows, maxToolRows: 0, source: 'project_config', policyId: 'test-policy' },
  );

  const permissiveLegacyRun = withLimit(20);
  expect(() => permissiveLegacyRun.observe(dispatchEvent, {
    purpose: 'answer_narration', dispatchPhase: 'narration', optIn: true,
    serializedResultShape: { resultRowCount: 20, columnCount: 2 },
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_RESULT_ROWS_BLOCKED' }));
  expect(permissiveLegacyRun.snapshot().providerEgressReceipts).toHaveLength(0);

  // A zero/manual policy is also denied. Result-bearing `answer_narration`
  // has no modern authorization path; only Research may mint one.
  expect(() => withLimit(0).observe(dispatchEvent, {
    purpose: 'answer_narration', dispatchPhase: 'narration', optIn: true,
    serializedResultShape: { resultRowCount: 1, columnCount: 2 },
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_RESULT_ROWS_BLOCKED' }));
});

it('enforces explicit Research narration and local-analysis physical egress caps per run', () => {
  const collector = () => new RunScopedProviderDispatchEvidence({
    total: 8, meaningResolution: 1, generationGroup: 8, narration: 2, repair: 1,
  }, undefined, RESEARCH_ROW_EGRESS_POLICY);
  const run = collector();

  expect(() => run.observe(dispatchEvent, {
    purpose: 'research_narration', dispatchPhase: 'narration', optIn: true,
    serializedResultShape: { resultRowCount: 20, columnCount: 2 }, cumulativeResultRowCount: 20,
  })).not.toThrow();
  expect(() => run.observe(dispatchEvent, {
    purpose: 'research_tool', dispatchPhase: 'generation', optIn: true,
    serializedResultShape: { resultRowCount: 200, columnCount: 4 }, cumulativeResultRowCount: 200,
  })).not.toThrow();
  expect(run.snapshot().providerEgressReceipts.map((receipt) => ({ purpose: receipt.purpose, rows: receipt.resultRowCount })))
    .toEqual([
      { purpose: 'research_narration', rows: 20 },
      { purpose: 'research_tool', rows: 200 },
    ]);

  expect(() => collector().observe(dispatchEvent, {
    purpose: 'research_tool', dispatchPhase: 'generation', optIn: true,
    serializedResultShape: { resultRowCount: 201, columnCount: 1 }, cumulativeResultRowCount: 201,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_RESULT_ROWS_LIMIT_EXCEEDED' }));
  expect(() => collector().observe(dispatchEvent, {
    purpose: 'research_narration', dispatchPhase: 'narration', optIn: true,
    serializedResultShape: { resultRowCount: 21, columnCount: 1 }, cumulativeResultRowCount: 21,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_RESULT_ROWS_LIMIT_EXCEEDED' }));
  expect(() => collector().observe(dispatchEvent, {
    purpose: 'research_tool', dispatchPhase: 'generation', optIn: false,
    serializedResultShape: { resultRowCount: 1, columnCount: 1 }, cumulativeResultRowCount: 1,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_RESULT_ROWS_BLOCKED' }));

  // Consent and cumulative counters are per collector/run; a new run begins at zero.
  expect(() => collector().observe(dispatchEvent, {
    purpose: 'research_tool', dispatchPhase: 'generation', optIn: true,
    serializedResultShape: { resultRowCount: 200, columnCount: 4 }, cumulativeResultRowCount: 200,
  })).not.toThrow();
});

it('pairs an opted-in Research narration receipt with exactly one physical provider trace attempt', () => {
  const run = new RunScopedProviderDispatchEvidence(
    { total: 4, meaningResolution: 1, generationGroup: 2, narration: 1, repair: 0 },
    undefined,
    RESEARCH_ROW_EGRESS_POLICY,
  );
  const { observer, spans } = providerTraceRecorder();
  const trace = createProviderDispatchTrace({
    observer,
    phase: 'narration',
    purpose: 'research_narration',
    admit: (event) => run.observe(event, {
      purpose: 'research_narration',
      dispatchPhase: 'narration',
      optIn: true,
      serializedResultShape: { resultRowCount: 2, columnCount: 2 },
      cumulativeResultRowCount: 2,
    }),
  });
  const options = { ...trace.options, model: 'research-narrator-test' };
  prepareProviderHttpDispatch({
    provider: 'ollama', operation: 'generate', attemptIndex: 1,
    envelope: dispatchEvent.envelope, options,
  });
  completeProviderHttpDispatch({
    provider: 'ollama', operation: 'generate', attemptIndex: 1, options,
  }, { outcome: 'ok', settlement: 'transport', httpStatus: 200 });
  trace.settle('ok');

  expect(run.snapshot().providerEgressReceipts).toEqual([
    expect.objectContaining({
      purpose: 'research_narration', dispatchPhase: 'narration',
      resultRowCount: 2, columnCount: 2, optIn: true,
    }),
  ]);
  expect(spans).toHaveLength(1);
  expect(providerAttempt(spans[0]!)).toMatchObject({
    phase: 'narration', purpose: 'research_narration', admission: 'admitted',
  });
  expect(spans[0]?.finish).toMatchObject({ outcome: 'ok', reasonCode: 'completed' });
});

it('accounts the real Research hypothesis planner once, then denies a capped second plan before send', async () => {
  const ledger = new RunScopedProviderDispatchEvidence(
    agentRunProviderDispatchBudgetForMode('research'),
    undefined,
    RESEARCH_ROW_EGRESS_POLICY,
  );
  const { observer, spans } = providerTraceRecorder();
  const request = attachAskTraceObserverV1(researchPlannerRequest(), observer);
  let physicalSends = 0;
  const provider = createResearchHypothesisPlanningProvider({
    provider: tracedHypothesisProvider({ onPhysicalSend: () => { physicalSends += 1; } }),
    request,
    ledger,
  });

  // This invokes the actual planResearchHypotheses structured call rather
  // than testing a hand-built provider trace in isolation.
  const hypotheses = await planResearchHypotheses(
    provider,
    request.question,
    RESEARCH_HYPOTHESIS_ASSETS,
    { signal: request.signal },
  );
  expect(hypotheses).toHaveLength(3);
  expect(physicalSends).toBe(1);
  expect(ledger.snapshot().providerEgressReceipts).toEqual([
    expect.objectContaining({ purpose: 'answer_generation', dispatchPhase: 'planning', resultRowCount: 0 }),
  ]);
  expect(spans).toHaveLength(1);
  expect(providerAttempt(spans[0]!)).toMatchObject({
    phase: 'planning', purpose: 'answer_generation', admission: 'admitted',
  });
  expect(spans[0]?.finish).toMatchObject({ outcome: 'ok', reasonCode: 'completed' });

  // A second hypothesis planner call is not a hidden retry. The shared
  // Research ledger denies it before the provider adapter may send another
  // HTTP body; planResearchHypotheses intentionally falls back to `[]`.
  await expect(planResearchHypotheses(
    provider,
    request.question,
    RESEARCH_HYPOTHESIS_ASSETS,
    { signal: request.signal },
  )).resolves.toEqual([]);
  expect(physicalSends).toBe(1);
  // The transport itself never starts for this second, denied admission.
  expect(ledger.snapshot().providerEgressReceipts).toHaveLength(1);
  expect(spans).toHaveLength(2);
  expect(providerAttempt(spans[1]!)).toMatchObject({
    phase: 'planning', purpose: 'answer_generation', admission: 'denied', cause: 'dispatch_budget',
  });
  expect(spans[1]?.finish).toMatchObject({ outcome: 'denied', reasonCode: 'provider_failure' });
});

it('classifies Research hypothesis planner transport failure and inherited cancellation without duplicate sends', async () => {
  const failingLedger = new RunScopedProviderDispatchEvidence(
    agentRunProviderDispatchBudgetForMode('research'),
    undefined,
    RESEARCH_ROW_EGRESS_POLICY,
  );
  const failureTrace = providerTraceRecorder();
  const failureRequest = attachAskTraceObserverV1(researchPlannerRequest(), failureTrace.observer);
  const failingProvider = createResearchHypothesisPlanningProvider({
    provider: tracedHypothesisProvider({ failAfterAdmission: true }),
    request: failureRequest,
    ledger: failingLedger,
  });
  await expect(planResearchHypotheses(
    failingProvider,
    failureRequest.question,
    RESEARCH_HYPOTHESIS_ASSETS,
    { signal: failureRequest.signal },
  )).resolves.toEqual([]);
  expect(failingLedger.snapshot().providerEgressReceipts).toHaveLength(1);
  expect(failureTrace.spans).toHaveLength(1);
  expect(providerAttempt(failureTrace.spans[0]!)).toMatchObject({
    phase: 'planning', purpose: 'answer_generation', admission: 'admitted', cause: 'gateway', httpStatusClass: '5xx',
  });
  expect(failureTrace.spans[0]?.finish).toMatchObject({ outcome: 'error', reasonCode: 'provider_failure' });

  const controller = new AbortController();
  const cancellationLedger = new RunScopedProviderDispatchEvidence(
    agentRunProviderDispatchBudgetForMode('research'),
    undefined,
    RESEARCH_ROW_EGRESS_POLICY,
  );
  const cancellationTrace = providerTraceRecorder();
  const cancellationRequest = attachAskTraceObserverV1(researchPlannerRequest(controller.signal), cancellationTrace.observer);
  let cancellationSends = 0;
  const cancellingProvider = createResearchHypothesisPlanningProvider({
    provider: tracedHypothesisProvider({
      onPhysicalSend: () => { cancellationSends += 1; },
      cancelAfterAdmission: () => controller.abort(new Error('cancelled by user')),
    }),
    request: cancellationRequest,
    ledger: cancellationLedger,
  });
  await expect(planResearchHypotheses(
    cancellingProvider,
    cancellationRequest.question,
    RESEARCH_HYPOTHESIS_ASSETS,
    { signal: cancellationRequest.signal },
  )).resolves.toEqual([]);
  expect(cancellationSends).toBe(1);
  expect(cancellationLedger.snapshot().providerEgressReceipts).toHaveLength(1);
  expect(cancellationTrace.spans).toHaveLength(1);
  expect(providerAttempt(cancellationTrace.spans[0]!)).toMatchObject({
    phase: 'planning', purpose: 'answer_generation', admission: 'admitted', cause: 'cancelled',
  });
  expect(cancellationTrace.spans[0]?.finish).toMatchObject({ outcome: 'cancelled', reasonCode: 'cancelled' });
});

it.each([
  [429, 'rate_limited', '4xx', true, 'wait_and_retry'],
  [502, 'gateway', '5xx', true, 'retry_same_provider'],
] as const)('records one typed provider attempt for HTTP %i without a synthetic duplicate', (
  status,
  cause,
  httpStatusClass,
  retryable,
  safeAction,
) => {
  const { observer, spans } = providerTraceRecorder();
  const trace = createProviderDispatchTrace({
    observer,
    phase: 'narration',
    purpose: 'research_narration',
    admit: (event) => event.envelope,
  });
  const options = { ...trace.options, model: 'research-narrator-test' };
  prepareProviderHttpDispatch({
    provider: 'ollama', operation: 'generate', attemptIndex: 1,
    envelope: dispatchEvent.envelope, options,
  });
  completeProviderHttpDispatch({
    provider: 'ollama', operation: 'generate', attemptIndex: 1, options,
  }, { outcome: 'error', settlement: 'transport', httpStatus: status });
  // The provider's outer promise rejects after transport completion. Its
  // settle call must observe the existing boundary, not append a second one.
  trace.settle('error', Object.assign(new Error(`HTTP ${status}`), { code: `HTTP_${status}` }));

  expect(spans).toHaveLength(1);
  expect(providerAttempt(spans[0]!)).toMatchObject({
    phase: 'narration', purpose: 'research_narration', admission: 'admitted',
    cause, httpStatusClass, retryable, safeAction,
  });
  expect(spans[0]?.finish).toMatchObject({ outcome: 'error', reasonCode: 'provider_failure' });
});

it('records a denied Research row-egress admission without a receipt or admitted trace attempt', () => {
  const run = new RunScopedProviderDispatchEvidence(
    { total: 4, meaningResolution: 1, generationGroup: 2, narration: 1, repair: 0 },
    undefined,
    RESEARCH_ROW_EGRESS_POLICY,
  );
  const { observer, spans } = providerTraceRecorder();
  const trace = createProviderDispatchTrace({
    observer,
    phase: 'narration',
    purpose: 'research_narration',
    admit: (event) => run.observe(event, {
      purpose: 'research_narration',
      dispatchPhase: 'narration',
      // The transport asks to serialize a result row but no one-run consent
      // was supplied. This must stop before any HTTP body can be admitted.
      optIn: false,
      serializedResultShape: { resultRowCount: 1, columnCount: 1 },
      cumulativeResultRowCount: 1,
    }),
  });
  const options = { ...trace.options, model: 'research-narrator-test' };
  expect(() => prepareProviderHttpDispatch({
    provider: 'ollama', operation: 'generate', attemptIndex: 1,
    envelope: dispatchEvent.envelope, options,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_RESULT_ROWS_BLOCKED' }));
  // The outer provider error must not fabricate a second unknown attempt.
  trace.settle('error', Object.assign(new Error('result rows blocked'), { code: 'PROVIDER_RESULT_ROWS_BLOCKED' }));

  expect(run.snapshot().providerEgressReceipts).toHaveLength(0);
  expect(spans).toHaveLength(1);
  expect(providerAttempt(spans[0]!)).toMatchObject({
    phase: 'narration', purpose: 'research_narration', admission: 'denied',
    cause: 'admission_denied', safeAction: 'inspect_run',
  });
  expect(spans[0]?.finish).toMatchObject({ outcome: 'denied', reasonCode: 'provider_failure' });
});

it('reserves one third ordinary Ask send for a single frozen-plan provider repair', () => {
  const run = new RunScopedProviderDispatchEvidence(agentRunProviderDispatchBudgetForMode('ask'));

  expect(() => run.observe(dispatchEvent, {
    purpose: 'answer_generation', dispatchPhase: 'meaning_resolution', optIn: false,
  })).not.toThrow();
  expect(() => run.observe(dispatchEvent, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).not.toThrow();
  // A repair is a separately typed, same-plan capability. The answer loop only
  // mints this phase after its frozen exploratory authority check; the ledger
  // makes room for it without allowing a second generation/replan.
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 2 }, {
    purpose: 'repair_sql', dispatchPhase: 'repair', optIn: false,
  })).not.toThrow();
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 3 }, {
    purpose: 'repair_sql', dispatchPhase: 'repair', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' }));
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 4 }, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' }));
  expect(run.snapshot().providerEgressReceipts).toHaveLength(3);
  expect(run.snapshot().providerEgressReceipts.map((receipt) => receipt.dispatchPhase)).toEqual([
    'meaning_resolution',
    'generation',
    'repair',
  ]);
});

it('admits one parent-bound transient retry without turning it into a second generation budget', () => {
  const run = new RunScopedProviderDispatchEvidence(agentRunProviderDispatchBudgetForMode('ask'));
  const first = { ...dispatchEvent, attemptIndex: 1 };
  const retry = { ...dispatchEvent, attemptIndex: 2 };

  run.observe(first, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  });
  // The retry retains phase/purpose/provider identity and consumes the total
  // budget, but is not rejected merely because the normal generation group is
  // one physical send.
  run.observe(retry, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
    retryOfAttemptIndex: 1,
  });
  expect(run.snapshot().providerEgressReceipts).toEqual([
    expect.objectContaining({ attemptIndex: 1, dispatchPhase: 'generation' }),
    expect.objectContaining({ attemptIndex: 2, dispatchPhase: 'generation', retryOfAttemptIndex: 1 }),
  ]);
  // No retry chaining, cross-phase borrowing, or repair retry is admitted.
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 3 }, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
    retryOfAttemptIndex: 2,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_RETRY_NOT_ALLOWED' }));
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 3 }, {
    purpose: 'repair_sql', dispatchPhase: 'repair', optIn: false,
    retryOfAttemptIndex: 1,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_RETRY_NOT_ALLOWED' }));
});

it('keeps legacy category classification distinct from candidate-ID meaning resolution', () => {
  const run = new RunScopedProviderDispatchEvidence(agentRunProviderDispatchBudgetForMode('ask'));

  run.observe(dispatchEvent, {
    purpose: 'classification', dispatchPhase: 'classification', optIn: false,
  });
  expect(run.snapshot().providerEgressReceipts).toEqual([
    expect.objectContaining({ purpose: 'classification', dispatchPhase: 'classification', resultRowCount: 0 }),
  ]);
  // A category-only prompt has no qualified candidate binding. It must never
  // be followed by (or presented as) a candidate-ID meaning resolution.
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 2 }, {
    purpose: 'answer_generation', dispatchPhase: 'meaning_resolution', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_INTERPRETATION_PHASE_CONFLICT' }));
  expect(run.snapshot().providerEgressReceipts).toHaveLength(1);
});

it('caps explicit Research at twelve physical sends with no thirteenth receipt', () => {
  const run = new RunScopedProviderDispatchEvidence(agentRunProviderDispatchBudgetForMode('research'));
  run.observe(dispatchEvent, {
    purpose: 'answer_generation', dispatchPhase: 'meaning_resolution', optIn: false,
  });
  run.observe({ ...dispatchEvent, attemptIndex: 1 }, {
    purpose: 'answer_generation', dispatchPhase: 'planning', optIn: false,
  });
  for (let attemptIndex = 1; attemptIndex <= 8; attemptIndex += 1) {
    run.observe({ ...dispatchEvent, attemptIndex }, {
      purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
    });
  }
  run.observe({ ...dispatchEvent, attemptIndex: 10 }, {
    purpose: 'research_narration', dispatchPhase: 'narration', optIn: false,
  });
  run.observe({ ...dispatchEvent, attemptIndex: 11 }, {
    purpose: 'repair_sql', dispatchPhase: 'repair', optIn: false,
  });

  expect(run.snapshot().providerEgressReceipts).toHaveLength(12);
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 12 }, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' }));
  expect(run.snapshot().providerEgressReceipts).toHaveLength(12);
});

it('accounts every physical dispatch once on the persisted AgentRun', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-agent-run-egress-'));
  writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
  saveProviderSettings(projectRoot, {
    id: 'openai',
    enabled: true,
    apiKey: 'test-secret',
    baseUrl: 'https://agent-run-egress.example.test/v1',
    model: 'probe-model',
  });
  const nativeFetch = globalThis.fetch;
  const providerBodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://agent-run-egress.example.test/')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      providerBodies.push(body);
      const serialized = JSON.stringify(body);
      const content = serialized.includes('Pick ONE category')
        ? JSON.stringify({
            category: 'general_knowledge',
            depth: 'quick',
            needsClarification: false,
            rationale: 'Specific governed metric lookup.',
          })
        : JSON.stringify({ summary: 'No governed result is available yet.' });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return nativeFetch(input, init);
  }));

  let server: Server | undefined;
  try {
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      preferredPort: 0,
      captureServer: (value) => { server = value; },
    });
    const response = await nativeFetch(`http://127.0.0.1:${port}/api/agent-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: 'How should I explain total revenue to a new analyst?',
        requestedMode: 'ask',
        workspaceContext: {
          schema: [{ customer_name: 'ROW_CANARY_SCHEMA', amount: 42 }],
          nested: {
            descriptor: [{ name: 'ROW_CANARY_DESCRIPTOR', type: 'varchar' }],
            content: [{ customer_name: 'ROW_CANARY_CONTENT', amount: 42 }],
          },
        },
      }),
    });
    expect(response.status).toBe(201);
    const payload = await response.json() as { run: { id: string } };
    const persistedResponse = await nativeFetch(
      `http://127.0.0.1:${port}/api/agent-runs/${encodeURIComponent(payload.run.id)}`,
    );
    expect(persistedResponse.status).toBe(200);
    const persisted = await persistedResponse.json() as { run: any };

    // An unmodeled project has no Resolved Analytical Plan to freeze, so the
    // run fails closed after the legacy category classification and never reaches
    // generation. That is the RAP contract, not a missing dispatch: the point
    // here is that the ONE dispatch that did happen is fully accounted for.
    expect(persisted.run.status).toBe('blocked');
    expect(providerBodies).toHaveLength(1);
    expect(JSON.stringify(providerBodies)).not.toContain('ROW_CANARY');
    expect(persisted.run.telemetry.providerRoundTrips).toBe(providerBodies.length);
    expect(persisted.run.providerEgressReceipts).toHaveLength(providerBodies.length);
    expect(persisted.run.providerEgressReceipts.map((receipt: any) => receipt.dispatchPhase)).toEqual([
      'classification',
    ]);
    expect(persisted.run.providerEgressReceipts.map((receipt: any) => receipt.purpose)).toEqual([
      'classification',
    ]);
    expect(persisted.run.providerEgressReceipts.map((receipt: any) => receipt.payloadFingerprint)).toEqual(
      providerBodies.map(providerPayloadFingerprint),
    );
    expect(persisted.run.diagnosticReceipt.providerEgressReceipts).toHaveLength(providerBodies.length);
    expect(persisted.run.diagnosticReceiptV2.telemetry.providerRoundTrips).toBe(providerBodies.length);
    expect(persisted.run.diagnosticReceiptV2.providerEgressReceiptFingerprints).toHaveLength(providerBodies.length);
    expect(persisted.run.providerEgressReceipts.every((receipt: any) =>
      receipt.resultRowCount === 0
      && receipt.columnCount === 0
      && typeof receipt.payloadFingerprint === 'string'
      && !JSON.stringify(receipt).includes('ROW_CANARY')
      && !JSON.stringify(receipt).includes('test-secret')
    )).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    rmSync(projectRoot, { recursive: true, force: true });
  }
}, 30_000);

it('types a governed refusal as DQL governance, not provider unavailability', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-agent-run-third-send-'));
  writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
  saveProviderSettings(projectRoot, {
    id: 'openai',
    enabled: true,
    apiKey: 'test-secret',
    baseUrl: 'https://third-send.example.test/v1',
    model: 'probe-model',
  });
  const nativeFetch = globalThis.fetch;
  const providerBodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).startsWith('https://third-send.example.test/')) return nativeFetch(input, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    providerBodies.push(body);
    const serialized = JSON.stringify(body);
    if (serialized.includes('Pick ONE category')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        category: 'general_knowledge',
        depth: 'quick',
        needsClarification: false,
        rationale: 'A plain-language explanation is required.',
      }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'." },
    }), { status: 400, headers: { 'content-type': 'application/json' } });
  }));

  let server: Server | undefined;
  try {
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      preferredPort: 0,
      captureServer: (value) => { server = value; },
    });
    const response = await nativeFetch(`http://127.0.0.1:${port}/api/agent-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: 'How should I explain total revenue to a new analyst?',
        requestedMode: 'ask',
      }),
    });

    expect(response.status).toBe(201);
    const { run } = await response.json() as { run: any };
    // An unmodeled project fails closed on the RAP boundary after the single
    // legacy category classification, so a second (let alone third) send never happens.
    // The property worth pinning is the ATTRIBUTION: DQL refusing on its own
    // governance must never be dressed up as the user's AI provider failing,
    // which sends them to re-authenticate a provider that worked fine.
    expect(providerBodies).toHaveLength(1);
    expect(run.telemetry.providerRoundTrips).toBe(1);
    expect(run.providerEgressReceipts).toEqual([
      expect.objectContaining({ purpose: 'classification', dispatchPhase: 'classification' }),
    ]);
    expect(run).toMatchObject({ route: 'blocked', status: 'blocked' });
    expect(JSON.stringify(run)).not.toContain('AI_PROVIDER_FAILURE');
    expect(JSON.stringify(run)).not.toMatch(/provider setup|provider unavailable|subscription failed/i);
  } finally {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    rmSync(projectRoot, { recursive: true, force: true });
  }
}, 30_000);

it('types a failed legacy category classifier without claiming semantic binding', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-meaning-budget-'));
  writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
  saveProviderSettings(projectRoot, {
    id: 'openai', enabled: true, apiKey: 'secret',
    baseUrl: 'https://meaning-budget.example.test/v1', model: 'gpt-5',
  });
  const nativeFetch = globalThis.fetch;
  const providerBodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).startsWith('https://meaning-budget.example.test/')) return nativeFetch(input, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    providerBodies.push(body);
    if (JSON.stringify(body).includes('Pick ONE category')) {
      return new Response(JSON.stringify({
        error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." },
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Bounded deterministic fallback.' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));

  let server: Server | undefined;
  try {
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      preferredPort: 0,
      captureServer: (value) => { server = value; },
    });
    const response = await nativeFetch(`http://127.0.0.1:${port}/api/agent-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'What is total revenue by customer?', requestedMode: 'ask' }),
    });
    expect(response.status).toBe(201);
    const { run } = await response.json() as { run: any };
    const classificationBodies = providerBodies.filter((body) => JSON.stringify(body).includes('Pick ONE category'));
    const phases = run.providerEgressReceipts.map((receipt: any) => receipt.dispatchPhase);

    expect(classificationBodies).toHaveLength(1);
    expect(providerBodies).toHaveLength(1);
    expect(phases.filter((phase: string) => phase === 'classification')).toHaveLength(1);
    expect(phases.filter((phase: string) => phase === 'meaning_resolution')).toHaveLength(0);
    expect(run.providerEgressReceipts).toEqual([
      expect.objectContaining({ purpose: 'classification', dispatchPhase: 'classification' }),
    ]);
    const traceId = run.traceReference?.traceId;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    let trace: any;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const traceResponse = await nativeFetch(`http://127.0.0.1:${port}/api/ask-traces/${traceId}`);
      if (traceResponse.status === 200) {
        trace = await traceResponse.json();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const attempts = (trace?.spans ?? []).filter((span: any) => span.name === 'provider.attempt');
    const admitted = attempts.filter((span: any) => span.payload?.attempt?.admission === 'admitted');
    const denied = attempts.filter((span: any) => span.payload?.attempt?.admission === 'denied');
    // The first transport was physical and receipt-backed. OpenAI then asks
    // for a parameter-compatibility retry, which the one-call category budget
    // rejects before a second body can leave the host. Both are visible, but
    // only the admitted physical attempt is a receipt/round trip.
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.payload?.attempt).toMatchObject({
      phase: 'classification', purpose: 'classification', admission: 'admitted',
    });
    expect(admitted[0]).toMatchObject({ outcome: 'error', reasonCode: 'provider_failure' });
    expect(denied).toEqual([
      expect.objectContaining({
        outcome: 'denied',
        payload: expect.objectContaining({
          attempt: expect.objectContaining({
            phase: 'classification', purpose: 'classification', cause: 'dispatch_budget',
          }),
        }),
      }),
    ]);
    expect(phases.filter((phase: string) => ['planning', 'generation', 'narration'].includes(phase)).length)
      .toBeLessThanOrEqual(2);
    expect(providerBodies.length).toBeLessThanOrEqual(3);
    expect(run.telemetry.providerRoundTrips).toBe(providerBodies.length);
    expect(run.providerEgressReceipts).toHaveLength(providerBodies.length);
  } finally {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    rmSync(projectRoot, { recursive: true, force: true });
  }
}, 30_000);

it('isolates dispatch receipts across concurrent HTTP AgentRuns', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-concurrent-egress-'));
  writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
  saveProviderSettings(projectRoot, {
    id: 'openai', enabled: true, apiKey: 'secret',
    baseUrl: 'https://concurrent-egress.example.test/v1', model: 'probe-model',
  });
  const nativeFetch = globalThis.fetch;
  const providerBodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).startsWith('https://concurrent-egress.example.test/')) return nativeFetch(input, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    providerBodies.push(body);
    const content = JSON.stringify(body).includes('Pick ONE category')
      ? JSON.stringify({ category: 'general_knowledge', depth: 'quick', needsClarification: false, rationale: 'explanation' })
      : 'A bounded explanation.';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));

  let server: Server | undefined;
  try {
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      preferredPort: 0,
      captureServer: (value) => { server = value; },
    });
    const submit = async (canary: string) => {
      const response = await nativeFetch(`http://127.0.0.1:${port}/api/agent-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question: `How should I explain revenue to ${canary}?`,
          requestedMode: 'ask',
        }),
      });
      expect(response.status).toBe(201);
      return (await response.json() as { run: any }).run;
    };
    const [alpha, beta] = await Promise.all([submit('RUN_ALPHA'), submit('RUN_BETA')]);
    const expected = (canary: string) => providerBodies
      .filter((body) => JSON.stringify(body).includes(canary))
      .map(providerPayloadFingerprint);

    expect(alpha.providerEgressReceipts.map((receipt: any) => receipt.payloadFingerprint)).toEqual(expected('RUN_ALPHA'));
    expect(beta.providerEgressReceipts.map((receipt: any) => receipt.payloadFingerprint)).toEqual(expected('RUN_BETA'));
    expect(alpha.telemetry.providerRoundTrips).toBe(expected('RUN_ALPHA').length);
    expect(beta.telemetry.providerRoundTrips).toBe(expected('RUN_BETA').length);
    expect(expected('RUN_ALPHA')).not.toEqual(expect.arrayContaining(expected('RUN_BETA')));
  } finally {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    rmSync(projectRoot, { recursive: true, force: true });
  }
}, 30_000);

it('stops before starting a dispatch the deadline cannot fit', () => {
  // The regression this pins: a provider costing ~13s a call burned the whole
  // 45s deadline in three calls and was killed mid-flight, so the run ended
  // with NO answer — strictly worse than stopping early and answering from
  // what it already gathered.
  let nowMs = 0;
  const budget = {
    startedAtMs: 0,
    hardDeadlineMs: 45_000,
    hardSignal: new AbortController().signal,
    mode: 'ask' as const,
    elapsedMs: () => nowMs,
    remainingMs: () => Math.max(0, 45_000 - nowMs),
    softTargetMs: () => 30_000,
    mayStartDiscovery: () => true,
    narrationSoftTargetMs: () => 38_000,
    mayStartNarration: () => true,
  };
  const run = new RunScopedProviderDispatchEvidence(
    { total: 6, meaningResolution: 1, generationGroup: 3, narration: 2, repair: 1 },
    budget,
  );

  // Two real dispatches, 13s apart, teach the sink what this provider costs.
  expect(() => run.observe(dispatchEvent, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).not.toThrow();
  nowMs = 13_000;
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 2 }, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).not.toThrow();

  // 32s in: 13s left, which cannot fit another ~13s call plus settle time.
  nowMs = 32_000;
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 3 }, {
    purpose: 'answer_generation', dispatchPhase: 'generation', optIn: false,
  })).toThrow(expect.objectContaining({ code: 'RUN_DEADLINE_INSUFFICIENT' }));

  // Narration is exempt — it is the step that turns gathered work into an answer.
  expect(() => run.observe({ ...dispatchEvent, attemptIndex: 4 }, {
    purpose: 'research_narration', dispatchPhase: 'narration', optIn: false,
  })).not.toThrow();
});
