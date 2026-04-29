/**
 * `dql agent` — block-first answer loop on the command line.
 *
 *   dql agent ask "what was revenue last week?"
 *     [--provider claude|openai|gemini|ollama]
 *     [--user alice@acme.com]   (filters Skills + records feedback as this user)
 *     [--domain growth]         (scopes KG search)
 *     [--format json]           (emits structured JSON instead of prose)
 *
 *   dql agent reindex
 *     Rebuilds .dql/cache/agent-kg.sqlite from the project's manifest +
 *     Skills folder. Equivalent to `dql app reindex`.
 *
 *   dql agent feedback <up|down> --block <id> --question "..."
 *     Records feedback into the KG. Used by clients without MCP access.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  type ProviderName,
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
      return runReindex(flags);
    case 'feedback':
      return runFeedback(rest, flags);
    case 'eval':
      return runEval(rest, flags);
    default:
      throw new Error(
        'Usage: dql agent <ask|reindex|feedback|eval> [args]\n' +
          '  dql agent ask "<question>" [--provider claude|openai|gemini|ollama] [--user <id>] [--domain <d>]\n' +
          '  dql agent reindex\n' +
          '  dql agent feedback up|down --block <id> --question "..."\n' +
          '  dql agent eval agent-evals.yml [--provider claude|openai|gemini|ollama]',
      );
  }
}

async function runAsk(rest: string[], flags: CLIFlags): Promise<void> {
  const question = rest.join(' ').trim();
  if (!question) throw new Error('Usage: dql agent ask "<question>"');

  const projectRoot = findProjectRoot(process.cwd());
  const kgPath = defaultKgPath(projectRoot);
  if (!existsSync(kgPath)) {
    throw new Error(
      'KG not built. Run `dql agent reindex` (or `dql app reindex`) before asking.',
    );
  }

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
    const manifest = buildManifest({ projectRoot, dbtManifestPath: resolveDbtManifestPath(projectRoot) ?? undefined });
    const result = await answer({
      question,
      provider,
      kg,
      skills,
      userId,
      domain,
      memoryContext,
      executeCertifiedBlock: async (node) => {
        const block = manifest.blocks[node.name] ?? manifest.blocks[node.nodeId.replace(/^block:/, '')];
        if (!block) throw new Error(`Matched block ${node.name} is not present in the manifest.`);
        const base = (flags as { runtimeUrl?: string; runtime?: string }).runtimeUrl
          ?? (flags as { runtime?: string }).runtime
          ?? process.env.DQL_RUNTIME_URL
          ?? 'http://127.0.0.1:3474';
        const source = readFileSync(join(projectRoot, block.filePath), 'utf-8');
        const response = await fetch(`${base.replace(/\/$/, '')}/api/notebook/execute`, {
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
        return {
          columns: Array.isArray(payload.result?.columns) ? payload.result.columns : [],
          rows,
          rowCount: typeof payload.result?.rowCount === 'number' ? payload.result.rowCount : rows.length,
          executionTime: payload.result?.executionTime,
          blockName: node.name,
        };
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
    }
  } finally {
    kg.close();
    memory.close();
  }
}

async function runReindex(flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const stats = await reindexProject(projectRoot);
  if ((flags as { format?: string }).format === 'json') {
    console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
    return;
  }
  console.log(`  ✓ KG rebuilt — ${stats.nodes} nodes, ${stats.edges} edges, ${stats.skills} skill(s).`);
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
  expected?: {
    sourceTier?: 'certified_artifact' | 'semantic_layer' | 'dbt_manifest' | 'no_answer';
    certification?: 'certified' | 'ai_generated' | 'analyst_review_required';
    kind?: 'certified' | 'uncertified' | 'no_answer';
    sqlContains?: string;
    citationKind?: string;
    noHallucinatedColumns?: string[];
  };
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
  const results: Array<{ name: string; passed: boolean; failures: string[] }> = [];

  try {
    for (const testCase of cases) {
      const memoryContext = memory.search({
        query: testCase.question,
        scopes: ['project', 'user', 'artifact'],
        limit: 6,
      });
      const result = await answer({
        question: testCase.question,
        domain: testCase.domain,
        provider,
        kg,
        skills,
        memoryContext,
      });
      const failures = evaluateCase(testCase, result);
      results.push({
        name: testCase.name ?? testCase.question,
        passed: failures.length === 0,
        failures,
      });
    }
  } finally {
    kg.close();
    memory.close();
  }

  const passed = results.filter((r) => r.passed).length;
  if ((flags as { format?: string }).format === 'json') {
    console.log(JSON.stringify({ ok: passed === results.length, passed, total: results.length, results }, null, 2));
    return;
  }
  for (const result of results) {
    console.log(`${result.passed ? '✓' : '✕'} ${result.name}`);
    for (const failure of result.failures) console.log(`  - ${failure}`);
  }
  console.log(`\n${passed}/${results.length} eval case(s) passed.`);
  if (passed !== results.length) process.exitCode = 1;
}

function evaluateCase(testCase: AgentEvalCase, result: Awaited<ReturnType<typeof answer>>): string[] {
  const expected = testCase.expected;
  if (!expected) return [];
  const failures: string[] = [];
  if (expected.kind && result.kind !== expected.kind) failures.push(`kind expected ${expected.kind}, got ${result.kind}`);
  if (expected.sourceTier && result.sourceTier !== expected.sourceTier) failures.push(`sourceTier expected ${expected.sourceTier}, got ${result.sourceTier}`);
  if (expected.certification && result.certification !== expected.certification) failures.push(`certification expected ${expected.certification}, got ${result.certification}`);
  if (expected.sqlContains && !result.proposedSql?.toLowerCase().includes(expected.sqlContains.toLowerCase())) failures.push(`SQL did not contain "${expected.sqlContains}"`);
  if (expected.citationKind && !result.citations.some((c) => c.kind === expected.citationKind)) failures.push(`missing citation kind ${expected.citationKind}`);
  for (const column of expected.noHallucinatedColumns ?? []) {
    if (result.proposedSql?.toLowerCase().includes(column.toLowerCase())) failures.push(`hallucinated forbidden column "${column}"`);
  }
  return failures;
}
