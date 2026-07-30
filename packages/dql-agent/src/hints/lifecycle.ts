import { createHash } from 'node:crypto';
import { buildLocalContextPack } from '../metadata/catalog.js';
import { validateSqlAgainstLocalContext } from '../metadata/sql-context-validation.js';
import {
  evaluateHint,
  getCorrectionTraceFromGit,
  getHintEvaluationFromGit,
  getHintFromGit,
  HintLifecycleError,
  recordCorrectionTrace,
  reopenHint,
  requiresEvaluatedApproval,
  reviewHint,
  updateHintCandidate,
  type RecordCorrectionTraceInput,
  type RecordCorrectionTraceResult,
  type ReviewHintResult,
} from './git-store.js';
import { assessHintFreshness, collectHintDependencies } from './dependencies.js';
import type {
  HintDependency,
  HintEvaluation,
  HintEvaluationCheck,
  HintLifecycleFailure,
  HintScope,
  Hint,
  CorrectionTrace,
} from './types.js';

export interface GovernedHintContext {
  snapshotId: string;
  dependencies: HintDependency[];
  checks: HintEvaluationCheck[];
  evidence: string[];
}

export type ResolveGovernedHintContext = (input: {
  projectRoot: string;
  question: string;
  correctedSql?: string;
  scope: HintScope;
  snapshotId?: string;
}) => Promise<GovernedHintContext>;

export interface GovernedHintExecutionResult {
  columns: unknown[];
  rows: unknown[];
  rowCount: number;
  sql?: string;
  executionReceipt?: unknown;
}

export type ExecuteGovernedHintSql = (
  sql: string,
  options: { rowLimit: number; question: string },
) => Promise<GovernedHintExecutionResult>;

export interface RecordGovernedCorrectionInput extends Omit<
  RecordCorrectionTraceInput,
  'failedRoute' | 'evidence' | 'snapshotId' | 'requiredEvaluation' | 'dependencies' | 'lifecycleErrors'
> {
  failedRoute?: string;
  evidence?: string[];
  snapshotId?: string;
  requiredEvaluation?: string;
}

export interface ReviewGovernedHintInput {
  hintId: string;
  decision: 'approved' | 'rejected';
  reviewer: string;
  note?: string;
  snapshotId?: string;
  rowLimit?: number;
  executeSql?: ExecuteGovernedHintSql;
  resolveContext?: ResolveGovernedHintContext;
}

export interface ReviewGovernedHintResult extends ReviewHintResult {
  evaluation?: HintEvaluation;
}

export interface GovernedHintInspection {
  hint: Hint;
  trace?: CorrectionTrace;
  evaluation?: HintEvaluation;
  currentSnapshotId: string;
  snapshotCurrent: boolean;
  dependenciesCurrent: boolean;
  driftedDependencies: HintDependency[];
  checks: HintEvaluationCheck[];
  state: 'current' | 'stale' | 'invalid' | 'unverified';
}

export interface EditGovernedHintCandidateInput {
  hintId: string;
  title?: string;
  guidance?: string;
  correctedSql?: string;
  scope?: HintScope;
  snapshotId?: string;
  resolveContext?: ResolveGovernedHintContext;
}

/**
 * Shared correction capture path for the notebook API, CLI runtime, and MCP.
 * Capture remains permissive: unsafe or unresolved corrections are retained as
 * candidates with lifecycle errors, but can never pass approval.
 */
export async function recordGovernedCorrection(
  projectRoot: string,
  input: RecordGovernedCorrectionInput,
  resolveContext: ResolveGovernedHintContext = resolveGovernedHintContext,
): Promise<RecordCorrectionTraceResult> {
  const context = await resolveContext({
    projectRoot,
    question: input.question,
    correctedSql: input.correctedSql,
    scope: input.scope,
    snapshotId: input.snapshotId,
  }).catch((error) => unresolvedContext(input, error));
  const lifecycleErrors = failuresFromChecks(context.checks);
  const requiredEvaluation = input.requiredEvaluation?.trim()
    || `correction: ${input.question.trim().replace(/\s+/g, ' ').slice(0, 60)}`;
  const evidence = uniqueStrings([
    ...(input.evidence ?? []),
    `question: ${input.question}`,
    ...(input.correctedSql ? [`corrected SQL: ${compact(input.correctedSql, 400)}`] : []),
    ...context.evidence,
  ]);
  const hintGuidance = input.hintGuidance?.trim() || deriveCorrectionGuidance(input);

  return recordCorrectionTrace(projectRoot, {
    ...input,
    hintGuidance,
    failedRoute: input.failedRoute?.trim() || 'generated_answer',
    evidence,
    snapshotId: context.snapshotId,
    requiredEvaluation,
    dependencies: context.dependencies,
    lifecycleErrors,
  });
}

