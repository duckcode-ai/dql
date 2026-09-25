import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';

/**
 * WHO IS ASKING (RFC 0010, slice HH-1). A program that embeds DQL can tell
 * the server who made each request; DQL then takes every "who did this"
 * record — a review, a correction's author, the owner of new content — from
 * that person instead of from the request body or this machine's git user.
 *
 * With no host hooks nothing here is used: `dql notebook` keeps its one
 * local owner and behaves exactly as before.
 */
export interface DqlPrincipal {
  /** Stable id from the host's identity provider. */
  id: string;
  kind: 'person' | 'service';
  displayName?: string;
  email?: string;
  groups?: string[];
  /** Values row rules can read later (RFC 0010 HH-3), e.g. region. */
  attributes?: Record<string, string | number | boolean | string[]>;
  /** 'host' when a hook supplied it; 'local' for the local owner. */
  source: 'local' | 'host';
}

export interface DqlRequestContext {
  principal: DqlPrincipal;
  requestId: string;
}

export interface DqlHostHooks {
  /**
   * Who made this request. Called for every `/api/` request except
   * `/api/health`. Return null to refuse it (401); a hook that throws is a
   * refusal too. When present it replaces the shared-token check.
   */
  resolvePrincipal?(req: IncomingMessage): Promise<DqlPrincipal | null> | DqlPrincipal | null;
  /**
   * Certify with every enterprise gate required (grain, outputs, pattern,
   * lineage, cadence). With a host, the host decides this, not the request.
   */
  enterpriseCertification?: boolean;
}

const requestContext = new AsyncLocalStorage<DqlRequestContext>();

/** Run `work` as `context`; without a context, just run it. */
export function withRequestContext<T>(context: DqlRequestContext | undefined, work: () => T): T {
  return context ? requestContext.run(context, work) : work();
}

export function currentRequestContext(): DqlRequestContext | undefined {
  return requestContext.getStore();
}

/** The host-supplied person behind the current request, if any. */
export function currentPrincipal(): DqlPrincipal | undefined {
  return requestContext.getStore()?.principal;
}

/**
 * The name recorded for the person acting now, when a host said who that
 * is: their email, else their display name, else their id. Undefined when
 * no host is in charge, so callers keep their local behaviour.
 */
export function hostActor(): string | undefined {
  const principal = currentPrincipal();
  if (!principal || principal.source !== 'host') return undefined;
  return principal.email?.trim() || principal.displayName?.trim() || principal.id;
}

/**
 * Accept only a well-formed principal from a hook. Anything else — no id,
 * an unknown kind, a thrown error — refuses the request.
 */
export function normalizeHostPrincipal(value: unknown): DqlPrincipal | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const kind = raw.kind === 'service' ? 'service' : raw.kind === undefined || raw.kind === 'person' ? 'person' : null;
  if (!kind) return null;
  const text = (field: unknown) => (typeof field === 'string' && field.trim() ? field.trim() : undefined);
  const groups = Array.isArray(raw.groups) ? raw.groups.filter((group): group is string => typeof group === 'string' && group.trim().length > 0) : undefined;
  const attributes = raw.attributes && typeof raw.attributes === 'object' && !Array.isArray(raw.attributes)
    ? raw.attributes as DqlPrincipal['attributes']
    : undefined;
  const email = text(raw.email);
  const displayName = text(raw.displayName);
  return {
    id,
    kind,
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
    ...(groups?.length ? { groups } : {}),
    ...(attributes ? { attributes } : {}),
    source: 'host',
  };
}

/** Ask the host who is asking; null when it refuses, errs or answers with something malformed. */
export async function resolveHostPrincipal(hooks: DqlHostHooks, req: IncomingMessage): Promise<DqlPrincipal | null> {
  if (!hooks.resolvePrincipal) return null;
  try {
    return normalizeHostPrincipal(await hooks.resolvePrincipal(req));
  } catch {
    return null;
  }
}
