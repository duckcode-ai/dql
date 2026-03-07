import React from 'react';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';
import { formatCompact } from '../utils/formatters.js';

export interface PredictionBlockProps {
  title: string;
  prediction: string;
  confidence: number;
  factors?: Array<{ name: string; impact: number }>;
  theme?: ChartTheme;
}

export function PredictionBlock({
  title,
  prediction,
  confidence,
  factors,
  theme = editorialDark,
}: PredictionBlockProps) {
  const confPct = (confidence * 100).toFixed(0);
  const confColor =
    confidence >= 0.8 ? theme.positive : confidence >= 0.5 ? theme.warning : theme.negative;

  return (
    <div
      style={{
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: 12,
        padding: '20px 24px',
        fontFamily: theme.fontFamily,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <span
          style={{
            fontSize: theme.fontSizeTick,
            fontWeight: 600,
            color: theme.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: theme.fontSizeTick,
            fontWeight: 600,
            color: confColor,
            background: confidence >= 0.8 ? theme.positiveBg : confidence >= 0.5 ? theme.warningBg : theme.negativeBg,
            padding: '2px 8px',
            borderRadius: 4,
            fontFamily: theme.fontFamilyMono,
          }}
        >
          {confPct}% confidence
        </span>
      </div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: theme.textPrimary,
          marginBottom: factors ? 16 : 0,
          lineHeight: 1.5,
        }}
      >
        {prediction}
      </div>
      {factors && factors.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div
            style={{
              fontSize: theme.fontSizeTick,
              color: theme.textDim,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontWeight: 600,
              marginBottom: 2,
            }}
          >
            Key Factors
          </div>
          {factors.map((f, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: theme.fontSizeLabel,
                fontFamily: theme.fontFamilyMono,
              }}
            >
              <span style={{ color: theme.textSecondary }}>{f.name}</span>
              <span
                style={{
                  color: f.impact >= 0 ? theme.positive : theme.negative,
                  fontWeight: 600,
                }}
              >
                {f.impact >= 0 ? '+' : ''}{f.impact.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