/**
 * Do not let a SQL-only correction silently become the reusable lesson. Older
 * clients may omit `hintGuidance`, so preserve a human-written correction when
 * one exists and otherwise derive a conservative, reviewable instruction.
 */
export function deriveCorrectionGuidance(input: Pick<
  RecordGovernedCorrectionInput,
  'question' | 'scope' | 'correction' | 'correctedSql' | 'hintGuidance'
>): string {
  const explicit = input.hintGuidance?.trim();
  if (explicit) return explicit;
  const correction = input.correction.trim();
  const correctedSql = input.correctedSql?.trim();
  const normalizedCorrection = correction.replace(/\s+/g, ' ');
  const normalizedSql = correctedSql?.replace(/\s+/g, ' ');
  if (!correctedSql || normalizedCorrection !== normalizedSql) {
    return correction;
  }
  const scope = [
    input.scope.domain ? `domain ${input.scope.domain}` : undefined,
    input.scope.metric ? `metric ${input.scope.metric}` : undefined,
    input.scope.dbtModel ? `model ${input.scope.dbtModel}` : undefined,
    input.scope.term ? `term ${input.scope.term}` : undefined,
    input.scope.block ? `block ${input.scope.block}` : undefined,
  ].filter(Boolean).join(', ');
  const question = compact(input.question, 120);
  return `For ${scope || 'matching governed questions'}, follow the reviewed corrected SQL pattern captured for "${question}". Confirm the pattern against current certified, dbt, and semantic context.`;
}

/**
 * Shared fail-closed review path. A v3 approval always creates a fresh
 * evaluation artifact, so a failed attempt remains reviewable and retryable.
 */
