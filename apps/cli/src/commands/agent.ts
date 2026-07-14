/**
 * `dql agent` — block-first answer loop on the command line.
 *
 *   dql agent ask "what was revenue last week?"
 *     [--provider claude|openai|gemini|ollama]
 *     [--user alice@acme.com]   (filters Skills + records feedback as this user)
 *     [--domain growth] [--purpose growth_attribution]
 *     [--format json]           (emits structured JSON instead of prose)
 *     [--thread <id>]           (continue a persisted conversation thread: the
 *                                question runs through the runtime's agent-run
 *                                engine, which injects prior turns and records
 *                                this one server-side)
 *
 *   dql agent threads
 *     Lists persisted conversation threads (id, updated, title) from the runtime.
 *
 *   dql agent reindex [path]
 *     Rebuilds .dql/cache/agent-kg.sqlite and metadata.sqlite from the
 *     project's manifest + Skills folder. Equivalent to `dql app reindex`.
 *
 *   dql agent feedback <up|down> --block <id> --question "..."
 *     Records feedback into the KG. Used by clients without MCP access.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import {
  KGStore,
  MemoryStore,
  defaultKgPath,
  defaultMemoryPath,
  reindexProject,
  loadSkills,
  pickProvider,
  answer,
  resolveDomainContextEnvelope,
  buildAnalysisQuestionPlan,
  buildLocalContextPack,
  coerceReasoningEffort,
  contextRetrievalBudgetForQuestion,
  deriveGeneratedDraftSlug,
  loadAgentSemanticLayer,
  recordQueryRun,
  recordRuntimeSchemaSnapshot,
  type ProviderName,
  upsertGeneratedDqlArtifactDraft,
  upsertGeneratedDraft,
  validateSqlAgainstLocalContext,
  type AgentAnswer,
  type AgentFollowUpContext,
  type AgentResultPayload,
  type AgentSchemaTable,
  type AnalysisDepth,
  type ReasoningEffort,
} from '@duckcodeailabs/dql-agent';
import { buildManifest, resolveDbtManifestPath } from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';
import { buildAnswerLoopTools, createGroundingContextExpander } from '../llm/answer-loop-tools.js';
import { judgeAnswer, type JudgeCompletion } from './eval-judge.js';
import { startProjectRuntime } from './notebook.js';

/**
 * Resolve the runtime the agent posts certified blocks / generated SQL to.
 *
 * If the caller pinned one (`--runtime-url` / `DQL_RUNTIME_URL`) we validate it is
 * actually a reachable DQL runtime — a bare `/api/health` is not enough, since
 * unrelated servers (e.g. Docker on :3474) answer `{"status":"ok"}` and would then
 * swallow the block with a misleading "no connection" error. Otherwise we start an
 * ephemeral runtime bound to THIS project on a free port and close it when done, so
 * there is no hardcoded-port collision and the runtime always matches the project.
 */
async function resolveAgentRuntime(
  projectRoot: string,
  flags: CLIFlags,
): Promise<{ runtimeBase: string; close: () => Promise<void> }> {
  const explicit = (flags as { runtimeUrl?: string; runtime?: string }).runtimeUrl
    ?? (flags as { runtime?: string }).runtime
    ?? process.env.DQL_RUNTIME_URL;
  if (explicit) {
    const base = explicit.replace(/\/$/, '');
    if (!(await isDqlRuntime(base))) {
      throw new Error(
        `No DQL runtime is reachable at ${base}. Start one with \`dql notebook\`, or omit ` +
          `--runtime-url / DQL_RUNTIME_URL to let \`dql agent ask\` start an ephemeral runtime.`,
      );
    }
    return { runtimeBase: base, close: async () => {} };
  }
  const handle = await startProjectRuntime(projectRoot, { preferredPort: 0 });
  return { runtimeBase: handle.url, close: handle.close };
}

async function fetchRuntimeSchemaContext(runtimeBase: string): Promise<AgentSchemaTable[]> {
  try {
    const response = await fetch(`${runtimeBase.replace(/\/$/, '')}/api/schema`);
    if (!response.ok) return [];
    const raw = await response.json();
    if (!Array.isArray(raw)) return [];
    return raw
      .map(normalizeRuntimeSchemaTable)
      .filter((table): table is AgentSchemaTable => Boolean(table))
      .slice(0, 500);
  } catch {
    return [];
  }
}

function normalizeRuntimeSchemaTable(raw: unknown): AgentSchemaTable | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const table = raw as Record<string, unknown>;
  const relation = cleanRuntimeSchemaString(table.path) ?? cleanRuntimeSchemaString(table.name);
  if (!relation) return undefined;
  const columns = Array.isArray(table.columns)
    ? table.columns
        .map(normalizeRuntimeSchemaColumn)
        .filter((column): column is AgentSchemaTable['columns'][number] => Boolean(column))
        .slice(0, 120)
    : [];
  return {
    relation,
    name: cleanRuntimeSchemaString(table.name) ?? relation.split('.').pop() ?? relation,
    source: cleanRuntimeSchemaString(table.source) ?? 'runtime schema',
    columns,
  };
}

function normalizeRuntimeSchemaColumn(raw: unknown): AgentSchemaTable['columns'][number] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const column = raw as Record<string, unknown>;
  const name = cleanRuntimeSchemaString(column.name);
  if (!name) return undefined;
  return {
    name,
    type: cleanRuntimeSchemaString(column.type),
    description: cleanRuntimeSchemaString(column.description),
  };
}

function recordCliRuntimeSchemaSnapshot(projectRoot: string, schemaContext: AgentSchemaTable[], source: string): void {
  if (schemaContext.length === 0) return;
  try {
    recordRuntimeSchemaSnapshot(projectRoot, {
      source,
      tables: schemaContext.map((table) => ({
        relation: table.relation,
        schema: table.schema,
        name: table.name,
        description: table.description,
        source: table.source,
        columns: table.columns.map((column) => ({
          name: column.name,
          type: column.type,
          description: column.description,
          sampleValues: column.sampleValues?.slice(0, 8),
        })),
      })),
    });
  } catch {
    // Runtime schema snapshots are advisory local metadata and must not block answers.
  }
}

function cleanRuntimeSchemaString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function cliReasoningEffort(flags: CLIFlags): ReasoningEffort | undefined {
  return coerceReasoningEffort(flags.reasoningEffort);
}

function cliAnalysisDepth(flags: CLIFlags): AnalysisDepth | undefined {
  const value = flags.analysisDepth?.trim().toLowerCase();
  return value === 'quick' || value === 'deep' ? value : undefined;
}

