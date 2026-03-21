import React from 'react';
import { themes } from '../../themes/notebook-theme';
import { parseQueryError } from '../../utils/parse-error';

interface ErrorOutputProps {
  message: string;
  themeMode: 'dark' | 'light';
}

export function ErrorOutput({ message, themeMode }: ErrorOutputProps) {
  const t = themes[themeMode];
  const parsed = parseQueryError(message);

  return (
    <div
      style={{
        padding: '12px 14px',
        background: `${t.error}10`,
        borderLeft: `3px solid ${t.error}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {/* Header row: icon + type badge + near badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {/* Error icon */}
        <div style={{ flexShrink: 0, color: t.error, display: 'flex', alignItems: 'center' }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
          </svg>
        </div>

        {/* Error type badge */}
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            fontFamily: t.fontMono,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: t.error,
            background: `${t.error}18`,
            border: `1px solid ${t.error}40`,
            borderRadius: 4,
            padding: '1px 7px',
            flexShrink: 0,
          }}
        >
          {parsed.type}
        </span>

        {/* Line badge */}
        {parsed.line !== undefined && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              fontFamily: t.fontMono,
              color: t.textSecondary,
              background: `${t.textMuted}18`,
              border: `1px solid ${t.textMuted}30`,
              borderRadius: 4,
              padding: '1px 7px',
              flexShrink: 0,
            }}
          >
            Line {parsed.line}
          </span>
        )}

        {/* Near badge */}
        {parsed.near && (
          <span
            style={{
              fontSize: 11,
              fontFamily: t.fontMono,
              color: t.textSecondary,
              flexShrink: 0,
            }}
          >
            near <span style={{ color: t.error }}>&ldquo;{parsed.near}&rdquo;</span>
          </span>
        )}
      </div>

      {/* Message */}
      <pre
        style={{
          margin: 0,
          fontFamily: t.fontMono,
          fontSize: 12,
          color: t.error,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {parsed.message}
      </pre>

      {/* Hint box */}
      {parsed.hint && (
        <div
          style={{
            marginTop: 2,
            padding: '8px 12px',
            background: `${t.warning}12`,
            border: `1px solid ${t.warning}40`,
            borderRadius: 6,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
          }}
        >
          {/* Lightbulb icon */}
          <span style={{ flexShrink: 0, fontSize: 13, lineHeight: 1.5 }}>&#x1F4A1;</span>
          <span
            style={{
              fontSize: 12,
              fontFamily: t.font,
              color: t.warning,
              lineHeight: 1.6,
            }}
          >
            {parsed.hint}
          </span>
        </div>
      )}
    </div>
  );
}
