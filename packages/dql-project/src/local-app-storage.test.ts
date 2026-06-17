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
      question: 'Why did deposits grow?',
      sql: 'SELECT 1 AS value',
      chartConfig: { chart: 'single_value' },
      result: { columns: ['value'], rows: [{ value: 1 }], rowCount: 1 },
      analysisPlan: { intent: 'ad_hoc_analysis', candidateTables: [{ relation: 'dev.deposits' }] },
      evidence: { validation: { status: 'warning' } },
      followUps: ['Show deposits by segment'],
    });

    expect(pin.reviewStatus).toBe('needs_review');
    const listed = store.listAiPins('executive-cockpit', 'bank-overview');
    expect(listed).toHaveLength(1);
    expect(listed[0].question).toBe('Why did deposits grow?');
    expect(listed[0].analysisPlan).toMatchObject({ intent: 'ad_hoc_analysis' });
    expect(listed[0].followUps).toEqual(['Show deposits by segment']);

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
      context: {
        activeSurface: 'app',
        sourceCertifiedBlock: 'monthly_revenue',
        sourceQuestion: 'What changed?',
        trustLabel: 'certified',
        contextPackId: 'ctx_123',
      },
      messages: [
        { role: 'user', content: 'What changed?' },
        { role: 'assistant', content: 'Deposits grew.' },
      ],
    });

    expect(created.messageCount).toBe(2);
    expect(created.context?.sourceCertifiedBlock).toBe('monthly_revenue');
    expect(store.listAppConversations('executive-cockpit')).toHaveLength(1);

    const updated = store.updateAppConversation(created.id, {
      context: {
        activeSurface: 'app',
        sourceCertifiedBlock: 'card_approval_rate',
        sourceQuestion: 'Why did approvals soften?',
        reviewStatus: 'draft_ready',
        draftBlockPath: 'blocks/_drafts/card_approval_rate.dql',
      },
      messages: [
        { role: 'user', content: 'What changed?' },
        { role: 'assistant', content: 'Deposits grew and card approvals softened.' },
      ],
    });
    expect(updated?.lastMessage).toContain('card approvals');
    expect(updated?.context?.sourceCertifiedBlock).toBe('card_approval_rate');

    const full = store.getAppConversation(created.id);
    expect(full?.messages?.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(full?.context?.draftBlockPath).toBe('blocks/_drafts/card_approval_rate.dql');
    expect(store.deleteAppConversation(created.id)).toBe(true);
    expect(store.listAppConversations('executive-cockpit')).toHaveLength(0);
  });

  it('stores App research investigations locally', () => {
    const created = store.createAppInvestigation({
      appId: 'executive-cockpit',
      dashboardId: 'bank-overview',
      sourceTileId: 'revenue-trend',
      sourceBlockId: 'monthly_revenue',
      question: 'Why did revenue drop in February?',
      intent: 'diagnose_change',
      context: { selectedBlock: { blockId: 'monthly_revenue', rowCount: 3 } },
      generatedSql: 'SELECT 1 AS revenue',
    });

    expect(created.reviewStatus).toBe('needs_review');
    expect(created.status).toBe('draft');
    expect(store.listAppInvestigations('executive-cockpit')).toHaveLength(1);

    const updated = store.updateAppInvestigation(created.id, {
      status: 'ready',
      summary: 'Revenue dropped because enterprise renewals slipped.',
      recommendation: 'Review the enterprise renewal cohort.',
      metrics: { currentValue: 10, baselineValue: 15, delta: -5 },
      driverCards: [{ title: 'Enterprise', contribution: '-5' }],
      resultPreviews: [{ result: { columns: ['segment', 'revenue'], rows: [{ segment: 'Enterprise', revenue: 10 }] } }],
      evidence: { trustStatus: { uncertified: true } },
      lastRunAt: '2026-02-01T00:00:00.000Z',
    });

    expect(updated?.status).toBe('ready');
    expect(updated?.metrics).toMatchObject({ delta: -5 });
    expect(updated?.driverCards).toHaveLength(1);
    expect(updated?.resultPreviews).toHaveLength(1);

    const pinned = store.markAppInvestigationPinned(created.id, 'pin_revenue_drop');
    expect(pinned?.pinnedAiPinId).toBe('pin_revenue_drop');
    expect(store.listAppInvestigations('executive-cockpit', 'bank-overview')[0].sourceBlockId).toBe('monthly_revenue');
  });
});
