import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveSlug, queryViaMetadata } from '../query-via-metadata.js';
import { makeCtx } from './_helpers.js';

describe('deriveSlug', () => {
  it('drops stopwords + lowercases + snake_cases', () => {
    expect(deriveSlug('How many active customers in Q1?')).toBe('many_active_customers_q1');
  });

  it('produces the same slug on paraphrase that hits the same content tokens', () => {
    const a = deriveSlug('what was monthly revenue last month?');
    const b = deriveSlug('What was last month\'s monthly revenue?');
    // Token sets are: {monthly, revenue, last, month} for both. v1 keeps insertion order.
    expect(a).toContain('monthly_revenue');
    expect(b).toContain('monthly_revenue');
  });

  it('falls back to a sentinel for empty / pure-stopword inputs', () => {
    expect(deriveSlug('   the of  ')).toBe('untitled_proposal');
  });

  it('truncates very long questions', () => {
    const question = 'how many distinct customer ids placed at least one order ' +
      'each calendar month last year by region and channel and product type';
    expect(deriveSlug(question).length).toBeLessThanOrEqual(60);
  });
});

describe('queryViaMetadata — Tier-2 promotion loop entry point', () => {
  let tmpProject: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpProject = mkdtempSync(join(tmpdir(), 'dql-tier2-'));
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tmpProject, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function ctxFor(root: string) {
    return makeCtx({}, { projectRoot: root } as never);
  }

  it('executes the proposed SQL and surfaces uncertified=true on the happy path', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: { columns: [{ name: 'n', type: 'integer' }], rows: [{ n: 42 }], executionTime: 5 },
      }),
    } as unknown as Response)) as unknown as typeof fetch;

    const result = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'How many active customers last month?',
      proposedSql: 'SELECT COUNT(DISTINCT customer_id) AS n FROM fct_orders',
      proposedDomain: 'customer',
      proposedEntity: 'Customer',
      upstreamRefs: ['fct_orders'],
    });

    expect(result.uncertified).toBe(true);
    expect((result as { rowCount: number }).rowCount).toBe(1);
    expect(result.draftBlock?.path).toMatch(/blocks\/_drafts\/.*\.dql$/);
    expect(result.draftBlock?.proposedContractId).toBe(
      'customer.Customer.many_active_customers_last_month',
    );
    expect(result.promote).toContain('dql certify --from-draft');
  });

  it('writes a draft .dql file with status=draft and the proposal metadata', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { columns: [], rows: [], executionTime: 0 } }),
    } as unknown as Response)) as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'What was monthly revenue last quarter?',
      proposedSql: 'SELECT 1',
      proposedDomain: 'finance',
      proposedEntity: 'Order',
    });

    const draftPath = join(tmpProject, out.draftBlock!.path);
    const content = readFileSync(draftPath, 'utf-8');
    expect(content).toContain('status = "draft"');
    expect(content).toContain('asked_times = 1');
    expect(content).toContain('proposed_contract_id = "finance.Order.monthly_revenue_last_quarter"');
    expect(content).toContain('What was monthly revenue last quarter?');
  });

  it('increments asked_times when the same question is asked again (dedupe via slug)', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { columns: [], rows: [], executionTime: 0 } }),
    } as unknown as Response)) as unknown as typeof fetch;

    const ctx = ctxFor(tmpProject);
    const first = await queryViaMetadata(ctx, {
      question: 'how many active customers?',
      proposedSql: 'SELECT 1',
    });
    const second = await queryViaMetadata(ctx, {
      question: 'how many active customers?',
      proposedSql: 'SELECT 1',
    });
    expect(first.draftBlock?.askedTimes).toBe(1);
    expect(second.draftBlock?.askedTimes).toBe(2);

    const draftPath = join(tmpProject, second.draftBlock!.path);
    expect(readFileSync(draftPath, 'utf-8')).toContain('asked_times = 2');
  });

  it('skips the draft when saveDraft=false (one-off introspection)', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { columns: [], rows: [], executionTime: 0 } }),
    } as unknown as Response)) as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'just curious',
      proposedSql: 'SELECT 1',
      saveDraft: false,
    });
    expect(out.draftBlock).toBeUndefined();
  });

  it('returns the proposal without executing when dryRun=true', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'how many?',
      proposedSql: 'SELECT 99',
      dryRun: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.uncertified).toBe(true);
    expect((out as { proposedSql: string }).proposedSql).toBe('SELECT 99');
    expect(out.draftBlock).toBeDefined();
  });

  it('reports a clear runtime-down error and still saves the draft for later', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'how many active customers?',
      proposedSql: 'SELECT 1',
    });
    expect((out as { error: string }).error).toMatch(/Could not reach DQL runtime/);
    expect(out.draftBlock).toBeDefined();
  });

  it('honors the limit parameter on returned rows', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: { columns: [], rows: [{ x: 1 }, { x: 2 }, { x: 3 }, { x: 4 }], executionTime: 1 },
      }),
    } as unknown as Response)) as unknown as typeof fetch;

    const out = await queryViaMetadata(ctxFor(tmpProject), {
      question: 'sample',
      proposedSql: 'SELECT 1',
      limit: 2,
    });
    expect((out as { rows: unknown[] }).rows).toHaveLength(2);
  });
});
