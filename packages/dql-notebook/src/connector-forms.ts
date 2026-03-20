import type { ConnectionConfig } from '@duckcodeailabs/dql-connectors';

export interface ConnectorFieldSchema {
  key: keyof ConnectionConfig | 'name';
  label: string;
  type: 'text' | 'number' | 'password' | 'checkbox';
  placeholder?: string;
  required?: boolean;
}

export interface ConnectorFormSchema {
  driver: ConnectionConfig['driver'];
  label: string;
  category: 'local' | 'warehouse' | 'lakehouse';
  description: string;
  fields: ConnectorFieldSchema[];
}

const schemas: ConnectorFormSchema[] = [
  {
    driver: 'file',
    label: 'Files / DuckDB memory',
    category: 'local',
    description: 'Query CSV, Parquet, and JSON files with DuckDB locally.',
    fields: [
      { key: 'filepath', label: 'DuckDB file path', type: 'text', placeholder: ':memory:' },
    ],
  },
  {
    driver: 'duckdb',
    label: 'DuckDB',
    category: 'local',
    description: 'Connect directly to a local DuckDB database file.',
    fields: [
      { key: 'filepath', label: 'DuckDB file path', type: 'text', placeholder: './local/dev.duckdb', required: true },
    ],
  },
  {
    driver: 'sqlite',
    label: 'SQLite',
    category: 'local',
    description: 'Connect to a local SQLite database file.',
    fields: [
      { key: 'filepath', label: 'SQLite file path', type: 'text', placeholder: './local/dev.sqlite', required: true },
    ],
  },
  {
    driver: 'postgresql',
    label: 'PostgreSQL',
    category: 'warehouse',
    description: 'Standard PostgreSQL analytics databases and services.',
    fields: warehouseFields(5432),
  },
  {
    driver: 'mysql',
    label: 'MySQL',
    category: 'warehouse',
    description: 'MySQL-compatible databases and managed services.',
    fields: warehouseFields(3306),
  },
  {
    driver: 'mssql',
    label: 'SQL Server',
    category: 'warehouse',
    description: 'Microsoft SQL Server over the TDS protocol.',
    fields: warehouseFields(1433),
  },
  {
    driver: 'fabric',
    label: 'Microsoft Fabric',
    category: 'lakehouse',
    description: 'Fabric warehouse and lakehouse SQL endpoints.',
    fields: warehouseFields(1433),
  },
  {
    driver: 'redshift',
    label: 'Amazon Redshift',
    category: 'warehouse',
    description: 'Redshift clusters and serverless endpoints.',
    fields: warehouseFields(5439),
  },
  {
    driver: 'snowflake',
    label: 'Snowflake',
    category: 'warehouse',
    description: 'Snowflake account, warehouse, database, and role.',
    fields: [
      { key: 'account', label: 'Account', type: 'text', required: true },
      { key: 'warehouse', label: 'Warehouse', type: 'text', required: true },
      { key: 'database', label: 'Database', type: 'text', required: true },
      { key: 'schema', label: 'Schema', type: 'text', required: true },
      { key: 'username', label: 'Username', type: 'text', required: true },
      { key: 'password', label: 'Password', type: 'password', required: true },
      { key: 'role', label: 'Role', type: 'text' },
    ],
  },
  {
    driver: 'bigquery',
    label: 'BigQuery',
    category: 'warehouse',
    description: 'Google BigQuery project-level connection.',
    fields: [
      { key: 'projectId', label: 'Project ID', type: 'text', required: true },
    ],
  },
  {
    driver: 'clickhouse',
    label: 'ClickHouse',
    category: 'warehouse',
    description: 'ClickHouse HTTP or cloud service endpoints.',
    fields: [
      { key: 'host', label: 'Host', type: 'text', required: true },
      { key: 'port', label: 'Port', type: 'number', placeholder: '8443' },
      { key: 'database', label: 'Database', type: 'text' },
      { key: 'username', label: 'Username', type: 'text' },
      { key: 'password', label: 'Password', type: 'password' },
      { key: 'ssl', label: 'Use TLS', type: 'checkbox' },
    ],
  },
  {
    driver: 'databricks',
    label: 'Databricks SQL',
    category: 'lakehouse',
    description: 'Databricks SQL warehouse hostname, path, and personal access token.',
    fields: [
      { key: 'host', label: 'Server hostname', type: 'text', required: true },
      { key: 'database', label: 'Catalog / database', type: 'text' },
      { key: 'schema', label: 'Schema', type: 'text' },
      { key: 'warehouse', label: 'HTTP path / warehouse', type: 'text', required: true },
      { key: 'password', label: 'Access token', type: 'password', required: true },
    ],
  },
  {
    driver: 'athena',
    label: 'Amazon Athena',
    category: 'lakehouse',
    description: 'Athena workgroup-backed query execution via AWS.',
    fields: [
      { key: 'host', label: 'Region', type: 'text', placeholder: 'us-east-1', required: true },
      { key: 'database', label: 'Database', type: 'text', required: true },
      { key: 'schema', label: 'S3 output location', type: 'text', placeholder: 's3://bucket/query-results/', required: true },
      { key: 'warehouse', label: 'Workgroup', type: 'text' },
    ],
  },
  {
    driver: 'trino',
    label: 'Trino',
    category: 'lakehouse',
    description: 'Trino / Starburst clusters exposed over HTTP.',
    fields: [
      { key: 'host', label: 'Host', type: 'text', required: true },
      { key: 'port', label: 'Port', type: 'number', placeholder: '8080' },
      { key: 'database', label: 'Catalog', type: 'text', required: true },
      { key: 'schema', label: 'Schema', type: 'text', required: true },
      { key: 'username', label: 'Username', type: 'text' },
      { key: 'password', label: 'Password', type: 'password' },
      { key: 'ssl', label: 'Use TLS', type: 'checkbox' },
    ],
  },
];

export function getConnectorFormSchemas(): ConnectorFormSchema[] {
  return schemas;
}

function warehouseFields(defaultPort: number): ConnectorFieldSchema[] {
  return [
    { key: 'host', label: 'Host', type: 'text', required: true },
    { key: 'port', label: 'Port', type: 'number', placeholder: String(defaultPort) },
    { key: 'database', label: 'Database', type: 'text', required: true },
    { key: 'username', label: 'Username', type: 'text' },
    { key: 'password', label: 'Password', type: 'password' },
    { key: 'ssl', label: 'Use TLS', type: 'checkbox' },
    { key: 'connectionString', label: 'Connection string', type: 'text' },
  ];
}
