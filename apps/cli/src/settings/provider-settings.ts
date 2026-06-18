import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type ProviderSettingsId = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'custom-openai';

export interface ProviderSettingsInput {
  id: ProviderSettingsId;
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface StoredProviderSettings extends ProviderSettingsInput {
  updatedAt: string;
}

export interface RedactedProviderSettings {
  id: ProviderSettingsId;
  label: string;
  enabled: boolean;
  active: boolean;
  hasApiKey: boolean;
  apiKeyPreview?: string;
  baseUrl?: string;
  model?: string;
  source: 'local' | 'env' | 'none';
  envVars: string[];
}

export interface EffectiveProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  enabled: boolean;
}

interface StoredProviderState {
  activeProvider?: ProviderSettingsId;
  providers: Partial<Record<ProviderSettingsId, StoredProviderSettings>>;
}

const PROVIDER_META: Record<ProviderSettingsId, { label: string; keyEnv?: string; modelEnv?: string; baseUrlEnv?: string }> = {
  anthropic: { label: 'Anthropic Claude', keyEnv: 'ANTHROPIC_API_KEY', modelEnv: 'ANTHROPIC_MODEL' },
  openai: { label: 'OpenAI', keyEnv: 'OPENAI_API_KEY', modelEnv: 'OPENAI_MODEL', baseUrlEnv: 'OPENAI_BASE_URL' },
  gemini: { label: 'Google Gemini', keyEnv: 'GEMINI_API_KEY', modelEnv: 'GEMINI_MODEL' },
  ollama: { label: 'Ollama', modelEnv: 'OLLAMA_MODEL', baseUrlEnv: 'OLLAMA_BASE_URL' },
  'custom-openai': { label: 'Custom OpenAI-compatible', keyEnv: 'DQL_OPENAI_COMPAT_API_KEY', modelEnv: 'DQL_OPENAI_COMPAT_MODEL', baseUrlEnv: 'DQL_OPENAI_COMPAT_BASE_URL' },
};

export function providerSettingsPath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'provider-settings.json');
}

export function listProviderSettings(projectRoot: string): RedactedProviderSettings[] {
  const state = readStoredProviderState(projectRoot);
  const stored = state.providers;
  return (Object.keys(PROVIDER_META) as ProviderSettingsId[]).map((id) => {
    const meta = PROVIDER_META[id];
    const local = stored[id];
    const envKey = meta.keyEnv ? process.env[meta.keyEnv] : undefined;
    const hasLocalKey = Boolean(local?.apiKey?.trim());
    const hasEnvKey = Boolean(envKey?.trim());
    const hasNoAuthEndpoint = id === 'custom-openai' && Boolean(local?.baseUrl?.trim());
    return {
      id,
      label: meta.label,
      enabled: local?.enabled ?? (hasLocalKey || hasEnvKey || hasNoAuthEndpoint || id === 'ollama'),
      active: state.activeProvider === id,
      hasApiKey: hasLocalKey || hasEnvKey || hasNoAuthEndpoint || id === 'ollama',
      apiKeyPreview: hasLocalKey ? previewSecret(local!.apiKey!) : hasEnvKey ? `${meta.keyEnv}=set` : undefined,
      baseUrl: local?.baseUrl || (meta.baseUrlEnv ? process.env[meta.baseUrlEnv] : undefined),
      model: local?.model || (meta.modelEnv ? process.env[meta.modelEnv] : undefined),
      source: hasLocalKey || local?.baseUrl || local?.model ? 'local' : hasEnvKey || envHas(meta) ? 'env' : 'none',
      envVars: [meta.keyEnv, meta.modelEnv, meta.baseUrlEnv].filter(Boolean) as string[],
    };
  });
}

export function getEffectiveProviderConfig(projectRoot: string, id: ProviderSettingsId): EffectiveProviderConfig {
  const stored = readStoredProviderState(projectRoot).providers[id];
  const meta = PROVIDER_META[id];
  return {
    apiKey: stored?.apiKey || (meta.keyEnv ? process.env[meta.keyEnv] : undefined),
    baseUrl: stored?.baseUrl || (meta.baseUrlEnv ? process.env[meta.baseUrlEnv] : undefined),
    model: stored?.model || (meta.modelEnv ? process.env[meta.modelEnv] : undefined),
    enabled: stored?.enabled ?? true,
  };
}

export function getActiveProvider(projectRoot: string): ProviderSettingsId | undefined {
  return readStoredProviderState(projectRoot).activeProvider;
}

export function saveProviderSettings(projectRoot: string, input: ProviderSettingsInput): RedactedProviderSettings[] {
  const state = readStoredProviderState(projectRoot);
  const stored = state.providers;
  const existing = stored[input.id];
  const next: StoredProviderSettings = {
    id: input.id,
    enabled: input.enabled ?? existing?.enabled ?? true,
    apiKey: input.apiKey === undefined ? existing?.apiKey : input.apiKey.trim() || undefined,
    baseUrl: input.baseUrl === undefined ? existing?.baseUrl : input.baseUrl.trim() || undefined,
    model: input.model === undefined ? existing?.model : input.model.trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  stored[input.id] = next;
  if (next.enabled === false && state.activeProvider === input.id) {
    state.activeProvider = undefined;
  } else if (next.enabled !== false && providerCanBeActive(input.id, next)) {
    state.activeProvider = input.id;
  }
  writeStoredProviderState(projectRoot, state);
  return listProviderSettings(projectRoot);
}

function readStoredProviderState(projectRoot: string): StoredProviderState {
  const path = providerSettingsPath(projectRoot);
  if (!existsSync(path)) return { providers: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      activeProvider?: ProviderSettingsId;
      providers?: Partial<Record<ProviderSettingsId, StoredProviderSettings>>;
    };
    return {
      activeProvider: isProviderSettingsId(parsed.activeProvider) ? parsed.activeProvider : undefined,
      providers: parsed.providers ?? {},
    };
  } catch {
    return { providers: {} };
  }
}

function writeStoredProviderState(projectRoot: string, state: StoredProviderState): void {
  const path = providerSettingsPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    version: 1,
    ...(state.activeProvider ? { activeProvider: state.activeProvider } : {}),
    providers: state.providers,
  }, null, 2) + '\n', 'utf-8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems that support chmod.
  }
}

function envHas(meta: { modelEnv?: string; baseUrlEnv?: string }): boolean {
  return Boolean((meta.modelEnv && process.env[meta.modelEnv]) || (meta.baseUrlEnv && process.env[meta.baseUrlEnv]));
}

function providerCanBeActive(id: ProviderSettingsId, stored: StoredProviderSettings): boolean {
  if (stored.enabled === true) return true;
  const meta = PROVIDER_META[id];
  const hasKey = Boolean(stored.apiKey?.trim() || (meta.keyEnv && process.env[meta.keyEnv]?.trim()));
  const hasBaseUrl = Boolean(stored.baseUrl?.trim() || (meta.baseUrlEnv && process.env[meta.baseUrlEnv]?.trim()));
  const hasModel = Boolean(stored.model?.trim() || (meta.modelEnv && process.env[meta.modelEnv]?.trim()));
  if (id === 'ollama') return hasBaseUrl || hasModel;
  if (id === 'custom-openai') return hasBaseUrl;
  return hasKey;
}

function isProviderSettingsId(value: unknown): value is ProviderSettingsId {
  return value === 'anthropic'
    || value === 'openai'
    || value === 'gemini'
    || value === 'ollama'
    || value === 'custom-openai';
}

function previewSecret(secret: string): string {
  if (secret.length <= 8) return '********';
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}
