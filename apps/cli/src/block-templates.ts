export interface BlockTemplate {
  id: string;
  name: string;
  description: string;
  content: string;
}

const BLOCK_TEMPLATES: BlockTemplate[] = [
  {
    id: 'metric-report',
    name: 'Metric Report',
    description: 'Single metric query with semantic references and ordering.',
    content: `SELECT
  @metric(total_revenue) AS total_revenue
ORDER BY 1 DESC
LIMIT 50;
`,
  },
  {
    id: 'dimension-analysis',
    name: 'Dimension Analysis',
    description: 'Group a metric by a business dimension.',
    content: `SELECT
  @dim(segment) AS segment,
  @metric(total_revenue) AS total_revenue
GROUP BY 1
ORDER BY 2 DESC
LIMIT 25;
`,
  },
  {
    id: 'time-series',
    name: 'Time Series',
    description: 'Time-based trend using a semantic date dimension.',
    content: `SELECT
  @dim(order_date) AS order_date,
  @metric(total_revenue) AS total_revenue
GROUP BY 1
ORDER BY 1
LIMIT 365;
`,
  },
  {
    id: 'kpi-dashboard',
    name: 'KPI Dashboard',
    description: 'Multiple KPI snapshot query.',
    content: `SELECT
  @metric(total_revenue) AS total_revenue,
  @metric(total_orders) AS total_orders,
  @metric(avg_order_value) AS avg_order_value;
`,
  },
  {
    id: 'data-quality',
    name: 'Data Quality',
    description: 'Simple assertion-style query for row quality checks.',
    content: `SELECT
  COUNT(*) AS row_count,
  COUNT(*) FILTER (WHERE @dim(segment) IS NULL) AS null_segment_rows
FROM orders;
`,
  },
];

export function listBlockTemplates(): BlockTemplate[] {
  return BLOCK_TEMPLATES;
}
