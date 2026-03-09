import type { BlockRecord, TestResultSummary } from '@dql/project';

/**
 * Certification rule that a block must pass to be certified.
 */
export interface CertificationRule {
  id: string;
  name: string;
  description: string;
  severity: 'error' | 'warning';
  check: (block: BlockRecord, testResults?: TestResultSummary) => CertificationCheckResult;
}

export interface CertificationCheckResult {
  passed: boolean;
  message?: string;
}

export interface CertificationResult {
  blockId: string;
  blockName: string;
  certified: boolean;
  errors: Array<{ rule: string; message: string }>;
  warnings: Array<{ rule: string; message: string }>;
  checkedAt: Date;
}

/**
 * Built-in certification rules.
 */
export const BUILTIN_RULES: CertificationRule[] = [
  {
    id: 'has-description',
    name: 'Block has description',
    description: 'Every block must have a non-empty description',
    severity: 'error',
    check: (block) => ({
      passed: !!block.description && block.description.trim().length > 0,
      message: block.description ? undefined : 'Missing description',
    }),
  },
  {
    id: 'has-owner',
    name: 'Block has owner',
    description: 'Every block must have an assigned owner',
    severity: 'error',
    check: (block) => ({
      passed: !!block.owner && block.owner.trim().length > 0,
      message: block.owner ? undefined : 'Missing owner',
    }),
  },
  {
    id: 'has-domain',
    name: 'Block has domain',
    description: 'Every block must belong to a domain',
    severity: 'error',
    check: (block) => ({
      passed: !!block.domain && block.domain.trim().length > 0,
      message: block.domain ? undefined : 'Missing domain',
    }),
  },
  {
    id: 'has-tags',
    name: 'Block has tags',
    description: 'Blocks should have at least one tag for discoverability',
    severity: 'warning',
    check: (block) => ({
      passed: block.tags.length > 0,
      message: block.tags.length > 0 ? undefined : 'No tags specified',
    }),
  },
  {
    id: 'tests-pass',
    name: 'All tests pass',
    description: 'Block tests must all pass for certification',
    severity: 'error',
    check: (_block, testResults) => {
      if (!testResults) {
        return { passed: false, message: 'No test results available' };
      }
      if (testResults.failed > 0) {
        return {
          passed: false,
          message: `${testResults.failed} test(s) failed`,
        };
      }
      return { passed: true };
    },
  },
  {
    id: 'has-tests',
    name: 'Block has tests',
    description: 'Blocks should have at least one test assertion',
    severity: 'warning',
    check: (_block, testResults) => {
      if (!testResults || testResults.assertions.length === 0) {
        return { passed: false, message: 'No test assertions defined' };
      }
      return { passed: true };
    },
  },
  {
    id: 'cost-reasonable',
    name: 'Query cost is reasonable',
    description: 'Estimated query cost should be below threshold',
    severity: 'warning',
    check: (block) => {
      if (block.costEstimate == null) return { passed: true };
      if (block.costEstimate > 100) {
        return {
          passed: false,
          message: `Cost estimate ${block.costEstimate} exceeds threshold of 100`,
        };
      }
      return { passed: true };
    },
  },
];

export const PROMOTABLE_RULES: CertificationRule[] = [
  ...BUILTIN_RULES,
  {
    id: 'canonical-git-path',
    name: 'Block is in a canonical Git path',
    description: 'Promotable blocks must not live under draft-only paths',
    severity: 'error',
    check: (block) => ({
      passed: !!block.gitPath && !block.gitPath.includes('/_drafts/') && !block.gitPath.startsWith('blocks/_drafts/'),
      message: block.gitPath ? 'Block is still stored in a draft-only path' : 'Missing Git path',
    }),
  },
  {
    id: 'stable-version',
    name: 'Block has a stable version',
    description: 'Promotable blocks must have a semantic version',
    severity: 'error',
    check: (block) => ({
      passed: /^\d+\.\d+\.\d+$/.test(block.version),
      message: `Version "${block.version}" is not a stable semantic version`,
    }),
  },
];

/**
 * Certifier evaluates blocks against certification rules.
 */
export class Certifier {
  private rules: CertificationRule[];

  constructor(rules?: CertificationRule[]) {
    this.rules = rules ?? BUILTIN_RULES;
  }

  /**
   * Add a custom rule.
   */
  addRule(rule: CertificationRule): void {
    this.rules.push(rule);
  }

  /**
   * Evaluate a block against all rules.
   */
  evaluate(
    block: BlockRecord,
    testResults?: TestResultSummary,
  ): CertificationResult {
    const errors: Array<{ rule: string; message: string }> = [];
    const warnings: Array<{ rule: string; message: string }> = [];

    for (const rule of this.rules) {
      const result = rule.check(block, testResults);
      if (!result.passed) {
        const entry = { rule: rule.name, message: result.message ?? rule.description };
        if (rule.severity === 'error') {
          errors.push(entry);
        } else {
          warnings.push(entry);
        }
      }
    }

    return {
      blockId: block.id,
      blockName: block.name,
      certified: errors.length === 0,
      errors,
      warnings,
      checkedAt: new Date(),
    };
  }
}
