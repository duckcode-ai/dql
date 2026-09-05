import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { ConnectionConfig, QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { getDialect, type DQLManifest, type SemanticLayer } from '@duckcodeailabs/dql-core';
import {
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
  /** Wrap one physical provider call in the run's dispatch ledger. */
  dispatchOptions?(purpose: 'resolve' | 'correct' | 'repair', request: AgentRunRequest): { options: ProviderRunOptions; settle(outcome: 'ok' | 'error' | 'cancelled', error?: unknown): void };
  /** The executed intent of the last usable turn in this thread, when there is one. */
  priorIntent(request: AgentRunRequest): { intent: AnalyticalIntentV1; summary?: string } | undefined;
  guidance?(request: AgentRunRequest): string | undefined;
  buildIdentity?(): Record<string, string>;
  maxRows?: number;
}

interface VocabularyCacheEntry { key: string; vocabulary: VocabularyIndex }

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

  const prepareDeps = (connection: ConnectionConfig, vocabulary: VocabularyIndex): PrepareDeps => {
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
    };
  };

  return async ({ runId, request, emit }) => {
    const startedAt = Date.now();
    const vocabulary = vocabularyFor();
    const provider = await deps.selectProvider(request);
    if (!provider) {
      return failure(runId, 'No AI model is configured for this project, so the question could not be interpreted.', 'provider_error', startedAt);
    }
    const connection = await deps.resolveConnection(request);
    const prior = request.threadId ? deps.priorIntent(request) : undefined;
    emit({ type: 'executor.started', message: prior ? 'Reading the question as an edit of the previous analysis.' : 'Reading the question against the governed vocabulary.', route: 'generated_answer' });
    const outcome = await runAskPipeline({
      question: request.question,
      vocabulary,
      provider: withLedger(provider, deps, request),
      prepareDeps: prepareDeps(connection, vocabulary),
      executeDeps: {
        maxRows: deps.maxRows ?? 500,
        run: async (sql, params, options) => {
          const started = Date.now();
          const executor = deps.executor as QueryExecutor & { executePositional?: QueryExecutor['executePositional'] };
          const result = typeof executor.executePositional === 'function'
            ? await executor.executePositional(sql, params ?? [], connection, { maxRows: options.maxRows })
            : await (async () => {
              if (params?.length) throw new Error('this warehouse executor cannot bind positional parameters');
              return executor.executeQuery(sql, [], {}, connection);
            })();
          const columns = result.columns.length ? result.columns.map((column) => column.name) : Object.keys(result.rows[0] ?? {});
          return { columns, rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount, executionTimeMs: result.executionTimeMs ?? Date.now() - started, ...(result.truncated ? { truncated: true } : {}) };
        },
      },
      ...(prior ? { prior: prior.intent, priorAnswerSummary: prior.summary } : {}),
      ...(deps.guidance?.(request) ? { guidance: deps.guidance(request) } : {}),
      explorationOptIn: explorationOptIn(request),
      deadlineMs: 120_000,
      preparationCache,
      cacheScope: `${deps.getManifest().snapshotId}|${connection.driver}|${vocabulary.fingerprint}`,
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
    sqlExecutions: receipt.executed ? 1 : 0,
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
    return withReceipt({ summary: outcome.text, answer: outcome.text, status: 'blocked', trustState: 'blocked', stopReason: 'blocked', resolvedRoute: 'generated_answer', answerRefusalCode: outcome.gap === 'denied' ? 'policy_blocked' : outcome.gap === 'ambiguous' ? 'ambiguous' : 'modeling_gap', artifacts: [{ id: `${runId}:gap`, kind: 'answer', title: 'No governed answer', trustState: 'blocked', payload: { kind: 'no_answer', text: outcome.text, answer: outcome.text, gap: { kind: outcome.gap, message: outcome.message, nearest: outcome.nearest }, ...common } }], evaluations: [], nextActions, telemetry });
  }
  if (outcome.kind === 'failed') {
    return withReceipt({ summary: outcome.text, answer: outcome.text, status: 'blocked', trustState: 'blocked', stopReason: 'blocked', resolvedRoute: 'generated_answer', answerRefusalCode: outcome.stage === 'resolve' ? 'provider_error' : 'execution_error', artifacts: [{ id: `${runId}:failed`, kind: 'answer', title: outcome.stage === 'execute' ? 'The query failed on the warehouse' : 'Could not prepare the query', trustState: 'blocked', payload: { kind: 'no_answer', text: outcome.text, answer: outcome.text, executionError: outcome.message, failedStage: outcome.stage, ...common } }], evaluations: [], nextActions: [{ id: 'review-analytical-failure', label: 'Review the interpretation and the engine message', route: 'blocked' }], telemetry });
  }
  if (outcome.kind !== 'answered') throw new Error(`unreachable pipeline outcome ${String((outcome as { kind: string }).kind)}`);
  const { candidate, result } = outcome;
  const certified = candidate.trust === 'certified';
  const route = certified ? { tier: 'certified_block', label: 'Certified block' } : candidate.tier === 'semantic' ? { tier: 'semantic_metric', label: 'Semantic metric' } : { tier: 'governed_relational', label: 'Governed relational program' };
  const trustState = certified ? 'certified' : 'governed';
  const payload = {
    kind: certified ? 'certified' : 'uncertified',
    route,
    sourceTier: certified ? 'certified_artifact' : candidate.tier === 'semantic' ? 'semantic_layer' : 'dbt_manifest',
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
      ...(receipt.uncovered?.length ? [{ id: 'pipeline-coverage', label: 'Question coverage', passed: true, severity: 'warning' as const, message: `The question mentioned ${receipt.uncovered.map((word) => `"${word}"`).join(', ')}, which this reading does not use. If that was the point, say it explicitly.` }] : []),
    ],
    nextActions: [{ id: 'create-block', label: 'Save as block', route: 'dql_block_draft', artifactKind: 'dql_block_draft' }, { id: 'research-gap', label: 'Research deeper', route: 'research' }],
    telemetry,
  });
}
