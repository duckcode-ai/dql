import { describe, expect, it } from 'vitest';
import { authoredDomainIds, authoredDomainOptions, authoredDomainOptionsWithCurrent, resolveAuthoredDomainId } from './authored-domain-options';

describe('authored domain options', () => {
  const domains = [
    { id: 'commerce.customer', name: 'Customer', parent: 'commerce' },
    { id: 'growth', name: 'Growth' },
    { id: 'commerce', name: 'Commerce' },
    { id: 'growth', name: 'Duplicate ignored' },
  ];

  it('normalizes declarations into a stable parent-aware menu', () => {
    expect(authoredDomainOptions(domains)).toEqual([
      { value: 'commerce', label: 'Commerce' },
      { value: 'commerce.customer', label: 'Commerce / Customer' },
      { value: 'growth', label: 'Growth' },
    ]);
  });

  it('never promotes semantic folders into the authored inventory', () => {
    expect(authoredDomainIds(domains)).toEqual(new Set(['commerce', 'commerce.customer', 'growth']));
    expect(authoredDomainOptionsWithCurrent('metrics', domains)[0]).toEqual({
      value: 'metrics',
      label: 'metrics (missing Domain page)',
      disabled: true,
    });
    expect(resolveAuthoredDomainId('Growth', domains)).toBe('growth');
    expect(resolveAuthoredDomainId('metrics', domains)).toBe('');
  });
});
