import { describe, expect, it } from 'vitest';
import {
  buildDomainSkillBootstrapPrompt,
  draftDomainSkillBootstrap,
  mergeDomainSkillBootstrapEnrichment,
} from './bootstrap.js';

describe('draftDomainSkillBootstrap', () => {
  it('creates reviewable domain and draft-skill candidates without writing files', () => {
    const candidates = draftDomainSkillBootstrap({
      version: '1', generatedAt: '', project: 'test', blocks: {
        revenue_by_month: { name: 'revenue_by_month', filePath: 'blocks/revenue.dql', domain: 'Revenue', status: 'certified' },
      }, metrics: {
        revenue: { name: 'revenue', domain: 'Revenue', filePath: 'semantic/revenue.yml' },
      }, terms: {}, domains: {},
    } as any);
    expect(candidates.find((candidate) => candidate.id === 'domain:revenue')).toMatchObject({ kind: 'domain', action: 'create' });
    expect(candidates.find((candidate) => candidate.id === 'skill:domain-revenue')).toMatchObject({ kind: 'skill', action: 'create', skill: { status: 'draft' } });
  });

  it('grounds AI enrichment to the provided candidates and rejects invented terms', () => {
    const manifest = {
      version: '1', generatedAt: '', project: 'test', blocks: {}, metrics: {}, terms: {}, domains: {
        Revenue: { name: 'Revenue', filePath: 'domains/revenue/domain.dql', primaryTerms: ['Net revenue'] },
      },
    } as any;
    const candidates = draftDomainSkillBootstrap(manifest);
    const prompt = buildDomainSkillBootstrapPrompt(manifest, candidates);
    expect(prompt.system).toContain('Never invent or rename domains, metrics, dimensions, blocks, models, joins, filters, owners, or source systems.');
    const enriched = mergeDomainSkillBootstrapEnrichment(candidates, JSON.stringify({
      drafts: [
        { id: 'domain:revenue', description: 'Revenue reporting for finance leaders.', primaryTerms: ['Net revenue', 'Imaginary KPI'] },
        { id: 'domain:invented', description: 'Must not be applied.' },
      ],
    }));
    const revenue = enriched.candidates.find((candidate) => candidate.id === 'domain:revenue');
    expect(revenue?.domain?.description).toBe('Revenue reporting for finance leaders.');
    expect(revenue?.domain?.primaryTerms).toEqual(['Net revenue']);
    expect(enriched.rejected.join(' ')).toContain('unknown candidate');
    expect(enriched.rejected.join(' ')).toContain('ungrounded primary terms');
  });
});
