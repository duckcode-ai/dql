import React from 'react';
import { themes, type ThemeMode } from '../../themes/notebook-theme';
import { parseQueryError } from '../../utils/parse-error';
import type { SchemaTable } from '../../store/types';

interface ErrorOutputProps {
  message: string;
  themeMode: ThemeMode;
  onFix?: () => void;
  schemaTables?: SchemaTable[];
}

/** Levenshtein distance for fuzzy name matching */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Find closest name from a list (case-insensitive, max distance 3) */
function closestMatch(name: string, candidates: string[]): string | null {
  const lower = name.toLowerCase();
  let best: string | null = null;
  let bestDist = 4;
  for (const c of candidates) {
    const d = levenshtein(lower, c.toLowerCase());
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return best;
}

export function ErrorOutput({ message, themeMode, onFix, schemaTables }: ErrorOutputProps) {
  const t = themes[themeMode];
  const parsed = parseQueryError(message);

  // Build schema-aware suggestions
  let schemaSuggestion: string | null = null;
  if (schemaTables && schemaTables.length > 0) {
    if (parsed.type === 'Reference Error') {
      // Column not found — try to find near token in column names
      const columnNotFound = /column.*not found|Referenced column/i.test(parsed.message);
      const tableNotFound = /table.*not found|Table.*does not exist/i.test(parsed.message);
      if (columnNotFound && parsed.near) {
        const allCols = schemaTables.flatMap((tbl) => tbl.columns.map((c) => c.name));
        const match = closestMatch(parsed.near, allCols);
        if (match) schemaSuggestion = `Did you mean column "${match}"?`;
      } else if (tableNotFound && parsed.near) {
        const match = closestMatch(parsed.near, schemaTables.map((tbl) => tbl.name));
        if (match) schemaSuggestion = `Did you mean table "${match}"?`;
      }
    }
  }

  // Show "Format & Run" fix for syntax/bracket errors
  const showFormatFix = onFix && (
    parsed.type === 'Syntax Error' ||
    (parsed.near === ')' || parsed.near === '(') ||
    parsed.near === 'end of input'
  );

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
      {/* Header row: icon + type badge + line badge + near badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flexShrink: 0, color: t.error, display: 'flex', alignItems: 'center' }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
          </svg>
        </div>

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

        {parsed.near && (
          <span style={{ fontSize: 11, fontFamily: t.fontMono, color: t.textSecondary, flexShrink: 0 }}>
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

      {/* Schema suggestion */}
      {schemaSuggestion && (
        <div
          style={{
            fontSize: 12,
            fontFamily: t.font,
            color: t.textSecondary,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span style={{ color: t.accent }}>→</span>
          {schemaSuggestion}
        </div>
      )}

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
          <span style={{ flexShrink: 0, fontSize: 13, lineHeight: 1.5 }}>&#x1F4A1;</span>
          <span style={{ fontSize: 12, fontFamily: t.font, color: t.warning, lineHeight: 1.6 }}>
            {parsed.hint}
          </span>
        </div>
      )}

      {/* Quick-fix action */}
      {showFormatFix && (
        <button
          onClick={onFix}
          style={{
            alignSelf: 'flex-start',
            marginTop: 2,
            padding: '5px 12px',
            background: `${t.accent}15`,
            border: `1px solid ${t.accent}50`,
            borderRadius: 6,
            color: t.accent,
            fontSize: 12,
            fontFamily: t.font,
            fontWeight: 500,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            transition: 'all 0.15s',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = `${t.accent}25`;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = `${t.accent}15`;
          }}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z" />
          </svg>
          Format & Run
        </button>
      )}
    </div>
  );
}
