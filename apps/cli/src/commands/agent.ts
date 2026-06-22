/**
 * `dql agent` — block-first answer loop on the command line.
 *
 *   dql agent ask "what was revenue last week?"
 *     [--provider claude|openai|gemini|ollama]
 *     [--user alice@acme.com]   (filters Skills + records feedback as this user)
 *     [--domain growth]         (scopes KG search)
 *     [--format json]           (emits structured JSON instead of prose)
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
    buildLocalContextPack,
    deriveGeneratedDraftSlug,
    recordQueryRun,
    type ProviderName,
    upsertGeneratedDraft,
    validateSqlAgainstLocalContext,
    type AgentAnswer,
    type AgentFollowUpContext,
    type AgentResultPayload,
  } from '@duckcodeailabs/dql-agent';
import { buildManifest, resolveDbtManifestPath } from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';

export async function runAgent(
  sub: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  switch (sub) {
    case 'ask':
      return runAsk(rest, flags);
    case 'reindex':
      return runReindex(rest, flags);
    case 'feedback':
      return runFeedback(rest, flags);
    case 'eval':
      return runEval(rest, flags);
    default:
      throw new Error(
        'Usage: dql agent <ask|reindex|feedback|eval> [args]\n' +
            '  dql agent ask "<question>" [--provider claude|openai|gemini|ollama] [--user <id>] [--domain <d>]\n' +
      '  dql agent reindex [path]\n' +
      '  dql agent feedback up|down --block <id> --question "..."\n' +
      '  dql agent eval agent-evals.yml [--provider claude|openai|gemini|ollama] [--execute] [--save]',
        );
  }
}

async function runAsk(rest: string[], flags: CLIFlags): Promise<void> {
  const question = rest.join(' ').trim();
  if (!question) throw new Error('Usage: dql agent ask "<question>"');

  const projectRoot = findProjectRoot(process.cwd());
  const kgPath = defaultKgPath(projectRoot);
  await reindexProject(projectRoot, { kgPath });

  const providerName = (flags as { provider?: string }).provider as ProviderName | undefined;
  const userId = (flags as { user?: string }).user;
  const domain = (flags as { domain?: string }).domain;
  const format = (flags as { format?: string }).format;

  const provider = await pickProvider(providerName);
  const kg = new KGStore(kgPath);
  const memory = new MemoryStore(defaultMemoryPath(projectRoot));
  const { skills } = loadSkills(projectRoot);

  try {
    const memoryContext = memory.search({
      query: question,
      scopes: ['project', 'user', 'artifact'],
      limit: 6,
    });
    const contextPack = await buildLocalContextPack(projectRoot, { question, limit: 80 }).catch(() => undefined);
    const manifest = buildManifest({ projectRoot, dbtManifestPath: resolveDbtManifestPath(projectRoot) ?? undefined });
    const runtimeBase = (flags as { runtimeUrl?: string; runtime?: string }).runtimeUrl
      ?? (flags as { runtime?: string }).runtime
      ?? process.env.DQL_RUNTIME_URL
      ?? 'http://127.0.0.1:3474';
    const result = await answer({
      question,
      provider,
      kg,
      skills,
      userId,
      domain,
      memoryContext,
      contextPack,
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
        captureGeneratedDraft: ({ question: draftQuestion, sql, intent, followUp, contextPack, sourceBlock, validationWarnings }) => {
          const slug = deriveGeneratedDraftSlug(draftQuestion);
          const proposedDomain = sourceBlock?.domain ?? contextPack?.objects.find((object) => object.domain)?.domain ?? domain ?? 'misc';
          return upsertGeneratedDraft(projectRoot, {
            slug,
            question: draftQuestion,
            proposedSql: sql,
            proposedContractId: `${proposedDomain}.Unknown.${slug}`,
            proposedDomain,
            sourceQuestion: followUp?.sourceQuestion,
            sourceBlock: followUp?.sourceBlockName ?? sourceBlock?.name,
            followupKind: followUp?.kind,
            requestedFilters: followUp?.filters,
            requestedDimensions: followUp?.dimensions,
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
    console.log(`${badge}\n\n${result.text}${cite}`);
    if (result.result) {
      console.log(`\nRows: ${result.result.rowCount}`);
      console.log(JSON.stringify(result.result.rows.slice(0, 5), null, 2));
    }
      if (result.proposedSql) {
        console.log(`\n--- Proposed SQL (review before saving as a block) ---\n${result.proposedSql}`);
        if (result.suggestedViz) console.log(`Viz: ${result.suggestedViz}`);
        if (result.draftBlock?.path) console.log(`Draft: ${result.draftBlock.path}`);
        if (result.promoteCommand) console.log(`Promote: ${result.promoteCommand}`);
      }
  } finally {
    kg.close();
    memory.close();
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
  console.log(`  ✓ KG and metadata catalog rebuilt — ${stats.nodes} nodes, ${stats.edges} edges, ${stats.skills} skill(s).`);
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
    rows?: unknown[];
  };
}

interface AgentEvalResult {
  name: string;
  passed: boolean;
  failures: string[];
  durationMs: number;
  executionMs?: number;
  kind: AgentAnswer['kind'];
  route?: string;
  intent?: string;
  reviewStatus?: string;
  contextObjects: number;
  followUp: boolean;
  draftSaved: boolean;
  expected?: AgentEvalCase['expected'];
  validationCode?: string;
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
  const kg = new KGStore(kgPath);
  const memory = new MemoryStore(defaultMemoryPath(projectRoot));
  const { skills } = loadSkills(projectRoot);
  const execute = Boolean((flags as { execute?: boolean }).execute);
  const runtimeBase = (flags as { runtimeUrl?: string; runtime?: string }).runtimeUrl
    ?? (flags as { runtime?: string }).runtime
    ?? process.env.DQL_RUNTIME_URL
    ?? 'http://127.0.0.1:3474';
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
      const contextPack = await buildLocalContextPack(projectRoot, {
        question: testCase.question,
        surface: 'cli-eval',
        followUp: testCase.followUp,
        selectedContext: testCase.selectedContext,
        limit: 80,
      }).catch(() => undefined);
      const result = await answer({
        question: testCase.question,
        domain: testCase.domain,
        provider,
        kg,
        skills,
        memoryContext,
        followUp: testCase.followUp,
        contextPack,
        executeCertifiedBlock: execute && manifest
          ? createCertifiedBlockExecutor(projectRoot, manifest, runtimeBase)
          : undefined,
        executeGeneratedSql: execute
          ? createGeneratedSqlExecutor(runtimeBase)
          : undefined,
        captureGeneratedDraft: ({ question: draftQuestion, sql, intent, followUp, contextPack: draftContextPack, sourceBlock, validationWarnings }) => {
          const slug = deriveGeneratedDraftSlug(draftQuestion);
          const proposedDomain = sourceBlock?.domain ?? draftContextPack?.objects.find((object) => object.domain)?.domain ?? testCase.domain ?? 'misc';
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
            sourceQuestion: followUp?.sourceQuestion,
            sourceBlock: followUp?.sourceBlockName ?? sourceBlock?.name,
            followupKind: followUp?.kind,
            requestedFilters: followUp?.filters,
            requestedDimensions: followUp?.dimensions,
            contextPackId: draftContextPack?.id,
            routeIntent: String(intent),
            validationWarnings,
          });
        },
      });
      const evaluation = evaluateCase(testCase, result);
      results.push({
        name: testCase.name ?? testCase.question,
        passed: evaluation.failures.length === 0,
        failures: evaluation.failures,
        durationMs: Date.now() - startedAt,
        executionMs: result.result?.executionTime,
        kind: result.kind,
        route: result.contextPack?.routeDecision.route,
        intent: result.contextPack?.routeDecision.intent,
        reviewStatus: result.reviewStatus,
        contextObjects: result.contextPack?.objects.length ?? 0,
        followUp: Boolean(testCase.followUp),
        draftSaved: Boolean(result.draftBlock?.path ?? result.draftBlockId),
        expected: testCase.expected,
        validationCode: evaluation.validationCode,
      });
    }
  } finally {
    kg.close();
    memory.close();
  }

  const passed = results.filter((r) => r.passed).length;
  const metrics = computeEvalMetrics(results);
  if ((flags as { format?: string }).format === 'json') {
    console.log(JSON.stringify({ ok: passed === results.length, passed, total: results.length, metrics, results }, null, 2));
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
  console.log(`Wrong certified count: ${metrics.wrong_certified_count}`);
  console.log(`Draft saved count: ${metrics.draft_saved_count}`);
  if (passed !== results.length) process.exitCode = 1;
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

function evaluateCase(testCase: AgentEvalCase, result: Awaited<ReturnType<typeof answer>>): { failures: string[]; validationCode?: string } {
  const expected = testCase.expected;
  if (!expected) return { failures: [] };
  const failures: string[] = [];
  let validationCode: string | undefined;
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
    if (!rowsEqual(actualRows, expected.rows)) failures.push('executed rows did not match expected rows');
  }
  return { failures, validationCode };
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
  return {
    certified_hit_rate: ratio(certifiedCases.filter((result) => result.passed && result.kind === 'certified').length, certifiedCases.length),
    generated_followup_pass_rate: ratio(generatedFollowUpCases.filter((result) => result.passed).length, generatedFollowUpCases.length),
    safe_refusal_rate: ratio(refusalCases.filter((result) => result.passed && result.kind === 'no_answer').length, refusalCases.length),
    wrong_certified_count: results.filter((result) =>
      result.kind === 'certified' &&
      (result.expected?.kind ? result.expected.kind !== 'certified' : result.followUp),
    ).length,
    outside_context_rejection_count: results.filter((result) =>
      result.validationCode === 'unknown_relation' || result.validationCode === 'unknown_column',
    ).length,
    draft_saved_count: results.filter((result) => result.draftSaved).length,
    avg_context_objects: average(results.map((result) => result.contextObjects)),
    avg_execution_ms: executionTimes.length ? average(executionTimes) : null,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
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
  computeEvalMetrics,
  evaluateCase,
};
