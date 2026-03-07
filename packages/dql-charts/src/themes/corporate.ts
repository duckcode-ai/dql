import type { ChartTheme } from './types.js';

export const corporate: ChartTheme = {
  name: 'corporate',

  // Background & surface — clean white/gray
  background: '#ffffff',
  surface: '#f8f9fa',
  surfaceAlt: '#f1f3f5',

  // Borders
  border: '#dee2e6',
  borderLight: '#e9ecef',

  // Text
  textPrimary: '#212529',
  textSecondary: '#495057',
  textMuted: '#868e96',
  textDim: '#adb5bd',

  // Accent — corporate blue
  accent: '#1864ab',
  accentBg: 'rgba(24, 100, 171, 0.08)',

  // Semantic colors
  positive: '#2b8a3e',
  positiveBg: 'rgba(43, 138, 62, 0.08)',
  negative: '#c92a2a',
  negativeBg: 'rgba(201, 42, 42, 0.08)',
  warning: '#e67700',
  warningBg: 'rgba(230, 119, 0, 0.08)',
  info: '#1971c2',
  infoBg: 'rgba(25, 113, 194, 0.08)',

  // Chart palette — professional, accessible
  palette: [
    '#1864ab', // navy blue
    '#2b8a3e', // forest green
    '#e67700', // amber
    '#862e9c', // purple
    '#c92a2a', // crimson
    '#0b7285', // teal
    '#5c940d', // olive
    '#d9480f', // burnt orange
    '#364fc7', // indigo
    '#a61e4d', // rose
  ],

  // Typography
  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  fontFamilyMono: "'SF Mono', 'Consolas', monospace",
  fontFamilySerif: "'Georgia', 'Times New Roman', serif",

  // Font sizes
  fontSizeTitle: 14,
  fontSizeLabel: 12,
  fontSizeAxis: 11,
  fontSizeTick: 10,
  fontSizeTooltip: 12,

  // Grid & axis
  gridColor: '#dee2e6',
  gridOpacity: 0.5,
  axisColor: '#868e96',
  tickColor: '#868e96',

  // Tooltip
  tooltipBg: '#212529',
  tooltipText: '#f8f9fa',
  tooltipBorder: '#343a40',

  // Animation
  animationDuration: 250,
};
