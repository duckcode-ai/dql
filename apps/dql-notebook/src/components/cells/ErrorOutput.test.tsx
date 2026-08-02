import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ErrorOutput } from '../output/ErrorOutput';
import type { Cell } from '../../store/types';
import { canBackgroundRepairNotebookCell } from '../../utils/notebook-background-repair';

describe('ErrorOutput', () => {
  it('offers bounded background repair without starting Notebook AI', () => {
    const markup = renderToStaticMarkup(
      <ErrorOutput
        message="DQL query contains internal DQL graph relation identifier source::dev.orders."
        themeMode="paper"
        editableArtifactLabel="DQL"
        onBackgroundRepair={() => undefined}
      />,
    );

    expect(markup).toContain('Fix and retry');
    expect(markup).toContain('same data target');
    expect(markup).toContain('edit the DQL and run again');
    expect(markup).not.toContain('Ask AI to fix');
  });

  it('offers quiet repair only when changing this cell can resolve the failure', () => {
    const cell = (updates: Partial<Cell>): Cell => ({
      id: 'cell_1',
      type: 'sql',
      content: 'SELECT * FROM source::analytics.main.orders',
      status: 'error',
      error: 'syntax error near source::',
      ...updates,
    });

    expect(canBackgroundRepairNotebookCell(cell({}))).toBe(true);
    expect(canBackgroundRepairNotebookCell(cell({
      content: 'SELECT * FROM {{upstream}}',
      error: 'Notebook dependency result is unavailable.',
      execution: {
        version: 1,
        runId: 'run_1',
        cellId: 'cell_1',
        route: 'notebook_sql_cell',
        status: 'error',
        startedAt: '2026-08-01T00:00:00.000Z',
        completedAt: '2026-08-01T00:00:00.001Z',
        durationMs: 1,
        error: { code: 'UPSTREAM_RESULT_UNAVAILABLE', message: 'Unavailable' },
      },
    }))).toBe(false);
    expect(canBackgroundRepairNotebookCell(cell({ error: 'permission denied for table orders' }))).toBe(false);
    expect(canBackgroundRepairNotebookCell(cell({
      type: 'dql',
      content: 'block revenue { type = "semantic" metrics = [@metric(revenue)] }',
    }))).toBe(false);
    expect(canBackgroundRepairNotebookCell(cell({
      type: 'dql',
      content: 'block revenue { query = """SELECT * FROM source::analytics.main.orders""" }',
    }))).toBe(true);
  });
});
