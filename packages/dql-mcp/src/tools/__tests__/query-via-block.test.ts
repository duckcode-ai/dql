import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { queryViaBlock } from '../query-via-block.js';
import { makeCtx, makeManifestBlock } from './_helpers.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(() => 'block "My Block" { type = "custom" status = "certified" query = "SELECT 1" }'),
  };
});

describe('queryViaBlock — certified-only enforcement (the wedge)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('refuses unknown blocks with a clear error', async () => {
    const ctx = makeCtx({});
    const result = await queryViaBlock(ctx, { name: 'Nonexistent' });
    expect(result).toEqual({ error: 'No block named "Nonexistent".' });
  });

  it('refuses draft-status blocks (only certified can serve to AI agents)', async () => {
    const ctx = makeCtx({
      'Draft Block': makeManifestBlock({ name: 'Draft Block', status: 'draft' }),
    });
    const result = await queryViaBlock(ctx, { name: 'Draft Block' });
    expect((result as { error: string }).error).toContain('only certified blocks can be executed via MCP');
    expect((result as { error: string }).error).toContain('"draft"');
  });

  it('refuses review-status blocks', async () => {
    const ctx = makeCtx({
      'Review Block': makeManifestBlock({ name: 'Review Block', status: 'review' }),
    });
    const result = await queryViaBlock(ctx, { name: 'Review Block' });
    expect((result as { error: string }).error).toContain('"review"');
  });

  it('returns the certified block result on the happy path', async () => {
    const ctx = makeCtx({ 'My Block': makeManifestBlock() });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          columns: [{ name: 'foo', type: 'integer' }],
          rows: [{ foo: 1 }, { foo: 2 }],
          executionTime: 12,
        },
      }),
    } as unknown as Response)) as unknown as typeof fetch;

    const result = await queryViaBlock(ctx, { name: 'My Block' });
    expect(result).toMatchObject({
      block: 'My Block',
      blockPath: 'blocks/my-block.dql',
      rowCount: 2,
      durationMs: 12,
      columns: [{ name: 'foo', type: 'integer' }],
    });
  });

  it('honors the limit param', async () => {
    const ctx = makeCtx({ 'My Block': makeManifestBlock() });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: {
          columns: [],
          rows: [{ foo: 1 }, { foo: 2 }, { foo: 3 }, { foo: 4 }],
          executionTime: 5,
        },
      }),
    } as unknown as Response)) as unknown as typeof fetch;

    const result = await queryViaBlock(ctx, { name: 'My Block', limit: 2 });
    expect((result as { rows: unknown[] }).rows).toHaveLength(2);
  });

  it('reports a clear, actionable error when the runtime is unreachable', async () => {
    const ctx = makeCtx({ 'My Block': makeManifestBlock() });
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await queryViaBlock(ctx, { name: 'My Block' });
    expect((result as { error: string }).error).toMatch(/Could not reach DQL runtime/);
    expect((result as { error: string }).error).toMatch(/dql serve/);
  });

  it('surfaces the runtime error response unchanged', async () => {
    const ctx = makeCtx({ 'My Block': makeManifestBlock() });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ error: 'Compile failed: column ordered_at not found' }),
    } as unknown as Response)) as unknown as typeof fetch;

    const result = await queryViaBlock(ctx, { name: 'My Block' });
    expect(result).toEqual({ error: 'Compile failed: column ordered_at not found' });
  });

  it('respects DQL_RUNTIME_URL when no serverUrl is passed', async () => {
    const ctx = makeCtx({ 'My Block': makeManifestBlock() });
    process.env.DQL_RUNTIME_URL = 'http://example.test:9999';
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { columns: [], rows: [], executionTime: 0 } }),
    } as unknown as Response));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await queryViaBlock(ctx, { name: 'My Block' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://example.test:9999/api/notebook/execute',
      expect.any(Object),
    );
    delete process.env.DQL_RUNTIME_URL;
  });
});
