import { describe, expect, it } from 'vitest';
import { askTraceRouteFromPathname } from './NotebookStore';

describe('Ask trace deep-link navigation (OBS-009)', () => {
  it('opens the trace catalog without retaining any trace or question data in navigation state', () => {
    expect(askTraceRouteFromPathname('/ask/traces')).toEqual({
      mainView: 'ask_observability',
    });
  });

  it('rehydrates only the decoded run ID from an addressable trace path', () => {
    expect(askTraceRouteFromPathname('/ask/traces/run%3Aoffice-42')).toEqual({
      mainView: 'ask_trace',
      runId: 'run:office-42',
    });
  });

  it('does not treat unrelated or nested paths as persisted trace state', () => {
    expect(askTraceRouteFromPathname('/ask')).toBeUndefined();
    expect(askTraceRouteFromPathname('/ask/traces/run-42/extra')).toBeUndefined();
  });
});
