import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildExecutionPlan } from '@duckcodeailabs/dql-notebook';
import { prepareBlockInvocation } from '../block-invocation.js';
import { writeFileSync } from 'node:fs';
import type { ConnectionConfig, QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { getDialect, type DQLManifest, type SemanticLayer } from '@duckcodeailabs/dql-core';
import {
  classifyWarehouseError,
  runAskPipeline,
  type AgentProvider,
  type AgentRouteExecutor,
  type AgentRouteExecutorResult,
  type AgentRunArtifact,
  type AgentRunNextAction,
  type AgentRunRequest,
  type AnalyticalIntentV1,
  type PipelineOutcome,
  type PreparedCandidate,
  type PrepareDeps,
  type RelationalJoinStep,
  type ProviderRunOptions,
  type SemanticCompileOutput,
  type SemanticCompileRequest,
  type VocabularyIndex,
  type PreparedBlock,
  type VocabularyEntry,
} from '@duckcodeailabs/dql-agent';
import { buildProjectVocabulary, normalizeRelationName } from './vocabulary-source.js';

/**
 * THE ASK PIPELINE HOST.
 *
 * Everything the host-neutral pipeline needs from the running server:
 * the vocabulary of the current snapshot, the configured provider, the
 * semantic compiler, the governed join graph, the warehouse, and the
 * conversation store. It returns an `AgentRouteExecutor`, so the engine
 * keeps owning the run lifecycle, artifacts, persistence and the UI shape.
 */

export interface AskPipelineHostDeps {
  projectRoot: string;
  executor: QueryExecutor;
  resolveConnection(request: AgentRunRequest): Promise<ConnectionConfig>;
  getSemanticLayer(): SemanticLayer | undefined;
  getManifest(): { manifest: DQLManifest | undefined; snapshotId: string };
  selectProvider(request: AgentRunRequest): Promise<AgentProvider | undefined>;
  /** Compile on the project's active semantic engine; throws with the engine's message. */
  compileSemantic(request: SemanticCompileRequest, connection: ConnectionConfig): Promise<SemanticCompileOutput>;
  /** The engine `compileSemantic` will use, known before preparation so the binder can speak its dialect. */
  semanticEngine?(): Promise<'native' | 'metricflow-cli' | 'dbt-cloud'>;
  /** Wrap one physical provider call in the run's dispatch ledger. */
  dispatchOptions?(purpose: 'resolve' | 'correct' | 'repair', request: AgentRunRequest): { options: ProviderRunOptions; settle(outcome: 'ok' | 'error' | 'cancelled', error?: unknown): void };
  /** The executed intent of the last usable turn in this thread, when there is one. */
  priorIntent(request: AgentRunRequest): { intent: AnalyticalIntentV1; summary?: string } | undefined;
  guidance?(request: AgentRunRequest): string | undefined;
  buildIdentity?(): Record<string, string>;
  maxRows?: number;
  /** Whether the project allowlists this physical column for an exact literal probe (`agent.runtimeValueGrounding`). */
  literalProbeAllowed?(relation: string, column: string): boolean;
  /** Distinct stored values equal to the literal ignoring case, on an allowlisted column; bounded, equality-predicated. */
  probeLiteral?(relation: string, column: string, value: string, connection: ConnectionConfig): Promise<string[]>;
  /** The entity keys behind a label value on an allowlisted label column (`SELECT DISTINCT key, label ... LIMIT 6`). */
  probeLabelKeys?(relation: string, keyColumn: string, labelColumn: string, value: string, connection: ConnectionConfig): Promise<Array<{ key: string; label: string }>>;
  /**
   * Open a physical trace span for a warehouse statement or a value probe;
   * the host never records SQL or values, only fingerprints and outcomes.
   */
  traceExecution?(request: AgentRunRequest, span: AskHostTraceSpan): { finish(outcome: 'ok' | 'error', extra?: { rowCount?: number; resultFingerprint?: string; safeErrorCode?: string }): void } | undefined;
}

export type AskHostTraceSpan =
  | { name: 'sql.execute'; sqlFingerprint: string; purpose: 'query' | 'fanout_probe'; tier?: 'certified' | 'semantic' | 'relational' | 'exploratory' }
  | { name: 'tool.call'; toolKind: 'search_values'; inputFingerprint: string };

const fingerprintText = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24);

interface VocabularyCacheEntry { key: string; vocabulary: VocabularyIndex }

/**
 * GROUND MEMBER LITERALS. A question says "Ryan byrd"; the warehouse holds
 * "Ryan Byrd". The relational tier compares case-insensitively, the semantic
 * compilers do not, so the literal is looked up once, on columns the project
 * explicitly allowlists, and replaced by the stored value. One stored value
 * is a correction; several are left to the query; none is recorded so the
 * reader learns the member is absent rather than seeing an empty aggregate.
 */
