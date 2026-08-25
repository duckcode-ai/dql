import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AskSpanIdV1,
  AskTraceDataV1,
  AskTraceEnvelopeV1,
  AskTraceExportReceiptV1,
  AskTraceListEntryV1,
  AskTraceListQueryV1,
  AskTraceListResponseV1,
  AskTraceRecordingStatusV1,
  AskTraceSpanV1,
  AskTraceStoreStatusV1,
  AskTraceTerminalOutcomeV1,
  CandidateDecisionV1,
  AskTraceLinkV1,
} from './types.js';
import { ASK_TRACE_SCHEMA_VERSION } from './types.js';
import { assertSafeTraceValue, durationMs, parseCursor, stableCursor } from './utils.js';

export const DEFAULT_ASK_TRACE_DETAIL_LIMIT = 500;
export const DEFAULT_ASK_TRACE_SUMMARY_LIMIT = 2_000;
export const DEFAULT_ASK_TRACE_DETAIL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_ASK_TRACE_SUMMARY_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1_000;
export const DEFAULT_ASK_TRACE_MAX_DB_BYTES = 256 * 1024 * 1024;
export const DEFAULT_ASK_TRACE_MAX_DETAIL_BYTES = 1 * 1024 * 1024;
export const DEFAULT_ASK_TRACE_MAX_SPANS = 512;
export const DEFAULT_ASK_TRACE_MAX_CANDIDATES = 1_024;
/**
 * Bounded producer limits. The observer enforces detail/candidate/span caps
 * synchronously so a rejected record cannot perturb Ask; adapters may use
 * these public bounds for their own batching without widening persistence.
 */
export const DEFAULT_ASK_TRACE_QUEUE_CAP = 4_096;
export const DEFAULT_ASK_TRACE_FLUSH_BATCH = 128;
export const DEFAULT_ASK_TRACE_FLUSH_INTERVAL_MS = 25;

export interface AskTraceStoreOptions {
  path: string;
  maxDetailedTraces?: number;
  maxSummaryTraces?: number;
  detailMaxAgeMs?: number;
  summaryMaxAgeMs?: number;
  maxDbBytes?: number;
  maxTraceDetailBytes?: number;
  maxSpansPerTrace?: number;
  maxCandidateDecisionsPerTrace?: number;
  queueCap?: number;
  flushBatchSize?: number;
  flushIntervalMs?: number;
  busyTimeoutMs?: number;
  /** Tests and CLIs use a read-only WAL observer without creating files. */
  readOnly?: boolean;
}

export interface AskTraceStoreWriteResult {
  accepted: boolean;
  dropped?: 'span_cap' | 'candidate_cap' | 'detail_cap' | 'store_cap' | 'queue_cap' | 'unsafe_payload' | 'unavailable';
}

type QueuedTraceWrite =
  | { kind: 'span'; key: string; value: AskTraceSpanV1; serialized: string }
  | { kind: 'candidate'; key: string; value: CandidateDecisionV1; serialized: string }
  | { kind: 'link'; key: string; value: AskTraceLinkV1; serialized: string };

/**
 * SQLite statement preparation is deliberately a store-lifecycle concern. The
 * trace producer may be called for every physical Ask boundary, so preparing
 * the same SQL once per span would turn observability into measurable routing
 * overhead even though the recorded data is unchanged.
 */
interface AskTracePreparedStatements {
  insertTrace: Database.Statement;
  /** The root is durable with begin(), not delayed behind the 25ms detail queue. */
  insertRootSpan: Database.Statement;
  updateTraceAccounting: Database.Statement;
  addDrops: Database.Statement;
  finalizeTrace: Database.Statement;
  insertExportReceipt: Database.Statement;
}

interface TraceQueueAccounting {
  /** New traces avoid read-before-write work on the Ask producer path. */
  loadedFromDatabase: boolean;
  spanCount: number;
  candidateDecisionCount: number;
  detailBytes: number;
  spanBytes: Map<string, number>;
  candidateBytes: Map<string, number>;
  linkBytes: number;
}

interface PendingTraceFinalization {
  envelope: AskTraceEnvelopeV1;
}

interface TraceRow {
  trace_id: string;
  root_span_id: string;
  run_id: string;
  surface: string;
  mode: string;
  thread_id: string | null;
  snapshot_id: string | null;
  question_fingerprint: string;
  status: string;
  recording_status: string;
  trust_state: string | null;
  selected_tier: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  first_issue_span_id: string | null;
  trace_fingerprint: string | null;
  span_count: number;
  candidate_decision_count: number;
  dropped_record_count: number;
  parent_trace_id: string | null;
  parent_run_id: string | null;
  detail_expired: number;
  detail_bytes: number;
  summary_json: string;
}

/**
 * Separate, local SQLite store.  Its failures are intentionally surfaced as a
 * status to the observer/API, never thrown into Ask execution.
 */
export class AskTraceSqliteStoreV1 {
  private db: Database.Database | undefined;
  private readonly options: Required<Omit<AskTraceStoreOptions, 'path' | 'readOnly'>> & Pick<AskTraceStoreOptions, 'path' | 'readOnly'>;
  private unavailableReason: AskTraceStoreStatusV1['reason'];
  private readonly queue: QueuedTraceWrite[] = [];
  private readonly queuedByKey = new Map<string, QueuedTraceWrite>();
  private readonly accounting = new Map<string, TraceQueueAccounting>();
  /** Drops waiting to be folded into the next local persistence transaction. */
  private readonly deferredDrops = new Map<string, number>();
  /** Lifetime drop counts remain available after a batch has persisted them. */
  private readonly droppedTotals = new Map<string, number>();
  /** Final receipts join their final detail batch in one SQLite transaction. */
  private readonly pendingFinalizations = new Map<string, PendingTraceFinalization>();
  /** Refreshed only at lifecycle/flush boundaries, never on an Ask producer call. */
  private databaseAtCap = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private prepared: AskTracePreparedStatements | undefined;
  /** Reused multi-row statements remove one native boundary per recorded span. */
  private readonly spanBatchStatements = new Map<number, Database.Statement>();
  private readonly candidateBatchStatements = new Map<number, Database.Statement>();
  private readonly linkBatchStatements = new Map<number, Database.Statement>();
  /** Cached at open/migration so observer creation does not issue a pragma. */
  private schemaVersion = 0;
  /** Completed persisted rows, refreshed after retention or at store open. */
  private detailedTraceCount = 0;
  private summaryTraceCount = 0;
  private readonly liveTraceIds = new Set<string>();
  /** Age retention is checked at lifecycle boundaries, not for every Ask. */
  private nextRetentionCheckAt = 0;

