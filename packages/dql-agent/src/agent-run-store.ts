/**
 * SQLite-backed agent-run persistence (P0, REL-002 follow-through).
 *
 * The legacy FileAgentRunStore kept every run in ONE pretty-printed JSON file
 * and rewrote the whole file on every save — with ~1 MB per run (full events,
 * evidence, and result payloads) a real project reached 123 MB and each answer
 * paid two full-file rewrites. This store keeps one row per run, enforces
 * retention on write, and compacts old runs' event streams so the recent runs
 * a user actually reopens stay complete while history stops growing unbounded.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeProviderEgressReceiptV1 } from '@duckcodeailabs/dql-core';
import type {
  AgentRun,
  AgentRunDiagnosticReceiptV1,
  AgentRunProgressV1,
  AgentRunStore,
} from './agent-run-engine.js';
import type {
  AgentRunDiagnosticReceiptV5,
  AgentRunDiagnosticReceiptV6,
  AskAnalystState,
} from './analytical-orchestration.js';

export interface SqliteAgentRunStoreOptions {
  /** Path of the .sqlite file (created on first use). */
  path: string;
  /** Legacy agent-runs.json to import once and rename to *.migrated. */
  legacyJsonPath?: string;
  /** Maximum retained runs (oldest pruned on write). Env DQL_AGENT_RUN_RETENTION overrides. */
  maxRuns?: number;
  /** Newest N runs keep their full event stream; older runs are compacted. */
  fullPayloadRuns?: number;
}

const DEFAULT_MAX_RUNS = 300;
const DEFAULT_FULL_PAYLOAD_RUNS = 50;

export function resolveAgentRunRetention(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.DQL_AGENT_RUN_RETENTION);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MAX_RUNS;
  return Math.max(20, Math.min(5_000, Math.floor(configured)));
}

export class SqliteAgentRunStore implements AgentRunStore {
  private readonly db: Database.Database;
  private readonly maxRuns: number;
  private readonly fullPayloadRuns: number;

