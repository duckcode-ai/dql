import { describe, expect, it } from 'vitest';
import { Parser } from '../parser/parser.js';
import { applyTableProfile, proposeTableDataset, renderTableDatasetBlock, tableColumnKind } from './table-draft.js';

const columns = [
  { name: 'order_line_id', type: 'VARCHAR' },
  { name: 'customer_id', type: 'VARCHAR' },
  { name: 'region', type: 'VARCHAR' },
  { name: 'order_date', type: 'TIMESTAMP' },
  { name: 'net_amount', type: 'DECIMAL(12,2)' },
  { name: 'discount_rate', type: 'DOUBLE' },
  { name: 'quantity', type: 'INTEGER' },
  { name: 'fiscal_year', type: 'INTEGER' },
  { name: 'Weird Name', type: 'VARCHAR' },
];

describe('start from a table', () => {
  it('reads types into kinds', () => {
    expect(['BIGINT', 'DECIMAL(10,2)', 'TIMESTAMP WITH TIME ZONE', 'DATE', 'BOOLEAN', 'VARCHAR'].map(tableColumnKind)).toEqual(['number', 'number', 'timestamp', 'date', 'boolean', 'string']);
  });

  it('proposes dates as time, text and ids as categories, numbers as totals, ids as distinct counts', () => {
    const proposal = proposeTableDataset({ table: 'order_lines', relation: 'main.order_lines', columns });
    expect(proposal.fields.map((field) => `${field.name}:${field.role}`)).toEqual([
      'order_line_id:dimension', 'customer_id:dimension', 'region:dimension', 'order_date:time', 'net_amount:attribute', 'discount_rate:attribute', 'quantity:attribute', 'fiscal_year:dimension',
    ]);
    expect(proposal.skipped).toEqual(['Weird Name']);
    expect(proposal.keyCandidates).toEqual(['order_line_id', 'customer_id']);
    expect(proposal.measures.map((measure) => [measure.name, measure.aggregation, measure.format, measure.include])).toEqual([
      ['net_amount', 'sum', 'currency', true],
      ['discount_rate', 'sum', 'number', false],
      ['quantity', 'sum', 'number', true],
      // The table's own id becomes the row count once the profile shows it is unique.
      ['customer_count', 'count_distinct', 'number', true],
    ]);
  });

  it('takes the first column with a value on every row and no repeats as the row identity', () => {
    const proposal = proposeTableDataset({ table: 'order_lines', relation: 'main.order_lines', columns });
    const profiled = applyTableProfile(proposal, { rows: 100, columns: { order_line_id: { distinct: 100, nonNull: 100 }, customer_id: { distinct: 12, nonNull: 100 } } }, 'order_lines');
    expect(profiled.key).toEqual({ column: 'order_line_id', entity: 'order_line' });
    expect(profiled.fields.find((field) => field.name === 'order_line_id')?.role).toBe('key');
    expect(profiled.measures[0]).toMatchObject({ name: 'order_line_count', from: 'order_line_id' });
    const noKey = applyTableProfile(proposal, { rows: 100, columns: { order_line_id: { distinct: 99, nonNull: 100 } } }, 'order_lines');
    expect(noKey.key).toBeUndefined();
  });

  it('renders a Dataset block that parses, with only the numbers kept', () => {
    const proposal = applyTableProfile(proposeTableDataset({ table: 'order_lines', relation: 'main.order_lines', columns: columns.slice(0, 8) }), { rows: 5, columns: { order_line_id: { distinct: 5, nonNull: 5 } } }, 'order_lines');
    const source = renderTableDatasetBlock({ proposal, blockName: 'Order lines', domain: 'sales', owner: 'ana@example.com', columnSql: (name) => `"${name}"` });
    const block = new Parser(source, 'order-lines.dql').parse().statements[0] as { datasetGrain?: { keys: string[]; keyEvidence?: string }; datasetMeasures?: Array<{ name: string }>; datasetFields?: Array<{ name: string }> };
    expect(block.datasetGrain).toMatchObject({ keys: ['order_line_id'], keyEvidence: 'proof.order-lines' });
    expect(block.datasetMeasures?.map((measure) => measure.name)).toEqual(['order_line_count', 'net_amount', 'quantity', 'customer_count']);
    expect(block.datasetFields).toHaveLength(8);
    expect(() => renderTableDatasetBlock({ proposal: { ...proposal, key: undefined }, blockName: 'x', domain: 'd', owner: 'o', columnSql: (name) => name })).toThrow('TABLE_DATASET_KEY_REQUIRED');
  });
});