export async function groundIntentLiterals(
  intent: AnalyticalIntentV1,
  vocabulary: VocabularyIndex,
  connection: ConnectionConfig,
  deps: Pick<AskPipelineHostDeps, 'literalProbeAllowed' | 'probeLiteral' | 'probeLabelKeys'>,
): Promise<{ intent: AnalyticalIntentV1; notes: string[] }> {
  const notes: string[] = [];
  const ground = async <T extends { ref: string; op: string; values: unknown[] }>(predicate: T): Promise<T> => {
    if (!(predicate.op === 'eq' || predicate.op === 'in') || !predicate.values.some((value) => typeof value === 'string')) return predicate;
    const entry = vocabulary.get(predicate.ref);
    const relation = entry?.physical?.relation;
    const column = entry?.physical?.column;
    if (!relation || !column || !deps.literalProbeAllowed!(relation, column)) return predicate;
    const values: unknown[] = [];
    for (const value of predicate.values) {
      if (typeof value !== 'string' || !value.trim()) { values.push(value); continue; }
      let stored: string[];
      try { stored = await deps.probeLiteral!(relation, column, value, connection); } catch (error) { notes.push(`${column}: probe failed (${error instanceof Error ? error.message : String(error)})`); values.push(value); continue; }
      if (stored.length === 1 && stored[0] !== value) { notes.push(`${column}: ${JSON.stringify(value)} is stored as ${JSON.stringify(stored[0])}`); values.push(stored[0]); }
      else if (stored.length === 0) { notes.push(`${column}: no stored value matches ${JSON.stringify(value)}`); values.push(value); }
      else values.push(value);
    }
    return { ...predicate, values };
  };
  const filters = [] as AnalyticalIntentV1['filters'];
  for (const predicate of intent.filters) filters.push(await ground(predicate));
  const measures = [] as AnalyticalIntentV1['measures'];
  for (const measure of intent.measures) {
    if (!measure.scope?.length) { measures.push(measure); continue; }
    const scope = [] as NonNullable<AnalyticalIntentV1['measures'][number]['scope']>;
    for (const predicate of measure.scope) scope.push(await ground(predicate));
    measures.push({ ...measure, scope });
  }
  let next: AnalyticalIntentV1 = { ...intent, filters, measures };
  // IDENTITY. A singular label ("Ryan Byrd") can name several members. The
  // keys behind the label are looked up on the same allowlist; several keys
  // make the answer one row per member, keyed, with the label displayed,
  // never one merged number.
  if (deps.probeLabelKeys) {
    for (const predicate of next.filters) {
      if (!(predicate.op === 'eq' || predicate.op === 'in') || predicate.values.length !== 1 || typeof predicate.values[0] !== 'string') continue;
      const entry = vocabulary.get(predicate.ref);
      const relation = entry?.physical?.relation;
      const column = entry?.physical?.column;
      if (!entry || !relation || !column || !entry.roles.includes('label') || !deps.literalProbeAllowed!(relation, column)) continue;
      const owner = vocabulary.entries.find((candidate) => candidate.kind === 'entity' && candidate.model === entry.model && candidate.entityType === 'primary' && candidate.physical?.relation === relation && candidate.physical.column);
      if (!owner?.physical?.column) continue;
      let members: Array<{ key: string; label: string }>;
      try { members = await deps.probeLabelKeys(relation, owner.physical.column, column, predicate.values[0], connection); } catch (error) { notes.push(`${column}: key probe failed (${error instanceof Error ? error.message : String(error)})`); continue; }
      const keys = [...new Set(members.map((member) => member.key))];
      if (keys.length <= 1) { if (keys.length === 1) notes.push(`identity: ${JSON.stringify(predicate.values[0])} identifies one ${owner.name}`); continue; }
      const keyed = next.groupBy.some((group) => group.ref === owner.ref);
      next = {
        ...next,
        groupBy: keyed ? next.groupBy : [{ ref: owner.ref, role: 'key' }, ...next.groupBy],
        display: next.display.includes(predicate.ref) ? next.display : [...next.display, predicate.ref],
        expectedShape: next.expectedShape === 'scalar' || next.expectedShape === 'comparison' || next.expectedShape === 'lookup' ? 'grouped' : next.expectedShape,
        provenance: { ...next.provenance, [owner.ref]: next.provenance[owner.ref] ?? `host:${keys.length} ${owner.name}s share ${JSON.stringify(predicate.values[0])}; one row per ${owner.name}` },
      };
      notes.push(`identity: ${keys.length} ${owner.name}s share the name ${JSON.stringify(predicate.values[0])}; one row per ${owner.name}, keyed by ${owner.physical.column}`);
    }
  }
  return { intent: next, notes };
}

/** Value probes are tool calls in the physical trace: one `search_values` span each, fingerprints only. */
export function tracedProbes(deps: Pick<AskPipelineHostDeps, 'literalProbeAllowed' | 'probeLiteral' | 'probeLabelKeys' | 'traceExecution'>, request: AgentRunRequest): Pick<AskPipelineHostDeps, 'literalProbeAllowed' | 'probeLiteral' | 'probeLabelKeys'> {
  if (!deps.traceExecution) return deps;
  const traced = async <T>(input: string, work: () => Promise<T>): Promise<T> => {
    const span = deps.traceExecution!(request, { name: 'tool.call', toolKind: 'search_values', inputFingerprint: fingerprintText(input) });
    try { const value = await work(); span?.finish('ok'); return value; } catch (error) { span?.finish('error', { safeErrorCode: 'probe_failure' }); throw error; }
  };
  return {
    literalProbeAllowed: deps.literalProbeAllowed,
    ...(deps.probeLiteral ? { probeLiteral: (relation, column, value, connection) => traced(`${relation}.${column}=${value}`, () => deps.probeLiteral!(relation, column, value, connection)) } : {}),
    ...(deps.probeLabelKeys ? { probeLabelKeys: (relation, key, label, value, connection) => traced(`${relation}.${key}/${label}=${value}`, () => deps.probeLabelKeys!(relation, key, label, value, connection)) } : {}),
  };
}

