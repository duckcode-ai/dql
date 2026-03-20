export type NotebookCellType = 'markdown' | 'sql' | 'dql' | 'chart';

export interface NotebookMetadata {
  title: string;
  description?: string;
  createdWith: 'dql';
  template?: string;
}

export interface NotebookChartConfig {
  sourceCellId?: string;
  chart?: string;
  x?: string;
  y?: string;
  y2?: string;
  color?: string;
  title?: string;
}

export interface NotebookCell {
  id: string;
  type: NotebookCellType;
  title?: string;
  source: string;
  config?: NotebookChartConfig;
}

export interface NotebookDocument {
  version: 1;
  metadata: NotebookMetadata;
  cells: NotebookCell[];
}

export function createNotebookDocument(
  title: string,
  cells: NotebookCell[],
  metadata: Partial<NotebookMetadata> = {},
): NotebookDocument {
  return {
    version: 1,
    metadata: {
      title,
      createdWith: 'dql',
      ...metadata,
    },
    cells,
  };
}

export function serializeNotebook(document: NotebookDocument): string {
  return JSON.stringify(document, null, 2);
}

export function deserializeNotebook(raw: string): NotebookDocument {
  const parsed = JSON.parse(raw) as Partial<NotebookDocument>;
  if (parsed.version !== 1 || !parsed.metadata?.title || !Array.isArray(parsed.cells)) {
    throw new Error('Invalid .dqlnb document.');
  }

  return {
    version: 1,
    metadata: {
      title: parsed.metadata.title,
      description: parsed.metadata.description,
      createdWith: 'dql',
      template: parsed.metadata.template,
    },
    cells: parsed.cells.map((cell, index) => ({
      id: cell.id ?? `cell-${index + 1}`,
      type: cell.type ?? 'markdown',
      title: cell.title,
      source: cell.source ?? '',
      config: cell.config,
    })),
  };
}

