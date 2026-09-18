import { afterEach, describe, expect, it } from 'vitest';
import { defaultPersonaRegistry } from '@duckcodeailabs/dql-project';
import { activePersonaPolicyFingerprint } from './governance-runtime.js';

const persona = (overrides: Record<string, unknown> = {}) => ({
  userId: 'ana@example.test', roles: ['analyst'], attributes: {}, rlsContext: { region: 'EU' }, appId: 'sales', ...overrides,
});

afterEach(() => defaultPersonaRegistry.set(null));

describe('active persona policy fingerprint', () => {
  it('separates personas of one App whose RLS context differs, so they never share a cached result', () => {
    defaultPersonaRegistry.set(persona() as never);
    const eu = activePersonaPolicyFingerprint();
    defaultPersonaRegistry.set(persona({ rlsContext: { region: 'US' } }) as never);
    const us = activePersonaPolicyFingerprint();
    defaultPersonaRegistry.set(persona({ userId: 'bo@example.test' }) as never);
    const otherUser = activePersonaPolicyFingerprint();
    defaultPersonaRegistry.set(persona({ roles: ['admin'] }) as never);
    const otherRole = activePersonaPolicyFingerprint();
    expect(new Set([eu, us, otherUser, otherRole]).size).toBe(4);
    expect(eu).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same persona regardless of key order and distinct from no persona', () => {
    defaultPersonaRegistry.set(persona({ rlsContext: { region: 'EU', team: 'north' }, roles: ['b', 'a'] }) as never);
    const first = activePersonaPolicyFingerprint();
    defaultPersonaRegistry.set(persona({ rlsContext: { team: 'north', region: 'EU' }, roles: ['a', 'b'] }) as never);
    expect(activePersonaPolicyFingerprint()).toBe(first);
    defaultPersonaRegistry.set(null);
    expect(activePersonaPolicyFingerprint()).not.toBe(first);
  });
});
