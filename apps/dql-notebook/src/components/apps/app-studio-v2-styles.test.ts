import { describe, expect, it } from 'vitest';
import { APP_STUDIO_V2_STYLES } from './app-studio-v2-styles';

describe('App Studio 2.0 styles (UI-022, E2E-020)', () => {
  it('does not reuse the shared full-screen canvas-grid class', () => {
    expect(APP_STUDIO_V2_STYLES).not.toMatch(/(^|\n)\.canvas-grid\s*\{/);
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-page-grid { position:static;');
  });

  it('keeps source addition and compact layout controls visibly represented', () => {
    expect(APP_STUDIO_V2_STYLES).toContain('.selected-source-card');
    expect(APP_STUDIO_V2_STYLES).toContain('.add-recommended');
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-canvas-label button');
  });

  it('supports one responsive decision-first launcher without an overlapping policy row', () => {
    expect(APP_STUDIO_V2_STYLES).toContain('.dql-app-studio-home { display:grid;');
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-source-policy-row { display:grid;');
    expect(APP_STUDIO_V2_STYLES).toContain('.studio-review-toggle');
    expect(APP_STUDIO_V2_STYLES).toContain('.dql-studio-v2-loading');
    expect(APP_STUDIO_V2_STYLES).toContain('@media (max-width:620px)');
  });
});
