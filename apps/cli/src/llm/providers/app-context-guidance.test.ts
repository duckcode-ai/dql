import { describe, expect, it } from 'vitest';
import { renderAppContextGuidance } from './provider-runner.js';

describe('the App an answer is asked in is bounded guidance, not a prompt dump', () => {
  const app = { app: { name: 'Revenue Review', domain: 'commerce', audience: 'executives', businessOutcome: 'decide the Q4 plan' }, focus: { blockId: 'monthly_revenue' }, drafts: [{ name: 'draft one', sql: 'SELECT 1' }, { name: 'draft two', sql: 'SELECT 2' }, { name: 'draft three', sql: 'SELECT 3' }] };
  it('names the app, its domain, audience, outcome, focus and at most two drafts — never their SQL', () => {
    const text = renderAppContextGuidance(app)!;
    expect(text).toContain('Asked inside the App "Revenue Review" (domain commerce).');
    expect(text).toContain('Focused block: monthly_revenue.');
    expect(text).toContain('draft one, draft two');
    expect(text).not.toContain('draft three');
    expect(text).not.toContain('SELECT');
    expect(text.length).toBeLessThanOrEqual(600);
  });
  it('is capped, and absent without an app name', () => {
    expect(renderAppContextGuidance({ ...app, app: { ...app.app, businessOutcome: 'x'.repeat(2000) } }, 300)!.length).toBeLessThanOrEqual(300);
    expect(renderAppContextGuidance({ app: {} })).toBeUndefined();
    expect(renderAppContextGuidance(null)).toBeUndefined();
  });
});
