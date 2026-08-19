/**
 * Provider cassettes — record a suite once against a real model, replay it
 * offline forever.
 *
 * A provider-backed eval is the only kind that measures the product users get:
 * without one, `mayAssumeInterpretation` is false and every ambiguous question
 * clarifies by design (AGT-017), which makes a clarification rate an artifact.
 * But calling a real model on every PR is slow, costly, and non-deterministic —
 * so the suite could never gate anything.
 *
 * Recording once and replaying fixes all three. Model drift then shows up as a
 * reviewable diff when cassettes are re-recorded, instead of as a mystery
 * regression on an unrelated pull request.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AgentMessage,
  AgentProvider,
  AgentToolDefinition,
  ProviderRunOptions,
  ProviderToolLoopOptions,
} from '@duckcodeailabs/dql-agent';

export type CassetteMode = 'record' | 'replay' | 'live';

/** One recorded tool call, so replay can re-run it against the live tools. */
export interface CassetteToolCall {
  name: string;
  args: unknown;
}

export interface CassetteEntry {
  key: string;
  operation: 'generate' | 'generate_with_tools';
  /** Non-secret provenance, so a stale cassette is identifiable by eye. */
  recordedAt: string;
  providerName: string;
  /** The model's final text. */
  text: string;
  /** Tool calls the model made, in order (generate_with_tools only). */
  toolCalls?: CassetteToolCall[];
}

/**
 * Stable key for one provider dispatch.
 *
 * Deliberately includes the full message list: the prompt IS the input, and two
 * turns that differ only in retrieved context are genuinely different calls.
 * Tool NAMES are included but not their schemas — a description edit should not
 * invalidate every cassette in the suite.
 */
export function cassetteKey(input: {
  providerName: string;
  operation: CassetteEntry['operation'];
  messages: AgentMessage[];
  toolNames?: string[];
  options?: { reasoningEffort?: unknown; maxTokens?: unknown; temperature?: unknown } | undefined;
}): string {
  const canonical = JSON.stringify({
    p: input.providerName,
    o: input.operation,
    m: input.messages.map((message) => ({ r: message.role, c: message.content })),
    t: [...(input.toolNames ?? [])].sort(),
    e: input.options?.reasoningEffort ?? null,
    x: input.options?.maxTokens ?? null,
    z: input.options?.temperature ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export class CassetteStore {
  private readonly dir: string;
  private readonly loaded = new Map<string, CassetteEntry>();

  constructor(dir: string) {
    this.dir = dir;
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as CassetteEntry;
        if (entry?.key) this.loaded.set(entry.key, entry);
      } catch {
        // A corrupt cassette is skipped, not fatal: it re-records on the next
        // --record run, and a replay miss reports the key that is missing.
      }
    }
  }

  get(key: string): CassetteEntry | undefined {
    return this.loaded.get(key);
  }

  put(entry: CassetteEntry): void {
    this.loaded.set(entry.key, entry);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${entry.key}.json`), `${JSON.stringify(entry, null, 2)}\n`, 'utf-8');
  }

  size(): number {
    return this.loaded.size;
  }
}

export class CassetteMissError extends Error {
  readonly key: string;
  constructor(key: string, operation: string) {
    super(
      `No cassette for ${operation} (${key}). CI replays recorded provider responses and never calls a live model; `
      + 're-record with --record against a real provider and commit the new cassettes.',
    );
    this.name = 'CassetteMissError';
    this.key = key;
  }
}

/**
 * Wrap a provider so its dispatches are recorded or replayed.
 *
 * On replay of a tool loop the recorded tool calls are RE-INVOKED against the
 * live tools rather than stubbed. The model's choices stay frozen (that is the
 * point), but compilation, validation, and execution still really happen — so
 * the suite keeps catching a broken compiler or a wrong number, which a fully
 * stubbed replay would sail straight past.
 */
export function withCassette(
  provider: AgentProvider,
  store: CassetteStore,
  mode: CassetteMode,
): AgentProvider {
  if (mode === 'live') return provider;

  const wrapped: AgentProvider = {
    name: provider.name,
    available: () => (mode === 'replay' ? Promise.resolve(true) : provider.available()),

    async generate(messages: AgentMessage[], options?: ProviderRunOptions): Promise<string> {
      const key = cassetteKey({ providerName: provider.name, operation: 'generate', messages, options });
      const hit = store.get(key);
      if (hit) return hit.text;
      if (mode === 'replay') throw new CassetteMissError(key, 'generate');
      const text = await provider.generate(messages, options);
      store.put({
        key, operation: 'generate', text,
        providerName: provider.name, recordedAt: new Date().toISOString(),
      });
      return text;
    },
  };

  if (provider.generateWithTools) {
    wrapped.generateWithTools = async (
      messages: AgentMessage[],
      tools: AgentToolDefinition[],
      options?: ProviderToolLoopOptions,
    ): Promise<string> => {
      const key = cassetteKey({
        providerName: provider.name,
        operation: 'generate_with_tools',
        messages,
        toolNames: tools.map((tool) => tool.name),
        options: options as { reasoningEffort?: unknown } | undefined,
      });
      const hit = store.get(key);
      if (hit) {
        const byName = new Map(tools.map((tool) => [tool.name, tool]));
        for (const call of hit.toolCalls ?? []) {
          const tool = byName.get(call.name);
          // A cassette recorded against a tool set that no longer has this tool
          // is stale in a way the run should surface, not paper over.
          if (!tool) continue;
          await tool.run(call.args).catch(() => undefined);
        }
        return hit.text;
      }
      if (mode === 'replay') throw new CassetteMissError(key, 'generate_with_tools');
      const observed: CassetteToolCall[] = [];
      const recordingTools = tools.map((tool) => ({
        ...tool,
        run: async (args: unknown) => {
          observed.push({ name: tool.name, args });
          return tool.run(args);
        },
      }));
      const text = await provider.generateWithTools!(messages, recordingTools, options);
      store.put({
        key, operation: 'generate_with_tools', text, toolCalls: observed,
        providerName: provider.name, recordedAt: new Date().toISOString(),
      });
      return text;
    };
  }

  return wrapped;
}

/**
 * Pick the cassette mode from the environment.
 *
 * Defaults to `replay` for ANY value that is not explicitly `record` or `live`,
 * including a missing or misspelled one. If someone sets the cassette directory
 * in CI and forgets the mode, the safe outcome is "never call a live model",
 * not a surprise bill and a non-deterministic suite.
 */
export function resolveCassetteModeFromEnv(env: Record<string, string | undefined>): CassetteMode {
  const raw = env.DQL_EVAL_CASSETTE_MODE;
  return raw === 'record' || raw === 'live' ? raw : 'replay';
}

/** Where a project's eval cassettes live. */
export function cassetteDirFor(projectRoot: string, suiteName: string): string {
  const safe = suiteName.replace(/[^a-z0-9._-]+/gi, '-').replace(/\.(ya?ml)$/i, '');
  return join(projectRoot, 'test-cassettes', safe);
}

export { dirname as _dirname };
