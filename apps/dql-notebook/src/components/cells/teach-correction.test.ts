import { describe, expect, it } from 'vitest';
import type { Cell } from '../../store/types';
import { teachCorrectionEligibility } from './teach-correction';

function successfulEditedCell(overrides: Partial<Cell> = {}): Cell {
  return {
    id: 'cell-1',
    type: 'sql',
    content: 'select sum(net_amount) from orders',
    status: 'success',
    result: { columns: ['sum'], rows: [{ sum: 42 }] },
    execution: {
      version: 1,
      runId: 'run-1',
      cellId: 'cell-1',
      route: 'notebook_sql_cell',
      status: 'success',
      startedAt: '2026-07-28T00:00:00.000Z',
      completedAt: '2026-07-28T00:00:01.000Z',
      durationMs: 1000,
      executedSql: 'select sum(net_amount) from orders',
    },
    dqlArtifact: {
      source: 'block "revenue" {}',
      sql: 'select sum(amount) from orders',
      question: 'What is net revenue?',
    },
    stale: false,
    fromSnapshot: false,
    ...overrides,
  };
}

describe('teachCorrectionEligibility', () => {
  it('allows only an edited AI query with a successful live run', () => {
    expect(teachCorrectionEligibility(successfulEditedCell()).eligible).toBe(true);
  });

  it.each([
    { stale: true },
    { fromSnapshot: true },
    { execution: undefined },
    { execution: { ...successfulEditedCell().execution!, status: 'error' as const } },
    { content: 'select sum(amount) from orders' },
  ])('rejects stale, cached, unexecuted, failed, or unedited results: %o', (overrides) => {
    expect(teachCorrectionEligibility(successfulEditedCell(overrides)).eligible).toBe(false);
  });
});
