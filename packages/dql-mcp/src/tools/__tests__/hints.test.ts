import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';

import { approveHint, listHints, recordCorrection } from '../hints.js';
import { DQLContext } from '../../context.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeCtx(): DQLContext {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-mcp-hints-'));
  tempDirs.push(projectRoot);
  return new DQLContext({ projectRoot });
}

function makeV3Ctx(): DQLContext {
  const ctx = makeCtx();
  writeFileSync(join(ctx.projectRoot, 'dql.config.json'), JSON.stringify({
    project: 'mcp_hints',
    manifestVersion: 3,
    modeling: { mode: 'dbt-first' },
  }));
  return ctx;
}

describe('correction-memory MCP tools', () => {
  it('record_correction → approve_hint → list_hints lifecycle', async () => {
    const ctx = makeCtx();

    const recorded = await recordCorrection(ctx, {
      question: 'What is net revenue for growth last quarter?',
      wrongAnswer: 'SELECT SUM(amount) FROM orders',
      correction: 'Use net_amount and exclude refunds.',
      lesson: {
        category: 'filter_rule',
        rule: 'Use net amount and exclude refunds for recognized revenue.',
        intentExamples: ['Net revenue by region'],
        avoid: ['Do not sum gross amount.'],
        expectedOutcome: 'Recognized revenue excludes refunded orders.',
      },
      scope: { metric: 'revenue', domain: 'growth' },
      author: 'analyst',
    }) as { ok: boolean; hintId: string; status: string };

    expect(recorded.ok).toBe(true);
    expect(recorded.status).toBe('candidate');

    // Candidates are listed but flagged as not-yet-usable.
    const candidates = listHints(ctx, { status: 'candidate' }) as { count: number };
    expect(candidates.count).toBe(1);
    expect((listHints(ctx, { status: 'approved' }) as { count: number }).count).toBe(0);

    const approved = await approveHint(ctx, {
      hintId: recorded.hintId,
      decision: 'approved',
      reviewer: 'lead',
    }) as { ok: boolean; status: string };
    expect(approved.ok).toBe(true);
    expect(approved.status).toBe('approved');

    const approvedList = listHints(ctx, { status: 'approved', metric: 'revenue' }) as {
      count: number;
      hints: Array<{
        scope: { metric?: string; domain?: string };
        lesson?: { category: string; intentExamples: string[] };
      }>;
    };
    expect(approvedList.count).toBe(1);
    expect(approvedList.hints[0].scope).toMatchObject({ metric: 'revenue', domain: 'growth' });
    expect(approvedList.hints[0].lesson).toMatchObject({
      category: 'filter_rule',
      intentExamples: ['Net revenue by region'],
    });
  });

  it('approve_hint errors clearly for an unknown hint', async () => {
    const ctx = makeCtx();
    const result = await approveHint(ctx, { hintId: 'hint_missing', decision: 'approved', reviewer: 'lead' }) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('uses the governed v3 lifecycle and refuses unsafe fabricated approval', async () => {
    const ctx = makeV3Ctx();
    const recorded = await recordCorrection(ctx, {
      question: 'Show payroll',
      wrongAnswer: 'SELECT employee_id FROM employees',
      correction: 'Delete the source',
      correctedSql: 'DELETE FROM secret.payroll',
      scope: { domain: 'people' },
      author: 'analyst',
    }) as { ok: boolean; hintId: string; status: string };

    const reviewed = await approveHint(ctx, {
      hintId: recorded.hintId,
      decision: 'approved',
      reviewer: 'lead',
      note: 'I reviewed this correction.',
    }) as { ok: boolean; status: string; error?: string };

    expect(recorded.status).toBe('candidate');
    expect(reviewed.ok).toBe(false);
    expect(reviewed.status).toBe('candidate');
    expect(reviewed.error).toContain('remains a candidate');
  });
});