/** A DQL runtime answers `/api/connections` with a connector/connection payload. */
async function isDqlRuntime(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/api/connections`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return false;
    const body = (await response.json()) as Record<string, unknown>;
    return 'connectorStatus' in body || 'dbtProfiles' in body || 'connections' in body;
  } catch {
    return false;
  }
}

export async function runAgent(
  sub: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  switch (sub) {
    case 'ask':
      return runAsk(rest, flags);
    case 'threads':
      return runThreads(flags);
    case 'reindex':
      return runReindex(rest, flags);
    case 'feedback':
      return runFeedback(rest, flags);
    case 'eval':
      return runEval(rest, flags);
    default:
      throw new Error(
        'Usage: dql agent <ask|threads|reindex|feedback|eval> [args]\n' +
            '  dql agent ask "<question>" [--provider claude|openai|gemini|ollama] [--user <id>] [--domain <d>] [--purpose <approved-purpose>] [--thread <id>]\n' +
      '  dql agent threads [--runtime-url <url>]\n' +
      '  dql agent reindex [path]\n' +
      '  dql agent feedback up|down --block <id> --question "..."\n' +
      '  dql agent eval agent-evals.yml [--provider claude|openai|gemini|ollama] [--execute] [--save]',
        );
  }
}

async function runAsk(rest: string[], flags: CLIFlags): Promise<void> {
  const question = rest.join(' ').trim();
  if (!question) throw new Error('Usage: dql agent ask "<question>"');

  // Thread-scoped ask: hand the question to the runtime's agent-run engine with
  // the thread id, so the SERVER injects prior turns and persists this run as a
  // new turn (the same conversation store the notebook UI uses).
  const threadId = (flags as { thread?: string }).thread;
  if (threadId) return runThreadAsk(question, threadId, flags);

  const projectRoot = findProjectRoot(process.cwd());
  const kgPath = defaultKgPath(projectRoot);
  await reindexProject(projectRoot, { kgPath });

  const providerName = (flags as { provider?: string }).provider as ProviderName | undefined;
  const userId = (flags as { user?: string }).user;
  const domain = (flags as { domain?: string }).domain;
  const purpose = flags.purpose || undefined;
  const format = (flags as { format?: string }).format;
  const reasoningEffort = cliReasoningEffort(flags);
  const requestedDepth = cliAnalysisDepth(flags);

  const provider = await pickProvider(providerName);
  const kg = new KGStore(kgPath);
  const memory = new MemoryStore(defaultMemoryPath(projectRoot));
  const { skills } = loadSkills(projectRoot);

  let closeRuntime: (() => Promise<void>) | undefined;
  try {
    const memoryContext = memory.search({
      query: question,
      scopes: ['project', 'user', 'artifact'],
      limit: 6,
    });
    const semanticLayer = loadAgentSemanticLayer(projectRoot);
    const questionPlan = buildAnalysisQuestionPlan(question);
    const contextBudget = contextRetrievalBudgetForQuestion({
      questionPlan,
      requestedDepth,
      reasoningEffort,
    });
    const manifest = buildManifest({ projectRoot, dbtManifestPath: resolveDbtManifestPath(projectRoot) ?? undefined });
    const domainContext = domain ? resolveDomainContextEnvelope({ manifest, activeDomain: domain, purpose, source: 'explicit_api' }) : undefined;
    const { runtimeBase, close } = await resolveAgentRuntime(projectRoot, flags);
    closeRuntime = close;
    const schemaContext = await fetchRuntimeSchemaContext(runtimeBase);
    recordCliRuntimeSchemaSnapshot(projectRoot, schemaContext, 'direct CLI runtime schema');
    const contextPack = await buildLocalContextPack(projectRoot, {
      question,
      surface: 'cli',
      strictness: contextBudget.strictness,
      limit: contextBudget.limit,
      domainContext,
      runtimeSchemaSnapshot: schemaContext.length > 0
        ? {
            source: 'direct CLI runtime schema',
            tables: schemaContext,
          }
        : undefined,
    }).catch(() => undefined);
    const answerLoopTools = buildAnswerLoopTools(projectRoot);
    const result = await answer({
      question,
      provider,
      kg,
      manifest,
      skills,
      userId,
      domain,
      domainContext,
      memoryContext,
      semanticLayer,
      schemaContext,
      contextPack,
      reasoningEffort,
      analysisDepth: contextBudget.analysisDepth,
      expandGroundingContext: createGroundingContextExpander(projectRoot),
      answerLoopTools,
      executeCertifiedBlock: async (node) => {
        const block = manifest.blocks[node.name] ?? manifest.blocks[node.nodeId.replace(/^block:/, '')];
        if (!block) throw new Error(`Matched block ${node.name} is not present in the manifest.`);
        const source = readFileSync(join(projectRoot, block.filePath), 'utf-8');
        const response = await fetch(`${runtimeBase.replace(/\/$/, '')}/api/notebook/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cell: {
              id: `agent-${node.name}`,
              type: 'dql',
              source,
              title: node.name,
            },
          }),
        });
        if (!response.ok) throw new Error(`Runtime returned ${response.status}: ${await response.text()}`);
        const payload = (await response.json()) as {
          result?: {
            columns?: unknown[];
            rows?: unknown[];
            rowCount?: number;
            executionTime?: number;
          };
          error?: string;
        };
        if (payload.error) throw new Error(payload.error);
        const rows = Array.isArray(payload.result?.rows) ? payload.result.rows : [];
        const result = {
          columns: Array.isArray(payload.result?.columns) ? payload.result.columns : [],
          rows,
          rowCount: typeof payload.result?.rowCount === 'number' ? payload.result.rowCount : rows.length,
          executionTime: payload.result?.executionTime,
          blockName: node.name,
        };
        recordCliQueryRun(projectRoot, {
          objectKey: `dql:block:${node.name}`,
          source: 'certified_block',
          status: 'executed',
          rowCount: result.rowCount,
          durationMs: result.executionTime,
          payload: { question, blockName: node.name },
        });
        return result;
      },
        executeGeneratedSql: async (sql) => {
        const response = await fetch(`${runtimeBase.replace(/\/$/, '')}/api/notebook/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cell: {
              id: `agent-generated-${Date.now().toString(36)}`,
              type: 'sql',
              source: sql,
              title: question,
            },
          }),
        });
        if (!response.ok) throw new Error(`Runtime returned ${response.status}: ${await response.text()}`);
        const payload = (await response.json()) as {
          result?: {
            columns?: unknown[];
            rows?: unknown[];
            rowCount?: number;
            executionTime?: number;
          };
          error?: string;
        };
        if (payload.error) throw new Error(payload.error);
        const rows = Array.isArray(payload.result?.rows) ? payload.result.rows : [];
        const result = {
          columns: Array.isArray(payload.result?.columns) ? payload.result.columns : [],
          rows,
          rowCount: typeof payload.result?.rowCount === 'number' ? payload.result.rowCount : rows.length,
          executionTime: payload.result?.executionTime,
          sql,
        };
        recordCliQueryRun(projectRoot, {
          source: 'ai_draft',
          status: 'executed',
          rowCount: result.rowCount,
          durationMs: result.executionTime,
          payload: { question, sql },
          });
          return result;
        },
        captureGeneratedDraft: ({ question: draftQuestion, sql, intent, followUp, contextPack, sourceBlock, sourceDqlArtifact, dqlArtifact, proposedEntity, requestedFilters, requestedDimensions, validationWarnings, outputs }) => {
          const slug = deriveGeneratedDraftSlug(draftQuestion);
          const proposedDomain = sourceBlock?.domain ?? contextPack?.objects.find((object) => object.domain)?.domain ?? domain ?? 'misc';
          if (dqlArtifact?.kind === 'semantic_block') {
            return upsertGeneratedDqlArtifactDraft(projectRoot, {
              slug,
              question: draftQuestion,
              proposedContractId: `${proposedDomain}.Unknown.${slug}`,
              proposedDomain,
              dqlArtifact,
              sourceQuestion: followUp?.sourceQuestion,
              sourceBlock: followUp?.sourceBlockName ?? sourceBlock?.name,
              followupKind: followUp?.kind,
              outputs,
              contextPackId: contextPack?.id,
              routeIntent: String(intent),
              validationWarnings,
            });
          }
          return upsertGeneratedDraft(projectRoot, {
            slug,
            question: draftQuestion,
            proposedSql: sql,
            proposedContractId: `${proposedDomain}.Unknown.${slug}`,
            proposedDomain,
            proposedEntity,
            sourceDqlArtifact,
            sourceQuestion: followUp?.sourceQuestion,
            sourceBlock: followUp?.sourceBlockName ?? sourceBlock?.name,
            followupKind: followUp?.kind,
            requestedFilters,
            requestedDimensions,
            outputs,
            contextPackId: contextPack?.id,
            routeIntent: String(intent),
            validationWarnings,
          });
        },
      });

    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const badge = result.kind === 'certified'
      ? '✓ Certified'
      : result.kind === 'uncertified'
        ? '! AI-generated · uncertified'
        : '? No answer';
    const cite = result.citations.length > 0
      ? '\n\nCitations:\n' + result.citations.map((c) => `  - ${c.kind} \`${c.name}\`${c.gitSha ? ` · ${c.gitSha.slice(0, 8)}` : ''}`).join('\n')
      : '';
    const footer = result.provenanceFooter ? `\n\n— ${result.provenanceFooter}` : '';
    console.log(`${badge}\n\n${result.text}${footer}${cite}`);
    if (result.result) {
      console.log(`\nRows: ${result.result.rowCount}`);
      console.log(JSON.stringify(result.result.rows.slice(0, 5), null, 2));
    }
    printDqlArtifactPreview(result);
  } finally {
    kg.close();
    memory.close();
    if (closeRuntime) await closeRuntime();
  }
}

