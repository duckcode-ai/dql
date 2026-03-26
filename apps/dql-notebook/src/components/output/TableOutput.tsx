import React, { useState, useMemo, useCallback } from 'react';
import { themes } from '../../themes/notebook-theme';
import type { QueryResult } from '../../store/types';

interface TableOutputProps {
  result: QueryResult;
  themeMode: 'dark' | 'light';
}

const PAGE_SIZES = [25, 50, 100, 500] as const;

type SortDir = 'asc' | 'desc' | null;

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

function compareValues(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (isNumeric(a) && isNumeric(b)) return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

// ─── Export Utilities ─────────────────────────────────────────────────────────

export function exportCSV(result: QueryResult, filename?: string) {
  const escape = (v: string) => {
    if (v.includes(',') || v.includes('"') || v.includes('\n')) {
      return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
  };
  const header = result.columns.map(escape).join(',');
  const rows = result.rows.map((row) =>
    result.columns.map((col) => escape(formatCell(row[col]))).join(',')
  );
  const csv = [header, ...rows].join('\n');
  downloadBlob(csv, (filename || 'export') + '.csv', 'text/csv');
}

export function exportJSON(result: QueryResult, filename?: string) {
  const json = JSON.stringify(result.rows, null, 2);
  downloadBlob(json, (filename || 'export') + '.json', 'application/json');
}

function downloadBlob(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Sort Arrow ───────────────────────────────────────────────────────────────

function SortArrow({ dir, color }: { dir: SortDir; color: string }) {
  if (!dir) return (
    <svg width="8" height="10" viewBox="0 0 8 10" fill={color} opacity={0.3} style={{ marginLeft: 3, flexShrink: 0 }}>
      <path d="M4 0L7 3.5H1L4 0Z" />
      <path d="M4 10L1 6.5H7L4 10Z" />
    </svg>
  );
  return (
    <svg width="8" height="10" viewBox="0 0 8 10" fill={color} style={{ marginLeft: 3, flexShrink: 0 }}>
      {dir === 'asc' ? <path d="M4 0L7 4H1L4 0Z" /> : <path d="M4 10L1 6H7L4 10Z" />}
    </svg>
  );
}

// ─── TableOutput ──────────────────────────────────────────────────────────────

export function TableOutput({ result, themeMode }: TableOutputProps) {
  const t = themes[themeMode];
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [filterText, setFilterText] = useState('');
  const [pageSize, setPageSize] = useState<number>(50);
  const [page, setPage] = useState(0);

  const handleSort = useCallback((col: string) => {
    if (sortCol === col) {
      if (sortDir === 'asc') setSortDir('desc');
      else if (sortDir === 'desc') { setSortCol(null); setSortDir(null); }
      else setSortDir('asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
    setPage(0);
  }, [sortCol, sortDir]);

  // Filter rows
  const filteredRows = useMemo(() => {
    if (!filterText.trim()) return result.rows;
    const lower = filterText.toLowerCase();
    return result.rows.filter((row) =>
      result.columns.some((col) => {
        const val = row[col];
        if (val === null || val === undefined) return false;
        return String(val).toLowerCase().includes(lower);
      })
    );
  }, [result.rows, result.columns, filterText]);

  // Sort rows
  const sortedRows = useMemo(() => {
    if (!sortCol || !sortDir) return filteredRows;
    const sorted = [...filteredRows];
    sorted.sort((a, b) => {
      const cmp = compareValues(a[sortCol], b[sortCol]);
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return sorted;
  }, [filteredRows, sortCol, sortDir]);

  // Paginate
  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const displayRows = sortedRows.slice(safePage * pageSize, (safePage + 1) * pageSize);

  if (result.columns.length === 0) {
    return (
      <div style={{ padding: '12px 16px', color: t.textMuted, fontSize: 12, fontFamily: t.font, fontStyle: 'italic' }}>
        Query executed successfully. No columns to display.
      </div>
    );
  }

  return (
    <div>
      {/* Toolbar: filter + export + pagination */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
        borderBottom: `1px solid ${t.tableBorder}`, background: `${t.tableHeaderBg}60`, flexWrap: 'wrap',
      }}>
        {/* Filter */}
        <div style={{ position: 'relative', flex: '0 1 200px', minWidth: 120 }}>
          <svg width="11" height="11" viewBox="0 0 16 16" fill={t.textMuted} style={{ position: 'absolute', left: 6, top: 6 }}>
            <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z" />
          </svg>
          <input
            value={filterText}
            onChange={(e) => { setFilterText(e.target.value); setPage(0); }}
            placeholder="Filter rows..."
            style={{
              width: '100%', background: t.inputBg, border: `1px solid ${t.inputBorder}`,
              borderRadius: 4, color: t.textPrimary, fontSize: 11, fontFamily: t.font,
              padding: '3px 8px 3px 22px', outline: 'none',
            }}
          />
          {filterText && (
            <button onClick={() => setFilterText('')} style={{
              position: 'absolute', right: 4, top: 3, background: 'none', border: 'none',
              color: t.textMuted, cursor: 'pointer', fontSize: 12, padding: '0 2px',
            }}>×</button>
          )}
        </div>

        {/* Row count */}
        <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font }}>
          {filterText ? `${sortedRows.length} of ${result.rows.length}` : `${result.rows.length}`} rows
        </span>

        <div style={{ flex: 1 }} />

        {/* Export buttons */}
        <ExportBtn label="CSV" onClick={() => exportCSV(result)} t={t} />
        <ExportBtn label="JSON" onClick={() => exportJSON(result)} t={t} />

        {/* Page size selector */}
        <select
          value={pageSize}
          onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
          style={{
            background: t.inputBg, border: `1px solid ${t.inputBorder}`, borderRadius: 3,
            color: t.textSecondary, fontSize: 10, fontFamily: t.font, padding: '2px 4px', outline: 'none',
          }}
        >
          {PAGE_SIZES.map((s) => (
            <option key={s} value={s}>{s} / page</option>
          ))}
        </select>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <PagBtn disabled={safePage === 0} onClick={() => setPage(0)} t={t}>«</PagBtn>
            <PagBtn disabled={safePage === 0} onClick={() => setPage(safePage - 1)} t={t}>‹</PagBtn>
            <span style={{ fontSize: 10, color: t.textSecondary, fontFamily: t.font, padding: '0 4px' }}>
              {safePage + 1}/{totalPages}
            </span>
            <PagBtn disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)} t={t}>›</PagBtn>
            <PagBtn disabled={safePage >= totalPages - 1} onClick={() => setPage(totalPages - 1)} t={t}>»</PagBtn>
          </div>
        )}
      </div>

      {/* Table */}
      <div style={{ maxHeight: 400, overflow: 'auto', position: 'relative' }}>
        <table style={{
          width: '100%', borderCollapse: 'collapse', tableLayout: 'auto',
          fontSize: 12, fontFamily: t.fontMono,
        }}>
          <thead>
            <tr>
              {result.columns.map((col) => (
                <th
                  key={col}
                  onClick={() => handleSort(col)}
                  style={{
                    background: t.tableHeaderBg, color: t.textSecondary, fontWeight: 600,
                    fontSize: 11, textAlign: 'left', padding: '6px 12px',
                    borderBottom: `1px solid ${t.tableBorder}`, borderRight: `1px solid ${t.tableBorder}`,
                    minWidth: 80, maxWidth: 300, whiteSpace: 'nowrap',
                    position: 'sticky', top: 0, zIndex: 1, fontFamily: t.font,
                    letterSpacing: '0.03em', overflow: 'hidden', textOverflow: 'ellipsis',
                    cursor: 'pointer', userSelect: 'none',
                    transition: 'background 0.1s',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center' }}>
                    {col}
                    <SortArrow dir={sortCol === col ? sortDir : null} color={sortCol === col ? t.accent : t.textMuted} />
                  </span>
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
                  background: hoveredRow === rowIdx ? t.tableRowHover : 'transparent',
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
                        whiteSpace: 'nowrap', maxWidth: 300,
                        overflow: 'hidden', textOverflow: 'ellipsis',
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
      </div>

      {/* Footer */}
      {(filterText || sortedRows.length > pageSize) && (
        <div style={{
          padding: '4px 12px', color: t.textMuted, fontSize: 10, fontFamily: t.font,
          borderTop: `1px solid ${t.tableBorder}`, background: `${t.tableHeaderBg}60`,
          display: 'flex', justifyContent: 'space-between',
        }}>
          <span>
            Showing {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, sortedRows.length)} of {sortedRows.length}
            {filterText && ` (filtered from ${result.rows.length})`}
          </span>
          {sortCol && <span>Sorted by {sortCol} {sortDir}</span>}
        </div>
      )}
    </div>
  );
}

function ExportBtn({ label, onClick, t }: { label: string; onClick: () => void; t: typeof themes['dark'] }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? t.btnHover : 'transparent',
        border: `1px solid ${hovered ? t.btnBorder : 'transparent'}`,
        borderRadius: 3, cursor: 'pointer',
        color: hovered ? t.textSecondary : t.textMuted,
        fontSize: 10, fontFamily: t.font, fontWeight: 600,
        padding: '2px 6px', transition: 'all 0.15s',
        display: 'flex', alignItems: 'center', gap: 3,
      }}
    >
      <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
        <path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z" />
        <path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.97a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.779a.749.749 0 1 1 1.06-1.06l1.97 1.97Z" />
      </svg>
      {label}
    </button>
  );
}

function PagBtn({ disabled, onClick, children, t }: { disabled: boolean; onClick: () => void; children: React.ReactNode; t: typeof themes['dark'] }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        background: 'transparent', border: 'none', cursor: disabled ? 'default' : 'pointer',
        color: disabled ? t.textMuted : t.textSecondary, fontSize: 12, fontFamily: t.font,
        padding: '0 3px', opacity: disabled ? 0.4 : 1, transition: 'opacity 0.1s',
      }}
    >
      {children}
    </button>
  );
}
