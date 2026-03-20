import React from 'react';
import { themes } from '../../themes/notebook-theme';

interface ErrorOutputProps {
  message: string;
  themeMode: 'dark' | 'light';
}

export function ErrorOutput({ message, themeMode }: ErrorOutputProps) {
  const t = themes[themeMode];

  return (
    <div
      style={{
        padding: '10px 14px',
        background: `${t.error}10`,
        borderLeft: `3px solid ${t.error}`,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
      }}
    >
      {/* Icon */}
      <div
        style={{
          flexShrink: 0,
          marginTop: 1,
          color: t.error,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
        </svg>
      </div>

      {/* Message */}
      <pre
        style={{
          flex: 1,
          margin: 0,
          fontFamily: t.fontMono,
          fontSize: 12,
          color: t.error,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap' as const,
          wordBreak: 'break-word' as const,
        }}
      >
        {message}
      </pre>
    </div>
  );
}