  constructor(options: AskTraceStoreOptions) {
    this.options = {
      path: options.path,
      readOnly: options.readOnly ?? false,
      maxDetailedTraces: options.maxDetailedTraces ?? DEFAULT_ASK_TRACE_DETAIL_LIMIT,
      maxSummaryTraces: options.maxSummaryTraces ?? DEFAULT_ASK_TRACE_SUMMARY_LIMIT,
      detailMaxAgeMs: options.detailMaxAgeMs ?? DEFAULT_ASK_TRACE_DETAIL_MAX_AGE_MS,
      summaryMaxAgeMs: options.summaryMaxAgeMs ?? DEFAULT_ASK_TRACE_SUMMARY_MAX_AGE_MS,
      maxDbBytes: options.maxDbBytes ?? DEFAULT_ASK_TRACE_MAX_DB_BYTES,
      maxTraceDetailBytes: options.maxTraceDetailBytes ?? DEFAULT_ASK_TRACE_MAX_DETAIL_BYTES,
      maxSpansPerTrace: options.maxSpansPerTrace ?? DEFAULT_ASK_TRACE_MAX_SPANS,
      maxCandidateDecisionsPerTrace: options.maxCandidateDecisionsPerTrace ?? DEFAULT_ASK_TRACE_MAX_CANDIDATES,
      queueCap: options.queueCap ?? DEFAULT_ASK_TRACE_QUEUE_CAP,
      flushBatchSize: options.flushBatchSize ?? DEFAULT_ASK_TRACE_FLUSH_BATCH,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_ASK_TRACE_FLUSH_INTERVAL_MS,
      busyTimeoutMs: options.busyTimeoutMs ?? 250,
    };
    this.open();
  }

  status(): AskTraceStoreStatusV1 {
    return {
      available: Boolean(this.db),
      schemaVersion: this.schemaVersion,
      recordingEnabled: Boolean(this.db) && !this.options.readOnly,
      ...(this.options.readOnly ? { readOnly: true } : {}),
      ...(this.unavailableReason ? { reason: this.unavailableReason } : {}),
    };
  }

  begin(envelope: AskTraceEnvelopeV1): AskTraceStoreWriteResult {
    if (!this.db || this.options.readOnly) return { accepted: false, dropped: 'unavailable' };
    try {
      if (this.databaseAtCap) return { accepted: false, dropped: 'store_cap' };
      assertSafeTraceValue({
        traceId: envelope.traceId,
        runId: envelope.runId,
        surface: envelope.surface,
        mode: envelope.mode,
        threadId: envelope.threadId,
        snapshotId: envelope.snapshotId,
        questionFingerprint: envelope.questionFingerprint,
      });
      // A running trace must have a portable root even if the process exits
      // before the ordinary 25ms queue gets its first chance to flush. The
      // observer immediately updates this same span with its live handle, but
      // this minimal root is committed atomically with trace admission.
      const durableEnvelope: AskTraceEnvelopeV1 = {
        ...envelope,
        spanCount: Math.max(1, envelope.spanCount),
      };
      const root = durableRootSpan(durableEnvelope);
      const rootPayload = storageJson(root.payload);
      const rootBytes = Buffer.byteLength(rootPayload, 'utf8') + 256;
      const inserted = this.db.transaction(() => {
        const insert = this.prepared!.insertTrace.run(
          durableEnvelope.traceId, durableEnvelope.rootSpanId, durableEnvelope.runId, durableEnvelope.surface, durableEnvelope.mode,
          durableEnvelope.threadId ?? null, durableEnvelope.snapshotId ?? null, durableEnvelope.questionFingerprint,
          durableEnvelope.status, durableEnvelope.recordingStatus, durableEnvelope.trustState ?? null,
          durableEnvelope.selectedTier ?? null, durableEnvelope.startedAt, durableEnvelope.parentTraceId ?? null,
          durableEnvelope.parentRunId ?? null, rootBytes, storageJson(durableEnvelope), durableEnvelope.startedAt,
        );
        if (insert.changes === 0) return false;
        this.prepared!.insertRootSpan.run(
          root.traceId, root.spanId, root.parentSpanId ?? null, root.ordinal, root.name, root.stage,
          root.startedAt, null, null, root.outcome, root.reasonCode, rootPayload,
        );
        return true;
      })();
      if (inserted) {
        this.liveTraceIds.add(envelope.traceId);
        this.accounting.set(envelope.traceId, {
          loadedFromDatabase: false,
          spanCount: 1,
          candidateDecisionCount: 0,
          detailBytes: rootBytes,
          spanBytes: new Map([[`span:${durableEnvelope.traceId}:${durableEnvelope.rootSpanId}`, rootBytes]]),
          candidateBytes: new Map(),
          linkBytes: 0,
        });
      } else {
        // A repeated begin (for example a harmless replay) must retain the
        // already-persisted accounting rather than resetting caps to zero.
        this.accounting.delete(envelope.traceId);
      }
      return { accepted: true };
    } catch {
      this.trip();
      return { accepted: false, dropped: 'unsafe_payload' };
    }
  }

  appendSpan(span: AskTraceSpanV1): AskTraceStoreWriteResult {
    if (!this.db || this.options.readOnly) return { accepted: false, dropped: 'unavailable' };
    try {
      const account = this.accountFor(span.traceId);
      if (!account) return { accepted: false, dropped: 'unavailable' };
      if (this.databaseAtCap) return this.drop(span.traceId, 'store_cap');
      const key = `span:${span.traceId}:${span.spanId}`;
      const queued = this.queuedByKey.get(key);
      if (!queued && this.queue.length >= this.options.queueCap) return this.drop(span.traceId, 'queue_cap');
      // A start/finish pair normally has one immutable typed payload. Its
      // first append stores a checked JSON snapshot; retaining that snapshot
      // for the queued finish avoids validating/serializing the same evidence
      // twice while preventing a later caller mutation from reaching SQLite.
      const reuseSerialized = queued?.kind === 'span' && queued.value.payload === span.payload;
      if (!reuseSerialized) assertSafeTraceValue(span.payload);
      const serialized = reuseSerialized ? queued.serialized : storageJson(span.payload);
      const bytes = Buffer.byteLength(serialized, 'utf8') + 256;
      const known = account.spanBytes.get(key);
      let previousBytes = known ?? 0;
      let incremented = false;
      if (known === undefined) {
        if (account.spanCount >= this.options.maxSpansPerTrace) return this.drop(span.traceId, 'span_cap');
        account.spanCount += 1;
        incremented = true;
        account.detailBytes += bytes - previousBytes;
      } else {
        account.detailBytes += bytes - known;
      }
      if (account.detailBytes > this.options.maxTraceDetailBytes) {
        account.detailBytes -= bytes - previousBytes;
        if (incremented) account.spanCount -= 1;
        return this.drop(span.traceId, 'detail_cap');
      }
      account.spanBytes.set(key, bytes);
      return this.enqueue({ kind: 'span', key, value: span, serialized }, span.traceId);
    } catch {
      // Unsafe input is rejected locally. It must not poison the unrelated
      // trace store or alter the Ask result.
      return { accepted: false, dropped: 'unsafe_payload' };
    }
  }

