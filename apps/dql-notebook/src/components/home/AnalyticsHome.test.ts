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

  // The browser cache stays authoritative for ITEMS (it holds the rendered
  // conversation), but NOT for the title: renaming a chat writes the title to
  // the server, so a stale local copy must never win — that would silently undo
  // a rename made in another tab or before a refresh.
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
      // The server title is the user's rename and wins.
      title: 'Top revenue customers',
      updatedAt: '2026-07-29T10:00:00.000Z',
      // The locally cached items are still preserved — that is what this guards.
      items: local.items,
      threadId: 'thr_revenue',
    });
  });

  it('does not restore a locally deleted thread while its server deletion is pending', () => {
    const local: AnalyticsHomeModule.Conversation = {
      id: 'conv_keep',
      title: 'Keep this conversation',
      threadId: 'thr_keep',
      createdAt: '2026-07-28T10:00:00.000Z',
      updatedAt: '2026-07-28T11:00:00.000Z',
      items: [],
    };
    const merged = mergePersistedAskConversations([local], [{
      id: 'thr_deleted',
      surface: 'ask',
      title: 'Deleted conversation',
      archived: false,
      createdAt: '2026-07-28T10:00:00.000Z',
      updatedAt: '2026-07-29T10:00:00.000Z',
    }, {
      id: 'thr_keep',
      surface: 'ask',
      title: 'Keep this conversation',
      archived: false,
      createdAt: local.createdAt,
      updatedAt: local.updatedAt,
    }], new Set(['thr_deleted']));

    expect(merged.map((conversation) => conversation.threadId)).toEqual(['thr_keep']);
  });
});

describe('conversation rename and pinning', () => {
  it('falls back to the local title when the server thread has none', () => {
    const local: AnalyticsHomeModule.Conversation = {
      id: 'conv_local',
      title: 'My analysis',
      threadId: 'thr_1',
      createdAt: '2026-07-28T10:00:00.000Z',
      updatedAt: '2026-07-28T11:00:00.000Z',
      items: [],
    };
    const [merged] = mergePersistedAskConversations([local], [{
      id: 'thr_1', surface: 'ask', archived: false,
      createdAt: local.createdAt, updatedAt: local.updatedAt,
    }]);
    expect(merged.title).toBe('My analysis');
  });

  it('carries the pinned flag from the server thread', () => {
    const [merged] = mergePersistedAskConversations([], [{
      id: 'thr_1', surface: 'ask', title: 'Pinned chat', archived: false, favorite: true,
      createdAt: '2026-07-28T10:00:00.000Z', updatedAt: '2026-07-28T11:00:00.000Z',
    }]);
    expect(merged.favorite).toBe(true);
    expect(merged.title).toBe('Pinned chat');
  });

  it('defaults to not pinned when the server does not say', () => {
    const [merged] = mergePersistedAskConversations([], [{
      id: 'thr_1', surface: 'ask', title: 'Chat', archived: false,
      createdAt: '2026-07-28T10:00:00.000Z', updatedAt: '2026-07-28T11:00:00.000Z',
    }]);
    expect(merged.favorite).toBe(false);
  });
});
