import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bedrockClaudeTransport,
  createBedrockClaudeProvider,
  createVertexClaudeProvider,
  defaultAwsCredentials,
  signAwsRequest,
  vertexClaudeTransport,
} from './claude-cloud.js';

/**
 * RFC 0010 HH-5: Claude through Amazon Bedrock and Google Vertex, checked
 * against AWS's published SigV4 test vector and recorded replies. Not yet
 * checked against the live services.
 */
const AWS_EXAMPLE = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AWS Signature Version 4', () => {
  it('matches the published "get-vanilla" test vector', () => {
    const headers = signAwsRequest({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      region: 'us-east-1',
      service: 'service',
      credentials: AWS_EXAMPLE,
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
    expect(headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });

  it('signs temporary credentials and the body', () => {
    const base = { method: 'POST', url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke', region: 'us-east-1', service: 'bedrock', now: new Date('2026-09-25T12:00:00Z') };
    const a = signAwsRequest({ ...base, body: '{"a":1}', credentials: { ...AWS_EXAMPLE, sessionToken: 'session' } });
    const b = signAwsRequest({ ...base, body: '{"a":2}', credentials: { ...AWS_EXAMPLE, sessionToken: 'session' } });
    expect(a['x-amz-security-token']).toBe('session');
    expect(a.authorization).toContain('SignedHeaders=host;x-amz-date;x-amz-security-token');
    expect(a.authorization).not.toBe(b.authorization);
  });

  it('finds credentials in the environment first, then the container endpoint', async () => {
    expect(await defaultAwsCredentials({ AWS_ACCESS_KEY_ID: 'id', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'token' })).toEqual({ accessKeyId: 'id', secretAccessKey: 'secret', sessionToken: 'token' });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ AccessKeyId: 'task', SecretAccessKey: 'task-secret', Token: 'task-token', Expiration: '2026-09-25T13:00:00Z' })));
    vi.stubGlobal('fetch', fetch);
    expect(await defaultAwsCredentials({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc' })).toMatchObject({ accessKeyId: 'task', sessionToken: 'task-token' });
    expect(fetch).toHaveBeenCalledWith('http://169.254.170.2/v2/credentials/abc', {});
    await expect(defaultAwsCredentials({})).rejects.toThrow('no AWS credentials');
  });
});

describe('Claude on Amazon Bedrock', () => {
  const transport = bedrockClaudeTransport({ region: 'us-east-1', credentials: async () => AWS_EXAMPLE, now: () => new Date('2026-09-25T12:00:00Z') });

  it('sends the Messages request to InvokeModel, signed, without an Anthropic key', async () => {
    const prepared = await transport.prepare({
      url: 'https://api.anthropic.com/v1/messages',
      body: { model: 'anthropic.claude-sonnet-5-v1:0', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'x-api-key': 'never-sent', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    });
    expect(prepared.url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-5-v1%3A0/invoke');
    expect(JSON.parse(prepared.body)).toEqual({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    expect(prepared.headers['x-api-key']).toBeUndefined();
    expect(prepared.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260925\/us-east-1\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
  });

  it('applies a Bedrock Guardrail to every call, inside the signature', async () => {
    const guarded = bedrockClaudeTransport({ region: 'us-east-1', credentials: async () => AWS_EXAMPLE, guardrail: { id: 'gr-abc123', version: '2' }, now: () => new Date('2026-09-25T12:00:00Z') });
    const prepared = await guarded.prepare({ url: 'x', body: { model: 'm', max_tokens: 1, messages: [] }, headers: {} });
    expect(prepared.headers).toMatchObject({ 'x-amzn-bedrock-guardrailidentifier': 'gr-abc123', 'x-amzn-bedrock-guardrailversion': '2' });
    expect(prepared.headers.authorization).toContain('SignedHeaders=accept;content-type;host;x-amz-date;x-amzn-bedrock-guardrailidentifier;x-amzn-bedrock-guardrailversion');
  });

  it('refuses a streamed request, which Bedrock frames its own way', async () => {
    await expect(transport.prepare({ url: 'x', body: { model: 'm', stream: true }, headers: {} })).rejects.toThrow('streaming');
  });

  it('answers through the provider, and streams as one whole answer', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'Revenue rose 8%.' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const provider = createBedrockClaudeProvider({ region: 'eu-west-1', model: 'eu.anthropic.claude-sonnet-5-v1:0', credentials: async () => AWS_EXAMPLE });
    expect(await provider.available()).toBe(true);
    expect(await provider.generate([{ role: 'user', content: 'Why?' }])).toBe('Revenue rose 8%.');
    const deltas: string[] = [];
    expect(await provider.generateStream!([{ role: 'user', content: 'Why?' }], {}, (delta) => deltas.push(delta))).toBe('Revenue rose 8%.');
    expect(deltas).toEqual(['Revenue rose 8%.']);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://bedrock-runtime.eu-west-1.amazonaws.com/model/eu.anthropic.claude-sonnet-5-v1%3A0/invoke');
    expect(JSON.parse(String(init.body)).model).toBeUndefined();
  });
});

describe('Claude on Google Vertex AI', () => {
  it('sends rawPredict or streamRawPredict with a Google token', async () => {
    const transport = vertexClaudeTransport({ projectId: 'insurer-prod', region: 'us-east5', accessToken: async () => ({ token: 'ya29.token' }) });
    const plain = await transport.prepare({ url: 'x', body: { model: 'claude-sonnet-5', max_tokens: 10, messages: [] }, headers: { 'x-api-key': 'k' } });
    expect(plain.url).toBe('https://us-east5-aiplatform.googleapis.com/v1/projects/insurer-prod/locations/us-east5/publishers/anthropic/models/claude-sonnet-5:rawPredict');
    expect(JSON.parse(plain.body)).toEqual({ anthropic_version: 'vertex-2023-10-16', max_tokens: 10, messages: [] });
    expect(plain.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer ya29.token' });
    const streamed = await vertexClaudeTransport({ projectId: 'p', region: 'global', accessToken: async () => ({ token: 't' }) })
      .prepare({ url: 'x', body: { model: 'claude-sonnet-5', stream: true }, headers: {} });
    expect(streamed.url).toBe('https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/anthropic/models/claude-sonnet-5:streamRawPredict');
    expect(JSON.parse(streamed.body).stream).toBe(true);
  });

  it('streams Anthropic server-sent events through the provider', async () => {
    const sse = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Claims "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"fell."}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    const provider = createVertexClaudeProvider({ projectId: 'p', region: 'europe-west1', model: 'claude-sonnet-5', accessToken: async () => ({ token: 't' }) });
    const deltas: string[] = [];
    expect(await provider.generateStream!([{ role: 'user', content: 'x' }], {}, (delta) => deltas.push(delta))).toBe('Claims fell.');
    expect(deltas).toEqual(['Claims ', 'fell.']);
  });
});
