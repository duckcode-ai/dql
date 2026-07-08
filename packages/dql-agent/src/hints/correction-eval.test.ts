import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { buildCorrectionEvalCase, emitCorrectionEvalCase, CORRECTIONS_EVAL_RELATIVE_PATH } from './correction-eval.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
function tmpProject(): string { const d = mkdtempSync(join(tmpdir(), 'corr-eval-')); dirs.push(d); return d; }

describe('buildCorrectionEvalCase (W4.3)', () => {
  it('asserts the relations the corrected SQL used', () => {
    const c = buildCorrectionEvalCase({
      question: 'What is revenue by customer?',
      correctedSql: 'SELECT c.customer_name, SUM(o.order_total) FROM fct_orders o JOIN dim_customers c ON o.customer_id = c.customer_id GROUP BY 1',
    });
    expect(c.question).toBe('What is revenue by customer?');
    expect(c.expected.sqlContains).toEqual(expect.arrayContaining(['fct_orders', 'dim_customers']));
  });

  it('produces a question-only case when the SQL has no parseable relations', () => {
    const c = buildCorrectionEvalCase({ question: 'huh', correctedSql: 'not sql {{{' });
    expect(c.expected.sqlContains).toBeUndefined();
  });
});

describe('emitCorrectionEvalCase (W4.3)', () => {
  it('creates the corrections eval file and appends a case', () => {
    const project = tmpProject();
    const path = emitCorrectionEvalCase(project, { question: 'Q1', correctedSql: 'SELECT * FROM orders' });
    expect(path).toBe(join(project, CORRECTIONS_EVAL_RELATIVE_PATH));
    expect(existsSync(path)).toBe(true);
    const doc = yaml.load(readFileSync(path, 'utf8')) as { cases: Array<{ question: string }> };
    expect(doc.cases).toHaveLength(1);
    expect(doc.cases[0].question).toBe('Q1');
  });

  it('dedupes by question — a re-correction replaces the prior case', () => {
    const project = tmpProject();
    emitCorrectionEvalCase(project, { question: 'Q1', correctedSql: 'SELECT * FROM orders' });
    emitCorrectionEvalCase(project, { question: 'Q2', correctedSql: 'SELECT * FROM customers' });
    emitCorrectionEvalCase(project, { question: 'Q1', correctedSql: 'SELECT * FROM fct_orders' });
    const path = join(project, CORRECTIONS_EVAL_RELATIVE_PATH);
    const doc = yaml.load(readFileSync(path, 'utf8')) as { cases: Array<{ question: string; expected: { sqlContains?: string[] } }> };
    expect(doc.cases).toHaveLength(2);
    const q1 = doc.cases.find((c) => c.question === 'Q1')!;
    expect(q1.expected.sqlContains).toContain('fct_orders'); // the re-correction won
  });
});
