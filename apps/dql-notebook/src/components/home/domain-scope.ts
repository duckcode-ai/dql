export type DomainScope = { domain: string; purpose?: string; modelAreaId?: string };

/** Survives reloads, so scoping is a mode you stay in rather than a one-shot. */
export const DOMAIN_SCOPE_KEY = 'dql-ask-domain-scope';
/** One-shot handoff written by the Domain workspace "Ask" button. */
export const DOMAIN_HANDOFF_KEY = 'dql-ask-domain-context';

/** The slice of Storage these helpers need, so they are testable without a DOM. */
export interface ScopeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function parseDomainScope(raw: string | null): DomainScope | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.domain !== 'string' || !parsed.domain.trim()) return undefined;
    return {
      domain: parsed.domain.trim(),
      purpose: typeof parsed.purpose === 'string' ? parsed.purpose : undefined,
      modelAreaId: typeof parsed.modelAreaId === 'string' ? parsed.modelAreaId : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Resolve the active domain scope.
 *
 * The scope used to live in sessionStorage, read once and immediately deleted,
 * so a reload or entering Ask from anywhere else dropped it silently — which
 * meant almost nobody stayed scoped long enough for domain context to matter.
 * A fresh handoff still wins (the user just picked a domain), but the choice now
 * persists until explicitly cleared.
 */
export function resolveDomainScope(session: ScopeStorage, local: ScopeStorage): DomainScope | undefined {
  try {
    const handoff = parseDomainScope(session.getItem(DOMAIN_HANDOFF_KEY));
    session.removeItem(DOMAIN_HANDOFF_KEY);
    if (handoff) {
      local.setItem(DOMAIN_SCOPE_KEY, JSON.stringify(handoff));
      return handoff;
    }
    return parseDomainScope(local.getItem(DOMAIN_SCOPE_KEY));
  } catch {
    return undefined;
  }
}

export function writeDomainScope(local: ScopeStorage, scope: DomainScope | undefined): void {
  try {
    if (scope) local.setItem(DOMAIN_SCOPE_KEY, JSON.stringify(scope));
    else local.removeItem(DOMAIN_SCOPE_KEY);
  } catch {
    // A blocked or full storage must never break asking a question.
  }
}

export function initialDomainScope(): DomainScope | undefined {
  if (typeof window === 'undefined') return undefined;
  return resolveDomainScope(window.sessionStorage, window.localStorage);
}

export function persistDomainScope(scope: DomainScope | undefined): void {
  if (typeof window === 'undefined') return;
  writeDomainScope(window.localStorage, scope);
}
