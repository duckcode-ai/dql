import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as PanelModule from './UnifiedAgentRunPanel';

let panel: typeof PanelModule;

beforeAll(async () => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost', pathname: '/' } });
  panel = await import('./UnifiedAgentRunPanel');
});

describe('a Research investigation in the Ask panel', () => {
  it('the inspector explains an investigation program by program, not as one answer', () => {
    const tabs = panel.askInspectorTabsForState({ analytical: false, blocked: false, hasDql: true, hasSql: true, hasLineage: false, pipeline: true, hasChecks: true, investigation: true });
    expect(tabs.map((tab) => tab.label)).toEqual(['How it was researched', 'DQL', 'SQL', 'Trust & steps']);
    const answer = panel.askInspectorTabsForState({ analytical: false, blocked: false, hasDql: true, hasSql: true, hasLineage: false, pipeline: true, hasChecks: true });
    expect(answer[0]!.label).toBe('How it answered');
  });

  it('describes an investigation as review-required Research, never as an AI-generated answer', () => {
    const payload = { kind: 'investigation', investigation: { version: 1, frame: { windows: {} }, headline: {} }, result: { columns: ['period', 'revenue'], rows: [{ period: 'August 2025', revenue: 1 }], rowCount: 1, executionTime: 0 } };
    const meta = panel.askArtifactMeta({ id: 'research', kind: 'research_run', title: 'Investigation of revenue', trustState: 'review_required', payload } as never, payload);
    expect(meta).toBe('Research · 1 row · review required');
    const draft = { result: { columns: ['x'], rows: [{ x: 1 }], rowCount: 1, executionTime: 12 } };
    expect(panel.askArtifactMeta({ id: 'answer', kind: 'answer', title: 'AI-drafted answer', trustState: 'review_required', payload: draft } as never, draft)).toBe('Table · 1 row · 12ms · AI-generated');
  });

  it('names what Research is doing while it runs, and leaves an ordinary Ask run\'s words alone', () => {
    const step = (phase: string, title: string) => ({ phase, title, state: 'done', at: 1 }) as never;
    expect(panel.askStoryActiveLabel([step('frame', 'Started from the answer being investigated')])).toBe('Framing the change to investigate');
    expect(panel.askStoryActiveLabel([step('frame', 'Comparing Revenue in August 2025 with July 2025')])).toBe('Measuring the change');
    expect(panel.askStoryActiveLabel([step('read', 'Asked the AI to read the question')])).toBe('Checking the reading against the project');
  });
});
