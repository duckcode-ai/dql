import type { AgentMessage, AgentProvider, ProviderRunOptions } from './types.js';

/**
 * One JSON object back from any provider.
 *
 * Providers that can constrain their output (the subscription CLI with a
 * schema, native tool calling) get the schema; the rest are asked for JSON
 * and parsed. Either way the caller receives the first balanced JSON object
 * in the reply, or a typed reason it could not.
 */
export interface StructuredReply {
  raw: string;
  json?: unknown;
  error?: 'empty' | 'unparseable' | 'provider_error';
  detail?: string;
}

export function extractFirstJsonObject(text: string): unknown | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1] ?? '', text];
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    if (start < 0) continue;
    let depth = 0;
    let quote = false;
    for (let index = start; index < candidate.length; index += 1) {
      const char = candidate[index];
      if (quote) {
        if (char === '\\') index += 1;
        else if (char === '"') quote = false;
        continue;
      }
      if (char === '"') quote = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(candidate.slice(start, index + 1)); } catch { break; }
        }
      }
    }
  }
  return undefined;
}

export async function generateStructured(
  provider: AgentProvider,
  messages: AgentMessage[],
  schema: Record<string, unknown>,
  options: ProviderRunOptions = {},
): Promise<StructuredReply> {
  let raw: string;
  try {
    raw = await provider.generate(messages, { temperature: 0, ...options, responseJsonSchema: schema });
  } catch (error) {
    return { raw: '', error: 'provider_error', detail: error instanceof Error ? error.message : String(error) };
  }
  if (!raw || !raw.trim()) return { raw: raw ?? '', error: 'empty' };
  const json = extractFirstJsonObject(raw);
  if (json === undefined) return { raw, error: 'unparseable', detail: raw.slice(0, 300) };
  return { raw, json };
}
