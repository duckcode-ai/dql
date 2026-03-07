import type { ChartTheme } from '../themes/types.js';

export function getSeriesColor(theme: ChartTheme, index: number): string {
  return theme.palette[index % theme.palette.length];
}

export function getSeriesColors(theme: ChartTheme, count: number): string[] {
  return Array.from({ length: count }, (_, i) => getSeriesColor(theme, i));
}

export function withOpacity(hex: string, opacity: number): string {
  if (hex.startsWith('rgba')) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}
