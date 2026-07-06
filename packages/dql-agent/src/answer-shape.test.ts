import { describe, expect, it } from 'vitest';
import { validateAnswerResultShape } from './answer-shape.js';
import { buildAnalysisQuestionPlan } from './metadata/analysis-planner.js';

describe('validateAnswerResultShape', () => {
  it('accepts total_* columns as scalar count answers', () => {
    const validation = validateAnswerResultShape(
      buildAnalysisQuestionPlan('How many customers do we have?'),
      {
        columns: ['total_customers'],
        rows: [{ total_customers: 100 }],
        rowCount: 1,
      },
    );

    expect(validation.warnings).toEqual([]);
    expect(validation.missingOutputs).toEqual([]);
  });

  it('warns when requested name columns are missing', () => {
    const validation = validateAnswerResultShape(
      buildAnalysisQuestionPlan('Who are the top 2 customers with customer name and revenue?'),
      {
        columns: ['customer_id', 'revenue'],
        rows: [
          { customer_id: 'c1', revenue: 20 },
          { customer_id: 'c2', revenue: 10 },
        ],
        rowCount: 2,
      },
    );

    expect(validation.missingOutputs).toEqual(expect.arrayContaining(['customer_name']));
    expect(validation.warnings[0]).toContain('customer_name');
  });

  it('accepts an abbreviated name-column alias (prod_name) as covering product_name', () => {
    const validation = validateAnswerResultShape(
      buildAnalysisQuestionPlan('list the top products with product name and revenue'),
      {
        columns: ['prod_name', 'revenue'],
        rows: [{ prod_name: 'Widget', revenue: 100 }],
        rowCount: 1,
      },
    );
    // prod_name (abbrev stem of product) covers product_name — no false "missing".
    expect(validation.missingOutputs).not.toContain('product_name');
  });

  it('accepts a bare name column as covering any *_name requirement', () => {
    const validation = validateAnswerResultShape(
      buildAnalysisQuestionPlan('list vendors with vendor name and total spend'),
      { columns: ['name', 'total_spend'], rows: [{ name: 'Acme', total_spend: 5 }], rowCount: 1 },
    );
    expect(validation.missingOutputs).not.toContain('vendor_name');
  });

  it('warns when a global top-N answer returns too many rows', () => {
    const validation = validateAnswerResultShape(
      buildAnalysisQuestionPlan('Show the top 2 customers by revenue'),
      {
        columns: ['customer_name', 'revenue'],
        rows: [
          { customer_name: 'A', revenue: 30 },
          { customer_name: 'B', revenue: 20 },
          { customer_name: 'C', revenue: 10 },
        ],
        rowCount: 3,
      },
    );

    expect(validation.topN).toBe(2);
    expect(validation.topNReturned).toBe(3);
    expect(validation.warnings).toEqual(expect.arrayContaining([
      'The user asked for top 2, but the answer returned 3 rows.',
    ]));
  });
});