  appendCandidate(candidate: CandidateDecisionV1): AskTraceStoreWriteResult {
    if (!this.db || this.options.readOnly) return { accepted: false, dropped: 'unavailable' };
    try {
      assertSafeTraceValue(candidate);
      const account = this.accountFor(candidate.traceId);
      if (!account) return { accepted: false, dropped: 'unavailable' };
      if (this.databaseAtCap) return this.drop(candidate.traceId, 'store_cap');
      const key = `candidate:${candidate.traceId}:${candidate.sequence}`;
      if (!this.queuedByKey.has(key) && this.queue.length >= this.options.queueCap) return this.drop(candidate.traceId, 'queue_cap');
      const serialized = storageJson(candidate);
      const bytes = Buffer.byteLength(serialized, 'utf8') + 96;
      const known = account.candidateBytes.get(key);
      let previousBytes = known ?? 0;
      let incremented = false;
      if (known === undefined) {
        if (account.candidateDecisionCount >= this.options.maxCandidateDecisionsPerTrace) return this.drop(candidate.traceId, 'candidate_cap');
        account.candidateDecisionCount += 1;
        incremented = true;
        account.detailBytes += bytes - previousBytes;
      } else {
        account.detailBytes += bytes - known;
      }
      if (account.detailBytes > this.options.maxTraceDetailBytes) {
        account.detailBytes -= bytes - previousBytes;
        if (incremented) account.candidateDecisionCount -= 1;
        return this.drop(candidate.traceId, 'detail_cap');
      }
      account.candidateBytes.set(key, bytes);
      return this.enqueue({ kind: 'candidate', key, value: candidate, serialized }, candidate.traceId);
    } catch {
      return { accepted: false, dropped: 'unsafe_payload' };
    }
  }

  appendLink(link: AskTraceLinkV1): AskTraceStoreWriteResult {
    if (!this.db || this.options.readOnly) return { accepted: false, dropped: 'unavailable' };
    try {
      assertSafeTraceValue(link);
      const traceId = link.sourceTraceId;
      const account = this.accountFor(traceId);
      if (!account) return { accepted: false, dropped: 'unavailable' };
      const key = `link:${traceId}:${link.createdAt}:${this.queue.length}`;
      if (this.queue.length >= this.options.queueCap) return this.drop(traceId, 'queue_cap');
      const serialized = storageJson(link);
      const bytes = Buffer.byteLength(serialized, 'utf8') + 96;
      if (account.detailBytes + bytes > this.options.maxTraceDetailBytes) return this.drop(traceId, 'detail_cap');
      account.detailBytes += bytes;
      account.linkBytes += bytes;
      return this.enqueue({ kind: 'link', key, value: link, serialized }, traceId);
    } catch {
      return { accepted: false, dropped: 'unsafe_payload' };
    }
  }

  finalize(envelope: AskTraceEnvelopeV1): AskTraceStoreWriteResult {
    if (!this.db || this.options.readOnly) return { accepted: false, dropped: 'unavailable' };
    try {
      assertSafeTraceValue({
        status: envelope.status,
        terminalOutcome: envelope.terminalOutcome,
        recordingStatus: envelope.recordingStatus,
        trustState: envelope.trustState,
        selectedTier: envelope.selectedTier,
        traceFingerprint: envelope.traceFingerprint,
      });
      const completedAt = envelope.completedAt ?? new Date().toISOString();
      // Do not flush detail and then issue a second autocommit UPDATE for the
      // same Ask. A final receipt joins its last bounded detail batch in one
      // transaction. This preserves the contract that finalization durably
      // persists every accepted record before returning, while avoiding a
      // redundant WAL/fsync boundary on the normal short Ask path.
      this.pendingFinalizations.set(envelope.traceId, {
        envelope: { ...envelope, completedAt },
      });
      this.flushNow();
      const accepted = Boolean(this.db) && !this.pendingFinalizations.has(envelope.traceId);
      if (accepted) this.maybeEnforceRetention();
      return accepted ? { accepted: true } : { accepted: false, dropped: 'unavailable' };
    } catch {
      this.trip();
      return { accepted: false, dropped: 'unavailable' };
    }
  }

  markPartial(traceId: string, extraDropped = 1): void {
    if (!this.db || this.options.readOnly) return;
    this.recordDrop(traceId, Math.max(1, extraDropped));
  }

  get(traceId: string): AskTraceDataV1 | undefined {
    if (!this.db) return undefined;
    this.flushNow();
    const row = this.db.prepare('SELECT * FROM ask_traces WHERE trace_id = ?').get(traceId) as TraceRow | undefined;
    return row ? this.dataForRow(row) : undefined;
  }

  getByRun(runId: string): AskTraceDataV1 | undefined {
    if (!this.db) return undefined;
    this.flushNow();
    const row = this.db.prepare('SELECT * FROM ask_traces WHERE run_id = ?').get(runId) as TraceRow | undefined;
    return row ? this.dataForRow(row) : undefined;
  }

