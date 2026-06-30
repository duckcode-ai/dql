import React, { useEffect, useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { Theme } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import { PanelFrame } from '@duckcodeailabs/dql-ui';
import { DriverLogo } from './DriverLogo';
import { ConnectionRuntimeSettings } from '../settings/SettingsPage';
import type { SettingsTab } from '../../store/types';

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
  connectorStatus?: ConnectorInstallStatus[];
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

interface ConnectorInstallStatus {
  driver: 'duckdb' | 'snowflake' | 'databricks';
  label: string;
  packageName?: string;
  packageSpec?: string;
  installed: boolean;
  builtIn: boolean;
  installPath: string;
  installCommand?: string;
}

const DRIVER_LABELS: Record<string, string> = {
  duckdb: 'DuckDB',
  file: 'Local File / DuckDB',
  snowflake: 'Snowflake',
  databricks: 'Databricks',
};

const DRIVER_COLORS: Record<string, string> = {
  duckdb: '#f4bc00',
  file: '#f4bc00',
  snowflake: '#29b5e8',
  databricks: '#ff3621',
};

// Short one-line blurbs for the driver cards.
const DRIVER_TAGLINES: Record<string, string> = {
  duckdb: 'In-process analytical database',
  file: 'Local CSV / Parquet via DuckDB',
  snowflake: 'Cloud data platform',
  databricks: 'Lakehouse platform',
};

const CONNECTOR_SCHEMAS: ConnectorFormSchema[] = [
  {
    driver: 'duckdb',
    label: 'DuckDB',
    fields: [
      { key: 'filepath', label: 'DuckDB file path', type: 'text', placeholder: './local/dev.duckdb', required: true },
    ],
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
          { value: 'mfa', label: 'Password + MFA' },
          { value: 'key_pair', label: 'Key pair / private key' },
          { value: 'external_browser', label: 'SSO / external browser' },
          { value: 'oauth', label: 'OAuth token' },
          { value: 'oauth_authorization_code', label: 'OAuth authorization code' },
          { value: 'oauth_client_credentials', label: 'OAuth client credentials' },
          { value: 'programmatic_access_token', label: 'Programmatic access token' },
          { value: 'workload_identity', label: 'Workload identity' },
        ],
      },
      { key: 'password', label: 'Password', type: 'password' },
      { key: 'token', label: 'Token', type: 'password', helpText: 'OAuth, programmatic access token, or OIDC workload identity token.' },
      { key: 'privateKeyPath', label: 'Private key file path', type: 'text', placeholder: '~/.ssh/snowflake_key.p8' },
      { key: 'privateKey', label: 'Private key PEM', type: 'textarea', helpText: 'Paste PEM only when a key file cannot be referenced.' },
      { key: 'privateKeyPassphrase', label: 'Private key passphrase', type: 'password' },
      { key: 'authenticator', label: 'Authenticator override', type: 'text', placeholder: 'EXTERNALBROWSER, OAUTH, WORKLOAD_IDENTITY, or Okta URL' },
      { key: 'role', label: 'Role', type: 'text' },
      { key: 'accessUrl', label: 'Access URL', type: 'text' },
      { key: 'application', label: 'Application name', type: 'text', placeholder: 'DQL' },
      { key: 'queryTag', label: 'Query tag', type: 'text', placeholder: 'team=analytics;app=dql' },
      { key: 'passcode', label: 'MFA passcode', type: 'password' },
      { key: 'passcodeInPassword', label: 'MFA passcode is appended to password', type: 'checkbox' },
      { key: 'clientRequestMFAToken', label: 'Reuse cached MFA token', type: 'checkbox' },
      { key: 'clientStoreTemporaryCredential', label: 'Cache SSO token locally', type: 'checkbox' },
      { key: 'clientSessionKeepAlive', label: 'Keep session alive', type: 'checkbox' },
      { key: 'clientSessionKeepAliveHeartbeatFrequency', label: 'Keep-alive heartbeat seconds', type: 'number', placeholder: '3600' },
      { key: 'credentialCacheDir', label: 'Credential cache directory', type: 'text' },
      { key: 'browserActionTimeout', label: 'Browser SSO timeout ms', type: 'number', placeholder: '120000' },
      { key: 'keepAlive', label: 'Socket keep-alive', type: 'checkbox' },
      { key: 'timeout', label: 'Connection timeout ms', type: 'number', placeholder: '60000' },
      { key: 'proxyHost', label: 'Proxy host', type: 'text' },
      { key: 'proxyPort', label: 'Proxy port', type: 'number' },
      { key: 'proxyProtocol', label: 'Proxy protocol', type: 'text', placeholder: 'https' },
      { key: 'proxyUser', label: 'Proxy user', type: 'text' },
      { key: 'proxyPassword', label: 'Proxy password', type: 'password' },
      { key: 'noProxy', label: 'No proxy hosts', type: 'text', placeholder: '*.amazonaws.com|*.internal' },
      { key: 'oauthClientId', label: 'OAuth client ID', type: 'text' },
      { key: 'oauthClientSecret', label: 'OAuth client secret', type: 'password' },
      { key: 'oauthAuthorizationUrl', label: 'OAuth authorization URL', type: 'text' },
      { key: 'oauthTokenRequestUrl', label: 'OAuth token request URL', type: 'text' },
      { key: 'oauthScope', label: 'OAuth scope', type: 'text' },
      { key: 'oauthRedirectUri', label: 'OAuth redirect URI', type: 'text' },
      { key: 'workloadIdentityProvider', label: 'Workload identity provider', type: 'text', placeholder: 'AWS, AZURE, GCP, or OIDC' },
      { key: 'workloadIdentityAzureClientId', label: 'Azure client ID', type: 'text' },
    ],
  },
  {
    driver: 'databricks',
    label: 'Databricks SQL',
    fields: [
      { key: 'host', label: 'Server hostname', type: 'text', required: true },
      { key: 'database', label: 'Catalog / database', type: 'text' },
      { key: 'schema', label: 'Schema', type: 'text' },
      { key: 'warehouse', label: 'Warehouse ID', type: 'text', helpText: 'Use the SQL warehouse ID when you have it.' },
      { key: 'httpPath', label: 'HTTP path', type: 'text', placeholder: '/sql/1.0/warehouses/abc123', helpText: 'Paste the dbt/JDBC HTTP path and DQL will extract the warehouse ID.' },
      {
        key: 'authMethod',
        label: 'Authentication',
        type: 'select',
        options: [
          { value: 'token', label: 'Access token' },
          { value: 'oauth', label: 'OAuth bearer token' },
        ],
      },
      { key: 'token', label: 'Bearer token', type: 'password', required: true, helpText: 'Use an OAuth token for automation when possible, or a service-principal PAT.' },
      { key: 'waitTimeout', label: 'Statement wait timeout', type: 'text', placeholder: '50s' },
      { key: 'byteLimit', label: 'Inline byte limit', type: 'number', placeholder: '25000000' },
    ],
  },
];
const CONNECTOR_SCHEMA_BY_DRIVER = Object.fromEntries(
  CONNECTOR_SCHEMAS.map((schema) => [schema.driver, schema]),
) as Record<string, ConnectorFormSchema>;

