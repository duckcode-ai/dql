import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KGStore } from './kg/sqlite-fts.js';
import { answer, parseProposal } from './answer-loop.js';
import type { AgentProvider, AgentMessage } from './providers/types.js';

class StubProvider implements AgentProvider {
  readonly name = 'claude' as const;
  messages: AgentMessage[] = [];
  constructor(private readonly response: string) {}
  async available(): Promise<boolean> { return true; }
  async generate(messages: AgentMessage[]): Promise<string> {
    this.messages = messages;
    return this.response;
  }
}

let dir: string;
let kg: KGStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-answer-'));
  kg = new KGStore(join(dir, 'kg.sqlite'));
  kg.rebuild([
    {
      nodeId: 'block:revenue_total',
      kind: 'block',
      name: 'revenue_total',
      domain: 'growth',
      status: 'certified',
      description: 'Top-level revenue across customer segments',
      llmContext: 'Use this for revenue trends. Tracks ARR over time.',
      tags: ['revenue'],
      gitSha: 'abc12345',
      sourceTier: 'certified_artifact',
      certification: 'certified',
      provenance: 'DQL block',
      businessOutcome: 'Revenue leadership can monitor quarterly growth.',
      businessOwner: 'revenue-ops',
      decisionUse: 'Quarterly planning and forecast review',
      reviewCadence: 'weekly',
      businessRules: ['Revenue excludes test accounts.'],
      caveats: ['Late-arriving invoices may restate current quarter revenue.'],
    },
    {
      nodeId: 'block:churn_logo',
      kind: 'block',
      name: 'churn_logo',
      domain: 'retention',
      status: 'draft',
      description: 'Logo churn',
    },
    {
      nodeId: 'metric:arr',
      kind: 'metric',
      name: 'arr',
      domain: 'growth',
      description: 'Annualized recurring revenue',
    },
  ], []);
});

afterEach(() => {
  kg.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('answer (block-first loop)', () => {
  it('returns Certified when a certified block matches', async () => {
    const provider = new StubProvider('should not be called');
    const result = await answer({
      question: 'What was revenue this quarter?',
      provider,
      kg,
    });
    expect(result.kind).toBe('certified');
    expect(result.block?.nodeId).toBe('block:revenue_total');
    expect(result.citations[0].gitSha).toBe('abc12345');
    expect(result.evidence?.route[0].tool).toBe('search_certified_artifacts');
    expect(result.evidence?.selectedAssets[0].nodeId).toBe('block:revenue_total');
    expect(result.evidence?.outcome?.name).toContain('Revenue leadership');
  });

  it('executes a certified block when the host supplies an executor', async () => {
    const provider = new StubProvider('should not be called');
    const result = await answer({
      question: 'What was revenue this quarter?',
      provider,
      kg,
      executeCertifiedBlock: async () => ({
        columns: ['revenue'],
        rows: [{ revenue: 42 }],
        rowCount: 1,
        executionTime: 12,
      }),
    });
    expect(result.kind).toBe('certified');
    expect(result.result?.rowCount).toBe(1);
    expect(result.text).toContain('Returned 1 row.');
    expect(result.evidence?.execution?.status).toBe('executed');
    expect(result.evidence?.execution?.rowCount).toBe(1);
    expect(result.evidence?.validation?.status).toBe('passed');
  });

  it('returns Uncertified when no certified block matches and SQL is proposed', async () => {
    const llmReply =
      'Median order value by region — joins fct_orders with dim_customers.\n\n' +
      '```sql\nSELECT region, MEDIAN(amount) FROM fct_orders GROUP BY region\n```\n\n' +
      'Viz: bar';
    const provider = new StubProvider(llmReply);
    const result = await answer({
      question: 'What is the median order value by region?',
      provider,
      kg,
    });
    expect(result.kind).toBe('uncertified');
    expect(result.proposedSql).toMatch(/SELECT region, MEDIAN/);
    expect(result.suggestedViz).toBe('bar');
    expect(result.evidence?.validation?.status).toBe('warning');
    expect(result.evidence?.route.map((step) => step.tool)).toContain('validate_sql');
    // Citations are best-effort — empty is acceptable when nothing in the KG matches.
    expect(Array.isArray(result.citations)).toBe(true);
  });

  it('returns no_answer when the model declines without SQL', async () => {
    const provider = new StubProvider('I cannot answer this without more schema context.');
    const result = await answer({
      question: 'Tell me a joke',
      provider,
      kg,
    });
    expect(result.kind).toBe('no_answer');
    expect(result.evidence?.validation?.status).toBe('failed');
  });

  it('passes extra context to the model without using it for certified routing', async () => {
    const provider = new StubProvider('Explanation draft.\n```sql\nSELECT 1\n```\nViz: table');
    const result = await answer({
      question: 'Explain this current query',
      extraContext: 'Current upstream SQL:\nSELECT SUM(amount) AS revenue FROM orders',
      provider,
      kg,
    });
    expect(result.kind).toBe('uncertified');
    expect(result.block).toBeUndefined();
    expect(provider.messages.some((m) => m.content.includes('Current upstream SQL'))).toBe(true);
  });

  it('skips a certified block if downvotes dominate', async () => {
    for (const i of [1, 2, 3]) {
      kg.recordFeedback({
        id: `dn${i}`, ts: new Date().toISOString(), user: `u${i}`, question: 'q',
        answerKind: 'certified', blockId: 'block:revenue_total', rating: 'down',
      });
    }
    const llmReply = 'fallback text\n```sql\nSELECT 1\n```\nViz: table';
    const provider = new StubProvider(llmReply);
    const result = await answer({
      question: 'Revenue trend',
      provider,
      kg,
    });
    expect(result.kind).toBe('uncertified');
  });
});

describe('parseProposal', () => {
  it('extracts SQL block + viz line + summary text', () => {
    const raw = 'Revenue summary.\n\n```sql\nSELECT 1\n```\n\nViz: line';
    expect(parseProposal(raw)).toEqual({
      text: 'Revenue summary.',
      sql: 'SELECT 1',
      viz: 'line',
    });
  });

  it('handles missing viz line', () => {
    const raw = 'No viz hint.\n\n```sql\nSELECT 2\n```';
    expect(parseProposal(raw)).toEqual({
      text: 'No viz hint.',
      sql: 'SELECT 2',
      viz: undefined,
    });
  });

  it('returns sql=undefined when there is no fenced SQL block', () => {
    const raw = 'I refuse';
    const parsed = parseProposal(raw);
    expect(parsed.sql).toBeUndefined();
    expect(parsed.text).toBe('I refuse');
  });
});
