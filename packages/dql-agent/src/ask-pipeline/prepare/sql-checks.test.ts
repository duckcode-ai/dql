import { describe, expect, it } from 'vitest';
import { aggregatesRows, appliedConditions, joinKeyPairs, missingRequiredFilters, missingStatedValues, requiredFilterFromText, statedValues, withRowGuard } from './sql-checks.js';

describe('the checks an AI-drafted statement passes before it runs', () => {
  const office = 'Lost opportunities count ,Lost Amount by month for fiscal year FY26 and competitor involved is Splunk';

  it('reads the values a question states: a fiscal year and a name, never its analytic words', () => {
    expect(statedValues(office)).toEqual([{ value: 'FY26', kind: 'fiscal_year' }, { value: 'Splunk', kind: 'text' }]);
    expect(statedValues('What share of orders were placed on a weekend in 2017?')).toEqual([{ value: '2017', kind: 'year' }]);
    expect(statedValues('Top customers by "beverage" revenue in Q2')).toEqual([{ value: 'Q2', kind: 'quarter' }, { value: 'beverage', kind: 'text' }]);
    expect(statedValues('how many opportunities did we lose to splunk', { version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [{ ref: 'column:a.b.c', op: 'eq', values: ['Splunk'], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'scalar' } as never)).toEqual([{ value: 'Splunk', kind: 'text' }]);
  });

  it('a statement that leaves a stated value out is caught; a fiscal year stored as its digits or its calendar years passes', () => {
    const stated = statedValues(office);
    expect(missingStatedValues("SELECT COUNT(*) FROM opp WHERE fiscal_year = 2026", stated)).toEqual([{ value: 'Splunk', kind: 'text' }]);
    expect(missingStatedValues("SELECT COUNT(*) FROM opp WHERE fiscal_year = 2026 AND tags ILIKE '%splunk%'", stated)).toEqual([]);
    expect(missingStatedValues("SELECT COUNT(*) FROM opp WHERE close_date >= '2025-02-01' AND competitor_c = 'Splunk'", stated)).toEqual([]);
  });

  it('reads a required filter and catches a statement that does not apply it', () => {
    const required = [requiredFilterFromText('is_test = false')!, requiredFilterFromText("region in ('EMEA', 'APAC')")!];
    expect(required[1]).toEqual({ text: "region in ('EMEA', 'APAC')", column: 'region', values: ['EMEA', 'APAC'] });
    expect(missingRequiredFilters('SELECT 1 FROM t WHERE is_test = false AND region IN (\'EMEA\', \'APAC\')', required)).toEqual([]);
    expect(missingRequiredFilters('SELECT 1 FROM t WHERE region IN (\'EMEA\')', required).map((item) => item.text)).toEqual(['is_test = false', "region in ('EMEA', 'APAC')"]);
    expect(missingRequiredFilters('SELECT 1 FROM t WHERE NOT is_test AND region in (\'emea\',\'apac\')', required)).toEqual([]);
  });

  it('says what a statement filters on, in its own words', () => {
    expect(appliedConditions("SELECT COUNT(*) FROM opp WHERE is_won = false AND tags ILIKE '%splunk%' GROUP BY 1 ORDER BY 1")).toBe("is_won = false AND tags ILIKE '%splunk%'");
    expect(appliedConditions('SELECT 1 FROM t')).toBeUndefined();
  });

  it('resolves join keys through aliases and leaves CTEs out', () => {
    expect(joinKeyPairs('SELECT COUNT(*) FROM sales.opportunities o JOIN crm.deal_notes AS d ON d.deal_ref = o.deal_ref')).toEqual([
      { left: { relation: 'crm.deal_notes', column: 'deal_ref' }, right: { relation: 'sales.opportunities', column: 'deal_ref' } },
    ]);
    expect(joinKeyPairs('WITH lost AS (SELECT * FROM sales.opportunities) SELECT COUNT(*) FROM lost l JOIN crm.deal_notes d ON d.deal_ref = l.deal_ref')).toEqual([]);
  });

  it('guards the rows a statement returns and recognises aggregation', () => {
    expect(withRowGuard('SELECT a FROM t ORDER BY a;', 501)).toBe('SELECT a FROM t ORDER BY a\nLIMIT 501');
    expect(withRowGuard('SELECT a FROM t LIMIT 10', 501)).toBe('SELECT a FROM t LIMIT 10');
    expect(aggregatesRows('SELECT COUNT(*) FROM t')).toBe(true);
    expect(aggregatesRows('SELECT a FROM t')).toBe(false);
  });
});
