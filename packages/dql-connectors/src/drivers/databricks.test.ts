import { describe, expect, it } from 'vitest';
import { normalizeDatabricksHost, resolveDatabricksWarehouseId } from './databricks.js';

describe('Databricks connection helpers', () => {
  it('normalizes workspace hosts to the URL origin', () => {
    expect(normalizeDatabricksHost('adb-123.4.azuredatabricks.net/')).toBe('https://adb-123.4.azuredatabricks.net');
    expect(normalizeDatabricksHost('https://adb-123.4.azuredatabricks.net/sql/warehouses/abc')).toBe('https://adb-123.4.azuredatabricks.net');
  });

  it('extracts the warehouse ID from dbt and JDBC HTTP paths', () => {
    expect(resolveDatabricksWarehouseId('/sql/1.0/warehouses/9196548d010cf14d')).toBe('9196548d010cf14d');
    expect(resolveDatabricksWarehouseId('https://adb.example.com/sql/1.0/warehouses/abc123?o=1234')).toBe('abc123');
  });

  it('keeps raw warehouse identifiers unchanged', () => {
    expect(resolveDatabricksWarehouseId('warehouse-prod-123')).toBe('warehouse-prod-123');
  });
});
