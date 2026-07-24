import { describe, expect, it } from 'vitest';
import type { Cell } from '../store/types';
import { substituteNotebookVariables } from './useVariableSubstitution';

function resultCell(overrides: Partial<Cell> = {}): Cell {
  return {
    id: 'cell_upstream',
    type: 'sql',
    name: 'upstream',
    content: 'select 1',
    status: 'idle',
    result: {
      columns: ['customer', 'revenue'],
      rows: [{ customer: 'Zoom', revenue: 42 }],
      rowCount: 1,
    },
    executionCount: 1,
    ...overrides,
  };
}

describe('substituteNotebookVariables', () => {
  it('uses a completed result after the transient success status returns to idle', () => {
    const substituted = substituteNotebookVariables(
      'select * from {{upstream}}',
      [resultCell()],
    );

    expect(substituted.unresolved).toEqual([]);
    expect(substituted.sql).toContain('WITH upstream AS');
    expect(substituted.sql).toContain('select * from "upstream"');
  });

  it('fails closed for stale or failed upstream results', () => {
    expect(substituteNotebookVariables(
      'select * from {{upstream}}',
      [resultCell({ stale: true })],
    ).unresolved).toEqual(['upstream']);
    expect(substituteNotebookVariables(
      'select * from {{upstream}}',
      [resultCell({ error: 'failed' })],
    ).unresolved).toEqual(['upstream']);
  });

  it('rejects duplicate display names while preserving stable cell-id references', () => {
    const cells = [
      resultCell({ id: 'cell_a' }),
      resultCell({ id: 'cell_b' }),
    ];

    expect(substituteNotebookVariables(
      'select * from {{upstream}}',
      cells,
    ).ambiguous).toEqual(['upstream']);
    const byId = substituteNotebookVariables(
      'select * from {{cell_b}}',
      cells,
    );
    expect(byId.ambiguous).toEqual([]);
    expect(byId.unresolved).toEqual([]);
    expect(byId.sql).toContain('WITH cell_b AS');
  });
});