/**
 * Join paths over the relationships the team declared in Domain Studio.
 * Each relationship names two modeling entities bound to dbt models, with
 * the key pairs; a breadth-first walk over the undirected graph finds the
 * shortest declared path between two physical relations. Deprecated or
 * rejected relationships never join; a draft one does, and the proof says so.
 */
export function modelingJoinPaths(manifest: DQLManifest | undefined, quoteRelation: (relation: string) => string): (fromRelation: string, toRelation: string) => RelationalJoinStep[] | undefined {
  const modeling = manifest?.modeling;
  if (!modeling) return () => undefined;
  const relationOfEntity = new Map<string, string>();
  for (const entity of Object.values(modeling.entities ?? {})) {
    const relation = normalizeRelationName(manifest?.dbtProvenance?.nodes[entity.dbtUniqueId]?.relation);
    if (!relation) continue;
    for (const key of [entity.id, entity.localId, entity.qualifiedId]) if (key) relationOfEntity.set(key, relation);
  }
  const edges = new Map<string, Array<{ relation: string; on: string }>>();
  const addEdge = (from: string, to: string, on: string) => {
    if (!edges.has(from)) edges.set(from, []);
    edges.get(from)!.push({ relation: to, on });
  };
  for (const relationship of Object.values(modeling.relationships ?? {})) {
    if (relationship.status === 'deprecated') continue;
    const from = relationOfEntity.get(relationship.from);
    const to = relationOfEntity.get(relationship.to);
    if (!from || !to || from === to || relationship.keys.length === 0) continue;
    const on = relationship.keys.map((key) => `${quoteRelation(from)}.${key.from} = ${quoteRelation(to)}.${key.to}`).join(' AND ');
    addEdge(from, to, on);
    addEdge(to, from, on);
  }
  return (fromRelation, toRelation) => {
    if (fromRelation === toRelation) return [];
    const previous = new Map<string, { relation: string; on: string }>();
    const queue = [fromRelation];
    const seen = new Set([fromRelation]);
    while (queue.length) {
      const current = queue.shift()!;
      for (const edge of edges.get(current) ?? []) {
        if (seen.has(edge.relation)) continue;
        seen.add(edge.relation);
        previous.set(edge.relation, { relation: current, on: edge.on });
        if (edge.relation === toRelation) {
          const steps: RelationalJoinStep[] = [];
          for (let at = toRelation; at !== fromRelation;) {
            const step = previous.get(at)!;
            steps.unshift({ relation: at, on: step.on });
            at = step.relation;
          }
          return steps;
        }
        queue.push(edge.relation);
      }
    }
    return undefined;
  };
}

/** Date cells become ISO instants so every consumer reads one calendar value. */
export function normalizeExecutedRow(row: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      out[key] = Number.isFinite(value.getTime()) ? value.toISOString() : null;
      changed = true;
    } else out[key] = value;
  }
  return changed ? out : row;
}

