import { describe, expect, it } from 'vitest';
import {
  hashWithoutServerToken,
  serverTokenFromHash,
  withServerAuthorization,
} from './server-auth';

describe('LAN server authentication', () => {
  it('reads the bearer token from a URL fragment and never requires a query parameter', () => {
    expect(serverTokenFromHash('#dql_token=secret-123')).toBe('secret-123');
    expect(serverTokenFromHash('#view=apps')).toBeUndefined();
  });

  it('scrubs only the token from the fragment', () => {
    expect(hashWithoutServerToken('#dql_token=secret-123')).toBe('');
    expect(hashWithoutServerToken('#view=apps&dql_token=secret-123')).toBe('#view=apps');
  });

  it('preserves caller headers when no browser token was initialized', () => {
    const headers = withServerAuthorization({ 'Content-Type': 'application/json' });
    expect(headers.get('Content-Type')).toBe('application/json');
  });
});
