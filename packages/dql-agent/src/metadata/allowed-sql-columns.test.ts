import { describe, expect, it } from 'vitest';
import { buildAllowedSqlContext } from './catalog.js';
import type { MetadataObject } from './catalog.js';

/**
 * W1.4 — a relation whose column list is truncated to the prompt budget must be
 * marked `partial`, otherwise column validation would false-positive a valid
 * column past the cut as unknown_column.
 */
function runtimeTable(relation: string, columnCount: number): MetadataObject {
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
      columns: Array.from({ length: columnCount }, (_, i) => ({ name: `col_${i}` })),
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
