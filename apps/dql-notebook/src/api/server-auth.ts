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

export interface ServerEventFrame {
  event: string;
  data: string;
}

/**
 * Read a same-origin SSE stream through fetch so LAN sessions can use the same
 * bearer header as every other API call. Native EventSource has no header API.
 */
export async function streamServerEvents(
  path: string,
  onEvent: (frame: ServerEventFrame) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(path, {
    headers: withServerAuthorization({ Accept: 'text/event-stream' }),
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error(`Event stream failed with HTTP ${response.status}.`);
  if (!response.body) throw new Error('Event stream response did not include a body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  const dispatch = () => {
    if (data.length > 0) onEvent({ event, data: data.join('\n') });
    event = 'message';
    data = [];
  };

  while (!signal.aborted) {
    const next = await reader.read();
    buffer += decoder.decode(next.value, { stream: !next.done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') {
        dispatch();
      } else if (!line.startsWith(':')) {
        const separator = line.indexOf(':');
        const field = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
        if (field === 'event') event = value || 'message';
        if (field === 'data') data.push(value);
      }
    }
    if (next.done) {
      dispatch();
      return;
    }
  }
}
