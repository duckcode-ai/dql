import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_STUDIO_V2_STYLES } from './app-studio-v2-styles';
import { APP_STYLES } from './app-styles';

/**
 * App Studio and the App reader share one type and colour system (RFC 0008,
 * step 2): a fixed type scale, three weights, three radii plus pills, and
 * status colours only from theme tokens, so dark mode and the brand follow.
 */
const TYPE_SCALE = [11, 12, 13, 14, 16, 20, 24, 32, 40];
const WEIGHTS = [400, 500, 600];
const RADII = [4, 8, 12, 99, 999];

const INLINE_SOURCES = ['DashboardRenderer.tsx', 'AppBuildProposalPanel.tsx', 'PersonaSwitcher.tsx', 'AppStudioV2.tsx', 'AppsView.tsx']
  .map((file) => [file, readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8')] as const);

const numbers = (css: string, pattern: RegExp) => [...css.matchAll(pattern)].map((match) => Number(match[1]));

describe.each([
  ['App Studio', APP_STUDIO_V2_STYLES],
  ['App reader', APP_STYLES],
])('%s styles', (_name, css) => {
  it('stays on the type scale', () => {
    const sizes = new Set([
      ...numbers(css, /font-size:\s?(\d+(?:\.\d+)?)px/g),
      ...numbers(css, /font:\s?\d{3} (\d+(?:\.\d+)?)px/g),
    ]);
    expect([...sizes].filter((size) => !TYPE_SCALE.includes(size))).toEqual([]);
  });

  it('uses only regular, medium and semibold weights', () => {
    const weights = new Set([
      ...numbers(css, /font-weight:\s?(\d{3})/g),
      ...numbers(css, /font:\s?(\d{3}) /g),
    ]);
    expect([...weights].filter((weight) => !WEIGHTS.includes(weight))).toEqual([]);
  });

  it('uses the shared corner radii', () => {
    const radii = new Set(
      [...css.matchAll(/border-radius:\s?([^;}]+)/g)]
        .flatMap((match) => [...match[1].matchAll(/(\d+(?:\.\d+)?)px/g)].map((value) => Number(value[1])))
        .filter((value) => value > 0),
    );
    expect([...radii].filter((radius) => !RADII.includes(radius))).toEqual([]);
  });

  it('takes status colours from theme tokens and uses the real font token', () => {
    expect(css).not.toMatch(/(?<!, )#(d97706|a16207|16a34a|15803d|dc2626|b91c1c)\b/i);
    expect(css).not.toContain('--font-sans');
  });
});

describe('inline App styles', () => {
  it.each(INLINE_SOURCES)('%s keeps inline type on the scale', (_file, source) => {
    const weights = [...source.matchAll(/fontWeight: ?(\d{3})\b/g)].map((match) => Number(match[1]));
    const sizes = [...source.matchAll(/fontSize: ?(\d+(?:\.\d+)?)(?![\d.])/g)].map((match) => Number(match[1]));
    expect(weights.filter((weight) => !WEIGHTS.includes(weight))).toEqual([]);
    expect(sizes.filter((size) => !TYPE_SCALE.includes(size))).toEqual([]);
  });
});
