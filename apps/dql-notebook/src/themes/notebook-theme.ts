// v1.3 Track 1 — legacy theme shim.
//
// This file used to own hard-coded DARK/LIGHT color objects. Every
// component read `t.appBg` and friends. As we migrate to Luna tokens
// (packages/dql-ui/src/styles/tokens.css) via the Tailwind 4 @theme
// bridge in globals.css, the canonical source of color is CSS vars on
// <html data-theme="…">.
//
// Rather than rewrite every component's inline-style reads in a single
// PR, we keep the legacy Theme API as a runtime Proxy: every property
// access resolves the matching Luna CSS variable on the document root.
// A consumer doing `themes[mode].appBg` now returns whatever
// `--color-bg-primary` resolves to under the active data-theme.
//
// The shim is intentionally "one source of truth" — both DARK and
// LIGHT proxies read from the same root. The app only reads the proxy
// matching the current themeMode, so there is no cross-contamination.
// Delete this file in the final v1.3 Track 8 PR once every component
// has migrated to Tailwind utility classes (`bg-bg-primary` etc).

export type Theme = {
  appBg: string;
  sidebarBg: string;
  activityBarBg: string;
  headerBg: string;
  headerBorder: string;
  cellBg: string;
  cellBorder: string;
  cellBorderActive: string;
  cellBorderRunning: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  editorBg: string;
  editorBorder: string;
  tableBorder: string;
  tableHeaderBg: string;
  tableRowHover: string;
  accent: string;
  accentHover: string;
  success: string;
  error: string;
  warning: string;
  btnBg: string;
  btnBorder: string;
  btnHover: string;
  sidebarItemHover: string;
  sidebarItemActive: string;
  scrollbarThumb: string;
  modalBg: string;
  modalOverlay: string;
  inputBg: string;
  inputBorder: string;
  pillBg: string;
  font: string;
  fontMono: string;
  fontSerif: string;
};

// Map each legacy Theme key to the canonical Luna CSS var declared in
// packages/dql-ui/src/styles/tokens.css. Values with no direct Luna
// analogue fall back to the closest semantic token.
const VAR_FOR: Record<keyof Theme, string> = {
  appBg: '--color-bg-primary',
  sidebarBg: '--color-bg-secondary',
  activityBarBg: '--color-bg-sunken',
  headerBg: '--color-bg-toolbar',
  headerBorder: '--color-border-primary',
  cellBg: '--color-bg-card',
  cellBorder: '--color-border-subtle',
  cellBorderActive: '--color-accent-blue',
  cellBorderRunning: '--color-status-success',
  textPrimary: '--color-text-primary',
  textSecondary: '--color-text-secondary',
  textMuted: '--color-text-tertiary',
  editorBg: '--color-bg-sunken',
  editorBorder: '--color-border-subtle',
  tableBorder: '--color-border-subtle',
  tableHeaderBg: '--color-bg-secondary',
  tableRowHover: '--color-bg-hover',
  accent: '--color-accent-blue',
  accentHover: '--color-accent-blue',
  success: '--color-status-success',
  error: '--color-status-error',
  warning: '--color-status-warning',
  btnBg: '--color-bg-tertiary',
  btnBorder: '--color-border-primary',
  btnHover: '--color-bg-hover',
  sidebarItemHover: '--color-bg-hover',
  sidebarItemActive: '--color-bg-active',
  scrollbarThumb: '--color-border-secondary',
  modalBg: '--color-bg-secondary',
  modalOverlay: '--color-bg-overlay',
  inputBg: '--color-bg-sunken',
  inputBorder: '--color-border-subtle',
  pillBg: '--color-bg-tertiary',
  font: '--font-ui',
  fontMono: '--font-mono',
  fontSerif: '--font-ui',
};

// Fallback values used for SSR / build-time access where `document` is
// not available. Mirror obsidian theme so server-rendered output does
// not flash a wrong-color frame.
const FALLBACK: Record<keyof Theme, string> = {
  appBg: '#0f1219',
  sidebarBg: '#151922',
  activityBarBg: '#0a0c11',
  headerBg: '#0f1219',
  headerBorder: 'rgba(255,255,255,0.08)',
  cellBg: '#151922',
  cellBorder: 'rgba(255,255,255,0.05)',
  cellBorderActive: '#5b8cff',
  cellBorderRunning: '#10b981',
  textPrimary: '#e7ebf2',
  textSecondary: '#9aa3b4',
  textMuted: '#6b7385',
  editorBg: '#0a0c11',
  editorBorder: 'rgba(255,255,255,0.05)',
  tableBorder: 'rgba(255,255,255,0.05)',
  tableHeaderBg: '#151922',
  tableRowHover: '#1c212d',
  accent: '#5b8cff',
  accentHover: '#5b8cff',
  success: '#10b981',
  error: '#ef4444',
  warning: '#f5b544',
  btnBg: '#1c212d',
  btnBorder: 'rgba(255,255,255,0.08)',
  btnHover: '#1c212d',
  sidebarItemHover: '#1c212d',
  sidebarItemActive: 'rgba(91,140,255,0.14)',
  scrollbarThumb: 'rgba(255,255,255,0.14)',
  modalBg: '#151922',
  modalOverlay: 'rgba(0,0,0,0.5)',
  inputBg: '#0a0c11',
  inputBorder: 'rgba(255,255,255,0.05)',
  pillBg: '#1c212d',
  font: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  fontMono: "'JetBrains Mono', 'SFMono-Regular', Menlo, Monaco, Consolas, monospace",
  fontSerif: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif",
};

function resolveVar(key: keyof Theme): string {
  if (typeof document === 'undefined') return FALLBACK[key];
  const cssVar = VAR_FOR[key];
  const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  return value || FALLBACK[key];
}

function makeThemeProxy(): Theme {
  return new Proxy({} as Theme, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (!(prop in VAR_FOR)) return undefined;
      return resolveVar(prop as keyof Theme);
    },
    has(_target, prop) {
      return typeof prop === 'string' && prop in VAR_FOR;
    },
    ownKeys() {
      return Object.keys(VAR_FOR);
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== 'string' || !(prop in VAR_FOR)) return undefined;
      return { enumerable: true, configurable: true, value: resolveVar(prop as keyof Theme) };
    },
  });
}

// One proxy — every consumer reads from the same document root. v1.3.2
// consolidated the Luna set down to three themes (obsidian / paper / white).
// Legacy names (`dark`/`light`/`midnight`/`arctic`) stay in the union so
// persisted state from v1.2 and early v1.3 releases still resolves cleanly.
const PROXY: Theme = makeThemeProxy();
export const DARK: Theme = PROXY;
export const LIGHT: Theme = PROXY;
export type ThemeMode = 'obsidian' | 'paper' | 'white' | 'dark' | 'light' | 'midnight' | 'arctic';
export const themes: Record<ThemeMode, Theme> = {
  obsidian: PROXY,
  paper: PROXY,
  white: PROXY,
  dark: PROXY,
  light: PROXY,
  midnight: PROXY,
  arctic: PROXY,
};
