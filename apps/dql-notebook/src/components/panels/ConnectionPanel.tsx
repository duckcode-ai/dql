import React, { useEffect, useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { Theme } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import { PanelFrame } from '@duckcodeailabs/dql-ui';
import { DriverLogo } from './DriverLogo';

interface ConnectionInfo {
  default: string;
  connections: Record<string, any>;
}

const DRIVER_LABELS: Record<string, string> = {
  duckdb: 'DuckDB',
  file: 'Local File / DuckDB',
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

const DRIVER_FIELDS: Record<string, string[]> = {
  duckdb: ['filepath'],
  postgres: ['host', 'port', 'database', 'user', 'password'],
  mysql: ['host', 'port', 'database', 'user', 'password'],
  bigquery: ['project', 'dataset', 'keyFilename'],
  snowflake: ['account', 'warehouse', 'database', 'schema', 'username', 'password'],
  mssql: ['server', 'port', 'database', 'user', 'password'],
  redshift: ['host', 'port', 'database', 'user', 'password'],
  sqlite: ['filepath'],
  databricks: ['host', 'path', 'token'],
  clickhouse: ['host', 'port', 'database', 'user', 'password'],
  athena: ['region', 'database', 'outputLocation'],
  trino: ['host', 'port', 'catalog', 'schema', 'user'],
  fabric: ['server', 'database', 'authentication'],
};

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
    config: { driver: 'postgres', host: 'localhost', port: 5432, database: 'postgres', user: 'postgres', password: '' },
  },
  {
    name: 'snowflake',
    label: 'Snowflake',
    description: 'Connect to your Snowflake data warehouse',
    config: { driver: 'snowflake', account: '', warehouse: '', database: '', schema: 'PUBLIC', username: '', password: '' },
  },
];

export function ConnectionPanel() {
  const { state } = useNotebook();
  const t = themes[state.themeMode];

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
    setEditDriver(cfg?.driver ?? 'duckdb');
    const fields: Record<string, string> = {};
    Object.entries(cfg ?? {}).forEach(([k, v]) => {
      if (k !== 'driver' && k !== 'type') fields[k] = String(v ?? '');
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
    Object.entries(editFields).forEach(([k, v]) => {
      if (v.trim()) {
        // Try to parse numbers for port
        if (k === 'port' && !isNaN(Number(v))) newConn[k] = Number(v);
        else newConn[k] = v;
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

  return (
    <PanelFrame title="Connections" bodyPadding={12}>

      {/* Connection list */}
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
                        {k.toLowerCase().includes('password') || k.toLowerCase().includes('token') ? '••••••••' : String(v)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          );
        })
      )}

      {/* Quick Connect presets */}
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

      {/* Add new connection form */}
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

      {saveMsg && (
        <div style={{
          fontSize: 11, fontFamily: t.font, padding: '4px 10px', borderRadius: 4, marginBottom: 8,
          color: saveMsg.startsWith('Error') ? t.error : t.success,
          background: saveMsg.startsWith('Error') ? `${t.error}12` : `${t.success}12`,
        }}>
          {saveMsg}
        </div>
      )}

      {/* Test connection */}
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

      <div style={{ ...sectionLabel, marginTop: 4 }}>Catalog</div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 8,
          marginBottom: 12,
        }}
      >
        {Object.entries(DRIVER_LABELS).map(([driver, label]) => {
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
    </PanelFrame>
  );
}

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
  const fields = DRIVER_FIELDS[editDriver] ?? [];

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
          {Object.entries(DRIVER_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      {/* Driver-specific fields */}
      {fields.map((field) => (
        <div key={field} style={{ marginBottom: 6 }}>
          <div style={labelStyle}>{field}</div>
          <input
            style={inputStyle}
            type={field.toLowerCase().includes('password') || field.toLowerCase().includes('token') ? 'password' : 'text'}
            value={editFields[field] ?? ''}
            placeholder={field === 'port' ? '5432' : field === 'filepath' ? ':memory:' : ''}
            onChange={(e) => setEditFields({ ...editFields, [field]: e.target.value })}
          />
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
