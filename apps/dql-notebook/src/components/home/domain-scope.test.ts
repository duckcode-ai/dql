import { describe, expect, it } from 'vitest';
import {
  DOMAIN_HANDOFF_KEY,
  DOMAIN_SCOPE_KEY,
  resolveDomainScope,
  writeDomainScope,
  type ScopeStorage,
} from './domain-scope';

function storage(seed: Record<string, string> = {}): ScopeStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

describe('Ask domain scope', () => {
  it('survives a reload instead of being consumed once', () => {
    // The Domain workspace hands the scope over via sessionStorage. That key was
    // read and deleted with nothing persisted, so a reload, a new tab, or
    // entering Ask from anywhere else silently dropped the scope — which is why
    // almost nobody stayed scoped long enough for domain context to matter.
    const session = storage({ [DOMAIN_HANDOFF_KEY]: JSON.stringify({ domain: 'growth', modelAreaId: 'growth::model_area::acquisition' }) });
    const local = storage();

    expect(resolveDomainScope(session, local)).toEqual({
      domain: 'growth', purpose: undefined, modelAreaId: 'growth::model_area::acquisition',
    });
    // The handoff itself is still one-shot...
    expect(session.getItem(DOMAIN_HANDOFF_KEY)).toBeNull();
    // ...but the choice outlives it.
    expect(resolveDomainScope(session, local)).toMatchObject({ domain: 'growth' });
    expect(resolveDomainScope(session, local)).toMatchObject({ domain: 'growth' });
  });

  it('clears only when explicitly cleared', () => {
    const local = storage();
    writeDomainScope(local, { domain: 'growth' });
    expect(resolveDomainScope(storage(), local)).toMatchObject({ domain: 'growth' });
    writeDomainScope(local, undefined);
    expect(resolveDomainScope(storage(), local)).toBeUndefined();
    expect(local.getItem(DOMAIN_SCOPE_KEY)).toBeNull();
  });

  it('lets a fresh handoff win over the remembered scope', () => {
    const local = storage({ [DOMAIN_SCOPE_KEY]: JSON.stringify({ domain: 'commerce' }) });
    const session = storage({ [DOMAIN_HANDOFF_KEY]: JSON.stringify({ domain: 'growth' }) });
    // The user just picked a domain; that beats whatever was remembered.
    expect(resolveDomainScope(session, local)).toMatchObject({ domain: 'growth' });
    expect(resolveDomainScope(session, local)).toMatchObject({ domain: 'growth' });
  });

  it('ignores corrupt or blank stored values rather than throwing', () => {
    expect(resolveDomainScope(storage(), storage({ [DOMAIN_SCOPE_KEY]: 'not json' }))).toBeUndefined();
    expect(resolveDomainScope(storage(), storage({ [DOMAIN_SCOPE_KEY]: JSON.stringify({ domain: '   ' }) }))).toBeUndefined();
  });

  it('never lets a blocked storage break asking a question', () => {
    const blocked: ScopeStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(resolveDomainScope(blocked, blocked)).toBeUndefined();
    expect(() => writeDomainScope(blocked, { domain: 'growth' })).not.toThrow();
  });
});
