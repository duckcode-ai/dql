import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { normalizeSnowflakePrivateKeyForAuth } from './snowflake.js';

describe('normalizeSnowflakePrivateKeyForAuth', () => {
  it('normalizes RSA private keys to PKCS8 PEM', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    const normalized = normalizeSnowflakePrivateKeyForAuth(privateKey);

    expect(normalized).toContain('-----BEGIN PRIVATE KEY-----');
  });

  it('accepts pasted keys with escaped newlines', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    const normalized = normalizeSnowflakePrivateKeyForAuth(privateKey.replace(/\n/g, '\\n'));

    expect(normalized).toContain('-----BEGIN PRIVATE KEY-----');
  });

  it('decrypts encrypted private keys with the matching passphrase', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: 'correct-passphrase',
      },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    const normalized = normalizeSnowflakePrivateKeyForAuth(privateKey, 'correct-passphrase');

    expect(normalized).toContain('-----BEGIN PRIVATE KEY-----');
  });

  it('returns an actionable error when an encrypted key has the wrong passphrase', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: 'correct-passphrase',
      },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    expect(() => normalizeSnowflakePrivateKeyForAuth(privateKey, 'wrong-passphrase'))
      .toThrow(/Snowflake private key could not be parsed or decrypted/);
  });
});