  constructor(options: SqliteAgentRunStoreOptions) {
    mkdirSync(dirname(options.path), { recursive: true });
    this.db = new Database(options.path);
    this.db.pragma('journal_mode = WAL');
    this.maxRuns = options.maxRuns ?? resolveAgentRunRetention();
    this.fullPayloadRuns = Math.max(1, options.fullPayloadRuns ?? DEFAULT_FULL_PAYLOAD_RUNS);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        route TEXT NOT NULL,
        status TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        compacted INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC);
    `);
    this.finalizeInterruptedRuns();
    if (options.legacyJsonPath) this.migrateLegacyJson(options.legacyJsonPath);
  }

  save(run: AgentRun): void {
    const persistedRun = normalizeRunProviderEgressReceipts(run);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_runs (id, question, route, status, started_at, completed_at, compacted, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        question = excluded.question,
        route = excluded.route,
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        compacted = 0,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      persistedRun.id,
      persistedRun.question,
      persistedRun.route,
      (persistedRun as { status?: string }).status ?? null,
      persistedRun.startedAt,
      (persistedRun as { completedAt?: string }).completedAt ?? null,
      JSON.stringify(persistedRun),
      now,
    );
    this.enforceRetention();
    this.compactOldRuns();
  }

  saveProgress(progress: AgentRunProgressV1): void {
    const updatedAt = progress.lifecycle.updatedAt;
    this.db.prepare(`
      INSERT INTO agent_runs (id, question, route, status, started_at, completed_at, compacted, payload_json, updated_at)
      VALUES (?, ?, ?, NULL, ?, NULL, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        question = excluded.question,
        route = excluded.route,
        status = NULL,
        started_at = excluded.started_at,
        completed_at = NULL,
        compacted = 0,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
      WHERE agent_runs.completed_at IS NULL
    `).run(
      progress.id,
      progress.question,
      progress.route ?? 'blocked',
      progress.lifecycle.startedAt,
      JSON.stringify(progress),
      updatedAt,
    );
  }

  get(id: string): AgentRun | undefined {
    const row = this.db.prepare('SELECT payload_json FROM agent_runs WHERE id = ?').get(id) as { payload_json: string } | undefined;
    return row ? parseRun(row.payload_json) : undefined;
  }

  getProgress(id: string): AgentRunProgressV1 | undefined {
    const row = this.db.prepare('SELECT payload_json FROM agent_runs WHERE id = ? AND completed_at IS NULL').get(id) as { payload_json: string } | undefined;
    return row ? parseProgress(row.payload_json) : undefined;
  }

  list(): AgentRun[] {
    const rows = this.db.prepare('SELECT payload_json FROM agent_runs ORDER BY started_at DESC').all() as Array<{ payload_json: string }>;
    return rows.flatMap((row) => {
      const run = parseRun(row.payload_json);
      return run ? [run] : [];
    });
  }

  close(): void {
    this.db.close();
  }

  /**
   * A local runtime restart cannot safely recreate provider/tool continuations.
   * Close orphaned rows with one inspectable, retryable terminal receipt instead
   * of leaving the UI in a permanent running state.
   *
   * Acceptance: API-008, API-007.
   */
  private finalizeInterruptedRuns(): void {
    const rows = this.db.prepare(
      'SELECT id, payload_json FROM agent_runs WHERE completed_at IS NULL',
    ).all() as Array<{ id: string; payload_json: string }>;
    if (rows.length === 0) return;
    const update = this.db.prepare(`
      UPDATE agent_runs
      SET route = ?, status = ?, completed_at = ?, payload_json = ?, updated_at = ?
      WHERE id = ? AND completed_at IS NULL
    `);
    const closeAll = this.db.transaction(() => {
      for (const row of rows) {
        const progress = parseProgress(row.payload_json);
        if (!progress) continue;
        const completedAt = new Date().toISOString();
        const userCancelled = progress.lifecycle.state === 'cancelling'
          || progress.events.some((event) => event.type === 'run.cancelled');
        const route = progress.route ?? (userCancelled ? 'cancelled' : 'blocked');
        const failure: AgentRunDiagnosticReceiptV1['failure'] = {
          code: userCancelled ? 'RUN_CANCELLED' : 'RUN_INTERRUPTED',
          phase: progress.lifecycle.phase,
          message: userCancelled
            ? 'Stopped by user.'
            : 'The local DQL runtime restarted before this agent run completed. No result was accepted.',
          recoverable: !userCancelled,
          safeActions: userCancelled ? [] : ['retry_same_request'],
        };
        const receipt: AgentRunDiagnosticReceiptV1 = {
          version: 1,
          runId: progress.id,
          phase: progress.lifecycle.phase,
          route,
          plan: progress.plan,
          steps: progress.steps,
          artifacts: progress.artifacts,
          evaluations: progress.evaluations,
          failure,
        };
        const runtimeReceipt = interruptedRuntimeReceiptV5(progress, userCancelled, route);
        const runtimeReceiptV6 = runtimeReceipt
          ? interruptedRuntimeReceiptV6(progress, userCancelled, runtimeReceipt)
          : undefined;
        const diagnosticArtifact = {
          id: `${progress.id}:diagnostic`,
          kind: 'answer' as const,
          title: userCancelled ? 'Cancelled agent run' : 'Interrupted agent run',
          trustState: 'blocked' as const,
          payload: {
            diagnosticReceipt: receipt,
            ...(runtimeReceipt ? { diagnosticReceiptV5: runtimeReceipt } : {}),
            ...(runtimeReceiptV6 ? { diagnosticReceiptV6: runtimeReceiptV6 } : {}),
          },
        };
        const run: AgentRun = {
          id: progress.id,
          question: progress.question,
          requestedMode: progress.requestedMode,
          route,
          status: userCancelled ? 'cancelled' : 'blocked',
          trustState: userCancelled ? 'not_applicable' : 'blocked',
          stopReason: userCancelled ? 'cancelled' : 'blocked',
          startedAt: progress.lifecycle.startedAt,
          completedAt,
          selectedObject: progress.selectedObject,
          plan: progress.plan,
          steps: progress.steps,
          summary: failure.message,
          artifacts: userCancelled
            ? progress.artifacts
            : [...progress.artifacts.filter((artifact) => artifact.trustState === 'blocked'), diagnosticArtifact],
          evaluations: [
            ...progress.evaluations,
            userCancelled
              ? {
                  id: 'run-cancelled',
                  label: 'Run cancelled',
                  passed: true,
                  severity: 'info' as const,
                  message: failure.message,
                }
              : {
                  id: 'run-interrupted',
                  label: 'Run interrupted',
                  passed: false,
                  severity: 'blocking' as const,
                  message: failure.message,
                  suggestedRepair: 'Retry the same request.',
                },
          ],
          events: [
            ...progress.events,
            {
              id: `${progress.id}:event:${progress.events.length + 1}`,
              runId: progress.id,
              type: userCancelled ? 'run.cancelled' : 'run.failed',
              at: completedAt,
              message: failure.message,
              route,
              status: userCancelled ? 'cancelled' : 'blocked',
              trustState: userCancelled ? 'not_applicable' : 'blocked',
            },
          ],
          nextActions: userCancelled
            ? []
            : [{ id: 'retry-interrupted-run', label: 'Retry request', route: progress.route }],
          repairAttempts: 0,
          escalationAttempts: 0,
          diagnosticReceipt: receipt,
          ...(runtimeReceipt ? { diagnosticReceiptV5: runtimeReceipt } : {}),
          ...(runtimeReceiptV6 ? { diagnosticReceiptV6: runtimeReceiptV6 } : {}),
          ...(progress.askAnalystState ? { askAnalystState: progress.askAnalystState } : {}),
          ...(progress.traceReference ? { traceReference: progress.traceReference } : {}),
          lifecycle: {
            ...progress.lifecycle,
            state: 'terminal',
            phase: userCancelled ? 'run.cancelled' : 'run.failed',
            revision: progress.lifecycle.revision + 1,
            eventCursor: progress.events.length + 1,
            updatedAt: completedAt,
            completedAt,
          },
        };
        update.run(run.route, run.status, completedAt, JSON.stringify(run), completedAt, run.id);
      }
    });
    closeAll();
  }

  private enforceRetention(): void {
    this.db.prepare(`
      DELETE FROM agent_runs WHERE id NOT IN (
        SELECT id FROM agent_runs ORDER BY started_at DESC LIMIT ?
      )
    `).run(this.maxRuns);
  }

  /**
   * Strip the verbose event stream (progress narration) from runs that fell out
   * of the recent window. Artifacts, evaluations, and answers stay intact so
   * old runs still render their results — they just lose the step-by-step log.
   */
  private compactOldRuns(): void {
    const stale = this.db.prepare(`
      SELECT id, payload_json FROM agent_runs
      WHERE compacted = 0 AND id NOT IN (
        SELECT id FROM agent_runs ORDER BY started_at DESC LIMIT ?
      )
    `).all(this.fullPayloadRuns) as Array<{ id: string; payload_json: string }>;
    if (stale.length === 0) return;
    const update = this.db.prepare('UPDATE agent_runs SET payload_json = ?, compacted = 1 WHERE id = ?');
    for (const row of stale) {
      const run = parseRun(row.payload_json);
      if (!run) {
        update.run(row.payload_json, row.id);
        continue;
      }
      update.run(JSON.stringify({ ...run, events: [] }), row.id);
    }
  }

  /** One-time import of the legacy JSON store; the file is renamed to *.migrated as a backup. */
  private migrateLegacyJson(legacyJsonPath: string): void {
    if (!existsSync(legacyJsonPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(legacyJsonPath, 'utf-8')) as { runs?: unknown };
      const runs = Array.isArray(parsed.runs)
        ? parsed.runs.filter(isAgentRunRecord).map(normalizeRunProviderEgressReceipts)
        : [];
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO agent_runs (id, question, route, status, started_at, completed_at, compacted, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      `);
      const now = new Date().toISOString();
      const importAll = this.db.transaction((records: AgentRun[]) => {
        for (const run of records) {
          insert.run(
            run.id,
            run.question,
            run.route,
            (run as { status?: string }).status ?? null,
            run.startedAt,
            (run as { completedAt?: string }).completedAt ?? null,
            JSON.stringify(run),
            now,
          );
        }
      });
      importAll(runs);
      this.enforceRetention();
      this.compactOldRuns();
    } catch {
      // A corrupt legacy file must not block the new store; keep it for forensics.
    }
    try {
      renameSync(legacyJsonPath, `${legacyJsonPath}.migrated`);
    } catch {
      // Rename is best-effort (e.g. another process holds the file on Windows).
    }
  }
}

