import type { ChartTheme } from './types.js';

export const minimal: ChartTheme = {
  name: 'minimal',

  // Background & surface — ultra-clean
  background: '#fafafa',
  surface: '#ffffff',
  surfaceAlt: '#f5f5f5',

  // Borders
  border: '#e0e0e0',
  borderLight: '#eeeeee',

  // Text
  textPrimary: '#1a1a1a',
  textSecondary: '#4a4a4a',
  textMuted: '#8a8a8a',
  textDim: '#b0b0b0',

  // Accent — muted slate
  accent: '#475569',
  accentBg: 'rgba(71, 85, 105, 0.06)',

  // Semantic colors
  positive: '#16a34a',
  positiveBg: 'rgba(22, 163, 74, 0.06)',
  negative: '#dc2626',
  negativeBg: 'rgba(220, 38, 38, 0.06)',
  warning: '#ca8a04',
  warningBg: 'rgba(202, 138, 4, 0.06)',
  info: '#2563eb',
  infoBg: 'rgba(37, 99, 235, 0.06)',

  // Chart palette — muted, understated
  palette: [
    '#475569', // slate
    '#0891b2', // cyan
    '#16a34a', // green
    '#ca8a04', // amber
    '#9333ea', // violet
    '#dc2626', // red
    '#0d9488', // teal
    '#c2410c', // orange
    '#4f46e5', // indigo
    '#be185d', // pink
  ],

  // Typography
  fontFamily: "'system-ui', -apple-system, sans-serif",
  fontFamilyMono: "'SF Mono', 'Menlo', monospace",
  fontFamilySerif: "'Charter', 'Georgia', serif",

  // Font sizes
  fontSizeTitle: 13,
  fontSizeLabel: 11,
  fontSizeAxis: 10,
  fontSizeTick: 9,
  fontSizeTooltip: 11,

  // Grid & axis — very subtle
  gridColor: '#e0e0e0',
  gridOpacity: 0.3,
  axisColor: '#b0b0b0',
  tickColor: '#b0b0b0',

  // Tooltip
  tooltipBg: '#1a1a1a',
  tooltipText: '#fafafa',
  tooltipBorder: '#333333',

  // Animation
  animationDuration: 200,
};
