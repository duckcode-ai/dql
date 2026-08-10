import { describe, expect, it } from 'vitest';
import { addSqlResultFilter, dashboardFilterableResultColumns, filterableResultColumns, replaceBlockStudioSql } from './sql-result-filter.js';
import { parameterizeSqlForDqlImport, candidateToDqlSource } from './block-studio-import.js';
import { prepareBlockInvocation } from './block-invocation.js';

const GROUPED = "SELECT region, channel, SUM(amount) AS revenue FROM main.orders WHERE region = 'EMEA' GROUP BY region, channel LIMIT 10";
const GROUPED_COLUMNS = ['region', 'channel', 'revenue'];

describe('filterableResultColumns', () => {
  it('offers plain source columns from the result', () => {
    const columns = filterableResultColumns(GROUPED, GROUPED_COLUMNS);
    expect(columns.map((c) => c.column)).toEqual(['region', 'channel']);
  });

  // Filtering an aggregate output needs HAVING, whose post-aggregation meaning
  // is not what picking a column off a table implies. It is never offered.
  it('never offers an aggregate output column', () => {
    const columns = filterableResultColumns(GROUPED, GROUPED_COLUMNS);
    expect(columns.map((c) => c.column)).not.toContain('revenue');
  });

  it('never offers a column that only feeds an aggregate', () => {
    const columns = filterableResultColumns(GROUPED, [...GROUPED_COLUMNS, 'amount']);
    expect(columns.map((c) => c.column)).not.toContain('amount');
  });

  it('qualifies with the alias when more than one relation is joined', () => {
    const sql = 'SELECT o.region, c.name FROM main.orders o JOIN main.customers c ON c.id = o.customer_id';
    const columns = filterableResultColumns(sql, ['region', 'name']);
    expect(columns.find((c) => c.column === 'region')?.predicateTarget).toBe('o.region');
    expect(columns.find((c) => c.column === 'name')?.predicateTarget).toBe('c.name');
  });

  it('refuses a column that is ambiguous across joined relations', () => {
    const sql = 'SELECT o.id, c.id FROM main.orders o JOIN main.customers c ON c.id = o.customer_id';
    expect(filterableResultColumns(sql, ['id'])).toEqual([]);
  });

  it('refuses anything it cannot read or prove is a single SELECT', () => {
    expect(filterableResultColumns('SELECT region FROM x QUALIFY ~~~ broken', ['region'])).toEqual([]);
    expect(filterableResultColumns('WITH t AS (SELECT region FROM x) SELECT region FROM t', ['region'])).toEqual([]);
    expect(filterableResultColumns('', ['region'])).toEqual([]);
    expect(filterableResultColumns(GROUPED, [])).toEqual([]);
  });
});

describe('dashboardFilterableResultColumns (UI-022)', () => {
  it('adds a certified computed dimension that exists in the settled result', () => {
    const sql = "SELECT date_trunc('month', ordered_at) AS month, SUM(order_total) AS gross_revenue FROM dev.orders GROUP BY 1";
    expect(dashboardFilterableResultColumns(sql, ['month', 'gross_revenue'], ['month']))
      .toEqual([{ column: 'month', predicateTarget: 'month' }]);
  });

  it('does not expose undeclared measures or declared fields absent from the result', () => {
    const sql = "SELECT date_trunc('month', ordered_at) AS month, SUM(order_total) AS gross_revenue FROM dev.orders GROUP BY 1";
    expect(dashboardFilterableResultColumns(sql, ['month', 'gross_revenue'], ['customer_segment']))
      .toEqual([]);
  });
});

