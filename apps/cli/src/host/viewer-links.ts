import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DqlDecision, DqlPrincipal } from './request-context.js';
import type { DqlRouteAction } from './route-actions.js';

/**
 * READ-ONLY LINKS TO ONE APP (RFC 0010, HH-2). A server shared on the
 * network used to put its own access token in page links, so anyone sent a
 * page could also edit the project, change connections and run any SQL. A
 * viewer link carries a signed token instead: it names one App and an
 * expiry, and a request that holds it may only read and run that App's
 * pages. The server keeps no list of links; the signature is the proof, made
 * with a key derived from the server token, so changing that token revokes
 * every link.
 */
const PREFIX = 'dqlv1';
const DAY_MS = 24 * 60 * 60 * 1000;
export const VIEWER_LINK_DAYS = 14;

function signingKey(serverToken: string): Buffer {
  return createHmac('sha256', serverToken).update('dql viewer links v1').digest();
}

function signature(serverToken: string, body: string): string {
  return createHmac('sha256', signingKey(serverToken)).update(`${PREFIX}.${body}`).digest('base64url');
}

export function isViewerToken(token: string): boolean {
  return token.startsWith(`${PREFIX}.`);
}

/** A token that opens one App's pages until it expires. */
export function mintViewerToken(serverToken: string, appId: string, now = Date.now(), days = VIEWER_LINK_DAYS): { token: string; expiresAt: string } {
  const expires = now + days * DAY_MS;
  const body = Buffer.from(JSON.stringify({ a: appId, e: Math.floor(expires / 1000) })).toString('base64url');
  return { token: `${PREFIX}.${body}.${signature(serverToken, body)}`, expiresAt: new Date(Math.floor(expires / 1000) * 1000).toISOString() };
}

/** The App a token opens, or null when it is forged, altered, malformed or expired. */
export function readViewerToken(serverToken: string, token: string, now = Date.now()): { appId: string; expiresAt: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, body, supplied] = parts as [string, string, string];
  const expected = Buffer.from(signature(serverToken, body));
  const actual = Buffer.from(supplied);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let payload: { a?: unknown; e?: unknown };
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as { a?: unknown; e?: unknown };
  } catch {
    return null;
  }
  if (typeof payload.a !== 'string' || !payload.a || typeof payload.e !== 'number') return null;
  if (payload.e * 1000 <= now) return null;
  return { appId: payload.a, expiresAt: new Date(payload.e * 1000).toISOString() };
}

/**
 * Who a viewer link acts as: nobody in particular, reading one App as its
 * owner publishes it (no "view as" persona). An App that narrows rows per
 * member cannot be shared this way — see `viewerLinkBlockedReason`.
 */
export function viewerPrincipal(appId: string): DqlPrincipal {
  return { id: `viewer:${appId}`, kind: 'service', displayName: 'Viewer', source: 'link' };
}

/** Why an App cannot be opened by link, or null when it can. */
export function viewerLinkBlockedReason(app: { rlsBindings?: unknown[] } | null): string | null {
  if (!app) return 'This App was not found.';
  if ((app.rlsBindings ?? []).length > 0) return 'This App shows each member only their own rows, so it cannot be shared by link. Add people as members on a server where they sign in.';
  return null;
}

/**
 * The few project-wide reads a page needs to draw: who is reading, and the
 * values a page filter can offer.
 */
const VIEWER_READS = new Set(['/api/identity', '/api/dashboard/filter-options']);

/**
 * What a viewer link may do: view, run and export its own App's pages, run
 * that App's Dataset tiles and filter lists, and nothing else — no other App,
 * no Studio, no settings, no SQL of its own, and no questions to the owner's
 * AI provider.
 */
export function viewerDecision(appId: string, route: DqlRouteAction, method: string | undefined, path: string): DqlDecision {
  const ownApp = route.resource.type === 'app' && route.resource.id === appId;
  if (ownApp && (route.action === 'app.view' || route.action === 'export')) return { allow: true };
  if (route.resource.type === 'project' && route.action === 'app.view') return { allow: true };
  if (route.action === 'project.read' && (method ?? 'GET').toUpperCase() === 'GET' && VIEWER_READS.has(path)) return { allow: true };
  return { allow: false, reason: 'This link opens one App to read. Ask its owner for access to anything else.' };
}