function printDqlArtifactPreview(result: AgentAnswer): void {
  const dqlSource = result.dqlArtifact?.source?.trim();
  if (dqlSource) {
    console.log(`\n--- DQL artifact (${result.dqlArtifact?.kind ?? 'draft'}) ---\n${dqlSource}`);
  }
  if (result.proposedSql) {
    const label = dqlSource
      ? 'Compiled SQL preview'
      : 'Proposed SQL (review before saving as a block)';
    console.log(`\n--- ${label} ---\n${result.proposedSql}`);
    if (result.suggestedViz) console.log(`Viz: ${result.suggestedViz}`);
    if (result.draftBlock?.path) console.log(`Draft: ${result.draftBlock.path}`);
    if (result.promoteCommand) console.log(`Promote: ${result.promoteCommand}`);
  }
}

/** Minimal slice of the runtime's AgentRun payload that the CLI prints. */
interface AgentThreadRun {
  id?: string;
  route?: string;
  trustState?: string;
  answer?: string;
  summary?: string;
}

/**
 * `dql agent ask --thread <id>` — POST the question to the runtime's
 * `/api/agent-runs` with the threadId in the body. The server injects the
 * thread's prior turns into the conversation context and records the completed
 * run as the next turn, so follow-ups resolve "those"/"that product" correctly
 * across CLI invocations (and across the notebook UI, which shares the store).
 */
