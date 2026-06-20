import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, parse } from '@duckcodeailabs/dql-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upsertGeneratedDraft } from './drafts.js';

describe('generated draft blocks', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-generated-draft-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'drafts' }), 'utf-8');
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes parseable DQL with flat Tier-2 review metadata', () => {
    const draft = upsertGeneratedDraft(projectRoot, {
      slug: 'enterprise_revenue_by_week',
      question: 'Break revenue down by Enterprise week',
      proposedSql: `
        SELECT week_start, SUM(revenue) AS revenue
        FROM main.revenue_events
        WHERE segment = 'Enterprise'
        GROUP BY 1
      `,
      proposedContractId: 'finance.Revenue.enterprise_revenue_by_week',
      proposedDomain: 'finance',
      proposedEntity: 'Revenue',
      upstreamRefs: ['revenue_total'],
      sourceQuestion: 'What was revenue last week?',
      sourceBlock: 'revenue_total',
      followupKind: 'drilldown',
      requestedFilters: ['Enterprise', 'last week'],
      requestedDimensions: ['week'],
      contextPackId: 'ctx_test',
      routeIntent: 'entity_drilldown',
      validationWarnings: ['review_required'],
    });

    const source = readFileSync(join(projectRoot, draft.path), 'utf-8');

    expect(source).toContain('// Tier-2 generated proposal');
    expect(source).not.toContain('# Tier-2');
    expect(() => parse(source)).not.toThrow();

    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(manifest.diagnostics?.filter((diagnostic) => diagnostic.kind === 'parse')).toEqual([]);
    expect(manifest.blocks.enterprise_revenue_by_week?.draftMetadata).toMatchObject({
      sourceQuestion: 'What was revenue last week?',
      sourceBlock: 'revenue_total',
      followupKind: 'drilldown',
      requestedFilters: ['Enterprise', 'last week'],
      requestedDimensions: ['week'],
      contextPackId: 'ctx_test',
      routeIntent: 'entity_drilldown',
      askedTimes: 1,
      validationWarnings: ['review_required'],
    });
  });

  it('writes generated drafts under the domain-first draft folder when the domain exists', () => {
    mkdirSync(join(projectRoot, 'domains', 'finance'), { recursive: true });

    const draft = upsertGeneratedDraft(projectRoot, {
      slug: 'enterprise_revenue_by_week',
      question: 'Break revenue down by Enterprise week',
      proposedSql: 'SELECT 1 AS revenue',
      proposedContractId: 'finance.Revenue.enterprise_revenue_by_week',
      proposedDomain: 'finance',
      proposedEntity: 'Revenue',
    });

    expect(draft.path).toBe('domains/finance/blocks/_drafts/enterprise_revenue_by_week.dql');

    const source = readFileSync(join(projectRoot, draft.path), 'utf-8');
    expect(source).toContain('dql certify --from-draft domains/finance/blocks/_drafts/enterprise_revenue_by_week.dql');
    expect(() => parse(source)).not.toThrow();

    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(manifest.blocks.enterprise_revenue_by_week?.filePath).toBe(draft.path);
    expect(manifest.blocks.enterprise_revenue_by_week?.draftMetadata?.askedTimes).toBe(1);
  });
});
