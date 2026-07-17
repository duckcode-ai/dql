import React, { useEffect, useRef, useState } from 'react';
import { Database } from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { Theme } from '../../themes/notebook-theme';
import { api, type DbtProfileConnectionCandidate } from '../../api/client';
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
  activeConnection?: { source: 'dql_config' | 'dbt_profile' | 'runtime'; driver: string; profileId?: string } | null;
  dbtProfiles?: DbtProfileConnectionCandidate[];
  connectorStatus?: ConnectorInstallStatus[];
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
      { key: 'host', label: 'Workspace URL', type: 'text', required: true, placeholder: 'https://adb-123.cloud.databricks.com' },
      { key: 'database', label: 'Catalog / database', type: 'text' },
      { key: 'schema', label: 'Schema', type: 'text' },
      { key: 'warehouse', label: 'Warehouse ID', type: 'text', helpText: 'Use the SQL warehouse ID when you have it.' },
      { key: 'httpPath', label: 'SQL warehouse ID or path', type: 'text', placeholder: '/sql/1.0/warehouses/abc123', helpText: 'Paste the warehouse ID or its JDBC/HTTP path.' },
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

function connectionFieldsFromProfile(profile: DbtProfileConnectionCandidate): Record<string, string> {
  const fields: Record<string, string> = {};
  Object.entries(profile.connection ?? {}).forEach(([key, value]) => {
    if (key !== 'driver' && value !== undefined && value !== null) {
      fields[normalizeFieldName(key)] = String(value);
    }
  });
  return fields;
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
  const [profilePath, setProfilePath] = useState('');
  const [previewingProfiles, setPreviewingProfiles] = useState(false);
  const [profileImportError, setProfileImportError] = useState<string | null>(null);
  // Prototype settings nav: Advanced (MCP/runtime) selection lives locally —
  // the store's SettingsTab only knows database/ai/memory.
  const [advancedView, setAdvancedView] = useState<'advanced' | null>(null);

  // Edit form state (inline editor for the "manage all connections" list)
  const [editName, setEditName] = useState('');
  const [editDriver, setEditDriver] = useState('duckdb');
  const [editFields, setEditFields] = useState<Record<string, string>>({});

  // Prototype primary form: a single always-open editor bound to the default
  // connection (Warehouse select swaps fields → Save connection). Seeded from
  // the default connection and re-seeded whenever its identity changes.
  const [primaryDriver, setPrimaryDriver] = useState('duckdb');
  const [primaryFields, setPrimaryFields] = useState<Record<string, string>>({});
  const seededIdentityRef = useRef<string | null>(null);

  useEffect(() => {
    api.getConnections().then((connInfo) => {
      setInfo(connInfo);
      // Auto-test if connections exist
      if (Object.keys(connInfo.connections).length > 0) {
        api.testConnection().then(setTestResult);
      }
    });
  }, []);

  // Seed the primary form from the default connection. Keyed on the connection's
  // identity so user typing (which only updates primaryFields) never re-seeds,
  // but a save/import/default-change (which refreshes `info`) does.
  useEffect(() => {
    if (!info) return;
    const key = info.default;
    const cfg = key ? info.connections?.[key] : undefined;
    const identity = cfg ? `${key}::${JSON.stringify(cfg)}` : '::none';
    if (seededIdentityRef.current === identity) return;
    seededIdentityRef.current = identity;
    if (cfg) {
      setPrimaryDriver(normalizeDriverName(String(cfg.driver ?? cfg.type ?? 'duckdb')));
      const fields: Record<string, string> = {};
      Object.entries(cfg).forEach(([k, v]) => {
        if (k !== 'driver' && k !== 'type') fields[normalizeFieldName(k)] = String(v ?? '');
      });
      setPrimaryFields(fields);
    } else {
      setPrimaryDriver('duckdb');
      setPrimaryFields({});
    }
  }, [info]);

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

  // Shared persistence used by both the inline connection editor and the
  // prototype primary form. Builds a typed connection config, writes it, then
  // re-tests the hot-swapped connection.
  const persistConnection = async (opts: {
    name: string;
    driver: string;
    fields: Record<string, string>;
    previousName: string | null;
  }): Promise<boolean> => {
    if (!info) return false;
    setSaving(true);
    setSaveMsg(null);

    const name = opts.name.trim() || (opts.previousName ?? 'default');
    const newConn: Record<string, unknown> = { driver: opts.driver };
    const schema = CONNECTOR_SCHEMA_BY_DRIVER[opts.driver];
    const fieldSchemas = new Map((schema?.fields ?? []).map((field) => [field.key, field]));
    Object.entries(opts.fields).forEach(([k, v]) => {
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
    if (opts.previousName && opts.previousName !== name) delete connections[opts.previousName];
    connections[name] = newConn;
    const nextDefault = chooseDefaultAfterSave(connections, info.default, name, opts.previousName);

    let ok = false;
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
        ok = result.ok;
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
    return ok;
  };

  const startAddFromDbtProfile = (profile: DbtProfileConnectionCandidate) => {
    const driver = normalizeDriverName(String(profile.connection.driver ?? profile.adapter ?? 'duckdb'));
    const fields = connectionFieldsFromProfile(profile);
    setTestResult(null);

    if (isPage) {
      setPrimaryDriver(driver);
      setPrimaryFields(fields);
    }
    setAddingNew(false);
    setEditing(null);
    void persistConnection({
      name: connectionNameFromProfile(profile),
      driver,
      fields,
      previousName: null,
    });
  };

  const previewProfilePath = async () => {
    const path = profilePath.trim();
    if (!path) {
      setProfileImportError('Enter a profiles.yml file or folder path.');
      return;
    }
    setPreviewingProfiles(true);
    setProfileImportError(null);
    try {
      const result = await api.previewDbtProfiles(path);
      setInfo((current) => {
        if (!current) return current;
        const merged = new Map((current.dbtProfiles ?? []).map((profile) => [profile.id, profile]));
        result.dbtProfiles.forEach((profile) => merged.set(profile.id, profile));
        return { ...current, dbtProfiles: [...merged.values()] };
      });
    } catch (error) {
      setProfileImportError(error instanceof Error ? error.message : 'Could not read that profiles.yml path.');
    } finally {
      setPreviewingProfiles(false);
    }
  };

  const handleSave = () => persistConnection({
    name: editName,
    driver: editDriver,
    fields: editFields,
    previousName: editing,
  });

  const handlePrimarySave = () => persistConnection({
    name: (info?.default || 'default'),
    driver: primaryDriver,
    fields: primaryFields,
    previousName: info?.default || null,
  });

  const changePrimaryDriver = (driver: string) => {
    setPrimaryDriver(driver);
    // Switching warehouse type clears the old driver's fields, mirroring the
    // inline editor; a fresh field set avoids leaking incompatible keys.
    setPrimaryFields({});
    setTestResult(null);
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

  const profilePathSection = (
    <div style={{ ...card, marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 650, color: t.textPrimary, fontFamily: t.font }}>Import dbt profiles.yml</div>
      <div style={{ marginTop: 3, fontSize: 10.5, color: t.textMuted, lineHeight: 1.45, fontFamily: t.font }}>
        Load a profiles.yml, profiles.yaml, profile.yml, or profile.yaml file. DuckDB, Snowflake, and Databricks targets are supported.
      </div>
      <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
        <input
          aria-label="dbt profile file or folder path"
          value={profilePath}
          onChange={(event) => setProfilePath(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void previewProfilePath(); } }}
          placeholder="~/.dbt/profiles.yml or /path/to/profile.yaml"
          style={{ flex: 1, minWidth: 0, border: `1px solid ${t.inputBorder}`, borderRadius: 6, background: t.inputBg, color: t.textPrimary, padding: '7px 9px', fontSize: 11.5, fontFamily: t.fontMono, outline: 'none' }}
        />
        <button
          type="button"
          onClick={() => void previewProfilePath()}
          disabled={previewingProfiles}
          style={{ border: `1px solid ${t.btnBorder}`, borderRadius: 6, background: t.btnBg, color: t.textSecondary, padding: '0 11px', fontSize: 11, fontWeight: 650, fontFamily: t.font, cursor: previewingProfiles ? 'wait' : 'pointer' }}
        >
          {previewingProfiles ? 'Reading…' : 'Find profiles'}
        </button>
      </div>
      {profileImportError ? <div role="alert" style={{ marginTop: 6, color: t.error, fontSize: 10.5, fontFamily: t.font }}>{profileImportError}</div> : null}
    </div>
  );

  const dbtProfilesSection = (
    <>
      {!addingNew && !editing && dbtProfileCandidates.length > 0 && (
        <>
          <div style={{ ...sectionLabel, marginTop: 8 }}>dbt profiles</div>
          <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
            {dbtProfileCandidates.map((profile) => {
              const driver = normalizeDriverName(String(profile.connection.driver ?? profile.adapter));
              const color = DRIVER_COLORS[driver] ?? t.accent;
              const ready = profile.missingFields.length === 0;
              const activeFromProfile = info?.activeConnection?.source === 'dbt_profile'
                && info.activeConnection.profileId === profile.id;
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
                        ? activeFromProfile ? 'Active runtime connection · import to save' : 'Ready to import and test'
                        : `Imports now · needs ${profile.missingFields.join(', ')}`}
                    </div>
                  </div>
                  <button
                    onClick={() => startAddFromDbtProfile(profile)}
                    disabled={saving}
                    title={profile.warnings.join(' ') || undefined}
                    style={{
                      background: t.btnBg,
                      border: `1px solid ${t.btnBorder}`,
                      borderRadius: 4,
                      cursor: saving ? 'wait' : 'pointer',
                      color: t.textSecondary,
                      fontSize: 11,
                      fontFamily: t.font,
                      padding: '4px 8px',
                      flexShrink: 0,
                    }}
                  >
                    Import & test
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
    const activeTab = state.settingsTab;
    // Prototype (Settings Redesign): left settings nav rail with status dots +
    // an Advanced group, content column to the right.
    const showAdvanced = advancedView !== null;
    const connected = Boolean(info && Object.keys(info.connections ?? {}).length > 0);
    const navItem = (
      active: boolean,
      label: string,
      onClick: () => void,
      right?: React.ReactNode,
    ) => (
      <button
        key={label}
        type="button"
        onClick={onClick}
        style={{
          display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', borderRadius: 7,
          border: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 12.5, fontWeight: 600,
          fontFamily: t.font, width: '100%',
          background: active ? 'var(--accent-dim)' : 'transparent',
          color: active ? t.accent : t.textSecondary,
        }}
      >
        <span style={{ flex: 1 }}>{label}</span>
        {right}
      </button>
    );

    return (
      <>
        <style>{CONNECTION_PAGE_STYLES}</style>
        <div style={{ display: 'flex', gap: 0, alignItems: 'stretch', minHeight: 0 }}>
          <nav aria-label="Settings sections" style={{ width: 'clamp(190px, 17vw, 240px)', flexShrink: 0, borderRight: `1px solid ${t.cellBorder}`, padding: '10px 10px 10px 0', display: 'flex', flexDirection: 'column', gap: 2, alignSelf: 'flex-start', position: 'sticky', top: 0 }}>
            {navItem(!showAdvanced && activeTab === 'database', 'Database', () => { setAdvancedView(null); dispatch({ type: 'SET_SETTINGS_TAB', tab: 'database' }); },
              <span style={{ width: 7, height: 7, borderRadius: 999, background: connected ? 'var(--status-success)' : 'var(--status-warning)' }} title={connected ? 'Connected' : 'Not connected'} />)}
            {navItem(!showAdvanced && activeTab === 'ai', 'AI provider', () => { setAdvancedView(null); dispatch({ type: 'SET_SETTINGS_TAB', tab: 'ai' }); },
              <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--status-success)' }} title="Configured in the AI section" />)}
            {navItem(!showAdvanced && activeTab === 'memory', 'Agent memory', () => { setAdvancedView(null); dispatch({ type: 'SET_SETTINGS_TAB', tab: 'memory' }); })}
            <div style={{ height: 1, background: t.cellBorder, margin: '10px 10px 10px 0' }} />
            {navItem(advancedView === 'advanced', 'MCP servers', () => setAdvancedView('advanced'),
              <span style={{ fontSize: 10, color: t.textMuted }}>Advanced</span>)}
            {navItem(advancedView === 'advanced', 'Runtime env', () => setAdvancedView('advanced'),
              <span style={{ fontSize: 10, color: t.textMuted }}>Advanced</span>)}
          </nav>
          <div style={{ flex: 1, minWidth: 0, padding: '0 0 24px 20px' }}>
            {showAdvanced ? (
              <ConnectionRuntimeSettings embedded section="advanced" />
            ) : activeTab === 'database' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* Prototype header + live status card. */}
                <div>
                  <div style={{ fontSize: 17, fontWeight: 700, color: t.textPrimary, fontFamily: t.font }}>Database connection</div>
                  <div style={{ fontSize: 12.5, color: t.textMuted, marginTop: 3, lineHeight: 1.5, fontFamily: t.font }}>
                    Where your dbt models and data live. Credentials stay in <span style={{ fontFamily: t.fontMono, fontSize: 11.5 }}>.dql/</span> and are never sent anywhere.
                  </div>
                </div>
                <div style={{ border: `1px solid ${testResult?.ok ? 'var(--status-success-border)' : 'var(--border-subtle)'}`, borderRadius: 12, background: t.cellBg, padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 12, maxWidth: 640 }}>
                  <span style={{ width: 36, height: 36, borderRadius: 9, background: connected ? 'var(--status-success-bg)' : 'var(--status-warning-bg)', color: connected ? 'var(--status-success)' : 'var(--status-warning)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Database size={17} strokeWidth={1.75} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0, fontFamily: t.font }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary }}>
                      {(DRIVER_LABELS[String(info?.connections?.[info?.default ?? '']?.driver ?? '')] ?? info?.connections?.[info?.default ?? '']?.driver ?? 'No connection yet')}
                      {connected ? ' · connected' : ''}
                    </div>
                    <div style={{ fontSize: 11.5, marginTop: 2, color: testing ? t.textMuted : testResult ? (testResult.ok ? 'var(--status-success)' : 'var(--status-error)') : t.textMuted }}>
                      {testing ? 'Testing…' : testResult ? testResult.message : connected ? 'Ready — run Test connection to verify.' : 'Add a connection below to get started.'}
                    </div>
                  </div>
                  <button type="button" onClick={() => void handleTest()} disabled={testing} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 13px', borderRadius: 8, border: `1px solid ${t.cellBorder}`, background: t.cellBg, color: t.textSecondary, fontSize: 12, fontWeight: 650, cursor: 'pointer', fontFamily: t.font, flexShrink: 0 }}>
                    {testing ? 'Testing…' : 'Test connection'}
                  </button>
                </div>
                <div style={{ maxWidth: 640 }}>
                  {profilePathSection}
                  {dbtProfilesSection}
                </div>
                {/* Primary form — Warehouse select swaps fields + shows the
                    selected driver's catalog install status, then Save. */}
                <DatabaseConnectionForm
                  t={t}
                  driver={primaryDriver}
                  fields={primaryFields}
                  onDriverChange={changePrimaryDriver}
                  onFieldsChange={setPrimaryFields}
                  onSave={() => void handlePrimarySave()}
                  saving={saving}
                  saveMessage={saveMsg}
                  connectorStatus={connectorStatusByDriver[primaryDriver]}
                  installing={installingDriver === primaryDriver}
                  onInstall={() => void handleInstallConnector(primaryDriver)}
                />
              </div>
            ) : activeTab === 'ai' ? (
              <ConnectionRuntimeSettings embedded section="providers" />
            ) : (
              <ConnectionRuntimeSettings embedded section="memory" />
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <PanelFrame title="Connections" bodyPadding={12}>
      {connectionListSection}
      {profilePathSection}
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

@keyframes dql-connector-shimmer {
  0% { opacity: 1; }
  50% { opacity: 0.45; }
  100% { opacity: 1; }
}

.dql-connector-installing {
  animation: dql-connector-shimmer 1.4s ease-in-out infinite;
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

// Keep the manual enterprise path short: show shared connection context plus
// the credentials for the selected auth method. Everything uncommon remains
// available under Advanced options or is carried through untouched from dbt.
function primaryFieldKeys(driver: string, fields: Record<string, string>): string[] {
  if (driver === 'duckdb') return ['filepath'];
  if (driver === 'databricks') return ['host', 'httpPath', 'database', 'schema', 'authMethod', 'token'];
  if (driver !== 'snowflake') return [];

  const common = ['account', 'warehouse', 'database', 'schema', 'username', 'authMethod'];
  switch (fields.authMethod || 'password') {
    case 'key_pair':
      return [...common, 'privateKeyPath', 'privateKey', 'privateKeyPassphrase'];
    case 'external_browser':
      return common;
    case 'oauth':
    case 'programmatic_access_token':
      return [...common, 'token'];
    case 'oauth_authorization_code':
      return [...common, 'oauthClientId', 'oauthClientSecret'];
    case 'oauth_client_credentials':
      return [...common, 'oauthClientId', 'oauthClientSecret', 'oauthTokenRequestUrl'];
    case 'workload_identity':
      return [...common, 'workloadIdentityProvider', 'token'];
    case 'mfa':
      return [...common, 'password', 'passcode'];
    default:
      return [...common, 'password'];
  }
}

// Fields that should span the full form width rather than sit in the 2-col grid.
const FULL_WIDTH_FIELDS = new Set(['filepath', 'httpPath', 'accessUrl']);

function DatabaseConnectionForm({
  t,
  driver,
  fields,
  onDriverChange,
  onFieldsChange,
  onSave,
  saving,
  saveMessage,
  connectorStatus,
  installing,
  onInstall,
}: {
  t: Theme;
  driver: string;
  fields: Record<string, string>;
  onDriverChange: (driver: string) => void;
  onFieldsChange: (fields: Record<string, string>) => void;
  onSave: () => void;
  saving: boolean;
  saveMessage: string | null;
  connectorStatus?: ConnectorInstallStatus;
  installing: boolean;
  onInstall: () => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const schema = CONNECTOR_SCHEMA_BY_DRIVER[driver];
  const allFields = schema?.fields ?? [];
  const primaryKeys = primaryFieldKeys(driver, fields);
  const primaryKeySet = new Set(primaryKeys);
  // Preserve the schema's declared order within each group.
  const primaryFields = allFields.filter((f) => primaryKeySet.has(f.key));
  const advancedFields = allFields.filter((f) => !primaryKeySet.has(f.key));
  const setField = (key: string, value: string) => onFieldsChange({ ...fields, [key]: value });

  return (
    <div style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 12, background: t.cellBg, padding: 18, display: 'flex', flexDirection: 'column', gap: 13, maxWidth: 640 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 280 }}>
        <span style={{ fontSize: 11, fontWeight: 650, color: t.textSecondary, fontFamily: t.font }}>Warehouse</span>
        <select
          value={driver}
          onChange={(e) => onDriverChange(e.target.value)}
          style={{ border: `1px solid ${t.cellBorder}`, background: t.cellBg, borderRadius: 8, padding: '8px 9px', fontSize: 12.5, fontFamily: t.font, color: t.textPrimary, outline: 'none' }}
        >
          {CONNECTOR_SCHEMAS.map(({ driver: value, label }) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </label>

      {/* Catalog install status for the selected warehouse's connector. */}
      <ConnectorStatusRow
        t={t}
        driver={driver}
        label={schema?.label ?? driver}
        status={connectorStatus}
        installing={installing}
        onInstall={onInstall}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {primaryFields.map((field) => (
          <StyledField
            key={field.key}
            t={t}
            field={field}
            value={fields[field.key] ?? ''}
            onChange={(v) => setField(field.key, v)}
            fullWidth={FULL_WIDTH_FIELDS.has(field.key)}
          />
        ))}
      </div>

      {advancedFields.length > 0 && (
        <details
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
          style={{ borderTop: `1px solid ${t.headerBorder}`, paddingTop: 12 }}
        >
          <summary style={{ cursor: 'pointer', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, fontWeight: 650, color: t.textSecondary, fontFamily: t.font }}>
            <span style={{ color: t.textMuted, fontSize: 10, transform: advancedOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>▶</span>
            Advanced options
            <span style={{ fontWeight: 400, color: t.textMuted, fontSize: 10.5 }}>{advancedFields.length} more</span>
          </summary>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
            {advancedFields.map((field) => (
              <StyledField
                key={field.key}
                t={t}
                field={field}
                value={fields[field.key] ?? ''}
                onChange={(v) => setField(field.key, v)}
                fullWidth={FULL_WIDTH_FIELDS.has(field.key) || field.type === 'textarea'}
              />
            ))}
          </div>
        </details>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4, borderTop: `1px solid ${t.headerBorder}` }}>
        <span style={{ fontSize: 10.5, color: t.textMuted, flex: 1, fontFamily: t.font }}>
          {saveMessage ?? 'Changes apply after a successful test.'}
        </span>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          style={{ height: 30, padding: '0 15px', borderRadius: 8, border: 'none', background: t.accent, color: '#fff', fontSize: 12, fontWeight: 650, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: t.font, boxShadow: '0 1px 4px rgba(107,93,211,0.25)', opacity: saving ? 0.7 : 1 }}
        >
          {saving ? 'Saving…' : 'Save connection'}
        </button>
      </div>
    </div>
  );
}

/**
 * Catalog install status for the selected warehouse's driver connector.
 * Mirrors the Setup Onboarding "catalog driver row": built-in drivers show
 * ready, installed drivers show a check, and drivers that need their package
 * show an Install action (→ installing shimmer → installed).
 */
function ConnectorStatusRow({
  t,
  driver,
  label,
  status,
  installing,
  onInstall,
}: {
  t: Theme;
  driver: string;
  label: string;
  status?: ConnectorInstallStatus;
  installing: boolean;
  onInstall: () => void;
}) {
  // Absent status = built-in/bundled driver (e.g. DuckDB) — treat as ready.
  const builtIn = status?.builtIn ?? true;
  const installed = status?.installed ?? true;
  const needsInstall = !installed && !builtIn;

  const tone = installing ? t.warning : needsInstall ? t.warning : t.success;
  const toneBg = installing ? 'var(--status-warning-bg)' : needsInstall ? 'var(--status-warning-bg)' : 'var(--status-success-bg)';
  const toneBorder = installing ? 'var(--status-warning-border)' : needsInstall ? 'var(--status-warning-border)' : 'var(--status-success-border)';
  const statusText = installing
    ? 'Installing connector package…'
    : builtIn
      ? 'Built in — no installation needed'
      : installed
        ? 'Connector installed and ready'
        : 'Connector package required before you can connect';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: `1px solid ${toneBorder}`, borderRadius: 9, background: toneBg, padding: '10px 12px' }}>
      <DriverLogo driver={driver} size={18} fallbackColor={DRIVER_COLORS[driver] ?? t.accent} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 650, color: t.textPrimary, fontFamily: t.font }}>{label} connector</div>
        <div
          className={installing ? 'dql-connector-installing' : undefined}
          style={{ fontSize: 11, color: tone, fontFamily: t.font, marginTop: 1 }}
        >
          {statusText}
        </div>
      </div>
      {needsInstall || installing ? (
        <button
          type="button"
          onClick={onInstall}
          disabled={installing}
          title={status?.installCommand}
          style={{ flexShrink: 0, height: 28, padding: '0 12px', borderRadius: 8, border: `1px solid ${t.accent}`, background: 'var(--accent-dim)', color: t.accent, fontSize: 11.5, fontWeight: 650, cursor: installing ? 'not-allowed' : 'pointer', fontFamily: t.font, opacity: installing ? 0.75 : 1 }}
        >
          {installing ? 'Installing…' : 'Install connector'}
        </button>
      ) : (
        <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 650, color: tone, fontFamily: t.font }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          {builtIn ? 'Ready' : 'Installed'}
        </span>
      )}
    </div>
  );
}

/** A single labelled form control styled to the Settings-redesign prototype. */
function StyledField({
  t,
  field,
  value,
  onChange,
  fullWidth,
}: {
  t: Theme;
  field: ConnectorFieldSchema;
  value: string;
  onChange: (value: string) => void;
  fullWidth?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const borderColor = focused ? t.accent : t.cellBorder;
  const controlBase: React.CSSProperties = {
    border: `1px solid ${borderColor}`,
    background: t.cellBg,
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 12,
    fontFamily: t.fontMono,
    color: t.textPrimary,
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  };
  const wrapStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    gridColumn: fullWidth ? '1 / -1' : undefined,
  };
  const labelNode = (
    <span style={{ fontSize: 11, fontWeight: 650, color: t.textSecondary, fontFamily: t.font }}>
      {field.label}{field.required ? ' *' : ''}
    </span>
  );

  if (field.type === 'checkbox') {
    return (
      <label style={{ ...wrapStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
        />
        {labelNode}
      </label>
    );
  }

  return (
    <label style={wrapStyle}>
      {labelNode}
      {field.type === 'select' ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{ ...controlBase, fontFamily: t.font, fontSize: 12.5, padding: '8px 9px' }}
        >
          <option value="">Default</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : field.type === 'textarea' ? (
        <textarea
          value={value}
          placeholder={field.placeholder ?? ''}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{ ...controlBase, minHeight: 72, resize: 'vertical' }}
        />
      ) : (
        <input
          type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
          value={value}
          placeholder={field.placeholder ?? ''}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={controlBase}
        />
      )}
      {field.helpText && (
        <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font, lineHeight: 1.35 }}>{field.helpText}</span>
      )}
    </label>
  );
}
