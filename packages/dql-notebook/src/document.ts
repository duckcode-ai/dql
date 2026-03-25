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

  if (normalized === 'dbt') {
    return createNotebookDocument(`${projectTitle} — DQL Notebook`, [
      {
        id: 'intro',
        type: 'markdown',
        title: 'Welcome',
        source: `# ${projectTitle}\n\nThis notebook connects to your dbt project's DuckDB database. Run the cells below to explore the mart tables built by dbt.\n\n> DQL is the **answer layer** on top of dbt. dbt transforms your data — DQL turns it into trusted, governed analytics answers.`,
      },
      {
        id: 'sql-tables',
        type: 'sql',
        title: 'Available Tables',
        source: `-- List all tables in your DuckDB database\nSHOW TABLES;`,
      },
      {
        id: 'sql-customers',
        type: 'sql',
        title: 'Customer Overview',
        source: `SELECT\n  customer_type,\n  COUNT(*) AS customers,\n  ROUND(AVG(count_lifetime_orders), 1) AS avg_orders,\n  ROUND(AVG(lifetime_spend), 2) AS avg_spend\nFROM dim_customers\nGROUP BY customer_type\nORDER BY customers DESC;`,
      },
      {
        id: 'dql-revenue',
        type: 'dql',
        title: 'Order Revenue',
        source: `block "Order Revenue" {\n    domain = "finance"\n    type   = "custom"\n    owner  = "data-team"\n    description = "Total order revenue over time"\n\n    query = """\n        SELECT\n            DATE_TRUNC('month', ordered_at) AS month,\n            COUNT(*) AS orders,\n            ROUND(SUM(order_total), 2) AS revenue\n        FROM fct_orders\n        GROUP BY 1\n        ORDER BY 1\n    """\n\n    visualization {\n        chart = "bar"\n        x     = month\n        y     = revenue\n    }\n\n    tests {\n        assert row_count > 0\n    }\n}`,
      },
      {
        id: 'sql-items',
        type: 'sql',
        title: 'Top Products',
        source: `SELECT\n  p.product_name,\n  COUNT(*) AS items_sold,\n  ROUND(SUM(oi.product_price), 2) AS total_revenue\nFROM order_items oi\nJOIN stg_products p ON oi.product_id = p.product_id\nGROUP BY p.product_name\nORDER BY total_revenue DESC\nLIMIT 10;`,
      },
      {
        id: 'next-steps',
        type: 'markdown',
        title: 'Next Steps',
        source: `## Next steps\n\n1. **Add SQL cells** — query any table from your dbt project\n2. **Create DQL blocks** — wrap queries with governance (owner, domain, tests)\n3. **Import lineage** — run \`dql compile --dbt-manifest target/manifest.json\`\n4. **View lineage** — run \`dql lineage\` to see the full data flow\n5. **Export** — save as \`.dqlnb\` for git-trackable analytics`,
      },
    ], { description: 'DQL notebook for exploring a dbt project with DuckDB.', template: 'dbt' });
  }

  // Default notebook for non-dbt projects
  return createNotebookDocument(`${projectTitle} — DQL Notebook`, [
    {
      id: 'intro',
      type: 'markdown',
      title: 'Welcome',
      source: `# ${projectTitle}\n\nWelcome to the DQL notebook. Use this notebook to write SQL, create governed DQL blocks, and build analytics answers — all tracked in Git.`,
    },
    {
      id: 'sql-starter',
      type: 'sql',
      title: 'Starter Query',
      source: `-- Write your SQL here\n-- DQL uses DuckDB — you can query local CSV, Parquet, and JSON files directly\n-- Example: SELECT * FROM read_csv_auto('./data/my_file.csv') LIMIT 10;`,
    },
    {
      id: 'next-steps',
      type: 'markdown',
      title: 'Next Steps',
      source: `## Next steps\n\n1. **Add data** — place CSV/Parquet files in your project or connect to a database\n2. **Write SQL cells** — query your data interactively\n3. **Create DQL blocks** — wrap queries with governance (owner, domain, tests)\n4. **Export** — save as \`.dqlnb\` for git-trackable analytics`,
    },
  ], { description: 'DQL notebook for interactive analytics.', template: 'default' });
}
