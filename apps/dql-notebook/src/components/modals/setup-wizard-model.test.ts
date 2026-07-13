import { describe, expect, it } from 'vitest';
import { normalizeOnboardingJob, onboardingErrorView, resolveDbtResumeStage } from './setup-wizard-model';

function apiError(code: string, message = 'offline'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('dbt-first setup wizard model', () => {
  it('resumes at the first incomplete governed step', () => {
    expect(resolveDbtResumeStage()).toBe('connect');
    expect(resolveDbtResumeStage({ dbt: { manifestFound: true } })).toBe('inspect');
    expect(resolveDbtResumeStage({ dbt: { manifestFound: true }, modeling: { enabled: true } })).toBe('domains');
    expect(resolveDbtResumeStage({ modeling: { snapshotState: 'ready' }, domains: { count: 0 } })).toBe('domains');
    expect(resolveDbtResumeStage({ modeling: { snapshotState: 'ready' }, domains: { count: 2 } })).toBe('domain-model');
  });

  it('gives exact, non-copying manifest remediation', () => {
    const view = onboardingErrorView(apiError('DBT_MANIFEST_MISSING', 'missing'), '../jaffle-shop', 'target/manifest.json');

    expect(view.title).toBe('dbt manifest.json is missing');
    expect(view.command).toBe('cd "../jaffle-shop" && dbt parse');
    expect(view.message).toContain('without importing or copying dbt semantics');
  });

  it('treats unavailable AI and warehouse access as optional capabilities', () => {
    expect(onboardingErrorView(apiError('AI_PROVIDER_UNAVAILABLE'), '.').optional).toBe(true);
    expect(onboardingErrorView(apiError('WAREHOUSE_UNAVAILABLE'), '.').message).toContain('certification');
  });

  it('normalizes both wrapped and raw job responses', () => {
    expect(normalizeOnboardingJob({
      job: { id: 'one', status: 'completed' },
    })).toMatchObject({ id: 'one', status: 'completed' });
    expect(normalizeOnboardingJob({
      id: 'two', status: 'running', progress: 30,
    })).toMatchObject({ id: 'two', status: 'running', progress: 30 });
  });
});
