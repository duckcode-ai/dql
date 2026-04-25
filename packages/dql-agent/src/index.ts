/**
 * Public surface for `@duckcodeailabs/dql-agent`.
 *
 * Consumers (CLI, MCP server, notebook UI) typically import:
 *   - `reindexProject(root)` to rebuild the KG
 *   - `KGStore` for direct queries
 *   - `answer({ ... })` for the block-first answer loop
 *   - the providers (Claude/OpenAI/Gemini/Ollama)
 */

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { DQLManifest } from '@duckcodeailabs/dql-core';
import { buildManifest } from '@duckcodeailabs/dql-core';
import { KGStore } from './kg/sqlite-fts.js';
import { buildKGFromManifest } from './kg/build.js';
import { loadSkills } from './skills/loader.js';
import type { Skill } from './skills/loader.js';

export { KGStore } from './kg/sqlite-fts.js';
export type { KGNode, KGEdge, KGNodeKind, KGSearchHit, KGFeedbackRow, KGSearchOptions } from './kg/types.js';
export { buildKGFromManifest } from './kg/build.js';
export { loadSkills, parseSkill, buildSkillsPrompt } from './skills/loader.js';
export type { Skill, SkillLoadResult } from './skills/loader.js';
export { answer, parseProposal } from './answer-loop.js';
export type { AgentAnswer, AgentCitation, AnswerKind, AnswerLoopInput } from './answer-loop.js';
export {
  ClaudeProvider, OpenAIProvider, GeminiProvider, OllamaProvider,
  pickProvider, buildProvider,
} from './providers/index.js';
export type { AgentProvider, AgentMessage, ProviderName, ProviderRunOptions } from './providers/index.js';

/**
 * Default location for the agent's SQLite KG file.
 * Mirrors the manifest cache layout under `.dql/cache/`.
 */
export function defaultKgPath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'cache', 'agent-kg.sqlite');
}

export interface ReindexOptions {
  manifest?: DQLManifest;
  /** Path to the KG sqlite file. Defaults to `.dql/cache/agent-kg.sqlite`. */
  kgPath?: string;
  /** Set to false to skip re-loading Skills. */
  loadSkills?: boolean;
}

/**
 * Rebuild the KG from the project's manifest. Safe to call on every save —
 * incremental indexing can land later; the wholesale rebuild is fast on the
 * scale dql projects realistically reach (thousands of nodes).
 */
export async function reindexProject(
  projectRoot: string,
  opts: ReindexOptions = {},
): Promise<{ nodes: number; edges: number; skills: number }> {
  const manifest = opts.manifest ?? loadManifest(projectRoot);
  const { nodes, edges } = buildKGFromManifest(manifest);

  // Skills become KG nodes too so the agent can retrieve them.
  let skills: Skill[] = [];
  if (opts.loadSkills !== false) {
    const result = loadSkills(projectRoot);
    skills = result.skills;
    for (const s of skills) {
      nodes.push({
        nodeId: `skill:${s.id}`,
        kind: 'skill',
        name: s.id,
        description: s.description,
        llmContext: s.body,
        sourcePath: s.sourcePath,
      });
    }
  }

  const kg = new KGStore(opts.kgPath ?? defaultKgPath(projectRoot));
  try {
    kg.rebuild(nodes, edges);
  } finally {
    kg.close();
  }
  return { nodes: nodes.length, edges: edges.length, skills: skills.length };
}

/**
 * Promotion suggester — surface uncertified answers that have accumulated
 * positive feedback so an analyst can certify them as proper blocks.
 */
export function getPromotionCandidates(projectRoot: string, minUps = 5): Array<{
  blockId: string; question: string; ups: number;
}> {
  const kg = new KGStore(defaultKgPath(projectRoot));
  try {
    return kg.promotionCandidates(minUps);
  } finally {
    kg.close();
  }
}

function loadManifest(projectRoot: string): DQLManifest {
  // Prefer the on-disk compiled manifest, fall back to a fresh build.
  const compiled = join(projectRoot, 'dql-manifest.json');
  if (existsSync(compiled)) {
    try {
      return JSON.parse(readFileSync(compiled, 'utf-8')) as DQLManifest;
    } catch {
      // fall through
    }
  }
  return buildManifest({ projectRoot });
}
