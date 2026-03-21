import React, { useState } from 'react';
import { themes } from '../../themes/notebook-theme';
import type { Theme } from '../../themes/notebook-theme';
import type { ThemeMode } from '../../store/types';

interface ReferencePanelProps {
  themeMode: ThemeMode;
}

// Generic collapsible section
function Section({
  title,
  defaultOpen = false,
  children,
  t,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  t: Theme;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [hovered, setHovered] = useState(false);

  return (
    <div style={{ borderBottom: `1px solid ${t.headerBorder}` }}>
      <button
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: '100%',
          padding: '7px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: hovered ? t.sidebarItemHover : 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          transition: 'background 0.1s',
        }}
      >
        <span
          style={{
            fontSize: 9,
            color: t.textMuted,
            display: 'inline-block',
            transition: 'transform 0.15s',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            lineHeight: 1,
          }}
        >
          &#9654;
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            fontFamily: t.font,
            color: t.textSecondary,
            letterSpacing: '0.04em',
          }}
        >
          {title}
        </span>
      </button>

      {open && (
        <div style={{ padding: '4px 12px 10px' }}>{children}</div>
      )}
    </div>
  );
}

// Copy button that shows a checkmark for 1.5s
function CopyButton({ code, t }: { code: string; t: Theme }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // fallback for non-secure contexts
      const el = document.createElement('textarea');
      el.value = code;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      style={{
        position: 'absolute',
        top: 6,
        right: 6,
        padding: '2px 6px',
        fontSize: 10,
        fontFamily: t.font,
        background: copied ? `${t.success}20` : t.btnBg,
        border: `1px solid ${copied ? t.success + '50' : t.btnBorder}`,
        borderRadius: 4,
        cursor: 'pointer',
        color: copied ? t.success : t.textMuted,
        transition: 'all 0.15s',
      }}
    >
      {copied ? '✓' : 'Copy'}
    </button>
  );
}

// Code block with copy button
function CodeBlock({ code, t }: { code: string; t: Theme }) {
  return (
    <div style={{ position: 'relative', marginTop: 6 }}>
      <pre
        style={{
          margin: 0,
          padding: '8px 10px',
          paddingRight: 52,
          background: t.editorBg,
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 6,
          fontFamily: t.fontMono,
          fontSize: 11,
          color: t.textPrimary,
          lineHeight: 1.6,
          whiteSpace: 'pre',
          overflowX: 'auto',
        }}
      >
        {code}
      </pre>
      <CopyButton code={code} t={t} />
    </div>
  );
}

