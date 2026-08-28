import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAgentRunStore } from './agent-run-store.js';
import type { AgentRun, AgentRunProgressV1 } from './agent-run-engine.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0; });
function tmp(): string { const dir = mkdtempSync(join(tmpdir(), 'run-store-')); dirs.push(dir); return dir; }

function run(id: string, startedAt: string, events = 3): AgentRun {
  return {
    id,
    question: `question ${id}`,
    route: 'generated_answer',
    status: 'completed',
    startedAt,
    completedAt: startedAt,
    events: Array.from({ length: events }, (_, index) => ({ type: 'executor.started', message: `event ${index}` })),
    artifacts: [{ kind: 'answer', payload: { answer: `answer ${id}` } }],
    evaluations: [],
  } as unknown as AgentRun;
}

function progress(id: string): AgentRunProgressV1 {
  const startedAt = '2026-07-20T10:00:00Z';
  return {
    version: 1,
    id,
    question: `question ${id}`,
    requestedMode: 'ask',
    route: 'generated_answer',
    steps: [],
    artifacts: [],
    evaluations: [],
    events: [{
      id: `${id}:event:1`,
      runId: id,
      type: 'run.started',
      at: startedAt,
      message: 'Started.',
    }],
    lifecycle: {
      version: 1,
      state: 'running',
      phase: 'run.started',
      revision: 1,
      eventCursor: 1,
      startedAt,
      updatedAt: startedAt,
    },
  };
}