const QUICK_CONNECT_PRESETS = [
  {
    name: 'default',
    label: 'Local DuckDB',
    description: 'In-memory DuckDB — no configuration needed',
    config: { driver: 'duckdb', filepath: ':memory:' },
  },
  {
    name: 'snowflake',
    label: 'Snowflake',
    description: 'Connect to your Snowflake data warehouse',
    config: { driver: 'snowflake', account: '', warehouse: '', database: '', schema: 'PUBLIC', username: '', password: '' },
  },
  {
    name: 'databricks',
    label: 'Databricks SQL',
    description: 'Connect to a Databricks SQL warehouse',
    config: { driver: 'databricks', host: '', warehouse: '', schema: 'default', token: '' },
  },
];

function normalizeDriverName(driver: string): string {
  return driver === 'postgres' ? 'postgresql' : driver;
}

function normalizeFieldName(field: string): string {
  const aliases: Record<string, string> = {
    dbname: 'database',
    dataset: 'schema',
    access_url: 'accessUrl',
    auth_method: 'authMethod',
    auth_type: 'authMethod',
    browser_action_timeout: 'browserActionTimeout',
    byte_limit: 'byteLimit',
    client_request_mfa_token: 'clientRequestMFAToken',
    client_session_keep_alive: 'clientSessionKeepAlive',
    client_session_keep_alive_heartbeat_frequency: 'clientSessionKeepAliveHeartbeatFrequency',
    client_store_temporary_credential: 'clientStoreTemporaryCredential',
    credential_cache_dir: 'credentialCacheDir',
    http_path: 'httpPath',
    keep_alive: 'keepAlive',
    keyFile: 'keyFilename',
    keyFileName: 'keyFilename',
    no_proxy: 'noProxy',
    oauth_authorization_url: 'oauthAuthorizationUrl',
    oauth_client_id: 'oauthClientId',
    oauth_client_secret: 'oauthClientSecret',
    oauth_redirect_uri: 'oauthRedirectUri',
    oauth_scope: 'oauthScope',
    oauth_token_request_url: 'oauthTokenRequestUrl',
    passcode_in_password: 'passcodeInPassword',
    private_key: 'privateKey',
    private_key_path: 'privateKeyPath',
    private_key_passphrase: 'privateKeyPassphrase',
    proxy_host: 'proxyHost',
    proxy_password: 'proxyPassword',
    proxy_port: 'proxyPort',
    proxy_protocol: 'proxyProtocol',
    proxy_user: 'proxyUser',
    query_tag: 'queryTag',
    path: 'filepath',
    project: 'projectId',
    server: 'host',
    server_hostname: 'host',
    user: 'username',
    wait_timeout: 'waitTimeout',
    workload_identity_azure_client_id: 'workloadIdentityAzureClientId',
    workload_identity_provider: 'workloadIdentityProvider',
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

function saveMessageColor(message: string, theme: Theme): string {
  if (message.startsWith('Error') || message.toLowerCase().includes('failed')) return theme.error;
  if (message.toLowerCase().includes('testing')) return theme.warning;
  return theme.success;
}

function isPlaceholderLocalConnection(cfg: any): boolean {
  const driver = normalizeDriverName(String(cfg?.driver ?? cfg?.type ?? ''));
  if (driver !== 'duckdb' && driver !== 'file') return false;
  const filepath = cfg?.filepath ?? cfg?.path;
  return !filepath || filepath === ':memory:';
}

function chooseDefaultAfterSave(
  connections: Record<string, any>,
  previousDefault: string,
  savedName: string,
  previousName: string | null,
): string {
  const savedWasDefault = previousName !== null && previousName === previousDefault;
  const defaultStillExists = Boolean(previousDefault && connections[previousDefault]);
  const savedConnection = connections[savedName];

  if (
    previousName === null ||
    savedWasDefault ||
    !defaultStillExists ||
    (
      previousDefault === 'default' &&
      isPlaceholderLocalConnection(connections.default) &&
      !isPlaceholderLocalConnection(savedConnection)
    )
  ) {
    return savedName;
  }

  return previousDefault;
}

function chooseFallbackDefault(connections: Record<string, any>): string | undefined {
  const keys = Object.keys(connections);
  return keys.find((key) => !isPlaceholderLocalConnection(connections[key])) ?? keys[0];
}

export function ConnectionPanel({ variant = 'panel' }: { variant?: 'panel' | 'page' } = {}) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const isPage = variant === 'page';

  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // connection key being edited
  const [addingNew, setAddingNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [installingDriver, setInstallingDriver] = useState<string | null>(null);

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
    if (!info || Object.keys(info.connections ?? {}).length === 0) {
      setTestResult({ ok: false, message: 'Add or import a connection before testing.' });
      return;
    }
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

  const handleInstallConnector = async (driver: string) => {
    setInstallingDriver(driver);
    setSaveMsg(null);
    try {
      const result = await api.installConnector(driver);
      if (result.connectorStatus && info) {
        setInfo({ ...info, connectorStatus: result.connectorStatus });
      } else {
        const refreshed = await api.getConnections();
        setInfo(refreshed);
      }
      setSaveMsg(result.ok ? 'Connector installed' : `Error: ${result.error ?? 'Install failed'}`);
    } catch (error: any) {
      setSaveMsg(`Error: ${error?.message ?? 'Install failed'}`);
    } finally {
      setInstallingDriver(null);
    }
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
    const nextDefault = chooseDefaultAfterSave(connections, info.default, name, editing);

    try {
      await api.saveConnections(connections, nextDefault);
      // Refresh
      const refreshed = await api.getConnections();
      setInfo(refreshed);
      setSaveMsg('Saved. Testing connection...');
      setEditing(null);
      setAddingNew(false);
      // Re-test the hot-swapped connection and refresh schema
      try {
        setTesting(true);
        const result = await api.testConnection();
        setTestResult(result);
        setSaveMsg(result.ok ? 'Saved and connected' : 'Saved, but connection test failed');
        if (result.ok) setTimeout(() => setSaveMsg(null), 2000);
      } catch (e: any) {
        setSaveMsg(`Saved, but connection test failed: ${e.message ?? 'Connection failed'}`);
      } finally { setTesting(false); }
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
    const nextDefault = key === info.default ? chooseFallbackDefault(connections) : info.default;
    setSaving(true);
    try {
      await api.saveConnections(connections, nextDefault);
      const refreshed = await api.getConnections();
      setInfo(refreshed);
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  const handleMakeDefault = async (key: string) => {
    if (!info) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      await api.saveConnections(info.connections, key);
      const refreshed = await api.getConnections();
      setInfo(refreshed);
      setSaveMsg('Default updated. Testing connection...');
      setTesting(true);
      const result = await api.testConnection();
      setTestResult(result);
      setSaveMsg(result.ok ? 'Default updated and connected' : 'Default updated, but connection test failed');
      if (result.ok) setTimeout(() => setSaveMsg(null), 2000);
    } catch (e: any) {
      setSaveMsg(`Error: ${e.message}`);
    } finally {
      setTesting(false);
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
  const connectorStatusByDriver = Object.fromEntries(
    (info?.connectorStatus ?? []).map((status) => [status.driver, status]),
  ) as Record<string, ConnectorInstallStatus>;
  const connectionCount = Object.keys(connections).length;
  const canTestConnection = connectionCount > 0;

  const connectionListSection = (
    <>
      <div style={sectionLabel}>Connections</div>
      {info === null ? (
        <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font }}>Loading…</div>
      ) : (
        Object.entries(connections).map(([key, cfg]: [string, any]) => {
          const driver: string = cfg?.driver ?? cfg?.type ?? 'unknown';
          const isDefault = key === defaultKey;
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
                {!isDefault && (
                  <button
                    onClick={() => handleMakeDefault(key)}
                    disabled={saving}
                    style={{
                      background: 'transparent', border: `1px solid ${t.btnBorder}`,
                      borderRadius: 3, cursor: saving ? 'not-allowed' : 'pointer', color: t.textMuted,
                      fontSize: 10, fontFamily: t.font, padding: '1px 6px', transition: 'all 0.15s',
                    }}
                  >
                    Use
                  </button>
                )}
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
                    await api.saveConnections(conns, preset.name);
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
          color: saveMessageColor(saveMsg, t),
          background: `${saveMessageColor(saveMsg, t)}12`,
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
        disabled={testing || !canTestConnection}
        style={{
          width: '100%', padding: '7px 0', borderRadius: 6,
          border: `1px solid ${t.btnBorder}`, background: t.btnBg,
          color: t.textSecondary, fontSize: 12, fontFamily: t.font, fontWeight: 500,
          cursor: testing || !canTestConnection ? 'not-allowed' : 'pointer', marginBottom: 8,
          opacity: testing || !canTestConnection ? 0.7 : 1, transition: 'all 0.15s',
        }}
      >
        {testing ? 'Testing...' : canTestConnection ? 'Test Connection' : 'Add connection to test'}
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
          const installStatus = connectorStatusByDriver[driver];
          const installed = installStatus?.installed ?? true;
          const builtIn = installStatus?.builtIn ?? false;
          const installing = installingDriver === driver;
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
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                marginTop: 'auto',
              }}>
                <span
                  style={{
                    fontSize: 9,
                    fontFamily: t.font,
                    fontWeight: 600,
                    color: installed ? t.success : t.warning,
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                  }}
                >
                  {builtIn ? 'Built in' : installed ? 'Installed' : 'Install required'}
                </span>
                {!installed && (
                  <button
                    onClick={() => handleInstallConnector(driver)}
                    disabled={Boolean(installingDriver)}
                    title={installStatus?.installCommand}
                    style={{
                      border: `1px solid ${t.btnBorder}`,
                      background: t.btnBg,
                      color: t.textSecondary,
                      borderRadius: 4,
                      padding: '2px 7px',
                      fontSize: 10,
                      fontFamily: t.font,
                      cursor: installingDriver ? 'not-allowed' : 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {installing ? 'Installing...' : 'Install'}
                  </button>
                )}
              </div>
              <code style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontMono }}>
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

    const activeTab = state.settingsTab;
    const tabs: Array<{ id: SettingsTab; label: string; hint: string }> = [
      { id: 'database', label: 'Database connection', hint: 'Warehouse credentials and schema' },
      { id: 'ai', label: 'AI providers', hint: 'The model that powers everything' },
      { id: 'memory', label: 'Agentic memory', hint: 'What the agent has learned' },
    ];

    return (
      <>
        <style>{CONNECTION_PAGE_STYLES}</style>
        <div className="dql-connection-page-stack">
          <div role="tablist" aria-label="Settings sections" style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${t.cellBorder}`, marginBottom: 4 }}>
            {tabs.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={active}
                  onClick={() => dispatch({ type: 'SET_SETTINGS_TAB', tab: tab.id })}
                  title={tab.hint}
                  style={{
                    appearance: 'none',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    padding: '9px 14px',
                    marginBottom: -1,
                    fontSize: 13,
                    fontWeight: active ? 700 : 500,
                    fontFamily: t.font,
                    color: active ? t.accent : t.textSecondary,
                    borderBottom: `2px solid ${active ? t.accent : 'transparent'}`,
                    transition: 'color 0.15s, border-color 0.15s',
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {activeTab === 'database' ? (
            <div className="dql-connection-page-grid">
              <section style={panelSurface}>
                {connectionListSection}
                {dbtProfilesSection}
                {quickConnectSection}
              </section>
              <aside style={panelSurface}>
                <div style={{ ...sectionLabel, marginBottom: 8 }}>Database setup</div>
                {addConnectionSection}
                {saveMessageSection}
                {testConnectionSection}
                {catalogSection}
              </aside>
            </div>
          ) : activeTab === 'ai' ? (
            <ConnectionRuntimeSettings embedded section="providers" />
          ) : (
            <ConnectionRuntimeSettings embedded section="memory" />
          )}
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
.dql-connection-page-stack {
  display: grid;
  gap: 16px;
}

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
