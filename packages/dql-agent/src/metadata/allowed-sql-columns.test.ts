import { describe, expect, it } from 'vitest';
import { buildAllowedSqlContext } from './catalog.js';
import type { MetadataObject } from './catalog.js';

/**
 * W1.4 — a relation whose column list is truncated to the prompt budget must be
 * marked `partial`, otherwise column validation would false-positive a valid
 * column past the cut as unknown_column.
 */
function runtimeTable(relation: string, columnCount: number, extraColumns: string[] = []): MetadataObject {
  return {
    objectKey: `runtime:table:${relation}`,
    objectType: 'runtime_table',
    name: relation.split('.').at(-1) ?? relation,
    fullName: relation,
    description: undefined,
    status: 'runtime_observed',
    sourceSystem: 'runtime schema snapshot',
    payload: {
      relation,
      columnCompleteness: 'complete',
      columns: [
        ...Array.from({ length: columnCount }, (_, i) => ({ name: `col_${i}` })),
        ...extraColumns.map((name) => ({ name })),
      ],
    },
  } as MetadataObject;
}

describe('buildAllowedSqlContext column budget (W1.4)', () => {
  it('keeps a relation complete when its columns fit the budget', () => {
    const ctx = buildAllowedSqlContext([runtimeTable('analytics.wide', 120)], []);
    const relation = ctx.relations.find((r) => r.relation === 'analytics.wide');
    expect(relation?.columns.length).toBe(120);
    expect(relation?.columnCompleteness).toBe('complete');
  });

  it('downgrades a relation to partial when its columns are truncated', () => {
    const ctx = buildAllowedSqlContext([runtimeTable('analytics.verywide', 200)], []);
    const relation = ctx.relations.find((r) => r.relation === 'analytics.verywide');
    // Truncated to the budget...
    expect(relation?.columns.length).toBe(120);
    // ...and marked partial so validation won't reject a real column past the cut.
    expect(relation?.columnCompleteness).toBe('partial');
  });
});

describe('buildAllowedSqlContext question-relevant column selection (W3.3)', () => {
  it('keeps a question-relevant column that sits PAST the budget cut', () => {
    // 200 filler columns then `churn_rate` at position 200 — far past the 120 cut.
    // Without relevance ranking it would be dropped; with it, a question mentioning
    // churn keeps it.
    const table = runtimeTable('analytics.metrics', 200, ['churn_rate']);
    const ctx = buildAllowedSqlContext([table], [], ['churn', 'rate']);
    const relation = ctx.relations.find((r) => r.relation === 'analytics.metrics');
    expect(relation?.columns.length).toBe(120);
    expect(relation?.columns.some((c) => c.name === 'churn_rate')).toBe(true);
  });

  it('keeps structural key columns even when the question does not mention them', () => {
    const table = runtimeTable('analytics.events', 200, ['customer_id']);
    const ctx = buildAllowedSqlContext([table], [], ['revenue']);
    const relation = ctx.relations.find((r) => r.relation === 'analytics.events');
    // customer_id survives truncation as a join key regardless of the question.
    expect(relation?.columns.some((c) => c.name === 'customer_id')).toBe(true);
  });

  it('preserves original column order among the survivors', () => {
    const table = runtimeTable('analytics.wide2', 200);
    const ctx = buildAllowedSqlContext([table], [], []);
    const relation = ctx.relations.find((r) => r.relation === 'analytics.wide2');
    const names = relation!.columns.map((c) => c.name);
    // No question tokens → all scores equal → first 120 in original order.
    expect(names.slice(0, 3)).toEqual(['col_0', 'col_1', 'col_2']);
  });
});

describe('buildAllowedSqlContext selected semantic bindings (AGT-011)', () => {
  it('allows the governed backing table declared by a selected semantic metric', () => {
    const metric: MetadataObject = {
      objectKey: 'semantic:metric:dbt_core_models.total_ccu_count',
      objectType: 'semantic_metric',
      name: 'dbt_core_models.total_ccu_count',
      fullName: 'dbt_core_models.total_ccu_count',
      status: 'certified',
      sourceSystem: 'dbt semantic metric',
      payload: {
        table: 'analytics.sm_ccu_consumption_by_usage_source_daily_f',
        formula: 'total_ccu_count',
      },
    };

    const ctx = buildAllowedSqlContext([metric], []);

    expect(ctx.relations).toContainEqual(expect.objectContaining({
      relation: 'analytics.sm_ccu_consumption_by_usage_source_daily_f',
      objectKey: metric.objectKey,
      source: 'semantic layer backing relation',
      columnCompleteness: 'partial',
    }));
  });

  it('merges dbt columns into the semantic backing relation when both are inspected', () => {
    const metric: MetadataObject = {
      objectKey: 'semantic:metric:orders.total_revenue',
      objectType: 'semantic_metric',
      name: 'orders.total_revenue',
      payload: { table: 'analytics.fct_orders' },
    };
    const model: MetadataObject = {
      objectKey: 'dbt:model:fct_orders',
      objectType: 'dbt_model',
      name: 'fct_orders',
      fullName: 'analytics.fct_orders',
      sourceSystem: 'dbt manifest',
      payload: {
        relation: 'analytics.fct_orders',
        columnCompleteness: 'complete',
        columns: [{ name: 'customer_id' }, { name: 'total_revenue', type: 'decimal' }],
      },
    };

    const relation = buildAllowedSqlContext([metric, model], []).relations[0];

    expect(relation).toMatchObject({
      relation: 'analytics.fct_orders',
      columnCompleteness: 'complete',
    });
    expect(relation?.columns.map((column) => column.name)).toEqual(['customer_id', 'total_revenue']);
  });
});
