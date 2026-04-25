import { describe, it, expect } from 'vitest';
import { personaVariables, mergePersonaVariables } from './persona-variables.js';
import type { ActivePersona } from './persona.js';

const personaA: ActivePersona = {
  userId: 'alice@acme.com',
  roles: ['analyst'],
  attributes: { region: 'NA' },
  rlsContext: { 'user.region': 'NA' },
  appId: 'growth-cxo',
};

describe('personaVariables', () => {
  it('returns empty for null persona', () => {
    expect(personaVariables(null)).toEqual({});
  });

  it('exposes user.<var> keys plus convenience bare aliases', () => {
    const vars = personaVariables(personaA);
    expect(vars['user.region']).toBe('NA');
    expect(vars['region']).toBe('NA');
    expect(vars['user.id']).toBe('alice@acme.com');
    expect(vars['user.userId']).toBe('alice@acme.com');
    expect(vars['user.roles']).toEqual(['analyst']);
  });
});

describe('mergePersonaVariables', () => {
  it('persona keys override base keys (no self-override of RLS)', () => {
    const merged = mergePersonaVariables({ 'user.region': 'EU', extra: 1 }, personaA);
    expect(merged['user.region']).toBe('NA');
    expect(merged.extra).toBe(1);
  });
});
