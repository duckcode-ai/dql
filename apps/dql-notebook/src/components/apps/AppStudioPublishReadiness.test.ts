import { describe, expect, it } from 'vitest';
import type { AppStudioBuildDraft } from '../../api/client';
import {
  blockingPublicationReviewTasks,
  localPublicationSteps,
  pagesNeedingSettledPreview,
  publicationIssueSummaries,
  unresolvedPublicationRequirements,
} from './app-studio-publish-readiness';

function draftFixture(): AppStudioBuildDraft {
  return {
    version: 2,
    id: 'build-1',
    appId: 'revenue-app',
    name: 'Revenue App',
    revision: 3,
    proposalHash: 'sha256:draft',
    authoringMode: 'ai',
    template: 'operational_dashboard',
    sourcePolicy: 'governed_only',
    state: 'local_draft',
    frame: { goal: 'Monitor revenue', audience: 'Finance', metrics: ['revenue'], dimensions: ['month'], filters: [], desiredOutput: 'Operational App' },
    requirements: [{ id: 'trend', question: 'Revenue over time', role: 'trend', required: true, measures: ['revenue'], dimensions: ['month'], filters: [] }],
    coverage: [{ requirementId: 'trend', status: 'gap', sourceIds: [], componentIds: [], reasons: [] }],
    sources: [{ id: 'block:revenue', kind: 'certified_block', sourceRef: 'revenue', trustState: 'certified', reviewStatus: 'not_required' }],
    pages: [{
      version: 2,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [{ i: 'revenue', x: 0, y: 0, w: 6, h: 4, block: { blockId: 'revenue' }, viz: { type: 'line' } }] },
    }],
    reviewTasks: [{ id: 'ai-review-1', message: 'Review every scoped analysis memo before stakeholder use.', status: 'open' }],
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  };
}

describe('App Studio publication readiness (API-013, UI-022)', () => {
  it('does not treat old unscoped AI reminders as publication blockers', () => {
    const draft = draftFixture();
    expect(blockingPublicationReviewTasks(draft)).toEqual([]);
    expect(localPublicationSteps(draft).map((step) => step.id)).toEqual(['questions', 'preview']);
  });

  it('keeps content-scoped review tasks blocking until resolved or removed', () => {
    const draft = draftFixture();
    draft.reviewTasks.push({ id: 'review-revenue', message: 'Validate revenue grain.', status: 'open', sourceId: 'block:revenue', tileId: 'revenue' });
    expect(blockingPublicationReviewTasks(draft).map((task) => task.id)).toEqual(['review-revenue']);
  });

  it('clears the question and preview steps only with explicit scope and a current settled receipt', () => {
    const draft = draftFixture();
    draft.requirements[0].required = false;
    draft.previewReceipts = [{ id: 'run-1', pageId: 'overview', revision: draft.revision, snapshotId: 'snapshot', filterFingerprint: 'filters', resultFingerprint: 'result', createdAt: draft.updatedAt }];
    expect(unresolvedPublicationRequirements(draft)).toEqual([]);
    expect(pagesNeedingSettledPreview(draft)).toEqual([]);
    expect(localPublicationSteps(draft)).toEqual([]);
  });

  it('ignores empty-measure AI placeholders on a manually authored App', () => {
    const draft = draftFixture();
    draft.authoringMode = 'manual';
    draft.frame.metrics = [];
    draft.requirements[0].measures = [];
    expect(unresolvedPublicationRequirements(draft)).toEqual([]);
  });

  it('does not duplicate a review-required DQL source as a changed-source action (API-013)', () => {
    expect(publicationIssueSummaries([
      'overview/ask-result references app-scoped exploratory DQL; promote it to governed semantic logic or a certified block first.',
    ])).toEqual([]);
  });
});
