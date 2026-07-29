import { describe, expect, it } from 'vitest';
import type { Domain } from '../../store/types';
import { blockGitPath } from './artifact-location';

describe('block Git path preview', () => {
  const domains: Domain[] = [
    {
      id: 'commerce.customer',
      name: 'Customer',
      parent: 'commerce',
      sourcePath: 'domains/commerce/customer/domain.dql',
    },
  ];

  it('previews a nested Domain Package path from its authoritative declaration', () => {
    expect(blockGitPath(domains, 'commerce.customer', 'reporting/monthly', 'customer-health')).toBe(
      'domains/commerce/customer/blocks/reporting/monthly/customer-health.dql',
    );
  });

  it('keeps global blocks under the compatible project root', () => {
    expect(blockGitPath(domains, '', 'shared', 'date-range')).toBe('blocks/shared/date-range.dql');
  });
});
