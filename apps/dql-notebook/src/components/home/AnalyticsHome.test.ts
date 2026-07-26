import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as AnalyticsHomeModule from './AnalyticsHome';

let askNotebookCellFromPayload: typeof AnalyticsHomeModule.askNotebookCellFromPayload;

describe('Ask AI Notebook repair handoff', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    ({ askNotebookCellFromPayload } = await import('./AnalyticsHome'));
  });

  it('UI-013 opens failed semantic DQL with attempted SQL and trust metadata intact', () => {
    const sql = 'SELECT SUM(revenue) AS revenue FORM analytics.orders';
    const cell = askNotebookCellFromPayload({
      title: 'Revenue repair',
      sql,
      dqlArtifact: {
        kind: 'semantic_block',
        name: 'revenue_repair',
        source: 'block "revenue_repair" {\n  type = "semantic"\n  metrics = ["revenue"]\n  dimensions = []\n}',
        metrics: ['revenue'],
        dimensions: [],
        persistence: 'transient',
        trustState: 'governed',
        compiledSql: sql,
      },
    });

    expect(cell).toMatchObject({
      type: 'dql',
      name: 'Revenue_repair',
      status: 'idle',
      content: expect.stringContaining('metrics = ["revenue"]'),
      dqlArtifact: {
        metrics: ['revenue'],
        dimensions: [],
        persistence: 'transient',
        trustState: 'governed',
        reviewState: 'review_required',
        compiledSql: sql,
      },
    });
  });

  it('UI-013 opens attempted SQL directly when a failed run has no DQL source', () => {
    expect(askNotebookCellFromPayload({
      title: 'SQL repair',
      sql: 'SELECT broken FROM missing_table',
    })).toMatchObject({
      type: 'sql',
      name: 'SQL_repair',
      content: 'SELECT broken FROM missing_table',
      status: 'idle',
    });
  });
});
