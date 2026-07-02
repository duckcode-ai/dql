import { describe, expect, it } from 'vitest';
import {
  coerceReasoningEffort,
  clampReasoningEffort,
  bumpReasoningEffort,
  supportsReasoningEffort,
  geminiReasoningStyle,
  effortToThinkingBudget,
  isReasoningEffort,
} from './reasoning-effort.js';

describe('reasoning-effort helpers', () => {
  it('coerces untrusted input to a valid effort or undefined', () => {
    expect(coerceReasoningEffort('high')).toBe('high');
    expect(coerceReasoningEffort(' Medium ')).toBe('medium');
    expect(coerceReasoningEffort('LOW')).toBe('low');
    expect(coerceReasoningEffort('auto')).toBeUndefined();
    expect(coerceReasoningEffort('')).toBeUndefined();
    expect(coerceReasoningEffort(undefined)).toBeUndefined();
    expect(coerceReasoningEffort('xhigh')).toBeUndefined();
  });

  it('type-guards effort values', () => {
    expect(isReasoningEffort('low')).toBe(true);
    expect(isReasoningEffort('auto')).toBe(false);
    expect(isReasoningEffort(2)).toBe(false);
  });

  it('clamps a desired effort down to the ceiling but never up', () => {
    expect(clampReasoningEffort('high', 'low')).toBe('low');
    expect(clampReasoningEffort('high', 'medium')).toBe('medium');
    expect(clampReasoningEffort('low', 'high')).toBe('low'); // ceiling never raises
    expect(clampReasoningEffort('medium', 'medium')).toBe('medium');
  });

  it('bumps one level and saturates at high', () => {
    expect(bumpReasoningEffort('low')).toBe('medium');
    expect(bumpReasoningEffort('medium')).toBe('high');
    expect(bumpReasoningEffort('high')).toBe('high');
  });

  it('detects Claude reasoning-capable models only (Opus 4.5+, Sonnet 4.6+/5+, Fable 5+)', () => {
    expect(supportsReasoningEffort('claude', 'claude-opus-4-5')).toBe(true);
    expect(supportsReasoningEffort('claude', 'claude-opus-4-7')).toBe(true);
    expect(supportsReasoningEffort('claude', 'claude-opus-4-8')).toBe(true);
    expect(supportsReasoningEffort('claude', 'claude-sonnet-4-6')).toBe(true);
    expect(supportsReasoningEffort('claude', 'claude-sonnet-5')).toBe(true);
    expect(supportsReasoningEffort('claude', 'claude-fable-5')).toBe(true);
    // `:thinking` virtual ids are always capable.
    expect(supportsReasoningEffort('claude', 'claude-sonnet-4-5-20250929:thinking')).toBe(true);
    // Sonnet 4.5 and Haiku 4.5 REJECT output_config.effort — must not match (would 400).
    expect(supportsReasoningEffort('claude', 'claude-sonnet-4-5-20250929')).toBe(false);
    expect(supportsReasoningEffort('claude', 'claude-haiku-4-5')).toBe(false);
    expect(supportsReasoningEffort('claude', 'claude-haiku-4-5-20251001')).toBe(false);
    expect(supportsReasoningEffort('claude', 'claude-3-5-sonnet')).toBe(false);
    expect(supportsReasoningEffort('claude', undefined)).toBe(false);
  });

  it('detects OpenAI reasoning-capable models only', () => {
    expect(supportsReasoningEffort('openai', 'o1')).toBe(true);
    expect(supportsReasoningEffort('openai', 'o3-mini')).toBe(true);
    expect(supportsReasoningEffort('openai', 'gpt-5')).toBe(true);
    expect(supportsReasoningEffort('openai', 'gpt-5.1')).toBe(true);
    expect(supportsReasoningEffort('openai', 'gpt-4.1-mini')).toBe(false);
    expect(supportsReasoningEffort('openai', 'gpt-4o')).toBe(false);
  });

  it('detects Gemini reasoning style by generation', () => {
    expect(geminiReasoningStyle('gemini-2.5-pro')).toBe('budget');
    expect(geminiReasoningStyle('gemini-3-pro')).toBe('level');
    expect(geminiReasoningStyle('gemini-1.5-flash')).toBeNull();
    expect(supportsReasoningEffort('gemini', 'gemini-2.5-pro')).toBe(true);
    expect(supportsReasoningEffort('gemini', 'gemini-1.5-flash')).toBe(false);
  });

  it('never treats ollama as reasoning-capable', () => {
    expect(supportsReasoningEffort('ollama', 'llama3.1')).toBe(false);
  });

  it('maps effort to an escalating thinking budget, floored at 1024', () => {
    expect(effortToThinkingBudget('low')).toBe(2048);
    expect(effortToThinkingBudget('medium')).toBe(8192);
    expect(effortToThinkingBudget('high')).toBe(16384);
    // Kept strictly below maxTokens with headroom, and never under the 1024 floor.
    expect(effortToThinkingBudget('high', 4000)).toBe(3200);
    expect(effortToThinkingBudget('high', 1000)).toBe(1024);
  });
});
