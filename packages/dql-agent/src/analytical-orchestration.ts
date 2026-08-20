/**
 * Shared contracts for the conversational analytical orchestrator.
 *
 * The existing DQL engine remains the authority for compilation, execution,
 * trust, and the immutable resolved analytical plan.  This module is the thin
 * outer contract used by the conversational layer to describe what it
 * understood, what it searched, and why it could or could not continue.
 *
 * The contract is intentionally content-only: it never carries model
 * chain-of-thought, credentials, raw provider payloads, or authorization.
 *
 * Acceptance: AGT-027..033, CTX-007, PERF-003, E2E-022.
 */

import { createHash } from 'node:crypto';
import type { DqlArtifactExecutionReceipt } from '@duckcodeailabs/dql-core';

export const ANALYTICAL_ORCHESTRATION_CONTRACT_VERSION = 1 as const;

export type AnalyticalTurnKind =
  | 'conversation'
  | 'definition'
  | 'lookup'
  | 'ranking'
  | 'breakdown'
  | 'comparison'
  | 'drilldown'
  | 'diagnosis'
  | 'research'
  | 'compound'
  | 'clarification'
  // Basic value/measure requests that are not a glossary definition.
  // Kept separate from `definition` so narration can explain the result.
  // (The union member is intentionally last for stable serialized values.)
  | 'aggregation';

export type AnalyticalTaskKind =
  | 'definition'
  | 'aggregation'
  | 'ranking'
  | 'attribute_lookup'
  | 'breakdown'
  | 'comparison'
  | 'drilldown'
  | 'diagnosis'
  | 'research_branch';

export type AnalyticalTaskStatus = 'planned' | 'running' | 'completed' | 'partial' | 'gap' | 'blocked';

export interface AnalyticalTaskOutputContractV1 {
  metrics: string[];
  dimensions: string[];
  filters: Array<{ field: string; value: string }>;
  grain?: string;
  limit?: number;
  order?: 'asc' | 'desc';
  requestedColumns?: string[];
}

export interface AnalyticalTaskV1 {
  version: 1;
  id: string;
  kind: AnalyticalTaskKind;
  question: string;
  dependencies: string[];
  output: AnalyticalTaskOutputContractV1;
  status: AnalyticalTaskStatus;
  /** Only qualified catalog IDs may be placed in this list. */
  candidateIds: string[];
  /** Shared prior-result bindings, e.g. region = Philadelphia. */
  inheritedBindings: Array<{ id: string; value: string; source: 'conversation' | 'result' | 'user' }>;
}

/** Durable, content-only outcome for one independent clause/branch. */
export interface AnalyticalTaskOutcomeV1 {
  version: 1;
  taskId: string;
  status: 'completed' | 'partial' | 'gap' | 'blocked';
  summary?: string;
  resultFingerprint?: string;
  gap?: AnalyticalCoverageGapV1;
}

export interface AnalyticalCoverageGapV1 {
  version: 1;
  code:
    | 'MISSING_MEASURE'
    | 'MISSING_DIMENSION'
    | 'MISSING_ATTRIBUTE'
    | 'MISSING_RELATIONSHIP'
    | 'MISSING_RUNTIME_CAPABILITY'
    | 'RESULT_CONTRACT_MISMATCH'
    | 'PROVIDER_UNAVAILABLE'
    | 'EXECUTION_FAILED'
    | 'AMBIGUOUS_MEANING'
    | 'POLICY_BLOCKED';
  phase: 'retrieval' | 'meaning' | 'planning' | 'compilation' | 'execution' | 'presentation';
  message: string;
  searchedSources: string[];
  attemptedRoutes: Array<'certified' | 'semantic' | 'governed_relational' | 'generated' | 'research'>;
  missing: string[];
  recoverable: boolean;
  planFrozen: boolean;
  nextActions: string[];
}

export interface AnalyticalTurnPlanV1 {
  version: 1;
  turnId?: string;
  question: string;
  kind: AnalyticalTurnKind;
  /** Natural-language turns use one bounded interpretation call by default. */
  meaningCallBudget: 0 | 1;
  meaningCallReason: 'explicit_binding' | 'conversation_only' | 'candidate_interpretation' | 'frozen_research_child';
  snapshotId?: string;
  sourceFingerprint?: string;
  taskIds: string[];
  tasks: AnalyticalTaskV1[];
  authorityOrder: Array<'certified' | 'semantic' | 'governed_relational' | 'generated'>;
  /** This is set only after compatibility and authorization have passed. */
  frozen: boolean;
  conversationTurnId?: string;
  parentRunId?: string;
}

