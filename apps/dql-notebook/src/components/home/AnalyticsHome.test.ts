import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentConversationThreadListResponse } from '../../api/client';
import { themes } from '../../themes/notebook-theme';
import type * as AnalyticsHomeModule from './AnalyticsHome';

let askNotebookCellFromPayload: typeof AnalyticsHomeModule.askNotebookCellFromPayload;
let mergePersistedAskConversations: typeof AnalyticsHomeModule.mergePersistedAskConversations;
let reconcileAskConversationCache: typeof AnalyticsHomeModule.reconcileAskConversationCache;
let snapshotAskConversationList: typeof AnalyticsHomeModule.snapshotAskConversationList;
let applyAskThreadIdCallback: typeof AnalyticsHomeModule.applyAskThreadIdCallback;
let applyAskItemsCallback: typeof AnalyticsHomeModule.applyAskItemsCallback;
let hydrateInitialAskConversationList: typeof AnalyticsHomeModule.hydrateInitialAskConversationList;
let AskHistoryVerificationGate: typeof AnalyticsHomeModule.AskHistoryVerificationGate;
let askResearchTracePath: typeof AnalyticsHomeModule.askResearchTracePath;
let openAskResearchTrace: typeof AnalyticsHomeModule.openAskResearchTrace;

describe('Ask AI Notebook repair handoff', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    ({
      askNotebookCellFromPayload,
      mergePersistedAskConversations,
      reconcileAskConversationCache,
      snapshotAskConversationList,
      applyAskThreadIdCallback,
      applyAskItemsCallback,
      hydrateInitialAskConversationList,
      AskHistoryVerificationGate,
      askResearchTracePath,
      openAskResearchTrace,
    } = await import('./AnalyticsHome'));
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

  it('opens Ask Research through the addressable local trace with an explicit Research focus', () => {
    expect(askResearchTracePath('ask run/with spaces')).toBe('/ask/traces/ask%20run%2Fwith%20spaces?focus=research');
  });

  it('routes the native Open research action to the Ask trace and its Research focus', () => {
    const dispatch = vi.fn();
    const history = { replaceState: vi.fn() };
    openAskResearchTrace({ sourceAskRunId: 'ask-research-run', dispatch, history });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({ type: 'OPEN_ASK_TRACE', runId: 'ask-research-run' });
    expect(history.replaceState).toHaveBeenCalledWith(
      { askTraceRunId: 'ask-research-run', focus: 'research' },
      '',
      '/ask/traces/ask-research-run?focus=research',
    );
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

  it('clears reused-origin cached Ask chats, answers, and canary values when the active server returns no Ask threads', () => {
    const canary = 'DQL_EGRESS_CANARY_76D5496D';
    const stale: AnalyticsHomeModule.Conversation = {
      id: 'conv_stale',
      title: 'Gross revenue',
      threadId: 'thr_stale',
      createdAt: '2026-08-22T10:00:00.000Z',
      updatedAt: '2026-08-22T10:01:00.000Z',
      // The test deliberately includes both a stale question and a rendered
      // answer payload. They must not survive a successful empty server list.
      items: [{ kind: 'user', id: 'stale-question', text: canary }, {
        kind: 'run',
        id: 'stale-run',
        run: { id: 'run_stale', answer: canary, summary: canary } as never,
      }],
    };
    const result = reconcileAskConversationCache({
      local: [stale],
      threads: [],
      activeId: stale.id,
      cachedProjectIdentity: `sha256:${'a'.repeat(64)}`,
      serverProjectIdentity: `sha256:${'a'.repeat(64)}`,
      createConversationId: () => 'conv_fresh',
    });

    expect(result).toMatchObject({
      conversations: [],
      activeId: 'conv_fresh',
      cacheIdentityMatches: true,
      resetBrowserCache: true,
    });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it('does not reuse rendered items when the same browser origin serves a different project identity', () => {
    const canary = 'DQL_EGRESS_CANARY_76D5496D';
    const stale: AnalyticsHomeModule.Conversation = {
      id: 'conv_server_thr_shared',
      title: 'Old project revenue',
      threadId: 'thr_shared',
      createdAt: '2026-08-22T10:00:00.000Z',
      updatedAt: '2026-08-22T10:01:00.000Z',
      items: [{ kind: 'user', id: 'stale-question', text: canary }],
    };
    const result = reconcileAskConversationCache({
      local: [stale],
      // Even a coincidentally identical thread id cannot authorize reuse of
      // a previous runtime's browser-rendered answer.
      threads: [{
        id: 'thr_shared', surface: 'ask', title: 'Fresh project revenue', archived: false,
        createdAt: '2026-08-23T10:00:00.000Z', updatedAt: '2026-08-23T10:01:00.000Z',
      }],
      activeId: stale.id,
      cachedProjectIdentity: `sha256:${'a'.repeat(64)}`,
      serverProjectIdentity: `sha256:${'b'.repeat(64)}`,
    });

    expect(result).toMatchObject({
      activeId: 'conv_server_thr_shared',
      cacheIdentityMatches: false,
      resetBrowserCache: true,
      conversations: [{
        id: 'conv_server_thr_shared',
        title: 'Fresh project revenue',
        threadId: 'thr_shared',
        items: [],
      }],
    });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it('keeps a new Ask create/submit when a deferred initial list returns a stale empty snapshot', () => {
    const projectIdentity = `sha256:${'a'.repeat(64)}`;
    const cachedAtRequestStart: AnalyticsHomeModule.Conversation[] = [{
      id: 'conv_existing',
      title: 'Existing cache',
      threadId: 'thr_existing',
      createdAt: '2026-08-23T10:00:00.000Z',
      updatedAt: '2026-08-23T10:00:00.000Z',
      items: [],
    }];
    // Capture the state before the list begins. A later submit creates both a
    // local rendered conversation and a server thread before this stale list
    // response returns.
    const requestSnapshot = snapshotAskConversationList(cachedAtRequestStart);
    const newConversation: AnalyticsHomeModule.Conversation = {
      id: 'conv_created_while_list_pending',
      title: 'New revenue question',
      threadId: 'thr_created_while_list_pending',
      createdAt: '2026-08-23T10:01:00.000Z',
      updatedAt: '2026-08-23T10:01:01.000Z',
      items: [{ kind: 'user', id: 'new-question', text: 'Show revenue by customer' }],
    };
    const result = reconcileAskConversationCache({
      local: [...cachedAtRequestStart, newConversation],
      // Simulates the stale response captured before the newly-created thread.
      threads: [],
      activeId: newConversation.id,
      cachedProjectIdentity: projectIdentity,
      serverProjectIdentity: projectIdentity,
      requestSnapshot,
      requestEpoch: 10,
      mutationEpochByConversationId: new Map([[newConversation.id, 11]]),
    });

    expect(result).toMatchObject({
      activeId: newConversation.id,
      resetBrowserCache: true,
      conversations: [newConversation],
    });
    expect(result.conversations.map((conversation) => conversation.id)).not.toContain('conv_existing');
  });

  it('keeps the Ask panel, cached canary, and thread lookup unmounted until a deferred list verifies the project', async () => {
    const canary = 'DQL_EGRESS_CANARY_76D5496D';
    const projectIdentity = `sha256:${'a'.repeat(64)}`;
    const cached: AnalyticsHomeModule.Conversation = {
      id: 'conv_safe_after_verification',
      title: canary,
      threadId: 'thr_verified',
      createdAt: '2026-08-23T10:00:00.000Z',
      updatedAt: '2026-08-23T10:01:00.000Z',
      items: [{ kind: 'user', id: 'cached-canary', text: canary }],
    };
    let current = [cached];
    let resolveList!: (value: AgentConversationThreadListResponse) => void;
    const deferredList = new Promise<AgentConversationThreadListResponse>((resolve) => { resolveList = resolve; });
    const listAgentThreads = vi.fn(() => deferredList);
    const hydration = hydrateInitialAskConversationList({
      listAgentThreads,
      requestSnapshot: snapshotAskConversationList(current),
      requestEpoch: 0,
      deletedAtRequestStart: new Set(),
      getDeletedThreadIds: () => new Set(),
      getConversations: () => current,
      getActiveId: () => cached.id,
      getMutationEpochByConversationId: () => new Map(),
      getCachedProjectIdentity: () => projectIdentity,
    });
    const threadLookup = vi.fn();
    const PanelProbe = () => {
      threadLookup(cached.threadId);
      return React.createElement('div', { 'data-ask-panel': 'mounted', 'data-thread-lookup': cached.threadId }, canary);
    };
    const pendingMarkup = renderToStaticMarkup(React.createElement(
      AskHistoryVerificationGate,
      { state: 'pending', t: themes.paper, onRetry: vi.fn(), children: React.createElement(PanelProbe) },
    ));

    expect(listAgentThreads).toHaveBeenCalledWith({ limit: 100 });
    expect(threadLookup).not.toHaveBeenCalled();
    expect(pendingMarkup).not.toContain(canary);
    expect(pendingMarkup).not.toContain('data-ask-panel');
    expect(pendingMarkup).not.toContain('data-thread-lookup');
    expect(pendingMarkup).toContain('disabled');

    resolveList({
      projectIdentity,
      threads: [{
        id: 'thr_verified', surface: 'ask', title: 'Verified conversation', archived: false,
        createdAt: cached.createdAt, updatedAt: cached.updatedAt,
      }],
    });
    const { reconciliation } = await hydration;
    const verifiedThreadId = reconciliation.conversations[0]?.threadId;
    const VerifiedPanelProbe = () => {
      threadLookup(verifiedThreadId);
      return React.createElement('div', { 'data-ask-panel': 'mounted', 'data-thread-lookup': verifiedThreadId }, 'verified panel');
    };
    const verifiedMarkup = renderToStaticMarkup(React.createElement(
      AskHistoryVerificationGate,
      { state: 'verified', t: themes.paper, onRetry: vi.fn(), children: React.createElement(VerifiedPanelProbe) },
    ));
    expect(reconciliation.cacheIdentityMatches).toBe(true);
    expect(verifiedMarkup).toContain('data-ask-panel');
    expect(verifiedMarkup).toContain('data-thread-lookup="thr_verified"');
    expect(threadLookup).toHaveBeenLastCalledWith('thr_verified');
  });

  it('keeps cached Ask content hidden and exposes retry when local history verification is unavailable', () => {
    const canary = 'DQL_EGRESS_CANARY_76D5496D';
    const threadLookup = vi.fn();
    const PanelProbe = () => {
      threadLookup();
      return React.createElement('div', { 'data-ask-panel': 'mounted' }, canary);
    };
    const markup = renderToStaticMarkup(React.createElement(
      AskHistoryVerificationGate,
      { state: 'unavailable', t: themes.paper, onRetry: vi.fn(), children: React.createElement(PanelProbe) },
    ));

    expect(threadLookup).not.toHaveBeenCalled();
    expect(markup).not.toContain(canary);
    expect(markup).not.toContain('data-ask-panel');
    expect(markup).toContain('Retry history verification');
    expect(markup).toContain('Cached conversations are hidden');
  });

  it('ignores a deferred thread-create callback from an unmounted or revoked Ask panel', () => {
    const current: AnalyticsHomeModule.Conversation[] = [{
      id: 'conv_current',
      title: 'Current project chat',
      createdAt: '2026-08-23T10:00:00.000Z',
      updatedAt: '2026-08-23T10:00:00.000Z',
      items: [],
    }];
    const afterLateCreate = applyAskThreadIdCallback({
      conversations: current,
      callbackConversationId: 'conv_revoked',
      callbackEpoch: 4,
      activeConversationId: 'conv_current',
      activeEpoch: 5,
      revokedPanelKeys: new Set(['conv_revoked:4']),
      threadId: 'thr_late_create',
      now: '2026-08-23T10:01:00.000Z',
    });

    // The old panel cannot recreate its local conversation or attach a late
    // server thread after the active panel has changed.
    expect(afterLateCreate).toBe(current);
    expect(afterLateCreate).toEqual(current);
  });

  it('keeps only project-B post-boundary items after a deferred API list replaces a failed project-A thread', async () => {
    const projectAIdentity = `sha256:${'a'.repeat(64)}`;
    const projectBIdentity = `sha256:${'b'.repeat(64)}`;
    const canary = 'DQL_EGRESS_CANARY_76D5496D';
    const conversationId = 'conv_reused_across_projects';
    const projectACache: AnalyticsHomeModule.Conversation = {
      id: conversationId,
      title: 'Project A secret analysis',
      threadId: 'thr_project_a_missing',
      createdAt: '2026-08-23T10:00:00.000Z',
      updatedAt: '2026-08-23T10:01:00.000Z',
      favorite: true,
      items: [{ kind: 'user', id: 'project-a-question', text: canary }, {
        kind: 'run',
        id: 'project-a-run-item',
        run: { id: 'run_project_a', answer: canary, summary: canary } as never,
      }],
    };
    let current = [projectACache];
    const mutationEpochByConversationId = new Map<string, number>();
    const requestSnapshot = snapshotAskConversationList(current);
    let resolveList!: (value: AgentConversationThreadListResponse) => void;
    const deferredList = new Promise<AgentConversationThreadListResponse>((resolve) => {
      resolveList = resolve;
    });
    const listAgentThreads = vi.fn(() => deferredList);

    // This is the exact component hydration seam: it has started the initial
    // API list, but project B has not answered it yet.
    const hydration = hydrateInitialAskConversationList({
      listAgentThreads,
      requestSnapshot,
      requestEpoch: 0,
      deletedAtRequestStart: new Set(),
      getDeletedThreadIds: () => new Set(),
      getConversations: () => current,
      getActiveId: () => conversationId,
      getMutationEpochByConversationId: () => mutationEpochByConversationId,
      getCachedProjectIdentity: () => projectAIdentity,
    });
    expect(listAgentThreads).toHaveBeenCalledWith({ limit: 100 });

    // UnifiedAgentRunPanel treats a missing old thread as a failed hydration
    // and forgets it before the next submit. Model its public follow-up: the
    // same local conversation receives a new project-B thread and new items.
    const oldThreadHydration = vi.fn(async () => { throw new Error('404 old project thread'); });
    await expect(oldThreadHydration()).rejects.toThrow('404 old project thread');
    current = applyAskThreadIdCallback({
      conversations: current,
      callbackConversationId: conversationId,
      callbackEpoch: 0,
      activeConversationId: conversationId,
      activeEpoch: 0,
      revokedPanelKeys: new Set(),
      threadId: 'thr_project_b_new',
      now: '2026-08-23T10:02:00.000Z',
    });
    mutationEpochByConversationId.set(conversationId, 1);
    const projectBItems: AnalyticsHomeModule.Conversation['items'] = [
      ...current[0].items,
      { kind: 'user', id: 'project-b-question', text: 'Project B revenue by customer' },
      {
        kind: 'run',
        id: 'project-b-run-item',
        run: { id: 'run_project_b', answer: 'Project B answer', summary: 'Project B answer' } as never,
      },
    ];
    current = applyAskItemsCallback({
      conversations: current,
      callbackConversationId: conversationId,
      callbackEpoch: 0,
      activeConversationId: conversationId,
      activeEpoch: 0,
      revokedPanelKeys: new Set(),
      items: projectBItems,
      now: '2026-08-23T10:03:00.000Z',
    });
    mutationEpochByConversationId.set(conversationId, 2);

    // The delayed initial list now confirms a different active project. No old
    // thread is listed, so only the post-boundary project-B delta may survive.
    resolveList({ threads: [], projectIdentity: projectBIdentity });
    const { reconciliation } = await hydration;
    expect(reconciliation).toMatchObject({
      activeId: conversationId,
      cacheIdentityMatches: false,
      resetBrowserCache: true,
      conversations: [{
        id: conversationId,
        title: 'Project B revenue by customer',
        threadId: 'thr_project_b_new',
        items: projectBItems.slice(-2),
      }],
    });
    expect(reconciliation.conversations[0]?.favorite).toBeUndefined();
    expect(JSON.stringify(reconciliation)).not.toContain(canary);
    expect(JSON.stringify(reconciliation)).not.toContain('Project A secret analysis');
    const threadLookup = vi.fn();
    const ReconciledProjectBPanel = () => {
      const conversation = reconciliation.conversations[0];
      threadLookup(conversation?.threadId);
      return React.createElement('div', {
        'data-ask-panel': 'mounted',
        'data-thread-lookup': conversation?.threadId,
      }, JSON.stringify(conversation?.items));
    };
    const mismatchMarkup = renderToStaticMarkup(React.createElement(
      AskHistoryVerificationGate,
      { state: 'verified', t: themes.paper, onRetry: vi.fn(), children: React.createElement(ReconciledProjectBPanel) },
    ));
    expect(threadLookup).toHaveBeenCalledWith('thr_project_b_new');
    expect(mismatchMarkup).toContain('data-thread-lookup="thr_project_b_new"');
    expect(mismatchMarkup).not.toContain(canary);
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
