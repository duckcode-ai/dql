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
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-ai-activity-label');
  });

  it('keeps the narrow Sources toolbar on two non-overlapping rows', () => {
    expect(APP_STUDIO_V2_STYLES).toContain('.source-catalog-toolbar { min-width:0; display:grid; grid-template-columns:minmax(0,1fr);');
    expect(APP_STUDIO_V2_STYLES).toContain('.source-view-tabs { min-width:0; width:100%;');
    expect(APP_STUDIO_V2_STYLES).toContain('grid-template-columns:repeat(4,minmax(0,1fr))');
    expect(APP_STUDIO_V2_STYLES).toContain('.source-catalog-toolbar > small { min-width:0; justify-self:end;');
  });

  it('uses one toolbar publish control with passive fix-count styling', () => {
    expect(APP_STUDIO_V2_STYLES).not.toContain('.review-state');
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-actions .publish small');
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

  it('keeps the desktop inspector scrollable and shrink-safe without changing the compact overlay', () => {
    expect(APP_STUDIO_V2_STYLES).toContain('grid-template-columns:300px minmax(0,1fr) clamp(280px,24vw,360px)');
    expect(APP_STUDIO_V2_STYLES).toContain('overflow-y:auto; overflow-x:hidden;');
    expect(APP_STUDIO_V2_STYLES).toContain('.inspector-body { min-width:0; max-width:100%;');
    expect(APP_STUDIO_V2_STYLES).toContain('.inspector-body input, .inspector-body textarea, .inspector-body select, .inspector-body button { min-width:0; max-width:100%;');
    expect(APP_STUDIO_V2_STYLES).toContain('overflow-wrap:anywhere;');
    expect(APP_STUDIO_V2_STYLES).toContain('@media (max-width:1240px)');
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-right.has-selection { display:block; position:fixed;');
  });
});
