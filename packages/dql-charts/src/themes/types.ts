export interface ChartTheme {
  name: string;

  // Background & surface
  background: string;
  surface: string;
  surfaceAlt: string;

  // Borders
  border: string;
  borderLight: string;

  // Text
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textDim: string;

  // Accent colors
  accent: string;
  accentBg: string;

  // Semantic colors
  positive: string;
  positiveBg: string;
  negative: string;
  negativeBg: string;
  warning: string;
  warningBg: string;
  info: string;
  infoBg: string;

  // Chart palette (ordered for series)
  palette: string[];

  // Typography
  fontFamily: string;
  fontFamilyMono: string;
  fontFamilySerif: string;

  // Font sizes
  fontSizeTitle: number;
  fontSizeLabel: number;
  fontSizeAxis: number;
  fontSizeTick: number;
  fontSizeTooltip: number;

  // Grid & axis
  gridColor: string;
  gridOpacity: number;
  axisColor: string;
  tickColor: string;

  // Tooltip
  tooltipBg: string;
  tooltipText: string;
  tooltipBorder: string;

  // Animation
  animationDuration: number;
}