/**
 * Restart recovery retains the typed continuation state for a deliberate retry,
 * but its diagnostic artifact/export receipt must remain content-free. Never
 * copy the question, filter values, member values, answer, SQL, or rows here.
 */
function interruptedRuntimeReceiptV5(
  progress: AgentRunProgressV1,
  cancelled: boolean,
  route: NonNullable<AgentRunProgressV1['route']>,
): AgentRunDiagnosticReceiptV5 | undefined {
  const state = progress.askAnalystState;
  if (!state) return undefined;
  const diagnosticState = interruptedDiagnosticState(state);
  const summaryInput = {
    version: 2 as const,
    runtimeMode: state.mode,
    whatHappened: cancelled
      ? 'The Ask runtime was cancelled before its final result was accepted.'
      : 'The Ask runtime was interrupted before its final result was accepted.',
    why: cancelled
      ? 'The local run was cancelled before finalization.'
      : 'The local DQL runtime restarted before finalization.',
    impact: 'No executable data answer was accepted for this run.',
    nextAction: cancelled ? 'none' as const : 'retry_same_plan' as const,
    ...(state.resolvedPlan?.compiler ? { selectedCompiler: state.resolvedPlan.compiler } : {}),
    programTaskCount: state.program.taskIds.length,
    admittedCandidateCount: state.workspace.admittedCandidateIds.length,
    toolCallCount: state.toolCalls,
    executionAttempts: state.executionAttempts,
  };
  return {
    version: 5,
    runId: progress.id,
    state: diagnosticState,
    summary: {
      ...summaryInput,
      summaryFingerprint: `sha256:${createHash('sha256').update(JSON.stringify(summaryInput)).digest('hex')}`,
    },
    businessAnswer: {
      version: 1,
      mode: 'deterministic_fallback',
      trustState: cancelled ? 'not_applicable' : 'blocked',
      factIds: [],
      limitationCount: 1,
    },
    finalStopReason: cancelled ? 'cancelled' : 'blocked',
  };
}

