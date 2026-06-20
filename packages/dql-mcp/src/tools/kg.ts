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
import {
  KGStore,
  buildLocalContextPack,
  defaultKgPath,
  ensureMetadataCatalogFresh,
  reindexProject,
  type KGNodeKind,
} from '@duckcodeailabs/dql-agent';

export const kgSearchInput = {
  query: z.string().describe('Natural-language or keyword query.'),
  kinds: z
    .array(
	      z.enum([
	        'block', 'term', 'business_view',
	        'metric', 'dimension', 'measure', 'entity', 'semantic_model', 'saved_query', 'domain',
	        'dbt_model', 'dbt_source', 'notebook', 'dashboard', 'app', 'skill',
	      ]),
    )
    .optional()
    .describe('Optional filter: only return nodes of these kinds.'),
  domain: z.string().optional().describe('Filter to a single business domain.'),
  limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 10).'),
};

export async function kgSearch(
  ctx: DQLContext,
  args: { query: string; kinds?: string[]; domain?: string; limit?: number },
) {
  const path = defaultKgPath(ctx.projectRoot);
  const refreshError = await reindexProject(ctx.projectRoot, { kgPath: path })
    .then(() => null)
    .catch((err) => err instanceof Error ? err.message : String(err));
  if (refreshError) {
    return {
      hits: [],
      hint: `KG refresh failed: ${refreshError}`,
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
        owner: h.node.owner,
        description: h.node.description,
        tags: h.node.tags,
        sourceTier: h.node.sourceTier,
        certification: h.node.certification,
        provenance: h.node.provenance,
        businessOutcome: h.node.businessOutcome,
        businessOwner: h.node.businessOwner,
        decisionUse: h.node.decisionUse,
        reviewCadence: h.node.reviewCadence,
        pattern: h.node.pattern,
        grain: h.node.grain,
        entities: h.node.entities,
        outputs: h.node.declaredOutputs,
        dimensions: h.node.dimensions,
        allowedFilters: h.node.allowedFilters,
        parameterPolicy: h.node.parameterPolicy,
        filterBindings: h.node.filterBindings,
        sourceSystems: h.node.sourceSystems,
        replacementFor: h.node.replacementFor,
        datalexContract: h.node.datalexContract,
        boundedContext: h.node.boundedContext,
        primaryTerms: h.node.primaryTerms,
        businessRules: h.node.businessRules,
        caveats: h.node.caveats,
        score: h.score,
        snippet: h.snippet,
        sourcePath: h.node.sourcePath,
      })),
    };
  } finally {
    kg.close();
  }
}

export const inspectMetadataContextInput = {
  question: z.string().describe('User question to ground in the local SQLite metadata catalog.'),
  focusObjectKey: z.string().optional().describe('Optional object key, such as dql:block:Revenue or semantic:metric:revenue.'),
  objectTypes: z.array(z.string()).optional().describe('Optional metadata object type filter.'),
  limit: z.number().int().min(1).max(160).optional().describe('Maximum selected objects in the context pack.'),
};

export async function inspectMetadataContext(
  ctx: DQLContext,
  args: {
    question: string;
    focusObjectKey?: string;
    objectTypes?: string[];
    limit?: number;
  },
) {
  const refresh = await ensureMetadataCatalogFresh(ctx.projectRoot)
    .catch((err) => ({
      path: '',
      refreshed: false,
      objectCount: 0,
      edgeCount: 0,
      diagnostics: [{
        kind: 'metadata',
        severity: 'error' as const,
        message: err instanceof Error ? err.message : String(err),
      }],
      fingerprint: '',
    }));
  const contextPack = await buildLocalContextPack(ctx.projectRoot, {
    question: args.question,
    focusObjectKey: args.focusObjectKey,
    objectTypes: args.objectTypes,
    limit: args.limit,
  });
  return {
    catalog: {
      path: refresh.path || '.dql/cache/metadata.sqlite',
      refreshed: refresh.refreshed,
      objectCount: refresh.objectCount,
      edgeCount: refresh.edgeCount,
      diagnostics: refresh.diagnostics,
    },
    contextPack,
  };
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
