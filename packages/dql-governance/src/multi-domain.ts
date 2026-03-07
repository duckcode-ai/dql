/**
 * Multi-Domain Git Governance — matches architecture spec §8.
 * Supports single-repo, multi-repo, and hybrid models.
 */

export type GovernanceModel = 'single-repo' | 'multi-repo' | 'hybrid';

export interface DomainConfig {
  name: string;
  repo: string;
  path: string;
  owner: string;
  approvalRules: ApprovalRules;
  costThreshold?: number;
  tags?: string[];
}

export interface ApprovalRules {
  minReviewers: number;
  autoCertifyOnMerge: boolean;
  requirePassingTests: boolean;
  requiredReviewers?: string[];
}

export interface PlatformConfig {
  model: GovernanceModel;
  coreRepo?: string;
  domains: DomainConfig[];
  globalRules: ApprovalRules;
  syncSchedule?: string;
}

export interface DomainSyncResult {
  domain: string;
  repo: string;
  blocksFound: number;
  blocksCreated: number;
  blocksUpdated: number;
  blocksUnchanged: number;
  errors: string[];
}

/**
 * MultiDomainGovernance manages governance across multiple repos/domains.
 */
export class MultiDomainGovernance {
  private config: PlatformConfig;

  constructor(config: PlatformConfig) {
    this.config = config;
  }

  getModel(): GovernanceModel {
    return this.config.model;
  }

  getDomains(): DomainConfig[] {
    return [...this.config.domains];
  }

  getDomain(name: string): DomainConfig | undefined {
    return this.config.domains.find((d) => d.name === name);
  }

  addDomain(domain: DomainConfig): void {
    const existing = this.config.domains.findIndex((d) => d.name === domain.name);
    if (existing >= 0) {
      this.config.domains[existing] = domain;
    } else {
      this.config.domains.push(domain);
    }
  }

  removeDomain(name: string): void {
    this.config.domains = this.config.domains.filter((d) => d.name !== name);
  }

  /**
   * Get the effective approval rules for a domain.
   * Domain rules override global rules where specified.
   */
  getEffectiveRules(domainName: string): ApprovalRules {
    const domain = this.getDomain(domainName);
    if (!domain) return { ...this.config.globalRules };

    return {
      minReviewers: Math.max(domain.approvalRules.minReviewers, this.config.globalRules.minReviewers),
      autoCertifyOnMerge: domain.approvalRules.autoCertifyOnMerge && this.config.globalRules.autoCertifyOnMerge,
      requirePassingTests: domain.approvalRules.requirePassingTests || this.config.globalRules.requirePassingTests,
      requiredReviewers: [
        ...(this.config.globalRules.requiredReviewers ?? []),
        ...(domain.approvalRules.requiredReviewers ?? []),
      ],
    };
  }

  /**
   * Validate that a block meets the governance requirements for its domain.
   */
  validateBlock(blockDomain: string, block: {
    hasTests: boolean;
    reviewerCount: number;
    reviewers: string[];
    testsPassing: boolean;
  }): { valid: boolean; violations: string[] } {
    const rules = this.getEffectiveRules(blockDomain);
    const violations: string[] = [];

    if (rules.requirePassingTests && !block.testsPassing) {
      violations.push('Block tests must pass before certification');
    }

    if (!block.hasTests && rules.requirePassingTests) {
      violations.push('Block must have at least one test');
    }

    if (block.reviewerCount < rules.minReviewers) {
      violations.push(`Requires ${rules.minReviewers} reviewer(s), got ${block.reviewerCount}`);
    }

    if (rules.requiredReviewers && rules.requiredReviewers.length > 0) {
      const missing = rules.requiredReviewers.filter((r) => !block.reviewers.includes(r));
      if (missing.length > 0) {
        violations.push(`Missing required reviewer(s): ${missing.join(', ')}`);
      }
    }

    return { valid: violations.length === 0, violations };
  }

  /**
   * Generate a sync plan for all domains.
   */
  getSyncPlan(): Array<{ domain: string; repo: string; path: string }> {
    return this.config.domains.map((d) => ({
      domain: d.name,
      repo: d.repo,
      path: d.path,
    }));
  }
}