export function createAskPipelineRouteExecutor(deps: AskPipelineHostDeps): AgentRouteExecutor {
  let vocabularyCache: VocabularyCacheEntry | undefined;
  const preparationCache = new Map<string, PreparedCandidate>();

  const vocabularyFor = (): VocabularyIndex => {
    const { manifest, snapshotId } = deps.getManifest();
    const layer = deps.getSemanticLayer();
    const key = `${snapshotId}|${layer ? layer.listCubes().map((cube) => cube.name).join(',') : 'no-semantic'}`;
    if (vocabularyCache?.key === key) return vocabularyCache.vocabulary;
    const vocabulary = buildProjectVocabulary({ ...(layer ? { semanticLayer: layer } : {}), ...(manifest ? { manifest } : {}) });
    vocabularyCache = { key, vocabulary };
    // Debug aid: DQL_ASK_PIPELINE_DUMP_VOCABULARY=<file> writes the cards the interpreter reads.
    if (process.env.DQL_ASK_PIPELINE_DUMP_VOCABULARY) {
      try { writeFileSync(process.env.DQL_ASK_PIPELINE_DUMP_VOCABULARY, `${vocabulary.renderCards({ maxChars: 1_000_000 })}\n`); } catch { /* debug only */ }
    }
    return vocabulary;
  };

  const prepareDeps = (connection: ConnectionConfig, vocabulary: VocabularyIndex, engine?: PrepareDeps['engine']): PrepareDeps => {
    const layer = deps.getSemanticLayer();
    const dialect = getDialect(connection.driver);
    const relationOfCube = new Map<string, string>();
    const cubeOfRelation = new Map<string, string>();
    for (const cube of layer?.listCubes() ?? []) {
      const relation = normalizeRelationName(cube.table) ?? cube.name;
      relationOfCube.set(cube.name, relation);
      cubeOfRelation.set(relation, cube.name);
    }
    const quoteRelation = (relation: string) => relation.split('.').map((part) => dialect.quoteIdentifier(part)).join('.');
    const semanticJoinPath = (fromRelation: string, toRelation: string): RelationalJoinStep[] | undefined => {
      if (!layer) return undefined;
      const from = cubeOfRelation.get(fromRelation);
      const to = cubeOfRelation.get(toRelation);
      if (!from || !to) return undefined;
      const path = layer.findJoinPath(from, to);
      if (path.length === 0) return undefined;
      return path.map((join) => {
        const left = relationOfCube.get(join.left) ?? join.left;
        const right = relationOfCube.get(join.right) ?? join.right;
        return { relation: right, on: join.sql.replace(/\$\{left\}/g, quoteRelation(left)).replace(/\$\{right\}/g, quoteRelation(right)) };
      });
    };
    const declaredJoinPath = modelingJoinPaths(deps.getManifest().manifest, quoteRelation);
    return {
      ...(layer ? { compileSemantic: (request) => deps.compileSemantic(request, connection) } : {}),
      // Two governed join sources, in order: the semantic layer's entity
      // joins, then the relationships the team declared in Domain Studio.
      joinPath: (fromRelation, toRelation) => semanticJoinPath(fromRelation, toRelation) ?? declaredJoinPath(fromRelation, toRelation),
      dialect: { quoteIdentifier: (name) => dialect.quoteIdentifier(name), dateTrunc: (grain, expr) => dialect.dateTrunc(grain, expr), limitClause: (limit) => dialect.limitClause(limit) },
      blockSql: (ref) => vocabulary.get(ref)?.sql,
      prepareBlock: (ref, context) => prepareBlockForAsk(deps.projectRoot, vocabulary.get(ref), context, connection?.driver),
      ...(engine ? { engine } : {}),
    };
  };

  return async ({ runId, request, emit }) => {
    const startedAt = Date.now();
    const vocabulary = vocabularyFor();
    const provider = await deps.selectProvider(request);
    if (!provider) {
      return failure(runId, 'No AI model is configured for this project, so the question could not be interpreted.', 'provider_error', startedAt);
    }
    // Interpretation never needs a warehouse: a greeting, a definition, a
    // clarification or a modeling gap is answered without one. A missing
    // connection surfaces verbatim at the first execution instead.
    let connection: ConnectionConfig | undefined;
    let connectionError: unknown;
    try {
      connection = await deps.resolveConnection(request);
    } catch (error) {
      connectionError = error;
    }
    const prior = request.threadId ? deps.priorIntent(request) : undefined;
    let engine: PrepareDeps['engine'];
    try { engine = await deps.semanticEngine?.(); } catch { engine = undefined; }
    emit({ type: 'executor.started', message: prior ? 'Reading the question as an edit of the previous analysis.' : 'Reading the question against the governed vocabulary.', route: 'generated_answer' });
    const outcome = await runAskPipeline({
      question: request.question,
      vocabulary,
      provider: withLedger(provider, deps, request),
      prepareDeps: prepareDeps(connection ?? { driver: 'duckdb' } as ConnectionConfig, vocabulary, engine),
      executeDeps: {
        maxRows: deps.maxRows ?? 500,
        run: async (sql, params, options) => {
          if (!connection) throw connectionError instanceof Error ? connectionError : new Error(String(connectionError ?? 'No database connection is configured.'));
          // A relation this connection has already proven it cannot see is
          // refused before SQL: the catalog lists it, the warehouse does not
          // have it, and a second round trip would say the same thing.
          const cacheKey = connectionKey(connection);
          const known = knownMissingRelation(cacheKey, sql);
          if (known) throw new Error(`'${known}' is known to be missing on this connection: the catalog lists it, the warehouse does not have it`);
          const started = Date.now();
          const executor = deps.executor as QueryExecutor & { executePositional?: QueryExecutor['executePositional'] };
          const span = deps.traceExecution?.(request, { name: 'sql.execute', sqlFingerprint: fingerprintText(`${sql}\n${JSON.stringify(params ?? [])}`), purpose: options.purpose ?? 'query', ...(options.tier ? { tier: options.tier } : {}) });
          let result: Awaited<ReturnType<QueryExecutor['executeQuery']>>;
          try {
            result = typeof executor.executePositional === 'function'
              ? await executor.executePositional(sql, params ?? [], connection, { maxRows: options.maxRows })
              : await (async () => {
                if (params?.length) throw new Error('this warehouse executor cannot bind positional parameters');
                return executor.executeQuery(sql, [], {}, connection);
              })();
          } catch (error) {
            span?.finish('error', { safeErrorCode: 'sql_failure' });
            recordRelationEvidence(cacheKey, sql, classifyWarehouseError(error instanceof Error ? error.message : String(error)));
            throw error;
          }
          recordRelationEvidence(cacheKey, sql);
          span?.finish('ok', { rowCount: result.rowCount, resultFingerprint: createHash('sha256').update(JSON.stringify({ columns: result.columns, rows: result.rows })).digest('hex') });
          // An executor may describe columns as objects or as bare names.
          const columns = result.columns.length
            ? (result.columns as Array<string | { name?: string }>).map((column, index) => typeof column === 'string' ? column : column?.name ?? Object.keys(result.rows[0] ?? {})[index] ?? `column_${index + 1}`)
            : Object.keys(result.rows[0] ?? {});
          // Calendar cells leave the warehouse as JS Dates; every consumer
          // (narration, persistence, the table) must read the same instant,
          // never a host-timezone rendering of it.
          const rows = (result.rows as Array<Record<string, unknown>>).map((row) => normalizeExecutedRow(row));
          return { columns, rows, rowCount: result.rowCount, executionTimeMs: result.executionTimeMs ?? Date.now() - started, ...(result.truncated ? { truncated: true } : {}) };
        },
      },
      ...(prior ? { prior: prior.intent, priorAnswerSummary: prior.summary } : {}),
      ...(deps.guidance?.(request) ? { guidance: deps.guidance(request) } : {}),
      ...(connection && deps.probeLiteral && deps.literalProbeAllowed ? { groundLiterals: (intent: AnalyticalIntentV1) => groundIntentLiterals(intent, vocabulary, connection, tracedProbes(deps, request)) } : {}),
      explorationOptIn: explorationOptIn(request),
      // Research branches phrase hypotheses ("because", "drivers"); the
      // full-question clause check is for questions a person asked.
      clauseCoverage: request.requestedMode !== 'research',
      // Room for one interpreter retry after a 60 s provider timeout plus
      // the rest of the turn; the engine's own hard deadline still wins.
      deadlineMs: 150_000,
      preparationCache,
      cacheScope: `${deps.getManifest().snapshotId}|${connection?.driver ?? 'none'}|${vocabulary.fingerprint}`,
      ...(deps.buildIdentity ? { build: deps.buildIdentity() } : {}),
      trace: (event) => emit({ type: 'executor.started', message: `${event.stage}${typeof event.detail === 'number' ? ` ${event.detail} ms` : ''}`, route: 'generated_answer' }),
    });
    return toExecutorResult(runId, outcome, startedAt);
  };
}