export async function reviewGovernedHint(
  projectRoot: string,
  input: ReviewGovernedHintInput,
): Promise<ReviewGovernedHintResult | null> {
  const hint = getHintFromGit(projectRoot, input.hintId);
  if (!hint) return null;
  if (input.decision === 'rejected' || !requiresEvaluatedApproval(projectRoot)) {
    return reviewHint(projectRoot, {
      hintId: input.hintId,
      decision: input.decision,
      reviewer: input.reviewer,
      note: input.note,
      snapshotId: input.snapshotId,
    });
  }
  if (hint.status !== 'candidate') {
    throw new HintLifecycleError(
      'HINT_NOT_CANDIDATE',
      `Hint ${hint.id} is ${hint.status}; only candidates can be reviewed.`,
    );
  }
  if (!hint.correctedSql?.trim()) {
    throw new HintLifecycleError(
      'HINT_CORRECTED_SQL_REQUIRED',
      `Hint ${hint.id} cannot be approved without corrected SQL.`,
    );
  }
  if (!hint.requiredEvaluation || !hint.snapshotId) {
    throw new HintLifecycleError(
      'HINT_PROVENANCE_REQUIRED',
      `Hint ${hint.id} is missing its required evaluation or immutable snapshot.`,
    );
  }

  const trace = hint.traceId ? getCorrectionTraceFromGit(projectRoot, hint.traceId) : null;
  const question = trace?.question?.trim() || hint.title;
  const resolveContext = input.resolveContext ?? resolveGovernedHintContext;
  const current = await resolveContext({
    projectRoot,
    question,
    correctedSql: hint.correctedSql,
    scope: hint.scope,
    snapshotId: input.snapshotId,
  }).catch((error) => unresolvedContext({ question, scope: hint.scope, correctedSql: hint.correctedSql }, error));

  const freshness = assessHintFreshness({
    dependencies: hint.dependencies,
    snapshotId: hint.snapshotId,
    currentSnapshotId: current.snapshotId,
    currentDependencies: new Map(
      current.dependencies.map((dependency) => [dependency.id, dependency.fingerprint]),
    ),
  });
  const checks: HintEvaluationCheck[] = [
    ...current.checks,
    {
      name: 'snapshot-current',
      passed: freshness.current,
      evidence: freshness.snapshotCurrent
        ? `Current snapshot matches ${hint.snapshotId}.`
        : freshness.dependenciesCurrent
          ? `Project snapshot changed from ${hint.snapshotId} to ${current.snapshotId}, but every scoped dependency still matches.`
          : `Candidate snapshot ${hint.snapshotId}; current snapshot ${current.snapshotId}.`,
    },
  ];
  checks.push({
    name: 'dependencies-current',
    passed: freshness.dependenciesCurrent,
    evidence: freshness.staleDependencies.length > 0
      ? `Changed or missing dependencies: ${freshness.staleDependencies.map((dependency) => dependency.id).join(', ')}.`
      : `${hint.dependencies?.length ?? 0} recorded dependencies match current governed context.`,
  });

  const rowLimit = clampRowLimit(input.rowLimit);
  const executionEvidence: string[] = [];
  if (input.executeSql) {
    try {
      const result = await input.executeSql(hint.correctedSql, { rowLimit, question });
      const bounded = Number.isInteger(result.rowCount)
        && result.rowCount >= 0
        && result.rowCount <= rowLimit
        && Array.isArray(result.rows)
        && result.rows.length <= rowLimit;
      checks.push({
        name: 'bounded-execution',
        passed: bounded,
        evidence: bounded
          ? `Compiled and executed read-only SQL with ${result.rowCount} row(s), bounded to ${rowLimit}.`
          : `Execution returned an invalid or unbounded result (rowCount=${String(result.rowCount)}, rows=${result.rows?.length ?? 'unknown'}).`,
      });
      const hasResultShape = Array.isArray(result.columns) && result.columns.length > 0;
      checks.push({
        name: 'result-shape-assertion',
        passed: hasResultShape,
        evidence: hasResultShape
          ? `Result columns: ${result.columns.map((column) =>
              typeof column === 'string'
                ? column
                : column && typeof column === 'object' && 'name' in column
                  ? String((column as { name?: unknown }).name ?? '?')
                  : '?',
            ).join(', ')}.`
          : 'Execution returned no inspectable result columns.',
      });
      executionEvidence.push(
        `bounded result: rows=${result.rowCount}; columns=${result.columns.length}; limit=${rowLimit}`,
      );
      if (result.executionReceipt) {
        executionEvidence.push(`execution receipt: ${compact(JSON.stringify(result.executionReceipt), 500)}`);
      }
    } catch (error) {
      checks.push({
        name: 'bounded-execution',
        passed: false,
        evidence: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    checks.push({
      name: 'review-evidence-assertion',
      passed: Boolean(input.note?.trim()),
      evidence: input.note?.trim()
        ? `Reviewer assertion: ${compact(input.note, 300)}`
        : 'This surface cannot execute the correction; an explicit reviewer evidence note is required.',
    });
  }
  checks.push({
    name: 'human-semantic-approval',
    passed: Boolean(input.reviewer.trim()),
    evidence: `Explicit approval by ${input.reviewer.trim() || 'unknown reviewer'}; execution success alone does not establish semantic correctness.`,
  });

  const evaluated = evaluateHint(projectRoot, {
    hintId: hint.id,
    snapshotId: hint.snapshotId,
    evaluation: hint.requiredEvaluation,
    evaluator: input.reviewer,
    checks,
    evidence: uniqueStrings([
      `candidate snapshot: ${hint.snapshotId}`,
      `current snapshot: ${current.snapshotId}`,
      ...current.evidence,
      ...executionEvidence,
    ]),
    note: input.note,
  });
  if (evaluated.evaluation.status !== 'passed') {
    throw new HintLifecycleError(
      'HINT_EVALUATION_FAILED',
      `Hint ${hint.id} remains a candidate because evaluation ${evaluated.evaluation.id} failed: ${
        checks.filter((check) => !check.passed).map((check) => check.name).join(', ')
      }. The evaluation is persisted and may be rerun after correction.`,
    );
  }

  const reviewed = reviewHint(projectRoot, {
    hintId: hint.id,
    decision: 'approved',
    reviewer: input.reviewer,
    note: input.note,
    snapshotId: hint.snapshotId,
  });
  return reviewed ? { ...reviewed, evaluation: evaluated.evaluation } : null;
}

/** CTX-005 / API-003: read-only live inspection used by review surfaces and lifecycle decisions. */
export async function inspectGovernedHint(
  projectRoot: string,
  input: {
    hintId: string;
    snapshotId?: string;
    resolveContext?: ResolveGovernedHintContext;
  },
): Promise<GovernedHintInspection | null> {
  const hint = getHintFromGit(projectRoot, input.hintId);
  if (!hint) return null;
  const trace = hint.traceId ? getCorrectionTraceFromGit(projectRoot, hint.traceId) ?? undefined : undefined;
  const question = trace?.question?.trim() || hint.title;
  const resolveContext = input.resolveContext ?? resolveGovernedHintContext;
  const current = await resolveContext({
    projectRoot,
    question,
    correctedSql: hint.correctedSql,
    scope: hint.scope,
    snapshotId: input.snapshotId,
  }).catch((error) => unresolvedContext({ question, scope: hint.scope, correctedSql: hint.correctedSql }, error));
  const freshness = assessHintFreshness({
    dependencies: hint.dependencies,
    snapshotId: hint.snapshotId,
    currentSnapshotId: current.snapshotId,
    currentDependencies: new Map(
      current.dependencies.map((dependency) => [dependency.id, dependency.fingerprint]),
    ),
  });
  const checks: HintEvaluationCheck[] = [
    ...current.checks,
    {
      name: 'snapshot-current',
      passed: freshness.current,
      evidence: freshness.snapshotCurrent
        ? `Current snapshot matches ${hint.snapshotId}.`
        : freshness.dependenciesCurrent
          ? `Project snapshot changed from ${hint.snapshotId ?? '(missing)'} to ${current.snapshotId}, but every scoped dependency still matches.`
          : `Recorded snapshot ${hint.snapshotId ?? '(missing)'}; current snapshot ${current.snapshotId}.`,
    },
    {
      name: 'dependencies-current',
      passed: freshness.dependenciesCurrent,
      evidence: freshness.staleDependencies.length > 0
        ? `Changed or missing dependencies: ${freshness.staleDependencies.map((dependency) => dependency.id).join(', ')}.`
        : `${hint.dependencies?.length ?? 0} recorded dependencies match current governed context.`,
    },
  ];
  const state: GovernedHintInspection['state'] = current.snapshotId.startsWith('unverified:')
    ? 'unverified'
    : !freshness.current
      ? 'stale'
      : checks.some((check) => !check.passed)
        ? 'invalid'
        : 'current';
  return {
    hint,
    trace,
    evaluation: hint.evaluationId ? getHintEvaluationFromGit(projectRoot, hint.evaluationId) ?? undefined : undefined,
    currentSnapshotId: current.snapshotId,
    snapshotCurrent: freshness.snapshotCurrent,
    dependenciesCurrent: freshness.dependenciesCurrent,
    driftedDependencies: freshness.staleDependencies,
    checks,
    state,
  };
}

/** CTX-005 / E2E-001: explicit edit revalidates provenance and clears prior evaluation state. */
export async function editGovernedHintCandidate(
  projectRoot: string,
  input: EditGovernedHintCandidateInput,
): Promise<Hint | null> {
  const hint = getHintFromGit(projectRoot, input.hintId);
  if (!hint) return null;
  const trace = hint.traceId ? getCorrectionTraceFromGit(projectRoot, hint.traceId) : null;
  const scope = input.scope ?? hint.scope;
  const correctedSql = input.correctedSql?.trim() || hint.correctedSql;
  const question = trace?.question?.trim() || input.title?.trim() || hint.title;
  const resolveContext = input.resolveContext ?? resolveGovernedHintContext;
  const current = await resolveContext({
    projectRoot,
    question,
    correctedSql,
    scope,
    snapshotId: input.snapshotId,
  }).catch((error) => unresolvedContext({ question, scope, correctedSql }, error));
  return updateHintCandidate(projectRoot, {
    hintId: hint.id,
    title: input.title,
    guidance: input.guidance,
    correctedSql,
    scope,
    snapshotId: current.snapshotId,
    dependencies: current.dependencies,
    lifecycleErrors: failuresFromChecks(current.checks),
  });
}

/** CTX-005: reopen an applied/retired hint as a non-retrievable candidate against current context. */
export async function reopenGovernedHint(
  projectRoot: string,
  input: {
    hintId: string;
    reviewer: string;
    note?: string;
    snapshotId?: string;
    resolveContext?: ResolveGovernedHintContext;
  },
): Promise<ReviewHintResult | null> {
  const hint = getHintFromGit(projectRoot, input.hintId);
  if (!hint) return null;
  const trace = hint.traceId ? getCorrectionTraceFromGit(projectRoot, hint.traceId) : null;
  const question = trace?.question?.trim() || hint.title;
  const resolveContext = input.resolveContext ?? resolveGovernedHintContext;
  const current = await resolveContext({
    projectRoot,
    question,
    correctedSql: hint.correctedSql,
    scope: hint.scope,
    snapshotId: input.snapshotId,
  }).catch((error) => unresolvedContext({ question, scope: hint.scope, correctedSql: hint.correctedSql }, error));
  return reopenHint(projectRoot, {
    hintId: hint.id,
    reviewer: input.reviewer,
    note: input.note,
    snapshotId: current.snapshotId,
    dependencies: current.dependencies,
    lifecycleErrors: failuresFromChecks(current.checks),
  });
}

/** Resolve current SQL authorization and content-addressed dependencies. */
export async function resolveGovernedHintContext(input: {
  projectRoot: string;
  question: string;
  correctedSql?: string;
  scope: HintScope;
  snapshotId?: string;
}): Promise<GovernedHintContext> {
  const pack = await buildLocalContextPack(input.projectRoot, {
    question: input.question,
    surface: 'hint_lifecycle',
    strictness: 'safe',
  });
  const snapshotId = input.snapshotId?.trim()
    || pack.freshness.fingerprint
    || `unverified:${shortHash(`${input.question}\0${input.correctedSql ?? ''}`)}`;
  const collected = collectHintDependencies({
    sql: input.correctedSql,
    scope: input.scope,
    objects: pack.objects,
    relations: pack.allowedSqlContext.relations,
    fallbackFingerprint: pack.freshness.fingerprint ?? undefined,
  });
  const validation = input.correctedSql?.trim()
    ? validateSqlAgainstLocalContext(input.correctedSql, pack, {
        dialect: input.scope.dialect,
        question: input.question,
      })
    : null;
  const checks: HintEvaluationCheck[] = [
    {
      name: 'corrected-sql-present',
      passed: Boolean(input.correctedSql?.trim()),
      evidence: input.correctedSql?.trim() ? 'Candidate includes corrected SQL.' : 'Candidate has no corrected SQL.',
    },
    {
      name: 'read-only-sql',
      passed: Boolean(validation && (
        validation.ok
        || (validation.code !== 'unsafe_sql' && validation.code !== 'insufficient_context')
      )),
      evidence: validation?.ok
        ? 'Parser accepted a read-only SELECT/WITH statement.'
        : validation?.error ?? 'No SQL was available to parse.',
    },
    {
      name: 'relations-authorized',
      passed: Boolean(validation?.ok) && collected.referencedRelations.length > 0 && collected.unknownRelations.length === 0,
      evidence: collected.unknownRelations.length > 0
        ? `Relations outside current governed context: ${collected.unknownRelations.join(', ')}.`
        : collected.referencedRelations.length > 0
          ? `Authorized relations: ${collected.referencedRelations.join(', ')}.`
          : validation && !validation.ok
            ? validation.error
            : 'No governed relation was referenced.',
    },
  ];
  return {
    snapshotId,
    dependencies: collected.dependencies,
    checks,
    evidence: [
      `snapshot: ${snapshotId}`,
      ...collected.dependencies.map((dependency) => `dependency: ${dependency.id}@${dependency.fingerprint}`),
    ],
  };
}

function unresolvedContext(
  input: { question: string; scope: HintScope; correctedSql?: string },
  error: unknown,
): GovernedHintContext {
  const message = error instanceof Error ? error.message : String(error);
  return {
    snapshotId: `unverified:${shortHash(`${input.question}\0${input.correctedSql ?? ''}`)}`,
    dependencies: [],
    checks: [
      { name: 'context-resolved', passed: false, evidence: message },
      { name: 'relations-authorized', passed: false, evidence: 'Current governed context could not be resolved.' },
    ],
    evidence: [`context resolution failed: ${message}`],
  };
}

function failuresFromChecks(checks: HintEvaluationCheck[]): HintLifecycleFailure[] {
  const at = new Date().toISOString();
  return checks
    .filter((check) => !check.passed)
    .map((check) => ({
      code: `HINT_${check.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_FAILED`,
      message: check.evidence || `${check.name} failed.`,
      at,
    }));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function compact(value: string, limit: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function clampRowLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 200;
  return Math.max(1, Math.min(500, Math.floor(value!)));
}
