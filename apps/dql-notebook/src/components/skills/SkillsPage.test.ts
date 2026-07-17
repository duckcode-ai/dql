import { describe, expect, it } from 'vitest';
import type { Skill } from '../../store/types';
import { skillMatchesModelingScope } from './modeling-scope';

function skill(id: string, domain: string | undefined, modelAreaRefs?: string[]): Skill {
  return {
    id,
    scope: 'project',
    domain,
    domains: domain ? [domain] : [],
    modelAreaRefs,
    body: id,
    preferredMetrics: [],
    preferredBlocks: [],
    vocabulary: {},
    sourcePath: `skills/${id}.skill.md`,
  };
}

describe('Area-scoped Skills', () => {
  it('keeps domain-wide Skills and the selected Area while excluding sibling Areas', () => {
    const scope = 'customers::model_area::retention';
    expect(skillMatchesModelingScope(skill('domain-wide', 'customers'), 'customers', scope)).toBe(true);
    expect(skillMatchesModelingScope(skill('retention', 'customers', ['retention']), 'customers', scope)).toBe(true);
    expect(skillMatchesModelingScope(skill('qualified', 'customers', [scope]), 'customers', scope)).toBe(true);
    expect(skillMatchesModelingScope(skill('churn', 'customers', ['churn']), 'customers', scope)).toBe(false);
    expect(skillMatchesModelingScope(skill('products', 'products', ['retention']), 'customers', scope)).toBe(false);
  });
});
