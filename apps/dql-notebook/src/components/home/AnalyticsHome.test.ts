import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as AnalyticsHomeModule from './AnalyticsHome';

let askNotebookCellFromPayload: typeof AnalyticsHomeModule.askNotebookCellFromPayload;
let mergePersistedAskConversations: typeof AnalyticsHomeModule.mergePersistedAskConversations;

describe('Ask AI Notebook repair handoff', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    ({ askNotebookCellFromPayload, mergePersistedAskConversations } = await import('./AnalyticsHome'));
  });

  it('UI-013 opens failed semantic DQL with attempted SQL and trust metadata intact', () => {
    const sql = 'SELECT SUM(revenue) AS revenue FORM analytics.orders';
    const cell = askNotebookCellFromPayload({
      title: 'Revenue repair',
      sql,
      question: 'What is revenue?',
      sourceRunId: 'run-revenue',
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
      correctionProvenance: {
        version: 1,
        source: 'agent_run',
        question: 'What is revenue?',
        generatedSql: sql,
        sourceRunId: 'run-revenue',
      },
    });
  });

  it('UI-013 opens attempted SQL directly when a failed run has no DQL source', () => {
    expect(askNotebookCellFromPayload({
      title: 'SQL repair',
      sql: 'SELECT broken FROM missing_table',
      question: 'Show the missing metric',
      sourceRunId: 'run-sql-repair',
    })).toMatchObject({
      type: 'sql',
      name: 'SQL_repair',
      content: 'SELECT broken FROM missing_table',
      status: 'idle',
      correctionProvenance: {
        version: 1,
        source: 'agent_run',
        question: 'Show the missing metric',
        generatedSql: 'SELECT broken FROM missing_table',
        sourceRunId: 'run-sql-repair',
      },
    });
  });

  it('API-008 rebuilds Ask history from durable server threads after browser storage is reset', () => {
    const recovered = mergePersistedAskConversations([], [{
      id: 'thr_revenue',
      surface: 'ask',
      title: 'Top revenue customers',
      archived: false,
      createdAt: '2026-07-28T10:00:00.000Z',
      updatedAt: '2026-07-29T10:00:00.000Z',
    }]);
    expect(recovered).toEqual([expect.objectContaining({
      id: 'conv_server_thr_revenue',
      title: 'Top revenue customers',
      threadId: 'thr_revenue',
      items: [],
    })]);
  });

  it('keeps the richer browser rendering cache while refreshing thread recency', () => {
    const local: AnalyticsHomeModule.Conversation = {
      id: 'conv_local',
      title: 'Revenue analysis',
      threadId: 'thr_revenue',
      createdAt: '2026-07-28T10:00:00.000Z',
      updatedAt: '2026-07-28T11:00:00.000Z',
      items: [{ kind: 'user', id: 'user_1', text: 'Who are the top customers?' }],
    };
    const [merged] = mergePersistedAskConversations([local], [{
      id: 'thr_revenue',
      surface: 'ask',
      title: 'Top revenue customers',
      archived: false,
      createdAt: local.createdAt,
      updatedAt: '2026-07-29T10:00:00.000Z',
    }]);
    expect(merged).toMatchObject({
      id: 'conv_local',
      title: 'Revenue analysis',
      updatedAt: '2026-07-29T10:00:00.000Z',
      items: local.items,
      threadId: 'thr_revenue',
    });
  });
});
