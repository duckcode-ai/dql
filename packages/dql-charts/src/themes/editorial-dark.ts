import type { ChartTheme } from './types.js';

export const editorialDark: ChartTheme = {
  name: 'editorial-dark',

  // Background and surface palette derived from the original chart prototype
  background: '#0d1117',
  surface: '#161b22',
  surfaceAlt: '#1c2128',

  // Borders
  border: '#30363d',
  borderLight: '#21262d',

  // Text
  textPrimary: '#e6edf3',
  textSecondary: '#b1bac4',
  textMuted: '#8b949e',
  textDim: '#6e7681',

  // Accent — warm amber from demo
  accent: '#d4a054',
  accentBg: 'rgba(212, 160, 84, 0.12)',

  // Semantic colors
  positive: '#3fb950',
  positiveBg: 'rgba(63, 185, 80, 0.12)',
  negative: '#f85149',
  negativeBg: 'rgba(248, 81, 73, 0.12)',
  warning: '#d29922',
  warningBg: 'rgba(210, 153, 34, 0.12)',
  info: '#58a6ff',
  infoBg: 'rgba(88, 166, 255, 0.12)',

  // Chart palette — editorial magazine quality
  palette: [
    '#d4a054', // warm amber (primary)
    '#58a6ff', // blue
    '#3fb950', // green
    '#f0883e', // orange
    '#bc8cff', // purple
    '#f85149', // red
    '#79c0ff', // light blue
    '#56d364', // light green
    '#e3b341', // gold
    '#db61a2', // pink
  ],

  // Typography
  fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
  fontFamilyMono: "'DM Mono', 'JetBrains Mono', monospace",
  fontFamilySerif: "'Newsreader', 'Georgia', serif",

  // Font sizes
  fontSizeTitle: 14,
  fontSizeLabel: 12,
  fontSizeAxis: 11,
  fontSizeTick: 10,
  fontSizeTooltip: 12,

  // Grid & axis
  gridColor: '#30363d',
  gridOpacity: 0.4,
  axisColor: '#484f58',
  tickColor: '#484f58',

  // Tooltip
  tooltipBg: '#1c2128',
  tooltipText: '#e6edf3',
  tooltipBorder: '#30363d',

  // Animation
  animationDuration: 300,
};
