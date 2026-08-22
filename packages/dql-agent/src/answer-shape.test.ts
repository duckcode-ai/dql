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

  it('accepts a governed revenue output for a plain-English spend request', () => {
    const validation = validateAnswerResultShape(
      buildAnalysisQuestionPlan('Who are the top customers who spent on beverage category products?'),
      {
        columns: ['customer_name', 'beverage_revenue', 'beverage_orders', 'beverage_product_types'],
        rows: [{ customer_name: 'Melissa Lopez', beverage_revenue: 1317, beverage_orders: 231, beverage_product_types: 5 }],
        rowCount: 1,
      },
    );

    expect(validation.missingOutputs).not.toContain('spend');
    expect(validation.warnings).toEqual([]);
  });

  it('accepts singularized sales for revenue without conflating an unrelated BCM measure', () => {
    const sales = validateAnswerResultShape(
      buildAnalysisQuestionPlan('show me sales by category'),
      {
        columns: ['category', 'revenue'],
        rows: [{ category: 'food', revenue: 40 }],
        rowCount: 1,
      },
    );
    const salePlan = buildAnalysisQuestionPlan('show me sales');
    const bcm = validateAnswerResultShape(
      {
        ...salePlan,
        requestedShape: { ...salePlan.requestedShape, requiredOutputs: ['bcm'] },
      },
      {
        columns: ['revenue'],
        rows: [{ revenue: 40 }],
        rowCount: 1,
      },
    );

    expect(sales.warnings).toEqual([]);
    expect(sales.missingOutputs).toEqual([]);
    expect(bcm.missingOutputs).toEqual(expect.arrayContaining(['bcm']));
  });

  it('uses only artifact-local role bindings for frozen entity labels and typed dimension aliases', () => {
    const customerPlan = buildAnalysisQuestionPlan('who are the top customers');
    const customer = validateAnswerResultShape(
      customerPlan,
      {
        columns: ['customer_name', 'lifetime_spend'],
        rows: [{ customer_name: 'Ada', lifetime_spend: 100 }],
        rowCount: 1,
      },
      {
        outputBindings: [{
          requested: 'customer',
          output: 'customer_name',
          role: 'entity_label',
        }],
      },
    );
    const categoryPlan = buildAnalysisQuestionPlan('show me sales by category');
    const category = validateAnswerResultShape(
      categoryPlan,
      {
        columns: ['product_type', 'revenue'],
        rows: [{ product_type: 'Food', revenue: 100 }],
        rowCount: 1,
      },
      {
        outputBindings: [{
          requested: 'category',
          output: 'product_type',
          role: 'dimension',
        }, {
          requested: 'sales',
          output: 'revenue',
          role: 'measure',
        }],
      },
    );
    const noBorrowedMetric = validateAnswerResultShape(
      buildAnalysisQuestionPlan('show me revenue'),
      {
        columns: ['customer_name', 'lifetime_spend'],
        rows: [{ customer_name: 'Ada', lifetime_spend: 100 }],
        rowCount: 1,
      },
      {
        outputBindings: [{
          requested: 'customer',
          output: 'customer_name',
          role: 'entity_label',
        }],
        requireBoundMeasures: true,
      },
    );

    expect(customer.missingOutputs).toEqual([]);
    expect(category.missingOutputs).toEqual([]);
    expect(noBorrowedMetric.missingOutputs).toEqual(expect.arrayContaining(['revenue']));
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

  it('accepts an exact-example member token only through the selected block-owned dimension binding', () => {
    const plan = buildAnalysisQuestionPlan('What is revenue by food and drink?');
    const result = {
      columns: ['category', 'revenue'],
      rows: [{ category: 'Food', revenue: 100 }],
      rowCount: 1,
    };

    const withoutExactExampleBinding = validateAnswerResultShape(plan, result, {
      outputBindings: [{ requested: 'revenue', output: 'revenue', role: 'measure' }],
      requireBoundMeasures: true,
    });
    const withExactExampleBinding = validateAnswerResultShape(plan, result, {
      outputBindings: [{ requested: 'revenue', output: 'revenue', role: 'measure' }, {
        requested: 'category',
        output: 'category',
        role: 'dimension',
        aliases: ['food'],
      }],
      requireBoundMeasures: true,
    });

    expect(withoutExactExampleBinding.missingOutputs).toContain('food');
    expect(withExactExampleBinding.missingOutputs).toEqual([]);
  });
});