// Small table for function reference
function RefTable({
  rows,
  t,
}: {
  rows: [string, string][];
  t: Theme;
}) {
  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: 11,
        fontFamily: t.font,
        marginTop: 6,
      }}
    >
      <tbody>
        {rows.map(([name, desc], i) => (
          <tr
            key={i}
            style={{ borderBottom: `1px solid ${t.tableBorder}` }}
          >
            <td
              style={{
                padding: '5px 6px 5px 0',
                fontFamily: t.fontMono,
                fontSize: 11,
                color: t.accent,
                whiteSpace: 'nowrap',
                verticalAlign: 'top',
                width: '45%',
              }}
            >
              {name}
            </td>
            <td
              style={{
                padding: '5px 0',
                color: t.textSecondary,
                verticalAlign: 'top',
                lineHeight: 1.5,
              }}
            >
              {desc}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const DQL_BLOCK_TEMPLATE = `block "Revenue by Channel" {
    domain      = "revenue"
    type        = "custom"
    description = "Revenue grouped by sales channel"
    owner       = "data-team"
    tags        = ["revenue"]

    params {
        period = "current_quarter"
    }

    query = """
        SELECT channel,
               SUM(order_total) AS revenue
        FROM read_csv_auto('data/orders.csv')
        WHERE fiscal_period = \${period}
        GROUP BY channel
        ORDER BY revenue DESC
    """

    visualization {
        chart = "bar"
        x     = channel
        y     = revenue
    }

    tests {
        assert row_count > 0
    }
}`;

const DQL_IMPORT_TEMPLATE = `-- Simple import (uses block's default params)
@import "./blocks/revenue_by_channel.dql"

-- Import with custom params (override block defaults)
@import "./blocks/revenue_by_channel.dql" with period = "Q4_2024"

-- Import with multiple params
@import "./blocks/pipeline_health.dql" with
    stage = "Closed Won",
    region = "EMEA"`;

export function ReferencePanel({ themeMode }: ReferencePanelProps) {
  const t = themes[themeMode];

  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        fontFamily: t.font,
      }}
    >
      {/* 1. SQL Essentials */}
      <Section title="SQL Essentials" defaultOpen={true} t={t}>
        <CodeBlock
          t={t}
          code={`-- Basic select
SELECT col1, col2
FROM table_name
WHERE condition
ORDER BY col1 DESC
LIMIT 100

-- GROUP BY
SELECT col, COUNT(*), SUM(val)
FROM table_name
GROUP BY col

-- JOIN
SELECT a.*, b.col
FROM table_a AS a
JOIN table_b AS b ON a.id = b.id

-- CTE (WITH)
WITH cte AS (
  SELECT * FROM table_name WHERE val > 0
)
SELECT * FROM cte

-- Window function
SELECT *,
  ROW_NUMBER() OVER (
    PARTITION BY group_col
    ORDER BY val DESC
  ) AS rank
FROM table_name`}
        />
      </Section>

      {/* 2. DuckDB Functions */}
      <Section title="DuckDB Functions" defaultOpen={false} t={t}>
        <RefTable
          t={t}
          rows={[
            ["read_csv_auto(path)", "Auto-detect CSV schema and load"],
            ["read_parquet(path)", "Load a Parquet file"],
            ["strftime(date, fmt)", "Format date as string (e.g. '%Y-%m')"],
            ["date_trunc(part, date)", "Truncate date to part ('month', 'year'…)"],
            ["CURRENT_DATE", "Today's date"],
            ["epoch_ms(ts)", "Convert epoch milliseconds to timestamp"],
            ["array_agg(col)", "Aggregate column values into an array"],
            ["string_agg(col, sep)", "Concatenate values with separator"],
          ]}
        />
      </Section>

      {/* 3. DQL Block Structure */}
      <Section title="DQL Block Structure" defaultOpen={true} t={t}>
        <CodeBlock t={t} code={DQL_BLOCK_TEMPLATE} />
      </Section>

      {/* 4. DQL Chart Types */}
      <Section title="DQL Chart Types" defaultOpen={false} t={t}>
        <RefTable
          t={t}
          rows={[
            ["table", "Tabular data grid (default)"],
            ["bar", "Bar chart — use x and y fields"],
            ["line", "Line chart — use x (date) and y (value)"],
            ["pie", "Pie/donut chart — use x (label) and y (value)"],
            ["kpi", "Single big-number KPI card (dql preview)"],
          ]}
        />
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: t.textMuted,
            fontFamily: t.font,
            lineHeight: 1.6,
          }}
        >
          Set chart type inside the{' '}
          <code style={{ fontFamily: t.fontMono, color: t.accent, fontSize: 11 }}>
            visualization &#123; chart = "pie"; x = label_col; y = value_col &#125;
          </code>{' '}
          block.
        </div>
      </Section>

      {/* 5. Block Imports */}
      <Section title="Block Imports (@import)" defaultOpen={false} t={t}>
        <div
          style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.7, fontFamily: t.font, marginBottom: 6 }}
        >
          Reference a <code style={{ fontFamily: t.fontMono, color: t.accent, fontSize: 11 }}>.dql</code> block
          file instead of copying its SQL. Run the cell to execute the block's query.
        </div>
        <CodeBlock t={t} code={DQL_IMPORT_TEMPLATE} />
        <div
          style={{ marginTop: 8, fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.6 }}
        >
          Parameters override the block's <code style={{ fontFamily: t.fontMono, color: t.accent, fontSize: 11 }}>params &#123; &#125;</code> defaults.
          The block's <code style={{ fontFamily: t.fontMono, color: t.accent, fontSize: 11 }}>visualization</code> config is applied automatically.
        </div>
      </Section>

      {/* 6. Variable References */}
      <Section title="Variable References" defaultOpen={false} t={t}>
        <div
          style={{
            fontSize: 12,
            color: t.textSecondary,
            lineHeight: 1.7,
            fontFamily: t.font,
            marginBottom: 8,
          }}
        >
          Use{' '}
          <code style={{ fontFamily: t.fontMono, color: t.accent, fontSize: 11 }}>
            {'{{cell_name}}'}
          </code>{' '}
          to reference other cells:
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            <li>
              <strong>Param cell</strong> → substituted as a SQL literal value
            </li>
            <li>
              <strong>SQL cell</strong> → injected as a CTE
            </li>
          </ul>
        </div>
        <CodeBlock
          t={t}
          code={`-- Param cell named "start_date" holds '2024-01-01'
SELECT *
FROM read_csv_auto('data/sales.csv')
WHERE date >= {{start_date}}

-- SQL cell named "base_query" used as CTE
SELECT segment, SUM(revenue) AS total
FROM {{base_query}}
GROUP BY segment`}
        />
      </Section>
    </div>
  );
}
