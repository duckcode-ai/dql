import { mkdtempSync, rmSync } from 'node:fs';
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

describe('correction-memory MCP tools', () => {
  it('record_correction → approve_hint → list_hints lifecycle', () => {
    const ctx = makeCtx();

    const recorded = recordCorrection(ctx, {
      question: 'What is net revenue for growth last quarter?',
      wrongAnswer: 'SELECT SUM(amount) FROM orders',
      correction: 'Use net_amount and exclude refunds.',
      scope: { metric: 'revenue', domain: 'growth' },
      author: 'analyst',
    }) as { ok: boolean; hintId: string; status: string };

    expect(recorded.ok).toBe(true);
    expect(recorded.status).toBe('candidate');

    // Candidates are listed but flagged as not-yet-usable.
    const candidates = listHints(ctx, { status: 'candidate' }) as { count: number };
    expect(candidates.count).toBe(1);
    expect((listHints(ctx, { status: 'approved' }) as { count: number }).count).toBe(0);

    const approved = approveHint(ctx, {
      hintId: recorded.hintId,
      decision: 'approved',
      reviewer: 'lead',
    }) as { ok: boolean; status: string };
    expect(approved.ok).toBe(true);
    expect(approved.status).toBe('approved');

    const approvedList = listHints(ctx, { status: 'approved', metric: 'revenue' }) as {
      count: number;
      hints: Array<{ scope: { metric?: string; domain?: string } }>;
    };
    expect(approvedList.count).toBe(1);
    expect(approvedList.hints[0].scope).toMatchObject({ metric: 'revenue', domain: 'growth' });
  });

  it('approve_hint errors clearly for an unknown hint', () => {
    const ctx = makeCtx();
    const result = approveHint(ctx, { hintId: 'hint_missing', decision: 'approved', reviewer: 'lead' }) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });
});
