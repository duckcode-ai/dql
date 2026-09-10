import { describe, expect, it } from 'vitest';
import { askScopeFromWorkspace, workspaceContextForScope } from './domain-context.js';

describe('the one scope selection every surface carries (CTX-001)', () => {
  it('reads the four selections out of a workspace context and ignores everything else', () => {
    expect(askScopeFromWorkspace({ domain: ' growth ', purpose: 'growth_attribution', modelAreaId: 'core', skillRefs: ['growth::skill::pipeline', ' '], surface: 'block-studio', appContext: { app: {} } }))
      .toEqual({ domain: 'growth', purpose: 'growth_attribution', modelAreaId: 'core', skillRefs: ['growth::skill::pipeline'] });
    expect(askScopeFromWorkspace({ skillRefs: 'one-skill' })).toEqual({ skillRefs: ['one-skill'] });
  });
  it('absent, empty or malformed fields are simply absent — never a default domain', () => {
    expect(askScopeFromWorkspace(undefined)).toEqual({});
    expect(askScopeFromWorkspace({ domain: '', purpose: 42, skillRefs: [1, 2] })).toEqual({});
    expect(askScopeFromWorkspace('growth')).toEqual({});
  });
  it('round-trips through the workspace context a client sends', () => {
    const scope = { domain: 'commerce', skillRefs: ['a', 'b'] };
    expect(askScopeFromWorkspace(workspaceContextForScope(scope))).toEqual(scope);
    expect(workspaceContextForScope({})).toEqual({});
  });
});
