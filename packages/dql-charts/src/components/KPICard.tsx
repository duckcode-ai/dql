import React from 'react';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';
import { formatCompact } from '../utils/formatters.js';

export interface KPICardProps {
  title: string;
  value: number | string;
  change?: number;
  changeLabel?: string;
  format?: 'number' | 'compact' | 'currency' | 'percent';
  theme?: ChartTheme;
  width?: number;
  height?: number;
}

export function KPICard({
  title,
  value,
  change,
  changeLabel,
  format = 'compact',
  theme = editorialDark,
}: KPICardProps) {
  const displayValue =
    typeof value === 'string'
      ? value
      : format === 'compact'
        ? formatCompact(value)
        : format === 'currency'
          ? `$${formatCompact(value)}`
          : format === 'percent'
            ? `${(value * 100).toFixed(1)}%`
            : formatCompact(value);

  const isPositive = change != null && change >= 0;
  const changeColor = isPositive ? theme.positive : theme.negative;
  const changeBg = isPositive ? theme.positiveBg : theme.negativeBg;
  const arrow = isPositive ? '\u2191' : '\u2193';

  return (
    <div
      role="figure"
      aria-label={`${title}: ${displayValue}${change != null ? `, ${isPositive ? 'up' : 'down'} ${Math.abs(change).toFixed(1)}%` : ''}`}
      style={{
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: 12,
        padding: '20px 24px',
        fontFamily: theme.fontFamily,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontSize: theme.fontSizeLabel, color: theme.textMuted, fontWeight: 500 }}>
        {title}
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 700,
          color: theme.textPrimary,
          fontFamily: theme.fontFamilyMono,
          letterSpacing: '-0.02em',
        }}
      >
        {displayValue}
      </div>
      {change != null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: changeColor,
              background: changeBg,
              padding: '2px 8px',
              borderRadius: 4,
              fontFamily: theme.fontFamilyMono,
            }}
          >
            {arrow} {Math.abs(change).toFixed(1)}%
          </span>
          {changeLabel && (
            <span style={{ fontSize: 11, color: theme.textDim }}>{changeLabel}</span>
          )}
        </div>
      )}
    </div>
  );
}
