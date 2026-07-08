import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KGStore } from './sqlite-fts.js';
import type { KGNode, KGEdge } from './types.js';

function nodes(): KGNode[] {
  return [
    {
      nodeId: 'block:revenue_total',
      kind: 'block',
      name: 'revenue_total',
      domain: 'growth',
      status: 'certified',
      description: 'Total revenue across all customer segments.',
      llmContext: 'Use this for top-level revenue trends. ARR + new logo revenue.',
      tags: ['revenue', 'growth'],
      sql: 'SELECT SUM(amount) AS total_revenue FROM orders',
      examples: [{ question: 'What was revenue last week?', sql: 'SELECT SUM(amount) FROM orders' }],
    },
    {
      nodeId: 'block:churn_logo',
      kind: 'block',
      name: 'churn_logo',
      domain: 'retention',
      status: 'draft',
      description: 'Logo churn count this quarter.',
      tags: ['churn', 'retention'],
    },
    {
      nodeId: 'metric:arr',
      kind: 'metric',
      name: 'arr',
      domain: 'growth',
      description: 'Annualized recurring revenue.',
    },
  ];
}

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-fts-'));
  dbPath = join(dir, 'kg.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('KGStore', () => {
  it('rebuilds + retrieves nodes', () => {
    const kg = new KGStore(dbPath);
    kg.rebuild(nodes(), [
      { src: 'block:revenue_total', dst: 'metric:arr', kind: 'aggregates' },
    ]);
    const node = kg.getNode('block:revenue_total');
    expect(node?.status).toBe('certified');
    expect(node?.tags).toEqual(['revenue', 'growth']);
    expect(node?.sql).toBe('SELECT SUM(amount) AS total_revenue FROM orders');
    kg.close();
  });

  it('FTS5 search ranks revenue blocks above churn for "revenue last week"', () => {
    const kg = new KGStore(dbPath);
    kg.rebuild(nodes(), []);
    const hits = kg.search({ query: 'revenue last week' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].node.nodeId).toBe('block:revenue_total');
    expect(hits[0].node.sql).toBe('SELECT SUM(amount) AS total_revenue FROM orders');
    kg.close();
  });

  it('domain filter narrows results', () => {
    const kg = new KGStore(dbPath);
    kg.rebuild(nodes(), []);
    const hits = kg.search({ query: 'revenue', domain: 'retention' });
    expect(hits.every((h) => h.node.domain === 'retention')).toBe(true);
    kg.close();
  });

  it('kinds filter restricts to specified kinds', () => {
    const kg = new KGStore(dbPath);
    kg.rebuild(nodes(), []);
    const hits = kg.search({ query: 'revenue', kinds: ['metric'] });
    expect(hits.every((h) => h.node.kind === 'metric')).toBe(true);
    kg.close();
  });

  it('records and aggregates feedback', () => {
    const kg = new KGStore(dbPath);
    kg.rebuild(nodes(), []);
    kg.recordFeedback({
      id: 'f1', ts: '2026-04-25T00:00:00Z', user: 'a', question: 'q', answerKind: 'certified',
      blockId: 'block:revenue_total', rating: 'up',
    });
    kg.recordFeedback({
      id: 'f2', ts: '2026-04-25T01:00:00Z', user: 'b', question: 'q', answerKind: 'certified',
      blockId: 'block:revenue_total', rating: 'up',
    });
    expect(kg.blockFeedbackScore('block:revenue_total')).toEqual({ up: 2, down: 0 });
    kg.close();
  });

  it('feedback-aware ranking demotes a downvoted block, bounded to 15% (W4.1)', () => {
    const kg = new KGStore(dbPath);
    kg.rebuild(nodes(), []);
    const scoreOf = () => kg.search({ query: 'revenue' }).find((h) => h.node.nodeId === 'block:revenue_total')?.score ?? 0;
    const before = scoreOf();
    expect(before).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) {
      kg.recordFeedback({ id: `d${i}`, ts: '2026-07-01T00:00:00Z', user: 'u', question: 'q', answerKind: 'certified', blockId: 'revenue_total', rating: 'down' });
    }
    const after = scoreOf();
    expect(after).toBeLessThan(before);          // downvotes demote it
    expect(after).toBeGreaterThanOrEqual(before * 0.85); // but bounded to -15%
    kg.close();
  });

  it('feedback multiplier is bounded and saturating (W4.1)', () => {
    const kg = new KGStore(dbPath);
    kg.rebuild(nodes(), []);
    for (let i = 0; i < 100; i++) {
      kg.recordFeedback({ id: `u${i}`, ts: '2026-07-01T00:00:00Z', user: 'u', question: 'q', answerKind: 'certified', blockId: 'revenue_total', rating: 'up' });
    }
    const multiplier = kg.feedbackMultipliers(['revenue_total']).get('revenue_total')!;
    expect(multiplier).toBeGreaterThan(1);
    expect(multiplier).toBeLessThanOrEqual(1.15);
    kg.close();
  });

  it('promotionCandidates surfaces uncertified upvoted answers without downvotes', () => {
    const kg = new KGStore(dbPath);
    kg.rebuild(nodes(), []);
    for (const i of [1, 2, 3, 4, 5]) {
      kg.recordFeedback({
        id: `f${i}`, ts: new Date().toISOString(), user: `u${i}`, question: 'median order value?',
        answerKind: 'uncertified', blockId: 'block:median_order_value', rating: 'up',
      });
    }
    const cands = kg.promotionCandidates(5);
    expect(cands).toHaveLength(1);
    expect(cands[0].blockId).toBe('block:median_order_value');
    expect(cands[0].ups).toBe(5);
    kg.close();
  });

  it('rebuild is idempotent (re-running clears prior rows)', () => {
    const kg = new KGStore(dbPath);
    kg.rebuild(nodes(), []);
    kg.rebuild([nodes()[0]], []);
    expect(kg.getNode('block:churn_logo')).toBeNull();
    expect(kg.getNode('block:revenue_total')).not.toBeNull();
    kg.close();
  });

  it('records rebuild metadata used by fingerprint-gated reindexing', () => {
    const kg = new KGStore(dbPath);
    kg.rebuild(nodes(), [], { fingerprint: 'kg-v1' });
    expect(kg.meta('built_at')).toBeTruthy();
    expect(kg.meta('fingerprint')).toBe('kg-v1');
    expect(kg.meta('node_count')).toBe('3');
    expect(kg.meta('edge_count')).toBe('0');

    kg.rebuild([nodes()[0]], [], { fingerprint: 'kg-v2' });
    expect(kg.meta('fingerprint')).toBe('kg-v2');
    expect(kg.meta('node_count')).toBe('1');

    kg.rebuild(nodes(), []);
    expect(kg.meta('fingerprint')).toBeNull();
    kg.close();
  });

  it('handles wildcard injection without errors', () => {
    const kg = new KGStore(dbPath);
    kg.rebuild(nodes(), []);
    // FTS5 wildcards/operators stripped — should still find revenue.
    const hits = kg.search({ query: 'revenue*' });
    expect(hits.some((h) => h.node.name === 'revenue_total')).toBe(true);
    kg.close();
  });

  it('supports safe prefix recall for partial business terms', () => {
    const kg = new KGStore(dbPath);
    kg.rebuild(nodes(), []);
    const hits = kg.search({ query: 'reven' });
    expect(hits.some((h) => h.node.name === 'revenue_total')).toBe(true);
    kg.close();
  });

  it('treats upstream SQL labels as plain search text, not FTS columns', () => {
    const kg = new KGStore(dbPath);
    kg.rebuild(nodes(), []);
    const hits = kg.search({
      query: 'What changed?\n\nCurrent upstream SQL:\nSELECT COUNT(*) FROM orders WHERE status = \'paid\'',
    });
    expect(Array.isArray(hits)).toBe(true);
    kg.close();
  });

  it('does not match certified artifacts from generic stop words alone', () => {
    const kg = new KGStore(dbPath);
    kg.rebuild(nodes(), []);
    const hits = kg.search({ query: 'Explain this current query' });
    expect(hits).toHaveLength(0);
    kg.close();
  });
});

