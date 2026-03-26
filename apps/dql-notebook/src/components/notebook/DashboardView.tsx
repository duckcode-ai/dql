import React from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { TableOutput } from '../output/TableOutput';
import { renderChart, resolveChartType } from '../output/ChartOutput';
import type { Cell } from '../../store/types';

/**
 * Dashboard / presentation mode: hides all code editors and shows only
 * cell outputs (tables, charts, rendered markdown) in a clean layout.
 */
export function DashboardView() {
  const { state } = useNotebook();
  const t = themes[state.themeMode];

  const visibleCells = state.cells.filter(
    (cell) =>
      cell.type === 'markdown' ||
      (cell.result && cell.status !== 'running') ||
      cell.error
  );

  return (
    <div
      style={{
        flex: 1,
        overflow: 'auto',
        background: t.appBg,
        padding: '32px 24px 48px',
      }}
    >
      <div
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        {/* Title */}
        <div style={{ textAlign: 'center', marginBottom: 8 }}>
          <h1
            style={{
              fontSize: 28,
              fontWeight: 700,
              color: t.textPrimary,
              fontFamily: t.font,
              letterSpacing: '-0.3px',
              margin: 0,
            }}
          >
            {state.notebookTitle || 'Untitled'}
          </h1>
          <p
            style={{
              fontSize: 12,
              color: t.textMuted,
              fontFamily: t.font,
              marginTop: 6,
            }}
          >
            {state.cells.filter((c) => c.result).length} results
            {state.activeFile ? ` \u00b7 ${state.activeFile.path}` : ''}
          </p>
        </div>

        {visibleCells.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              padding: 48,
              color: t.textMuted,
              fontSize: 14,
              fontFamily: t.font,
            }}
          >
            No outputs to display. Run some cells first, then switch to dashboard mode.
          </div>
        ) : (
          visibleCells.map((cell) => (
            <DashboardCard key={cell.id} cell={cell} />
          ))
        )}
      </div>
    </div>
  );
}

function DashboardCard({ cell }: { cell: Cell }) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];

  // Markdown cells render as simple prose
  if (cell.type === 'markdown') {
    return (
      <div
        style={{
          background: t.cellBg,
          borderRadius: 10,
          border: `1px solid ${t.cellBorder}`,
          padding: '16px 24px',
          fontSize: 14,
          lineHeight: 1.7,
          fontFamily: t.font,
          color: t.textSecondary,
          whiteSpace: 'pre-wrap',
        }}
        dangerouslySetInnerHTML={{
          __html: simpleMarkdownToHtml(cell.content, t),
        }}
      />
    );
  }

  // Error cells
  if (cell.error) {
    return (
      <div
        style={{
          background: t.cellBg,
          borderRadius: 10,
          border: `1px solid ${t.error}40`,
          padding: '16px 24px',
        }}
      >
        {cell.name && (
          <CardTitle name={cell.name} t={t} />
        )}
        <div
          style={{
            color: t.error,
            fontSize: 12,
            fontFamily: t.fontMono,
            whiteSpace: 'pre-wrap',
          }}
        >
          {cell.error}
        </div>
      </div>
    );
  }

  // Result cells — chart or table
  if (!cell.result) return null;

  const chartType = resolveChartType(cell.result, cell.chartConfig);
  const isChart = chartType !== 'table';

  return (
    <div
      style={{
        background: t.cellBg,
        borderRadius: 10,
        border: `1px solid ${t.cellBorder}`,
        overflow: 'hidden',
      }}
    >
      {/* Card header with name and stats */}
      <div
        style={{
          padding: '10px 20px',
          borderBottom: `1px solid ${t.cellBorder}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {cell.name ? (
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: t.textPrimary,
              fontFamily: t.font,
              flex: 1,
            }}
          >
            {cell.name}
          </span>
        ) : (
          <span style={{ flex: 1 }} />
        )}
        <span
          style={{
            fontSize: 10,
            color: t.textMuted,
            fontFamily: t.fontMono,
          }}
        >
          {cell.result.rowCount ?? cell.result.rows.length} rows
          {cell.result.executionTime != null && (
            <> &middot; {cell.result.executionTime < 1000
              ? `${cell.result.executionTime}ms`
              : `${(cell.result.executionTime / 1000).toFixed(1)}s`
            }</>
          )}
        </span>
      </div>

      {/* Output */}
      <div style={{ padding: isChart ? '16px 20px' : 0 }}>
        {isChart ? (
          renderChart(chartType, cell.result, state.themeMode, cell.chartConfig)
        ) : (
          <TableOutput result={cell.result} themeMode={state.themeMode} />
        )}
      </div>
    </div>
  );
}

function CardTitle({ name, t }: { name: string; t: any }) {
  return (
    <div
      style={{
        fontSize: 13,
        fontWeight: 600,
        color: t.textPrimary,
        fontFamily: t.font,
        marginBottom: 8,
      }}
    >
      {name}
    </div>
  );
}

/** Minimal markdown→HTML for dashboard read-only rendering */
function simpleMarkdownToHtml(text: string, t: any): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      // Headings
      const hMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (hMatch) {
        const level = hMatch[1].length;
        const sizes = ['28px', '22px', '18px', '16px', '14px', '13px'];
        return `<div style="font-size:${sizes[level - 1]};font-weight:${level <= 2 ? 700 : 600};color:${t.textPrimary};margin:8px 0 4px">${esc(hMatch[2])}</div>`;
      }
      // HR
      if (/^[-*_]{3,}$/.test(trimmed)) {
        return `<hr style="border:none;border-top:1px solid ${t.cellBorder};margin:8px 0"/>`;
      }
      // Empty line
      if (!trimmed) return '<div style="height:6px"></div>';
      // Inline: bold, italic, code
      let html = esc(trimmed);
      html = html.replace(/\*{2}(.+?)\*{2}/g, '<strong>$1</strong>');
      html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
      html = html.replace(/`(.+?)`/g, `<code style="background:${t.editorBg};padding:1px 4px;border-radius:3px;font-size:0.9em">$1</code>`);
      return `<div style="margin-bottom:4px">${html}</div>`;
    })
    .join('');
}
