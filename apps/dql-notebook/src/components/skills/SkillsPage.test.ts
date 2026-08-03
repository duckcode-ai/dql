import { describe, expect, it } from 'vitest';
import type { Skill } from '../../store/types';
import { skillMatchesModelingScope, skillMatchesSourcePaths } from './modeling-scope';

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

  it('keeps the Domain workspace count and visible files on the same authored path contract', () => {
    const core = { ...skill('revenue-definition', 'core'), sourcePath: '/repo/domains/core/skills/revenue-definition.skill.md' };
    const global = skill('sql-conventions', undefined);
    const allowed = ['domains/core/skills/revenue-definition.skill.md'];
    expect(skillMatchesSourcePaths(core, allowed)).toBe(true);
    expect(skillMatchesSourcePaths(global, allowed)).toBe(false);
    expect(skillMatchesSourcePaths(global, undefined)).toBe(true);
  });
});
