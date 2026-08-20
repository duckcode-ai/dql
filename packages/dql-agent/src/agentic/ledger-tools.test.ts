import { describe, it, expect, vi } from 'vitest';
import type { AgentToolDefinition } from '../providers/types.js';
import { IdentifierLedger } from './identifier-ledger.js';
import {
  ANALYST_TOOL_POLICY,
  adjudicateProposedSql,
  evidenceSourceForTool,
  harvestIdentifiers,
  withLedgerHarvest,
} from './ledger-tools.js';

const tool = (name: string, output: unknown): AgentToolDefinition => ({
  name, description: 'x', inputSchema: { type: 'object', properties: {} },
  run: async () => output,
});

describe('harvestIdentifiers', () => {
  it('pulls names out of the shapes tools actually return', () => {
    const found = harvestIdentifiers({
      relation: 'analytics.public.orders',
      columns: [{ name: 'order_total' }, { name: 'ordered_at' }],
      compatibleDimensions: ['customer_name'],
    });
    expect(found).toEqual(expect.arrayContaining([
      'analytics.public.orders', 'analytics.public.orders.order_total',
      'analytics.public.orders.ordered_at', 'customer_name',
    ]));
  });

  it('takes bare strings inside identifier lists', () => {
    expect(harvestIdentifiers({ columns: ['a_col', 'b_col'] })).toEqual(['a_col', 'b_col']);
  });

  it('rejects SQL and prose, which are not identifiers', () => {
    // Admitting a whole SELECT would make the ledger vacuous.
    const found = harvestIdentifiers({
      sql: 'SELECT order_total FROM orders',
      description: 'Total revenue per customer.',
      name: 'orders',
    });
    expect(found).toEqual(['orders']);
  });

  it('deduplicates and bounds the walk so one preview cannot blow up', () => {
    const wide = { columns: Array.from({ length: 5000 }, (_, i) => `col_${i}`) };
    expect(harvestIdentifiers(wide, 50)).toHaveLength(50);
    expect(harvestIdentifiers({ columns: ['dup', 'dup', 'dup'] })).toEqual(['dup']);
  });

  it('survives nulls and primitives without throwing', () => {
    expect(harvestIdentifiers(null)).toEqual([]);
    expect(harvestIdentifiers(undefined)).toEqual([]);
    expect(harvestIdentifiers(42)).toEqual([]);
    expect(harvestIdentifiers('bare string')).toEqual([]);
  });

  it('walks deep enough for real tool payloads but stops before pathological ones', () => {
    // Six levels covers the nesting tools actually produce (result → columns →
    // entries → fields). Beyond that the payload is not a tool result shape, and
    // walking it only costs time.
    const atBound = { a: { b: { c: { d: { e: { f: { name: 'reachable' } } } } } } };
    expect(harvestIdentifiers(atBound)).toEqual(['reachable']);
    const beyond = { a: { b: { c: { d: { e: { f: { g: { name: 'too_deep' } } } } } } } };
    expect(harvestIdentifiers(beyond)).toEqual([]);
  });
});

describe('evidenceSourceForTool', () => {
  it('ranks a compiler above a preview above a catalog lookup', () => {
    // A compiler emitting SQL is the strongest claim a name exists; a catalog
    // search only says something was INDEXED under that name.
    expect(evidenceSourceForTool('compile_semantic_query')).toBe('compiler');
    expect(evidenceSourceForTool('preview_query')).toBe('preview');
    expect(evidenceSourceForTool('get_table_schema')).toBe('schema_tool');
    expect(evidenceSourceForTool('search_semantic_layer')).toBe('catalog');
  });

  it('defaults an unknown tool to the weakest evidence', () => {
    expect(evidenceSourceForTool('some_future_tool')).toBe('catalog');
  });
});

describe('withLedgerHarvest', () => {
  it('admits identifiers as the loop observes them, and returns output untouched', async () => {
    const ledger = new IdentifierLedger();
    const events: Array<{ tool: string; admitted: number }> = [];
    const [wrapped] = withLedgerHarvest(
      [tool('get_table_schema', { relation: 'orders', columns: [{ name: 'order_total' }] })],
      ledger,
      (event) => events.push(event),
    );
    const output = await wrapped!.run({});
    expect(output).toEqual({ relation: 'orders', columns: [{ name: 'order_total' }] });
    expect(ledger.isAdmitted('orders')).toBe(true);
    expect(ledger.isAdmitted('orders.order_total')).toBe(true);
    expect(events).toEqual([{ tool: 'get_table_schema', admitted: 2 }]);
  });

  it('never breaks a working tool when harvesting fails', async () => {
    // A harvesting bug must not take down a tool that returned fine. Worst case
    // is an unadmitted name, which surfaces as a recoverable correction.
    const ledger = new IdentifierLedger();
    vi.spyOn(ledger, 'admit').mockImplementation(() => { throw new Error('harvest exploded'); });
    const [wrapped] = withLedgerHarvest([tool('get_table_schema', { name: 'orders' })], ledger);
    await expect(wrapped!.run({})).resolves.toEqual({ name: 'orders' });
  });

  it('propagates a tool error rather than swallowing it', async () => {
    const ledger = new IdentifierLedger();
    const failing: AgentToolDefinition = {
      name: 'compile_semantic_query', description: 'x', inputSchema: { type: 'object', properties: {} },
      run: async () => { throw new Error('compile failed'); },
    };
    const [wrapped] = withLedgerHarvest([failing], ledger);
    await expect(wrapped!.run({})).rejects.toThrow('compile failed');
  });
});

describe('adjudicateProposedSql', () => {
  it('passes SQL whose names were all observed', async () => {
    const ledger = new IdentifierLedger();
    const [wrapped] = withLedgerHarvest(
      [tool('compile_semantic_query', { relation: 'analytics.orders', columns: ['order_total'] })],
      ledger,
    );
    await wrapped!.run({});
    expect(adjudicateProposedSql(ledger, {
      relations: ['analytics.orders'], columns: ['analytics.orders.order_total'],
    }))
      .toEqual({ ok: true });
  });

  it('returns a correction, not a refusal, for an invented column', async () => {
    // The dominant failure: a plausible-but-wrong name. `customer_tier` reads
    // better than `service_tier`, which is exactly why prompting does not fix it.
    const ledger = new IdentifierLedger();
    const [wrapped] = withLedgerHarvest(
      [tool('get_table_schema', { relation: 'dim_accounts', columns: ['service_tier'] })],
      ledger,
    );
    await wrapped!.run({});
    const verdict = adjudicateProposedSql(ledger, {
      columns: ['dim_accounts.service_tier', 'dim_accounts.servce_tier'],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.unadmitted).toEqual(['dim_accounts.servce_tier']);
    expect(verdict.correction).toContain('did you mean dim_accounts.service_tier?');
  });
});

describe('ANALYST_TOOL_POLICY', () => {
  it('states the explore-then-compose discipline the enforcement backs up', () => {
    expect(ANALYST_TOOL_POLICY).toContain('EXPLORE');
    expect(ANALYST_TOOL_POLICY).toContain('COMPOSE');
    expect(ANALYST_TOOL_POLICY).toMatch(/ONLY names a tool returned/);
  });
});
