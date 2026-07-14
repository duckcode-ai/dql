import { describe, expect, it } from 'vitest';
import { blockDomainOptions } from './domain-options';

describe('blockDomainOptions', () => {
  it('keeps the active domain first and removes duplicate menu entries', () => {
    expect(blockDomainOptions('commerce', ['revenue', 'commerce', 'revenue', 'growth'])).toEqual([
      'commerce',
      'growth',
      'revenue',
    ]);
  });

  it('provides a stable alphabetical menu when no domain is selected', () => {
    expect(blockDomainOptions('', ['revenue', 'commerce', 'growth'])).toEqual([
      'commerce',
      'growth',
      'revenue',
    ]);
  });
});
