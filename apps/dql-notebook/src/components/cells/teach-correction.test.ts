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
    },
    correctionProvenance: {
      version: 1,
      source: 'agent_run',
      question: 'What is net revenue?',
      generatedSql: 'select sum(amount) from orders',
      sourceRunId: 'agent-run-1',
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

  it('remains eligible after the temporary success indicator returns to idle', () => {
    expect(teachCorrectionEligibility(successfulEditedCell({ status: 'idle' }))).toMatchObject({
      eligible: true,
      reason: 'ready',
    });
  });

  it.each([
    { stale: true },
    { fromSnapshot: true },
    { execution: undefined },
    { execution: { ...successfulEditedCell().execution!, status: 'error' as const } },
    { execution: { ...successfulEditedCell().execution!, executedSql: 'select sum(gross_amount) from orders' } },
    { content: 'select sum(amount) from orders' },
  ])('rejects stale, cached, unexecuted, failed, or unedited results: %o', (overrides) => {
    expect(teachCorrectionEligibility(successfulEditedCell(overrides)).eligible).toBe(false);
  });

  it.each([
    { sourcePath: 'domains/commerce/blocks/revenue.dql' },
    { persistence: 'saved' as const },
    { trustState: 'certified' as const },
    { reviewState: 'certified' as const },
  ])('never teaches from saved or certified governed DQL: %o', (artifactOverride) => {
    const cell = successfulEditedCell({
      dqlArtifact: {
        ...successfulEditedCell().dqlArtifact!,
        ...artifactOverride,
      },
    });
    expect(teachCorrectionEligibility(cell).eligible).toBe(false);
  });

  it('uses the successfully executed SQL for an edited transient DQL draft', () => {
    const cell = successfulEditedCell({
      type: 'dql',
      content: 'block "revenue" {\n  metrics = ["net_revenue"]\n}',
      execution: {
        ...successfulEditedCell().execution!,
        route: 'notebook_dql_cell',
        executedSql: 'select sum(net_amount) from orders',
      },
      correctionProvenance: {
        version: 1,
        source: 'agent_run',
        question: 'What is net revenue?',
        generatedDql: 'block "revenue" {\n  metrics = ["gross_revenue"]\n}',
        generatedSql: 'select sum(gross_amount) from orders',
      },
      dqlArtifact: {
        source: 'block "revenue" {\n  metrics = ["gross_revenue"]\n}',
        sql: 'select sum(gross_amount) from orders',
        persistence: 'transient',
        trustState: 'review_required',
      },
    });

    expect(teachCorrectionEligibility(cell)).toMatchObject({
      eligible: true,
      generatedSql: 'select sum(gross_amount) from orders',
      correctedSql: 'select sum(net_amount) from orders',
      question: 'What is net revenue?',
    });
  });

  it('accepts compiler SQL as the execution-backed correction when a DQL adapter omits executedSql', () => {
    const base = successfulEditedCell();
    const cell: Cell = {
      ...base,
      type: 'dql',
      content: 'block "revenue" {\n  metrics = ["net_revenue"]\n}',
      execution: {
        ...base.execution!,
        route: 'notebook_dql_cell',
        executedSql: undefined,
        compiledSql: 'select sum(net_amount) from orders',
      },
      correctionProvenance: {
        version: 1,
        source: 'agent_run',
        question: 'What is net revenue?',
        generatedDql: 'block "revenue" {\n  metrics = ["gross_revenue"]\n}',
        generatedSql: 'select sum(gross_amount) from orders',
      },
      dqlArtifact: {
        source: 'block "revenue" {\n  metrics = ["gross_revenue"]\n}',
        persistence: 'transient',
      },
    };

    expect(teachCorrectionEligibility(cell)).toMatchObject({
      eligible: true,
      correctedSql: 'select sum(net_amount) from orders',
    });
  });
});