function explorationOptIn(request: AgentRunRequest): boolean {
  const workspace = request.workspaceContext && typeof request.workspaceContext === 'object' ? request.workspaceContext as Record<string, unknown> : {};
  return workspace.explorationOptIn === true || request.requestedMode === 'sql';
}

/** Every physical call, corrective ones included, passes through the run's ledger. */
function withLedger(provider: AgentProvider, deps: AskPipelineHostDeps, request: AgentRunRequest): AgentProvider {
  if (!deps.dispatchOptions) return provider;
  let calls = 0;
  return {
    name: provider.name,
    available: () => provider.available(),
    generate: async (messages, options) => {
      calls += 1;
      const trace = deps.dispatchOptions!(calls === 1 ? 'resolve' : 'correct', request);
      try {
        const text = await provider.generate(messages, { ...options, ...trace.options });
        trace.settle('ok');
        return text;
      } catch (error) {
        trace.settle('error', error);
        throw error;
      }
    },
  };
}

const sha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function failure(runId: string, message: string, code: 'provider_error' | 'execution_error', startedAt: number): AgentRouteExecutorResult {
  return {
    summary: message, answer: message, status: 'blocked', trustState: 'blocked', stopReason: 'blocked', resolvedRoute: 'generated_answer', answerRefusalCode: code,
    artifacts: [{ id: `${runId}:diagnostic`, kind: 'answer', title: 'Could not answer', trustState: 'blocked', payload: { kind: 'no_answer', text: message, answer: message, executionError: message } }],
    evaluations: [], nextActions: [{ id: 'retry-after-provider', label: 'Retry after fixing the AI model settings', route: 'generated_answer' }],
    telemetry: { version: 1, stageDurationsMs: { total: Date.now() - startedAt }, providerRoundTrips: 0, toolCalls: 0, sqlExecutions: 0, repairs: 0, egressReceipts: 0 },
  };
}

/** How a gap is headed: no matching data is not a modeling gap. */
export function gapPresentation(gap: Extract<PipelineOutcome, { kind: 'gap' }>['gap']): { title: string; code: 'policy_blocked' | 'ambiguous' | 'no_data' | 'modeling_gap' } {
  if (gap === 'denied') return { title: 'Blocked by policy', code: 'policy_blocked' };
  if (gap === 'ambiguous') return { title: 'One detail is missing', code: 'ambiguous' };
  if (gap === 'not_retrieved') return { title: 'No matching data for that period', code: 'no_data' };
  return { title: 'No governed answer', code: 'modeling_gap' };
}

/**
 * A certified block, compiled and bound the way Block Studio, Apps and the
 * Notebook run it: values from the shared invocation contract (declared
 * defaults, values the question states outright, explicit inputs), SQL
 * lowered by the DQL compiler to positional placeholders, and the bound
 * values in placeholder order. No template placeholder survives.
 */
