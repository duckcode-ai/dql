import { describe, expect, it } from 'vitest';
import { buildParamValues, expandArrayParameters, normalizeSQLPlaceholders } from './sql-params.js';

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

  it('binds missing optional variables as null', () => {
    const params = [
      { name: 'user.region', position: 1 },
      { name: 'user.branch', position: 2 },
    ];
    const values = buildParamValues(params, {});
    expect(values).toEqual([null, null]);
  });
});

describe('expandArrayParameters', () => {
  it('expands array-valued business parameters into positional binds', () => {
    const expanded = expandArrayParameters(
      'SELECT * FROM games WHERE team_name IN ($1) AND season = $2',
      [
        { name: 'team_set', position: 1 },
        { name: 'season', position: 2 },
      ],
      { team_set: ['LAL', 'BOS'], season: 2017 },
    );

    expect(expanded.sql).toBe('SELECT * FROM games WHERE team_name IN ($1, $2) AND season = $3');
    expect(buildParamValues(expanded.params, expanded.variables)).toEqual(['LAL', 'BOS', 2017]);
    expect(normalizeSQLPlaceholders(expanded.sql, 'snowflake')).toBe('SELECT * FROM games WHERE team_name IN (?, ?) AND season = ?');
  });

  it('does not rewrite placeholder-like text inside string literals', () => {
    const expanded = expandArrayParameters(
      "SELECT '$1' AS literal, team_name FROM games WHERE team_name IN ($1)",
      [{ name: 'team_set', position: 1 }],
      { team_set: ['LAL', 'BOS'] },
    );

    expect(expanded.sql).toBe("SELECT '$1' AS literal, team_name FROM games WHERE team_name IN ($1, $2)");
    expect(buildParamValues(expanded.params, expanded.variables)).toEqual(['LAL', 'BOS']);
  });
});
