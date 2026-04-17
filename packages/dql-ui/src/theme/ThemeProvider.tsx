/**
 * ThemeProvider — applies the active DQL theme to its subtree by writing CSS
 * custom properties onto a wrapper element.
 *
 * Usage
 *
 *   <ThemeProvider theme="dark">
 *     <App />
 *   </ThemeProvider>
 *
 * The wrapper sets `data-theme="dark"` so tooling, Radix portals, and plain
 * CSS rules can target it. Components in the subtree read tokens via
 * `cssVar('surfaceBase')` — no context subscription needed, so theme
 * changes don't trigger re-renders.
 */
import * as React from 'react';
import { themes, themeToCssVars, type ThemeName, type ThemeTokens } from '../tokens/index.js';

interface ThemeContextValue {
  theme: ThemeName;
  tokens: ThemeTokens;
  setTheme: (t: ThemeName) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  /** Controlled theme name. If omitted, provider manages its own state starting at `defaultTheme`. */
  theme?: ThemeName;
  /** Initial theme when uncontrolled. Default: 'dark'. */
  defaultTheme?: ThemeName;
  /** Called when theme changes (for persistence). */
  onThemeChange?: (theme: ThemeName) => void;
  /** Apply tokens at :root instead of a wrapper div. Useful for full-app theming. */
  applyGlobal?: boolean;
  children: React.ReactNode;
}

export function ThemeProvider({
  theme: controlled,
  defaultTheme = 'dark',
  onThemeChange,
  applyGlobal = false,
  children,
}: ThemeProviderProps): React.ReactElement {
  const [internal, setInternal] = React.useState<ThemeName>(defaultTheme);
  const active = controlled ?? internal;
  const tokens = themes[active];

  const setTheme = React.useCallback(
    (t: ThemeName) => {
      if (controlled === undefined) setInternal(t);
      onThemeChange?.(t);
    },
    [controlled, onThemeChange],
  );

  // Apply to :root when requested — Radix portals escape our wrapper, so
  // global mode ensures popovers/dialogs pick up the same tokens.
  React.useEffect(() => {
    if (!applyGlobal) return;
    const vars = themeToCssVars(tokens);
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    root.setAttribute('data-theme', active);
    return () => {
      for (const k of Object.keys(vars)) root.style.removeProperty(k);
      root.removeAttribute('data-theme');
    };
  }, [applyGlobal, active, tokens]);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme: active, tokens, setTheme }),
    [active, tokens, setTheme],
  );

  const inlineStyle = applyGlobal ? undefined : (themeToCssVars(tokens) as React.CSSProperties);

  return (
    <ThemeContext.Provider value={value}>
      <div data-theme={active} style={inlineStyle}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

/** Access the active theme. Only needed for toggling; styles should use `cssVar()` directly. */
export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside a <ThemeProvider>');
  }
  return ctx;
}
