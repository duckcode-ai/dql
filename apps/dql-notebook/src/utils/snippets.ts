export interface Snippet {
  id: string;
  label: string;
  description: string;
  category: 'SQL' | 'DQL' | 'Analysis';
  code: string;
}

export const SNIPPETS: Snippet[] = [
  // SQL category
  {
    id: 'select-all',
    label: 'Select all rows',
    description: 'Read all rows from a CSV file with a row limit',
    category: 'SQL',
    code: `SELECT * FROM read_csv_auto('data/filename.csv') LIMIT 100`,
  },
  {
    id: 'group-by',
    label: 'Group and aggregate',
    description: 'Group rows and compute count + sum',
    category: 'SQL',
    code: `SELECT
  category,
  COUNT(*) AS count,
  SUM(amount) AS total
FROM read_csv_auto('data/filename.csv')
GROUP BY category
ORDER BY total DESC`,
  },
  {
    id: 'filter-date',
    label: 'Filter by date range',
    description: 'Filter rows between two dates',
    category: 'SQL',
    code: `SELECT *
FROM read_csv_auto('data/filename.csv')
WHERE date_column >= '2024-01-01'
  AND date_column < '2025-01-01'`,
  },
  {
    id: 'window-rank',
    label: 'Window function: rank',
    description: 'Rank rows within groups using ROW_NUMBER()',
    category: 'SQL',
    code: `SELECT
  *,
  ROW_NUMBER() OVER (PARTITION BY category ORDER BY amount DESC) AS rank
FROM read_csv_auto('data/filename.csv')`,
  },
  {
    id: 'cte',
    label: 'CTE (WITH clause)',
    description: 'Define a named subquery with WITH',
    category: 'SQL',
    code: `WITH base AS (
  SELECT *
  FROM read_csv_auto('data/filename.csv')
  WHERE amount > 0
)
SELECT
  category,
  SUM(amount) AS total
FROM base
GROUP BY category`,
  },
  {
    id: 'join',
    label: 'Join two tables',
    description: 'Join two CSV files on a shared key',
    category: 'SQL',
    code: `SELECT a.*, b.name
FROM read_csv_auto('data/table_a.csv') AS a
JOIN read_csv_auto('data/table_b.csv') AS b
  ON a.id = b.id`,
  },
  {
    id: 'pivot',
    label: 'Pivot / unpivot',
    description: 'Pivot a column into multiple columns',
    category: 'SQL',
    code: `SELECT *
FROM (
  SELECT category, quarter, amount
  FROM read_csv_auto('data/filename.csv')
) PIVOT (SUM(amount) FOR quarter IN ('Q1', 'Q2', 'Q3', 'Q4'))`,
  },

  // DQL category
  {
    id: 'dql-block',
    label: 'DQL block (basic)',
    description: 'Minimal DQL block with a table visualization',
    category: 'DQL',
    code: `block "My Block" {
    domain      = "analytics"
    type        = "custom"
    description = "Describe what this block does"
    owner       = "data-team"
    tags        = ["analytics"]

    query = """
        SELECT *
        FROM read_csv_auto('data/filename.csv')
        LIMIT 100
    """

    visualization {
        chart = "table"
    }
}`,
  },
  {
    id: 'dql-block-bar',
    label: 'DQL block with bar chart',
    description: 'DQL block with params, bar chart, and a test assertion',
    category: 'DQL',
    code: `block "Revenue by Segment" {
    domain      = "revenue"
    type        = "custom"
    description = "Revenue grouped by segment"
    owner       = "data-team"
    tags        = ["revenue"]

    params {
        period = "current_quarter"
    }

    query = """
        SELECT
            segment_tier AS segment,
            SUM(amount)  AS revenue
        FROM read_csv_auto('data/revenue.csv')
        WHERE fiscal_period = \${period}
        GROUP BY segment_tier
        ORDER BY revenue DESC
    """

    visualization {
        chart = "bar"
        x     = segment
        y     = revenue
    }

    tests {
        assert row_count > 0
    }
}`,
  },

  // Analysis category
  {
    id: 'revenue-by-segment',
    label: 'Revenue by segment',
    description: 'Aggregate revenue totals, deal count, and average deal size per segment',
    category: 'Analysis',
    code: `SELECT
  segment_tier,
  SUM(amount) AS total_revenue,
  COUNT(*) AS deals,
  ROUND(AVG(amount), 0) AS avg_deal
FROM read_csv_auto('data/revenue.csv')
GROUP BY segment_tier
ORDER BY total_revenue DESC`,
  },
  {
    id: 'quarterly-trend',
    label: 'Quarterly trend',
    description: 'Revenue totals grouped by fiscal year and quarter',
    category: 'Analysis',
    code: `SELECT
  fiscal_year || ' ' || fiscal_quarter AS period,
  SUM(amount) AS revenue
FROM read_csv_auto('data/revenue.csv')
GROUP BY fiscal_year, fiscal_quarter
ORDER BY fiscal_year, fiscal_quarter`,
  },
];