export interface AnalyticalAnswerSectionV1 {
  version: 1;
  id: string;
  taskId: string;
  status: 'answered' | 'partial' | 'gap' | 'blocked';
  answer?: string;
  result?: CanonicalQueryResultV1;
  gap?: AnalyticalCoverageGapV1;
  factIds: string[];
  trustState: 'certified' | 'governed' | 'review_required' | 'not_applicable' | 'blocked';
}

export interface AnalyticalTurnAnswerV1 {
  version: 1;
  answer: string;
  sections: AnalyticalAnswerSectionV1[];
  followUps: string[];
  facts: string[];
}

/**
 * Small, explainable intent vocabulary used before the physical plan exists.
 * It is deliberately not a second semantic matcher: candidate identity still
 * comes from retrieval plus the bounded meaning call. These helpers only turn
 * a request into a task graph and output contract, so a compound question can
 * report partial success instead of collapsing the whole turn to one error.
 */
export function inferAnalyticalTurnKind(question: string): AnalyticalTurnKind {
  const text = question.toLowerCase();
  if (/\b(hello|hi|hey|thanks|thank you|good morning|good afternoon)\b/.test(text)) return 'conversation';
  if (/\b(why|root cause|driver|diagnos|anomal|changed)\b/.test(text)) return 'diagnosis';
  if (/\b(research|investigate|deep dive|tell a story|surrounding context)\b/.test(text)) return 'research';
  if (/\b(compare|versus|vs\.?|difference)\b/.test(text)) return 'comparison';
  if (/\b(top|bottom|highest|lowest|rank)\b/.test(text)) return 'ranking';
  if (/\b(by|per|over time|trend|monthly|daily|weekly)\b/.test(text)) return 'breakdown';
  if (/\b(what is|what are|define|definition|meaning)\b/.test(text) && !/\b(total|revenue|count|sales|amount)\b/.test(text)) return 'definition';
  if (/\b(region|country|state|city|name|label|email|category|product|customer)\b/.test(text)
    && /\b(where|which|what|who)\b/.test(text)) return 'lookup';
  return 'aggregation';
}

/**
 * `Regarding: "Mr. Matthew Meyer"` and friends — a short label, a colon, and a
 * quoted value, with nothing else in the clause. Deliberately narrow: it must
 * be the WHOLE clause and the value must be quoted, so an ordinary question
 * that happens to contain a colon is untouched.
 */
const ANNOTATION_CLAUSE = /^\s*[A-Za-z][A-Za-z ]{0,24}:\s*["“'‘][^"”'’]*["”'’]\s*$/;

