import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { themes } from '../../themes/notebook-theme';
import type * as ComposerModule from './AskComposerOptions';

let AskComposerOptions: typeof ComposerModule.AskComposerOptions;

beforeAll(async () => {
  // The API client reads window.location when it loads.
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
  ({ AskComposerOptions } = await import('./AskComposerOptions'));
});

const base = {
  t: themes.paper,
  thinkingMode: 'auto' as const,
  onThinkingMode: () => undefined,
  research: false,
  onResearch: () => undefined,
  researchRows: false,
  onResearchRows: () => undefined,
};

describe('the Ask composer controls', () => {
  it('show two quiet icons by default: no model chip, thinking label or database picker', () => {
    const markup = renderToStaticMarkup(createElement(AskComposerOptions, base));
    expect(markup).toContain('aria-label="Answer settings"');
    expect(markup).toContain('aria-label="Research mode"');
    expect(markup).not.toContain('>Thinking');
    expect(markup).not.toContain('<select');
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain('>Research<');
  });

  it('name Research beside its icon only while it is on', () => {
    const markup = renderToStaticMarkup(createElement(AskComposerOptions, { ...base, research: true }));
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('>Research<');
  });

  it('open into one panel with the model, a thinking choice and the Research options', () => {
    const closed = renderToStaticMarkup(createElement(AskComposerOptions, { ...base, thinkingMode: 'high', defaultOpen: true }));
    expect(closed).toContain('role="dialog"');
    expect(closed).toContain('No model connected');
    for (const label of ['Auto', 'Low', 'Medium', 'High']) expect(closed).toContain(`>${label}</button>`);
    expect(closed).toContain('aria-checked="true"');
    expect(closed).toContain('Cross-checks the number');
    expect(closed).toContain('role="switch"');
    expect(closed).not.toContain('redacted result rows');
    const researching = renderToStaticMarkup(createElement(AskComposerOptions, { ...base, research: true, defaultOpen: true }));
    expect(researching).toContain('Let Research tools read redacted result rows for this run');
  });
});
