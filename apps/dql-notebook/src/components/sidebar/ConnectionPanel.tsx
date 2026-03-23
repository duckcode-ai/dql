import React, { useEffect, useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { api } from '../../api/client';

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

export function ConnectionPanel() {
  const { state } = useNotebook();
  const t = themes[state.themeMode];

  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    api.getConnections().then(setInfo);
  }, []);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const result = await api.testConnection();
    setTestResult(result);
    setTesting(false);
  };

  const sectionLabel = {
    fontSize: 10,
    fontWeight: 600,
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
    <div style={{ flex: 1, overflow: 'auto', padding: '12px 12px 20px' }}>

      {/* Active connection */}
      <div style={sectionLabel}>Active Connection</div>
      {info === null ? (
        <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font }}>Loading…</div>
      ) : (
        Object.entries(connections).map(([key, cfg]: [string, any]) => {
          const driver: string = cfg?.driver ?? cfg?.type ?? 'unknown';
          const isDefault = key === defaultKey || Object.keys(connections).length === 1;
          const color = DRIVER_COLORS[driver] ?? t.accent;
          return (
            <div
              key={key}
              style={{
                ...card,
                borderLeft: isDefault ? `3px solid ${color}` : `1px solid ${t.cellBorder}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: t.fontMono,
                    color,
                    background: `${color}18`,
                    border: `1px solid ${color}40`,
                    borderRadius: 4,
                    padding: '1px 6px',
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase' as const,
                  }}
                >
                  {DRIVER_LABELS[driver] ?? driver}
                </span>
                {isDefault && (
                  <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font }}>
                    default
                  </span>
                )}
              </div>

              {/* Connection details */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {Object.entries(cfg ?? {})
                  .filter(([k]) => k !== 'driver' && k !== 'type')
                  .map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                      <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono, minWidth: 70, flexShrink: 0 }}>
                        {k}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          color: t.textSecondary,
                          fontFamily: t.fontMono,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap' as const,
                        }}
                      >
                        {k.toLowerCase().includes('password') ? '••••••••' : String(v)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          );
        })
      )}

      {/* Test connection */}
      <button
        onClick={handleTest}
        disabled={testing}
        style={{
          width: '100%',
          padding: '7px 0',
          borderRadius: 6,
          border: `1px solid ${t.btnBorder}`,
          background: testing ? t.btnBg : t.btnBg,
          color: t.textSecondary,
          fontSize: 12,
          fontFamily: t.font,
          fontWeight: 500,
          cursor: testing ? 'not-allowed' : 'pointer',
          marginBottom: 8,
          opacity: testing ? 0.7 : 1,
          transition: 'all 0.15s',
        }}
      >
        {testing ? 'Testing…' : 'Test Connection'}
      </button>

      {testResult && (
        <div
          style={{
            fontSize: 12,
            fontFamily: t.font,
            color: testResult.ok ? t.success : t.error,
            background: testResult.ok ? `${t.success}12` : `${t.error}12`,
            border: `1px solid ${testResult.ok ? t.success : t.error}40`,
            borderRadius: 6,
            padding: '7px 10px',
            marginBottom: 12,
          }}
        >
          {testResult.ok ? '✓ ' : '✗ '}{testResult.message}
        </div>
      )}

      {/* How to change connection */}
      <div style={{ ...sectionLabel, marginTop: 4 }}>Change Connection</div>
      <div style={{ ...card, fontSize: 12, fontFamily: t.font, color: t.textSecondary, lineHeight: 1.6 }}>
        Edit <code style={{ fontFamily: t.fontMono, color: t.accent, fontSize: 11 }}>dql.config.json</code> in your project root to add or switch connections. Supported drivers:
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          {[
            { driver: 'duckdb / file', desc: 'Local CSV, Parquet, DuckDB' },
            { driver: 'postgres', desc: 'PostgreSQL / Supabase / RDS' },
            { driver: 'bigquery', desc: 'Google BigQuery' },
            { driver: 'snowflake', desc: 'Snowflake' },
            { driver: 'mysql', desc: 'MySQL / MariaDB / PlanetScale' },
            { driver: 'mssql', desc: 'SQL Server / Azure SQL' },
            { driver: 'redshift', desc: 'Amazon Redshift' },
            { driver: 'databricks', desc: 'Databricks SQL' },
            { driver: 'clickhouse', desc: 'ClickHouse' },
            { driver: 'athena', desc: 'Amazon Athena' },
            { driver: 'trino', desc: 'Trino / Starburst' },
            { driver: 'fabric', desc: 'Microsoft Fabric' },
          ].map(({ driver, desc }) => (
            <div key={driver} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <code style={{ fontSize: 10, fontFamily: t.fontMono, color: t.textMuted, minWidth: 80, flexShrink: 0 }}>
                {driver}
              </code>
              <span style={{ fontSize: 11, color: t.textMuted }}>{desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Example config snippet */}
      <div style={{ ...sectionLabel, marginTop: 4 }}>Example Config</div>
      <pre
        style={{
          background: t.cellBg,
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 7,
          padding: '10px 12px',
          fontSize: 11,
          fontFamily: t.fontMono,
          color: t.textSecondary,
          overflow: 'auto',
          lineHeight: 1.6,
          margin: 0,
        }}
      >
{`{
  "connections": {
    "default": {
      "driver": "duckdb",
      "path": ":memory:"
    },
    "prod": {
      "driver": "postgres",
      "host": "localhost",
      "port": 5432,
      "database": "analytics",
      "user": "analyst",
      "password": "..."
    }
  }
}`}
      </pre>
    </div>
  );
}