/**
 * Restart recovery has no live trace collector, so V6 is projected only from
 * the persisted V2 state and its content-free V5 envelope. Do not infer a
 * connection or SQL attempt from elapsed time/prose: an interrupted execution
 * count is retained separately and the connection boundary remains skipped
 * unless a terminal run receipt recorded it before restart.
 */
function interruptedRuntimeReceiptV6(
  progress: AgentRunProgressV1,
  cancelled: boolean,
  receipt: AgentRunDiagnosticReceiptV5,
): AgentRunDiagnosticReceiptV6 {
  const state = progress.askAnalystState!;
  const planning = state.version === 2
    ? state.planningReceipt
    : undefined;
  const plannerTool = state.workspace.tools.find((tool) => tool.kind === 'provider_meaning');
  const recoveryTool = state.workspace.tools.find((tool) => tool.kind === 'candidate_extension');
  const planFrozen = state.resolvedPlan?.planFrozen === true;
  const verification = planning?.verification ?? {
    version: 1 as const,
    status: state.phase === 'clarify' ? 'ambiguous' as const : state.phase === 'blocked' ? 'invalid' as const : 'valid' as const,
    missingRoles: [],
    candidateIds: [],
    reasonCode: state.phase === 'clarify'
      ? 'persisted_clarification_state'
      : state.phase === 'blocked'
        ? 'persisted_blocked_state'
        : 'persisted_program_state',
  };
  // A durable failed provider tool is a planner attempt too. This restores a
  // truthful concise V6 restart story for V2 checkpoints saved between
  // dispatch and planning-receipt finalization.
  const plannerAttempted = plannerTool?.status === 'completed' || plannerTool?.status === 'failed';
  const plannerCalls = Math.max(
    planning?.plannerCalls ?? 0,
    plannerAttempted ? Math.max(1, state.planningContinuations) : 0,
  );
  const revisionCalls = planning?.revisionCalls
    ?? (recoveryTool?.status === 'completed' && plannerCalls > 1 ? 1 : 0);
  const planningMode = planning?.mode
    ?? (plannerCalls === 0
      ? 'deterministic_binding'
      : revisionCalls > 0 ? 'targeted_revision' : 'initial_planner');
  const executionAttempts = state.executionAttempts;
  return {
    ...receipt,
    version: 6,
    planning: {
      version: 1,
      mode: planningMode,
      plannerCalls,
      revisionCalls,
      verification,
    },
    // Candidate roles/labels are intentionally not persisted in the restart
    // projection. Empty is more truthful than rebuilding role counts from
    // raw member/requirement terms after a process restart.
    roleCoverage: [],
    cascade: {
      attempts: [],
      ...(state.resolvedPlan?.selectedTier ? { selectedTier: state.resolvedPlan.selectedTier } : {}),
      ...(state.resolvedPlan?.compiler && state.resolvedPlan.compiler !== 'none'
        ? { stopReason: `persisted_${state.resolvedPlan.compiler}_plan` }
        : {}),
      planFrozen,
    },
    connection: { attempted: false },
    execution: { attempts: executionAttempts },
    facts: { factCount: 0 },
    safeNextAction: receipt.summary.nextAction,
    story: [
      { stage: 'retrieval', status: state.workspace.snapshotId ? 'completed' : 'skipped', reasonCode: state.workspace.snapshotId ? 'persisted_snapshot' : 'snapshot_not_retained' },
      { stage: 'role_coverage', status: 'skipped', reasonCode: 'content_free_restart_projection' },
      {
        stage: 'planner',
        status: plannerTool?.status === 'failed' ? 'blocked' : plannerCalls > 0 ? 'completed' : 'skipped',
        reasonCode: plannerTool?.reasonCode ?? planningMode,
      },
      { stage: 'verification', status: verification.status === 'valid' ? 'completed' : 'blocked', reasonCode: verification.reasonCode },
      { stage: 'targeted_recovery', status: recoveryTool?.status === 'completed' ? 'completed' : 'skipped', reasonCode: recoveryTool?.reasonCode ?? 'not_required' },
      { stage: 'cascade', status: planFrozen ? 'completed' : state.phase === 'blocked' ? 'blocked' : 'skipped', reasonCode: state.resolvedPlan?.compiler ?? 'no_persisted_compiler' },
      { stage: 'freeze', status: planFrozen ? 'completed' : 'skipped', reasonCode: planFrozen ? 'persisted_plan_frozen' : 'no_persisted_plan' },
      { stage: 'connection', status: 'skipped', reasonCode: 'connection_boundary_not_retained_on_restart' },
      { stage: 'execution', status: executionAttempts > 0 ? 'blocked' : 'skipped', reasonCode: executionAttempts > 0 ? 'interrupted_after_execution_attempt' : 'execution_not_attempted' },
      { stage: 'facts', status: 'skipped', reasonCode: cancelled ? 'run_cancelled_before_final_facts' : 'run_interrupted_before_final_facts' },
    ],
  };
}

