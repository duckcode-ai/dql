import { describe, expect, it } from 'vitest';
import { describeSchemaObject } from './DataSourceIcon';

describe('database object presentation', () => {
  it('distinguishes local and project CSV datasets from warehouse tables', () => {
    expect(describeSchemaObject({ name: 'customers', path: '.dql/local/datasets/customers.csv', columns: [], source: 'file', objectType: 'dataset', storageMode: 'local' }))
      .toMatchObject({ kind: 'csv', label: 'csv', tone: 'accent' });
    expect(describeSchemaObject({ name: 'targets', path: 'data/targets.csv', columns: [], source: 'file', objectType: 'dataset', storageMode: 'project' }))
      .toMatchObject({ kind: 'csv', label: 'project csv', tone: 'success' });
    expect(describeSchemaObject({ name: 'dev.orders', path: 'dev.orders', columns: [], source: 'database', objectType: 'table' }))
      .toMatchObject({ kind: 'table', label: 'table' });
  });

  it('distinguishes staged snapshots and other file formats', () => {
    expect(describeSchemaObject({ name: 'orders_snapshot', path: '.dql/local/datasets/staged/orders.parquet', columns: [], source: 'file', objectType: 'staged_dataset', storageMode: 'staged' }))
      .toMatchObject({ kind: 'staged', label: 'snapshot', tone: 'warning' });
    expect(describeSchemaObject({ name: 'events', path: 'data/events.jsonl', columns: [], source: 'file' }).kind).toBe('json');
    expect(describeSchemaObject({ name: 'facts', path: 'data/facts.parquet', columns: [], source: 'file' }).kind).toBe('parquet');
  });
});