export function createWelcomeNotebook(template: string, projectTitle: string): NotebookDocument {
  const normalized = template.toLowerCase();

  if (normalized === 'ecommerce') {
    return createNotebookDocument(`${projectTitle} Welcome`, [
      {
        id: 'intro',
        type: 'markdown',
        title: 'Welcome',
        source: `# ${projectTitle}\n\nThis notebook gives you a browser-first tour of DQL using the bundled e-commerce sample data. Run the cells below to explore revenue, funnel health, and repeat purchase behavior.`,
      },
      {
        id: 'dql-revenue',
        type: 'dql',
        title: 'Revenue by Channel',
        source: `block "Revenue by Channel" {\n    domain = "commerce"\n    type = "custom"\n    description = "Starter DQL block for channel-level revenue"\n\n    query = """\n        SELECT channel, ROUND(SUM(order_total), 2) AS revenue\n        FROM read_csv_auto('./data/orders.csv')\n        GROUP BY channel\n        ORDER BY revenue DESC\n    """\n\n    visualization {\n        chart = "bar"\n        x = channel\n        y = revenue\n    }\n\n    tests {\n        assert row_count > 0\n    }\n}`,
      },
      {
        id: 'sql-funnel',
        type: 'sql',
        title: 'Checkout Funnel',
        source: `SELECT step, users\nFROM read_csv_auto('./data/funnel.csv')\nORDER BY sort_order;`,
      },
      {
        id: 'chart-funnel',
        type: 'chart',
        title: 'Funnel View',
        source: '',
        config: {
          sourceCellId: 'sql-funnel',
          chart: 'bar',
          x: 'step',
          y: 'users',
          title: 'Funnel conversion by step',
        },
      },
    ], { description: 'Guided walkthrough for the e-commerce template.', template: 'ecommerce' });
  }

  if (normalized === 'saas') {
    return createNotebookDocument(`${projectTitle} Welcome`, [
      {
        id: 'intro',
        type: 'markdown',
        title: 'Welcome',
        source: `# ${projectTitle}\n\nThis notebook highlights MRR, churn, and expansion revenue using the bundled SaaS sample data.`,
      },
      {
        id: 'dql-mrr',
        type: 'dql',
        title: 'MRR by Plan',
        source: `block "MRR by Plan" {\n    domain = "saas"\n    type = "custom"\n    description = "Monthly recurring revenue by plan tier"\n\n    query = """\n        SELECT plan_tier, ROUND(SUM(mrr), 2) AS mrr\n        FROM read_csv_auto('./data/subscriptions.csv')\n        WHERE status = 'active'\n        GROUP BY plan_tier\n        ORDER BY mrr DESC\n    """\n\n    visualization {\n        chart = "bar"\n        x = plan_tier\n        y = mrr\n    }\n}`,
      },
      {
        id: 'sql-cohort',
        type: 'sql',
        title: 'Logo Retention',
        source: `SELECT cohort_month, retained_accounts\nFROM read_csv_auto('./data/cohorts.csv')\nORDER BY cohort_month;`,
      },
      {
        id: 'chart-cohort',
        type: 'chart',
        title: 'Retention Trend',
        source: '',
        config: {
          sourceCellId: 'sql-cohort',
          chart: 'line',
          x: 'cohort_month',
          y: 'retained_accounts',
          title: 'Retained accounts by cohort',
        },
      },
    ], { description: 'Guided walkthrough for the SaaS template.', template: 'saas' });
  }

  if (normalized === 'taxi') {
    return createNotebookDocument(`${projectTitle} Welcome`, [
      {
        id: 'intro',
        type: 'markdown',
        title: 'Welcome',
        source: `# ${projectTitle}\n\nThis notebook explores trip volume, fares, and pickup patterns using the bundled taxi dataset.`,
      },
      {
        id: 'dql-borough',
        type: 'dql',
        title: 'Trips by Borough',
        source: `block "Trips by Borough" {\n    domain = "mobility"\n    type = "custom"\n    description = "Trip count by pickup borough"\n\n    query = """\n        SELECT pickup_borough, COUNT(*) AS trip_count\n        FROM read_csv_auto('./data/trips.csv')\n        GROUP BY pickup_borough\n        ORDER BY trip_count DESC\n    """\n\n    visualization {\n        chart = "bar"\n        x = pickup_borough\n        y = trip_count\n    }\n}`,
      },
      {
        id: 'sql-fare',
        type: 'sql',
        title: 'Average Fare by Hour',
        source: `SELECT pickup_hour, ROUND(AVG(fare_amount), 2) AS avg_fare\nFROM read_csv_auto('./data/trips.csv')\nGROUP BY pickup_hour\nORDER BY pickup_hour;`,
      },
      {
        id: 'chart-fare',
        type: 'chart',
        title: 'Hourly Fare Trend',
        source: '',
        config: {
          sourceCellId: 'sql-fare',
          chart: 'line',
          x: 'pickup_hour',
          y: 'avg_fare',
          title: 'Average fare by pickup hour',
        },
      },
    ], { description: 'Guided walkthrough for the NYC taxi template.', template: 'taxi' });
  }

  return createNotebookDocument(`${projectTitle} Welcome`, [
    {
      id: 'intro',
      type: 'markdown',
      title: 'Welcome',
      source: `# ${projectTitle}\n\nWelcome to the browser-first DQL notebook. Use this notebook to edit DQL, run raw SQL, and compare chart configurations without leaving the browser.`,
    },
    {
      id: 'dql-starter',
      type: 'dql',
      title: 'Starter DQL Block',
      source: `block "Revenue by Segment" {\n    domain = "revenue"\n    type = "custom"\n    description = "Starter block for segment revenue analysis"\n\n    query = """\n        SELECT segment_tier AS segment, SUM(amount) AS revenue\n        FROM read_csv_auto('./data/revenue.csv')\n        GROUP BY segment_tier\n        ORDER BY revenue DESC\n    """\n\n    visualization {\n        chart = "bar"\n        x = segment\n        y = revenue\n    }\n}`,
    },
    {
      id: 'markdown-next',
      type: 'markdown',
      title: 'Next Steps',
      source: `## What to try next\n\n- Edit the SQL in the DQL cell and run it again\n- Add a new SQL or markdown cell from the toolbar\n- Export this notebook as a \`.dqlnb\` file for git-friendly review`,
    },
  ], { description: 'Guided walkthrough for the starter template.', template: 'starter' });
}
