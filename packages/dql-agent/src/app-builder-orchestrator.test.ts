import { describe, expect, it, vi } from 'vitest';
import { planAppBuildBrief } from './app-builder-orchestrator.js';
import type { AppSourceCatalogRecord } from './app-source-catalog.js';

const candidates: AppSourceCatalogRecord[] = [
  source('app:block:sales:revenue', 'Revenue trend', 'certified'),
  source('app:block:sales:orders', 'Orders by region', 'draft'),
];

describe('App Builder orchestrator', () => {
  it('AGT-026 uses one bounded provider call and rejects invented source ids', async () => {
    const complete = vi.fn(async () => JSON.stringify({
      frame: { goal: 'Executive sales', metrics: ['revenue'], dimensions: ['region'], filters: ['date'] },
      requirements: [{ id: 'r1', question: 'Revenue trend', role: 'trend', required: true, measures: ['revenue'], dimensions: ['date'], filters: [] }],
      components: [
        { id: 'c1', title: 'Revenue trend', sourceId: 'app:block:sales:revenue', requirementIds: ['r1'], role: 'trend', view: 'line', rationale: 'Exact capability match' },
        { id: 'invented', title: 'Invented', sourceId: 'app:block:missing', requirementIds: ['r1'], role: 'detail', view: 'table', rationale: 'Not supplied' },
      ],
    }));

    const brief = await planAppBuildBrief({
      prompt: 'Build an executive sales App',
      candidates,
      sourcePolicy: 'include_review_required',
      complete,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(brief.planningMode).toBe('ai');
    expect(brief.components.map((component) => component.sourceId)).toEqual(['app:block:sales:revenue']);
    expect(complete.mock.calls[0]?.[0].user).not.toContain('SELECT');
  });

  it('falls back deterministically while preserving draft trust and supplied ids', async () => {
    const brief = await planAppBuildBrief({
      prompt: 'Build revenue and regional orders',
      candidates,
      sourcePolicy: 'include_review_required',
      complete: async () => 'not json',
    });
    expect(brief.planningMode).toBe('deterministic_fallback');
    expect(brief.selectedSourceIds).toEqual(candidates.map((candidate) => candidate.sourceId));

    const generic = await planAppBuildBrief({
      prompt: 'Build an analytics app from my certified DQL blocks and available warehouse tables.',
      candidates,
      sourcePolicy: 'include_review_required',
    });
    expect(generic.requirements).toHaveLength(1);
    expect(generic.selectedSourceIds).toEqual(candidates.map((candidate) => candidate.sourceId));
  });

  it('derives offline requirements from the request instead of shortlist descriptions', async () => {
    const allCandidates = [
      ...candidates,
      source('app:block:customers:growth', 'New customer growth', 'draft'),
      source('app:block:runtime:acceptance', 'Runtime parameter acceptance', 'certified'),
    ];
    const brief = await planAppBuildBrief({
      prompt: 'Build an executive sales App showing revenue trend, orders by region, and new-customer growth for the last 90 days.',
      candidates: allCandidates,
      sourcePolicy: 'include_review_required',
      complete: async () => {
        throw new Error('provider unavailable');
      },
    });

    expect(brief.planningMode).toBe('deterministic_fallback');
    expect(brief.requirements.map((requirement) => requirement.question)).toEqual([
      'Revenue trend',
      'Orders by region',
      'New-customer growth for the last 90 days',
    ]);
    expect(brief.selectedSourceIds).not.toContain('app:block:runtime:acceptance');
    expect(brief.components.flatMap((component) => component.requirementIds)).toEqual(expect.arrayContaining([
      'requirement-1', 'requirement-2', 'requirement-3',
    ]));
  });
});

function source(sourceId: string, title: string, lifecycle: 'certified' | 'draft'): AppSourceCatalogRecord {
  return {
    sourceId,
    qualifiedIdentity: `sales::block::${title}`,
    sourceRevision: `sha256:${sourceId}`,
    snapshotId: 'snapshot-1',
    kind: 'block',
    lifecycle,
    trust: lifecycle === 'certified' ? 'certified' : 'review_required',
    executable: true,
    name: title,
    title,
    domain: 'sales',
    sourcePath: `blocks/${sourceId.split(':').at(-1)}.dql`,
    executionRef: `blocks/${sourceId.split(':').at(-1)}.dql`,
    tags: [],
    capabilities: { measures: ['revenue'], dimensions: ['region'], outputs: ['revenue'], filters: ['date'], allowedVisualizations: ['line'], parameters: [] },
    eligibility: { discoverable: true, localPreview: true, projectPublish: lifecycle === 'certified', reasonCodes: [] },
    reasons: ['matched'],
  };
}
