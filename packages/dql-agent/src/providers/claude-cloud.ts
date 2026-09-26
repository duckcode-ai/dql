import { createHash, createHmac } from 'node:crypto';
import type { ProviderHttpTransport } from './dispatch.js';
import { ClaudeProvider } from './claude.js';

/**
 * CLAUDE INSIDE THE CUSTOMER'S CLOUD (RFC 0010, slice HH-5). The same
 * Messages API, reached through Amazon Bedrock or Google Vertex AI so
 * prompts stay in the customer's own account and region. No cloud SDKs:
 * Bedrock requests are signed with AWS Signature Version 4 here, and Vertex
 * requests carry a Google access token from the environment, the machine's
 * metadata server (Cloud Run, GKE, GCE), or the host.
 *
 * Built from the services' public docs:
 * - Bedrock InvokeModel: POST https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/invoke,
 *   body = Messages request without `model`, with `anthropic_version: "bedrock-2023-05-31"`.
 * - Vertex: POST https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/publishers/anthropic/models/{model}:rawPredict
 *   (`:streamRawPredict` streams Anthropic's own SSE), body without `model`, with
 *   `anthropic_version: "vertex-2023-10-16"`; the `global` location uses aiplatform.googleapis.com.
 * Not yet checked against the live services.
 */

// ── AWS Signature Version 4 ──────────────────────────────────────────────

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** When temporary credentials stop working. */
  expiration?: Date;
}

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Uint8Array, value: string): Uint8Array => new Uint8Array(createHmac('sha256', key).update(value).digest());

/** RFC 3986 encoding, as SigV4 requires. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function amzDate(now: Date): { stamp: string; day: string } {
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { stamp, day: stamp.slice(0, 8) };
}

/**
 * Sign one request (SigV4, header form). Every given header is signed along
 * with `host` and `x-amz-date` (and `x-amz-security-token` for temporary
 * credentials). Path segments are encoded again, as for every AWS service
 * except S3. Returns the headers to send.
 */
export function signAwsRequest(input: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now?: Date;
}): Record<string, string> {
  const url = new URL(input.url);
  const { stamp, day } = amzDate(input.now ?? new Date());
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ');
  headers.host = url.host;
  headers['x-amz-date'] = stamp;
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken;
  const signedNames = Object.keys(headers).sort();
  const canonicalUri = url.pathname.split('/').map((segment) => encodeRfc3986(segment)).join('/') || '/';
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    signedNames.map((name) => `${name}:${headers[name]}`).join('\n') + '\n',
    signedNames.join(';'),
    sha256Hex(input.body ?? ''),
  ].join('\n');
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`,
  };
}

/**
 * Credentials the way AWS SDKs find them first: environment variables, then
 * the container credentials endpoint (ECS task roles and EKS Pod Identity).
 * A host with its own AWS SDK passes a `credentials` function instead.
 */
export async function defaultAwsCredentials(env: NodeJS.ProcessEnv = process.env): Promise<AwsCredentials> {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) };
  }
  const endpoint = env.AWS_CONTAINER_CREDENTIALS_FULL_URI
    ?? (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ? `http://169.254.170.2${env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}` : undefined);
  if (endpoint) {
    const token = env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    const response = await fetch(endpoint, token ? { headers: { Authorization: token } } : {});
    if (!response.ok) throw new Error(`bedrock: the container credentials endpoint answered ${response.status}`);
    const json = await response.json() as { AccessKeyId?: string; SecretAccessKey?: string; Token?: string; Expiration?: string };
    if (!json.AccessKeyId || !json.SecretAccessKey) throw new Error('bedrock: the container credentials endpoint returned no keys');
    return { accessKeyId: json.AccessKeyId, secretAccessKey: json.SecretAccessKey, ...(json.Token ? { sessionToken: json.Token } : {}), ...(json.Expiration ? { expiration: new Date(json.Expiration) } : {}) };
  }
  throw new Error('bedrock: no AWS credentials found (set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, run with an ECS task role or EKS Pod Identity, or let the host supply them)');
}

function cached<T extends { expiration?: Date }>(load: () => Promise<T>, marginMs = 60_000): () => Promise<T> {
  let value: T | undefined;
  return async () => {
    if (value && (!value.expiration || value.expiration.getTime() - marginMs > Date.now())) return value;
    value = await load();
    return value;
  };
}

function messagesBody(body: Record<string, unknown>, anthropicVersion: string): { model: string; stream: boolean; rest: Record<string, unknown> } {
  const { model, stream, ...rest } = body;
  if (typeof model !== 'string' || !model) throw new Error('claude: a model id is required');
  return { model, stream: stream === true, rest: { anthropic_version: anthropicVersion, ...rest } };
}

/** Only the headers the cloud should see: never an Anthropic API key. */
function cloudHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'x-api-key' || lower === 'anthropic-version' || lower === 'authorization') continue;
    out[lower] = value;
  }
  out['content-type'] = 'application/json';
  return out;
}

