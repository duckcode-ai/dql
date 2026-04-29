import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalAppStorage } from './local-app-storage.js';

let dir: string;
let store: LocalAppStorage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dql-local-apps-'));
  store = new LocalAppStorage(join(dir, '.dql', 'local', 'apps.sqlite'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('LocalAppStorage', () => {
  it('stores AI pins and refresh metadata locally', () => {
    const pin = store.createAiPin({
      appId: 'executive-cockpit',
      dashboardId: 'bank-overview',
      title: 'AI summary',
      answer: 'Deposits are growing.',
      sql: 'SELECT 1 AS value',
      chartConfig: { chart: 'single_value' },
      result: { columns: ['value'], rows: [{ value: 1 }], rowCount: 1 },
    });

    expect(pin.reviewStatus).toBe('needs_review');
    expect(store.listAiPins('executive-cockpit', 'bank-overview')).toHaveLength(1);

    const refreshed = store.updateAiPinResult(pin.id, { columns: ['value'], rows: [{ value: 2 }], rowCount: 1 });
    expect(refreshed?.lastRefreshedAt).toBeTruthy();
    expect(refreshed?.lastRefreshError).toBeUndefined();

    const promoted = store.markAiPinPromoted(pin.id, 'apps/executive-cockpit/drafts/ai_summary.dql');
    expect(promoted?.reviewStatus).toBe('draft_created');
    expect(promoted?.promotedBlockPath).toBe('apps/executive-cockpit/drafts/ai_summary.dql');
  });

  it('stores private App conversations locally', () => {
    const created = store.createAppConversation({
      appId: 'executive-cockpit',
      dashboardId: 'bank-overview',
      title: 'Weekly review',
      messages: [
        { role: 'user', content: 'What changed?' },
        { role: 'assistant', content: 'Deposits grew.' },
      ],
    });

    expect(created.messageCount).toBe(2);
    expect(store.listAppConversations('executive-cockpit')).toHaveLength(1);

    const updated = store.updateAppConversation(created.id, {
      messages: [
        { role: 'user', content: 'What changed?' },
        { role: 'assistant', content: 'Deposits grew and card approvals softened.' },
      ],
    });
    expect(updated?.lastMessage).toContain('card approvals');

    const full = store.getAppConversation(created.id);
    expect(full?.messages?.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(store.deleteAppConversation(created.id)).toBe(true);
    expect(store.listAppConversations('executive-cockpit')).toHaveLength(0);
  });
});
