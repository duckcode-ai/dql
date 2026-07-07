import { describe, expect, it } from 'vitest';
import { SemanticLayer } from '@duckcodeailabs/dql-core';
import { composeSemanticQueryFromMembers } from './compose.js';

function layer(): SemanticLayer {
  return new SemanticLayer({
    metrics: [{ name: 'total_revenue', label: 'Total Revenue', description: 'Recognized revenue.', domain: 'finance', sql: 'amount', type: 'sum', table: 'orders' }],
    dimensions: [{ name: 'channel', label: 'Channel', description: 'Sales channel.', domain: 'finance', sql: 'channel', type: 'string', table: 'orders' }],
  });
}

describe('composeSemanticQueryFromMembers — hollow-answer guard', () => {
  it('rejects a degenerate compile (empty/blank SQL) so the loop falls through to generation', () => {
    // Reproduces the "Answered from governed semantic metrics … " with an EMPTY SQL
    // preview and no rows: an incompatible metric×dimension combo compiles to blank
    // SQL. Accepting it would surface a hollow governed answer; it must be rejected.
    const l = layer();
    (l as unknown as { composeQuery: () => { sql: string } }).composeQuery = () => ({ sql: '   ' });
    const result = composeSemanticQueryFromMembers({
      semanticLayer: l,
      question: 'top customers who bought the top products with revenue',
      selection: { metrics: ['total_revenue'], dimensions: ['channel'] },
    });
    expect(result).toBeUndefined();
  });

  it('accepts a real compiled query with executable SQL', () => {
    const l = layer();
    (l as unknown as { composeQuery: () => { sql: string } }).composeQuery = () =>
      ({ sql: 'SELECT channel, SUM(amount) AS total_revenue FROM orders GROUP BY channel' });
    const result = composeSemanticQueryFromMembers({
      semanticLayer: l,
      question: 'revenue by channel',
      selection: { metrics: ['total_revenue'], dimensions: ['channel'] },
    });
    expect(result?.sql).toContain('SELECT channel');
    expect(result?.metrics).toEqual(['total_revenue']);
  });
});
