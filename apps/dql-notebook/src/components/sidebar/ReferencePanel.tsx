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

const SEMANTIC_METRIC_YAML = `# semantic-layer/metrics/total_revenue.yaml
name: total_revenue
label: Total Revenue
description: Sum of all recognized revenue.
domain: finance
sql: SUM(amount)
type: sum          # sum|count|count_distinct|avg|min|max|custom
table: fct_revenue
tags:
  - revenue
  - kpi`;

const SEMANTIC_DIMENSION_YAML = `# semantic-layer/dimensions/segment.yaml
name: segment
label: Customer Segment
description: Customer segment tier.
sql: segment_tier
type: string       # string|number|date|boolean
table: fct_revenue`;

const SEMANTIC_HIERARCHY_YAML = `# semantic-layer/hierarchies/time.yaml
name: fiscal_time
label: Fiscal Time
description: Drill from year to quarter.
domain: finance
levels:
  - name: fiscal_year
    dimension: fiscal_year
    order: 1
  - name: fiscal_quarter
    dimension: fiscal_quarter
    order: 2
defaultRollup: sum`;

const SEMANTIC_CUBE_YAML = `# semantic-layer/cubes/revenue_cube.yaml
name: revenue
label: Revenue Cube
table: fct_revenue
domain: finance

measures:
  - name: total_revenue
    sql: SUM(amount)
    type: sum
  - name: deal_count
    sql: COUNT(*)
    type: count

dimensions:
  - name: segment_tier
    sql: segment_tier
    type: string

time_dimensions:
  - name: recognized_at
    sql: recognized_at
    primary_time: true
    granularities: [day, month, quarter, year]

joins:
  - name: customers
    type: left
    sql: "\${left}.customer_id = \${right}.id"`;

const SEMANTIC_CONFIG_DQL = `{
  "semanticLayer": {
    "provider": "dql"
  }
}`;

const SEMANTIC_CONFIG_DBT = `{
  "semanticLayer": {
    "provider": "dbt",
    "projectPath": "/path/to/your/dbt-project"
  }
}`;

const SEMANTIC_CONFIG_CUBEJS = `{
  "semanticLayer": {
    "provider": "cubejs",
    "projectPath": "/path/to/your/cube-project"
  }
}`;

const CONNECTION_DUCKDB = `{
  "defaultConnection": {
    "driver": "file",
    "filepath": ":memory:"
  }
}`;

const CONNECTION_SNOWFLAKE = `{
  "defaultConnection": {
    "driver": "snowflake",
    "account": "acme.snowflakecomputing.com",
    "username": "your_user",
    "password": "\${SNOWFLAKE_PASSWORD}",
    "database": "ANALYTICS",
    "schema": "PUBLIC",
    "warehouse": "COMPUTE_WH",
    "role": "ANALYST"
  }
}`;

const CONNECTION_BIGQUERY = `{
  "defaultConnection": {
    "driver": "bigquery",
    "project": "your-gcp-project-id",
    "dataset": "analytics",
    "keyFilename": "./service-account.json"
  }
}`;

const CONNECTION_POSTGRES = `{
  "defaultConnection": {
    "driver": "postgres",
    "host": "localhost",
    "port": 5432,
    "database": "analytics",
    "username": "your_user",
    "password": "\${POSTGRES_PASSWORD}"
  }
}`;

const SEMANTIC_REFS_TEMPLATE = `-- Reference metrics and dimensions inline in any SQL cell.
-- DQL resolves these at query time — no SQL duplication.
SELECT
  @dim(segment),
  @metric(total_revenue)
FROM fct_revenue
GROUP BY @dim(segment)
ORDER BY @metric(total_revenue) DESC

-- Or use Compose Query in the Semantic Layer panel:
-- 1. Pick metrics + dimensions (+ optional time dimension)
-- 2. Click "Compose SQL"
-- 3. Click "+ Insert as Cell" to add the generated SQL`;