export function prepareBlockForAsk(projectRoot: string, entry: VocabularyEntry | undefined, context: { question?: string }, driver?: string): PreparedBlock | undefined {
  if (!entry || entry.kind !== 'block') return undefined;
  if (!entry.sourcePath) {
    // No declaration on disk: the raw query is only usable without parameters.
    return entry.sql && !/\$\{/.test(entry.sql) ? { sql: entry.sql, params: [], parameters: [] } : { error: 'the block declaration is not available to bind its parameters' };
  }
  let source: string;
  try {
    source = readFileSync(join(projectRoot, entry.sourcePath), 'utf8');
  } catch (error) {
    return { error: `the block source could not be read (${entry.sourcePath}): ${error instanceof Error ? error.message : String(error)}` };
  }
  const invocation = prepareBlockInvocation({ block: entry.name, source, question: context.question, surface: 'ask_ai' });
  if (invocation.errors.length) return { error: invocation.errors.join(' '), unresolved: invocation.unresolvedParameters };
  if (invocation.unresolvedParameters.length) return { error: `it still needs values for ${invocation.unresolvedParameters.join(', ')}`, unresolved: invocation.unresolvedParameters };
  let plan: ReturnType<typeof buildExecutionPlan>;
  try {
    plan = buildExecutionPlan({ id: `ask-${entry.name}`, type: 'dql', source, title: entry.name }, { ...(driver ? { driver } : {}), parameters: invocation.values });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!plan?.sql) return { error: 'the block produced no executable SQL' };
  const specs = [...plan.sqlParams].sort((left, right) => left.position - right.position);
  // The invocation's resolved values win (a question's "top 3" over the declared default); the plan's variables are the declared defaults.
  const params = specs.map((spec) => (invocation.values[spec.name] !== undefined ? invocation.values[spec.name] : plan.variables[spec.name] !== undefined ? plan.variables[spec.name] : spec.literalValue));
  const missing = specs.filter((spec, index) => params[index] === undefined).map((spec) => spec.name);
  if (missing.length) return { error: `no value bound for ${missing.join(', ')}`, unresolved: missing };
  if (/\$\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}/.test(plan.sql)) return { error: 'a template placeholder survived compilation' };
  const sources = new Map(invocation.resolvedParameters.map((parameter) => [parameter.name, parameter.source]));
  return {
    sql: plan.sql,
    params,
    parameters: specs.map((spec, index) => ({ name: spec.name, position: spec.position, value: params[index], source: sources.get(spec.name) ?? 'default' })),
    ...(entry.contract?.outputs?.length ? { outputs: entry.contract.outputs } : {}),
  };
}

/**
 * What a connection has proven it cannot see. The catalog is a snapshot of the
 * project's models; the connection is the warehouse as it is right now. When
 * the two disagree the disagreement is durable for the session: asking the
 * same missing table again costs another failed round trip and tells the
 * reader nothing new, so the second question is refused before SQL.
 */
const missingByConnection = new Map<string, Set<string>>();

/** A stable key for a connection: the account and database, never a credential. */
export function connectionKey(connection: ConnectionConfig): string {
  return [connection.driver, connection.account, connection.host, connection.port, connection.database ?? connection.catalog, connection.filepath, connection.schema]
    .filter((part) => part !== undefined && part !== '')
    .join('|');
}

