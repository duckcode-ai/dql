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

  it('names what Research is doing while it runs, and leaves an ordinary Ask run\'s words alone', () => {
    const step = (phase: string, title: string) => ({ phase, title, state: 'done', at: 1 }) as never;
    expect(panel.askStoryActiveLabel([step('frame', 'Started from the answer being investigated')])).toBe('Framing the change to investigate');
    expect(panel.askStoryActiveLabel([step('frame', 'Comparing Revenue in August 2025 with July 2025')])).toBe('Measuring the change');
    expect(panel.askStoryActiveLabel([step('read', 'Asked the AI to read the question')])).toBe('Checking the reading against the project');
  });
});
