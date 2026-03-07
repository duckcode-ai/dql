import type { ChartTheme } from './types.js';

export const editorialLight: ChartTheme = {
  name: 'editorial-light',

  background: '#f8f7f4',
  surface: '#ffffff',
  surfaceAlt: '#f3f1ed',

  border: '#e5e2db',
  borderLight: '#eceae4',

  textPrimary: '#1a1917',
  textSecondary: '#3d3b36',
  textMuted: '#6b6860',
  textDim: '#9e9a90',

  accent: '#b07d3a',
  accentBg: '#faf3e8',

  positive: '#2d8a4e',
  positiveBg: '#edf7f0',
  negative: '#c4314b',
  negativeBg: '#fdf0f2',
  warning: '#a06b12',
  warningBg: '#fdf6e8',
  info: '#4f5bd5',
  infoBg: '#eef0ff',

  palette: [
    '#b07d3a',
    '#4f5bd5',
    '#2d8a4e',
    '#c4314b',
    '#7c6bc4',
    '#0e8585',
    '#d4763a',
    '#3a8fb0',
    '#8a6d3b',
    '#b04f7d',
  ],

  fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
  fontFamilyMono: "'DM Mono', 'JetBrains Mono', monospace",
  fontFamilySerif: "'Newsreader', 'Georgia', serif",

  fontSizeTitle: 14,
  fontSizeLabel: 12,
  fontSizeAxis: 11,
  fontSizeTick: 10,
  fontSizeTooltip: 12,

  gridColor: '#e5e2db',
  gridOpacity: 0.6,
  axisColor: '#9e9a90',
  tickColor: '#9e9a90',

  tooltipBg: '#ffffff',
  tooltipText: '#1a1917',
  tooltipBorder: '#e5e2db',

  animationDuration: 300,
};
