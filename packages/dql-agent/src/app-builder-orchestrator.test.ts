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
      requiredSourceIds: [],
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
      requiredSourceIds: [],
      sourcePolicy: 'include_review_required',
      complete: async () => 'not json',
    });
    expect(brief.planningMode).toBe('deterministic_fallback');
    expect(brief.selectedSourceIds).toEqual(candidates.map((candidate) => candidate.sourceId));

    const generic = await planAppBuildBrief({
      prompt: 'Build an analytics app from my certified DQL blocks and available warehouse tables.',
      candidates,
      requiredSourceIds: [],
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
      requiredSourceIds: [],
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
    expect(brief.components.find((component) => component.sourceId === candidates[0].sourceId)?.requirementIds).toEqual(['requirement-1']);
    expect(brief.components.find((component) => component.sourceId === candidates[1].sourceId)?.requirementIds).toEqual(['requirement-2']);
    expect(brief.components.find((component) => component.sourceId === 'app:block:customers:growth')?.requirementIds).toEqual([]);
    expect(brief.warnings).toEqual(expect.arrayContaining([expect.stringContaining('unsupported requirement coverage was removed')]));
  });

  it('retains explicitly required certified and draft sources omitted by the provider', async () => {
    const requiredCandidates = [
      { ...candidates[0], capabilities: { ...candidates[0].capabilities, measures: ['margin'], outputs: ['margin'] } },
      { ...candidates[1], name: 'Revenue order detail', title: 'Revenue order detail' },
    ];
    const complete = vi.fn(async () => JSON.stringify({
      frame: { goal: 'Executive sales' },
      requirements: [{ id: 'r1', question: 'Profit margin', role: 'kpi', required: true, measures: ['margin'], dimensions: [], filters: [] }],
      components: [{ id: 'c1', title: 'Revenue trend', sourceId: candidates[0].sourceId, requirementIds: ['r1'], role: 'trend', view: 'line', rationale: 'Provider selected only certified revenue' }],
    }));

    const brief = await planAppBuildBrief({
      prompt: 'Build an executive sales App',
      candidates: requiredCandidates,
      requiredSourceIds: requiredCandidates.map((candidate) => candidate.sourceId),
      sourcePolicy: 'include_review_required',
      complete,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(brief.components.map((component) => component.sourceId)).toEqual(requiredCandidates.map((candidate) => candidate.sourceId));
    expect(brief.selectedSourceIds).toEqual(requiredCandidates.map((candidate) => candidate.sourceId));
    const appendedDraft = brief.components.find((component) => component.sourceId === requiredCandidates[1].sourceId);
    expect(appendedDraft).toMatchObject({ view: 'line', requirementIds: [] });
    expect(brief.warnings).toEqual([expect.stringContaining('declared measures, dimensions, and filters did not match')]);
  });

  it('rejects a required source that was not supplied as a candidate card', async () => {
    await expect(planAppBuildBrief({
      prompt: 'Build an executive sales App',
      candidates,
      requiredSourceIds: ['app:block:missing'],
      sourcePolicy: 'governed_only',
    })).rejects.toThrow('APP_BUILD_REQUIRED_SOURCE_MISSING');
  });

  it('does not confuse partially overlapping structured capability names', async () => {
    const capabilityCandidates = [
      { ...candidates[0], capabilities: { ...candidates[0].capabilities, measures: ['gross_margin'], outputs: ['gross_margin'] } },
      { ...candidates[1], name: 'Gross revenue detail', title: 'Gross revenue detail', capabilities: { ...candidates[1].capabilities, measures: ['gross_revenue'], outputs: ['gross_revenue'] } },
    ];
    const brief = await planAppBuildBrief({
      prompt: 'Compare gross margin and supporting revenue detail',
      candidates: capabilityCandidates,
      requiredSourceIds: [capabilityCandidates[1].sourceId],
      sourcePolicy: 'include_review_required',
      complete: async () => JSON.stringify({
        frame: { goal: 'Compare gross margin' },
        requirements: [{ id: 'gross-margin', question: 'Gross margin', role: 'kpi', required: true, measures: ['gross_margin'], dimensions: [], filters: [] }],
        components: [{ id: 'margin', title: 'Gross margin', sourceId: capabilityCandidates[0].sourceId, requirementIds: ['gross-margin'], role: 'kpi', view: 'kpi', rationale: 'Exact gross margin capability' }],
      }),
    });

    expect(brief.components.find((component) => component.sourceId === capabilityCandidates[1].sourceId)?.requirementIds).toEqual([]);
    expect(brief.warnings).toEqual([expect.stringContaining('declared measures, dimensions, and filters did not match')]);
  });

  it('rejects provider capability fields that contradict the visible requirement question', async () => {
    const revenueCandidate = {
      ...candidates[0],
      capabilities: { ...candidates[0].capabilities, measures: ['revenue'], outputs: ['revenue'] },
    };
    const brief = await planAppBuildBrief({
      prompt: 'Profit margin',
      candidates: [revenueCandidate],
      requiredSourceIds: [],
      sourcePolicy: 'governed_only',
      complete: async () => JSON.stringify({
        frame: { goal: 'Profit margin' },
        requirements: [{ id: 'profit-margin', question: 'Profit margin', role: 'kpi', required: true, measures: ['revenue'], dimensions: [], filters: [] }],
        components: [{ id: 'revenue', title: 'Revenue trend', sourceId: revenueCandidate.sourceId, requirementIds: ['profit-margin'], role: 'kpi', view: 'kpi', rationale: 'Provider claimed revenue covers profit margin' }],
      }),
    });

    expect(brief.components).toEqual([expect.objectContaining({ sourceId: revenueCandidate.sourceId, requirementIds: [] })]);
    expect(brief.warnings).toEqual([expect.stringContaining('unsupported requirement coverage was removed')]);
  });

  it('keeps an explicitly required deterministic source without claiming unsupported coverage', async () => {
    const revenueOrders = { ...candidates[1], name: 'Revenue orders', title: 'Revenue orders' };
    const brief = await planAppBuildBrief({
      prompt: 'Profit margin',
      candidates: [revenueOrders],
      requiredSourceIds: [revenueOrders.sourceId],
      sourcePolicy: 'include_review_required',
    });

    expect(brief.planningMode).toBe('deterministic_fallback');
    expect(brief.selectedSourceIds).toEqual([revenueOrders.sourceId]);
    expect(brief.components).toEqual([expect.objectContaining({ sourceId: revenueOrders.sourceId, requirementIds: [] })]);
    expect(brief.warnings).toEqual([expect.stringContaining('unsupported requirement coverage was removed')]);
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
