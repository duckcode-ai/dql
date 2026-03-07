export type { ThemeConfig } from './theme-types.js';
export { lightTheme } from './light.js';
export { darkTheme } from './dark.js';
export { corporateTheme } from './corporate.js';
export { minimalTheme } from './minimal.js';
export { colorfulTheme } from './colorful.js';

import { lightTheme } from './light.js';
import { darkTheme } from './dark.js';
import { corporateTheme } from './corporate.js';
import { minimalTheme } from './minimal.js';
import { colorfulTheme } from './colorful.js';
import type { ThemeConfig } from './theme-types.js';

const themeRegistry: Map<string, ThemeConfig> = new Map([
  ['light', lightTheme],
  ['dark', darkTheme],
  ['corporate', corporateTheme],
  ['minimal', minimalTheme],
  ['colorful', colorfulTheme],
]);

export function getTheme(name?: string): ThemeConfig {
  if (!name) return lightTheme;
  return themeRegistry.get(name) ?? lightTheme;
}

export function registerTheme(theme: ThemeConfig): void {
  themeRegistry.set(theme.name, theme);
}

export function getAvailableThemes(): string[] {
  return [...themeRegistry.keys()];
}
