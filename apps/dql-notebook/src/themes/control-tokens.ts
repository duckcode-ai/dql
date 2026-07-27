import type { CSSProperties } from 'react';
import type { Theme } from './notebook-theme';

/**
 * One control language for the whole workbench.
 *
 * Buttons across the app had drifted into five radii (5, 6, 7, 12, 999), four
 * font sizes (10, 11, 11.5, 12.5) and four weights (550, 600, 700, 800), each
 * hard-coded in its own local style helper. The result read as a row of
 * mismatched boxes and made it hard to tell what was clickable.
 *
 * Every control style should be derived from `controlStyle` rather than
 * hand-rolled, so a change here propagates instead of drifting again.
 */
export const CONTROL_RADIUS = 6;
export const CONTROL_PILL_RADIUS = 999;

export type ControlSize = 'xs' | 'sm' | 'md' | 'lg';

/** Height / type scale. `lg` is the Ask composer send button. */
export const CONTROL_SIZES: Record<ControlSize, { height: number; fontSize: number; paddingX: number; gap: number; icon: number }> = {
  xs: { height: 22, fontSize: 10.5, paddingX: 7, gap: 4, icon: 11 },
  sm: { height: 26, fontSize: 11.5, paddingX: 9, gap: 5, icon: 12 },
  md: { height: 32, fontSize: 12.5, paddingX: 12, gap: 6, icon: 14 },
  lg: { height: 54, fontSize: 12.5, paddingX: 17, gap: 7, icon: 15 },
};

/**
 * Colour carries the meaning, nothing else:
 * `primary` commits · `danger` destroys · `accent` is AI/selected ·
 * `success` executes · `secondary` is a normal action · `ghost` is quiet.
 */
export type ControlVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent' | 'success';

export interface ControlStyleOptions {
  variant?: ControlVariant;
  size?: ControlSize;
  /** Selected/toggled state for segmented controls. */
  active?: boolean;
  /** Renders muted and non-interactive. */
  disabled?: boolean;
  /** Fully rounded (suggestion chips, filter pills). */
  pill?: boolean;
}

export function controlStyle(t: Theme, options: ControlStyleOptions = {}): CSSProperties {
  const { variant = 'secondary', size = 'sm', active = false, disabled = false, pill = false } = options;
  const scale = CONTROL_SIZES[size];
  const tone = variant === 'danger'
    ? t.error
    : variant === 'success'
      ? t.success
      : variant === 'accent'
        ? t.accent
        : undefined;

  const base: CSSProperties = {
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: scale.gap,
    height: scale.height,
    padding: `0 ${scale.paddingX}px`,
    borderRadius: pill ? CONTROL_PILL_RADIUS : CONTROL_RADIUS,
    fontSize: scale.fontSize,
    fontWeight: variant === 'primary' ? 700 : 600,
    fontFamily: t.font,
    lineHeight: 1,
    whiteSpace: 'nowrap',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    transition: 'background 0.15s, border-color 0.15s, color 0.15s',
  };

  if (variant === 'primary') {
    return { ...base, background: t.accent, border: `1px solid ${t.accent}`, color: '#ffffff' };
  }
  if (variant === 'ghost') {
    return {
      ...base,
      background: active ? `${t.accent}14` : 'transparent',
      border: '1px solid transparent',
      color: active ? t.accent : t.textMuted,
      fontWeight: 550,
    };
  }
  if (tone) {
    return {
      ...base,
      background: active ? `${tone}22` : `${tone}12`,
      border: `1px solid ${tone}${active ? '66' : '33'}`,
      color: tone,
    };
  }
  return {
    ...base,
    background: active ? `${t.accent}14` : t.btnBg,
    border: `1px solid ${active ? t.accent : t.btnBorder}`,
    color: active ? t.accent : t.textSecondary,
  };
}
