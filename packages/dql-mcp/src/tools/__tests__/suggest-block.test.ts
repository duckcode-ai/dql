import { describe, it, expect, vi } from 'vitest';

vi.mock('@duckcodeailabs/dql-governance', () => ({
  Certifier: class {
    evaluate() {
      return {
        certified: false,
        errors: [],
        warnings: [{ message: 'Draft block — needs review.' }],
        checkedAt: new Date('2026-05-01T12:00:00Z'),
      };
    }
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import { suggestBlock } from '../suggest-block.js';
import { makeCtx } from './_helpers.js';

function ctxWithRefresh() {
  return makeCtx({}, { refresh: vi.fn() } as Partial<import('../../context.js').DQLContext>);
}

describe('suggestBlock tool', () => {
  it('rejects empty/whitespace block names', () => {
    const ctx = ctxWithRefresh();
    const result = suggestBlock(ctx, {
      name: '   ',
      domain: 'finance',
      owner: 'tests@example.com',
      description: 'desc',
      sql: 'SELECT 1',
    });
    expect((result as { error?: string }).error).toBe('Invalid block name.');
  });

  it('produces a structured draft envelope for a valid suggestion', () => {
    const ctx = ctxWithRefresh();
    const result = suggestBlock(ctx, {
      name: 'monthly_revenue',
      domain: 'finance',
      owner: 'tests@example.com',
      description: 'monthly gross revenue',
      sql: 'SELECT 1',
    });
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });
});
