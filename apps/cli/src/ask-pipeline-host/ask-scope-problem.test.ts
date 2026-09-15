import { describe, expect, it } from 'vitest';
import { askScopeProblem } from './host.js';

const manifest = {
  modeling: {
    packages: { commerce: { id: 'commerce', filePath: 'domains/commerce/domain.dql', exports: [] } },
    areas: {}, entities: {}, relationships: {}, concepts: {},
    interfaces: { exports: {}, imports: {} },
  },
} as never;

describe('a saved Ask scope that no longer exists', () => {
  it('stops with a plain message instead of answering unscoped', () => {
    expect(askScopeProblem(manifest, { domain: 'finance' })).toBe('Ask is scoped to the domain "finance", which no longer exists. Clear the scope or pick another domain, then ask again.');
    expect(askScopeProblem(manifest, { domain: 'commerce', modelAreaId: 'commerce::model_area::gone' })).toMatch(/subject area that no longer exists in commerce/);
  });

  it('lets an empty or existing scope through', () => {
    expect(askScopeProblem(manifest, undefined)).toBeUndefined();
    expect(askScopeProblem(manifest, {})).toBeUndefined();
    expect(askScopeProblem(manifest, { domain: 'commerce' })).toBeUndefined();
    // No compiled manifest: nothing to check against, so nothing is refused.
    expect(askScopeProblem(undefined, { domain: 'finance' })).toBeUndefined();
  });
});