  list(input: AskTraceListQueryV1 = {}): AskTraceListResponseV1 {
    if (!this.db) return { traces: [] };
    this.flushNow();
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
    const cursor = parseCursor(input.cursor);
    const filterConditions: string[] = [];
    const filterParameters: unknown[] = [];
    if (input.status) {
      filterConditions.push('status = ?');
      filterParameters.push(input.status);
    }
    if (input.mode) {
      filterConditions.push('mode = ?');
      filterParameters.push(input.mode);
    }
    if (input.trustState) {
      filterConditions.push('trust_state = ?');
      filterParameters.push(input.trustState);
    }
    if (input.selectedTier) {
      filterConditions.push('selected_tier = ?');
      filterParameters.push(input.selectedTier);
    }
    if (input.surface) {
      filterConditions.push('surface = ?');
      filterParameters.push(input.surface);
    }
    if (input.recordingStatus) {
      filterConditions.push('recording_status = ?');
      filterParameters.push(input.recordingStatus);
    }
    const conditions = [...filterConditions];
    const parameters = [...filterParameters];
    if (cursor) {
      conditions.push('(started_at < ? OR (started_at = ? AND trace_id < ?))');
      parameters.push(cursor.startedAt, cursor.startedAt, cursor.traceId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT * FROM ask_traces ${where}
      ORDER BY started_at DESC, trace_id DESC LIMIT ?
    `).all(...parameters, limit + 1) as TraceRow[];
    const filterWhere = filterConditions.length ? `WHERE ${filterConditions.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM ask_traces ${filterWhere}`)
      .get(...filterParameters) as { count?: number } | undefined;
    const page = rows.slice(0, limit).map((row) => this.summaryForRow(row));
    const last = page.at(-1);
    return {
      traces: page,
      total: Math.max(0, Number(total?.count ?? 0)),
      ...(rows.length > limit && last ? { nextCursor: stableCursor({ startedAt: last.startedAt, traceId: last.traceId }) } : {}),
    };
  }

  recordExportReceipt(traceId: string, receipt: AskTraceExportReceiptV1): void {
    if (!this.db || this.options.readOnly) return;
    try {
      this.prepared!.insertExportReceipt.run(
        traceId, receipt.bundleFingerprint, receipt.profile, receipt.exportedAt, storageJson(receipt),
      );
    } catch {
      this.trip();
    }
  }

  /** Number of writes waiting for the bounded local persistence batch. */
  pendingWriteCount(): number {
    return this.queue.length + this.pendingFinalizations.size;
  }

  /** Deferred drops are folded into the final compact trace receipt. */
  droppedRecordCount(traceId: string): number {
    return this.droppedTotals.get(traceId) ?? 0;
  }

  /**
   * Flush queued trace detail synchronously at a lifecycle/read boundary. Ask
   * event production itself remains batched by `enqueue`; this method exists so
   * a finalized run, CLI inspection, or shutdown never leaves a half-written
   * local receipt behind.
   */
  flushNow(): void {
    if (!this.db || this.options.readOnly) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    while ((this.queue.length > 0 || this.deferredDrops.size > 0 || this.pendingFinalizations.size > 0) && this.db) this.flushBatch();
  }

  close(): void {
    this.flushNow();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    try { this.db?.close(); } catch { /* local trace shutdown is best effort */ }
    this.db = undefined;
    this.prepared = undefined;
    this.spanBatchStatements.clear();
    this.candidateBatchStatements.clear();
    this.linkBatchStatements.clear();
    this.pendingFinalizations.clear();
    this.schemaVersion = 0;
  }

  private accountFor(traceId: string): TraceQueueAccounting | undefined {
    // Observers only append to a trace they began in this process. Restarted
    // recording traces are finalized during open(), so producer calls never
    // synchronously query SQLite just to recover counters.
    return this.accounting.get(traceId);
  }

  private enqueue(write: QueuedTraceWrite, traceId: string): AskTraceStoreWriteResult {
    const existing = this.queuedByKey.get(write.key);
    if (existing) {
      // Span start -> finish and a repeated candidate decision coalesce into
      // the newest typed state before SQLite sees them. This bounds writes
      // without dropping the final physical outcome.
      if (existing.kind === 'span' && write.kind === 'span') {
        existing.value = write.value;
        existing.serialized = write.serialized;
        return { accepted: true };
      }
      if (existing.kind === 'candidate' && write.kind === 'candidate') {
        existing.value = write.value;
        existing.serialized = write.serialized;
        return { accepted: true };
      }
      if (existing.kind === 'link' && write.kind === 'link') {
        existing.value = write.value;
        existing.serialized = write.serialized;
        return { accepted: true };
      }
    }
    if (this.queue.length >= this.options.queueCap) return this.drop(traceId, 'queue_cap');
    this.queue.push(write);
    this.queuedByKey.set(write.key, write);
    this.scheduleFlush();
    return { accepted: true };
  }

  /** Finalization may only join a batch after every earlier trace record is in it. */
  private hasQueuedWriteForTrace(traceId: string): boolean {
    return this.queue.some((item) => (
      item.kind === 'span'
        ? item.value.traceId === traceId
        : item.kind === 'candidate'
          ? item.value.traceId === traceId
          : item.value.sourceTraceId === traceId
    ));
  }

  private scheduleFlush(): void {
    if (!this.db || this.options.readOnly || this.flushTimer) return;
    const flush = () => {
      this.flushTimer = undefined;
      this.flushBatch();
      if (this.queue.length > 0 || this.deferredDrops.size > 0 || this.pendingFinalizations.size > 0) this.scheduleFlush();
    };
    // Large bursts flush as soon as the event loop yields; ordinary Ask traces
    // wait up to the documented 25ms coalescing window. Both paths retain the
    // bounded transaction size and never block a trace producer synchronously.
    if (this.queue.length >= this.options.flushBatchSize) {
      this.flushTimer = setTimeout(flush, 0);
      return;
    }
    this.flushTimer = setTimeout(flush, this.options.flushIntervalMs);
  }

  private flushBatch(): void {
    if (!this.db || this.options.readOnly || (this.queue.length === 0 && this.deferredDrops.size === 0 && this.pendingFinalizations.size === 0)) return;
    const batch = this.queue.splice(0, this.options.flushBatchSize);
    for (const item of batch) this.queuedByKey.delete(item.key);
    const drops = [...this.deferredDrops.entries()];
    const finalizations = [...this.pendingFinalizations.entries()].filter(([traceId]) => !this.hasQueuedWriteForTrace(traceId));
    try {
      const finalizationTraceIds = new Set(finalizations.map(([traceId]) => traceId));
      this.db.transaction(() => {
        const touchedTraceIds = new Set<string>();
        const spans: Array<Extract<QueuedTraceWrite, { kind: 'span' }>> = [];
        const candidates: Array<Extract<QueuedTraceWrite, { kind: 'candidate' }>> = [];
        const links: Array<Extract<QueuedTraceWrite, { kind: 'link' }>> = [];
        for (const item of batch) {
          if (item.kind === 'span') {
            spans.push(item);
            touchedTraceIds.add(item.value.traceId);
          } else if (item.kind === 'candidate') {
            candidates.push(item);
            touchedTraceIds.add(item.value.traceId);
          } else {
            links.push(item);
            touchedTraceIds.add(item.value.sourceTraceId);
          }
        }
        // Every accepted item still reaches SQLite in this transaction. Grouping
        // only removes repeated JS/native call overhead; it never samples,
        // collapses distinct spans, or defers finalization persistence.
        this.writeSpanBatch(spans);
        this.writeCandidateBatch(candidates);
        this.writeLinkBatch(links);
        const updatedAt = new Date().toISOString();
        for (const [traceId, count] of drops) {
          this.prepared!.addDrops.run(count, updatedAt, traceId);
          touchedTraceIds.add(traceId);
        }
        for (const traceId of touchedTraceIds) {
          // A final receipt writes these same counters atomically below. Do
          // not issue an immediately superseded SQLite UPDATE for every Ask.
          if (finalizationTraceIds.has(traceId)) continue;
          const account = this.accountFor(traceId);
          if (!account) continue;
          this.prepared!.updateTraceAccounting.run(
            account.spanCount, account.candidateDecisionCount, account.detailBytes, updatedAt, traceId,
          );
        }
        for (const [traceId, pending] of finalizations) {
          const detail = this.accountFor(traceId);
          const envelope = pending.envelope;
          const dropped = Math.max(envelope.droppedRecordCount, this.droppedRecordCount(traceId));
          const recordingStatus = dropped > 0 ? 'partial' : envelope.recordingStatus;
          const completedAt = envelope.completedAt ?? updatedAt;
          const persistedEnvelope: AskTraceEnvelopeV1 = {
            ...envelope,
            completedAt,
            recordingStatus,
            spanCount: detail?.spanCount ?? envelope.spanCount,
            candidateDecisionCount: detail?.candidateDecisionCount ?? envelope.candidateDecisionCount,
            droppedRecordCount: dropped,
          };
          // The producer owns authoritative in-process counters. Avoid a
          // read-back SELECT after every Ask merely to rediscover counts just
          // flushed from the bounded queue. A restarted trace never reaches
          // this method because startup marks it interrupted before a new
          // observer is admitted.
          this.prepared!.finalizeTrace.run(
            persistedEnvelope.status, persistedEnvelope.recordingStatus,
            persistedEnvelope.trustState ?? null, persistedEnvelope.selectedTier ?? null,
            completedAt, persistedEnvelope.durationMs ?? durationMs(persistedEnvelope.startedAt, completedAt),
            persistedEnvelope.firstIssueSpanId ?? null, persistedEnvelope.traceFingerprint ?? null,
            persistedEnvelope.spanCount, persistedEnvelope.candidateDecisionCount,
            persistedEnvelope.droppedRecordCount, detail?.detailBytes ?? 0,
            storageJson(persistedEnvelope), updatedAt, traceId,
          );
        }
      })();
      for (const [traceId, count] of drops) {
        const pending = this.deferredDrops.get(traceId) ?? 0;
        if (pending <= count) this.deferredDrops.delete(traceId);
        else this.deferredDrops.set(traceId, pending - count);
      }
      for (const [traceId] of finalizations) {
        this.pendingFinalizations.delete(traceId);
        if (this.liveTraceIds.delete(traceId)) {
          this.detailedTraceCount += 1;
          this.summaryTraceCount += 1;
        }
      }
      // File-system capacity checks are intentionally not part of the hot
      // producer/finalization path. Retention/open and a near-cap condition
      // refresh the cached state before a later trace is admitted.
    } catch {
      for (const item of batch) {
        const traceId = item.kind === 'span' ? item.value.traceId : item.kind === 'candidate' ? item.value.traceId : item.value.sourceTraceId;
        this.recordDrop(traceId);
      }
      this.trip();
    }
  }

  private writeSpanBatch(items: Array<Extract<QueuedTraceWrite, { kind: 'span' }>>): void {
    for (const rows of batches(items, 64)) {
      const statement = this.batchStatement(this.spanBatchStatements, rows.length, 12, `
        INSERT OR REPLACE INTO ask_spans (
          trace_id, span_id, parent_span_id, ordinal, name, stage, started_at, completed_at,
          duration_ms, outcome, reason_code, payload_json
        ) VALUES
      `);
      const values: unknown[] = [];
      for (const { value: span, serialized } of rows) {
        values.push(
          span.traceId, span.spanId, span.parentSpanId ?? null, span.ordinal, span.name, span.stage,
          span.startedAt, span.completedAt ?? null, span.durationMs ?? null, span.outcome, span.reasonCode, serialized,
        );
      }
      statement.run(...values);
    }
  }

  private writeCandidateBatch(items: Array<Extract<QueuedTraceWrite, { kind: 'candidate' }>>): void {
    for (const rows of batches(items, 64)) {
      const statement = this.batchStatement(this.candidateBatchStatements, rows.length, 14, `
        INSERT OR REPLACE INTO ask_candidate_decisions (
          trace_id, sequence, candidate_id, display_label, role, source, lane, lane_rank,
          fused_rank, reciprocal_rank_score, decision, reason_code, compatibility_code, payload_json
        ) VALUES
      `);
      const values: unknown[] = [];
      for (const { value: candidate, serialized } of rows) {
        values.push(
          candidate.traceId, candidate.sequence, candidate.candidateId, null,
          candidate.role, candidate.source, candidate.lane ?? null, candidate.laneRank ?? null,
          candidate.fusedRank ?? null, candidate.reciprocalRankScore ?? null, candidate.decision,
          candidate.reasonCode, candidate.compatibilityCode ?? null, serialized,
        );
      }
      statement.run(...values);
    }
  }

  private writeLinkBatch(items: Array<Extract<QueuedTraceWrite, { kind: 'link' }>>): void {
    for (const rows of batches(items, 64)) {
      const statement = this.batchStatement(this.linkBatchStatements, rows.length, 10, `
        INSERT INTO ask_trace_links (
          source_trace_id, source_run_id, target_trace_id, target_run_id, kind,
          hypothesis_fingerprint, choice_fingerprint, verdict_fingerprint, created_at, payload_json
        ) VALUES
      `);
      const values: unknown[] = [];
      for (const { value: link, serialized } of rows) {
        values.push(
          link.sourceTraceId, link.sourceRunId, link.targetTraceId ?? null, link.targetRunId ?? null,
          link.kind, link.hypothesisFingerprint ?? null, link.choiceFingerprint ?? null,
          link.verdictFingerprint ?? null, link.createdAt, serialized,
        );
      }
      statement.run(...values);
    }
  }

  private batchStatement(
    cache: Map<number, Database.Statement>,
    rowCount: number,
    columnCount: number,
    prefix: string,
  ): Database.Statement {
    const cached = cache.get(rowCount);
    if (cached) return cached;
    const placeholders = `(${Array.from({ length: columnCount }, () => '?').join(', ')})`;
    const statement = this.db!.prepare(`${prefix} ${Array.from({ length: rowCount }, () => placeholders).join(', ')}`);
    cache.set(rowCount, statement);
    return statement;
  }

  private open(): void {
    if (this.options.readOnly && !existsSync(this.options.path)) {
      this.unavailableReason = 'store_error';
      return;
    }
    try {
      if (!this.options.readOnly) mkdirSync(dirname(this.options.path), { recursive: true });
      this.db = new Database(this.options.path, this.options.readOnly ? { readonly: true, fileMustExist: true } : undefined);
      this.db.pragma('busy_timeout = ' + Math.max(25, Math.min(5_000, this.options.busyTimeoutMs)));
      const existing = Number(this.db.pragma('user_version', { simple: true }) ?? 0);
      // A CLI/read-only observer must not deserialize a newer trace schema
      // optimistically. Leave it untouched and report a typed compatibility
      // state rather than trying to migrate or infer fields.
      if (existing > ASK_TRACE_SCHEMA_VERSION) {
        this.db.close();
        this.db = undefined;
        this.unavailableReason = 'unsupported_schema';
        return;
      }
      if (!this.options.readOnly) {
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');
        this.migrate(existing);
        this.finalizeInterrupted();
        this.enforceRetention();
        this.refreshCapacityState();
      }
      this.schemaVersion = this.options.readOnly ? existing : ASK_TRACE_SCHEMA_VERSION;
      this.prepareStatements();
      this.refreshRetentionCounts();
      // Store open already performed the age/cap sweep. Avoid repeating the
      // same synchronous retention SQL for the first ordinary Ask.
      this.nextRetentionCheckAt = Date.now() + 60_000;
    } catch {
      this.close();
      if (!this.options.readOnly && existsSync(this.options.path)) {
        try {
          renameSync(this.options.path, `${this.options.path}.corrupt.${Date.now()}`);
          this.db = new Database(this.options.path);
          this.db.pragma('journal_mode = WAL');
          this.db.pragma('synchronous = NORMAL');
          this.db.pragma('foreign_keys = ON');
          this.migrate(0);
          this.refreshCapacityState();
          this.schemaVersion = ASK_TRACE_SCHEMA_VERSION;
          this.prepareStatements();
          this.refreshRetentionCounts();
          this.nextRetentionCheckAt = Date.now() + 60_000;
          return;
        } catch {
          this.close();
        }
      }
      this.unavailableReason = 'store_error';
    }
  }

  private migrate(existing: number): void {
    if (!this.db || existing >= ASK_TRACE_SCHEMA_VERSION) return;
    this.db.transaction(() => {
      this.db!.exec(`
        CREATE TABLE IF NOT EXISTS ask_traces (
          trace_id TEXT PRIMARY KEY,
          root_span_id TEXT NOT NULL,
          run_id TEXT NOT NULL UNIQUE,
          surface TEXT NOT NULL,
          mode TEXT NOT NULL,
          thread_id TEXT,
          snapshot_id TEXT,
          question_fingerprint TEXT NOT NULL,
          status TEXT NOT NULL,
          recording_status TEXT NOT NULL,
          trust_state TEXT,
          selected_tier TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          duration_ms INTEGER,
          first_issue_span_id TEXT,
          trace_fingerprint TEXT,
          span_count INTEGER NOT NULL DEFAULT 0,
          candidate_decision_count INTEGER NOT NULL DEFAULT 0,
          dropped_record_count INTEGER NOT NULL DEFAULT 0,
          parent_trace_id TEXT,
          parent_run_id TEXT,
          detail_expired INTEGER NOT NULL DEFAULT 0,
          detail_bytes INTEGER NOT NULL DEFAULT 0,
          summary_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ask_spans (
          trace_id TEXT NOT NULL REFERENCES ask_traces(trace_id) ON DELETE CASCADE,
          span_id TEXT NOT NULL,
          parent_span_id TEXT,
          ordinal INTEGER NOT NULL,
          name TEXT NOT NULL,
          stage TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          duration_ms INTEGER,
          outcome TEXT NOT NULL,
          reason_code TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (trace_id, span_id)
        );
        CREATE TABLE IF NOT EXISTS ask_span_events (
          trace_id TEXT NOT NULL REFERENCES ask_traces(trace_id) ON DELETE CASCADE,
          span_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          at TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (trace_id, span_id, sequence)
        );
        CREATE TABLE IF NOT EXISTS ask_candidate_decisions (
          trace_id TEXT NOT NULL REFERENCES ask_traces(trace_id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          candidate_id TEXT NOT NULL,
          display_label TEXT,
          role TEXT NOT NULL,
          source TEXT NOT NULL,
          lane TEXT,
          lane_rank INTEGER,
          fused_rank INTEGER,
          reciprocal_rank_score REAL,
          decision TEXT NOT NULL,
          reason_code TEXT NOT NULL,
          compatibility_code TEXT,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (trace_id, sequence)
        );
        CREATE TABLE IF NOT EXISTS ask_trace_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_trace_id TEXT NOT NULL,
          source_run_id TEXT NOT NULL,
          target_trace_id TEXT,
          target_run_id TEXT,
          kind TEXT NOT NULL,
          hypothesis_fingerprint TEXT,
          choice_fingerprint TEXT,
          verdict_fingerprint TEXT,
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ask_export_receipts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trace_id TEXT NOT NULL REFERENCES ask_traces(trace_id) ON DELETE CASCADE,
          bundle_fingerprint TEXT NOT NULL,
          profile TEXT NOT NULL,
          exported_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ask_traces_started ON ask_traces(started_at DESC, trace_id);
        CREATE INDEX IF NOT EXISTS idx_ask_traces_thread ON ask_traces(thread_id);
        CREATE INDEX IF NOT EXISTS idx_ask_traces_snapshot ON ask_traces(snapshot_id);
        CREATE INDEX IF NOT EXISTS idx_ask_traces_parent ON ask_traces(parent_trace_id);
        CREATE INDEX IF NOT EXISTS idx_ask_spans_name_outcome ON ask_spans(name, outcome);
        CREATE INDEX IF NOT EXISTS idx_ask_candidates_identity ON ask_candidate_decisions(candidate_id, role, reason_code);
        CREATE INDEX IF NOT EXISTS idx_ask_links_source_target ON ask_trace_links(source_trace_id, target_trace_id);
      `);
      this.db!.pragma(`user_version = ${ASK_TRACE_SCHEMA_VERSION}`);
    })();
  }

  private prepareStatements(): void {
    if (!this.db || this.options.readOnly) return;
    this.prepared = {
      insertTrace: this.db.prepare(`
        INSERT INTO ask_traces (
          trace_id, root_span_id, run_id, surface, mode, thread_id, snapshot_id,
          question_fingerprint, status, recording_status, trust_state, selected_tier,
          started_at, completed_at, duration_ms, first_issue_span_id, trace_fingerprint,
          span_count, candidate_decision_count, dropped_record_count, parent_trace_id,
          parent_run_id, detail_expired, detail_bytes, summary_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 1, 0, 0, ?, ?, 0, ?, ?, ?)
        ON CONFLICT(trace_id) DO NOTHING
      `),
      insertRootSpan: this.db.prepare(`
        INSERT INTO ask_spans (
          trace_id, span_id, parent_span_id, ordinal, name, stage, started_at, completed_at,
          duration_ms, outcome, reason_code, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(trace_id, span_id) DO NOTHING
      `),
      updateTraceAccounting: this.db.prepare(`
        UPDATE ask_traces
        SET span_count = ?, candidate_decision_count = ?, detail_bytes = ?, updated_at = ?
        WHERE trace_id = ?
      `),
      addDrops: this.db.prepare(`
        UPDATE ask_traces
        SET recording_status = 'partial', dropped_record_count = dropped_record_count + ?, updated_at = ?
        WHERE trace_id = ?
      `),
      finalizeTrace: this.db.prepare(`
        UPDATE ask_traces SET
          status = ?, recording_status = ?, trust_state = ?, selected_tier = ?, completed_at = ?,
          duration_ms = ?, first_issue_span_id = ?, trace_fingerprint = ?, span_count = ?,
          candidate_decision_count = ?, dropped_record_count = ?, detail_bytes = ?, summary_json = ?, updated_at = ?
        WHERE trace_id = ?
      `),
      insertExportReceipt: this.db.prepare(`
        INSERT INTO ask_export_receipts (trace_id, bundle_fingerprint, profile, exported_at, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `),
    };
  }

  private refreshRetentionCounts(): void {
    if (!this.db) return;
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) AS summary_count,
        SUM(CASE WHEN detail_expired = 0 THEN 1 ELSE 0 END) AS detail_count
      FROM ask_traces
    `).get() as { summary_count?: number; detail_count?: number } | undefined;
    this.summaryTraceCount = Number(counts?.summary_count ?? 0);
    this.detailedTraceCount = Number(counts?.detail_count ?? 0);
  }

  private maybeEnforceRetention(): void {
    if (!this.db || this.options.readOnly) return;
    const now = Date.now();
    if (
      this.detailedTraceCount > this.options.maxDetailedTraces
      || this.summaryTraceCount > this.options.maxSummaryTraces
      || now >= this.nextRetentionCheckAt
    ) {
      this.enforceRetention();
      this.nextRetentionCheckAt = now + 60_000;
    }
  }

  private drop(traceId: string, dropped: NonNullable<AskTraceStoreWriteResult['dropped']>): AskTraceStoreWriteResult {
    this.recordDrop(traceId);
    return { accepted: false, dropped };
  }

  /**
   * Keep producer-side loss accounting entirely in memory. The next bounded
   * batch marks the trace partial; no synchronous UPDATE is issued from an
   * Ask/tool/provider callback.
   */
  private recordDrop(traceId: string, count = 1): void {
    this.deferredDrops.set(traceId, (this.deferredDrops.get(traceId) ?? 0) + count);
    this.droppedTotals.set(traceId, (this.droppedTotals.get(traceId) ?? 0) + count);
    this.scheduleFlush();
  }

  private summaryForRow(row: TraceRow): AskTraceListEntryV1 {
    const envelope = this.envelopeForRow(row);
    return { ...envelope, detailAvailable: row.detail_expired === 0 };
  }

  private envelopeForRow(row: TraceRow): AskTraceEnvelopeV1 {
    // The V1 table has no terminal-outcome column. It is a safe, additive
    // field in the already persisted summary envelope, so read it defensively
    // without a schema migration and leave older rows unchanged.
    const terminalOutcome = terminalOutcomeFromSummary(row.summary_json);
    return {
      version: 1,
      traceId: row.trace_id,
      rootSpanId: row.root_span_id,
      runId: row.run_id,
      surface: row.surface as AskTraceEnvelopeV1['surface'],
      mode: row.mode as AskTraceEnvelopeV1['mode'],
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(row.snapshot_id ? { snapshotId: row.snapshot_id } : {}),
      questionFingerprint: row.question_fingerprint,
      status: row.status as AskTraceEnvelopeV1['status'],
      ...(terminalOutcome ? { terminalOutcome } : {}),
      recordingStatus: (row.detail_expired ? 'detail_expired' : row.recording_status) as AskTraceRecordingStatusV1,
      ...(row.trust_state ? { trustState: row.trust_state } : {}),
      ...(row.selected_tier ? { selectedTier: row.selected_tier as AskTraceEnvelopeV1['selectedTier'] } : {}),
      startedAt: row.started_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
      ...(row.first_issue_span_id ? { firstIssueSpanId: row.first_issue_span_id as AskSpanIdV1 } : {}),
      ...(row.trace_fingerprint ? { traceFingerprint: row.trace_fingerprint } : {}),
      spanCount: row.span_count,
      candidateDecisionCount: row.candidate_decision_count,
      droppedRecordCount: row.dropped_record_count,
      ...(row.parent_trace_id ? { parentTraceId: row.parent_trace_id } : {}),
      ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    };
  }

  private dataForRow(row: TraceRow): AskTraceDataV1 {
    const envelope = this.envelopeForRow(row);
    if (row.detail_expired) return { envelope, spans: [], candidateDecisions: [], links: [] };
    const spans = (this.db?.prepare(`
      SELECT * FROM ask_spans WHERE trace_id = ? ORDER BY ordinal ASC, span_id ASC
    `).all(row.trace_id) ?? []).map((span) => this.spanForRow(span as Record<string, unknown>, row.trace_id));
    const candidates = (this.db?.prepare(`
      SELECT payload_json FROM ask_candidate_decisions WHERE trace_id = ? ORDER BY sequence ASC
    `).all(row.trace_id) ?? []).flatMap((entry) => {
      const parsed = parseJson((entry as { payload_json: string }).payload_json);
      return parsed ? [parsed as CandidateDecisionV1] : [];
    });
    const links = (this.db?.prepare(`
      SELECT payload_json FROM ask_trace_links WHERE source_trace_id = ? OR target_trace_id = ? ORDER BY id ASC
    `).all(row.trace_id, row.trace_id) ?? []).flatMap((entry) => {
      const parsed = parseJson((entry as { payload_json: string }).payload_json);
      return parsed ? [parsed as AskTraceLinkV1] : [];
    });
    return { envelope, spans, candidateDecisions: candidates, links };
  }

  private spanForRow(row: Record<string, unknown>, traceId: string): AskTraceSpanV1 {
    return {
      version: 1,
      traceId,
      spanId: String(row.span_id),
      ...(typeof row.parent_span_id === 'string' ? { parentSpanId: row.parent_span_id } : {}),
      ordinal: Number(row.ordinal),
      name: row.name as AskTraceSpanV1['name'],
      stage: row.stage as AskTraceSpanV1['stage'],
      startedAt: String(row.started_at),
      ...(typeof row.completed_at === 'string' ? { completedAt: row.completed_at } : {}),
      ...(typeof row.duration_ms === 'number' ? { durationMs: row.duration_ms } : {}),
      outcome: row.outcome as AskTraceSpanV1['outcome'],
      reasonCode: row.reason_code as AskTraceSpanV1['reasonCode'],
      payload: parseJson(String(row.payload_json)) as AskTraceSpanV1['payload'],
    };
  }

  private finalizeInterrupted(): void {
    if (!this.db || this.options.readOnly) return;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const open = this.db!.prepare(`SELECT trace_id, started_at FROM ask_traces WHERE status = 'running'`).all() as Array<{ trace_id: string; started_at: string }>;
      for (const trace of open) {
        this.db!.prepare(`
          UPDATE ask_spans SET completed_at = ?, duration_ms = MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)), outcome = 'interrupted', reason_code = 'interrupted'
          WHERE trace_id = ? AND completed_at IS NULL
        `).run(now, now, trace.trace_id);
        this.db!.prepare(`
          UPDATE ask_traces SET status = 'interrupted', recording_status = CASE WHEN recording_status = 'recording' THEN 'partial' ELSE recording_status END,
          completed_at = ?, duration_ms = MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)), updated_at = ?
          WHERE trace_id = ?
        `).run(now, now, now, trace.trace_id);
      }
    })();
  }

  private enforceRetention(): void {
    if (!this.db || this.options.readOnly) return;
    try {
      const now = Date.now();
      const detailCutoff = new Date(now - this.options.detailMaxAgeMs).toISOString();
      const summaryCutoff = new Date(now - this.options.summaryMaxAgeMs).toISOString();
      // Detailed evidence expires independently: summaries remain inspectable.
      const expired = this.db.prepare(`
        SELECT trace_id FROM ask_traces WHERE detail_expired = 0 AND started_at < ?
        UNION
        SELECT trace_id FROM ask_traces WHERE detail_expired = 0 AND trace_id NOT IN (
          SELECT trace_id FROM ask_traces ORDER BY started_at DESC, trace_id DESC LIMIT ?
        )
      `).all(detailCutoff, this.options.maxDetailedTraces) as Array<{ trace_id: string }>;
      const expire = this.db.transaction((traceIds: string[]) => {
        for (const traceId of traceIds) {
          this.db!.prepare('DELETE FROM ask_spans WHERE trace_id = ?').run(traceId);
          this.db!.prepare('DELETE FROM ask_span_events WHERE trace_id = ?').run(traceId);
          this.db!.prepare('DELETE FROM ask_candidate_decisions WHERE trace_id = ?').run(traceId);
          // Research and continuation links are durable relationship evidence.
          // Detail expiry must not sever them merely because spans aged out.
          this.db!.prepare(`UPDATE ask_traces SET detail_expired = 1, recording_status = 'detail_expired', detail_bytes = 0 WHERE trace_id = ?`).run(traceId);
        }
      });
      expire(expired.map((row) => row.trace_id));
      this.db.prepare(`
        DELETE FROM ask_traces WHERE started_at < ? OR trace_id NOT IN (
          SELECT trace_id FROM ask_traces ORDER BY started_at DESC, trace_id DESC LIMIT ?
        )
      `).run(summaryCutoff, this.options.maxSummaryTraces);
      // Once both sides have left summary retention there is no addressable
      // trace left to inspect. Remove only truly orphaned links, preserving a
      // relationship whenever either source or target summary remains.
      this.db.prepare(`
        DELETE FROM ask_trace_links
        WHERE source_trace_id NOT IN (SELECT trace_id FROM ask_traces)
          AND (target_trace_id IS NULL OR target_trace_id NOT IN (SELECT trace_id FROM ask_traces))
      `).run();
      // SQLite's page file may stay large after deletes. The cap still guarantees
      // future recording stays bounded; incremental vacuum avoids a blocking VACUUM.
      this.refreshCapacityState();
      if (this.databaseAtCap) {
        const oldest = this.db.prepare(`
          SELECT trace_id FROM ask_traces WHERE detail_expired = 0 ORDER BY started_at ASC LIMIT 50
        `).all() as Array<{ trace_id: string }>;
        for (const row of oldest) this.markPartial(row.trace_id);
        this.db.pragma('incremental_vacuum(64)');
        this.refreshCapacityState();
      }
      this.refreshRetentionCounts();
    } catch {
      this.trip();
    }
  }

  private trip(): void {
    // A store problem must never leak to execution. Keep the existing file for
    // support investigation and turn subsequent observer calls into no-ops.
    this.unavailableReason = 'store_error';
    try { this.db?.close(); } catch { /* tracing is strictly fail-open */ }
    this.db = undefined;
    this.prepared = undefined;
    this.spanBatchStatements.clear();
    this.candidateBatchStatements.clear();
    this.linkBatchStatements.clear();
    this.pendingFinalizations.clear();
    this.schemaVersion = 0;
  }

  private isDatabaseAtCap(): boolean {
    try {
      const main = existsSync(this.options.path) ? statSync(this.options.path).size : 0;
      const walPath = `${this.options.path}-wal`;
      const wal = existsSync(walPath) ? statSync(walPath).size : 0;
      return main + wal > this.options.maxDbBytes;
    } catch {
      return false;
    }
  }

  /** File-system stats are intentionally confined to lifecycle/flush work. */
  private refreshCapacityState(): void {
    this.databaseAtCap = this.isDatabaseAtCap();
  }
}

export function defaultAskTraceSqlitePath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'local', 'ask-observability.sqlite');
}

/**
 * The observer writes the same root first into its in-memory span map. Keeping
 * the store's emergency root intentionally tiny and deterministic means an
 * interrupted run remains structurally exportable without retaining question
 * text or any execution payload before normal tracing starts.
 */
function durableRootSpan(envelope: AskTraceEnvelopeV1): AskTraceSpanV1 {
  return {
    version: 1,
    traceId: envelope.traceId,
    spanId: envelope.rootSpanId,
    ordinal: 0,
    name: envelope.mode === 'research' ? 'research.run' : 'ask.run',
    stage: 'request',
    startedAt: envelope.startedAt,
    outcome: 'ok',
    reasonCode: 'started',
    payload: {
      kind: 'stage',
      requestedMode: envelope.mode,
      fingerprint: envelope.questionFingerprint,
    },
  };
}

function parseJson(value: string): unknown | undefined {
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function terminalOutcomeFromSummary(value: string): AskTraceTerminalOutcomeV1 | undefined {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const terminalOutcome = (parsed as Record<string, unknown>).terminalOutcome;
  return terminalOutcome === 'completed'
    || terminalOutcome === 'needs_review'
    || terminalOutcome === 'needs_clarification'
    || terminalOutcome === 'cancelled'
    || terminalOutcome === 'blocked'
    ? terminalOutcome
    : undefined;
}

/**
 * SQLite is an internal, local queue target rather than a portable artifact.
 * Payloads have already crossed the strict typed/redaction boundary; portable
 * export re-canonicalizes the parsed trace before it is checksummed. Keeping
 * normal JSON here avoids sorting every nested object once per physical span
 * without changing exported/replayed trace semantics.
 */
function storageJson(value: object): string {
  return JSON.stringify(value);
}

function* batches<T>(items: T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) yield items.slice(index, index + size);
}
