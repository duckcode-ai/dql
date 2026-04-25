import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KGStore } from './sqlite-fts.js';
import type { KGNode } from './types.js';

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
    kg.close();
  });

  it('FTS5 search ranks revenue blocks above churn for "revenue last week"', () => {
    const kg = new KGStore(dbPath);
    kg.rebuild(nodes(), []);
    const hits = kg.search({ query: 'revenue last week' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].node.nodeId).toBe('block:revenue_total');
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

  it('handles wildcard injection without errors', () => {
    const kg = new KGStore(dbPath);
    kg.rebuild(nodes(), []);
    // FTS5 wildcards/operators stripped — should still find revenue.
    const hits = kg.search({ query: 'revenue*' });
    expect(hits.some((h) => h.node.name === 'revenue_total')).toBe(true);
    kg.close();
  });
});
