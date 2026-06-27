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

describe('queryViaBlock — DataLex contract enforcement (Phase 2.1 wedge)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  // A registry shape sufficient for the tool — we stub it directly here
  // so the test doesn't depend on the dql-core class wiring.
  function fakeRegistry(behavior: 'ok' | 'not_found' | 'version_mismatch' | 'malformed') {
    return {
      isLoaded: () => true,
      resolve: () => {
        if (behavior === 'ok') {
          return {
            ok: true,
            contract: { id: 'commerce.Customer.mau', name: 'mau', version: 1 },
            domain: 'commerce',
            entity: 'Customer',
          };
        }
        if (behavior === 'not_found') {
          return {
            ok: false,
            reason: 'not_found',
            message: 'No such contract.',
            requestedRef: 'commerce.Customer.unknown',
          };
        }
        if (behavior === 'version_mismatch') {
          return {
            ok: false,
            reason: 'version_mismatch',
            message: 'Pinned version missing.',
            requestedRef: 'commerce.Customer.mau@99',
            availableVersions: [1, 2],
          };
        }
        return {
          ok: false,
          reason: 'malformed_ref',
          message: 'invalid syntax',
          requestedRef: 'bad-ref',
        };
      },
      list: () => [],
      reload: () => undefined,
      loadDiagnostics: () => [],
    };
  }

  it('serves the block when datalex_contract resolves cleanly', async () => {
    const ctx = makeCtx(
      {
        'My Block': makeManifestBlock({ datalexContract: 'commerce.Customer.mau' }),
      },
      { datalexRegistry: fakeRegistry('ok') as never },
    );
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { columns: [], rows: [{ x: 1 }], executionTime: 1 } }),
    } as unknown as Response)) as unknown as typeof fetch;

    const result = await queryViaBlock(ctx, { name: 'My Block' });
    expect(result).toMatchObject({ block: 'My Block', rowCount: 1 });
  });

  it('refuses the block when the contract id is not found', async () => {
    const ctx = makeCtx(
      {
        'My Block': makeManifestBlock({ datalexContract: 'commerce.Customer.unknown' }),
      },
      { datalexRegistry: fakeRegistry('not_found') as never },
    );
    const result = await queryViaBlock(ctx, { name: 'My Block' });
    expect((result as { error: string }).error).toContain('not in the loaded DataLex manifest');
    expect((result as { error: string }).error).toContain('Refusing to serve');
  });

  it('refuses the block when a pinned version is missing and surfaces availability', async () => {
    const ctx = makeCtx(
      {
        'My Block': makeManifestBlock({ datalexContract: 'commerce.Customer.mau@99' }),
      },
      { datalexRegistry: fakeRegistry('version_mismatch') as never },
    );
    const result = await queryViaBlock(ctx, { name: 'My Block' });
    expect((result as { error: string }).error).toContain('pins a version that does not exist');
    expect((result as { error: string }).error).toContain('available: 1, 2');
  });

  it('refuses the block when the contract reference is malformed', async () => {
    const ctx = makeCtx(
      {
        'My Block': makeManifestBlock({ datalexContract: 'bad-ref' }),
      },
      { datalexRegistry: fakeRegistry('malformed') as never },
    );
    const result = await queryViaBlock(ctx, { name: 'My Block' });
    expect((result as { error: string }).error).toContain('malformed');
  });

  it('serves the block when no DataLex registry is loaded (project hasn\'t adopted DataLex)', async () => {
    // makeCtx's default registry returns isLoaded() === false.
    const ctx = makeCtx({
      'My Block': makeManifestBlock({ datalexContract: 'commerce.Customer.mau' }),
    });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { columns: [], rows: [], executionTime: 0 } }),
    } as unknown as Response)) as unknown as typeof fetch;

    const result = await queryViaBlock(ctx, { name: 'My Block' });
    expect((result as { block?: string }).block).toBe('My Block');
  });
});

describe('queryViaBlock — grain gate (defense in depth)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  function okFetch() {
    return vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { columns: [], rows: [{ x: 1 }], executionTime: 1 } }),
    } as unknown as Response)) as unknown as typeof fetch;
  }

  it('refuses a grain-mismatched block even when called directly', async () => {
    const ctx = makeCtx({
      'Account Revenue': makeManifestBlock({
        name: 'Account Revenue',
        grain: 'account_id',
        entities: ['Account'],
        declaredOutputs: ['account_id', 'total_revenue'],
      }),
    });
    globalThis.fetch = okFetch();

    const result = await queryViaBlock(ctx, {
      name: 'Account Revenue',
      question: 'Show revenue by region',
    });
    expect((result as { error?: string }).error).toMatch(/failed the grain gate/i);
    expect((result as { error?: string }).error).toMatch(/account.*region.*Tier 2/i);
    expect((result as { grainGate?: { allow: boolean } }).grainGate?.allow).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('serves an exact-grain block when the question matches the declared grain', async () => {
    const ctx = makeCtx({
      'Region Revenue': makeManifestBlock({
        name: 'Region Revenue',
        grain: 'region',
        entities: ['Region'],
        declaredOutputs: ['region', 'total_revenue'],
      }),
    });
    globalThis.fetch = okFetch();

    const result = await queryViaBlock(ctx, {
      name: 'Region Revenue',
      question: 'Show revenue by region',
    });
    expect((result as { block?: string }).block).toBe('Region Revenue');
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it('serves a finer-grain block that can roll up to the requested grain', async () => {
    const ctx = makeCtx({
      'Daily Revenue': makeManifestBlock({
        name: 'Daily Revenue',
        grain: 'day',
        declaredOutputs: ['day', 'total_revenue'],
      }),
    });
    globalThis.fetch = okFetch();

    const result = await queryViaBlock(ctx, {
      name: 'Daily Revenue',
      question: 'Show revenue by week',
    });
    expect((result as { block?: string }).block).toBe('Daily Revenue');
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it('does not gate when no question is supplied (backward compatible)', async () => {
    const ctx = makeCtx({
      'Account Revenue': makeManifestBlock({
        name: 'Account Revenue',
        grain: 'account_id',
        entities: ['Account'],
      }),
    });
    globalThis.fetch = okFetch();

    const result = await queryViaBlock(ctx, { name: 'Account Revenue' });
    expect((result as { block?: string }).block).toBe('Account Revenue');
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it('does not gate when the question carries no extractable grain', async () => {
    const ctx = makeCtx({
      'Account Revenue': makeManifestBlock({
        name: 'Account Revenue',
        grain: 'account_id',
        entities: ['Account'],
      }),
    });
    globalThis.fetch = okFetch();

    const result = await queryViaBlock(ctx, {
      name: 'Account Revenue',
      question: 'Run Account Revenue',
    });
    expect((result as { block?: string }).block).toBe('Account Revenue');
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});
