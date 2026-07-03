import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Secure on-disk store for subscription OAuth credentials (Claude Pro/Max,
 * ChatGPT Plus/Pro). Replaces the VSCode SecretStorage the reference flow used
 * with a `chmod 600` JSON file under `.dql/`, mirroring how `provider-settings.json`
 * already guards API keys. Tokens never leave the machine.
 */

export interface ClaudeOAuthCredentials {
  type: 'claude';
  access_token: string;
  refresh_token: string;
  /** ISO-8601 expiry timestamp. */
  expired: string;
  email?: string;
}

export interface CodexOAuthCredentials {
  type: 'openai-codex';
  access_token: string;
  refresh_token: string;
  /** Expiry as a Unix epoch in milliseconds. */
  expires: number;
  email?: string;
  accountId?: string;
}

interface OAuthStoreFile {
  version: 1;
  claude?: ClaudeOAuthCredentials;
  codex?: CodexOAuthCredentials;
}

export type OAuthProviderKey = 'claude' | 'codex';

export function oauthCredentialsPath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'oauth-credentials.json');
}

function readStore(projectRoot: string): OAuthStoreFile {
  const path = oauthCredentialsPath(projectRoot);
  if (!existsSync(path)) return { version: 1 };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<OAuthStoreFile>;
    return { version: 1, claude: parsed.claude, codex: parsed.codex };
  } catch {
    return { version: 1 };
  }
}

function writeStore(projectRoot: string, store: OAuthStoreFile): void {
  const path = oauthCredentialsPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n', 'utf-8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems without chmod.
  }
}

/** Basic shape validation — a corrupt/partial entry is treated as "not connected". */
function isClaudeCreds(v: unknown): v is ClaudeOAuthCredentials {
  const c = v as ClaudeOAuthCredentials | undefined;
  return Boolean(c && c.type === 'claude' && typeof c.access_token === 'string' && typeof c.refresh_token === 'string' && typeof c.expired === 'string');
}

function isCodexCreds(v: unknown): v is CodexOAuthCredentials {
  const c = v as CodexOAuthCredentials | undefined;
  return Boolean(c && c.type === 'openai-codex' && typeof c.access_token === 'string' && typeof c.refresh_token === 'string' && typeof c.expires === 'number');
}

export function getClaudeCredentials(projectRoot: string): ClaudeOAuthCredentials | null {
  const creds = readStore(projectRoot).claude;
  return isClaudeCreds(creds) ? creds : null;
}

export function setClaudeCredentials(projectRoot: string, creds: ClaudeOAuthCredentials): void {
  const store = readStore(projectRoot);
  store.claude = creds;
  writeStore(projectRoot, store);
}

export function getCodexCredentials(projectRoot: string): CodexOAuthCredentials | null {
  const creds = readStore(projectRoot).codex;
  return isCodexCreds(creds) ? creds : null;
}

export function setCodexCredentials(projectRoot: string, creds: CodexOAuthCredentials): void {
  const store = readStore(projectRoot);
  store.codex = creds;
  writeStore(projectRoot, store);
}

export function clearOAuthProvider(projectRoot: string, key: OAuthProviderKey): void {
  const store = readStore(projectRoot);
  delete store[key];
  writeStore(projectRoot, store);
}