describe('KGStore cross-domain traversal', () => {
  it('finds neighbors and a cross-domain join path over kg_edges', () => {
    const kg = new KGStore(dbPath);
    // growth: arr -> revenue_total ; retention: churn_logo ; bridged by a shared entity.
    kg.rebuild(nodes(), [
      { src: 'metric:arr', dst: 'block:revenue_total', kind: 'defines' },
      { src: 'block:revenue_total', dst: 'entity:customer', kind: 'reads_from' },
      { src: 'block:churn_logo', dst: 'entity:customer', kind: 'reads_from' },
    ]);

    const neighbors = kg.neighbors('block:revenue_total');
    const neighborIds = neighbors.map((n) => n.node.nodeId).sort();
    // both the inbound 'defines' (metric:arr) and outbound 'reads_from' (entity:customer)
    expect(neighborIds).toContain('metric:arr');

    const outOnly = kg.neighbors('block:revenue_total', { direction: 'out' }).map((n) => n.node.nodeId);
    expect(outOnly).not.toContain('metric:arr');

    // cross-domain join: growth revenue_total <-> retention churn_logo via the shared customer entity.
    const path = kg.findJoinPath('block:revenue_total', 'block:churn_logo');
    expect(path).toEqual(['block:revenue_total', 'entity:customer', 'block:churn_logo']);

    expect(kg.findJoinPath('metric:arr', 'metric:arr')).toEqual(['metric:arr']);
    expect(kg.findJoinPath('block:revenue_total', 'metric:nonexistent')).toBeNull();
    kg.close();
  });

  it('does not starve inbound edges when outbound edges exceed the limit', () => {
    const kg = new KGStore(dbPath);
    const hubNodes: KGNode[] = [
      { nodeId: 'entity:customer', kind: 'entity', name: 'customer', domain: 'shared' },
      { nodeId: 'block:churn', kind: 'block', name: 'churn', domain: 'retention' },
      ...Array.from({ length: 5 }, (_, i) => ({ nodeId: `block:out${i}`, kind: 'block' as const, name: `out${i}`, domain: 'growth' })),
    ];
    const edges: KGEdge[] = [
      { src: 'block:churn', dst: 'entity:customer', kind: 'reads_from' }, // the lone inbound (cross-domain) edge
      ...Array.from({ length: 5 }, (_, i) => ({ src: 'entity:customer', dst: `block:out${i}`, kind: 'reads_from' as const })),
    ];
    kg.rebuild(hubNodes, edges);
    // With a tight limit, the 5 outbound edges must NOT starve the single inbound bridge.
    const ids = kg.neighbors('entity:customer', { limit: 4 }).map((n) => n.node.nodeId);
    expect(ids).toContain('block:churn');
    kg.close();
  });
});
