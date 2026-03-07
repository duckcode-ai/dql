import { describe, it, expect } from 'vitest';
import { MultiDomainGovernance } from './multi-domain.js';
import type { PlatformConfig } from './multi-domain.js';

const config: PlatformConfig = {
  model: 'multi-repo',
  domains: [
    {
      name: 'revenue',
      repo: 'github.com/acme/dql-revenue',
      path: 'blocks/',
      owner: 'kranthi',
      approvalRules: { minReviewers: 1, autoCertifyOnMerge: true, requirePassingTests: true },
    },
    {
      name: 'retention',
      repo: 'github.com/acme/dql-retention',
      path: 'blocks/',
      owner: 'sarah',
      approvalRules: { minReviewers: 2, autoCertifyOnMerge: true, requirePassingTests: true, requiredReviewers: ['sarah'] },
    },
  ],
  globalRules: { minReviewers: 1, autoCertifyOnMerge: true, requirePassingTests: true },
};

describe('MultiDomainGovernance', () => {
  it('returns the governance model', () => {
    const gov = new MultiDomainGovernance(config);
    expect(gov.getModel()).toBe('multi-repo');
  });

  it('lists all domains', () => {
    const gov = new MultiDomainGovernance(config);
    expect(gov.getDomains()).toHaveLength(2);
  });

  it('gets a specific domain', () => {
    const gov = new MultiDomainGovernance(config);
    const domain = gov.getDomain('revenue');
    expect(domain).toBeDefined();
    expect(domain!.owner).toBe('kranthi');
  });

  it('computes effective rules (domain overrides global)', () => {
    const gov = new MultiDomainGovernance(config);
    const rules = gov.getEffectiveRules('retention');
    expect(rules.minReviewers).toBe(2);
    expect(rules.requiredReviewers).toContain('sarah');
  });

  it('falls back to global rules for unknown domain', () => {
    const gov = new MultiDomainGovernance(config);
    const rules = gov.getEffectiveRules('unknown');
    expect(rules.minReviewers).toBe(1);
  });

  it('validates a block that meets requirements', () => {
    const gov = new MultiDomainGovernance(config);
    const result = gov.validateBlock('revenue', {
      hasTests: true, reviewerCount: 1, reviewers: [], testsPassing: true,
    });
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('rejects a block with insufficient reviewers', () => {
    const gov = new MultiDomainGovernance(config);
    const result = gov.validateBlock('retention', {
      hasTests: true, reviewerCount: 1, reviewers: ['kranthi'], testsPassing: true,
    });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes('reviewer'))).toBe(true);
  });

  it('rejects a block with failing tests', () => {
    const gov = new MultiDomainGovernance(config);
    const result = gov.validateBlock('revenue', {
      hasTests: true, reviewerCount: 1, reviewers: [], testsPassing: false,
    });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes('tests must pass'))).toBe(true);
  });

  it('generates a sync plan', () => {
    const gov = new MultiDomainGovernance(config);
    const plan = gov.getSyncPlan();
    expect(plan).toHaveLength(2);
    expect(plan[0].domain).toBe('revenue');
    expect(plan[1].repo).toContain('retention');
  });

  it('adds and removes domains', () => {
    const gov = new MultiDomainGovernance(config);
    gov.addDomain({
      name: 'sales', repo: 'github.com/acme/sales', path: 'blocks/', owner: 'mike',
      approvalRules: { minReviewers: 1, autoCertifyOnMerge: true, requirePassingTests: true },
    });
    expect(gov.getDomains()).toHaveLength(3);
    gov.removeDomain('sales');
    expect(gov.getDomains()).toHaveLength(2);
  });
});
