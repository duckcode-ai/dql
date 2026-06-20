import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listProposals } from '../list-proposals.js';
import { makeCtx } from './_helpers.js';

function writeDraft(
  root: string,
  slug: string,
  fields: {
    question: string;
    askedTimes?: number;
    lastAsked?: string;
    domain?: string;
    entity?: string;
  },
) {
  writeDraftAt(root, join(root, 'blocks', '_drafts'), slug, fields);
}

function writeDomainDraft(
  root: string,
  domain: string,
  slug: string,
  fields: {
    question: string;
    askedTimes?: number;
    lastAsked?: string;
    entity?: string;
  },
) {
  writeDraftAt(root, join(root, 'domains', domain, 'blocks', '_drafts'), slug, { ...fields, domain });
}

function writeDraftAt(
  root: string,
  draftDir: string,
  slug: string,
  fields: {
    question: string;
    askedTimes?: number;
    lastAsked?: string;
    domain?: string;
    entity?: string;
  },
) {
  mkdirSync(draftDir, { recursive: true });
  const askedTimes = fields.askedTimes ?? 1;
  const lastAsked = fields.lastAsked ?? '2026-05-01T12:00:00Z';
  const domain = fields.domain ?? 'misc';
  const entity = fields.entity ?? 'Unknown';
  const proposedId = `${domain}.${entity}.${slug}`;
  writeFileSync(
    join(draftDir, `${slug}.dql`),
    `block "${slug}" {
    domain = "${domain}"
    type = "custom"
    status = "draft"
    description = """${fields.question}"""
    datalex_contract = ""

    _proposed {
        asked_times = ${askedTimes}
        first_asked = "2026-04-01T00:00:00Z"
        last_asked = "${lastAsked}"
        proposed_contract_id = "${proposedId}"
        proposed_domain = "${domain}"
        proposed_entity = "${entity}"
        upstream_refs = ["fct_orders", "dim_customers"]
    }

    query = """SELECT 1"""
}
`,
  );
}

describe('listProposals', () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = mkdtempSync(join(tmpdir(), 'dql-list-'));
  });
  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('returns an empty list when blocks/_drafts/ does not exist', () => {
    const out = listProposals(makeCtx({}, { projectRoot: tmpProject } as never));
    expect(out.proposals).toEqual([]);
  });

  it('parses proposal fields out of the _proposed block', () => {
    writeDraft(tmpProject, 'monthly_active_customers', {
      question: 'How many active customers each month?',
      askedTimes: 4,
      domain: 'customer',
      entity: 'Customer',
    });
    const out = listProposals(makeCtx({}, { projectRoot: tmpProject } as never));
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0]).toMatchObject({
      slug: 'monthly_active_customers',
      askedTimes: 4,
      proposedDomain: 'customer',
      proposedEntity: 'Customer',
      proposedContractId: 'customer.Customer.monthly_active_customers',
      upstreamRefs: ['fct_orders', 'dim_customers'],
    });
    expect(out.proposals[0].certifyHint).toContain('dql certify --from-draft');
    expect(out.proposals[0].certifyHint).toContain('--domain customer');
  });

  it('includes domain-first draft proposals in the review queue', () => {
    writeDomainDraft(tmpProject, 'finance', 'enterprise_revenue_by_week', {
      question: 'Break enterprise revenue by week',
      askedTimes: 6,
      entity: 'Revenue',
    });

    const out = listProposals(makeCtx({}, { projectRoot: tmpProject } as never));

    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0]).toMatchObject({
      draftPath: 'domains/finance/blocks/_drafts/enterprise_revenue_by_week.dql',
      slug: 'enterprise_revenue_by_week',
      askedTimes: 6,
      proposedDomain: 'finance',
      proposedEntity: 'Revenue',
    });
    expect(out.proposals[0].certifyHint).toContain('dql certify --from-draft domains/finance/blocks/_drafts/enterprise_revenue_by_week.dql');
  });

  it('ranks by askedTimes DESC, then lastAsked DESC', () => {
    writeDraft(tmpProject, 'high', { question: 'frequent', askedTimes: 9, lastAsked: '2026-04-30T00:00:00Z' });
    writeDraft(tmpProject, 'low_recent', { question: 'rare but recent', askedTimes: 1, lastAsked: '2026-05-01T18:00:00Z' });
    writeDraft(tmpProject, 'medium', { question: 'middle', askedTimes: 3, lastAsked: '2026-04-15T00:00:00Z' });

    const out = listProposals(makeCtx({}, { projectRoot: tmpProject } as never));
    expect(out.proposals.map((p) => p.slug)).toEqual(['high', 'medium', 'low_recent']);
  });

  it('honors askedAtLeastTimes filter', () => {
    writeDraft(tmpProject, 'a', { question: 'a', askedTimes: 1 });
    writeDraft(tmpProject, 'b', { question: 'b', askedTimes: 5 });
    writeDraft(tmpProject, 'c', { question: 'c', askedTimes: 3 });

    const out = listProposals(makeCtx({}, { projectRoot: tmpProject } as never), {
      askedAtLeastTimes: 3,
    });
    expect(out.proposals.map((p) => p.slug).sort()).toEqual(['b', 'c']);
  });

  it('honors since filter (drops drafts whose lastAsked is older)', () => {
    writeDraft(tmpProject, 'old', { question: 'old', lastAsked: '2026-04-01T00:00:00Z' });
    writeDraft(tmpProject, 'new', { question: 'new', lastAsked: '2026-05-01T18:00:00Z' });

    const out = listProposals(makeCtx({}, { projectRoot: tmpProject } as never), {
      since: '2026-05-01T00:00:00Z',
    });
    expect(out.proposals.map((p) => p.slug)).toEqual(['new']);
  });
});
