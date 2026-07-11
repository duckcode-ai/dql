import { describe, expect, it } from 'vitest';
import { buildCombinedDatasetCell, estimateJoinCardinality, findDatasetReferences, findWarehouseReferences, suggestJoinPairs } from './dataset-references';

describe('notebook dataset combination helpers', () => {
  it('captures every referenced local dataset without substring matches', () => {
    const references = findDatasetReferences(
      'select * from "orders_snapshot" join customers on true',
      [
        { name: 'orders_snapshot', path: '', columns: [], objectType: 'staged_dataset', datasetId: 'staged_1', fileFingerprint: 'one' },
        { name: 'customers', path: '', columns: [], objectType: 'dataset', datasetId: 'csv_1', fileFingerprint: 'two' },
        { name: 'customer', path: '', columns: [], objectType: 'dataset', datasetId: 'csv_2' },
      ],
    );
    expect(references.map((reference) => reference.id)).toEqual(['staged_1', 'csv_1']);
    expect(references.map((reference) => reference.role)).toEqual(['staged', 'source']);
  });

  it('identifies warehouse relations separately from local datasets', () => {
    const tables = [
      { name: 'dev.orders', path: 'dev.orders', columns: [], source: 'database' as const },
      { name: 'customers_csv', path: 'customers.csv', columns: [], source: 'file' as const, objectType: 'dataset', datasetId: 'csv' },
    ];
    const sql = 'select * from dev.orders join customers_csv on true';
    expect(findWarehouseReferences(sql, tables)).toEqual(['dev.orders']);
    expect(findDatasetReferences(sql, tables).map((reference) => reference.id)).toEqual(['csv']);
  });

  it('ranks exact and related identifier keys', () => {
    const suggestions = suggestJoinPairs(
      ['customer_id', 'order_date'],
      [{ name: 'customer_id', flags: ['identifier'] }, { name: 'id', flags: ['identifier'] }],
    );
    expect(suggestions[0]).toMatchObject({ warehouseKey: 'customer_id', localKey: 'customer_id', score: 100 });
    expect(suggestions.some((item) => item.warehouseKey === 'customer_id' && item.localKey === 'id')).toBe(true);
    expect(suggestJoinPairs(['month', 'revenue'], [{ name: 'id' }, { name: 'name' }])).toEqual([]);
  });

  it('warns when both preview sides repeat the selected key', () => {
    expect(estimateJoinCardinality({
      warehouseRows: [{ id: 1 }, { id: 1 }, { id: 2 }],
      warehouseKey: 'id',
      localDistinctCount: 2,
      localSampledRows: 3,
    })).toBe('many_to_many');
  });

  it('builds a review-required local join cell with both lineage references', () => {
    const cell = buildCombinedDatasetCell({
      staged: { id: 'stage', alias: 'orders_snapshot', fileFingerprint: 'a', refreshedAt: '2026-07-10T00:00:00Z', columns: ['customer_id', 'revenue'] },
      local: { id: 'csv', alias: 'customers', fileFingerprint: 'b', refreshedAt: '2026-07-09T00:00:00Z', columns: ['id', 'name'] },
      warehouseKey: 'customer_id',
      localKey: 'id',
      joinType: 'left',
      sourceCell: { id: 'warehouse-cell', type: 'sql', content: 'select * from orders', status: 'success' },
    });
    expect(cell.executionTarget).toEqual({ target: 'local' });
    expect(cell.datasetRefs).toHaveLength(2);
    expect(cell.dependencies).toEqual([{ cellId: 'warehouse-cell' }]);
    expect(cell.content).toContain('warehouse."customer_id" = local_data."id"');
    expect(cell.content).toContain('local_data."name" AS "name"');
  });
});
