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

import { existsSync } from 'node:fs';
import {
  KGStore,
  defaultKgPath,
  reindexProject,
  loadSkills,
  pickProvider,
  answer,
  type ProviderName,
} from '@duckcodeailabs/dql-agent';
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
    default:
      throw new Error(
        'Usage: dql agent <ask|reindex|feedback> [args]\n' +
          '  dql agent ask "<question>" [--provider claude|openai|gemini|ollama] [--user <id>] [--domain <d>]\n' +
          '  dql agent reindex\n' +
          '  dql agent feedback up|down --block <id> --question "..."',
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
  const { skills } = loadSkills(projectRoot);

  try {
    const result = await answer({ question, provider, kg, skills, userId, domain });

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
    if (result.proposedSql) {
      console.log(`\n--- Proposed SQL (review before saving as a block) ---\n${result.proposedSql}`);
      if (result.suggestedViz) console.log(`Viz: ${result.suggestedViz}`);
    }
  } finally {
    kg.close();
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
