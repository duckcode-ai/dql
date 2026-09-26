import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import type { DqlAction, DqlResource, DqlRouteAction } from './route-actions.js';
import type { DqlCredentialsHook, DqlRowPolicy } from './row-policy.js';

export type { DqlAction, DqlResource, DqlRouteAction } from './route-actions.js';

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
  /**
   * 'host' when a hook supplied it; 'link' for a read-only page link, which
   * sees its one App as the owner publishes it; 'local' for the local owner.
   */
  source: 'local' | 'host' | 'link';
}

export interface DqlRequestContext {
  principal: DqlPrincipal;
  requestId: string;
}

/** A host's answer to "may this person do this?". */
export interface DqlDecision {
  allow: boolean;
  /** Shown to the person when refused. */
  reason?: string;
}

export interface DqlHostHooks {
  /**
   * Who made this request. Called for every `/api/` request except
   * `/api/health`. Return null to refuse it (401); a hook that throws is a
   * refusal too. When present it replaces the shared-token check.
   */
  resolvePrincipal?(req: IncomingMessage): Promise<DqlPrincipal | null> | DqlPrincipal | null;
  /**
   * May this person do this? Called for every `/api/` request the host
   * placed, with the route's action and resource (RFC 0010 HH-2). A refusal
   * or a hook that throws answers 403. Without it, every placed person may
   * do everything, as with the shared token.
   */
  authorize?(principal: DqlPrincipal, action: DqlAction, resource: DqlResource): Promise<DqlDecision> | DqlDecision;
  /**
   * What each statement may read (RFC 0010 HH-3). Every query the server
   * sends to a warehouse — Datasets, page tiles, AI-written SQL, notebook
   * cells, proofs — passes here first; return it, a narrowed rewrite, or a
   * refusal. See `row-policy.ts`.
   */
  rowPolicy?: DqlRowPolicy;
  /**
   * The connection as the person asking (RFC 0010 HH-4): their own warehouse
   * token or role, laid over the configured connection before any statement
   * runs. A refusal stops the query with "reconnect" — never a retry with the
   * service credential. See `row-policy.ts`.
   */
  credentials?: DqlCredentialsHook;
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

/** Ask the host whether this request may go ahead; an error is a refusal. */
export async function authorizeHostRequest(hooks: DqlHostHooks, principal: DqlPrincipal, route: DqlRouteAction): Promise<DqlDecision> {
  if (!hooks.authorize) return { allow: true };
  try {
    const decision = await hooks.authorize(principal, route.action, route.resource);
    if (decision && decision.allow === true) return { allow: true };
    const reason = decision && typeof decision.reason === 'string' && decision.reason.trim() ? decision.reason.trim() : undefined;
    return { allow: false, ...(reason ? { reason } : {}) };
  } catch {
    return { allow: false };
  }
}

/**
 * ONE PERSONA PER PERSON. "View as" (the App persona) is kept per signed-in
 * person, so a steward previewing an App as a member never changes what
 * anyone else sees. Requests without a host principal keep the one
 * process-wide persona, as before.
 */
const personaSlots = new Map<string, { value: unknown }>();
export function installHostPersonaSlots(registry: { useSlots(resolver: (() => { value: any } | undefined) | null): void }): void {
  registry.useSlots(() => {
    const principal = currentPrincipal();
    if (!principal || principal.source === 'local') return undefined;
    let slot = personaSlots.get(principal.id);
    if (!slot) {
      slot = { value: null };
      personaSlots.set(principal.id, slot);
    }
    return slot;
  });
}

/**
 * The person as App policies see them when they have not chosen an App
 * persona: their own groups and department, never the owner's full access.
 */
export function hostUserContext(): { userId: string; roles: string[]; department?: string } | undefined {
  const principal = currentPrincipal();
  const actor = hostActor();
  if (!principal || !actor) return undefined;
  const department = principal.attributes?.department;
  return {
    userId: actor,
    roles: [...(principal.groups ?? [])],
    ...(typeof department === 'string' ? { department } : {}),
  };
}

/**
 * Row-rule values for the signed-in person: `{user.id}`, `{user.email}`,
 * `{user.roles}` and each attribute as `{user.<name>}`. The person's values
 * win over anything a request passes, so nobody widens their own rows.
 */
export function hostPrincipalVariables(): Record<string, unknown> | undefined {
  const principal = currentPrincipal();
  const actor = hostActor();
  if (!principal || !actor) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(principal.attributes ?? {})) {
    out[`user.${key}`] = value;
    out[key] = value;
  }
  out['user.id'] = actor;
  out['user.userId'] = actor;
  if (principal.email) out['user.email'] = principal.email;
  out['user.roles'] = [...(principal.groups ?? [])];
  return out;
}

/** What about the signed-in person can change query results, for cache and proof keys. */
export function hostPrincipalPolicyIdentity(): Record<string, unknown> | undefined {
  const principal = currentPrincipal();
  if (!principal || principal.source !== 'host') return undefined;
  const attributes = Object.fromEntries(Object.entries(principal.attributes ?? {}).sort(([left], [right]) => left.localeCompare(right)));
  return { id: principal.id, groups: [...(principal.groups ?? [])].sort(), attributes };
}
