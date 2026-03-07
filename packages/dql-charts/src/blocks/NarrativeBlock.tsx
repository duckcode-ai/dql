import React from 'react';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';

export interface NarrativeBlockProps {
  title?: string;
  content: string;
  theme?: ChartTheme;
}

export function NarrativeBlock({
  title,
  content,
  theme = editorialDark,
}: NarrativeBlockProps) {
  return (
    <div
      style={{
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: 12,
        padding: '24px 28px',
        fontFamily: theme.fontFamilySerif,
        lineHeight: 1.7,
      }}
    >
      {title && (
        <h3
          style={{
            margin: '0 0 12px 0',
            fontSize: 16,
            fontWeight: 700,
            color: theme.textPrimary,
            fontFamily: theme.fontFamily,
            letterSpacing: '-0.01em',
          }}
        >
          {title}
        </h3>
      )}
      <div
        style={{
          fontSize: 14,
          color: theme.textSecondary,
          whiteSpace: 'pre-wrap',
        }}
      >
        {content}
      </div>
    </div>
  );
}
