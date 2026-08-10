import { describe, expect, it } from 'vitest';
import { APP_STUDIO_V2_STYLES } from './app-studio-v2-styles';

describe('App Studio 2.0 styles (UI-022, E2E-020)', () => {
  it('does not reuse the shared full-screen canvas-grid class', () => {
    expect(APP_STUDIO_V2_STYLES).not.toMatch(/(^|\n)\.canvas-grid\s*\{/);
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-page-grid { position:static;');
  });

  it('keeps source discovery, explicit add actions, and compact layout controls visible', () => {
    expect(APP_STUDIO_V2_STYLES).toContain('.source-search-primary');
    expect(APP_STUDIO_V2_STYLES).toContain('.used-sources-disclosure');
    expect(APP_STUDIO_V2_STYLES).toContain('.source-catalog-row');
    expect(APP_STUDIO_V2_STYLES).toContain('.source-add-view');
    expect(APP_STUDIO_V2_STYLES).not.toContain('.studio-add-steps');
    expect(APP_STUDIO_V2_STYLES).not.toContain('.source-prompt');
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-canvas-label button');
  });

  it('supports one responsive decision-first launcher without an overlapping policy row', () => {
    expect(APP_STUDIO_V2_STYLES).toContain('.dql-app-studio-home { display:grid;');
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-source-policy-row { display:grid;');
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-review-toggle');
    expect(APP_STUDIO_V2_STYLES).toContain('.dql-studio-v2-loading');
    expect(APP_STUDIO_V2_STYLES).toContain('@media (max-width:620px)');
  });

  it('uses one focused AI source review before the canvas is generated', () => {
    expect(APP_STUDIO_V2_STYLES).toContain('.dql-studio-v2.proposal-focus');
    expect(APP_STUDIO_V2_STYLES).toContain('.proposal-focus .studio-workspace');
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-ai-plan {');
    expect(APP_STUDIO_V2_STYLES).toContain('.proposal-source-picker');
    expect(APP_STUDIO_V2_STYLES).toContain('.proposal-source-list');
    expect(APP_STUDIO_V2_STYLES).toContain('.proposal-catalog-list');
    expect(APP_STUDIO_V2_STYLES).not.toContain('.studio-ai-understanding');
    expect(APP_STUDIO_V2_STYLES).toContain('.used-source-list');
    expect(APP_STUDIO_V2_STYLES).toContain('.source-review-lane');
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-actions .copilot');
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-copilot-panel');
  });

  it('presents publication blockers as a guided readiness checklist', () => {
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-readiness-card');
    expect(APP_STUDIO_V2_STYLES).toContain('.readiness-item');
    expect(APP_STUDIO_V2_STYLES).toContain('.readiness-actions');
  });

  it('shows a real loading state while newly added governed tiles auto-preview', () => {
    expect(APP_STUDIO_V2_STYLES).toContain('.preview-state.loading');
    expect(APP_STUDIO_V2_STYLES).toContain('.preview-loading-mark');
    expect(APP_STUDIO_V2_STYLES).toContain('.source-add-view:disabled');
    expect(APP_STUDIO_V2_STYLES).toContain('@media (prefers-reduced-motion:reduce)');
  });

  it('presents mapped dashboard filters with searchable controls and automatic refresh', () => {
    expect(APP_STUDIO_V2_STYLES).toContain('.filter-builder');
    expect(APP_STUDIO_V2_STYLES).toContain('.filter-mapping');
    expect(APP_STUDIO_V2_STYLES).toContain('.filter-scope-switch');
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-filter.dropdown');
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-filter-menu');
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-filter[aria-busy="true"]');
  });
});
