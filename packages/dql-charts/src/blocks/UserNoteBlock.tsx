import React from 'react';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';

export interface UserNoteBlockProps {
  author: string;
  content: string;
  timestamp?: string;
  theme?: ChartTheme;
}

export function UserNoteBlock({
  author,
  content,
  timestamp,
  theme = editorialDark,
}: UserNoteBlockProps) {
  return (
    <div
      style={{
        background: theme.surface,
        border: `1px solid ${theme.accent}`,
        borderLeft: `3px solid ${theme.accent}`,
        borderRadius: 8,
        padding: '16px 20px',
        fontFamily: theme.fontFamily,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: theme.fontSizeLabel, fontWeight: 600, color: theme.accent }}>
          {author}
        </span>
        {timestamp && (
          <span style={{ fontSize: theme.fontSizeTick, color: theme.textDim }}>
            {timestamp}
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: theme.fontSizeLabel,
          color: theme.textSecondary,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
        }}
      >
        {content}
      </div>
    </div>
  );
}
