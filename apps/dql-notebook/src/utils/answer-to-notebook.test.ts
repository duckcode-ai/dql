import { beforeAll, describe, expect, it, vi } from 'vitest';

let buildNotebookCellsFromAnswer: typeof import('./answer-to-notebook').buildNotebookCellsFromAnswer;

beforeAll(async () => {
  vi.stubGlobal('window', {
    location: { origin: 'http://localhost' },
    localStorage: { getItem: () => null, setItem: () => undefined },
  });
  ({ buildNotebookCellsFromAnswer } = await import('./answer-to-notebook'));
});

describe('Ask answer to Notebook handoff', () => {
  it('preserves the named connection used by the Ask run', () => {
    const cells = buildNotebookCellsFromAnswer({
      title: 'Revenue by customer',
      question: 'Revenue for Melissa Lopez',
      sourceRunId: 'run-1',
      executionTarget: { target: 'connection', connectionName: 'reporting' },
      dqlArtifact: {
        kind: 'semantic_block',
        name: 'revenue_by_customer',
        source: 'block "revenue_by_customer" {\n  type = "semantic"\n  metric = "revenue"\n}',
      },
    }, []);

    expect(cells).toHaveLength(1);
    expect(cells[0]?.executionTarget).toEqual({
      target: 'connection',
      connectionName: 'reporting',
    });
  });
});