const SEMANTIC_CONFIG_SNOWFLAKE = `{
  "semanticLayer": {
    "provider": "snowflake",
    "projectPath": "MY_DATABASE"
  }
}`;

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
        <div style={{ marginTop: 8, fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.6 }}>
          Run <code style={{ fontFamily: t.fontMono, color: t.accent, fontSize: 11 }}>dql certify &lt;file&gt; --connection duckdb</code> to
          execute <code style={{ fontFamily: t.fontMono, color: t.accent, fontSize: 11 }}>tests &#123;&#125;</code> assertions against live data.
          Use <code style={{ fontFamily: t.fontMono, color: t.accent, fontSize: 11 }}>--skip-tests</code> to check governance fields only.
        </div>
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

      {/* 5. Semantic Layer Usage */}
      <Section title="Semantic Layer Usage" defaultOpen={false} t={t}>
        <div
          style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.7, fontFamily: t.font, marginBottom: 6 }}
        >
          Use{' '}
          <code style={{ fontFamily: t.fontMono, color: t.accent, fontSize: 11 }}>@metric(name)</code>
          {' '}and{' '}
          <code style={{ fontFamily: t.fontMono, color: t.accent, fontSize: 11 }}>@dim(name)</code>
          {' '}inline in SQL cells, or use Compose Query in the Semantic Layer panel.
        </div>
        <CodeBlock t={t} code={SEMANTIC_REFS_TEMPLATE} />
      </Section>

      {/* 6. Semantic Layer Setup */}
      <Section title="Semantic Layer" defaultOpen={false} t={t}>
        <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.7, fontFamily: t.font, marginBottom: 8 }}>
          Define reusable metrics, dimensions, and hierarchies in YAML.
          They appear in the{' '}
          <strong style={{ color: t.textPrimary }}>Semantic Layer</strong> sidebar panel.
        </div>

        <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, fontFamily: t.font, margin: '10px 0 4px', letterSpacing: '0.03em' }}>
          Directory Structure
        </div>
        <CodeBlock t={t} code={`my-project/
├── dql.config.json
└── semantic-layer/
    ├── metrics/       ← one YAML per metric
    ├── dimensions/    ← one YAML per dimension
    ├── hierarchies/   ← optional drill paths
    └── cubes/         ← optional (groups all into one)`} />

        <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, fontFamily: t.font, margin: '12px 0 4px', letterSpacing: '0.03em' }}>
          Metric YAML
        </div>
        <CodeBlock t={t} code={SEMANTIC_METRIC_YAML} />

        <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, fontFamily: t.font, margin: '12px 0 4px', letterSpacing: '0.03em' }}>
          Dimension YAML
        </div>
        <CodeBlock t={t} code={SEMANTIC_DIMENSION_YAML} />

        <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, fontFamily: t.font, margin: '12px 0 4px', letterSpacing: '0.03em' }}>
          Hierarchy YAML
        </div>
        <CodeBlock t={t} code={SEMANTIC_HIERARCHY_YAML} />

        <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, fontFamily: t.font, margin: '12px 0 4px', letterSpacing: '0.03em' }}>
          Cube YAML (advanced — multi-table with joins)
        </div>
        <CodeBlock t={t} code={SEMANTIC_CUBE_YAML} />
      </Section>

      {/* 7. Semantic Layer Providers */}
      <Section title="Semantic Layer Providers" defaultOpen={false} t={t}>
        <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.7, fontFamily: t.font, marginBottom: 8 }}>
          Add to your <code style={{ fontFamily: t.fontMono, color: t.accent, fontSize: 11 }}>dql.config.json</code> to
          connect a semantic layer provider.
        </div>

        <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, fontFamily: t.font, margin: '10px 0 4px', letterSpacing: '0.03em' }}>
          DQL Native (YAML files in semantic-layer/)
        </div>
        <CodeBlock t={t} code={SEMANTIC_CONFIG_DQL} />

        <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, fontFamily: t.font, margin: '12px 0 4px', letterSpacing: '0.03em' }}>
          dbt (reads models/**/*.yml)
        </div>
        <CodeBlock t={t} code={SEMANTIC_CONFIG_DBT} />
        <div style={{ marginTop: 4, fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.5 }}>
          Point to your dbt project root (directory with <code style={{ fontFamily: t.fontMono, fontSize: 10 }}>dbt_project.yml</code>).
          Reads <code style={{ fontFamily: t.fontMono, fontSize: 10 }}>semantic_models</code> and{' '}
          <code style={{ fontFamily: t.fontMono, fontSize: 10 }}>metrics</code> blocks (dbt 1.6+).
        </div>

        <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, fontFamily: t.font, margin: '12px 0 4px', letterSpacing: '0.03em' }}>
          Cube.js (reads model/ or schema/)
        </div>
        <CodeBlock t={t} code={SEMANTIC_CONFIG_CUBEJS} />
        <div style={{ marginTop: 4, fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.5 }}>
          Point to your Cube.js project root. Reads{' '}
          <code style={{ fontFamily: t.fontMono, fontSize: 10 }}>cubes:</code> blocks from YAML schema files.
        </div>

        <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, fontFamily: t.font, margin: '12px 0 4px', letterSpacing: '0.03em' }}>
          Snowflake Semantic Views (requires live connection)
        </div>
        <CodeBlock t={t} code={SEMANTIC_CONFIG_SNOWFLAKE} />
        <div style={{ marginTop: 4, fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.5 }}>
          Introspects Snowflake semantic views via{' '}
          <code style={{ fontFamily: t.fontMono, fontSize: 10 }}>SHOW SEMANTIC VIEWS</code>.
          Set <code style={{ fontFamily: t.fontMono, fontSize: 10 }}>projectPath</code> to your database name to scope discovery.
          Requires a Snowflake connection in <code style={{ fontFamily: t.fontMono, fontSize: 10 }}>defaultConnection</code>.
        </div>
      </Section>

      {/* 8. Connection Setup */}
      <Section title="Connection Setup" defaultOpen={false} t={t}>
        <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.7, fontFamily: t.font, marginBottom: 8 }}>
          Configure <code style={{ fontFamily: t.fontMono, color: t.accent, fontSize: 11 }}>defaultConnection</code> in{' '}
          <code style={{ fontFamily: t.fontMono, color: t.accent, fontSize: 11 }}>dql.config.json</code>.
        </div>

        <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, fontFamily: t.font, margin: '10px 0 4px', letterSpacing: '0.03em' }}>
          DuckDB (in-memory — default)
        </div>
        <CodeBlock t={t} code={CONNECTION_DUCKDB} />

        <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, fontFamily: t.font, margin: '12px 0 4px', letterSpacing: '0.03em' }}>
          Snowflake
        </div>
        <CodeBlock t={t} code={CONNECTION_SNOWFLAKE} />

        <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, fontFamily: t.font, margin: '12px 0 4px', letterSpacing: '0.03em' }}>
          BigQuery
        </div>
        <CodeBlock t={t} code={CONNECTION_BIGQUERY} />

        <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, fontFamily: t.font, margin: '12px 0 4px', letterSpacing: '0.03em' }}>
          PostgreSQL
        </div>
        <CodeBlock t={t} code={CONNECTION_POSTGRES} />

        <div style={{ marginTop: 8, fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.5 }}>
          Use <code style={{ fontFamily: t.fontMono, fontSize: 10 }}>${'${ENV_VAR}'}</code> syntax for secrets.
          Run <code style={{ fontFamily: t.fontMono, fontSize: 10 }}>dql doctor</code> to verify your connection.
        </div>
      </Section>

      {/* 9. Variable References */}
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
