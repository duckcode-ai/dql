import React, { useEffect, useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { Theme } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import { PanelFrame } from '@duckcodeailabs/dql-ui';
import { DriverLogo } from './DriverLogo';

interface ConnectorFieldSchema {
  key: string;
  label: string;
  type: 'text' | 'number' | 'password' | 'checkbox' | 'select' | 'textarea';
  placeholder?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  helpText?: string;
}

interface ConnectorFormSchema {
  driver: string;
  label: string;
  fields: ConnectorFieldSchema[];
}

interface ConnectionInfo {
  default: string;
  connections: Record<string, any>;
  dbtProfiles?: DbtProfileConnectionCandidate[];
}

interface DbtProfileConnectionCandidate {
  id: string;
  profileName: string;
  targetName: string;
  adapter: string;
  path: string;
  connection: Record<string, unknown>;
  missingFields: string[];
  warnings: string[];
}

const DRIVER_LABELS: Record<string, string> = {
  duckdb: 'DuckDB',
  file: 'Local File / DuckDB',
  postgresql: 'PostgreSQL',
  postgres: 'PostgreSQL',
  bigquery: 'BigQuery',
  snowflake: 'Snowflake',
  sqlite: 'SQLite',
  mysql: 'MySQL',
  mssql: 'SQL Server',
  redshift: 'Amazon Redshift',
  databricks: 'Databricks',
  clickhouse: 'ClickHouse',
  athena: 'Amazon Athena',
  trino: 'Trino',
  fabric: 'Microsoft Fabric',
};

const DRIVER_COLORS: Record<string, string> = {
  duckdb: '#f4bc00',
  file: '#f4bc00',
  postgresql: '#336791',
  postgres: '#336791',
  bigquery: '#4285f4',
  snowflake: '#29b5e8',
  sqlite: '#003b57',
  mysql: '#00758f',
  mssql: '#cc2927',
  redshift: '#8c4fff',
  databricks: '#ff3621',
  clickhouse: '#ffcc00',
  athena: '#ff9900',
  trino: '#dd00a1',
  fabric: '#0078d4',
};

// v1.3.3 Hex handoff — drivers with a TRENDING badge in the catalog grid.
// These are the warehouses teams adopt most in our handoff deck.

// Short one-line blurbs for the driver cards.
const DRIVER_TAGLINES: Record<string, string> = {
  duckdb: 'In-process analytical database',
  file: 'Local CSV / Parquet via DuckDB',
  postgresql: 'Open-source relational warehouse',
  postgres: 'Open-source relational warehouse',
  bigquery: 'Google Cloud serverless warehouse',
  snowflake: 'Cloud data platform',
  sqlite: 'Embedded SQL database',
  mysql: 'Open-source relational database',
  mssql: 'Microsoft SQL Server',
  redshift: 'AWS cloud data warehouse',
  databricks: 'Lakehouse platform',
  clickhouse: 'Columnar OLAP database',
  athena: 'AWS serverless S3 query engine',
  trino: 'Distributed SQL query engine',
  fabric: 'Microsoft unified analytics',
};

const CONNECTOR_SCHEMAS: ConnectorFormSchema[] = [
  {
    driver: 'file',
    label: 'Files / DuckDB memory',
    fields: [
      { key: 'filepath', label: 'DuckDB file path', type: 'text', placeholder: ':memory:' },
    ],
  },
  {
    driver: 'duckdb',
    label: 'DuckDB',
    fields: [
      { key: 'filepath', label: 'DuckDB file path', type: 'text', placeholder: './local/dev.duckdb', required: true },
    ],
  },
  {
    driver: 'sqlite',
    label: 'SQLite',
    fields: [
      { key: 'filepath', label: 'SQLite file path', type: 'text', placeholder: './local/dev.sqlite', required: true },
    ],
  },
  {
    driver: 'postgresql',
    label: 'PostgreSQL',
    fields: warehouseFields(5432),
  },
  {
    driver: 'mysql',
    label: 'MySQL',
    fields: warehouseFields(3306),
  },
  {
    driver: 'mssql',
    label: 'SQL Server',
    fields: warehouseFields(1433),
  },
  {
    driver: 'fabric',
    label: 'Microsoft Fabric',
    fields: warehouseFields(1433),
  },
  {
    driver: 'redshift',
    label: 'Amazon Redshift',
    fields: warehouseFields(5439),
  },
  {
    driver: 'snowflake',
    label: 'Snowflake',
    fields: [
      { key: 'account', label: 'Account', type: 'text', required: true },
      { key: 'warehouse', label: 'Warehouse', type: 'text', required: true },
      { key: 'database', label: 'Database', type: 'text', required: true },
      { key: 'schema', label: 'Schema', type: 'text', required: true },
      { key: 'username', label: 'Username', type: 'text', required: true },
      {
        key: 'authMethod',
        label: 'Authentication',
        type: 'select',
        options: [
          { value: 'password', label: 'Password' },
          { value: 'key_pair', label: 'Key pair / private key' },
          { value: 'external_browser', label: 'SSO / external browser' },
          { value: 'oauth', label: 'OAuth token' },
        ],
      },
      { key: 'password', label: 'Password / OAuth token', type: 'password' },
      { key: 'privateKeyPath', label: 'Private key file path', type: 'text', placeholder: '~/.ssh/snowflake_key.p8' },
      { key: 'privateKey', label: 'Private key PEM', type: 'textarea', helpText: 'Paste PEM only when a key file cannot be referenced.' },
      { key: 'privateKeyPassphrase', label: 'Private key passphrase', type: 'password' },
      { key: 'authenticator', label: 'Authenticator override', type: 'text', placeholder: 'EXTERNALBROWSER or OAUTH' },
      { key: 'role', label: 'Role', type: 'text' },
    ],
  },
  {
    driver: 'bigquery',
    label: 'BigQuery',
    fields: [
      { key: 'projectId', label: 'Project ID', type: 'text', required: true },
      { key: 'location', label: 'Location', type: 'text', placeholder: 'US' },
      {
        key: 'authMethod',
        label: 'Authentication',
        type: 'select',
        options: [
          { value: 'application_default', label: 'Application default credentials' },
          { value: 'service_account_key_file', label: 'Service account key file' },
          { value: 'service_account_json', label: 'Service account JSON' },
        ],
      },
      { key: 'keyFilename', label: 'Key file path', type: 'text', placeholder: '/secure/path/service-account.json' },
      { key: 'serviceAccountJson', label: 'Service account JSON', type: 'textarea' },
    ],
  },
  {
    driver: 'clickhouse',
    label: 'ClickHouse',
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
    fields: [
      { key: 'host', label: 'Server hostname', type: 'text', required: true },
      { key: 'database', label: 'Catalog / database', type: 'text' },
      { key: 'schema', label: 'Schema', type: 'text' },
      { key: 'warehouse', label: 'HTTP path / warehouse', type: 'text', required: true },
      { key: 'authMethod', label: 'Authentication', type: 'select', options: [{ value: 'token', label: 'Access token' }] },
      { key: 'token', label: 'Access token', type: 'password', required: true },
    ],
  },
  {
    driver: 'athena',
    label: 'Amazon Athena',
    fields: [
      { key: 'host', label: 'Region', type: 'text', placeholder: 'us-east-1', required: true },
      { key: 'database', label: 'Database', type: 'text', required: true },
      { key: 'outputLocation', label: 'S3 output location', type: 'text', placeholder: 's3://bucket/query-results/', required: true },
      { key: 'workgroup', label: 'Workgroup', type: 'text' },
      {
        key: 'authMethod',
        label: 'Authentication',
        type: 'select',
        options: [
          { value: 'aws_default', label: 'AWS default provider chain' },
          { value: 'aws_profile', label: 'AWS profile' },
          { value: 'aws_access_key', label: 'Access key / session token' },
        ],
      },
      { key: 'profile', label: 'AWS profile', type: 'text', placeholder: 'prod-analytics' },
      { key: 'accessKeyId', label: 'Access key ID', type: 'password' },
      { key: 'secretAccessKey', label: 'Secret access key', type: 'password' },
      { key: 'sessionToken', label: 'Session token', type: 'password' },
    ],
  },
  {
    driver: 'trino',
    label: 'Trino',
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
const CONNECTOR_SCHEMA_BY_DRIVER = Object.fromEntries(
  CONNECTOR_SCHEMAS.map((schema) => [schema.driver, schema]),
) as Record<string, ConnectorFormSchema>;

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

const QUICK_CONNECT_PRESETS = [
  {
    name: 'default',
    label: 'Local DuckDB',
    description: 'In-memory DuckDB — no configuration needed',
    config: { driver: 'duckdb', filepath: ':memory:' },
  },
  {
    name: 'postgres',
    label: 'PostgreSQL',
    description: 'Connect to a local PostgreSQL instance',
    config: { driver: 'postgresql', host: 'localhost', port: 5432, database: 'postgres', username: 'postgres', password: '' },
  },
  {
    name: 'snowflake',
    label: 'Snowflake',
    description: 'Connect to your Snowflake data warehouse',
    config: { driver: 'snowflake', account: '', warehouse: '', database: '', schema: 'PUBLIC', username: '', password: '' },
  },
];

function normalizeDriverName(driver: string): string {
  return driver === 'postgres' ? 'postgresql' : driver;
}

function normalizeFieldName(field: string): string {
  const aliases: Record<string, string> = {
    dbname: 'database',
    dataset: 'schema',
    http_path: 'httpPath',
    keyFile: 'keyFilename',
    keyFileName: 'keyFilename',
    private_key_path: 'privateKeyPath',
    private_key_passphrase: 'privateKeyPassphrase',
    path: 'filepath',
    project: 'projectId',
    server: 'host',
    server_hostname: 'host',
    user: 'username',
  };
  return aliases[field] ?? field;
}

function connectionNameFromProfile(profile: DbtProfileConnectionCandidate): string {
  const name = `${profile.profileName}_${profile.targetName}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return name || 'dbt_profile';
}

function shortPath(path: string): string {
  const marker = '/.dbt/';
  const markerIndex = path.indexOf(marker);
  if (markerIndex >= 0) return `~${path.slice(markerIndex)}`;
  const parts = path.split('/');
  return parts.slice(-3).join('/');
}

function isSensitiveField(field: string): boolean {
  const key = field.toLowerCase();
  return (
    key.includes('password') ||
    key.includes('token') ||
    key.includes('passphrase') ||
    key.includes('privatekey') ||
    key.includes('serviceaccountjson') ||
    key.includes('secretaccesskey') ||
    key.includes('clientsecret')
  );
}

export function ConnectionPanel({ variant = 'panel' }: { variant?: 'panel' | 'page' } = {}) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const isPage = variant === 'page';

  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // connection key being edited
  const [addingNew, setAddingNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // Edit form state
  const [editName, setEditName] = useState('');
  const [editDriver, setEditDriver] = useState('duckdb');
  const [editFields, setEditFields] = useState<Record<string, string>>({});

  useEffect(() => {
    api.getConnections().then((connInfo) => {
      setInfo(connInfo);
      // Auto-test if connections exist
      if (Object.keys(connInfo.connections).length > 0) {
        api.testConnection().then(setTestResult);
      }
    });
  }, []);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const result = await api.testConnection();
    setTestResult(result);
    setTesting(false);
  };

  const startEdit = (key: string, cfg: any) => {
    setEditing(key);
    setAddingNew(false);
    setEditName(key);
    setEditDriver(normalizeDriverName(cfg?.driver ?? cfg?.type ?? 'duckdb'));
    const fields: Record<string, string> = {};
    Object.entries(cfg ?? {}).forEach(([k, v]) => {
      if (k !== 'driver' && k !== 'type') fields[normalizeFieldName(k)] = String(v ?? '');
    });
    setEditFields(fields);
  };

  const startAdd = () => {
    setAddingNew(true);
    setEditing(null);
    setEditName('');
    setEditDriver('duckdb');
    setEditFields({});
  };

  const startAddFromDbtProfile = (profile: DbtProfileConnectionCandidate) => {
    setAddingNew(true);
    setEditing(null);
    setEditName(connectionNameFromProfile(profile));
    setEditDriver(normalizeDriverName(String(profile.connection.driver ?? profile.adapter ?? 'duckdb')));
    const fields: Record<string, string> = {};
    Object.entries(profile.connection ?? {}).forEach(([key, value]) => {
      if (key !== 'driver' && value !== undefined && value !== null) {
        fields[normalizeFieldName(key)] = String(value);
      }
    });
    setEditFields(fields);
    setTestResult(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setAddingNew(false);
  };

  const handleSave = async () => {
    if (!info) return;
    setSaving(true);
    setSaveMsg(null);

    const name = editName.trim() || (editing ?? 'default');
    const newConn: Record<string, unknown> = { driver: editDriver };
    const schema = CONNECTOR_SCHEMA_BY_DRIVER[editDriver];
    const fieldSchemas = new Map((schema?.fields ?? []).map((field) => [field.key, field]));
    Object.entries(editFields).forEach(([k, v]) => {
      const fieldSchema = fieldSchemas.get(k as ConnectorFieldSchema['key']);
      if (fieldSchema?.type === 'checkbox') {
        if (v !== '') newConn[k] = v === 'true';
        return;
      }
      const trimmed = v.trim();
      if (trimmed) {
        if (fieldSchema?.type === 'number' && !isNaN(Number(trimmed))) newConn[k] = Number(trimmed);
        else newConn[k] = trimmed;
      }
    });

    const connections = { ...info.connections };
    // If renaming, remove old key
    if (editing && editing !== name) delete connections[editing];
    connections[name] = newConn;

    try {
      await api.saveConnections(connections);
      // Refresh
      const refreshed = await api.getConnections();
      setInfo(refreshed);
      setSaveMsg('Saved');
      setTimeout(() => setSaveMsg(null), 2000);
      setEditing(null);
      setAddingNew(false);
      // Re-test the hot-swapped connection and refresh schema
      try {
        setTesting(true);
        const result = await api.testConnection();
        setTestResult(result);
      } catch { /* non-fatal */ }
      finally { setTesting(false); }
    } catch (e: any) {
      setSaveMsg(`Error: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (key: string) => {
    if (!info) return;
    const connections = { ...info.connections };
    delete connections[key];
    setSaving(true);
    try {
      await api.saveConnections(connections);
      const refreshed = await api.getConnections();
      setInfo(refreshed);
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  const sectionLabel = {
    fontSize: 10,
    fontWeight: 600 as const,
    letterSpacing: '0.07em',
    textTransform: 'uppercase' as const,
    color: t.textMuted,
    fontFamily: t.font,
    marginBottom: 6,
  };

  const card = {
    background: t.cellBg,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 7,
    padding: '10px 12px',
    marginBottom: 10,
  };

  const connections = info?.connections ?? {};
  const defaultKey = info?.default ?? '';
  const dbtProfileCandidates = info?.dbtProfiles ?? [];
  const connectionCount = Object.keys(connections).length;

  const connectionListSection = (
    <>
      <div style={sectionLabel}>Connections</div>
      {info === null ? (
        <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font }}>Loading…</div>
      ) : (
        Object.entries(connections).map(([key, cfg]: [string, any]) => {
          const driver: string = cfg?.driver ?? cfg?.type ?? 'unknown';
          const isDefault = key === defaultKey || Object.keys(connections).length === 1;
          const color = DRIVER_COLORS[driver] ?? t.accent;

          if (editing === key) {
            return <ConnectionForm key={key} t={t} editName={editName} setEditName={setEditName}
              editDriver={editDriver} setEditDriver={setEditDriver} editFields={editFields}
              setEditFields={setEditFields} onSave={handleSave} onCancel={cancelEdit}
              onDelete={() => handleDelete(key)} saving={saving} isNew={false} />;
          }

          return (
            <div
              key={key}
              style={{
                ...card,
                borderLeft: isDefault ? `3px solid ${color}` : `1px solid ${t.cellBorder}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <DriverLogo driver={driver} size={18} fallbackColor={color} />
                <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
                  {DRIVER_LABELS[driver] ?? driver}
                </span>
                <span style={{ fontSize: 11, fontFamily: t.fontMono, color: t.textMuted }}>
                  {key}
                </span>
                {isDefault && testResult?.ok && (
                  <span
                    title="Connected"
                    aria-label="Connected"
                    style={{
                      width: 7, height: 7, borderRadius: '50%',
                      background: t.success, flexShrink: 0,
                      boxShadow: `0 0 0 2px ${t.success}25`,
                    }}
                  />
                )}
                {isDefault && testResult && !testResult.ok && (
                  <span
                    title={testResult.message}
                    aria-label="Disconnected"
                    style={{
                      width: 7, height: 7, borderRadius: '50%',
                      background: t.error, flexShrink: 0,
                      boxShadow: `0 0 0 2px ${t.error}25`,
                    }}
                  />
                )}
                {isDefault && (
                  <span style={{ fontSize: 9, color: t.accent, fontFamily: t.font, fontWeight: 600, letterSpacing: '0.05em' }}>DEFAULT</span>
                )}
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => startEdit(key, cfg)}
                  style={{
                    background: 'transparent', border: `1px solid ${t.btnBorder}`,
                    borderRadius: 3, cursor: 'pointer', color: t.textMuted,
                    fontSize: 10, fontFamily: t.font, padding: '1px 6px', transition: 'all 0.15s',
                  }}
                >
                  Edit
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {Object.entries(cfg ?? {})
                  .filter(([k]) => k !== 'driver' && k !== 'type')
                  .map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                      <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono, minWidth: 70, flexShrink: 0 }}>{k}</span>
                      <span style={{ fontSize: 11, color: t.textSecondary, fontFamily: t.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                        {isSensitiveField(k) ? '••••••••' : String(v)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          );
        })
      )}
      {info !== null && connectionCount === 0 && (
        <div
          style={{
            ...card,
            color: t.textMuted,
            fontSize: 12,
            fontFamily: t.font,
            lineHeight: 1.45,
          }}
        >
          No saved connections yet. Import a dbt profile target or add one manually.
        </div>
      )}
    </>
  );

  const dbtProfilesSection = (
    <>
      {!addingNew && !editing && dbtProfileCandidates.length > 0 && (
        <>
          <div style={{ ...sectionLabel, marginTop: 8 }}>dbt profiles.yml</div>
          <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
            {dbtProfileCandidates.map((profile) => {
              const driver = normalizeDriverName(String(profile.connection.driver ?? profile.adapter));
              const color = DRIVER_COLORS[driver] ?? t.accent;
              const ready = profile.missingFields.length === 0;
              return (
                <div
                  key={profile.id}
                  style={{
                    ...card,
                    marginBottom: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <DriverLogo driver={driver} size={18} fallbackColor={color} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
                        {profile.profileName}
                      </span>
                      <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono }}>
                        {profile.targetName}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {DRIVER_LABELS[driver] ?? profile.adapter} from {shortPath(profile.path)}
                    </div>
                    <div style={{ fontSize: 10, color: ready ? t.success : t.warning, fontFamily: t.font, marginTop: 2 }}>
                      {ready
                        ? 'Ready to test after import'
                        : `Needs ${profile.missingFields.join(', ')}`}
                    </div>
                  </div>
                  <button
                    onClick={() => startAddFromDbtProfile(profile)}
                    style={{
                      background: t.btnBg,
                      border: `1px solid ${t.btnBorder}`,
                      borderRadius: 4,
                      cursor: 'pointer',
                      color: t.textSecondary,
                      fontSize: 11,
                      fontFamily: t.font,
                      padding: '4px 8px',
                      flexShrink: 0,
                    }}
                  >
                    Import
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );

  const quickConnectSection = (
    <>
      {!addingNew && !editing && Object.keys(connections).length === 0 && (
        <>
          <div style={{ ...sectionLabel, marginTop: 8 }}>Quick Connect</div>
          <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
            {QUICK_CONNECT_PRESETS.map((preset) => (
              <button
                key={preset.name}
                onClick={async () => {
                  setSaving(true);
                  try {
                    const conns = { ...connections, [preset.name]: preset.config };
                    await api.saveConnections(conns);
                    const refreshed = await api.getConnections();
                    setInfo(refreshed);
                    // Auto-test
                    setTesting(true);
                    const result = await api.testConnection();
                    setTestResult(result);
                    setTesting(false);
                  } finally {
                    setSaving(false);
                  }
                }}
                disabled={saving}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                  background: t.cellBg, border: `1px solid ${t.cellBorder}`, borderRadius: 7,
                  cursor: saving ? 'not-allowed' : 'pointer', textAlign: 'left' as const,
                  transition: 'border-color 0.15s',
                }}
              >
                <DriverLogo driver={preset.config.driver} size={18} />
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
                    {preset.label}
                  </div>
                  <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font }}>
                    {preset.description}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );

  const addConnectionSection = (
    <>
      {addingNew ? (
        <ConnectionForm t={t} editName={editName} setEditName={setEditName}
          editDriver={editDriver} setEditDriver={setEditDriver} editFields={editFields}
          setEditFields={setEditFields} onSave={handleSave} onCancel={cancelEdit}
          saving={saving} isNew />
      ) : (
        <button
          onClick={startAdd}
          style={{
            width: '100%', padding: '7px 0', borderRadius: 6,
            border: `1px dashed ${t.cellBorder}`, background: 'transparent',
            color: t.textSecondary, fontSize: 12, fontFamily: t.font, fontWeight: 500,
            cursor: 'pointer', marginBottom: 12, display: 'flex', alignItems: 'center',
            justifyContent: 'center', gap: 6, transition: 'border-color 0.15s, color 0.15s',
          }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
          Add Connection
        </button>
      )}
    </>
  );

  const saveMessageSection = (
    <>
      {saveMsg && (
        <div style={{
          fontSize: 11, fontFamily: t.font, padding: '4px 10px', borderRadius: 4, marginBottom: 8,
          color: saveMsg.startsWith('Error') ? t.error : t.success,
          background: saveMsg.startsWith('Error') ? `${t.error}12` : `${t.success}12`,
        }}>
          {saveMsg}
        </div>
      )}
    </>
  );

  const testConnectionSection = (
    <>
      <button
        onClick={handleTest}
        disabled={testing}
        style={{
          width: '100%', padding: '7px 0', borderRadius: 6,
          border: `1px solid ${t.btnBorder}`, background: t.btnBg,
          color: t.textSecondary, fontSize: 12, fontFamily: t.font, fontWeight: 500,
          cursor: testing ? 'not-allowed' : 'pointer', marginBottom: 8,
          opacity: testing ? 0.7 : 1, transition: 'all 0.15s',
        }}
      >
        {testing ? 'Testing…' : 'Test Connection'}
      </button>

      {testResult && (
        <div
          style={{
            fontSize: 12, fontFamily: t.font,
            color: testResult.ok ? t.success : t.error,
            background: testResult.ok ? `${t.success}12` : `${t.error}12`,
            border: `1px solid ${testResult.ok ? t.success : t.error}40`,
            borderRadius: 6, padding: '7px 10px', marginBottom: 12,
          }}
        >
          {testResult.ok ? '✓ ' : '✗ '}{testResult.message}
        </div>
      )}
    </>
  );

  const catalogSection = (
    <>
      <div style={{ ...sectionLabel, marginTop: 4 }}>Catalog</div>
      <div
        className={isPage ? 'dql-connection-catalog-grid' : undefined}
        style={{
          display: 'grid',
          gridTemplateColumns: isPage ? 'repeat(auto-fit, minmax(180px, 1fr))' : 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 8,
          marginBottom: 12,
        }}
      >
          {CONNECTOR_SCHEMAS.map(({ driver, label }) => {
          const color = DRIVER_COLORS[driver] ?? t.accent;
          const tagline = DRIVER_TAGLINES[driver] ?? '';
          return (
            <div
              key={driver}
              style={{
                background: t.cellBg,
                border: `1px solid ${t.cellBorder}`,
                borderRadius: 8,
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                minHeight: 76,
                position: 'relative',
                transition: 'border-color 0.15s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <DriverLogo driver={driver} size={18} fallbackColor={color} />
                <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
                  {label}
                </span>
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: t.textMuted,
                  fontFamily: t.font,
                  lineHeight: 1.35,
                }}
              >
                {tagline}
              </div>
              <code style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontMono, marginTop: 'auto' }}>
                {driver}
              </code>
            </div>
          );
        })}
      </div>
    </>
  );

  if (isPage) {
    const panelSurface = {
      background: t.cellBg,
      border: `1px solid ${t.cellBorder}`,
      borderRadius: 8,
      padding: 14,
      minWidth: 0,
      boxShadow: '0 1px 2px rgba(0, 0, 0, 0.03)',
    };

    return (
      <>
        <style>{CONNECTION_PAGE_STYLES}</style>
        <div className="dql-connection-page-grid">
          <section style={panelSurface}>
            {connectionListSection}
            {dbtProfilesSection}
            {quickConnectSection}
          </section>
          <aside style={panelSurface}>
            <div style={{ ...sectionLabel, marginBottom: 8 }}>Setup</div>
            {addConnectionSection}
            {saveMessageSection}
            {testConnectionSection}
            {catalogSection}
          </aside>
        </div>
      </>
    );
  }

  return (
    <PanelFrame title="Connections" bodyPadding={12}>
      {connectionListSection}
      {dbtProfilesSection}
      {quickConnectSection}
      {addConnectionSection}
      {saveMessageSection}
      {testConnectionSection}
      {catalogSection}
    </PanelFrame>
  );
}

const CONNECTION_PAGE_STYLES = `
.dql-connection-page-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.18fr) minmax(320px, 0.82fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 920px) {
  .dql-connection-page-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
`;

function ConnectionForm({
  t, editName, setEditName, editDriver, setEditDriver, editFields, setEditFields,
  onSave, onCancel, onDelete, saving, isNew,
}: {
  t: Theme;
  editName: string; setEditName: (v: string) => void;
  editDriver: string; setEditDriver: (v: string) => void;
  editFields: Record<string, string>; setEditFields: (v: Record<string, string>) => void;
  onSave: () => void; onCancel: () => void;
  onDelete?: () => void;
  saving: boolean; isNew: boolean;
}) {
  const schema = CONNECTOR_SCHEMA_BY_DRIVER[editDriver];
  const fields = schema?.fields ?? [];

  const inputStyle = {
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 4,
    color: t.textPrimary,
    fontSize: 11,
    fontFamily: t.fontMono,
    padding: '4px 8px',
    outline: 'none',
    width: '100%',
  };

  const labelStyle = {
    fontSize: 9,
    fontWeight: 600 as const,
    color: t.textMuted,
    fontFamily: t.font,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
    marginBottom: 2,
  };

  return (
    <div style={{
      background: t.cellBg, border: `1px solid ${t.accent}40`, borderRadius: 7,
      padding: '10px 12px', marginBottom: 10,
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: t.accent, fontFamily: t.font, marginBottom: 8 }}>
        {isNew ? 'New Connection' : 'Edit Connection'}
      </div>

      {/* Connection name */}
      <div style={{ marginBottom: 6 }}>
        <div style={labelStyle}>Name</div>
        <input style={inputStyle} value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="e.g. production" />
      </div>

      {/* Driver */}
      <div style={{ marginBottom: 6 }}>
        <div style={labelStyle}>Driver</div>
        <select
          style={{ ...inputStyle, fontFamily: t.font }}
          value={editDriver}
          onChange={(e) => { setEditDriver(e.target.value); setEditFields({}); }}
        >
          {CONNECTOR_SCHEMAS.map((schema) => (
            <option key={schema.driver} value={schema.driver}>{schema.label}</option>
          ))}
        </select>
      </div>

      {/* Driver-specific fields */}
      {fields.map((field) => (
        <div key={field.key} style={{ marginBottom: 6 }}>
          <div style={labelStyle}>
            {field.label}
            {field.required ? ' *' : ''}
          </div>
          {field.type === 'select' ? (
            <select
              style={{ ...inputStyle, fontFamily: t.font }}
              value={editFields[field.key] ?? ''}
              onChange={(e) => setEditFields({ ...editFields, [field.key]: e.target.value })}
            >
              <option value="">Default</option>
              {(field.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : field.type === 'checkbox' ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: t.textSecondary, fontFamily: t.font }}>
              <input
                type="checkbox"
                checked={editFields[field.key] === 'true'}
                onChange={(e) => setEditFields({ ...editFields, [field.key]: e.target.checked ? 'true' : 'false' })}
              />
              Enabled
            </label>
          ) : field.type === 'textarea' ? (
            <textarea
              style={{ ...inputStyle, minHeight: 72, resize: 'vertical' as const }}
              value={editFields[field.key] ?? ''}
              placeholder={field.placeholder ?? ''}
              onChange={(e) => setEditFields({ ...editFields, [field.key]: e.target.value })}
            />
          ) : (
            <input
              style={inputStyle}
              type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
              value={editFields[field.key] ?? ''}
              placeholder={field.placeholder ?? ''}
              onChange={(e) => setEditFields({ ...editFields, [field.key]: e.target.value })}
            />
          )}
          {field.helpText && (
            <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font, marginTop: 3, lineHeight: 1.35 }}>
              {field.helpText}
            </div>
          )}
        </div>
      ))}

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button
          onClick={onSave}
          disabled={saving}
          style={{
            flex: 1, padding: '5px 0', borderRadius: 5, border: 'none',
            background: t.accent, color: '#fff', fontSize: 11, fontFamily: t.font,
            fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={onCancel}
          style={{
            padding: '5px 12px', borderRadius: 5, border: `1px solid ${t.btnBorder}`,
            background: 'transparent', color: t.textSecondary, fontSize: 11, fontFamily: t.font,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        {onDelete && !isNew && (
          <button
            onClick={onDelete}
            style={{
              padding: '5px 12px', borderRadius: 5, border: `1px solid ${t.error}40`,
              background: 'transparent', color: t.error, fontSize: 11, fontFamily: t.font,
              cursor: 'pointer',
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
