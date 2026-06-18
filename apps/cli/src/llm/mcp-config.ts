import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type NativeMcpProvider = 'openai' | 'anthropic';

export interface RemoteMcpServer {
  kind?: 'server' | 'connector';
  name: string;
  url?: string;
  connectorId?: string;
  description?: string;
  authorizationToken?: string;
  authorizationTokenEnv?: string;
  allowedTools?: string[];
  enabled: boolean;
  trusted: boolean;
  deferLoading?: boolean;
  providers?: NativeMcpProvider[];
}

export interface RemoteMcpLoadResult {
  path: string;
  servers: RemoteMcpServer[];
  warnings: string[];
}

export interface RedactedRemoteMcpEntry extends Omit<RemoteMcpServer, 'authorizationToken'> {
  kind: 'server' | 'connector';
  hasAuthorizationToken: boolean;
  authorizationTokenPreview?: string;
}

export interface RemoteMcpSettings {
  path: string;
  entries: RedactedRemoteMcpEntry[];
  warnings: string[];
}

export interface RemoteMcpSettingsInput {
  entries?: unknown;
}

interface RawMcpConfig {
  servers?: unknown;
  connectors?: unknown;
}

export function remoteMcpConfigPath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'mcp-servers.json');
}

export function loadRemoteMcpServers(projectRoot: string, provider: NativeMcpProvider): RemoteMcpLoadResult {
  const path = remoteMcpConfigPath(projectRoot);
  if (!existsSync(path)) return { path, servers: [], warnings: [] };
  let parsed: RawMcpConfig;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as RawMcpConfig;
  } catch (error) {
    return {
      path,
      servers: [],
      warnings: [`Could not read MCP config at ${path}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const warnings: string[] = [];
  const servers = [
    ...normalizeEntries(parsed.servers, 'server', warnings),
    ...normalizeEntries(parsed.connectors, 'connector', warnings),
  ].filter((server) => {
    if (!server.enabled) return false;
    if (server.providers?.length && !server.providers.includes(provider)) return false;
    if (!server.trusted) {
      warnings.push(`MCP ${server.connectorId ? 'connector' : 'server'} "${server.name}" is skipped because trusted=true is required.`);
      return false;
    }
    if (provider === 'anthropic' && server.connectorId) {
      warnings.push(`MCP connector "${server.name}" is OpenAI-only and was skipped for Anthropic.`);
      return false;
    }
    return true;
  });

  return { path, servers, warnings };
}

export function listRemoteMcpSettings(projectRoot: string): RemoteMcpSettings {
  const { path, parsed, warnings } = readRawMcpConfig(projectRoot);
  const entries = [
    ...normalizeEntries(parsed?.servers, 'server', warnings),
    ...normalizeEntries(parsed?.connectors, 'connector', warnings),
  ].map(redactEntry);
  return { path, entries, warnings };
}

export function saveRemoteMcpSettings(projectRoot: string, input: RemoteMcpSettingsInput): RemoteMcpSettings {
  const current = listRemoteMcpSecrets(projectRoot);
  const warnings: string[] = [];
  const entries = normalizeSaveEntries(input.entries, current, warnings);
  const servers = entries
    .filter((entry) => entry.kind !== 'connector')
    .map((entry) => compactObject({
      name: entry.name,
      url: entry.url,
      description: entry.description,
      authorizationToken: entry.authorizationToken,
      authorizationTokenEnv: entry.authorizationTokenEnv,
      allowedTools: entry.allowedTools,
      enabled: entry.enabled,
      trusted: entry.trusted,
      deferLoading: entry.deferLoading,
      providers: entry.providers,
    }));
  const connectors = entries
    .filter((entry) => entry.kind === 'connector')
    .map((entry) => compactObject({
      name: entry.name,
      connectorId: entry.connectorId,
      description: entry.description,
      authorizationToken: entry.authorizationToken,
      authorizationTokenEnv: entry.authorizationTokenEnv,
      allowedTools: entry.allowedTools,
      enabled: entry.enabled,
      trusted: entry.trusted,
      deferLoading: entry.deferLoading,
      providers: entry.providers,
    }));
  const path = remoteMcpConfigPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, servers, connectors }, null, 2) + '\n', 'utf-8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems that do not support POSIX modes.
  }
  const next = listRemoteMcpSettings(projectRoot);
  return { ...next, warnings: [...warnings, ...next.warnings] };
}

export function openAiMcpTools(servers: RemoteMcpServer[]): Record<string, unknown>[] {
  return servers.map((server) => {
    const authorization = authToken(server);
    if (server.connectorId) {
      return compactObject({
        type: 'mcp',
        server_label: server.name,
        connector_id: server.connectorId,
        authorization,
        allowed_tools: nonEmpty(server.allowedTools),
        require_approval: 'never',
      });
    }
    return compactObject({
      type: 'mcp',
      server_label: server.name,
      server_description: server.description,
      server_url: server.url,
      headers: authorization ? { Authorization: `Bearer ${authorization}` } : undefined,
      allowed_tools: nonEmpty(server.allowedTools),
      defer_loading: server.deferLoading === true ? true : undefined,
      require_approval: 'never',
    });
  });
}

export function anthropicMcpConfig(servers: RemoteMcpServer[]): {
  mcpServers: Record<string, unknown>[];
  toolsets: Record<string, unknown>[];
} {
  const remoteServers = servers.filter((server) => server.url && !server.connectorId);
  return {
    mcpServers: remoteServers.map((server) => compactObject({
      type: 'url',
      url: server.url,
      name: server.name,
      authorization_token: authToken(server),
    })),
    toolsets: remoteServers.map((server) => compactObject({
      type: 'mcp_toolset',
      mcp_server_name: server.name,
      default_config: {
        enabled: true,
        defer_loading: server.deferLoading === true,
      },
      configs: allowedToolConfig(server.allowedTools),
    })),
  };
}

function normalizeEntries(input: unknown, kind: 'server' | 'connector', warnings: string[]): RemoteMcpServer[] {
  if (!Array.isArray(input)) return [];
  const out: RemoteMcpServer[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      warnings.push(`Ignoring invalid MCP ${kind} entry.`);
      continue;
    }
    const raw = entry as Record<string, unknown>;
    const name = cleanName(raw.name ?? raw.server_label ?? raw.serverLabel);
    if (!name) {
      warnings.push(`Ignoring MCP ${kind} with missing or invalid name.`);
      continue;
    }
    const url = cleanUrl(raw.url ?? raw.server_url ?? raw.serverUrl);
    const connectorId = cleanString(raw.connectorId ?? raw.connector_id);
    if (kind === 'server' && !url) {
      warnings.push(`Ignoring MCP server "${name}" because url/server_url is required.`);
      continue;
    }
    if (kind === 'connector' && !connectorId) {
      warnings.push(`Ignoring MCP connector "${name}" because connectorId is required.`);
      continue;
    }
    out.push({
      kind,
      name,
      url,
      connectorId,
      description: cleanString(raw.description ?? raw.server_description ?? raw.serverDescription),
      authorizationToken: cleanString(raw.authorizationToken ?? raw.authorization ?? raw.authorization_token),
      authorizationTokenEnv: cleanString(raw.authorizationTokenEnv ?? raw.authorizationEnv ?? raw.authorization_token_env),
      allowedTools: cleanStringArray(raw.allowedTools ?? raw.allowed_tools),
      enabled: raw.enabled !== false,
      trusted: raw.trusted === true,
      deferLoading: raw.deferLoading === true || raw.defer_loading === true,
      providers: cleanProviderArray(raw.providers),
    });
  }
  return out;
}

function readRawMcpConfig(projectRoot: string): { path: string; parsed?: RawMcpConfig; warnings: string[] } {
  const path = remoteMcpConfigPath(projectRoot);
  if (!existsSync(path)) return { path, parsed: undefined, warnings: [] };
  try {
    return { path, parsed: JSON.parse(readFileSync(path, 'utf-8')) as RawMcpConfig, warnings: [] };
  } catch (error) {
    return {
      path,
      parsed: undefined,
      warnings: [`Could not read MCP config at ${path}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

function listRemoteMcpSecrets(projectRoot: string): Map<string, RemoteMcpServer> {
  const { parsed } = readRawMcpConfig(projectRoot);
  const warnings: string[] = [];
  const entries = [
    ...normalizeEntries(parsed?.servers, 'server', warnings),
    ...normalizeEntries(parsed?.connectors, 'connector', warnings),
  ];
  return new Map(entries.map((entry) => [entryKey(entry.kind ?? 'server', entry.name), entry]));
}

function normalizeSaveEntries(
  input: unknown,
  current: Map<string, RemoteMcpServer>,
  warnings: string[],
): RemoteMcpServer[] {
  if (!Array.isArray(input)) return [];
  const entries: RemoteMcpServer[] = [];
  for (const rawEntry of input) {
    if (!rawEntry || typeof rawEntry !== 'object') {
      warnings.push('Ignoring invalid MCP connection.');
      continue;
    }
    const raw = rawEntry as Record<string, unknown>;
    const kind = raw.kind === 'connector' ? 'connector' : 'server';
    const name = cleanName(raw.name);
    if (!name) {
      warnings.push('Ignoring MCP connection with missing name.');
      continue;
    }
    const url = cleanUrl(raw.url ?? raw.server_url ?? raw.serverUrl);
    const connectorId = cleanString(raw.connectorId ?? raw.connector_id);
    if (kind === 'server' && !url) {
      warnings.push(`Ignoring MCP server "${name}" because URL is required.`);
      continue;
    }
    if (kind === 'connector' && !connectorId) {
      warnings.push(`Ignoring MCP connector "${name}" because connector ID is required.`);
      continue;
    }
    const existing = current.get(entryKey(kind, name));
    const newToken = cleanString(raw.authorizationToken ?? raw.authorization ?? raw.authorization_token);
    entries.push({
      kind,
      name,
      url,
      connectorId,
      description: cleanString(raw.description ?? raw.server_description ?? raw.serverDescription),
      authorizationToken: newToken ?? existing?.authorizationToken,
      authorizationTokenEnv: cleanString(raw.authorizationTokenEnv ?? raw.authorizationEnv ?? raw.authorization_token_env),
      allowedTools: cleanStringArray(raw.allowedTools ?? raw.allowed_tools),
      enabled: raw.enabled !== false,
      trusted: raw.trusted === true,
      deferLoading: raw.deferLoading === true || raw.defer_loading === true,
      providers: cleanProviderArray(raw.providers),
    });
  }
  return entries;
}

function redactEntry(entry: RemoteMcpServer): RedactedRemoteMcpEntry {
  const hasAuthorizationToken = Boolean(entry.authorizationToken?.trim());
  const { authorizationToken: _authorizationToken, ...safe } = entry;
  return {
    ...safe,
    kind: entry.kind ?? (entry.connectorId ? 'connector' : 'server'),
    hasAuthorizationToken,
    authorizationTokenPreview: hasAuthorizationToken ? previewSecret(entry.authorizationToken!) : undefined,
  };
}

function entryKey(kind: 'server' | 'connector', name: string): string {
  return `${kind}:${name}`;
}

function authToken(server: RemoteMcpServer): string | undefined {
  if (server.authorizationTokenEnv) {
    const value = process.env[server.authorizationTokenEnv]?.trim();
    if (value) return value;
  }
  return server.authorizationToken?.trim() || undefined;
}

function allowedToolConfig(tools?: string[]): Record<string, { enabled: true; defer_loading?: true }> | undefined {
  const names = nonEmpty(tools);
  if (!names) return undefined;
  return Object.fromEntries(names.map((tool) => [tool, { enabled: true, defer_loading: true }]));
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => {
    if (value === undefined || value === null) return false;
    if (Array.isArray(value) && value.length === 0) return false;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return false;
    return true;
  }));
}

function nonEmpty(values?: string[]): string[] | undefined {
  return values?.length ? values : undefined;
}

function cleanName(value: unknown): string | undefined {
  const raw = cleanString(value);
  if (!raw) return undefined;
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return safe || undefined;
}

function cleanUrl(value: unknown): string | undefined {
  const raw = cleanString(value);
  if (!raw) return undefined;
  if (!/^https?:\/\//i.test(raw)) return undefined;
  return raw;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(cleanString).filter((item): item is string => Boolean(item));
  return values.length ? Array.from(new Set(values)) : undefined;
}

function cleanProviderArray(value: unknown): NativeMcpProvider[] | undefined {
  const values = cleanStringArray(value);
  if (!values) return undefined;
  const providers = values.filter((item): item is NativeMcpProvider => item === 'openai' || item === 'anthropic');
  return providers.length ? providers : undefined;
}

function previewSecret(secret: string): string {
  if (secret.length <= 8) return '********';
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}
