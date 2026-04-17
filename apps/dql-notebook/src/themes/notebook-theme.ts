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

// v0.10 restyle — tighter contrast, hex-inspired near-black shell, refined accent.
export const DARK = {
  appBg: '#0a0a0c',
  sidebarBg: '#111114',
  activityBarBg: '#08080a',
  headerBg: '#111114',
  headerBorder: '#1d1d22',
  cellBg: '#131317',
  cellBorder: '#26262d',
  cellBorderActive: '#5b8def',
  cellBorderRunning: '#4ade80',
  textPrimary: '#f4f4f5',
  textSecondary: '#a0a0a8',
  textMuted: '#5a5a65',
  editorBg: '#0a0a0c',
  editorBorder: '#26262d',
  tableBorder: '#26262d',
  tableHeaderBg: '#17171c',
  tableRowHover: '#1a1a20',
  accent: '#5b8def',
  accentHover: '#7aa5ff',
  success: '#4ade80',
  error: '#f87171',
  warning: '#fbbf24',
  btnBg: '#1a1a1f',
  btnBorder: '#26262d',
  btnHover: '#26262d',
  sidebarItemHover: '#1a1a20',
  sidebarItemActive: '#1f2937',
  scrollbarThumb: '#26262d',
  modalBg: '#111114',
  modalOverlay: 'rgba(0,0,0,0.75)',
  inputBg: '#0a0a0c',
  inputBorder: '#26262d',
  pillBg: '#1a1a1f',
  font: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  fontMono: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
  fontSerif: "Georgia, 'Times New Roman', serif",
} as const;

export const LIGHT = {
  appBg: '#fafafa',
  sidebarBg: '#f3f4f6',
  activityBarBg: '#ececef',
  headerBg: '#ffffff',
  headerBorder: '#e4e4e7',
  cellBg: '#ffffff',
  cellBorder: '#e4e4e7',
  cellBorderActive: '#4f46e5',
  cellBorderRunning: '#16a34a',
  textPrimary: '#18181b',
  textSecondary: '#52525b',
  textMuted: '#a1a1aa',
  editorBg: '#fafafa',
  editorBorder: '#e4e4e7',
  tableBorder: '#e4e4e7',
  tableHeaderBg: '#f3f4f6',
  tableRowHover: '#f3f4f6',
  accent: '#4f46e5',
  accentHover: '#4338ca',
  success: '#16a34a',
  error: '#dc2626',
  warning: '#ca8a04',
  btnBg: '#f3f4f6',
  btnBorder: '#e4e4e7',
  btnHover: '#e4e4e7',
  sidebarItemHover: '#e4e4e7',
  sidebarItemActive: '#e0e7ff',
  scrollbarThumb: '#d4d4d8',
  modalBg: '#ffffff',
  modalOverlay: 'rgba(0,0,0,0.4)',
  inputBg: '#ffffff',
  inputBorder: '#e4e4e7',
  pillBg: '#f3f4f6',
  font: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  fontMono: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
  fontSerif: "Georgia, 'Times New Roman', serif",
} as const;

export const themes: Record<'dark' | 'light', Theme> = { dark: DARK as Theme, light: LIGHT as Theme };
