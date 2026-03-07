import { describe, expect, it } from 'vitest';
import { buildParamValues } from './sql-params.js';

describe('buildParamValues', () => {
  it('builds positional values from variables', () => {
    const params = [
      { name: 'region', position: 2 },
      { name: 'org', position: 1 },
    ];
    const values = buildParamValues(params, { org: 'acme', region: 'us' });
    expect(values).toEqual(['acme', 'us']);
  });

  it('falls back to literalValue when variable is missing', () => {
    const params = [
      { name: '__rls_literal_1', position: 1, literalValue: 'EMEA' },
    ];
    const values = buildParamValues(params, {});
    expect(values).toEqual(['EMEA']);
  });
});
