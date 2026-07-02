import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getEffectiveProviderConfig,
  listProviderSettings,
  saveProviderSettings,
} from './provider-settings.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dql-provider-settings-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.ANTHROPIC_REASONING_EFFORT;
});

describe('provider reasoning-effort settings', () => {
  it('defaults to auto (no ceiling) when unset', () => {
    const cfg = getEffectiveProviderConfig(root, 'anthropic');
    expect(cfg.reasoningEffort).toBeUndefined();
    const redacted = listProviderSettings(root).find((p) => p.id === 'anthropic')!;
    expect(redacted.reasoningEffort).toBe('auto');
  });

  it('persists an explicit ceiling and reads it back', () => {
    saveProviderSettings(root, { id: 'anthropic', apiKey: 'k', reasoningEffort: 'medium' });
    expect(getEffectiveProviderConfig(root, 'anthropic').reasoningEffort).toBe('medium');
    expect(listProviderSettings(root).find((p) => p.id === 'anthropic')!.reasoningEffort).toBe('medium');
  });

  it("clears the ceiling back to auto when saved as 'auto'", () => {
    saveProviderSettings(root, { id: 'openai', apiKey: 'k', reasoningEffort: 'high' });
    expect(getEffectiveProviderConfig(root, 'openai').reasoningEffort).toBe('high');
    saveProviderSettings(root, { id: 'openai', reasoningEffort: 'auto' });
    expect(getEffectiveProviderConfig(root, 'openai').reasoningEffort).toBeUndefined();
  });

  it('leaves the ceiling unchanged when reasoningEffort is omitted on save', () => {
    saveProviderSettings(root, { id: 'gemini', apiKey: 'k', reasoningEffort: 'low' });
    saveProviderSettings(root, { id: 'gemini', model: 'gemini-2.5-pro' }); // unrelated edit
    expect(getEffectiveProviderConfig(root, 'gemini').reasoningEffort).toBe('low');
  });

  it('falls back to the provider env override when nothing is stored', () => {
    process.env.ANTHROPIC_REASONING_EFFORT = 'high';
    expect(getEffectiveProviderConfig(root, 'anthropic').reasoningEffort).toBe('high');
  });

  it('surfaces model reasoning-capability so the UI can show/hide the control', () => {
    // Default Claude model reasons; a non-reasoning model turns it off.
    saveProviderSettings(root, { id: 'anthropic', apiKey: 'k', model: 'claude-opus-4-7' });
    expect(listProviderSettings(root).find((p) => p.id === 'anthropic')!.supportsReasoningEffort).toBe(true);
    saveProviderSettings(root, { id: 'openai', apiKey: 'k', model: 'gpt-4.1-mini' });
    expect(listProviderSettings(root).find((p) => p.id === 'openai')!.supportsReasoningEffort).toBe(false);
    // Local + subscription providers never expose the control.
    expect(listProviderSettings(root).find((p) => p.id === 'ollama')!.supportsReasoningEffort).toBe(false);
    expect(listProviderSettings(root).find((p) => p.id === 'claude-code')!.supportsReasoningEffort).toBe(false);
  });
});
