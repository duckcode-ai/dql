import { describe, it, expect } from 'vitest';
import { PersonaRegistry, OWNER_DEFAULT } from './persona.js';
import type { AppDocument } from '@duckcodeailabs/dql-core';

const app: AppDocument = {
  version: 1,
  id: 'growth-cxo',
  name: 'Growth',
  domain: 'growth',
  owners: ['alice@acme.com'],
  members: [
    { userId: 'alice@acme.com', roles: ['owner'], attributes: { region: 'NA' } },
    { userId: 'bob@acme.com', roles: ['viewer'], attributes: { region: 'EU' } },
  ],
  roles: [{ id: 'owner' }, { id: 'viewer' }],
  policies: [],
  rlsBindings: [{ role: 'viewer', variable: 'user.region', from: 'region' }],
};

describe('PersonaRegistry', () => {
  it('starts with no active persona; toUserContext returns owner default', () => {
    const r = new PersonaRegistry();
    expect(r.active).toBeNull();
    expect(r.toUserContext()).toEqual(OWNER_DEFAULT);
  });

  it('setFromApp resolves a viewer persona with RLS context', () => {
    const r = new PersonaRegistry();
    const persona = r.setFromApp(app, 'bob@acme.com');
    expect(persona?.userId).toBe('bob@acme.com');
    expect(persona?.roles).toEqual(['viewer']);
    expect(persona?.rlsContext).toEqual({ 'user.region': 'EU' });
    expect(r.resolveUserVar('user.region')).toBe('EU');
  });

  it('setFromApp returns null and clears state for unknown userId', () => {
    const r = new PersonaRegistry();
    r.setFromApp(app, 'bob@acme.com');
    const result = r.setFromApp(app, 'eve@acme.com');
    expect(result).toBeNull();
    expect(r.active).toBeNull();
  });

  it('clear() restores the owner-fallback context', () => {
    const r = new PersonaRegistry();
    r.setFromApp(app, 'bob@acme.com');
    r.clear();
    expect(r.active).toBeNull();
    expect(r.toUserContext()).toEqual(OWNER_DEFAULT);
  });

  it('subscribers fire on every change', () => {
    const r = new PersonaRegistry();
    const events: Array<unknown> = [];
    r.subscribe((next) => events.push(next?.userId ?? null));
    r.setFromApp(app, 'bob@acme.com');
    r.clear();
    expect(events).toEqual(['bob@acme.com', null]);
  });

  it('toUserContext exposes department from attributes when present', () => {
    const r = new PersonaRegistry();
    const withDept: AppDocument = {
      ...app,
      members: [{ userId: 'c@acme.com', roles: ['viewer'], attributes: { department: 'finance' } }],
    };
    r.setFromApp(withDept, 'c@acme.com');
    expect(r.toUserContext().department).toBe('finance');
  });
});
