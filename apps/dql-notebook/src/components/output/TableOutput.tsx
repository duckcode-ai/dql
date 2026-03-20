import React, { useState } from 'react';
import { themes } from '../../themes/notebook-theme';
import type { QueryResult } from '../../store/types';

interface TableOutputProps {
  result: QueryResult;
  themeMode: 'dark' | 'light';
}

const MAX_ROWS = 500;

function isNumeric(value: unknown): boolean {
  if (typeof value === 'number') return true;
  if (typeof value === 'string') return !isNaN(Number(value)) && value.trim() !== '';
  return false;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function TableOutput({ result, themeMode }: TableOutputProps) {
  const t = themes[themeMode];
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);

  const displayRows = result.rows.slice(0, MAX_ROWS);
  const truncated = result.rows.length > MAX_ROWS;

  if (result.columns.length === 0) {
    return (
      <div
        style={{
          padding: '12px 16px',
          color: t.textMuted,
          fontSize: 12,
          fontFamily: t.font,
          fontStyle: 'italic',
        }}
      >
        Query executed successfully. No columns to display.
      </div>
    );
  }

  return (
    <div
      style={{
        maxHeight: 400,
        overflow: 'auto',
        position: 'relative',
      }}
    >
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse' as const,
          tableLayout: 'auto' as const,
          fontSize: 12,
          fontFamily: t.fontMono,
        }}
      >
        <thead>
          <tr>
            {result.columns.map((col) => (
              <th
                key={col}
                style={{
                  background: t.tableHeaderBg,
                  color: t.textSecondary,
                  fontWeight: 600,
                  fontSize: 11,
                  textAlign: 'left' as const,
                  padding: '6px 12px',
                  borderBottom: `1px solid ${t.tableBorder}`,
                  borderRight: `1px solid ${t.tableBorder}`,
                  minWidth: 80,
                  maxWidth: 300,
                  whiteSpace: 'nowrap' as const,
                  position: 'sticky' as const,
                  top: 0,
                  zIndex: 1,
                  fontFamily: t.font,
                  letterSpacing: '0.03em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row, rowIdx) => (
            <tr
              key={rowIdx}
              onMouseEnter={() => setHoveredRow(rowIdx)}
              onMouseLeave={() => setHoveredRow(null)}
              style={{
                background:
                  hoveredRow === rowIdx ? t.tableRowHover : 'transparent',
                transition: 'background 0.1s',
              }}
            >
              {result.columns.map((col) => {
                const value = row[col];
                const isNull = value === null || value === undefined;
                const numericAlign = isNumeric(value);

                return (
                  <td
                    key={col}
                    style={{
                      padding: '5px 12px',
                      borderBottom: `1px solid ${t.tableBorder}`,
                      borderRight: `1px solid ${t.tableBorder}`,
                      color: isNull ? t.textMuted : t.textPrimary,
                      fontStyle: isNull ? 'italic' : 'normal',
                      textAlign: numericAlign ? 'right' : 'left',
                      whiteSpace: 'nowrap' as const,
                      maxWidth: 300,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {isNull ? '—' : formatCell(value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {truncated && (
        <div
          style={{
            padding: '8px 12px',
            color: t.textMuted,
            fontSize: 11,
            fontFamily: t.font,
            borderTop: `1px solid ${t.tableBorder}`,
            background: t.tableHeaderBg,
            fontStyle: 'italic',
          }}
        >
          Showing {MAX_ROWS.toLocaleString()} of {result.rows.length.toLocaleString()} rows
        </div>
      )}
    </div>
  );
}
