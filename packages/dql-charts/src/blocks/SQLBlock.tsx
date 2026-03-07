import React from 'react';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';

export interface SQLBlockProps {
  sql: string;
  title?: string;
  executionTime?: number;
  rowCount?: number;
  theme?: ChartTheme;
}

export function SQLBlock({
  sql,
  title,
  executionTime,
  rowCount,
  theme = editorialDark,
}: SQLBlockProps) {
  return (
    <div
      style={{
        background: theme.surfaceAlt,
        border: `1px solid ${theme.border}`,
        borderRadius: 12,
        overflow: 'hidden',
      }}
    >
      {(title || executionTime != null || rowCount != null) && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '10px 16px',
            borderBottom: `1px solid ${theme.border}`,
            fontFamily: theme.fontFamily,
            fontSize: theme.fontSizeTick,
          }}
        >
          <span style={{ color: theme.textMuted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {title || 'SQL'}
          </span>
          <span style={{ color: theme.textDim }}>
            {rowCount != null && `${rowCount.toLocaleString()} rows`}
            {rowCount != null && executionTime != null && ' · '}
            {executionTime != null && `${executionTime}ms`}
          </span>
        </div>
      )}
      <pre
        style={{
          margin: 0,
          padding: '16px 20px',
          fontFamily: theme.fontFamilyMono,
          fontSize: theme.fontSizeLabel,
          color: theme.textPrimary,
          lineHeight: 1.6,
          overflowX: 'auto',
          whiteSpace: 'pre',
        }}
      >
        {sql}
      </pre>
    </div>
  );
}