describe('addSqlResultFilter', () => {
  it('extends an existing WHERE and keeps trailing clauses in place', () => {
    const added = addSqlResultFilter(GROUPED, GROUPED_COLUMNS, 'channel', ['top_n', 'region']);
    expect(added.parameterName).toBe('channel');
    expect(added.sql).toBe(
      "SELECT region, channel, SUM(amount) AS revenue FROM main.orders WHERE region = 'EMEA' AND channel = ${channel} GROUP BY region, channel LIMIT 10",
    );
  });

  it('adds a WHERE clause when the statement has none', () => {
    const sql = 'SELECT region, channel FROM main.orders ORDER BY region';
    const added = addSqlResultFilter(sql, ['region', 'channel'], 'region');
    expect(added.sql).toBe('SELECT region, channel FROM main.orders WHERE region = ${region} ORDER BY region');
  });

  it('appends at the end when there are no trailing clauses', () => {
    const sql = 'SELECT region FROM main.orders';
    expect(addSqlResultFilter(sql, ['region'], 'region').sql)
      .toBe('SELECT region FROM main.orders WHERE region = ${region}');
  });

  // A GROUP BY inside a subquery must never be mistaken for the outer one.
  it('ignores clause keywords nested inside a subquery', () => {
    const sql = 'SELECT region FROM (SELECT region FROM main.orders GROUP BY region) t ORDER BY region';
    const added = addSqlResultFilter(sql, ['region'], 'region');
    expect(added.sql).toBe(
      'SELECT region FROM (SELECT region FROM main.orders GROUP BY region) t WHERE region = ${region} ORDER BY region',
    );
  });

  // A clause keyword inside a string literal is data, not structure.
  it('ignores clause keywords inside string literals', () => {
    const sql = "SELECT region FROM main.orders WHERE note = 'group by limit'";
    const added = addSqlResultFilter(sql, ['region'], 'region');
    expect(added.sql).toBe("SELECT region FROM main.orders WHERE note = 'group by limit' AND region = ${region}");
  });

  it('does not collide with an existing parameter name', () => {
    const added = addSqlResultFilter(GROUPED, GROUPED_COLUMNS, 'region', ['top_n', 'region']);
    expect(added.parameterName).toBe('region_2');
    expect(added.sql).toContain('${region_2}');
  });

  // A generated block's SQL carries `${param}` placeholders. They must survive
  // both the analysis and the edit — including `LIMIT ${top_n}`, where a quoted
  // filler would not even parse.
  it('works on a parameterized block source and preserves its placeholders', () => {
    const parameterized = 'SELECT region, channel, SUM(amount) AS revenue FROM main.orders'
      + ' WHERE region = ${region} GROUP BY region, channel LIMIT ${top_n}';
    const columns = ['region', 'channel', 'revenue'];
    expect(filterableResultColumns(parameterized, columns).map((c) => c.column)).toEqual(['region', 'channel']);

    const added = addSqlResultFilter(parameterized, columns, 'channel', ['region', 'top_n']);
    expect(added.sql).toBe(
      'SELECT region, channel, SUM(amount) AS revenue FROM main.orders'
      + ' WHERE region = ${region} AND channel = ${channel} GROUP BY region, channel LIMIT ${top_n}',
    );
  });

  it('refuses a column it would not have offered', () => {
    expect(() => addSqlResultFilter(GROUPED, GROUPED_COLUMNS, 'revenue')).toThrow('cannot be turned into a filter input');
  });
});

// The whole point of the feature: the promoted column must come back as a
// real, resolved, runtime-editable parameter on the rebuilt block.
describe('add-filter round trip', () => {
  it('promotes a result column into a working parameter', () => {
    const sql = "SELECT region, channel, SUM(amount) AS revenue FROM main.orders WHERE region = 'EMEA' GROUP BY region, channel LIMIT 10";
    const p = parameterizeSqlForDqlImport(sql);
    const source = candidateToDqlSource({
      name: 'g', domain: 'd', description: 'q', owner: '', tags: [], terms: [], pattern: '', grain: '',
      entities: [], outputs: [], dimensions: [], allowedFilters: p.allowedFilters,
      parameterPolicy: p.parameterPolicy, filterBindings: p.filterBindings,
      parameterDecisions: p.parameterDecisions, sourceSystems: [], replacementFor: [],
      reviewCadence: 'monthly', sql: p.sql, llmContext: '',
    });
    const before = prepareBlockInvocation({ source, surface: 'ask_ai' });
    expect(before.parameters.map((x) => x.name).sort()).toEqual(['region', 'top_n']);

    const cols = ['region', 'channel', 'revenue'];
    expect(filterableResultColumns(p.sql, cols).map((c) => c.column)).toEqual(['region', 'channel']);

    const added = addSqlResultFilter(p.sql, cols, 'channel', before.parameters.map((x) => x.name));
    const next = replaceBlockStudioSql(source, added.sql, added.parameterName, 'retail');
    const after = prepareBlockInvocation({ source: next, surface: 'ask_ai' });

    expect(after.errors).toEqual([]);
    expect(after.unresolvedParameters).toEqual([]);
    expect(after.parameters.map((x) => x.name).sort()).toEqual(['channel', 'region', 'top_n']);
    expect(after.parameters.find((x) => x.name === 'channel')?.policy).toBe('dynamic');
    expect(after.values.channel).toBe('retail');
    expect(next).toContain('AND channel = ${channel}');
  });
});
