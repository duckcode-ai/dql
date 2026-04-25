import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySlackSignature } from './signature.js';

const SECRET = 'topsecret';

function sign(timestamp: string, body: string): string {
  const hmac = createHmac('sha256', SECRET).update(`v0:${timestamp}:${body}`).digest('hex');
  return `v0=${hmac}`;
}

describe('verifySlackSignature', () => {
  const now = 1_800_000_000;
  const ts = String(now);
  const body = 'token=abc&user_id=U123&text=ask+revenue';

  it('accepts a valid signature within tolerance', () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: ts,
        body,
        signature: sign(ts, body),
        now,
      }),
    ).toBe(true);
  });

  it('rejects signatures past the tolerance window', () => {
    const old = String(now - 1000);
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: old,
        body,
        signature: sign(old, body),
        now,
      }),
    ).toBe(false);
  });

  it('rejects mismatched body', () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: ts,
        body: 'token=other',
        signature: sign(ts, body),
        now,
      }),
    ).toBe(false);
  });

  it('rejects malformed timestamp', () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: 'not-a-number',
        body,
        signature: sign(ts, body),
        now,
      }),
    ).toBe(false);
  });

  it('rejects mismatched signature length without throwing', () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: ts,
        body,
        signature: 'v0=tooshort',
        now,
      }),
    ).toBe(false);
  });
});
