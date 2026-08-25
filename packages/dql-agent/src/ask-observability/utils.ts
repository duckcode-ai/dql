import { createHash, randomBytes } from 'node:crypto';

/** Canonical JSON is used only for fingerprints and portable bundle checksums. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function fingerprint(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function mintHexId(bytes: 8 | 16): string {
  // W3C trace/span identifiers must not be all zero. `randomBytes` makes that
  // practically impossible; retain the explicit guard for deterministic tests.
  let id = randomBytes(bytes).toString('hex');
  while (/^0+$/.test(id)) id = randomBytes(bytes).toString('hex');
  return id;
}

export function isoNow(now: () => Date = () => new Date()): string {
  return now().toISOString();
}

export function durationMs(startedAt: string, completedAt: string): number {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  return Number.isFinite(started) && Number.isFinite(completed)
    ? Math.max(0, completed - started)
    : 0;
}

/** A bounded label can be stored locally, but never definitions, values, or prose. */
export function boundedLabel(value: string | undefined, max = 160): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/[\r\n\t]+/g, ' ');
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

/**
 * Trace payloads are typed, but this final boundary makes accidental raw data
 * keys fail closed before SQLite/export. It intentionally retains fingerprints,
 * counts, reason codes, and qualified IDs supplied by their typed contracts.
 */
const PROHIBITED_KEY = /(authorization|cookie|secret|token|password|api[_-]?key|prompt|response|question|sql(?:text)?|literal|parameter(?:values?)?|rows$|sample(?:d)?(?:values?)?|values$|header|dsn|connection[_-]?string|path|url|error(?:message)?)/i;
const PROHIBITED_VALUE = /(?:\b(?:sk|pk|rk)_[A-Za-z0-9_-]{12,}\b|-----BEGIN [A-Z ]+-----|\bselect\b.+\bfrom\b|\bhttps?:\/\/|(?:^|\s)\/[A-Za-z0-9_./-]{3,})/i;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,79}$/i;

export function isSafeTraceValue(value: unknown): boolean {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return true;
  if (typeof value === 'string') return value.length <= 512 && !PROHIBITED_VALUE.test(value);
  if (Array.isArray(value)) return value.length <= 256 && value.every(isSafeTraceValue);
  if (typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).every(([key, entry]) => {
    // One-way fingerprints are expressly part of the contract. Their source
    // names (for example `questionFingerprint` or `sqlFingerprint`) must not
    // be confused with the prohibited raw values they represent.
    const isFingerprint = /fingerprint$/i.test(key);
    // `safeErrorCode` is a deliberately typed, allowlisted error *class*, not
    // a provider/tool error message.  Keep raw `error` fields prohibited while
    // allowing the single code field needed to explain a failed physical tool
    // attempt without turning the trace into a data side-channel.
    const isSafeErrorCode = key === 'safeErrorCode'
      && typeof entry === 'string'
      && SAFE_ERROR_CODE.test(entry);
    return (isFingerprint || isSafeErrorCode || !PROHIBITED_KEY.test(key)) && isSafeTraceValue(entry);
  });
}

export function assertSafeTraceValue(value: unknown): void {
  if (!isSafeTraceValue(value)) throw new Error('ASK_TRACE_UNSAFE_PAYLOAD');
}

export function pseudo(value: string, salt: string, prefix = 'id'): string {
  return `${prefix}_${createHash('sha256').update(`${salt}:${value}`).digest('hex').slice(0, 16)}`;
}

export function stableCursor(input: { startedAt: string; traceId: string }): string {
  return Buffer.from(`${input.startedAt}\u0000${input.traceId}`, 'utf8').toString('base64url');
}

export function parseCursor(cursor: string | undefined): { startedAt: string; traceId: string } | undefined {
  if (!cursor) return undefined;
  try {
    const [startedAt, traceId] = Buffer.from(cursor, 'base64url').toString('utf8').split('\u0000');
    return startedAt && traceId ? { startedAt, traceId } : undefined;
  } catch {
    return undefined;
  }
}