export function splitAnalyticalTasks(question: string): string[] {
  // The separator belongs to the SPLIT, not to the clause. Carrying it through
  // produced a child task whose question was literally
  // `" then "What customer type is Wesley Jenkins` — quote, connector and all —
  // which then failed to resolve and surfaced that punctuation to the reader as
  // the task title.
  const leadingJunk = /^(?:[\s"'“”‘’,:;.\-]+|\b(?:then|and|also)\b)+/i;
  const trailingJunk = /[\s"'“”‘’,:;.\-]+$/;
  const raw = question
    .split(/\s*(?:\?|;|\band then\b|\balso\b)\s*/i)
    .flatMap((part) => part.split(/\s+\band\s+(?=(?:what|who|which|show|list|tell|give|how|why)\b)/i));
  // A `Label: "value"` clause is an ANNOTATION, not a question. The composer
  // appends `Regarding: "<selected row>"` when the reader follows up on
  // something they clicked, and splitting on the `?` before it turned that
  // referent into a task of its own — titled `Regarding: "Mr. Matthew Meyer`,
  // which then "answered" by computing an unrelated maximum over the rows still
  // on screen. Context says WHO the real task is about; it is never a task.
  // Filtered before the junk strip, which would unbalance the quotes.
  const asked = raw.filter((part) => !ANNOTATION_CLAUSE.test(part));
  const parts = (asked.length > 0 ? asked : raw)
    .map((part) => part.replace(leadingJunk, '').replace(trailingJunk, '').trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [question.trim()];
}

export function buildAnalyticalTaskGraph(input: {
  question: string;
  candidateIds?: string[];
  metrics?: string[];
  dimensions?: string[];
  filters?: Array<{ field: string; value: string }>;
  inheritedBindings?: Array<{ id: string; value: string; source: 'conversation' | 'result' | 'user' }>;
  maxTasks?: number;
}): { kind: AnalyticalTurnKind; tasks: AnalyticalTaskV1[]; partial: boolean } {
  const clauses = splitAnalyticalTasks(input.question).slice(0, Math.max(1, Math.min(6, input.maxTasks ?? 6)));
  const candidateIds = [...new Set((input.candidateIds ?? []).filter((id) => id.trim()))];
  const metrics = [...new Set((input.metrics ?? []).filter((metric) => metric.trim()))];
  const dimensions = [...new Set((input.dimensions ?? []).filter((dimension) => dimension.trim()))];
  const filters = input.filters ?? [];
  const inheritedBindings = input.inheritedBindings ?? [];
  const tasks = clauses.map((clause, index): AnalyticalTaskV1 => {
    const kind = inferAnalyticalTurnKind(clause);
    const research = kind === 'research' || kind === 'diagnosis';
    const taskKind: AnalyticalTaskKind = research
      ? 'research_branch'
      : kind === 'lookup'
        ? 'attribute_lookup'
        : kind === 'breakdown'
          ? 'breakdown'
          : kind === 'comparison'
            ? 'comparison'
            : kind === 'ranking'
              ? 'ranking'
              : kind === 'definition'
                ? 'definition'
                : 'aggregation';
    return {
      version: 1,
      id: `task-${index + 1}`,
      kind: taskKind,
      question: clause,
      dependencies: index === 0 ? [] : [],
      output: {
        metrics,
        dimensions,
        filters,
        ...(kind === 'ranking' ? { order: 'desc' as const } : {}),
      },
      status: 'planned',
      candidateIds,
      inheritedBindings,
    };
  });
  return {
    kind: tasks.length > 1 ? 'compound' : inferAnalyticalTurnKind(input.question),
    tasks,
    partial: false,
  };
}

export function buildAnalyticalTurnPlan(input: {
  question: string;
  turnId?: string;
  candidateIds?: string[];
  metrics?: string[];
  dimensions?: string[];
  filters?: Array<{ field: string; value: string }>;
  inheritedBindings?: Array<{ id: string; value: string; source: 'conversation' | 'result' | 'user' }>;
  zeroCallReason?: AnalyticalTurnPlanV1['meaningCallReason'];
  frozen?: boolean;
  snapshotId?: string;
  sourceFingerprint?: string;
}): AnalyticalTurnPlanV1 {
  const graph = buildAnalyticalTaskGraph(input);
  const zeroCall = input.zeroCallReason === 'explicit_binding'
    || input.zeroCallReason === 'conversation_only'
    || input.zeroCallReason === 'frozen_research_child';
  return {
    version: 1,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    question: input.question,
    kind: graph.kind,
    meaningCallBudget: zeroCall ? 0 : 1,
    meaningCallReason: input.zeroCallReason ?? 'candidate_interpretation',
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    ...(input.sourceFingerprint ? { sourceFingerprint: input.sourceFingerprint } : {}),
    taskIds: graph.tasks.map((task) => task.id),
    tasks: graph.tasks,
    authorityOrder: ['certified', 'semantic', 'governed_relational', 'generated'],
    frozen: input.frozen === true,
  };
}

export function summarizeTaskOutcomes(tasks: AnalyticalTaskV1[]): {
  status: 'completed' | 'partial' | 'gap' | 'blocked';
  completed: string[];
  gaps: string[];
} {
  const completed = tasks.filter((task) => task.status === 'completed').map((task) => task.id);
  const gaps = tasks.filter((task) => task.status === 'gap' || task.status === 'blocked').map((task) => task.id);
  const status = completed.length === tasks.length && tasks.length > 0
    ? 'completed'
    : completed.length > 0
      ? 'partial'
      : gaps.some((id) => tasks.find((task) => task.id === id)?.status === 'blocked')
        ? 'blocked'
        : 'gap';
  return { status, completed, gaps };
}

export interface CanonicalQueryResultV1 {
  version: 1;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  executionTime?: number;
  truncated?: boolean;
  /** The exact execution proof is carried through every transport boundary. */
  executionReceipt?: DqlArtifactExecutionReceipt;
  /** Trust/tier are descriptive identity, never inferred by a renderer. */
  trustState?: 'certified' | 'governed' | 'review_required' | 'not_applicable' | 'blocked';
  answerTier?: string;
  resultFingerprint: string;
}

/**
 * Normalize connector, MetricFlow, and provider result shapes at one boundary.
 * Connectors may return `ColumnMeta[]` and rows as arrays; UI surfaces should
 * never need to guess how to index those rows.
 */
export function normalizeCanonicalQueryResult(input: {
  columns?: unknown;
  rows?: unknown;
  rowCount?: unknown;
  executionTime?: unknown;
  executionTimeMs?: unknown;
  truncated?: unknown;
  resultFingerprint?: unknown;
  executionReceipt?: unknown;
  trustState?: unknown;
  answerTier?: unknown;
}): CanonicalQueryResultV1 {
  const columns = Array.isArray(input.columns)
    ? input.columns.map(columnName)
    : [];
  const rawRows = Array.isArray(input.rows) ? input.rows : [];
  const inferredColumns = columns.length > 0
    ? columns
    : objectRowColumns(rawRows).length > 0
      ? objectRowColumns(rawRows)
      : firstArrayRow(rawRows)
        ? firstArrayRow(rawRows)!.map((_, index) => `column_${index + 1}`)
        : [];
  const rows = rawRows.map((row) => normalizeRow(row, inferredColumns));
  const rowCount = typeof input.rowCount === 'number' && Number.isFinite(input.rowCount)
    ? Math.max(0, Math.trunc(input.rowCount))
    : rows.length;
  const executionTime = typeof input.executionTimeMs === 'number'
    ? input.executionTimeMs
    : typeof input.executionTime === 'number'
      ? input.executionTime
      : undefined;
  const canonical = {
    version: 1 as const,
    columns: inferredColumns,
    rows,
    rowCount,
    ...(executionTime !== undefined ? { executionTime } : {}),
    ...(input.truncated === true ? { truncated: true } : {}),
  };
  const receipt = input.executionReceipt && typeof input.executionReceipt === 'object'
    ? input.executionReceipt as DqlArtifactExecutionReceipt
    : undefined;
  const receiptFingerprint = typeof receipt?.resultFingerprint === 'string' ? receipt.resultFingerprint : undefined;
  const suppliedFingerprint = typeof input.resultFingerprint === 'string' && input.resultFingerprint.trim()
    ? input.resultFingerprint.trim()
    : receiptFingerprint;
  const trustState = input.trustState === 'certified'
    || input.trustState === 'governed'
    || input.trustState === 'review_required'
    || input.trustState === 'not_applicable'
    || input.trustState === 'blocked'
    ? input.trustState
    : undefined;
  return {
    ...canonical,
    ...(receipt ? { executionReceipt: receipt } : {}),
    ...(trustState ? { trustState } : {}),
    ...(typeof input.answerTier === 'string' && input.answerTier.trim()
      ? { answerTier: input.answerTier.trim() }
      : {}),
    // A connector/execution receipt is authoritative. The local digest is only
    // a backwards-compatible fallback for legacy unreceipted rows.
    resultFingerprint: suppliedFingerprint ?? stableFingerprint(canonical),
  };
}

export function canonicalResultRows(result: CanonicalQueryResultV1): unknown[][] {
  return result.rows.map((row) => result.columns.map((column) => row[column]));
}

export function assertCanonicalResult(result: CanonicalQueryResultV1): void {
  if (result.version !== 1) throw new Error('Unsupported analytical result contract version.');
  if (result.rowCount < result.rows.length) throw new Error('Result rowCount cannot be smaller than the returned rows.');
  if (new Set(result.columns).size !== result.columns.length) throw new Error('Result columns must be unique.');
  for (const row of result.rows) {
    for (const column of result.columns) {
      if (!Object.prototype.hasOwnProperty.call(row, column)) {
        throw new Error(`Result row is missing the declared column ${column}.`);
      }
    }
  }
}

export interface ContextCandidateCardV1 {
  id: string;
  lane: 'exact' | 'lexical' | 'vector' | 'graph' | 'runtime_value' | 'domain' | 'skill' | 'conversation'
    | 'certified' | 'semantic' | 'relational' | 'business';
  relevance: number;
  trust?: 'certified' | 'semantic' | 'governed_sql' | 'exploratory';
  compatible?: boolean;
  summary?: string;
}

export interface ContextFusionDiagnosticsV1 {
  lanes: Record<string, {
    returned: number;
    durationMs?: number;
    status?: 'ok' | 'empty' | 'error' | 'skipped';
    error?: string;
    skippedReason?: string;
  }>;
  selectedIds: string[];
  truncated: boolean;
}

export interface ContextFusionResultV1 {
  candidates: ContextCandidateCardV1[];
  diagnostics: ContextFusionDiagnosticsV1;
}

/** Reciprocal-rank fusion keeps recall across lexical, vector, and graph lanes. */
export function fuseContextCandidates(
  lanes: Record<string, ContextCandidateCardV1[]>,
  limit = 32,
): ContextFusionResultV1 {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const byId = new Map<string, ContextCandidateCardV1 & { score: number; lanes: Set<string> }>();
  const diagnostics: ContextFusionDiagnosticsV1 = { lanes: {}, selectedIds: [], truncated: false };
  for (const [lane, cards] of Object.entries(lanes)) {
    diagnostics.lanes[lane] = { returned: cards.length };
    cards.forEach((card, index) => {
      if (!card.id.trim()) return;
      const score = 1 / (60 + index + 1) + Math.max(0, Math.min(1, card.relevance)) * 0.25;
      const existing = byId.get(card.id);
      if (existing) {
        existing.score += score;
        existing.lanes.add(lane);
        if ((card.relevance ?? 0) > existing.relevance) existing.relevance = card.relevance;
        if (card.compatible === true) existing.compatible = true;
        if (!existing.summary && card.summary) existing.summary = card.summary;
      } else {
        byId.set(card.id, { ...card, score, lanes: new Set([lane]) });
      }
    });
  }
  const selected = [...byId.values()]
    .sort((left, right) => right.score - left.score || right.relevance - left.relevance || left.id.localeCompare(right.id))
    .slice(0, safeLimit)
    .map(({ score: _score, lanes: _lanes, ...card }) => card);
  diagnostics.selectedIds = selected.map((card) => card.id);
  diagnostics.truncated = byId.size > selected.length;
  return { candidates: selected, diagnostics };
}

export async function retrieveContextLanes(
  lanes: Record<string, () => Promise<ContextCandidateCardV1[]>>,
  limit = 32,
  maxConcurrent = 4,
): Promise<ContextFusionResultV1> {
  const entries = Object.entries(lanes);
  const concurrency = Math.max(1, Math.min(8, Math.trunc(maxConcurrent) || 1));
  const settled: Array<readonly [string, ContextCandidateCardV1[] | { error: string }, number]> = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = entries[index];
      if (!entry) return;
      const [name, retrieve] = entry;
      const startedAt = Date.now();
      try {
        const cards = await retrieve();
        settled[index] = [name, cards, Date.now() - startedAt];
      } catch (error) {
        settled[index] = [name, { error: error instanceof Error ? error.message : String(error) }, Date.now() - startedAt];
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => worker()));
  const successful: Record<string, ContextCandidateCardV1[]> = {};
  const errors: Record<string, string> = {};
  const durations: Record<string, number> = {};
  for (const [name, result, durationMs] of settled) {
    durations[name] = durationMs;
    if (Array.isArray(result)) successful[name] = result;
    else errors[name] = result.error;
  }
  const fused = fuseContextCandidates(successful, limit);
  for (const [name, cards] of Object.entries(successful)) {
    fused.diagnostics.lanes[name] = {
      returned: cards.length,
      durationMs: durations[name],
      status: cards.length > 0 ? 'ok' : 'empty',
    };
  }
  for (const [name, error] of Object.entries(errors)) {
    fused.diagnostics.lanes[name] = {
      returned: 0,
      durationMs: durations[name],
      status: 'error',
      error,
    };
  }
  return fused;
}

export interface ResearchLedgerEntryV1 {
  id: string;
  branchId: string;
  question: string;
  status: 'observed' | 'failed' | 'skipped';
  /** Optional complete execution proof; arbitrary IDs are never accepted. */
  executionReceipt?: DqlArtifactExecutionReceipt;
  resultFingerprint?: string;
  rowCount?: number;
  facts: string[];
  receipts: string[];
  error?: string;
}

export interface ResearchEvidenceLedgerV1 {
  version: 1;
  rootQuestion: string;
  planId?: string;
  snapshotId?: string;
  entries: ResearchLedgerEntryV1[];
  factIds: string[];
  stoppingReason: 'completed' | 'budget' | 'insufficient_evidence' | 'blocked' | 'not_started';
}

export function capResearchBranches<T>(branches: T[], max = 6): T[] {
  return branches.slice(0, Math.max(1, Math.min(6, Math.trunc(max))));
}

export function buildResearchEvidenceLedger(input: {
  rootQuestion: string;
  planId?: string;
  snapshotId?: string;
  entries: ResearchLedgerEntryV1[];
  stoppingReason?: ResearchEvidenceLedgerV1['stoppingReason'];
}): ResearchEvidenceLedgerV1 {
  const entries = input.entries.slice(0, 6).map((entry) => {
    const resultFingerprint = normalizeAnalyticalExecutionFingerprint(entry.resultFingerprint);
    const executionReceipt = normalizeAnalyticalExecutionReceipt(entry.executionReceipt);
    const receiptFingerprint = executionReceipt?.resultFingerprint;
    const listedFingerprint = entry.receipts
      .map((receipt) => normalizeAnalyticalExecutionFingerprint(receipt))
      .find((receipt): receipt is string => Boolean(receipt));
    const executionProof = resultFingerprint ?? receiptFingerprint ?? listedFingerprint;

    // A receipt/result proof is meaningful only for an observed branch. Never
    // carry a preloaded receipt, child ID, context-pack ID, or malformed
    // fingerprint through a failed/cancelled/skipped entry.
    if (entry.status !== 'observed') {
      const { executionReceipt: _receipt, resultFingerprint: _fingerprint, ...withoutProof } = entry;
      return { ...withoutProof, receipts: [] };
    }

    // A ready/observed branch without a complete receipt or canonical result
    // fingerprint is not an observation. Downgrade it and retain no invented
    // proof; callers can still inspect the branch and retry it explicitly.
    if (!executionProof) {
      const { executionReceipt: _receipt, resultFingerprint: _fingerprint, ...withoutProof } = entry;
      return {
        ...withoutProof,
        status: 'failed' as const,
        receipts: [],
        error: entry.error ?? 'Research branch had no valid execution receipt or canonical result fingerprint.',
      };
    }

    return {
      ...entry,
      status: 'observed' as const,
      resultFingerprint: executionProof,
      ...(executionReceipt ? { executionReceipt } : {}),
      receipts: [executionProof],
    };
  });
  return {
    version: 1,
    rootQuestion: input.rootQuestion,
    ...(input.planId ? { planId: input.planId } : {}),
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    entries,
    factIds: [...new Set(entries.flatMap((entry) => entry.facts))],
    stoppingReason: input.stoppingReason ?? (entries.length > 0 ? 'completed' : 'not_started'),
  };
}

/** The only accepted host-side execution identity is a SHA-256 fingerprint. */
export function normalizeAnalyticalExecutionFingerprint(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined;
}

/**
 * Normalize a complete DQL execution receipt. A partial object or arbitrary
 * identifier is deliberately not execution evidence.
 */
export function normalizeAnalyticalExecutionReceipt(value: unknown): DqlArtifactExecutionReceipt | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sourceFingerprint = normalizeAnalyticalExecutionFingerprint(record.sourceFingerprint);
  const compiledSqlFingerprint = normalizeAnalyticalExecutionFingerprint(record.compiledSqlFingerprint);
  const parameterFingerprint = normalizeAnalyticalExecutionFingerprint(record.parameterFingerprint);
  const resultFingerprint = normalizeAnalyticalExecutionFingerprint(record.resultFingerprint);
  return sourceFingerprint && compiledSqlFingerprint && parameterFingerprint && resultFingerprint
    ? { sourceFingerprint, compiledSqlFingerprint, parameterFingerprint, resultFingerprint }
    : undefined;
}

export function buildCoverageGap(input: Omit<AnalyticalCoverageGapV1, 'version'>): AnalyticalCoverageGapV1 {
  return { version: 1, ...input };
}

function columnName(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string') {
    return String((value as { name: unknown }).name);
  }
  return String(value ?? 'column');
}

function objectRowColumns(rows: unknown[]): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const column of Object.keys(row as Record<string, unknown>)) columns.add(column);
  }
  return [...columns];
}

function firstArrayRow(rows: unknown[]): unknown[] | undefined {
  const row = rows.find((candidate) => Array.isArray(candidate));
  return row as unknown[] | undefined;
}

function normalizeRow(row: unknown, columns: string[]): Record<string, unknown> {
  if (Array.isArray(row)) return Object.fromEntries(columns.map((column, index) => [column, row[index]]));
  if (row && typeof row === 'object') {
    const record = row as Record<string, unknown>;
    return Object.fromEntries(columns.map((column) => [column, record[column]]));
  }
  return Object.fromEntries(columns.map((column) => [column, undefined]));
}

function stableFingerprint(value: unknown): string {
  const text = stableStringify(value);
  return createHash('sha256').update(text).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
