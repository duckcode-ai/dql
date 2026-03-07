import React from 'react';
import type { ChartTheme } from '../themes/types.js';
import { editorialDark } from '../themes/editorial-dark.js';
import { autoFormat } from '../utils/formatters.js';

export interface DataTableProps {
  data: Record<string, unknown>[];
  columns?: string[];
  theme?: ChartTheme;
  maxRows?: number;
  width?: number;
  height?: number;
}

export function DataTable({
  data,
  columns,
  theme = editorialDark,
  maxRows = 50,
}: DataTableProps) {
  const cols = columns || (data.length > 0 ? Object.keys(data[0]) : []);
  const rows = data.slice(0, maxRows);

  return (
    <div
      style={{
        overflow: 'auto',
        border: `1px solid ${theme.border}`,
        borderRadius: 8,
        fontFamily: theme.fontFamilyMono,
        fontSize: theme.fontSizeLabel,
      }}
    >
      <table role="table" aria-label={`Data table with ${cols.length} columns and ${rows.length} rows`} style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {cols.map((col) => (
              <th
                key={col}
                style={{
                  textAlign: 'left',
                  padding: '10px 14px',
                  background: theme.surfaceAlt,
                  color: theme.textSecondary,
                  fontWeight: 600,
                  fontSize: theme.fontSizeTick,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  borderBottom: `1px solid ${theme.border}`,
                  position: 'sticky',
                  top: 0,
                }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr
              key={ri}
              style={{
                borderBottom: `1px solid ${theme.borderLight}`,
                background: ri % 2 === 0 ? 'transparent' : theme.surfaceAlt,
              }}
            >
              {cols.map((col) => (
                <td
                  key={col}
                  style={{
                    padding: '8px 14px',
                    color: theme.textPrimary,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {autoFormat(row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
