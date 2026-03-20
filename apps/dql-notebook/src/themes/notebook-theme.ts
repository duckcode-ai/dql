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

export const DARK = {
  appBg: '#0d1117',
  sidebarBg: '#161b22',
  activityBarBg: '#0d1117',
  headerBg: '#161b22',
  headerBorder: '#21262d',
  cellBg: '#161b22',
  cellBorder: '#30363d',
  cellBorderActive: '#388bfd',
  cellBorderRunning: '#56d364',
  textPrimary: '#e6edf3',
  textSecondary: '#8b949e',
  textMuted: '#484f58',
  editorBg: '#0d1117',
  editorBorder: '#30363d',
  tableBorder: '#30363d',
  tableHeaderBg: '#1c2128',
  tableRowHover: '#21262d',
  accent: '#388bfd',
  accentHover: '#58a6ff',
  success: '#56d364',
  error: '#f85149',
  warning: '#e3b341',
  btnBg: '#21262d',
  btnBorder: '#30363d',
  btnHover: '#30363d',
  sidebarItemHover: '#21262d',
  sidebarItemActive: '#1f2d3d',
  scrollbarThumb: '#30363d',
  modalBg: '#161b22',
  modalOverlay: 'rgba(0,0,0,0.7)',
  inputBg: '#0d1117',
  inputBorder: '#30363d',
  pillBg: '#21262d',
  font: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  fontMono: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
  fontSerif: "Georgia, 'Times New Roman', serif",
} as const;

export const LIGHT = {
  appBg: '#ffffff',
  sidebarBg: '#f6f8fa',
  activityBarBg: '#eff1f3',
  headerBg: '#ffffff',
  headerBorder: '#d0d7de',
  cellBg: '#ffffff',
  cellBorder: '#d0d7de',
  cellBorderActive: '#0969da',
  cellBorderRunning: '#1f883d',
  textPrimary: '#1f2328',
  textSecondary: '#57606a',
  textMuted: '#8c959f',
  editorBg: '#f6f8fa',
  editorBorder: '#d0d7de',
  tableBorder: '#d0d7de',
  tableHeaderBg: '#f6f8fa',
  tableRowHover: '#f6f8fa',
  accent: '#0969da',
  accentHover: '#0550ae',
  success: '#1f883d',
  error: '#cf222e',
  warning: '#9a6700',
  btnBg: '#f6f8fa',
  btnBorder: '#d0d7de',
  btnHover: '#eaeef2',
  sidebarItemHover: '#eaeef2',
  sidebarItemActive: '#dbeafe',
  scrollbarThumb: '#d0d7de',
  modalBg: '#ffffff',
  modalOverlay: 'rgba(0,0,0,0.4)',
  inputBg: '#ffffff',
  inputBorder: '#d0d7de',
  pillBg: '#eaeef2',
  font: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  fontMono: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
  fontSerif: "Georgia, 'Times New Roman', serif",
} as const;

export const themes: Record<'dark' | 'light', Theme> = { dark: DARK as Theme, light: LIGHT as Theme };
