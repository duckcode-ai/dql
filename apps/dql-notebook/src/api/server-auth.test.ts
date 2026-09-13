import { describe, expect, it } from 'vitest';
import {
  hashWithoutServerToken,
  reportServerAuthRejected,
  serverTokenFromAccessInput,
  serverTokenFromHash,
  wasServerAuthRejected,
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

  it('finds the token in a pasted access link or a bare token, and none in a link without it', () => {
    expect(serverTokenFromAccessInput(' http://10.0.0.31:3630/#dql_token=036129c2d922328b0bc423948fbc5413 ')).toBe('036129c2d922328b0bc423948fbc5413');
    expect(serverTokenFromAccessInput('10.0.0.31:3630/#view=apps&dql_token=secret-123')).toBe('secret-123');
    expect(serverTokenFromAccessInput('036129c2d922328b0bc423948fbc5413')).toBe('036129c2d922328b0bc423948fbc5413');
    expect(serverTokenFromAccessInput('http://10.0.0.31:3630/')).toBeUndefined();
    expect(serverTokenFromAccessInput('short')).toBeUndefined();
  });

  it('only a refused token (401) asks for the access link', () => {
    expect(reportServerAuthRejected(403)).toBe(false);
    expect(reportServerAuthRejected(500)).toBe(false);
    expect(wasServerAuthRejected()).toBe(false);
    expect(reportServerAuthRejected(401)).toBe(true);
    expect(wasServerAuthRejected()).toBe(true);
  });

  it('preserves caller headers when no browser token was initialized', () => {
    const headers = withServerAuthorization({ 'Content-Type': 'application/json' });
    expect(headers.get('Content-Type')).toBe('application/json');
  });
});