// ── Amazon Bedrock ───────────────────────────────────────────────────────

export interface BedrockClaudeOptions {
  /** The Bedrock region, e.g. us-east-1. Model ids may be in-region ids or Geo inference profile ids (e.g. us.anthropic…). */
  region: string;
  credentials?: () => Promise<AwsCredentials>;
  /** For tests and VPC endpoints: replaces https://bedrock-runtime.{region}.amazonaws.com. */
  endpoint?: string;
  /** An Amazon Bedrock Guardrail applied to every call (its id or ARN, and version). */
  guardrail?: { id: string; version: string };
  now?: () => Date;
}

export function bedrockClaudeTransport(options: BedrockClaudeOptions): ProviderHttpTransport {
  const credentials = cached(options.credentials ?? (() => defaultAwsCredentials()));
  const base = (options.endpoint ?? `https://bedrock-runtime.${options.region}.amazonaws.com`).replace(/\/$/, '');
  return {
    async prepare({ body, headers }) {
      const { model, stream, rest } = messagesBody(body, 'bedrock-2023-05-31');
      if (stream) throw new Error('bedrock: streaming is answered whole; use a provider with streaming off');
      const url = `${base}/model/${encodeURIComponent(model)}/invoke`;
      const payload = JSON.stringify(rest);
      const signed = signAwsRequest({
        method: 'POST',
        url,
        headers: {
          ...cloudHeaders(headers),
          accept: 'application/json',
          ...(options.guardrail ? { 'x-amzn-bedrock-guardrailidentifier': options.guardrail.id, 'x-amzn-bedrock-guardrailversion': options.guardrail.version } : {}),
        },
        body: payload,
        region: options.region,
        service: 'bedrock',
        credentials: await credentials(),
        ...(options.now ? { now: options.now() } : {}),
      });
      return { url, body: payload, headers: signed };
    },
  };
}

/** Claude through Amazon Bedrock, answered whole (Bedrock streams in its own event-stream framing). */
export function createBedrockClaudeProvider(options: BedrockClaudeOptions & { model: string }): ClaudeProvider {
  return new ClaudeProvider({ model: options.model, transport: bedrockClaudeTransport(options), streaming: false });
}

// ── Google Vertex AI ─────────────────────────────────────────────────────

export interface GoogleAccessToken {
  token: string;
  expiration?: Date;
}

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/**
 * A Google access token the way Google libraries find one on Google Cloud:
 * `GOOGLE_OAUTH_ACCESS_TOKEN` if set, else the metadata server of the
 * machine (Cloud Run, GKE with Workload Identity, GCE). A host with its own
 * Google auth library passes an `accessToken` function instead.
 */
export async function defaultGoogleAccessToken(env: NodeJS.ProcessEnv = process.env): Promise<GoogleAccessToken> {
  if (env.GOOGLE_OAUTH_ACCESS_TOKEN) return { token: env.GOOGLE_OAUTH_ACCESS_TOKEN };
  const response = await fetch(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } }).catch(() => null);
  if (!response?.ok) throw new Error('vertex: no Google access token (set GOOGLE_OAUTH_ACCESS_TOKEN, run on Google Cloud with a service account, or let the host supply one)');
  const json = await response.json() as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('vertex: the metadata server returned no access token');
  return { token: json.access_token, ...(json.expires_in ? { expiration: new Date(Date.now() + json.expires_in * 1000) } : {}) };
}

export interface VertexClaudeOptions {
  projectId: string;
  /** A region (us-east5, europe-west1), a multi-region (us, eu) or global. */
  region: string;
  accessToken?: () => Promise<GoogleAccessToken>;
  /** For tests and Private Service Connect: replaces the regional host. */
  endpoint?: string;
}

export function vertexHost(region: string): string {
  return region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
}

export function vertexClaudeTransport(options: VertexClaudeOptions): ProviderHttpTransport {
  const token = cached(options.accessToken ?? (() => defaultGoogleAccessToken()));
  const base = (options.endpoint ?? `https://${vertexHost(options.region)}`).replace(/\/$/, '');
  return {
    async prepare({ body, headers }) {
      const { model, stream, rest } = messagesBody(body, 'vertex-2023-10-16');
      const url = `${base}/v1/projects/${encodeURIComponent(options.projectId)}/locations/${encodeURIComponent(options.region)}/publishers/anthropic/models/${encodeURIComponent(model)}:${stream ? 'streamRawPredict' : 'rawPredict'}`;
      return {
        url,
        body: JSON.stringify(stream ? { ...rest, stream: true } : rest),
        headers: { ...cloudHeaders(headers), authorization: `Bearer ${(await token()).token}` },
      };
    },
  };
}

/** Claude through Google Vertex AI; streams Anthropic's own SSE. */
export function createVertexClaudeProvider(options: VertexClaudeOptions & { model: string }): ClaudeProvider {
  return new ClaudeProvider({ model: options.model, transport: vertexClaudeTransport(options) });
}
