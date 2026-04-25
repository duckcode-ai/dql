/**
 * MCP tools wrapping the dql-agent KG.
 *
 * `kg_search` — keyword + filter search over the KG (powers chat retrieval).
 * `feedback_record` — log thumbs-up/down rows that feed self-learning.
 *
 * Both tools open the SQLite KG file at `.dql/cache/agent-kg.sqlite` and
 * close it after the turn so file handles never leak. If the KG hasn't
 * been built yet, `kg_search` returns an empty result with a hint.
 */

import { z } from 'zod';
import { existsSync } from 'node:fs';
import type { DQLContext } from '../context.js';
import { KGStore, defaultKgPath, type KGNodeKind } from '@duckcodeailabs/dql-agent';

export const kgSearchInput = {
  query: z.string().describe('Natural-language or keyword query.'),
  kinds: z
    .array(
      z.enum([
        'block', 'metric', 'dimension', 'domain',
        'dbt_model', 'dbt_source', 'dashboard', 'app', 'skill',
      ]),
    )
    .optional()
    .describe('Optional filter: only return nodes of these kinds.'),
  domain: z.string().optional().describe('Filter to a single business domain.'),
  limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 10).'),
};

export function kgSearch(
  ctx: DQLContext,
  args: { query: string; kinds?: string[]; domain?: string; limit?: number },
) {
  const path = defaultKgPath(ctx.projectRoot);
  if (!existsSync(path)) {
    return {
      hits: [],
      hint: `KG not built. Run \`dql app reindex\` to build .dql/cache/agent-kg.sqlite.`,
    };
  }
  const kg = new KGStore(path);
  try {
    const hits = kg.search({
      query: args.query,
      kinds: args.kinds as KGNodeKind[] | undefined,
      domain: args.domain,
      limit: args.limit ?? 10,
    });
    return {
      hits: hits.map((h) => ({
        nodeId: h.node.nodeId,
        kind: h.node.kind,
        name: h.node.name,
        domain: h.node.domain,
        status: h.node.status,
        description: h.node.description,
        score: h.score,
        snippet: h.snippet,
        sourcePath: h.node.sourcePath,
      })),
    };
  } finally {
    kg.close();
  }
}

export const feedbackRecordInput = {
  user: z.string().describe('User who submitted the feedback.'),
  question: z.string().describe('Original question.'),
  answerKind: z.enum(['certified', 'uncertified']).describe('How the answer was classified.'),
  blockId: z.string().optional().describe('Block id the answer was anchored to (if any).'),
  rating: z.enum(['up', 'down']).describe('Thumbs up or down.'),
  comment: z.string().optional().describe('Optional free-text rationale.'),
};

export function feedbackRecord(
  ctx: DQLContext,
  args: {
    user: string;
    question: string;
    answerKind: 'certified' | 'uncertified';
    blockId?: string;
    rating: 'up' | 'down';
    comment?: string;
  },
) {
  const path = defaultKgPath(ctx.projectRoot);
  if (!existsSync(path)) {
    return {
      ok: false,
      error: 'KG not built — run `dql app reindex` first so feedback can be persisted.',
    };
  }
  const kg = new KGStore(path);
  try {
    kg.recordFeedback({
      id: `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      user: args.user,
      question: args.question,
      answerKind: args.answerKind,
      blockId: args.blockId,
      rating: args.rating,
      comment: args.comment,
    });
    return { ok: true };
  } finally {
    kg.close();
  }
}
