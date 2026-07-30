const SERVER_TOKEN_FRAGMENT_KEY = 'dql_token';
const SERVER_TOKEN_SESSION_KEY = 'dql.server-token.v1';

/** Read the one-time LAN bearer token without putting it in an HTTP request. */
export function serverTokenFromHash(hash: string): string | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = params.get(SERVER_TOKEN_FRAGMENT_KEY)?.trim();
  return token || undefined;
}

/** Remove only DQL's token while preserving any unrelated fragment state. */
export function hashWithoutServerToken(hash: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  params.delete(SERVER_TOKEN_FRAGMENT_KEY);
  const remaining = params.toString();
  return remaining ? `#${remaining}` : '';
}

function initializeServerToken(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const supplied = serverTokenFromHash(window.location.hash);
    if (supplied) {
      window.sessionStorage.setItem(SERVER_TOKEN_SESSION_KEY, supplied);
      const cleanHash = hashWithoutServerToken(window.location.hash);
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${window.location.search}${cleanHash}`,
      );
      return supplied;
    }
    return window.sessionStorage.getItem(SERVER_TOKEN_SESSION_KEY)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

const serverToken = initializeServerToken();

/** Attach the session-only token to same-origin DQL API calls when supplied. */
export function withServerAuthorization(headers?: HeadersInit): Headers {
  const resolved = new Headers(headers);
  if (serverToken) resolved.set('Authorization', `Bearer ${serverToken}`);
  return resolved;
}
