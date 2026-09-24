import { describe, expect, it } from 'vitest';
import { readDriverDefinition } from './dashboard-document.js';

const base = { version: 1, measure: 'revenue', timeField: 'order_date', grain: 'month', anchor: '2026-02-01', comparison: 'previous_period', dimensions: ['*'] };

describe('driver definitions narrowed to what the reader sees (RFC 0009 step 6a)', () => {
  it('keeps scalar equality filters on named fields', () => {
    const errors: string[] = [];
    const definition = readDriverDefinition({ ...base, filters: [{ field: 'region', op: 'eq', values: ['US'] }, { field: 'channel', op: 'not_in', values: ['Web', 'Store'] }] }, 'driver', (message) => errors.push(message));
    expect(errors).toEqual([]);
    expect(definition?.filters).toEqual([{ field: 'region', op: 'eq', values: ['US'] }, { field: 'channel', op: 'not_in', values: ['Web', 'Store'] }]);
    expect(readDriverDefinition(base, 'driver', () => undefined)?.filters).toBeUndefined();
  });

  it('refuses ranges, empty values and too many filters', () => {
    const errors: string[] = [];
    expect(readDriverDefinition({ ...base, filters: [{ field: 'order_date', op: 'gte', values: ['2026-01-01'] }] }, 'driver', (message) => errors.push(message))).toBeUndefined();
    expect(readDriverDefinition({ ...base, filters: [{ field: 'region', op: 'eq', values: [] }] }, 'driver', (message) => errors.push(message))).toBeUndefined();
    expect(readDriverDefinition({ ...base, filters: Array.from({ length: 13 }, () => ({ field: 'region', op: 'eq', values: ['US'] })) }, 'driver', (message) => errors.push(message))).toBeUndefined();
    expect(errors).toHaveLength(3);
  });
});
