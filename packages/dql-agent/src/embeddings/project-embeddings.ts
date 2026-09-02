import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  embeddingOptionsFromEnv,
  resolveEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingResolveOptions,
} from './provider.js';

/**
 * Embedding settings a project declares in `dql.config.json`.
 *
 * Retrieval was previously semantic only if you exported an environment
 * variable, which no product surface mentioned — so in practice every project
 * ran the deterministic hashed fallback and "plain English" questions could
 * only ever match on shared tokens. Project config makes it a setting a user
 * can actually find and change.
 */
export interface ProjectEmbeddingSettings {
  /** `hashed` is the offline default; the others need an endpoint or key. */
  provider?: 'hashed' | 'ollama' | 'openai';
  /** Ollama base URL, e.g. http://127.0.0.1:11434 */
  endpoint?: string;
  /** Embedding model, e.g. nomic-embed-text (Ollama) or text-embedding-3-small. */
  model?: string;
  /** Only for the OpenAI-compatible provider. */
  apiKey?: string;
  baseUrl?: string;
}

export function readProjectEmbeddingSettings(projectRoot: string): ProjectEmbeddingSettings {
  const configPath = join(projectRoot, 'dql.config.json');
  if (!existsSync(configPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const ai = raw.ai && typeof raw.ai === 'object' && !Array.isArray(raw.ai)
      ? raw.ai as Record<string, unknown>
      : {};
    const embeddings = ai.embeddings && typeof ai.embeddings === 'object' && !Array.isArray(ai.embeddings)
      ? ai.embeddings as Record<string, unknown>
      : {};
    const str = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined;
    const provider = str(embeddings.provider);
    return {
      ...(provider === 'hashed' || provider === 'ollama' || provider === 'openai' ? { provider } : {}),
      ...(str(embeddings.endpoint) ? { endpoint: str(embeddings.endpoint) } : {}),
      ...(str(embeddings.model) ? { model: str(embeddings.model) } : {}),
      ...(str(embeddings.apiKey) ? { apiKey: str(embeddings.apiKey) } : {}),
      ...(str(embeddings.baseUrl) ? { baseUrl: str(embeddings.baseUrl) } : {}),
    };
  } catch {
    // A malformed config must not break retrieval; fall back to the default.
    return {};
  }
}

export function embeddingOptionsFromSettings(settings: ProjectEmbeddingSettings): EmbeddingResolveOptions {
  if (settings.provider === 'ollama' && settings.endpoint) {
    return {
      ollamaEndpoint: settings.endpoint,
      ...(settings.model ? { ollamaModel: settings.model } : {}),
    };
  }
  if (settings.provider === 'openai' && settings.apiKey) {
    return {
      openaiApiKey: settings.apiKey,
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
    };
  }
  return {};
}

const cache = new Map<string, { key: string; provider: EmbeddingProvider }>();

/**
 * The embedding provider for a project: its own settings first, then the
 * environment, then the deterministic hashed default.
 *
 * Environment stays supported so an operator can point a whole deployment at
 * one embedder without editing each project, but an explicit project setting
 * wins because that is the one a user chose in the product.
 */
export function projectEmbeddingProvider(
  projectRoot: string,
  env: Record<string, string | undefined> = process.env,
): EmbeddingProvider {
  const settings = readProjectEmbeddingSettings(projectRoot);
  const fromSettings = embeddingOptionsFromSettings(settings);
  const options = Object.keys(fromSettings).length > 0 ? fromSettings : embeddingOptionsFromEnv(env);
  const key = JSON.stringify({
    e: options.ollamaEndpoint ?? '',
    om: options.ollamaModel ?? '',
    // Never cache-key on the raw secret.
    k: options.openaiApiKey ? 'set' : '',
    m: options.model ?? '',
    b: options.baseUrl ?? '',
  });
  const hit = cache.get(projectRoot);
  if (hit?.key === key) return hit.provider;
  const provider = resolveEmbeddingProvider(options);
  cache.set(projectRoot, { key, provider });
  return provider;
}

/** True when the project is on the offline lexical fallback, not real semantics. */
export function isHashedEmbeddingProvider(provider: EmbeddingProvider): boolean {
  return provider.id.startsWith('hashed-token');
}

/** Settings changed — drop the memo so the next call re-resolves. */
export function clearProjectEmbeddingCache(projectRoot?: string): void {
  if (projectRoot) cache.delete(projectRoot);
  else cache.clear();
}