describe('SqliteAgentRunStore', () => {
  it('round-trips save/get/list ordered newest-first', () => {
    const store = new SqliteAgentRunStore({ path: join(tmp(), 'runs.sqlite') });
    store.save(run('a', '2026-07-20T10:00:00Z'));
    store.save(run('b', '2026-07-20T11:00:00Z'));
    expect(store.get('a')?.question).toBe('question a');
    expect(store.list().map((r) => r.id)).toEqual(['b', 'a']);
    store.close();
  });

  it('updates in place when the same run id is saved twice', () => {
    const store = new SqliteAgentRunStore({ path: join(tmp(), 'runs.sqlite') });
    store.save(run('a', '2026-07-20T10:00:00Z'));
    store.save({ ...run('a', '2026-07-20T10:00:00Z'), question: 'updated' } as AgentRun);
    expect(store.list()).toHaveLength(1);
    expect(store.get('a')?.question).toBe('updated');
    store.close();
  });

  it('persists accepted running state and replaces it with the terminal run', () => {
    const store = new SqliteAgentRunStore({ path: join(tmp(), 'runs.sqlite') });
    store.saveProgress(progress('active'));
    expect(store.get('active')).toBeUndefined();
    expect(store.getProgress('active')?.lifecycle.state).toBe('running');
    store.save(run('active', '2026-07-20T10:00:00Z'));
    expect(store.getProgress('active')).toBeUndefined();
    expect(store.get('active')?.status).toBe('completed');
    store.close();
  });

  it('closes orphaned running state as an inspectable interrupted run on restart', () => {
    const path = join(tmp(), 'runs.sqlite');
    const store = new SqliteAgentRunStore({ path });
    store.saveProgress(progress('orphan'));
    store.close();
    const reopened = new SqliteAgentRunStore({ path });
    const interrupted = reopened.get('orphan');
    expect(interrupted).toMatchObject({
      id: 'orphan',
      status: 'blocked',
      lifecycle: { state: 'terminal', phase: 'run.failed' },
      diagnosticReceipt: {
        failure: { code: 'RUN_INTERRUPTED', recoverable: true },
      },
    });
    expect(interrupted?.artifacts[0]?.payload).toMatchObject({
      diagnosticReceipt: { failure: { code: 'RUN_INTERRUPTED' } },
    });
    reopened.close();
  });

  it('preserves typed Ask continuation but writes only a content-free V5 receipt on restart', () => {
    const path = join(tmp(), 'runs.sqlite');
    const store = new SqliteAgentRunStore({ path });
    const initial = progress('orphan-v5');
    initial.askAnalystState = {
      version: 1,
      mode: 'authoritative',
      phase: 'program_ready',
      frame: {
        version: 3,
        questionFingerprint: 'sha256:question',
        kind: 'aggregation',
        requirements: {
          measures: ['revenue'], dimensions: [], entityTerms: [], entityDisplayTerms: [], memberTerms: [], outputTerms: [],
        },
        conversation: { binding: 'none' },
      },
      mission: { version: 1, mode: 'ask', taskLimit: 3, planningContinuationLimit: 2, tasks: [], hypotheses: [] },
      workspace: {
        version: 1,
        admittedCandidateIds: ['metric:revenue'],
        excludedCandidates: [],
        sourceCoverage: [],
        tools: [{ version: 1, id: 'tool:retrieve_snapshot', kind: 'retrieve_snapshot', status: 'completed', candidateIds: ['metric:revenue'], reasonCode: 'snapshot_acquired' }],
      },
      program: {
        version: 1,
        id: 'program:restart',
        frameFingerprint: 'sha256:question',
        taskIds: ['task-1'],
        candidateIds: ['metric:revenue'],
        executionCandidateIds: ['metric:revenue'],
        requiredRoles: ['metric'],
        filters: [{ fieldTerms: ['customer_name'], memberIds: [], value: 'Brittany Barrera', operator: 'equals' }],
        relationshipRequirements: [],
        outputs: { measures: ['revenue'], dimensions: [], entityDisplayTerms: [], assertions: ['all_requested_measures', 'result_contract'] },
      },
      conversationDelta: {
        version: 1,
        sourceQuestionFingerprint: 'sha256:question',
        partialFrame: {
          kind: 'aggregation',
          requirements: { measures: ['revenue'], dimensions: [], entityTerms: [], entityDisplayTerms: [], memberTerms: [], outputTerms: [] },
        },
      },
      planningContinuations: 1,
      toolCalls: 1,
      executionAttempts: 0,
      repairAttempts: 0,
    } as never;
    store.saveProgress(initial);
    store.close();

    const reopened = new SqliteAgentRunStore({ path });
    const interrupted = reopened.get('orphan-v5');
    expect(interrupted?.askAnalystState?.program.filters[0]?.value).toBe('Brittany Barrera');
    expect(interrupted?.diagnosticReceiptV5).toMatchObject({
      version: 5,
      state: { requirementCounts: { filters: 1 }, program: { id: 'program:restart' } },
      businessAnswer: { mode: 'deterministic_fallback', factIds: [] },
    });
    expect(JSON.stringify(interrupted?.diagnosticReceiptV5)).not.toContain('Brittany Barrera');
    reopened.close();
  });

  it('round-trips V2 Ask state, program, planner receipt, and conversation delta across a restart', () => {
    const path = join(tmp(), 'runs.sqlite');
    const store = new SqliteAgentRunStore({ path });
    const initial = progress('orphan-v2');
    initial.askAnalystState = {
      version: 2,
      mode: 'authoritative',
      phase: 'program_ready',
      planningMode: 'targeted_revision',
      plannerRevisionCount: 1,
      frame: {
        version: 4,
        questionFingerprint: 'sha256:question-v2',
        kind: 'ranking',
        planningMode: 'targeted_revision',
        requirements: {
          measures: ['revenue'], dimensions: ['product category'], entityTerms: ['customer'], entityDisplayTerms: ['customer name'], memberTerms: [], outputTerms: [],
        },
        conversation: { binding: 'structured_clarification', selectedStableId: 'selection:customer_name' },
      },
      mission: {
        version: 1,
        mode: 'ask',
        taskLimit: 3,
        planningContinuationLimit: 2,
        tasks: [{ id: 'task-1', kind: 'ranking', question: 'top customers by product revenue', dependencies: [] }],
        deferredTasks: [{ id: 'task-2', kind: 'breakdown' }],
        hypotheses: [],
      },
      workspace: {
        version: 2,
        snapshotId: 'snapshot:v2',
        sourceFingerprint: 'sha256:snapshot-v2',
        workspaceCandidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:product_category'],
        plannerCandidateIds: ['metric:revenue', 'dimension:customer_name'],
        admittedCandidateIds: ['metric:revenue', 'dimension:customer_name'],
        excludedCandidates: [{ id: 'dimension:product_category', reasonCode: 'not_admitted' }],
        sourceCoverage: [],
        tools: [{ version: 1, id: 'tool:candidate_extension', kind: 'candidate_extension', status: 'completed', candidateIds: ['dimension:product_category'], reasonCode: 'targeted_same_snapshot_admitted' }],
        targetedContext: { version: 1, status: 'admitted', candidateIds: ['dimension:product_category'], relationshipPathIds: [], reasonCode: 'targeted_same_snapshot_admitted' },
      },
      program: {
        version: 2,
        id: 'program:restart-v2',
        frameFingerprint: 'sha256:question-v2',
        taskIds: ['task-1'],
        candidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:product_category'],
        executionCandidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:product_category'],
        plannerCandidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:product_category'],
        workspaceCandidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:product_category'],
        requiredRoles: ['metric', 'entity_label', 'categorical_dimension'],
        filters: [{ fieldTerms: ['customer_name'], memberIds: ['member:stable'], value: 'Brittany Barrera', operator: 'equals' }],
        relationshipRequirements: [],
        outputs: { measures: ['revenue'], dimensions: ['product category'], entityDisplayTerms: ['customer name'], assertions: ['all_requested_measures', 'all_requested_dimensions', 'result_contract'] },
        planner: {
          version: 1,
          tasks: [{ taskId: 'task-1', selectedConceptIds: ['metric:revenue', 'dimension:customer_name', 'dimension:product_category'], roleBindings: { metric: ['metric:revenue'], entity_label: ['dimension:customer_name'], categorical_dimension: ['dimension:product_category'] }, operations: ['aggregate', 'group', 'rank'], assumptions: ['top defaults to 10'] }],
          confidence: 'high',
          missingInformation: [],
        },
      },
      conversationDelta: {
        version: 2,
        sourceQuestionFingerprint: 'sha256:question-v2',
        selectedStableId: 'selection:customer_name',
        programId: 'program:restart-v2',
        partialFrame: {
          kind: 'ranking',
          planningMode: 'targeted_revision',
          requirements: { measures: ['revenue'], dimensions: ['product category'], entityTerms: ['customer'], entityDisplayTerms: ['customer name'], memberTerms: [], outputTerms: [] },
        },
      },
      planningReceipt: {
        version: 1,
        mode: 'targeted_revision',
        plannerCalls: 2,
        revisionCalls: 1,
        verification: { version: 1, status: 'valid', missingRoles: [], candidateIds: ['metric:revenue', 'dimension:customer_name', 'dimension:product_category'], reasonCode: 'program_verified' },
      },
      planningContinuations: 1,
      toolCalls: 2,
      executionAttempts: 0,
      repairAttempts: 0,
    } as never;
    store.saveProgress(initial);
    store.close();

    const reopened = new SqliteAgentRunStore({ path });
    const interrupted = reopened.get('orphan-v2');
    expect(interrupted?.askAnalystState).toMatchObject({
      version: 2,
      planningMode: 'targeted_revision',
      plannerRevisionCount: 1,
      frame: { version: 4, planningMode: 'targeted_revision' },
      workspace: { version: 2, targetedContext: { status: 'admitted' } },
      program: { version: 2, id: 'program:restart-v2', planner: { tasks: [expect.objectContaining({ taskId: 'task-1' })] } },
      conversationDelta: { version: 2, programId: 'program:restart-v2' },
      planningReceipt: { plannerCalls: 2, revisionCalls: 1, verification: { status: 'valid' } },
    });
    // V2 continuation remains local durable state; the restart diagnostic is
    // still content-free and preserves the V1-V5 reader contract.
    expect(interrupted?.askAnalystState?.program.filters[0]?.value).toBe('Brittany Barrera');
    expect(JSON.stringify(interrupted?.diagnosticReceiptV5)).not.toContain('Brittany Barrera');
    expect(interrupted?.diagnosticReceiptV6).toMatchObject({
      version: 6,
      planning: { mode: 'targeted_revision', plannerCalls: 2, revisionCalls: 1, verification: { status: 'valid' } },
      cascade: { planFrozen: false },
      connection: { attempted: false },
      execution: { attempts: 0 },
      story: expect.arrayContaining([
        expect.objectContaining({ stage: 'planner', status: 'completed' }),
        expect.objectContaining({ stage: 'verification', status: 'completed' }),
        expect.objectContaining({ stage: 'connection', status: 'skipped' }),
      ]),
    });
    expect(JSON.stringify(interrupted?.diagnosticReceiptV6)).not.toContain('Brittany Barrera');
    expect(interrupted?.artifacts[0]?.payload).toMatchObject({ diagnosticReceiptV6: { version: 6 } });
    reopened.close();

    // A V2 checkpoint can be durable after the provider boundary records a
    // failed initial dispatch but before the planning receipt increments its
    // counter. The concise V6 receipt is the default trace/UI input, so it
    // must report that real call as blocked rather than claiming the planner
    // was skipped with zero calls.
    const failed = JSON.parse(JSON.stringify(initial)) as AgentRunProgressV1;
    failed.id = 'orphan-v2-failed-planner';
    failed.question = 'top customers';
    failed.events[0] = {
      ...failed.events[0]!,
      id: 'orphan-v2-failed-planner:event:1',
      runId: 'orphan-v2-failed-planner',
    };
    const failedState = failed.askAnalystState as any;
    failedState.phase = 'blocked';
    failedState.planningMode = 'initial_planner';
    failedState.frame.planningMode = 'initial_planner';
    failedState.workspace.tools = [{
      version: 1,
      id: 'tool:provider_meaning',
      kind: 'provider_meaning',
      status: 'failed',
      candidateIds: [],
      reasonCode: 'planning.initial.failed',
    }];
    failedState.planningReceipt = {
      version: 1,
      mode: 'initial_planner',
      plannerCalls: 0,
      revisionCalls: 0,
      verification: {
        version: 1,
        status: 'invalid',
        missingRoles: [],
        candidateIds: [],
        reasonCode: 'provider_preflight_unavailable',
      },
    };
    failedState.planningContinuations = 0;
    const failedStore = new SqliteAgentRunStore({ path });
    failedStore.saveProgress(failed);
    failedStore.close();

    const restarted = new SqliteAgentRunStore({ path });
    const failedInterrupted = restarted.get('orphan-v2-failed-planner');
    expect(failedInterrupted?.diagnosticReceiptV6).toMatchObject({
      version: 6,
      planning: {
        mode: 'initial_planner',
        plannerCalls: 1,
        revisionCalls: 0,
        verification: { status: 'invalid', reasonCode: 'provider_preflight_unavailable' },
      },
      story: expect.arrayContaining([
        expect.objectContaining({ stage: 'planner', status: 'blocked', reasonCode: 'planning.initial.failed' }),
      ]),
    });
    expect(JSON.stringify(failedInterrupted?.diagnosticReceiptV6)).not.toContain('Brittany Barrera');
    expect(failedInterrupted?.artifacts[0]?.payload).toMatchObject({ diagnosticReceiptV6: { version: 6 } });
    restarted.close();
  });

  it('preserves a user cancellation as cancelled across restart', () => {
    const path = join(tmp(), 'runs.sqlite');
    const store = new SqliteAgentRunStore({ path });
    const initial = progress('cancelled-restart');
    store.saveProgress({
      ...initial,
      lifecycle: {
        ...initial.lifecycle,
        state: 'cancelling',
        updatedAt: '2026-07-20T10:00:01Z',
      },
    });
    store.close();

    const reopened = new SqliteAgentRunStore({ path });
    const cancelled = reopened.get('cancelled-restart');
    expect(cancelled).toMatchObject({
      route: 'generated_answer',
      status: 'cancelled',
      trustState: 'not_applicable',
      stopReason: 'cancelled',
      summary: 'Stopped by user.',
      nextActions: [],
      lifecycle: { state: 'terminal', phase: 'run.cancelled' },
      diagnosticReceipt: {
        failure: { code: 'RUN_CANCELLED', recoverable: false, safeActions: [] },
      },
    });
    expect(cancelled?.events.at(-1)?.type).toBe('run.cancelled');
    expect(cancelled?.artifacts).toEqual([]);
    reopened.close();
  });

  it('enforces retention on write (oldest pruned)', () => {
    const store = new SqliteAgentRunStore({ path: join(tmp(), 'runs.sqlite'), maxRuns: 20 });
    for (let index = 0; index < 30; index += 1) {
      store.save(run(`r${index}`, `2026-07-20T10:${String(index).padStart(2, '0')}:00Z`));
    }
    const ids = store.list().map((r) => r.id);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('r29');
    expect(ids).not.toContain('r0');
    store.close();
  });

  it('compacts event streams for runs beyond the recent window but keeps artifacts', () => {
    const store = new SqliteAgentRunStore({ path: join(tmp(), 'runs.sqlite'), maxRuns: 50, fullPayloadRuns: 2 });
    for (let index = 0; index < 5; index += 1) {
      store.save(run(`r${index}`, `2026-07-20T10:0${index}:00Z`));
    }
    const all = store.list();
    const newest = all[0]!;
    const oldest = all.at(-1)!;
    expect(newest.events.length).toBeGreaterThan(0);
    expect(oldest.events).toEqual([]);
    expect(oldest.artifacts).toHaveLength(1);
    store.close();
  });

  it('imports a legacy JSON store once and renames it to *.migrated', () => {
    const dir = tmp();
    const legacy = join(dir, 'agent-runs.json');
    writeFileSync(legacy, JSON.stringify({ version: 1, runs: [run('legacy1', '2026-07-19T10:00:00Z'), { junk: true }] }));
    const store = new SqliteAgentRunStore({ path: join(dir, 'runs.sqlite'), legacyJsonPath: legacy });
    expect(store.get('legacy1')?.question).toBe('question legacy1');
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(`${legacy}.migrated`)).toBe(true);
    // Re-opening must not double-import or crash.
    store.close();
    const reopened = new SqliteAgentRunStore({ path: join(dir, 'runs.sqlite'), legacyJsonPath: legacy });
    expect(reopened.list()).toHaveLength(1);
    reopened.close();
  });

  it('drops corrupt row-bearing ordinary Ask receipts while importing legacy JSON', () => {
    const dir = tmp();
    const legacy = join(dir, 'agent-runs.json');
    const corruptReceipt = {
      version: 1,
      purpose: 'classification',
      dispatchPhase: 'classification',
      provider: 'openai',
      permittedCategories: ['question', 'result_rows'],
      resultRowCount: 1,
      cumulativeResultRowCount: 1,
      columnCount: 1,
      redactionPolicyId: 'hand-edited-local-json',
      optIn: true,
      payloadFingerprint: 'sha256:corrupt',
    };
    const legacyRun = {
      ...run('legacy-egress', '2026-07-19T10:00:00Z'),
      providerEgressReceipts: [corruptReceipt],
      diagnosticReceipt: { version: 1, providerEgressReceipts: [corruptReceipt] },
      artifacts: [{
        kind: 'answer',
        payload: { diagnosticReceipt: { version: 1, providerEgressReceipts: [corruptReceipt] } },
      }],
    };
    writeFileSync(legacy, JSON.stringify({ version: 1, runs: [legacyRun] }));

    const store = new SqliteAgentRunStore({ path: join(dir, 'runs.sqlite'), legacyJsonPath: legacy });
    const imported = store.get('legacy-egress');
    expect(imported?.providerEgressReceipts).toEqual([]);
    expect(imported?.diagnosticReceipt?.providerEgressReceipts).toEqual([]);
    expect((imported?.artifacts[0]?.payload as { diagnosticReceipt?: { providerEgressReceipts?: unknown[] } })
      .diagnosticReceipt?.providerEgressReceipts).toEqual([]);
    store.close();
  });

  it('keeps V1/V2 phase-less ordinary narration rows as read-only legacy evidence on import', () => {
    const dir = tmp();
    const legacy = join(dir, 'agent-runs.json');
    const legacyReceipt = {
      version: 1,
      purpose: 'answer_narration',
      provider: 'openai',
      permittedCategories: ['question', 'result_rows'],
      resultRowCount: 2,
      cumulativeResultRowCount: 2,
      columnCount: 1,
      redactionPolicyId: 'legacy-result-rows-v1',
      optIn: true,
      payloadFingerprint: 'sha256:legacy-narration',
    };
    const legacyRun = {
      ...run('legacy-narration', '2026-07-19T10:00:00Z'),
      providerEgressReceipts: [legacyReceipt],
      diagnosticReceipt: { version: 1, providerEgressReceipts: [legacyReceipt] },
    };
    writeFileSync(legacy, JSON.stringify({ version: 1, runs: [legacyRun] }));

    const store = new SqliteAgentRunStore({ path: join(dir, 'runs.sqlite'), legacyJsonPath: legacy });
    const imported = store.get('legacy-narration');
    expect(imported?.providerEgressReceipts).toEqual([
      expect.objectContaining({ purpose: 'answer_narration', resultRowCount: 2, legacyReadOnly: true }),
    ]);
    expect(imported?.diagnosticReceipt?.providerEgressReceipts).toEqual([
      expect.objectContaining({ purpose: 'answer_narration', legacyReadOnly: true }),
    ]);
    store.close();
  });

  it('tolerates a corrupt legacy file (kept on disk, store still works)', () => {
    const dir = tmp();
    const legacy = join(dir, 'agent-runs.json');
    writeFileSync(legacy, 'not json {');
    const store = new SqliteAgentRunStore({ path: join(dir, 'runs.sqlite'), legacyJsonPath: legacy });
    store.save(run('a', '2026-07-20T10:00:00Z'));
    expect(store.list()).toHaveLength(1);
    expect(existsSync(`${legacy}.migrated`)).toBe(true);
    store.close();
  });
});
