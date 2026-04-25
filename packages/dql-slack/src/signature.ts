/**
 * Slack request signature verification (https://api.slack.com/authentication/verifying-requests-from-slack).
 *
 * Slack signs each request with HMAC-SHA256 over `v0:<timestamp>:<rawBody>`
 * using your app's signing secret. The signature lives in
 * `x-slack-signature` and the timestamp in `x-slack-request-timestamp`.
 *
 * The verifier:
 *   - rejects requests older than 5 minutes (replay-prevention),
 *   - computes the HMAC and compares with the supplied digest,
 *   - returns `true` only if both pass.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifyOptions {
  signingSecret: string;
  /** ISO-8601 or unix-epoch seconds (Slack uses epoch seconds). */
  timestamp: string;
  /** Raw bytes (or string) of the POST body — NOT the parsed form. */
  body: string;
  /** Header value `x-slack-signature` (e.g. "v0=abc..."). */
  signature: string;
  /** Allowed clock skew in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Override "now" for tests. */
  now?: number;
}

export function verifySlackSignature(opts: VerifyOptions): boolean {
  const { signingSecret, timestamp, body, signature, toleranceSeconds = 300 } = opts;
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) return false;

  const base = `v0:${timestamp}:${body}`;
  const computed = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  if (computed.length !== signature.length) return false;
  try {
    return timingSafeEqual(
      new Uint8Array(Buffer.from(computed)),
      new Uint8Array(Buffer.from(signature)),
    );
  } catch {
    return false;
  }
}
