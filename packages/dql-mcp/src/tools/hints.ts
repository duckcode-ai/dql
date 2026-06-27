/**
 * MCP tools for scoped correction memory ("mini Hint Graph").
 *
 * `record_correction` — capture a Tier-2 correction as a Git trace + candidate
 *                       hint (NOT used until approved).
 * `approve_hint`      — human review: approve/reject a candidate hint. Approval
 *                       is the only path that makes a hint usable in retrieval.
 * `list_hints`        — list hints (optionally filtered by status) for review.
 *
 * Source of truth is Git (`.dql/hints`, `.dql/traces`, `.dql/reviews`); SQLite
 * (`.dql/cache/agent-kg.sqlite`) is reindexed automatically on every write.
 */

import { z } from 'zod';
import type { DQLContext } from '../context.js';
import {
  getHintFromGit,
  listHintsFromGit,
  recordCorrectionTrace,
  reviewHint,
  type Hint,
} from '@duckcodeailabs/dql-agent';

const scopeSchema = {
  metric: z.string().optional().describe('Metric / KPI the hint is about, e.g. "revenue".'),
  dbtModel: z.string().optional().describe('dbt model the hint is about, e.g. "fct_orders".'),
  domain: z.string().optional().describe('Business domain, e.g. "growth".'),
  dialect: z.string().optional().describe('Warehouse SQL dialect, e.g. "duckdb", "snowflake".'),
  term: z.string().optional().describe('Business term the hint refines.'),
  block: z.string().optional().describe('Certified block the hint relates to.'),
};

export const recordCorrectionInput = {
  question: z.string().describe('The analyst question the Tier-2 answer was for.'),
  wrongAnswer: z.string().describe('The generated answer/SQL that was wrong.'),
  correction: z.string().describe('The analyst correction: corrected SQL, rule, or guidance.'),
  scope: z.object(scopeSchema).describe('Scope the correction applies within. A hint only applies inside its scope.'),
  rationale: z.string().optional().describe('Why the original answer was wrong.'),
  author: z.string().optional().describe('Who recorded the correction.'),
  correctedSql: z.string().optional().describe('Optional canonical corrected SQL to endorse.'),
  hintTitle: z.string().optional().describe('Override the derived hint title.'),
  hintGuidance: z.string().optional().describe('Override the hint guidance (defaults to the correction).'),
  tags: z.array(z.string()).optional().describe('Searchable keywords.'),
  anchorObjectKey: z.string().optional().describe('contextPackId / blockId the correction anchored to.'),
};

export function recordCorrection(
  ctx: DQLContext,
  args: {
    question: string;
    wrongAnswer: string;
    correction: string;
    scope: {
      metric?: string;
      dbtModel?: string;
      domain?: string;
      dialect?: string;
      term?: string;
      block?: string;
    };
    rationale?: string;
    author?: string;
    correctedSql?: string;
    hintTitle?: string;
    hintGuidance?: string;
    tags?: string[];
    anchorObjectKey?: string;
  },
) {
  const { trace, hint } = recordCorrectionTrace(ctx.projectRoot, {
    question: args.question,
    scope: args.scope,
    wrongAnswer: args.wrongAnswer,
    correction: args.correction,
    rationale: args.rationale,
    author: args.author,
    correctedSql: args.correctedSql,
    hintTitle: args.hintTitle,
    hintGuidance: args.hintGuidance,
    tags: args.tags,
    anchorObjectKey: args.anchorObjectKey,
  });
  return {
    ok: true,
    traceId: trace.id,
    hintId: hint.id,
    status: hint.status,
    note:
      'Recorded as a CANDIDATE hint. It is NOT used in answers until approved via `approve_hint`. ' +
      'Both the trace and hint are written under .dql/ and should be committed to Git.',
    hint: summarizeHint(hint),
  };
}

export const approveHintInput = {
  hintId: z.string().describe('Id of the candidate hint to review.'),
  decision: z.enum(['approved', 'rejected']).describe('Approve (usable in retrieval) or reject.'),
  reviewer: z.string().describe('Who is reviewing.'),
  note: z.string().optional().describe('Optional review note.'),
};

export function approveHint(
  ctx: DQLContext,
  args: { hintId: string; decision: 'approved' | 'rejected'; reviewer: string; note?: string },
) {
  const existing = getHintFromGit(ctx.projectRoot, args.hintId);
  if (!existing) {
    return { ok: false, error: `Hint ${args.hintId} not found under .dql/hints/.` };
  }
  const result = reviewHint(ctx.projectRoot, {
    hintId: args.hintId,
    decision: args.decision,
    reviewer: args.reviewer,
    note: args.note,
  });
  if (!result) {
    return { ok: false, error: `Could not review hint ${args.hintId}.` };
  }
  return {
    ok: true,
    hintId: result.hint.id,
    status: result.hint.status,
    reviewId: result.review.id,
    note:
      result.hint.status === 'approved'
        ? 'Approved. This scoped hint will now be folded into matching Tier-2 drafts (after certified routing). Commit the updated .dql/ files to Git.'
        : 'Rejected. This hint will not be used. Commit the updated .dql/ files to Git.',
    hint: summarizeHint(result.hint),
  };
}

export const listHintsInput = {
  status: z.enum(['candidate', 'approved', 'rejected']).optional().describe('Filter by lifecycle status.'),
  domain: z.string().optional().describe('Filter to a single domain scope.'),
  metric: z.string().optional().describe('Filter to a single metric scope.'),
};

export function listHints(
  ctx: DQLContext,
  args: { status?: 'candidate' | 'approved' | 'rejected'; domain?: string; metric?: string },
) {
  let hints = listHintsFromGit(ctx.projectRoot);
  if (args.status) hints = hints.filter((hint) => hint.status === args.status);
  if (args.domain) hints = hints.filter((hint) => eq(hint.scope.domain, args.domain));
  if (args.metric) hints = hints.filter((hint) => eq(hint.scope.metric, args.metric));
  return {
    count: hints.length,
    hints: hints.map(summarizeHint),
  };
}

function summarizeHint(hint: Hint) {
  return {
    id: hint.id,
    title: hint.title,
    status: hint.status,
    guidance: hint.guidance,
    scope: hint.scope,
    correctedSql: hint.correctedSql,
    traceId: hint.traceId,
    author: hint.author,
    reviewer: hint.reviewer,
    updatedAt: hint.updatedAt,
  };
}

function eq(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