function interruptedDiagnosticState(state: AskAnalystState): AgentRunDiagnosticReceiptV5['state'] {
  return {
    version: 1,
    mode: state.mode,
    phase: state.phase,
    questionFingerprint: state.frame.questionFingerprint,
    kind: state.frame.kind,
    requirementCounts: {
      measures: state.frame.requirements.measures.length,
      dimensions: state.frame.requirements.dimensions.length,
      entityTerms: state.frame.requirements.entityTerms.length + state.frame.requirements.entityDisplayTerms.length,
      members: state.frame.requirements.memberTerms.length,
      filters: state.program.filters.length,
    },
    mission: {
      mode: state.mission.mode,
      taskCount: state.mission.tasks.length,
      deferredTaskCount: state.mission.deferredTasks?.length ?? 0,
      hypothesisCount: state.mission.hypotheses.length,
    },
    workspace: {
      ...(state.workspace.snapshotId ? { snapshotId: state.workspace.snapshotId } : {}),
      ...(state.workspace.sourceFingerprint ? { sourceFingerprint: state.workspace.sourceFingerprint } : {}),
      admittedCandidateCount: state.workspace.admittedCandidateIds.length,
      excludedCandidateCount: state.workspace.excludedCandidates.length,
      sourceCoverage: state.workspace.sourceCoverage.map((coverage) => ({
        source: coverage.source,
        status: coverage.status,
        candidateCount: coverage.candidateIds.length,
      })),
      tools: state.workspace.tools.map((tool) => ({
        id: tool.id,
        kind: tool.kind,
        status: tool.status,
        reasonCode: tool.reasonCode,
      })),
    },
    program: {
      id: state.program.id,
      taskCount: state.program.taskIds.length,
      candidateCount: state.program.candidateIds.length,
      requiredRoles: state.program.requiredRoles,
      outputAssertionCount: state.program.outputs.assertions.length,
    },
    ...(state.resolvedPlan ? { resolvedPlan: state.resolvedPlan } : {}),
    counters: {
      planningContinuations: state.planningContinuations,
      toolCalls: state.toolCalls,
      executionAttempts: state.executionAttempts,
      repairAttempts: state.repairAttempts,
    },
  };
}