async function runThreadAsk(question: string, threadId: string, flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const format = (flags as { format?: string }).format;
  const { runtimeBase, close } = await resolveAgentRuntime(projectRoot, flags);
  try {
    const reasoningEffort = cliReasoningEffort(flags);
    const analysisDepth = cliAnalysisDepth(flags);
    const response = await fetch(`${runtimeBase.replace(/\/$/, '')}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        threadId,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(analysisDepth ? { analysisDepth } : {}),
      }),
    });
    if (!response.ok) throw new Error(`Runtime returned ${response.status}: ${await response.text()}`);
    const payload = (await response.json()) as { run?: AgentThreadRun };
    if (!payload.run) throw new Error('Runtime did not return an agent run.');
    if (format === 'json') {
      console.log(JSON.stringify(payload.run, null, 2));
      return;
    }
    const run = payload.run;
    const badge = run.trustState === 'certified'
      ? '✓ Certified'
      : run.trustState === 'grounded'
        ? '✓ Verified (grounded)'
        : run.trustState === 'review_required'
          ? '! AI-generated · review required'
          : run.trustState === 'blocked'
            ? '✕ Blocked'
            : '· Reply';
    console.log(`${badge}\n\n${(run.answer ?? run.summary ?? '').trim()}`);
    console.log(`\nThread: ${threadId}`);
  } finally {
    await close();
  }
}

/** `dql agent threads` — list server-persisted conversation threads. */
async function runThreads(flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const format = (flags as { format?: string }).format;
  const { runtimeBase, close } = await resolveAgentRuntime(projectRoot, flags);
  try {
    const response = await fetch(`${runtimeBase.replace(/\/$/, '')}/api/agent/threads?limit=50`);
    if (!response.ok) throw new Error(`Runtime returned ${response.status}: ${await response.text()}`);
    const payload = (await response.json()) as {
      threads?: Array<{ id: string; surface?: string; title?: string; updatedAt?: string }>;
    };
    const threads = Array.isArray(payload.threads) ? payload.threads : [];
    if (format === 'json') {
      console.log(JSON.stringify({ threads }, null, 2));
      return;
    }
    if (threads.length === 0) {
      console.log('No conversation threads yet. Ask from the notebook UI, or continue one here with `dql agent ask "<question>" --thread <id>`.');
      return;
    }
    for (const thread of threads) {
      const updated = thread.updatedAt ? new Date(thread.updatedAt).toISOString().replace('T', ' ').slice(0, 16) : 'unknown';
      console.log(`  ${thread.id}  ${updated}  [${thread.surface ?? 'notebook'}]  ${thread.title ?? '(untitled)'}`);
    }
    console.log(`\n${threads.length} thread(s). Continue one: dql agent ask "<question>" --thread <id>`);
  } finally {
    await close();
  }
}

function recordCliQueryRun(
  projectRoot: string,
  run: {
    objectKey?: string;
    source: string;
    status: string;
    rowCount?: number;
    durationMs?: number;
    errorCode?: string;
    payload?: Record<string, unknown>;
  },
): void {
  try {
    recordQueryRun(projectRoot, run);
  } catch {
    // Local query-run history is advisory and must not block CLI answers.
  }
}

async function runReindex(rest: string[], flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(resolve(rest[0] ?? process.cwd()));
  const stats = await reindexProject(projectRoot);
  if ((flags as { format?: string }).format === 'json') {
    console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
    return;
  }
  const kgStatus = stats.kgRebuilt ? 'KG rebuilt' : 'KG fresh';
  const catalogStatus = stats.metadataRefreshed ? 'metadata refreshed' : 'metadata fresh';
  console.log(`  ✓ ${kgStatus}; ${catalogStatus} — ${stats.nodes} nodes, ${stats.edges} edges, ${stats.skills} skill(s).`);
}

async function runFeedback(rest: string[], flags: CLIFlags): Promise<void> {
  const rating = rest[0];
  if (rating !== 'up' && rating !== 'down') {
    throw new Error('Usage: dql agent feedback up|down --block <id> --question "..."');
  }
  const blockId = (flags as { block?: string }).block;
  const question = (flags as { question?: string }).question;
  const user = (flags as { user?: string }).user ?? `${process.env.USER ?? 'owner'}@local`;
  if (!question) throw new Error('--question is required');

  const projectRoot = findProjectRoot(process.cwd());
  const kgPath = defaultKgPath(projectRoot);
  if (!existsSync(kgPath)) throw new Error('KG not built. Run `dql agent reindex`.');
  const kg = new KGStore(kgPath);
  try {
    kg.recordFeedback({
      id: `fb_${Date.now().toString(36)}`,
      ts: new Date().toISOString(),
      user,
      question,
      answerKind: blockId?.startsWith('block:') ? 'certified' : 'uncertified',
      blockId,
      rating,
      comment: (flags as { comment?: string }).comment,
    });
    console.log(`  ✓ Recorded ${rating} from ${user}.`);
  } finally {
    kg.close();
  }
}

interface AgentEvalFile {
  cases?: AgentEvalCase[];
}

interface AgentEvalCase {
  name?: string;
  question: string;
  domain?: string;
  followUp?: AgentFollowUpContext;
  selectedContext?: unknown;
  expected?: {
    sourceTier?: 'certified_artifact' | 'business_context' | 'semantic_layer' | 'dbt_manifest' | 'no_answer';
    certification?: 'certified' | 'ai_generated' | 'analyst_review_required';
    kind?: 'certified' | 'uncertified' | 'no_answer';
    sqlContains?: string | string[];
    sqlNotContains?: string | string[];
    citationKind?: string;
    noHallucinatedColumns?: string[];
    route?: 'certified' | 'generated_sql' | 'research' | 'clarify';
    intent?: string;
    reviewStatus?: 'none' | 'draft_ready' | 'analyst_review_required' | 'certified';
    missingContextKind?: string;
    allowedRelationsOnly?: boolean;
    allowedColumnsOnly?: boolean;
    draftSaved?: boolean;
    minToolCalls?: number;
    rows?: unknown[];
  };
}

interface AgentEvalResult {
  name: string;
  passed: boolean;
  failures: string[];
  durationMs: number;
  executionMs?: number;
  executionMatched?: boolean;
  kind: AgentAnswer['kind'];
  route?: string;
  intent?: string;
  reviewStatus?: string;
  contextObjects: number;
  followUp: boolean;
  draftSaved: boolean;
  expected?: AgentEvalCase['expected'];
  validationCode?: string;
  trace: AgentEvalTraceStage[];
  toolCalls: number;
  judgeScore?: number;
  judgePass?: boolean;
}

type AgentEvalTraceStageName =
  | 'context'
  | 'rewrite'
  | 'lane'
  | 'tools'
  | 'answer'
  | 'validation'
  | 'execution'
  | 'draft'
  | 'scoring';

interface AgentEvalTraceStage {
  stage: AgentEvalTraceStageName;
  status: 'passed' | 'failed' | 'not_run' | 'info';
  message: string;
  payload?: unknown;
}

async function runEval(rest: string[], flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const evalPath = rest[0] ? join(projectRoot, rest[0]) : join(projectRoot, 'agent-evals.yml');
  if (!existsSync(evalPath)) throw new Error(`Eval file not found: ${evalPath}`);

  const raw = loadYaml(readFileSync(evalPath, 'utf-8')) as AgentEvalFile | AgentEvalCase[] | null;
  const cases = Array.isArray(raw) ? raw : raw?.cases ?? [];
  if (cases.length === 0) throw new Error('No eval cases found.');

  const kgPath = defaultKgPath(projectRoot);
  if (!existsSync(kgPath)) await reindexProject(projectRoot, { kgPath });

  const providerName = (flags as { provider?: string }).provider as ProviderName | undefined;
  const provider = await pickProvider(providerName);
  const reasoningEffort = cliReasoningEffort(flags);
  const requestedDepth = cliAnalysisDepth(flags);
  const kg = new KGStore(kgPath);
  const memory = new MemoryStore(defaultMemoryPath(projectRoot));
  const { skills } = loadSkills(projectRoot);
  const execute = Boolean((flags as { execute?: boolean }).execute);
  // R3.2: optional LLM-as-judge. Uses the same provider's completion; skipped
  // gracefully when no provider is available so offline eval stays deterministic.
  const judge = Boolean((flags as { judge?: boolean }).judge);
  const judgeComplete: JudgeCompletion = async ({ system, user }) =>
    provider.generate([{ role: 'system', content: system }, { role: 'user', content: user }], {});
  const runtimeBase = (flags as { runtimeUrl?: string; runtime?: string }).runtimeUrl
    ?? (flags as { runtime?: string }).runtime
    ?? process.env.DQL_RUNTIME_URL
    ?? 'http://127.0.0.1:3474';
  const semanticLayer = loadAgentSemanticLayer(projectRoot);
  const expandGroundingContext = createGroundingContextExpander(projectRoot);
  const answerLoopTools = buildAnswerLoopTools(projectRoot);
  const schemaContext = execute
    ? await fetchRuntimeSchemaContext(runtimeBase)
    : [];
  recordCliRuntimeSchemaSnapshot(projectRoot, schemaContext, 'CLI eval runtime schema');
  const manifest = execute
    ? buildManifest({ projectRoot, dbtManifestPath: resolveDbtManifestPath(projectRoot) ?? undefined })
    : null;
  const results: AgentEvalResult[] = [];

  try {
    for (const testCase of cases) {
      const startedAt = Date.now();
      const memoryContext = memory.search({
        query: testCase.question,
        scopes: ['project', 'user', 'artifact'],
        limit: 6,
      });
      const questionPlan = buildAnalysisQuestionPlan(testCase.question, testCase.followUp);
      const contextBudget = contextRetrievalBudgetForQuestion({
        questionPlan,
        requestedDepth,
        reasoningEffort,
      });
      const contextPack = await buildLocalContextPack(projectRoot, {
        question: testCase.question,
        surface: 'cli-eval',
        followUp: testCase.followUp,
        selectedContext: testCase.selectedContext,
        strictness: contextBudget.strictness,
        limit: contextBudget.limit,
        runtimeSchemaSnapshot: schemaContext.length > 0
          ? {
              source: 'CLI eval runtime schema',
              tables: schemaContext,
            }
          : undefined,
      }).catch(() => undefined);
      const result = await answer({
        question: testCase.question,
        domain: testCase.domain,
        domainContext: testCase.domain && manifest
          ? resolveDomainContextEnvelope({ manifest, activeDomain: testCase.domain, source: 'explicit_api' })
          : undefined,
        provider,
        kg,
        manifest: manifest ?? undefined,
        skills,
        memoryContext,
        followUp: testCase.followUp,
        semanticLayer,
        schemaContext,
        contextPack,
        reasoningEffort,
        analysisDepth: contextBudget.analysisDepth,
        expandGroundingContext,
        answerLoopTools,
        executeCertifiedBlock: execute && manifest
          ? createCertifiedBlockExecutor(projectRoot, manifest, runtimeBase)
          : undefined,
        executeGeneratedSql: execute
          ? createGeneratedSqlExecutor(runtimeBase)
          : undefined,
        captureGeneratedDraft: ({ question: draftQuestion, sql, intent, followUp, contextPack: draftContextPack, sourceBlock, sourceDqlArtifact, dqlArtifact, proposedEntity, requestedFilters, requestedDimensions, validationWarnings, outputs }) => {
          const slug = deriveGeneratedDraftSlug(draftQuestion);
          const proposedDomain = sourceBlock?.domain ?? draftContextPack?.objects.find((object) => object.domain)?.domain ?? testCase.domain ?? 'misc';
          if (dqlArtifact?.kind === 'semantic_block') {
            if (!(flags as { save?: boolean }).save) {
              return {
                path: previewGeneratedDraftPath(projectRoot, proposedDomain, slug),
                askedTimes: 0,
                proposedContractId: `${proposedDomain}.Unknown.${slug}`,
              };
            }
            return upsertGeneratedDqlArtifactDraft(projectRoot, {
              slug,
              question: draftQuestion,
              proposedContractId: `${proposedDomain}.Unknown.${slug}`,
              proposedDomain,
              dqlArtifact,
              sourceQuestion: followUp?.sourceQuestion,
              sourceBlock: followUp?.sourceBlockName ?? sourceBlock?.name,
              followupKind: followUp?.kind,
              outputs,
              contextPackId: draftContextPack?.id,
              routeIntent: String(intent),
              validationWarnings,
            });
          }
          if (!(flags as { save?: boolean }).save) {
            return {
              path: previewGeneratedDraftPath(projectRoot, proposedDomain, slug),
              askedTimes: 0,
              proposedContractId: `${proposedDomain}.Unknown.${slug}`,
            };
          }
          return upsertGeneratedDraft(projectRoot, {
            slug,
            question: draftQuestion,
            proposedSql: sql,
            proposedContractId: `${proposedDomain}.Unknown.${slug}`,
            proposedDomain,
            proposedEntity,
            sourceDqlArtifact,
            sourceQuestion: followUp?.sourceQuestion,
            sourceBlock: followUp?.sourceBlockName ?? sourceBlock?.name,
            followupKind: followUp?.kind,
            requestedFilters,
            requestedDimensions,
            outputs,
            contextPackId: draftContextPack?.id,
            routeIntent: String(intent),
            validationWarnings,
          });
        },
      });
      const evaluation = evaluateCase(testCase, result);
      const durationMs = Date.now() - startedAt;
      const draftSaved = Boolean(result.draftBlock?.path ?? result.draftBlockId);
      const judgeVerdict = judge
        ? await judgeAnswer({
            question: testCase.question,
            sql: result.proposedSql ?? result.sql,
            answerText: result.text,
            trustLabel: result.trustLabelInfo?.display ?? result.certification,
            resultSample: result.result?.rows,
          }, judgeComplete)
        : undefined;
      results.push({
        name: testCase.name ?? testCase.question,
        passed: evaluation.failures.length === 0,
        failures: evaluation.failures,
        durationMs,
        executionMs: result.result?.executionTime,
        executionMatched: evaluation.executionMatched,
        ...(judgeVerdict ? { judgeScore: judgeVerdict.score, judgePass: judgeVerdict.pass } : {}),
        kind: result.kind,
        route: result.contextPack?.routeDecision.route,
        intent: result.contextPack?.routeDecision.intent,
        reviewStatus: result.reviewStatus,
        contextObjects: result.contextPack?.objects.length ?? 0,
        followUp: Boolean(testCase.followUp),
        draftSaved,
        toolCalls: result.evidence?.toolCalls?.length ?? 0,
        expected: testCase.expected,
        validationCode: evaluation.validationCode,
        trace: buildEvalTrace({
          testCase,
          result,
          evaluation,
          durationMs,
          draftSaved,
        }),
      });
    }
  } finally {
    kg.close();
    memory.close();
  }

  const passed = results.filter((r) => r.passed).length;
  const metrics = computeEvalMetrics(results);
  const thresholds = {
    minToolRequirement: (flags as { minToolRequirement?: number }).minToolRequirement ?? null,
    minExecutionMatch: (flags as { minExecutionMatch?: number }).minExecutionMatch ?? null,
    minJudgePass: (flags as { minJudgePass?: number }).minJudgePass ?? null,
    maxWrongCertified: (flags as { maxWrongCertified?: number }).maxWrongCertified ?? null,
  };
  const thresholdsPassed = agentEvalThresholdsPass(metrics, thresholds);
  const ok = passed === results.length && thresholdsPassed;
  if ((flags as { format?: string }).format === 'json') {
    console.log(JSON.stringify({ ok, passed, total: results.length, thresholds, metrics, results }, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }
  for (const result of results) {
    console.log(`${result.passed ? '✓' : '✕'} ${result.name}`);
    for (const failure of result.failures) console.log(`  - ${failure}`);
  }
  console.log(`\n${passed}/${results.length} eval case(s) passed.`);
  console.log(`Certified hit rate: ${formatRate(metrics.certified_hit_rate)}`);
  console.log(`Generated follow-up pass rate: ${formatRate(metrics.generated_followup_pass_rate)}`);
  console.log(`Safe refusal rate: ${formatRate(metrics.safe_refusal_rate)}`);
  console.log(`Execution match rate: ${formatRate(metrics.execution_match_rate)}`);
  console.log(`Tool requirement pass rate: ${formatRate(metrics.tool_requirement_pass_rate)}`);
  console.log(`Tool-observed case count: ${metrics.tool_observed_case_count}`);
  console.log(`Average tool calls: ${metrics.avg_tool_calls}`);
  console.log(`Wrong certified count: ${metrics.wrong_certified_count}`);
  console.log(`Draft saved count: ${metrics.draft_saved_count}`);
  if (thresholds.minToolRequirement !== null) {
    console.log(`Tool requirement threshold: ${thresholds.minToolRequirement} (actual ${formatRate(metrics.tool_requirement_pass_rate)})`);
  }
  if (thresholds.minExecutionMatch !== null) {
    console.log(`Execution-match threshold: ${thresholds.minExecutionMatch} (actual ${formatRate(metrics.execution_match_rate)})`);
  }
  if (thresholds.minJudgePass !== null) {
    console.log(`Judge-pass threshold: ${thresholds.minJudgePass} (actual ${formatRate(metrics.judge_pass_rate)})`);
  }
  if (thresholds.maxWrongCertified !== null) {
    console.log(`Wrong-certified ceiling: ${thresholds.maxWrongCertified} (actual ${metrics.wrong_certified_count})`);
  }
  if (!ok) process.exitCode = 1;
}

function previewGeneratedDraftPath(projectRoot: string, domain: string, slug: string): string {
  const safeDomain = domain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^\/+|\/+$/g, '');
  if (safeDomain && existsSync(join(projectRoot, 'domains', safeDomain))) {
    return `domains/${safeDomain}/blocks/_drafts/${slug}.dql`;
  }
  return `blocks/_drafts/${slug}.dql`;
}

function evaluateCase(testCase: AgentEvalCase, result: Awaited<ReturnType<typeof answer>>): {
  failures: string[];
  validationCode?: string;
  executionMatched?: boolean;
} {
  const expected = testCase.expected;
  if (!expected) return { failures: [] };
  const failures: string[] = [];
  let validationCode: string | undefined;
  let executionMatched: boolean | undefined;
  if (expected.kind && result.kind !== expected.kind) failures.push(`kind expected ${expected.kind}, got ${result.kind}`);
  if (expected.sourceTier && result.sourceTier !== expected.sourceTier) failures.push(`sourceTier expected ${expected.sourceTier}, got ${result.sourceTier}`);
  if (expected.certification && result.certification !== expected.certification) failures.push(`certification expected ${expected.certification}, got ${result.certification}`);
  if (expected.reviewStatus && result.reviewStatus !== expected.reviewStatus) failures.push(`reviewStatus expected ${expected.reviewStatus}, got ${result.reviewStatus}`);
  if (expected.route && result.contextPack?.routeDecision.route !== expected.route) failures.push(`route expected ${expected.route}, got ${result.contextPack?.routeDecision.route ?? 'none'}`);
  if (expected.intent && result.contextPack?.routeDecision.intent !== expected.intent) failures.push(`intent expected ${expected.intent}, got ${result.contextPack?.routeDecision.intent ?? 'none'}`);
  if (expected.missingContextKind && !result.contextPack?.missingContext.some((item) => item.kind === expected.missingContextKind)) failures.push(`missing context kind ${expected.missingContextKind} was not reported`);
  for (const token of stringList(expected.sqlContains)) {
    if (!result.proposedSql?.toLowerCase().includes(token.toLowerCase())) failures.push(`SQL did not contain "${token}"`);
  }
  for (const token of stringList(expected.sqlNotContains)) {
    if (result.proposedSql?.toLowerCase().includes(token.toLowerCase())) failures.push(`SQL contained forbidden token "${token}"`);
  }
  if (expected.citationKind && !result.citations.some((c) => c.kind === expected.citationKind)) failures.push(`missing citation kind ${expected.citationKind}`);
  for (const column of expected.noHallucinatedColumns ?? []) {
    if (result.proposedSql?.toLowerCase().includes(column.toLowerCase())) failures.push(`hallucinated forbidden column "${column}"`);
  }
  if (expected.draftSaved !== undefined) {
    const saved = Boolean(result.draftBlock?.path ?? result.draftBlockId);
    if (saved !== expected.draftSaved) failures.push(`draftSaved expected ${expected.draftSaved}, got ${saved}`);
  }
  if (typeof expected.minToolCalls === 'number') {
    const actualToolCalls = result.evidence?.toolCalls?.length ?? 0;
    if (actualToolCalls < expected.minToolCalls) {
      failures.push(`toolCalls expected at least ${expected.minToolCalls}, got ${actualToolCalls}`);
    }
  }
  if ((expected.allowedRelationsOnly || expected.allowedColumnsOnly) && result.proposedSql) {
    const validation = validateSqlAgainstLocalContext(result.proposedSql, result.contextPack, {
      question: testCase.question,
      intent: result.contextPack?.routeDecision.intent,
      filterValues: testCase.followUp?.filters,
    });
    if (!validation.ok) {
      validationCode = validation.code;
      failures.push(`SQL context validation failed (${validation.code}): ${validation.error}`);
    }
  }
  if (expected.rows) {
    const actualRows = result.result?.rows ?? [];
    executionMatched = rowsEqual(actualRows, expected.rows);
    if (!executionMatched) failures.push('executed rows did not match expected rows');
  }
  return { failures, validationCode, executionMatched };
}

function computeEvalMetrics(results: AgentEvalResult[]) {
  const certifiedCases = results.filter((result) =>
    result.expected?.kind === 'certified' ||
    result.expected?.certification === 'certified' ||
    result.expected?.route === 'certified',
  );
  const generatedFollowUpCases = results.filter((result) =>
    result.followUp &&
    (result.expected?.kind === 'uncertified' || result.expected?.route === 'generated_sql'),
  );
  const refusalCases = results.filter((result) =>
    result.expected?.kind === 'no_answer' || result.expected?.route === 'clarify',
  );
  const executionTimes = results
    .map((result) => result.executionMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const executionMatchCases = results.filter((result) => result.executionMatched !== undefined);
  const toolRequiredCases = results.filter((result) => typeof result.expected?.minToolCalls === 'number');
  const toolCallCounts = results.map((result) => result.toolCalls);
  const judged = results.filter((result) => typeof result.judgeScore === 'number');
  return {
    certified_hit_rate: ratio(certifiedCases.filter((result) => result.passed && result.kind === 'certified').length, certifiedCases.length),
    judge_mean_score: judged.length ? average(judged.map((result) => result.judgeScore ?? 0)) : null,
    judge_pass_rate: judged.length ? ratio(judged.filter((result) => result.judgePass).length, judged.length) : null,
    generated_followup_pass_rate: ratio(generatedFollowUpCases.filter((result) => result.passed).length, generatedFollowUpCases.length),
    safe_refusal_rate: ratio(refusalCases.filter((result) => result.passed && result.kind === 'no_answer').length, refusalCases.length),
    execution_match_rate: ratio(executionMatchCases.filter((result) => result.executionMatched).length, executionMatchCases.length),
    tool_requirement_pass_rate: ratio(
      toolRequiredCases.filter((result) => result.toolCalls >= (result.expected?.minToolCalls ?? 0)).length,
      toolRequiredCases.length,
    ),
    wrong_certified_count: results.filter((result) =>
      result.kind === 'certified' &&
      (result.expected?.kind ? result.expected.kind !== 'certified' : result.followUp),
    ).length,
    outside_context_rejection_count: results.filter((result) =>
      result.validationCode === 'unknown_relation' || result.validationCode === 'unknown_column',
    ).length,
    draft_saved_count: results.filter((result) => result.draftSaved).length,
    tool_observed_case_count: results.filter((result) => result.toolCalls > 0).length,
    avg_tool_calls: average(toolCallCounts),
    avg_context_objects: average(results.map((result) => result.contextObjects)),
    avg_execution_ms: executionTimes.length ? average(executionTimes) : null,
  };
}

function agentEvalThresholdsPass(
  metrics: ReturnType<typeof computeEvalMetrics>,
  thresholds: {
    minToolRequirement: number | null;
    minExecutionMatch?: number | null;
    minJudgePass?: number | null;
    maxWrongCertified?: number | null;
  },
): boolean {
  // A rate threshold with no applicable cases (metric === null) is vacuously
  // satisfied — you only fail when the metric exists and falls below the bar.
  const rateOk = (metric: number | null, min: number | null | undefined): boolean =>
    min === null || min === undefined || metric === null || metric >= min;
  return rateOk(metrics.tool_requirement_pass_rate, thresholds.minToolRequirement)
    && rateOk(metrics.execution_match_rate, thresholds.minExecutionMatch)
    && rateOk(metrics.judge_pass_rate, thresholds.minJudgePass)
    && (thresholds.maxWrongCertified === null
      || thresholds.maxWrongCertified === undefined
      || metrics.wrong_certified_count <= thresholds.maxWrongCertified);
}

function buildEvalTrace(input: {
  testCase: AgentEvalCase;
  result: Awaited<ReturnType<typeof answer>>;
  evaluation: ReturnType<typeof evaluateCase>;
  durationMs: number;
  draftSaved: boolean;
}): AgentEvalTraceStage[] {
  const { testCase, result, evaluation, durationMs, draftSaved } = input;
  const routeDecision = result.contextPack?.routeDecision;
  const selectedRelations = result.contextPack?.retrievalDiagnostics.selectedRelations ?? [];
  const allowedRelations = result.contextPack?.allowedSqlContext?.relations ?? [];
  const followUp = testCase.followUp;
  const toolCalls = result.evidence?.toolCalls ?? [];
  const routeEvidence = result.evidence?.route ?? [];
  const executionStatus = result.executionError
    ? 'failed'
    : result.result
      ? 'passed'
      : 'not_run';
  const validationExpected = Boolean(testCase.expected?.allowedRelationsOnly || testCase.expected?.allowedColumnsOnly);
  const validationStatus = evaluation.validationCode
    ? 'failed'
    : validationExpected
      ? 'passed'
      : 'not_run';
  const rowsExpected = testCase.expected?.rows !== undefined;
  const expectedMinToolCalls = testCase.expected?.minToolCalls;
  const toolStatus = typeof expectedMinToolCalls === 'number'
    ? toolCalls.length >= expectedMinToolCalls ? 'passed' : 'failed'
    : toolCalls.length > 0 ? 'passed' : routeEvidence.length > 0 ? 'info' : 'not_run';
  const toolMessage = typeof expectedMinToolCalls === 'number'
    ? toolCalls.length >= expectedMinToolCalls
      ? `Observed ${toolCalls.length} provider tool call(s), meeting the minimum of ${expectedMinToolCalls}.`
      : `Observed ${toolCalls.length} provider tool call(s), below the minimum of ${expectedMinToolCalls}.`
    : toolCalls.length > 0
      ? `Observed ${toolCalls.length} provider tool call(s).`
      : routeEvidence.length > 0
        ? `Captured ${routeEvidence.length} deterministic route evidence step(s).`
        : 'No provider tool calls were observed for this answer.';

  return [
    {
      stage: 'context',
      status: result.contextPack ? 'passed' : 'not_run',
      message: result.contextPack
        ? `Context pack ${result.contextPack.id} selected ${result.contextPack.objects.length} object(s).`
        : 'No context pack was attached to the answer.',
      payload: result.contextPack
        ? {
            contextPackId: result.contextPack.id,
            selectedObjectCount: result.contextPack.objects.length,
            allowedRelationCount: allowedRelations.length,
            selectedRelations: selectedRelations.slice(0, 12).map((relation) => relation.relation),
            missingContext: result.contextPack.missingContext,
          }
        : undefined,
    },
    {
      stage: 'rewrite',
      status: followUp ? 'passed' : 'not_run',
      message: followUp
        ? `Follow-up context attached (${followUp.kind}).`
        : 'No follow-up rewrite/context was supplied for this case.',
      payload: summarizeFollowUpForTrace(followUp),
    },
    {
      stage: 'lane',
      status: routeDecision ? 'passed' : 'not_run',
      message: routeDecision
        ? `Lane ${routeDecision.route} / ${routeDecision.intent}.`
        : 'No lane decision was attached to the answer.',
      payload: routeDecision
        ? {
            route: routeDecision.route,
            intent: routeDecision.intent,
            reason: routeDecision.reason,
            trustLabel: routeDecision.trustLabel,
            reviewStatus: routeDecision.reviewStatus,
            exactObjectKey: routeDecision.exactObjectKey,
          }
        : undefined,
    },
    {
      stage: 'tools',
      status: toolStatus,
      message: toolMessage,
      payload: {
        observedToolCalls: toolCalls.length,
        expectedMinToolCalls,
        providerToolCalls: toolCalls.slice(0, 12).map((call) => ({
          order: call.order,
          name: call.name,
          status: call.status,
          inputSummary: call.inputSummary,
          outputSummary: call.outputSummary,
        })),
        routeEvidence: routeEvidence.slice(0, 12).map((step) => ({
          tool: step.tool,
          status: step.status,
          label: step.label,
          detail: step.detail,
        })),
      },
    },
    {
      stage: 'answer',
      status: result.kind === 'no_answer' ? 'failed' : 'passed',
      message: `Answer kind ${result.kind}${result.sourceTier ? ` from ${result.sourceTier}` : ''}.`,
      payload: {
        kind: result.kind,
        sourceTier: result.sourceTier,
        certification: result.certification,
        reviewStatus: result.reviewStatus,
        route: result.route?.tier,
        refusalCode: result.refusalCode,
        sourceCertifiedBlock: result.sourceCertifiedBlock,
        dqlArtifactKind: result.dqlArtifact?.kind,
        providerUsed: result.providerUsed,
      },
    },
    {
      stage: 'validation',
      status: validationStatus,
      message: evaluation.validationCode
        ? `SQL context validation failed with ${evaluation.validationCode}.`
        : validationExpected
          ? 'SQL context validation passed.'
          : 'SQL context validation was not required by this case.',
      payload: {
        validationCode: evaluation.validationCode,
        failures: evaluation.failures,
        expectedAllowedRelationsOnly: testCase.expected?.allowedRelationsOnly,
        expectedAllowedColumnsOnly: testCase.expected?.allowedColumnsOnly,
      },
    },
    {
      stage: 'execution',
      status: executionStatus,
      message: result.executionError
        ? result.executionError
        : result.result
          ? `Executed and returned ${result.result.rowCount} row(s).`
          : 'No SQL/block execution result was captured.',
      payload: {
        rowCount: result.result?.rowCount,
        executionTime: result.result?.executionTime,
        executionMatched: rowsExpected ? evaluation.executionMatched : undefined,
        expectedRows: rowsExpected ? testCase.expected?.rows?.length : undefined,
        columns: summarizeResultColumns(result.result?.columns),
      },
    },
    {
      stage: 'draft',
      status: draftSaved ? 'passed' : 'not_run',
      message: draftSaved
        ? `Draft captured at ${result.draftBlock?.path ?? result.draftBlockId}.`
        : 'No generated draft was captured.',
      payload: {
        draftBlockId: result.draftBlockId,
        draftPath: result.draftBlock?.path,
        promoteCommand: result.promoteCommand,
      },
    },
    {
      stage: 'scoring',
      status: evaluation.failures.length === 0 ? 'passed' : 'failed',
      message: evaluation.failures.length === 0
        ? `Case passed in ${durationMs}ms.`
        : `Case failed ${evaluation.failures.length} check(s) in ${durationMs}ms.`,
      payload: {
        durationMs,
        expected: testCase.expected,
      },
    },
  ];
}

function summarizeFollowUpForTrace(followUp: AgentFollowUpContext | undefined): unknown {
  if (!followUp) return undefined;
  const priorResultRef = followUp.priorResultRef
    ? {
        id: followUp.priorResultRef.id,
        question: followUp.priorResultRef.question,
        columns: followUp.priorResultRef.columns,
        rowCount: followUp.priorResultRef.rowCount,
        sourceSql: truncateTraceText(followUp.priorResultRef.sourceSql, 4000),
      }
    : undefined;
  const priorDqlArtifact = followUp.priorDqlArtifact
    ? {
        kind: followUp.priorDqlArtifact.kind,
        name: followUp.priorDqlArtifact.name,
        sourcePath: followUp.priorDqlArtifact.sourcePath,
        source: truncateTraceText(followUp.priorDqlArtifact.source, 4000),
        metrics: followUp.priorDqlArtifact.metrics,
        dimensions: followUp.priorDqlArtifact.dimensions,
        filters: followUp.priorDqlArtifact.filters,
        timeDimension: followUp.priorDqlArtifact.timeDimension,
        orderBy: followUp.priorDqlArtifact.orderBy,
        limit: followUp.priorDqlArtifact.limit,
      }
    : undefined;
  return {
    kind: followUp.kind,
    sourceTurnId: followUp.sourceTurnId,
    sourceBlockName: followUp.sourceBlockName,
    sourceQuestion: followUp.sourceQuestion,
    filters: followUp.filters,
    dimensions: followUp.dimensions,
    priorResultColumns: followUp.priorResultColumns,
    priorResultValues: followUp.priorResultValues,
    priorResultRef,
    priorDqlArtifact,
    priorLimit: followUp.priorLimit,
    priorMeasures: followUp.priorMeasures,
    resolvedReferences: followUp.resolvedReferences,
    unresolvedReferences: followUp.unresolvedReferences,
  };
}

function truncateTraceText(value: string | undefined, maxLength: number): string | undefined {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function summarizeResultColumns(columns: unknown[] | undefined): string[] {
  return (columns ?? []).map((column) => {
    if (typeof column === 'string') return column;
    if (column && typeof column === 'object' && 'name' in column) {
      const name = (column as { name?: unknown }).name;
      return typeof name === 'string' ? name : JSON.stringify(column);
    }
    return String(column);
  });
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 1000) / 10}%`;
}

function stringList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function rowsEqual(actual: unknown[], expected: unknown[]): boolean {
  return JSON.stringify(normalizeRows(actual)) === JSON.stringify(normalizeRows(expected));
}

function normalizeRows(rows: unknown[]): unknown[] {
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    return Object.fromEntries(Object.entries(row as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  });
}

function createCertifiedBlockExecutor(
  projectRoot: string,
  manifest: ReturnType<typeof buildManifest>,
  runtimeBase: string,
) {
  return async (node: { name: string; nodeId: string }): Promise<AgentResultPayload> => {
    const block = manifest.blocks[node.name] ?? manifest.blocks[node.nodeId.replace(/^block:/, '')];
    if (!block) throw new Error(`Matched block ${node.name} is not present in the manifest.`);
    const source = readFileSync(join(projectRoot, block.filePath), 'utf-8');
    const payload = await executeRuntimeCell(runtimeBase, {
      id: `agent-eval-${node.name}`,
      type: 'dql',
      source,
      title: node.name,
    });
    const rows = Array.isArray(payload.result?.rows) ? payload.result.rows : [];
    return {
      columns: Array.isArray(payload.result?.columns) ? payload.result.columns : [],
      rows,
      rowCount: typeof payload.result?.rowCount === 'number' ? payload.result.rowCount : rows.length,
      executionTime: payload.result?.executionTime,
      blockName: node.name,
    };
  };
}

function createGeneratedSqlExecutor(runtimeBase: string) {
  return async (sql: string): Promise<AgentResultPayload> => {
    const payload = await executeRuntimeCell(runtimeBase, {
      id: `agent-eval-generated-${Date.now().toString(36)}`,
      type: 'sql',
      source: sql,
      title: 'agent eval generated SQL',
    });
    const rows = Array.isArray(payload.result?.rows) ? payload.result.rows : [];
    return {
      columns: Array.isArray(payload.result?.columns) ? payload.result.columns : [],
      rows,
      rowCount: typeof payload.result?.rowCount === 'number' ? payload.result.rowCount : rows.length,
      executionTime: payload.result?.executionTime,
      sql,
    };
  };
}

async function executeRuntimeCell(
  runtimeBase: string,
  cell: { id: string; type: 'dql' | 'sql'; source: string; title: string },
): Promise<{
  result?: {
    columns?: unknown[];
    rows?: unknown[];
    rowCount?: number;
    executionTime?: number;
  };
  error?: string;
}> {
  const response = await fetch(`${runtimeBase.replace(/\/$/, '')}/api/notebook/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cell }),
  });
  if (!response.ok) throw new Error(`Runtime returned ${response.status}: ${await response.text()}`);
  const payload = (await response.json()) as {
    result?: {
      columns?: unknown[];
      rows?: unknown[];
      rowCount?: number;
      executionTime?: number;
    };
    error?: string;
  };
  if (payload.error) throw new Error(payload.error);
  return payload;
}

export const __test__ = {
  agentEvalThresholdsPass,
  buildEvalTrace,
  cliAnalysisDepth,
  cliReasoningEffort,
  computeEvalMetrics,
  evaluateCase,
};
