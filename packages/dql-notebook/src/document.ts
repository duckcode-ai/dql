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

function listTablesSQL(driver?: string): string {
  switch (driver) {
    case 'duckdb':
    case 'sqlite':
    case 'file':
      return `SHOW TABLES;`;
    case 'postgresql':
    case 'redshift':
      return `SELECT table_schema, table_name FROM information_schema.tables\nWHERE table_schema NOT IN ('information_schema', 'pg_catalog')\nORDER BY table_schema, table_name LIMIT 20;`;
    case 'mysql':
      return `SELECT table_schema, table_name FROM information_schema.tables\nWHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')\nORDER BY table_schema, table_name LIMIT 20;`;
    case 'snowflake':
    case 'mssql':
    case 'databricks':
    case 'trino':
    case 'fabric':
      return `SELECT table_schema, table_name FROM information_schema.tables\nWHERE table_schema NOT IN ('INFORMATION_SCHEMA')\nORDER BY table_schema, table_name LIMIT 20;`;
    default:
      return `SELECT table_schema, table_name FROM information_schema.tables\nLIMIT 20;`;
  }
}

export function createWelcomeNotebook(template: string, projectTitle: string, driver?: string): NotebookDocument {
  const normalized = template.toLowerCase();
  const showTablesQuery = listTablesSQL(driver);

  if (normalized === 'dbt') {
    return createNotebookDocument(`${projectTitle} — DQL Notebook`, [
      {
        id: 'intro',
        type: 'markdown',
        title: 'Welcome',
        source: `# ${projectTitle}\n\nThis notebook connects to your dbt project's database. Run the cells below to explore the tables built by dbt.\n\n> DQL is the **answer layer** on top of dbt. dbt transforms your data — DQL turns it into trusted, governed analytics answers.`,
      },
      {
        id: 'sql-tables',
        type: 'sql',
        title: 'Available Tables',
        source: `-- List tables in your database\n${showTablesQuery}`,
      },
      {
        id: 'sql-explore',
        type: 'sql',
        title: 'Explore Your Data',
        source: `-- Replace 'your_table' with a table name from the results above\n-- SELECT * FROM your_table LIMIT 20;`,
      },
      {
        id: 'dql-example',
        type: 'dql',
        title: 'Example DQL Block',
        source: `block "Example Block" {\n    domain = "analytics"\n    type   = "custom"\n    owner  = "data-team"\n    description = "An example governed analytics block"\n\n    query = """\n        -- Replace with your own query\n        ${showTablesQuery.replace(/\n/g, '\n        ')}\n    """\n\n    tests {\n        assert row_count > 0\n    }\n}`,
      },
      {
        id: 'next-steps',
        type: 'markdown',
        title: 'Next Steps',
        source: `## Next steps\n\n1. **Add SQL cells** — query any table from your dbt project\n2. **Create DQL blocks** — wrap queries with governance (owner, domain, tests)\n3. **Open Block Studio** — use the sidebar to browse tables and semantic metrics\n4. **View lineage** — run \`dql lineage\` to see the full data flow\n5. **Export** — save as \`.dqlnb\` for git-trackable analytics`,
      },
    ], { description: 'DQL notebook for exploring a dbt project.', template: 'dbt' });
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
      id: 'sql-tables',
      type: 'sql',
      title: 'Available Tables',
      source: `-- List tables in your database\n${showTablesQuery}`,
    },
    {
      id: 'sql-starter',
      type: 'sql',
      title: 'Starter Query',
      source: `-- Write your SQL here\n-- If using DuckDB, you can query local CSV, Parquet, and JSON files directly\n-- Example: SELECT * FROM read_csv_auto('./data/my_file.csv') LIMIT 10;`,
    },
    {
      id: 'next-steps',
      type: 'markdown',
      title: 'Next Steps',
      source: `## Next steps\n\n1. **Add data** — place CSV/Parquet files in your project or connect to a database\n2. **Write SQL cells** — query your data interactively\n3. **Create DQL blocks** — wrap queries with governance (owner, domain, tests)\n4. **Export** — save as \`.dqlnb\` for git-trackable analytics`,
    },
  ], { description: 'DQL notebook for interactive analytics.', template: 'default' });
}