export function defaultAgentRunSqlitePath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'local', 'agent-runs.sqlite');
}

function parseRun(payload: string): AgentRun | undefined {
  try {
    const value = JSON.parse(payload) as unknown;
    return isAgentRunRecord(value) ? normalizeRunProviderEgressReceipts(value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Durable run JSON is local and therefore untrusted on import/read. Keep an
 * invalid provider receipt from advertising historical row egress through the
 * primary run field, diagnostic receipt, or its diagnostic artifact payload.
 */
function normalizeRunProviderEgressReceipts(run: AgentRun): AgentRun {
  const normalizeReceiptList = (value: unknown) => Array.isArray(value)
    ? value.flatMap((receipt) => {
        const normalized = normalizeProviderEgressReceiptV1(receipt);
        return normalized ? [normalized] : [];
      })
    : undefined;
  const normalizeReceiptContainer = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    const providerEgressReceipts = normalizeReceiptList(record.providerEgressReceipts);
    return providerEgressReceipts === undefined
      ? value
      : { ...record, providerEgressReceipts };
  };
  const rootReceipts = normalizeReceiptList((run as unknown as Record<string, unknown>).providerEgressReceipts);
  const diagnosticReceipt = normalizeReceiptContainer((run as unknown as Record<string, unknown>).diagnosticReceipt);
  const artifacts = run.artifacts.map((artifact) => {
    if (!artifact.payload || typeof artifact.payload !== 'object' || Array.isArray(artifact.payload)) return artifact;
    const payload = artifact.payload as Record<string, unknown>;
    const normalizedDiagnosticReceipt = normalizeReceiptContainer(payload.diagnosticReceipt);
    return normalizedDiagnosticReceipt === payload.diagnosticReceipt
      ? artifact
      : { ...artifact, payload: { ...payload, diagnosticReceipt: normalizedDiagnosticReceipt } };
  });
  return {
    ...run,
    ...(rootReceipts === undefined ? {} : { providerEgressReceipts: rootReceipts }),
    ...(diagnosticReceipt === (run as unknown as Record<string, unknown>).diagnosticReceipt
      ? {}
      : { diagnosticReceipt: diagnosticReceipt as AgentRun['diagnosticReceipt'] }),
    artifacts,
  };
}

function parseProgress(payload: string): AgentRunProgressV1 | undefined {
  try {
    const value = JSON.parse(payload) as unknown;
    return isAgentRunProgressRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isAgentRunRecord(value: unknown): value is AgentRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.question === 'string'
    && typeof record.route === 'string'
    && typeof record.status === 'string'
    && typeof record.completedAt === 'string'
    && Array.isArray(record.events)
    && Array.isArray(record.artifacts)
    && Array.isArray(record.evaluations);
}

function isAgentRunProgressRecord(value: unknown): value is AgentRunProgressV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const lifecycle = record.lifecycle;
  return record.version === 1
    && typeof record.id === 'string'
    && typeof record.question === 'string'
    && Boolean(lifecycle && typeof lifecycle === 'object' && !Array.isArray(lifecycle))
    && (lifecycle as Record<string, unknown>).state !== 'terminal'
    && Array.isArray(record.events)
    && Array.isArray(record.artifacts)
    && Array.isArray(record.evaluations);
}