/** Relation names as SQL writes them, lowercased and unquoted. */
function relationsInSql(sql: string): string[] {
  const found = new Set<string>();
  for (const match of sql.matchAll(/(?:FROM|JOIN)\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)){0,2})/gi)) {
    const name = (match[1] ?? '').replace(/["`[\]]/g, '').replace(/\s+/g, '').toLowerCase();
    if (name) found.add(name);
  }
  return [...found];
}

/** The tail of a qualified name, so dev.orders matches analytics.dev.orders. */
function relationTail(name: string): string {
  const parts = name.toLowerCase().replace(/["`[\]]/g, '').split('.');
  return parts.slice(-2).join('.');
}

/** The relation this query reads that the connection is already known to lack. */
export function knownMissingRelation(key: string, sql: string): string | undefined {
  const missing = missingByConnection.get(key);
  if (!missing || missing.size === 0) return undefined;
  const tails = new Map([...missing].map((name) => [relationTail(name), name]));
  for (const relation of relationsInSql(sql)) {
    const hit = tails.get(relationTail(relation));
    if (hit) return hit;
  }
  return undefined;
}

/** Record what a failed query proved about the connection, and what a successful one disproved. */
export function recordRelationEvidence(key: string, sql: string, failure?: { class: string; relations: string[] }): void {
  if (!failure) {
    const missing = missingByConnection.get(key);
    if (!missing) return;
    for (const relation of relationsInSql(sql)) {
      for (const name of [...missing]) if (relationTail(name) === relationTail(relation)) missing.delete(name);
    }
    return;
  }
  if (failure.class !== 'relation_missing') return;
  const named = failure.relations.length ? failure.relations : relationsInSql(sql);
  if (named.length !== 1) return;
  const missing = missingByConnection.get(key) ?? new Set<string>();
  missing.add(named[0]!);
  missingByConnection.set(key, missing);
}

/** Test seam: forget everything learned about connections. */
export function resetRelationEvidence(): void {
  missingByConnection.clear();
}

export function toExecutorResult(runId: string, outcome: PipelineOutcome, startedAt: number): AgentRouteExecutorResult {
  const receipt = outcome.receipt;
  const telemetry: AgentRouteExecutorResult['telemetry'] = {
    version: 1,
    stageDurationsMs: {
      ...(receipt.timings.resolve !== undefined ? { meaning: receipt.timings.resolve } : {}),
      ...(receipt.timings.execute !== undefined ? { execution: receipt.timings.execute } : {}),
      total: Date.now() - startedAt,
    },
    providerRoundTrips: receipt.dispatches.length,
    toolCalls: receipt.candidates.length + receipt.refusals.length,
    sqlExecutions: receipt.warehouse?.executions ?? (receipt.executed ? 1 : 0),
    ...(receipt.warehouse ? { sqlAttempts: receipt.warehouse.attempts, sqlFailures: receipt.warehouse.failures } : {}),
    repairs: receipt.dispatches.filter((dispatch) => dispatch.purpose.includes('repair')).length,
    egressReceipts: receipt.dispatches.length,
  };
  const common = { askIntentV1: outcome.intent, askPipeline: receipt };
  const withReceipt = <T extends AgentRouteExecutorResult>(result: T): T => ({ ...result, askPipelineReceipt: receipt });
  if (outcome.kind === 'conversation' || outcome.kind === 'definition') {
    return withReceipt({ summary: outcome.kind === 'definition' ? 'Explained a governed definition.' : 'Replied conversationally.', answer: outcome.reply, answerKind: 'conversational', status: 'completed', trustState: 'not_applicable', stopReason: 'conversational_reply', resolvedRoute: 'conversation', artifacts: [], evaluations: [], nextActions: [], telemetry });
  }
  if (outcome.kind === 'clarify') {
    const clarificationOptions: NonNullable<AgentRouteExecutorResult['clarificationOptions']> = outcome.options.map((option) => ({ id: option.ref, label: option.label, ...(option.description ? { description: option.description } : {}), kind: 'vocabulary', question: `${outcome.intent.reading || 'the question'} — ${option.label}` }));
    return withReceipt({ summary: outcome.question, answer: outcome.question, status: 'needs_clarification', trustState: 'not_applicable', stopReason: 'needs_clarification', resolvedRoute: 'clarify', answerRefusalCode: 'ambiguous', clarificationOptions, artifacts: [{ id: `${runId}:clarify`, kind: 'answer', title: 'One question before running this', trustState: 'not_applicable', payload: { kind: 'no_answer', text: outcome.question, answer: outcome.question, ...common } }], evaluations: [], nextActions: [{ id: 'clarify', label: 'Clarify question', route: 'generated_answer' }], telemetry });
  }
  if (outcome.kind === 'gap') {
    const nextActions: AgentRunNextAction[] = [
      { id: 'review-metadata-gap', label: 'Review what the project models', route: 'blocked' },
      ...(outcome.offerExploration ? [{ id: 'explore-review-required', label: 'Explore the physical tables (review-required)', route: 'generated_answer' as const }] : []),
    ];
    const presentation = gapPresentation(outcome.gap);
    return withReceipt({ summary: outcome.text, answer: outcome.text, status: 'blocked', trustState: 'blocked', stopReason: 'blocked', resolvedRoute: 'generated_answer', answerRefusalCode: presentation.code, artifacts: [{ id: `${runId}:gap`, kind: 'answer', title: presentation.title, trustState: 'blocked', payload: { kind: 'no_answer', text: outcome.text, answer: outcome.text, gap: { kind: outcome.gap, message: outcome.message, nearest: outcome.nearest }, ...common } }], evaluations: [], nextActions, telemetry });
  }
  if (outcome.kind === 'failed') {
    return withReceipt({ summary: outcome.text, answer: outcome.text, status: 'blocked', trustState: 'blocked', stopReason: 'blocked', resolvedRoute: 'generated_answer', answerRefusalCode: outcome.stage === 'resolve' ? 'provider_error' : 'execution_error', artifacts: [{ id: `${runId}:failed`, kind: 'answer', title: outcome.stage === 'execute' ? 'The query failed on the warehouse' : 'Could not prepare the query', trustState: 'blocked', payload: { kind: 'no_answer', text: outcome.text, answer: outcome.text, executionError: outcome.message, failedStage: outcome.stage, ...common } }], evaluations: [], nextActions: [{ id: 'review-analytical-failure', label: 'Review the interpretation and the engine message', route: 'blocked' }], telemetry });
  }
  if (outcome.kind !== 'answered') throw new Error(`unreachable pipeline outcome ${String((outcome as { kind: string }).kind)}`);
  const { candidate, result } = outcome;
  const certified = candidate.trust === 'certified';
  // A certified block served as published for a question it cannot answer
  // with identity is evidence: governed trust, the block as its source.
  const blockAsEvidence = candidate.tier === 'certified' && !certified;
  const route = certified ? { tier: 'certified_block', label: 'Certified block' } : blockAsEvidence ? { tier: 'certified_block', label: 'Certified block, served as evidence' } : candidate.tier === 'semantic' ? { tier: 'semantic_metric', label: 'Semantic metric' } : { tier: 'governed_relational', label: 'Governed relational program' };
  const trustState = certified ? 'certified' : 'governed';
  const payload = {
    kind: certified ? 'certified' : 'uncertified',
    route,
    sourceTier: certified || blockAsEvidence ? 'certified_artifact' : candidate.tier === 'semantic' ? 'semantic_layer' : 'dbt_manifest',
    certification: certified ? 'certified' : 'governed',
    reviewStatus: certified ? 'certified' : 'governed',
    text: outcome.text,
    answer: outcome.text,
    sql: candidate.sql,
    ...(candidate.params?.length ? { sqlParams: candidate.params } : {}),
    result: {
      columns: result.columns, rows: result.rows, rowCount: result.rowCount, executionTime: result.executionTimeMs, sql: candidate.sql,
      // Canonical result identity is a bare sha256 hex: every reader of
      // execution proof (Research branches, result follow-ups) validates that shape.
      resultFingerprint: createHash('sha256').update(JSON.stringify({ columns: result.columns, rows: result.rows })).digest('hex'), trustState, answerTier: route.tier, ...(result.truncated ? { truncated: true } : {}),
      // The units contract; absent on legacy results, which render exactly as before.
      ...(result.columnsMeta?.length ? { columnsMeta: result.columnsMeta } : {}),
    },
    ...(candidate.sourceRef ? { certifiedBlockRef: candidate.sourceRef } : {}),
    ...(candidate.artifact !== undefined ? { dqlArtifact: candidate.artifact } : {}),
    proof: [...candidate.proof, ...(receipt.executed?.proofs ?? [])],
    ...common,
  };
  const artifact: AgentRunArtifact = { id: `${runId}:answer`, kind: 'answer', title: certified ? 'Certified answer' : 'Governed answer', trustState, payload };
  return withReceipt({
    summary: outcome.text, answer: outcome.text, status: 'completed', trustState,
    stopReason: certified ? 'certified_answer_found' : 'governed_semantic_answer',
    resolvedRoute: certified ? 'certified_answer' : candidate.tier === 'semantic' ? 'semantic_answer' : 'generated_answer',
    answerTier: route.tier, result: payload.result, artifacts: [artifact],
    evaluations: [
      { id: 'pipeline-interpretation', label: 'Interpretation', passed: true, severity: 'info', message: `Read as: ${outcome.intent.reading || 'the intent below'}` },
      { id: 'pipeline-preparation', label: certified ? 'Certified entailment' : candidate.tier === 'semantic' ? 'Semantic compilation' : 'Governed composition', passed: true, severity: 'info', message: candidate.proof.join(' ') },
      ...(receipt.executed?.proofs ?? []).map((proof, index) => ({ id: `pipeline-execution-${index + 1}`, label: 'Execution proof', passed: true, severity: 'info' as const, message: proof })),
      // Words the reading does not use are never a passed check; the
      // evaluation carries no repair action, so it informs and does not loop.
      ...(receipt.uncovered?.length ? [{ id: 'pipeline-coverage', label: 'Question coverage', passed: false, severity: 'warning' as const, message: `The question mentioned ${receipt.uncovered.map((word) => `"${word}"`).join(', ')}, which this reading does not use. If that was the point, say it explicitly.` }] : []),
      ...(receipt.grounding ?? []).filter((note) => note.startsWith('identity:') && /share the name/.test(note)).map((note, index) => ({ id: `pipeline-identity-${index + 1}`, label: 'Identity', passed: true, severity: 'warning' as const, message: note.slice('identity:'.length).trim() })),
      // A certified block served as published with a label-only grouping
      // says so: the answer cannot keep two same-named entities apart.
      ...(candidate.tier === 'certified' ? candidate.proof.filter((line) => /no identity key/.test(line)).map((line, index) => ({ id: `pipeline-certified-caveat-${index + 1}`, label: 'Certified block identity', passed: false, severity: 'warning' as const, message: `${line.replace(/^the block/, 'The block')}. Recertify it with the entity key to keep same-named members apart.` })) : []),
      // A certified block refused for identity is shown as source evidence
      // beside the keyed governed answer that replaced it.
      ...receipt.refusals.filter((refusal) => refusal.tier === 'certified' && /no identity key/.test(refusal.message)).map((refusal, index) => ({ id: `pipeline-certified-identity-${index + 1}`, label: 'Certified source, not applicable', passed: false, severity: 'warning' as const, message: `${refusal.message.replace(/^block:/, 'Block ')}. The answer is composed by entity key; recertify the block with the key column to serve it as certified.` })),
    ],
    nextActions: [
      ...(receipt.refusals.some((refusal) => refusal.tier === 'certified' && /no identity key/.test(refusal.message)) || (candidate.tier === 'certified' && candidate.proof.some((line) => /no identity key/.test(line))) ? [{ id: 'recertify-with-key', label: 'Recertify this block with the entity key', route: 'dql_block_draft' as const, artifactKind: 'dql_block_draft' as const }] : []),
      { id: 'create-block', label: 'Save as block', route: 'dql_block_draft', artifactKind: 'dql_block_draft' }, { id: 'research-gap', label: 'Research deeper', route: 'research' },
    ],
    telemetry,
  });
}
