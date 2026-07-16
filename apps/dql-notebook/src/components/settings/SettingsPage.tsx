import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  api,
  type AgentMemory,
  type OAuthProviderId,
  type OAuthStatus,
  type ProviderCliStatus,
  type ProviderSettings,
  type ProviderSettingsId,
  type ReasoningEffortSetting,
  type RemoteMcpEntry,
  type RemoteMcpSettings,
  type SettingsEnvGroup,
} from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';

const PROVIDER_ORDER: ProviderSettingsId[] = ['claude-code', 'codex', 'anthropic', 'openai', 'gemini', 'ollama', 'custom-openai'];
// Subscription providers (log in with an installed CLI) render as their own group,
// separate from API-key / local providers.
const SUBSCRIPTION_PROVIDER_ORDER: ProviderSettingsId[] = ['claude-code', 'codex'];
const KEY_PROVIDER_ORDER: ProviderSettingsId[] = ['anthropic', 'openai', 'gemini', 'ollama', 'custom-openai'];

// Base URL is supported for every provider so enterprise deployments can route
// through a gateway/proxy. Empty = use the provider's public default.
function baseUrlPlaceholder(id: ProviderSettingsId): string {
  switch (id) {
    case 'ollama':
      return 'http://host.docker.internal:11434 or http://127.0.0.1:11434';
    case 'anthropic':
      return 'Base URL (optional) — e.g. https://api.anthropic.com or your gateway';
    case 'gemini':
      return 'Base URL (optional) — e.g. https://generativelanguage.googleapis.com/v1beta or your gateway';
    case 'openai':
      return 'Base URL (optional) — e.g. https://api.openai.com/v1 or your gateway';
    case 'custom-openai':
    default:
      return 'Base URL — e.g. https://your-gateway/v1';
  }
}

export function SettingsPage() {
  return <ConnectionRuntimeSettings includeMemory />;
}

export function ConnectionRuntimeSettings({
  includeMemory = true,
  embedded = false,
  section,
}: {
  includeMemory?: boolean;
  embedded?: boolean;
  /** When set, render only this section (for the tabbed Settings page). */
  section?: 'providers' | 'memory' | 'advanced';
}) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const [groups, setGroups] = useState<SettingsEnvGroup[]>([]);
  const [providers, setProviders] = useState<ProviderSettings[]>([]);
  const [cliStatus, setCliStatus] = useState<Partial<Record<ProviderSettingsId, ProviderCliStatus>>>({});
  const [mcpSettings, setMcpSettings] = useState<RemoteMcpSettings>({ path: '', entries: [], warnings: [] });
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [env, providerRes, mcpRes, memoryRes] = await Promise.all([
        api.getSettingsEnvStatus(),
        api.getProviderSettings(),
        api.getRemoteMcpSettings(),
        includeMemory ? api.listAgentMemory() : Promise.resolve({ memories: [] }),
      ]);
      setGroups(env.groups);
      setProviders(providerRes.providers);
      setMcpSettings(mcpRes.settings);
      setMemories(memoryRes.memories);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Detect installed/logged-in subscription CLIs separately — it spawns the CLIs,
  // so it must not block the main settings load.
  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    void api.getProviderCliStatus().then((res) => {
      if (!cancelled) setCliStatus(res.status ?? {});
    });
    return () => { cancelled = true; };
  }, [loading]);

  const configured = useMemo(() => providers.filter((p) => p.enabled && (p.hasApiKey || p.id === 'ollama' || p.authMode === 'subscription_cli')).length, [providers]);
  const activeProvider = providers.find((provider) => provider.active);

  return (
    <div style={{ padding: embedded ? 0 : 24, maxWidth: embedded ? undefined : 1180 }}>
      {!section && (
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>AI providers, memory &amp; connections</div>
            <div style={{ color: t.textSecondary, fontSize: 13, marginTop: 6, lineHeight: 1.5, maxWidth: 820 }}>
              Connect a model provider, manage the agent's learning &amp; memory, and (optionally) attach MCP servers. Secrets stay under <code>.dql/</code> and are never returned raw.
            </div>
          </div>
          <SummaryCard
            configured={configured}
            total={providers.length || PROVIDER_ORDER.length}
            activeLabel={activeProvider?.label}
            t={t}
          />
        </div>
      )}

      {status && (
        <div style={{ marginTop: 14, border: `1px solid ${t.headerBorder}`, borderRadius: 8, padding: '10px 12px', fontSize: 12, color: t.textSecondary, background: t.cellBg }}>
          {status}
        </div>
      )}

      {loading ? (
        <div style={{ marginTop: 24, color: t.textSecondary }}>Loading settings...</div>
      ) : (
        <>
          {section === 'providers' && (
            <ProviderSettingsForm
              providers={providers}
              cliStatus={cliStatus}
              t={t}
              onSaved={(next) => setProviders(next)}
              onStatus={setStatus}
            />
          )}
          {!section && (
          <section style={{ marginTop: 22 }}>
            <SectionTitle title="Model providers" detail="Connect at least one AI provider — it powers governed answers, block suggestions, and research. Sign in with a Claude or ChatGPT subscription, or use an API key / local model." t={t} />

            <GroupLabel
              title="Use your subscription"
              detail="No API key — sign in with the provider's CLI. DQL runs each request through it using your plan."
              t={t}
            />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
              {SUBSCRIPTION_PROVIDER_ORDER.map((id) => {
                const provider = providers.find((p) => p.id === id);
                return provider ? (
                  <ProviderCard
                    key={id}
                    provider={provider}
                    cliStatus={cliStatus[id]}
                    t={t}
                    onSaved={(next) => setProviders(next)}
                    onStatus={setStatus}
                  />
                ) : null;
              })}
            </div>

            <GroupLabel
              title="API key & local providers"
              detail="Paste an API key (or set the env var), point at a gateway, or run a local model with Ollama."
              t={t}
            />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
              {KEY_PROVIDER_ORDER.map((id) => {
                const provider = providers.find((p) => p.id === id);
                return provider ? (
                  <ProviderCard
                    key={id}
                    provider={provider}
                    t={t}
                    onSaved={(next) => setProviders(next)}
                    onStatus={setStatus}
                  />
                ) : null;
              })}
            </div>
          </section>
          )}

          {(!section || section === 'memory') && includeMemory && (
            <section style={{ marginTop: section ? 0 : 22 }}>
              <SectionTitle
                title="Agent learning & memory"
                detail="Durable business context the agent now reads on every question — your glossary, rules, and the lessons it learns when you correct or certify a draft. Advisory only: it never overrides certified metadata or routing."
                t={t}
              />
              <MemoryEditor
                memories={memories}
                t={t}
                onChange={setMemories}
                onStatus={setStatus}
              />
            </section>
          )}

          {/* Prototype: MCP servers + Runtime env are their own "Advanced" nav
              sections; the legacy no-section page keeps the collapsed details. */}
          {section === 'advanced' && (
            <>
              <section>
                <SectionTitle title="MCP servers and connectors" detail="Remote MCP servers can be attached to OpenAI and Claude SDK chat. OpenAI hosted connectors are OpenAI-only." t={t} />
                <McpConnectionsEditor
                  settings={mcpSettings}
                  t={t}
                  onChange={setMcpSettings}
                  onStatus={setStatus}
                />
              </section>
              <section style={{ marginTop: 22 }}>
                <SectionTitle title="Runtime status" detail="Environment variables remain supported for Docker, CI, and shell-based setup." t={t} />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
                  {groups.map((group) => (
                    <EnvGroupCard key={group.id} group={group} t={t} />
                  ))}
                </div>
              </section>
            </>
          )}
          {!section && (
          <details style={{ marginTop: 22, border: `1px solid ${t.headerBorder}`, borderRadius: 10, background: t.cellBg, overflow: 'hidden' }}>
            <summary style={{ cursor: 'pointer', padding: '13px 16px', fontSize: 13, fontWeight: 650, listStyle: 'none', color: t.textPrimary }}>
              Advanced — MCP connections &amp; runtime status
              <span style={{ color: t.textMuted, fontWeight: 400, marginLeft: 8, fontSize: 12 }}>optional for most users</span>
            </summary>
            <div style={{ padding: '4px 16px 18px' }}>
              <section style={{ marginTop: 14 }}>
                <SectionTitle title="MCP servers and connectors" detail="Remote MCP servers can be attached to OpenAI and Claude SDK chat. OpenAI hosted connectors are OpenAI-only." t={t} />
                <McpConnectionsEditor
                  settings={mcpSettings}
                  t={t}
                  onChange={setMcpSettings}
                  onStatus={setStatus}
                />
              </section>

              <section style={{ marginTop: 22 }}>
                <SectionTitle title="Runtime status" detail="Environment variables remain supported for Docker, CI, and shell-based setup." t={t} />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
                  {groups.map((group) => (
                    <EnvGroupCard key={group.id} group={group} t={t} />
                  ))}
                </div>
              </section>
            </div>
          </details>
          )}
        </>
      )}
    </div>
  );
}

function McpConnectionsEditor({
  settings,
  t,
  onChange,
  onStatus,
}: {
  settings: RemoteMcpSettings;
  t: Theme;
  onChange: (settings: RemoteMcpSettings) => void;
  onStatus: (message: string | null) => void;
}) {
  const [entries, setEntries] = useState<RemoteMcpEntry[]>(settings.entries);
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [jsonDraft, setJsonDraft] = useState(() => entriesToMcpConfigJson(settings.entries));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEntries(settings.entries);
    setJsonDraft(entriesToMcpConfigJson(settings.entries));
    setJsonError(null);
  }, [settings]);

  const replaceEntries = (next: RemoteMcpEntry[]) => {
    setEntries(next);
    setJsonDraft(entriesToMcpConfigJson(next));
    setJsonError(null);
  };

  const update = (index: number, patch: Partial<RemoteMcpEntry>) => {
    replaceEntries(entries.map((entry, i) => i === index ? normalizeMcpEntry({ ...entry, ...patch }) : entry));
  };

  const remove = (index: number) => {
    replaceEntries(entries.filter((_, i) => i !== index));
  };

  const addServer = () => {
    replaceEntries([...entries, {
      kind: 'server',
      name: '',
      url: '',
      enabled: true,
      trusted: false,
      providers: ['openai', 'anthropic'],
    }]);
  };

  const addConnector = () => {
    replaceEntries([...entries, {
      kind: 'connector',
      name: '',
      connectorId: 'connector_googledrive',
      enabled: true,
      trusted: false,
      providers: ['openai'],
    }]);
  };

  const selectMode = (next: 'form' | 'json') => {
    if (next === 'json') setJsonDraft(entriesToMcpConfigJson(entries));
    setJsonError(null);
    setMode(next);
  };

  const parseJsonDraft = (): RemoteMcpEntry[] => {
    const next = parseMcpConfigJson(jsonDraft);
    setEntries(next);
    setJsonDraft(entriesToMcpConfigJson(next));
    setJsonError(null);
    return next;
  };

  const formatJsonDraft = () => {
    try {
      parseJsonDraft();
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error));
    }
  };

  const applyJsonDraft = () => {
    try {
      parseJsonDraft();
      setMode('form');
      onStatus('MCP JSON applied.');
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error));
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const nextEntries = mode === 'json' ? parseJsonDraft() : entries;
      const result = await api.saveRemoteMcpSettings(nextEntries.map((entry) => normalizeMcpEntry(entry)));
      onChange(result.settings);
      const warningText = result.settings.warnings.length ? ` ${result.settings.warnings.join(' ')}` : '';
      onStatus(`MCP connections saved.${warningText}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (mode === 'json') setJsonError(message);
      onStatus(message);
    } finally {
      setBusy(false);
    }
  };

  const enabledTrusted = entries.filter((entry) => entry.enabled && entry.trusted).length;
  const serverCount = entries.filter((entry) => entry.kind === 'server').length;
  const connectorCount = entries.filter((entry) => entry.kind === 'connector').length;

  return (
    <section style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.cellBg, padding: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 12, color: t.textSecondary }}>
            {enabledTrusted} trusted connection{enabledTrusted === 1 ? '' : 's'} available to SDK providers
          </div>
          <div style={{ fontSize: 11, color: t.textMuted, marginTop: 3 }}>
            {serverCount} remote server{serverCount === 1 ? '' : 's'} / {connectorCount} OpenAI connector{connectorCount === 1 ? '' : 's'}
          </div>
          {settings.path && <div style={{ fontSize: 11, color: t.textMuted, marginTop: 3, fontFamily: t.fontMono }}>{settings.path}</div>}
        </div>
        <div style={{ display: 'flex', border: `1px solid ${t.headerBorder}`, borderRadius: 6, overflow: 'hidden' }}>
          <button type="button" onClick={() => selectMode('form')} style={segmentedButtonStyle(t, mode === 'form')}>Form</button>
          <button type="button" onClick={() => selectMode('json')} style={segmentedButtonStyle(t, mode === 'json')}>JSON import</button>
        </div>
        <button type="button" onClick={addServer} style={buttonStyle(t, false)}>Add MCP server</button>
        <button type="button" onClick={addConnector} style={buttonStyle(t, false)}>Add OpenAI connector</button>
        <button type="button" onClick={save} disabled={busy} style={buttonStyle(t, true)}>Save MCP</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginTop: 12 }}>
        <McpCompatibilityCard
          title="Remote MCP server"
          detail="Use URL-based MCP servers with OpenAI and Claude. Mark trusted when the server is approved for model tool use."
          badge="OpenAI + Claude"
          t={t}
        />
        <McpCompatibilityCard
          title="OpenAI connector"
          detail="Use OpenAI hosted connectors such as Google Drive. These are skipped for Claude because Anthropic does not use connector IDs."
          badge="OpenAI only"
          t={t}
        />
        <McpCompatibilityCard
          title="JSON import"
          detail="Paste DQL JSON, OpenAI Responses tools, or Claude mcp_servers. DQL saves the normalized project config."
          badge="DQL normalized"
          t={t}
        />
      </div>

      {settings.warnings.length > 0 && (
        <div style={{ marginTop: 10, color: '#9a5a00', fontSize: 12, lineHeight: 1.4 }}>
          {settings.warnings.join(' ')}
        </div>
      )}

      {mode === 'json' ? (
        <div style={{ marginTop: 14 }}>
          <div style={{ color: t.textSecondary, fontSize: 12, lineHeight: 1.45, marginBottom: 8 }}>
            Paste DQL MCP JSON, OpenAI Responses <code>tools</code>, or Claude <code>mcp_servers</code>. Existing stored tokens are preserved when <code>authorizationToken</code> is omitted and the same kind/name is kept.
          </div>
          <textarea
            value={jsonDraft}
            onChange={(event) => {
              setJsonDraft(event.target.value);
              setJsonError(null);
            }}
            spellCheck={false}
            rows={18}
            style={{
              ...inputStyle(t),
              width: '100%',
              minHeight: 360,
              resize: 'vertical',
              fontFamily: t.fontMono,
              fontSize: 12,
              lineHeight: 1.45,
            }}
          />
          {jsonError && (
            <div style={{ color: '#b42318', fontSize: 12, marginTop: 8 }}>
              {jsonError}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" onClick={formatJsonDraft} style={buttonStyle(t, false)}>Format JSON</button>
            <button type="button" onClick={applyJsonDraft} style={buttonStyle(t, false)}>Apply to form</button>
          </div>
        </div>
      ) : entries.length === 0 ? (
        <div style={{ marginTop: 14, color: t.textSecondary, fontSize: 12 }}>
          No MCP connections configured.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12, marginTop: 14 }}>
          {entries.map((entry, index) => (
            <div key={`${entry.kind}-${entry.name || index}`} style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, padding: 12, background: t.appBg }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select
                  value={entry.kind}
                  onChange={(event) => update(index, {
                    kind: event.target.value === 'connector' ? 'connector' : 'server',
                    providers: event.target.value === 'connector' ? ['openai'] : entry.providers,
                  })}
                  style={{ ...inputStyle(t), width: 116 }}
                >
                  <option value="server">Server</option>
                  <option value="connector">Connector</option>
                </select>
                <input
                  value={entry.name}
                  onChange={(event) => update(index, { name: event.target.value })}
                  placeholder="Name"
                  style={{ ...inputStyle(t), flex: 1 }}
                />
                <button type="button" onClick={() => remove(index)} style={buttonStyle(t, false)}>Remove</button>
              </div>

              <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                {entry.kind === 'connector' ? (
                  <input
                    value={entry.connectorId ?? ''}
                    onChange={(event) => update(index, { connectorId: event.target.value })}
                    placeholder="connector_googledrive"
                    style={inputStyle(t)}
                  />
                ) : (
                  <input
                    value={entry.url ?? ''}
                    onChange={(event) => update(index, { url: event.target.value })}
                    placeholder="https://example.com/mcp or /sse"
                    style={inputStyle(t)}
                  />
                )}
                <input
                  value={entry.description ?? ''}
                  onChange={(event) => update(index, { description: event.target.value })}
                  placeholder="Description shown to the model"
                  style={inputStyle(t)}
                />
                <input
                  value={entry.authorizationTokenEnv ?? ''}
                  onChange={(event) => update(index, { authorizationTokenEnv: event.target.value })}
                  placeholder="Authorization token env var"
                  style={inputStyle(t)}
                />
                <input
                  value={entry.authorizationToken ?? ''}
                  onChange={(event) => update(index, { authorizationToken: event.target.value })}
                  type="password"
                  placeholder={entry.hasAuthorizationToken ? `Leave blank to keep ${entry.authorizationTokenPreview ?? 'stored token'}` : 'Optional OAuth token'}
                  style={inputStyle(t)}
                />
                <input
                  value={(entry.allowedTools ?? []).join(', ')}
                  onChange={(event) => update(index, { allowedTools: splitCsv(event.target.value) })}
                  placeholder="Allowed tools, comma separated"
                  style={inputStyle(t)}
                />
              </div>

              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
                <label style={checkboxLabelStyle(t)}><input type="checkbox" checked={entry.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} /> Enabled</label>
                <label style={checkboxLabelStyle(t)}><input type="checkbox" checked={entry.trusted} onChange={(event) => update(index, { trusted: event.target.checked })} /> Trusted</label>
                <label style={checkboxLabelStyle(t)}><input type="checkbox" checked={Boolean(entry.deferLoading)} onChange={(event) => update(index, { deferLoading: event.target.checked })} /> Defer tools</label>
                <label style={checkboxLabelStyle(t)}><input type="checkbox" checked={(entry.providers ?? []).includes('openai')} onChange={(event) => update(index, { providers: toggleMcpProvider(entry.providers, 'openai', event.target.checked) })} /> OpenAI</label>
                <label style={checkboxLabelStyle(t)}><input type="checkbox" checked={(entry.providers ?? []).includes('anthropic')} disabled={entry.kind === 'connector'} onChange={(event) => update(index, { providers: toggleMcpProvider(entry.providers, 'anthropic', event.target.checked) })} /> Anthropic</label>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function McpCompatibilityCard({
  title,
  detail,
  badge,
  t,
}: {
  title: string;
  detail: string;
  badge: string;
  t: Theme;
}) {
  return (
    <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.appBg, padding: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary }}>{title}</div>
        <span style={{ marginLeft: 'auto', border: `1px solid ${t.accent}33`, borderRadius: 999, padding: '2px 7px', color: t.accent, background: `${t.accent}12`, fontSize: 10, fontWeight: 800, whiteSpace: 'nowrap' }}>
          {badge}
        </span>
      </div>
      <div style={{ color: t.textSecondary, fontSize: 11, lineHeight: 1.45, marginTop: 6 }}>
        {detail}
      </div>
    </div>
  );
}

function CliStatusLine({ status, command, loginCmd, t }: { status?: ProviderCliStatus; command?: string; loginCmd: string; t: Theme }) {
  let tone = t.textMuted;
  let dot = t.textMuted;
  let text: React.ReactNode = 'Checking for the CLI…';
  if (status) {
    if (!status.installed) {
      tone = t.warning; dot = t.warning;
      text = <><code>{command}</code> CLI not found on this machine — install it, then sign in.</>;
    } else if (!status.loggedIn) {
      tone = t.warning; dot = t.warning;
      text = <>Installed but not signed in — run <code>{command} {loginCmd}</code>.</>;
    } else {
      tone = t.success; dot = t.success;
      const who = [status.email, status.subscriptionType ? `${status.subscriptionType} plan` : status.authMethod]
        .filter(Boolean).join(' · ');
      text = <>Signed in{who ? <> — {who}</> : ''}. Ready to use.</>;
    }
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: tone }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flex: '0 0 auto' }} />
      <span>{text}</span>
    </div>
  );
}

function GroupLabel({ title, detail, t }: { title: string; detail: string; t: Theme }) {
  return (
    <div style={{ margin: '20px 0 10px' }}>
      <div style={{ fontSize: 12.5, fontWeight: 750, color: t.textPrimary, letterSpacing: '-0.01em' }}>{title}</div>
      <div style={{ fontSize: 11.5, color: t.textSecondary, marginTop: 2, lineHeight: 1.45 }}>{detail}</div>
    </div>
  );
}

/** Map a subscription settings id to its OAuth provider id. */
function oauthProviderFor(id: ProviderSettingsId): OAuthProviderId {
  return id === 'codex' ? 'codex' : 'claude';
}

/**
 * Browser sign-in for a subscription provider (Claude Pro/Max, ChatGPT Plus/Pro).
 * "Sign in" opens the provider's OAuth page in a new tab; the local callback
 * captures the redirect and stores the token, and we poll until connected —
 * then auto-activate with the subscription's default model. Falls back to a note
 * about the CLI path.
 */
function SubscriptionOAuthPanel({
  oauthProvider,
  label,
  model,
  setModel,
  cliStatus,
  command,
  loginCmd,
  t,
  onStatus,
  onConnected,
}: {
  oauthProvider: OAuthProviderId;
  label: string;
  model: string;
  setModel: (m: string) => void;
  cliStatus?: ProviderCliStatus;
  command?: string;
  loginCmd: string;
  t: Theme;
  onStatus: (message: string | null) => void;
  onConnected: (defaultModel: string) => void;
}) {
  const [status, setStatus] = useState<OAuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const brand = oauthProvider === 'codex' ? 'ChatGPT' : 'Claude';

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    api.getOAuthStatus(oauthProvider).then((s) => { if (mountedRef.current) setStatus(s); }).catch(() => { /* offline */ });
    return () => { mountedRef.current = false; stopPolling(); };
  }, [oauthProvider, stopPolling]);

  const signIn = async () => {
    setBusy(true);
    try {
      const res = await api.startOAuth(oauthProvider);
      setStatus(res);
      window.open(res.url, '_blank', 'noopener,noreferrer');
      onStatus(`Opened your browser to sign in to ${brand}. Complete it there — this updates automatically.`);
      const started = Date.now();
      stopPolling();
      pollRef.current = window.setInterval(async () => {
        const s = await api.getOAuthStatus(oauthProvider).catch(() => null);
        if (!mountedRef.current) { stopPolling(); return; }
        if (s) setStatus(s);
        if (s?.connected) {
          stopPolling();
          setBusy(false);
          onConnected(s.defaultModel);
        } else if (Date.now() - started > 5 * 60 * 1000) {
          stopPolling();
          setBusy(false);
          onStatus(`${brand} sign-in timed out. Try again.`);
        }
      }, 2500);
    } catch (error) {
      setBusy(false);
      onStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const signOut = async () => {
    setBusy(true);
    stopPolling();
    try {
      setStatus(await api.signOutOAuth(oauthProvider));
      onStatus(`Signed out of ${brand}.`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (status?.connected) {
    const models = status.models.length > 0 ? status.models : [status.defaultModel];
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
          <span style={{ color: '#16a34a', fontWeight: 700 }}>✓ Signed in to {brand}</span>
          {status.email ? <span style={{ color: t.textSecondary }}>as {status.email}</span> : null}
        </div>
        <label style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>Model</label>
        <select value={model || status.defaultModel} onChange={(e) => setModel(e.target.value)} style={inputStyle(t)}>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <div>
          <button type="button" onClick={signOut} disabled={busy} style={buttonStyle(t, false)}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <button type="button" onClick={signIn} disabled={busy} style={buttonStyle(t, true)}>
        {busy || status?.pending ? `Waiting for ${brand}…` : `Sign in with ${brand}`}
      </button>
      <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.5 }}>
        No API key needed — signs in with your {brand} subscription in the browser.
      </div>
      <details>
        <summary style={{ fontSize: 11.5, color: t.textSecondary, cursor: 'pointer' }}>Prefer the CLI?</summary>
        <div style={{ marginTop: 6, display: 'grid', gap: 6 }}>
          <CliStatusLine status={cliStatus} command={command} loginCmd={loginCmd} t={t} />
          <div style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.5 }}>
            Or install the <code>{command}</code> CLI and run <code>{command} {loginCmd}</code>, then Enable + Save.
          </div>
        </div>
      </details>
    </div>
  );
}

// ── Prototype AI-provider section (Settings Redesign) ───────────────────────
// One form: pick the provider brand, then "How do you want to connect?" radio
// cards (Subscription / API key / Local — only what the brand supports) swap
// the sub-form beneath. The active provider shows as a status card with Test.
type ProviderBrandMode = 'subscription' | 'api' | 'local';
const PROVIDER_BRANDS: Array<{ key: string; label: string; modes: Partial<Record<ProviderBrandMode, ProviderSettingsId>> }> = [
  { key: 'claude', label: 'Anthropic Claude', modes: { subscription: 'claude-code', api: 'anthropic' } },
  { key: 'openai', label: 'OpenAI', modes: { subscription: 'codex', api: 'openai' } },
  { key: 'gemini', label: 'Google Gemini', modes: { api: 'gemini' } },
  { key: 'ollama', label: 'Ollama — local', modes: { local: 'ollama' } },
  { key: 'gateway', label: 'Custom gateway', modes: { api: 'custom-openai' } },
];
const MODE_COPY: Record<ProviderBrandMode, { label: string; hint: string }> = {
  subscription: { label: 'Subscription', hint: 'Sign in — no API key' },
  api: { label: 'API key', hint: 'Paste a key or use env var' },
  local: { label: 'Local', hint: 'Runs on this machine' },
};

function brandForProviderId(id: ProviderSettingsId | undefined): string {
  if (!id) return 'claude';
  const brand = PROVIDER_BRANDS.find((entry) => Object.values(entry.modes).includes(id));
  return brand?.key ?? 'claude';
}

function ProviderSettingsForm({
  providers,
  cliStatus,
  t,
  onSaved,
  onStatus,
}: {
  providers: ProviderSettings[];
  cliStatus: Partial<Record<ProviderSettingsId, ProviderCliStatus>>;
  t: Theme;
  onSaved: (providers: ProviderSettings[]) => void;
  onStatus: (message: string | null) => void;
}) {
  const activeProvider = providers.find((provider) => provider.active);
  const [brandKey, setBrandKey] = useState<string>(() => brandForProviderId(activeProvider?.id));
  const brand = PROVIDER_BRANDS.find((entry) => entry.key === brandKey) ?? PROVIDER_BRANDS[0];
  const availableModes = (Object.keys(brand.modes) as ProviderBrandMode[]);
  const [mode, setMode] = useState<ProviderBrandMode>(() => {
    const activeMode = availableModes.find((candidate) => brand.modes[candidate] === activeProvider?.id);
    return activeMode ?? availableModes[0];
  });
  const effectiveMode = availableModes.includes(mode) ? mode : availableModes[0];
  const providerId = brand.modes[effectiveMode]!;
  const provider = providers.find((entry) => entry.id === providerId);

  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [model, setModel] = useState(provider?.model ?? '');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffortSetting>(provider?.reasoningEffort ?? 'auto');
  const [busy, setBusy] = useState(false);
  const [activeTest, setActiveTest] = useState<{ state: 'idle' | 'testing' | 'done'; ok?: boolean; message?: string; seconds?: string }>({ state: 'idle' });

  // Re-seed the form whenever the concrete provider changes.
  useEffect(() => {
    setApiKey('');
    setBaseUrl(provider?.baseUrl ?? '');
    setModel(provider?.model ?? '');
    setReasoningEffort(provider?.reasoningEffort ?? 'auto');
  }, [providerId, provider?.baseUrl, provider?.model, provider?.reasoningEffort]);

  const testActive = async () => {
    if (!activeProvider) return;
    setActiveTest({ state: 'testing' });
    const started = Date.now();
    const result = await api.testProviderSettings(activeProvider.id, {});
    const ok = result.ok !== false;
    setActiveTest({ state: 'done', ok, message: result.message, seconds: ((Date.now() - started) / 1000).toFixed(1) });
  };

  const makeActive = async () => {
    setBusy(true);
    try {
      const result = await api.saveProviderSettings({
        id: providerId,
        enabled: true,
        apiKey: apiKey || undefined,
        baseUrl,
        model,
        reasoningEffort,
      });
      onSaved(result.providers);
      onStatus(`${brand.label} is now the active provider.`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleOAuthConnected = async (defaultModel: string) => {
    const chosen = model || defaultModel;
    setModel(chosen);
    try {
      const result = await api.saveProviderSettings({ id: providerId, enabled: true, model: chosen });
      onSaved(result.providers);
      onStatus(`${brand.label} connected and activated.`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const fieldLabel: React.CSSProperties = { fontSize: 11, fontWeight: 650, color: t.textSecondary };
  const input: React.CSSProperties = { ...inputStyle(t), borderRadius: 8 };
  const footnote = effectiveMode === 'subscription'
    ? 'Uses your existing plan through the provider’s sign-in — nothing billed per token.'
    : effectiveMode === 'local'
      ? 'Everything runs on this machine — no data leaves your network.'
      : 'Keys stay in .dql/ and are never returned raw.';

  return (
    <div style={{ width: 'min(640px, 100%)', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 700, color: t.textPrimary }}>AI provider</div>
        <div style={{ fontSize: 12.5, color: t.textMuted, marginTop: 3, lineHeight: 1.5 }}>
          One provider powers governed answers, block suggestions, and research. Keys stay in <span style={{ fontFamily: t.fontMono, fontSize: 11.5 }}>.dql/</span> — never returned raw.
        </div>
      </div>

      {/* active provider status card */}
      {activeProvider ? (
        <div style={{ border: '1px solid var(--status-success-border)', borderRadius: 12, background: t.cellBg, padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ width: 36, height: 36, borderRadius: 9, background: 'var(--status-success-bg)', color: 'var(--status-success)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Sparkles size={17} strokeWidth={1.75} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary }}>
              Active · {activeProvider.label}{activeProvider.model ? ` — ${activeProvider.model}` : ''}
            </div>
            <div style={{ fontSize: 11.5, color: activeTest.state === 'done' && activeTest.ok === false ? 'var(--status-error)' : 'var(--status-success)', marginTop: 2 }}>
              {activeTest.state === 'testing' ? 'Testing…'
                : activeTest.state === 'done'
                  ? (activeTest.ok ? `Test passed · ${activeTest.seconds}s` : (activeTest.message || 'Test failed'))
                  : (activeProvider.source === 'env' ? 'Configured from environment' : 'Connected and ready')}
            </div>
          </div>
          <button type="button" onClick={() => void testActive()} disabled={activeTest.state === 'testing'} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 13px', borderRadius: 8, border: `1px solid ${t.headerBorder}`, background: t.cellBg, color: t.textSecondary, fontSize: 12, fontWeight: 650, cursor: 'pointer', fontFamily: t.font, flexShrink: 0 }}>
            {activeTest.state === 'testing' ? 'Testing…' : 'Test'}
          </button>
        </div>
      ) : null}

      {/* single provider form */}
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, background: t.cellBg, padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabel}>Provider</span>
            <select value={brand.key} onChange={(event) => { setBrandKey(event.target.value); setMode('subscription'); }} style={input}>
              {PROVIDER_BRANDS.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabel}>Model</span>
            <input value={model} onChange={(event) => setModel(event.target.value)} placeholder={provider?.model || 'Default model'} style={input} />
          </label>
        </div>

        <div>
          <span style={{ ...fieldLabel, display: 'block', marginBottom: 6 }}>How do you want to connect?</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {availableModes.map((candidate) => {
              const selected = candidate === effectiveMode;
              return (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => setMode(candidate)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 9, border: `1.5px solid ${selected ? t.accent : t.headerBorder}`, background: selected ? 'var(--accent-dim)' : t.cellBg, cursor: 'pointer', fontFamily: t.font, textAlign: 'left' }}
                >
                  <span style={{ width: 13, height: 13, borderRadius: 999, border: `1.5px solid ${selected ? t.accent : 'var(--border-strong)'}`, background: selected ? t.accent : t.cellBg, boxShadow: selected ? `inset 0 0 0 2.5px ${t.cellBg}` : 'none', flexShrink: 0 }} />
                  <span style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: 12, fontWeight: 650, color: t.textPrimary }}>{MODE_COPY[candidate].label}</span>
                    <span style={{ fontSize: 10, color: t.textMuted }}>{MODE_COPY[candidate].hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {effectiveMode === 'subscription' && provider ? (
          <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 9, background: 'var(--bg-1)', padding: '11px 13px' }}>
            <SubscriptionOAuthPanel
              oauthProvider={oauthProviderFor(providerId)}
              label={provider.label}
              model={model}
              setModel={setModel}
              cliStatus={cliStatus[providerId]}
              command={provider.command}
              loginCmd={providerId === 'claude-code' ? '/login' : 'login'}
              t={t}
              onStatus={onStatus}
              onConnected={handleOAuthConnected}
            />
          </div>
        ) : null}

        {effectiveMode === 'api' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={fieldLabel}>API key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={provider?.hasApiKey ? 'Leave blank to keep existing key' : 'API key'}
                style={{ ...input, fontFamily: t.fontMono }}
              />
            </label>
            {provider?.envVars?.[0] ? (
              <span style={{ fontSize: 10.5, color: t.textMuted, paddingBottom: 9 }}>or set <span style={{ fontFamily: t.fontMono }}>{provider.envVars[0]}</span></span>
            ) : null}
            {providerId === 'custom-openai' ? (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: '1 / -1' }}>
                <span style={fieldLabel}>Gateway base URL</span>
                <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={baseUrlPlaceholder(providerId)} style={{ ...input, fontFamily: t.fontMono }} />
              </label>
            ) : null}
            {provider?.supportsReasoningEffort ? (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: '1 / -1' }}>
                <span style={fieldLabel}>Reasoning effort</span>
                <select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffortSetting)} style={input}>
                  <option value="auto">Auto — pick per task (up to High)</option>
                  <option value="low">Low — fastest, cheapest</option>
                  <option value="medium">Medium</option>
                  <option value="high">High — deepest reasoning</option>
                </select>
              </label>
            ) : null}
          </div>
        ) : null}

        {effectiveMode === 'local' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={fieldLabel}>Host</span>
              <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://localhost:11434" style={{ ...input, fontFamily: t.fontMono }} />
            </label>
            <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 2 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: provider?.enabled ? 'var(--status-success)' : t.textMuted }}>
                <span style={{ width: 7, height: 7, borderRadius: 999, background: provider?.enabled ? 'var(--status-success)' : 'var(--border-strong)' }} />
                {provider?.enabled ? 'Ollama configured' : 'Point at your Ollama host'}
              </span>
            </div>
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4, borderTop: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: 10.5, color: t.textMuted, flex: 1 }}>{footnote}</span>
          <button type="button" onClick={() => void makeActive()} disabled={busy} style={{ height: 30, padding: '0 15px', borderRadius: 8, border: 'none', background: t.accent, color: '#fff', fontSize: 12, fontWeight: 650, cursor: 'pointer', fontFamily: t.font, boxShadow: '0 1px 4px rgba(107,93,211,0.25)', opacity: busy ? 0.7 : 1 }}>
            {busy ? 'Saving…' : 'Make active provider'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  cliStatus,
  t,
  onSaved,
  onStatus,
}: {
  provider: ProviderSettings;
  cliStatus?: ProviderCliStatus;
  t: Theme;
  onSaved: (providers: ProviderSettings[]) => void;
  onStatus: (message: string | null) => void;
}) {
  const [enabled, setEnabled] = useState(provider.enabled);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '');
  const [model, setModel] = useState(provider.model ?? '');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffortSetting>(provider.reasoningEffort ?? 'auto');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const isSubscription = provider.authMode === 'subscription_cli';
  const loginCmd = provider.id === 'claude-code' ? '/login' : 'login';
  // Show the reasoning-effort control only for reasoning-capable models.
  const showReasoning = provider.supportsReasoningEffort === true && !isSubscription && provider.id !== 'ollama';

  useEffect(() => {
    setEnabled(provider.enabled);
    setBaseUrl(provider.baseUrl ?? '');
    setModel(provider.model ?? '');
    setReasoningEffort(provider.reasoningEffort ?? 'auto');
    setApiKey('');
    setTestResult(null);
  }, [provider.id, provider.enabled, provider.baseUrl, provider.model, provider.reasoningEffort]);

  const save = async () => {
    setBusy(true);
    try {
      const result = await api.saveProviderSettings({
        id: provider.id,
        enabled,
        apiKey: apiKey || undefined,
        baseUrl,
        model,
        reasoningEffort,
      });
      onSaved(result.providers);
      onStatus(`${provider.label} settings saved.`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    // Test exactly what's in the form (key/base URL/model) so it works before Save.
    const result = await api.testProviderSettings(provider.id, {
      apiKey: apiKey || undefined,
      baseUrl: baseUrl || undefined,
      model: model || undefined,
    });
    const ok = result.ok !== false;
    setTestResult({
      ok,
      message: result.message || (ok ? `${provider.label} is reachable.` : `${provider.label} test failed.`),
    });
    setTesting(false);
  };

  // On a successful subscription sign-in: enable + activate this provider with the
  // subscription's default model, so it's ready to use with no extra Save click.
  const handleOAuthConnected = async (defaultModel: string) => {
    const chosen = model || defaultModel;
    setModel(chosen);
    setEnabled(true);
    try {
      const result = await api.saveProviderSettings({ id: provider.id, enabled: true, model: chosen });
      onSaved(result.providers);
      onStatus(`${provider.label} connected and activated.`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.cellBg, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{provider.label}</div>
            {provider.active ? <span style={activeBadgeStyle(t)}>Active</span> : null}
          </div>
          <div style={{ fontSize: 11, color: t.textSecondary, marginTop: 3 }}>
            {provider.source === 'local' ? 'Project local' : provider.source === 'env' ? 'Environment' : 'Not configured'}
            {provider.apiKeyPreview ? ` · ${provider.apiKeyPreview}` : ''}
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: t.textSecondary }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
      </div>

      <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
        {isSubscription ? (
          <SubscriptionOAuthPanel
            oauthProvider={oauthProviderFor(provider.id)}
            label={provider.label}
            model={model}
            setModel={setModel}
            cliStatus={cliStatus}
            command={provider.command}
            loginCmd={loginCmd}
            t={t}
            onStatus={onStatus}
            onConnected={handleOAuthConnected}
          />
        ) : (
          <>
            {provider.id !== 'ollama' && (
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                type="password"
                placeholder={provider.hasApiKey ? 'Leave blank to keep existing key' : 'API key'}
                style={inputStyle(t)}
              />
            )}
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={baseUrlPlaceholder(provider.id)}
              style={inputStyle(t)}
            />
          </>
        )}
        {!isSubscription && (
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Default model"
            style={inputStyle(t)}
          />
        )}
        {showReasoning && (
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>Reasoning effort</label>
            <select
              value={reasoningEffort}
              onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffortSetting)}
              style={inputStyle(t)}
            >
              <option value="auto">Auto — pick per task (up to High)</option>
              <option value="low">Low — fastest, cheapest</option>
              <option value="medium">Medium</option>
              <option value="high">High — deepest reasoning</option>
            </select>
            <div style={{ fontSize: 11, color: t.textSecondary, lineHeight: 1.4 }}>
              {reasoningEffort === 'auto'
                ? 'The agent spends more reasoning on SQL generation, gates, and repairs, and less on chat.'
                : `Caps every request at ${reasoningEffort} reasoning.`}
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" onClick={save} disabled={busy || testing} style={buttonStyle(t, true)}>
          {provider.active ? 'Save active provider' : 'Save and use'}
        </button>
        <button type="button" onClick={test} disabled={busy || testing} style={buttonStyle(t, false)}>
          {testing ? 'Testing…' : 'Test'}
        </button>
      </div>

      {testResult && (
        <div
          role="status"
          style={{
            marginTop: 10,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 7,
            fontSize: 12,
            lineHeight: 1.45,
            padding: '8px 10px',
            borderRadius: 7,
            color: testResult.ok ? t.success : t.error,
            background: `${testResult.ok ? t.success : t.error}12`,
            border: `1px solid ${testResult.ok ? t.success : t.error}40`,
          }}
        >
          <span style={{ flexShrink: 0, fontWeight: 700 }}>{testResult.ok ? '✓' : '✗'}</span>
          <span>{testResult.message}</span>
        </div>
      )}

      {provider.envVars.length > 0 && (
        <div style={{ marginTop: 10, color: t.textSecondary, fontSize: 11, lineHeight: 1.4 }}>
          Env: {provider.envVars.join(', ')}
        </div>
      )}
    </section>
  );
}

function MemoryEditor({
  memories,
  t,
  onChange,
  onStatus,
}: {
  memories: AgentMemory[];
  t: Theme;
  onChange: (memories: AgentMemory[]) => void;
  onStatus: (message: string | null) => void;
}) {
  const [scope, setScope] = useState<AgentMemory['scope']>('project');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');

  const refresh = async () => {
    const result = await api.listAgentMemory();
    onChange(result.memories);
  };

  const save = async () => {
    if (!title.trim() || !content.trim()) return;
    await api.saveAgentMemory({
      scope,
      title,
      content,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      source: 'settings-ui',
      confidence: 0.8,
      importance: scope === 'project' ? 0.7 : 0.5,
      enabled: true,
    });
    setTitle('');
    setContent('');
    setTags('');
    await refresh();
    onStatus('Memory saved.');
  };

  const ensureFiles = async () => {
    const result = await api.ensureAgentMemoryFiles();
    onStatus(`Memory files ready: ${result.files.join(', ')}`);
  };

  const remove = async (id: string) => {
    await api.deleteAgentMemory(id);
    await refresh();
    onStatus('Memory deleted.');
  };

  // ── Prototype layout: scope filter tabs · Add memory · cards · info card ──
  const [formOpen, setFormOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'project' | 'me'>('all');
  const [editingId, setEditingId] = useState<string | null>(null);

  const scopeBadge = (memoryScope: AgentMemory['scope']): { label: string; bg: string; color: string } => {
    if (memoryScope === 'project') return { label: 'project', bg: 'var(--accent-dim)', color: t.accent };
    if (memoryScope === 'user') return { label: 'just me', bg: `${t.textMuted}1f`, color: t.textMuted };
    return { label: memoryScope, bg: 'var(--status-success-bg)', color: 'var(--status-success)' };
  };
  const visible = memories.filter((memory) =>
    filter === 'all' ? true : filter === 'project' ? memory.scope === 'project' : memory.scope === 'user');

  const startEdit = (memory: AgentMemory) => {
    setEditingId(memory.id);
    setScope(memory.scope);
    setTitle(memory.title);
    setContent(memory.content);
    setTags(memory.tags.join(', '));
    setFormOpen(true);
  };
  const closeForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setTitle('');
    setContent('');
    setTags('');
  };
  const saveFromForm = async () => {
    if (!content.trim()) return;
    // The prototype captures a single sentence — derive the title from it.
    if (!title.trim()) setTitle(content.trim().slice(0, 60));
    const effectiveTitle = title.trim() || content.trim().slice(0, 60);
    await api.saveAgentMemory({
      scope,
      title: effectiveTitle,
      content,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      source: 'settings-ui',
      confidence: 0.8,
      importance: scope === 'project' ? 0.7 : 0.5,
      enabled: true,
    });
    // Editing = replace: save the new version, then retire the old entry.
    if (editingId) await api.deleteAgentMemory(editingId).catch(() => undefined);
    closeForm();
    await refresh();
    onStatus(editingId ? 'Memory updated.' : 'Memory saved.');
  };

  const filterTab = (key: 'all' | 'project' | 'me', label: string) => (
    <button
      key={key}
      type="button"
      onClick={() => setFilter(key)}
      style={{ border: 'none', borderRadius: 5, padding: '4px 11px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: t.font, background: filter === key ? 'var(--accent-dim)' : 'transparent', color: filter === key ? t.accent : t.textMuted }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ width: 'min(640px, 100%)', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, border: `1px solid ${t.headerBorder}`, borderRadius: 7, background: t.cellBg }}>
          {filterTab('all', 'All')}
          {filterTab('project', 'Project')}
          {filterTab('me', 'Just me')}
        </div>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={() => (formOpen ? closeForm() : setFormOpen(true))} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 13px', borderRadius: 8, border: 'none', background: t.accent, color: '#fff', fontSize: 12, fontWeight: 650, cursor: 'pointer', fontFamily: t.font, boxShadow: '0 1px 4px rgba(107,93,211,0.25)' }}>
          + Add memory
        </button>
      </div>

      {formOpen ? (
        <div style={{ border: `1px solid ${t.accent}4d`, borderRadius: 12, background: t.cellBg, padding: '15px 17px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <textarea
            rows={2}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="e.g. Fiscal quarters start in February. 'Sales' means recognized revenue unless someone says bookings."
            style={{ ...inputStyle(t), borderRadius: 8, resize: 'vertical', lineHeight: 1.55 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: t.textSecondary }}>
              Scope
              <select value={scope} onChange={(e) => setScope(e.target.value as AgentMemory['scope'])} style={{ ...inputStyle(t), width: 'auto', borderRadius: 7, padding: '5px 7px' }}>
                <option value="project">Project</option>
                <option value="user">Just me</option>
                <option value="artifact">Artifact note</option>
                <option value="notebook">Notebook context</option>
                <option value="thread">Thread summary</option>
              </select>
            </label>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags (optional)" style={{ ...inputStyle(t), width: 160, borderRadius: 7, padding: '5px 8px' }} />
            <div style={{ flex: 1 }} />
            <button type="button" onClick={closeForm} style={{ height: 28, padding: '0 12px', borderRadius: 7, border: `1px solid ${t.headerBorder}`, background: t.cellBg, color: t.textSecondary, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: t.font }}>Cancel</button>
            <button type="button" onClick={() => void saveFromForm()} disabled={!content.trim()} style={{ height: 28, padding: '0 13px', borderRadius: 7, border: 'none', background: t.accent, color: '#fff', fontSize: 11.5, fontWeight: 650, cursor: 'pointer', fontFamily: t.font, opacity: content.trim() ? 1 : 0.6 }}>
              {editingId ? 'Update memory' : 'Save memory'}
            </button>
          </div>
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {visible.length === 0 ? (
          <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 11, background: t.cellBg, padding: '13px 15px', fontSize: 12, color: t.textSecondary, lineHeight: 1.5 }}>
            No memory yet. Add business context by hand, or correct/certify a draft and the agent will remember it here automatically.
          </div>
        ) : visible.slice(0, 30).map((memory) => {
          const learned = !['settings-ui', 'manual', ''].includes(memory.source);
          const badge = scopeBadge(memory.scope);
          const meta = learned
            ? `Learned from ${memory.source}${typeof memory.confidence === 'number' ? ` · ${Math.round(memory.confidence * 100)}% confidence` : ''}`
            : `Added by hand${memory.tags.length ? ` · ${memory.tags.join(', ')}` : ''}`;
          return (
            <div key={memory.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 11, background: t.cellBg, padding: '13px 15px', display: 'flex', gap: 11, alignItems: 'flex-start' }}>
              <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '2.5px 7px', borderRadius: 5, marginTop: 1, background: badge.bg, color: badge.color }}>{badge.label}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: t.textPrimary, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                  {memory.content || memory.title}
                </div>
                <div style={{ fontSize: 10.5, color: t.textMuted, marginTop: 4 }}>{meta}</div>
              </div>
              <button type="button" title="Edit" onClick={() => startEdit(memory)} style={{ flexShrink: 0, width: 25, height: 25, borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--bg-1)', color: t.textMuted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 11 }}>✎</button>
              <button type="button" title="Stop using" onClick={() => void remove(memory.id)} style={{ flexShrink: 0, width: 25, height: 25, borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--bg-1)', color: t.textMuted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 11 }}>🗑</button>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', border: '1px solid var(--border-subtle)', background: t.cellBg, borderRadius: 10, padding: '11px 13px' }}>
        <span style={{ fontSize: 11.5, color: t.textMuted, lineHeight: 1.55 }}>
          Memories are Git-backed files under <span style={{ fontFamily: t.fontMono, fontSize: 10.5 }}>.dql/memory/</span>. The agent also proposes new ones when you correct or certify a draft — they appear here for review.
          {' '}<button type="button" onClick={() => void ensureFiles()} style={{ border: 'none', background: 'none', color: t.accent, cursor: 'pointer', padding: 0, fontSize: 11.5, fontFamily: t.font }}>Prepare files</button>
        </span>
      </div>
    </div>
  );
}

function EnvGroupCard({ group, t }: { group: SettingsEnvGroup; t: Theme }) {
  return (
    <section style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.cellBg, overflow: 'hidden' }}>
      <div style={{ padding: '14px 14px 10px', borderBottom: `1px solid ${t.headerBorder}` }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{group.title}</div>
        <div style={{ color: t.textSecondary, fontSize: 12, lineHeight: 1.45, marginTop: 4 }}>{group.description}</div>
      </div>
      {group.vars.map((item) => (
        <div key={item.key} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, padding: '11px 14px', borderBottom: `1px solid ${t.headerBorder}` }}>
          <div style={{ minWidth: 0 }}>
            <code style={{ fontSize: 12, color: t.textPrimary }}>{item.key}</code>
            <div style={{ color: t.textSecondary, fontSize: 12, lineHeight: 1.4, marginTop: 4 }}>{item.description}</div>
          </div>
          <StatusPill present={item.present} />
        </div>
      ))}
    </section>
  );
}

function SectionTitle({ title, detail, t }: { title: string; detail: string; t: Theme }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 3 }}>{detail}</div>
    </div>
  );
}

function SummaryCard({
  configured,
  total,
  activeLabel,
  t,
}: {
  configured: number;
  total: number;
  activeLabel?: string;
  t: Theme;
}) {
  return (
    <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, padding: '10px 12px', minWidth: 160, textAlign: 'right', background: t.cellBg }}>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{configured}/{total}</div>
      <div style={{ fontSize: 12, color: t.textSecondary }}>providers ready</div>
      <div style={{ fontSize: 11, color: activeLabel ? t.accent : t.textMuted, marginTop: 4 }}>
        {activeLabel ? `${activeLabel} active` : 'No active provider'}
      </div>
    </div>
  );
}

function StatusPill({ present }: { present: boolean }) {
  return (
    <span style={{ alignSelf: 'start', fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '3px 8px', color: present ? '#12613a' : '#7a4a00', background: present ? '#d9f8e6' : '#fff0cc', whiteSpace: 'nowrap' }}>
      {present ? 'Set' : 'Optional'}
    </span>
  );
}

function inputStyle(t: Theme): React.CSSProperties {
  return {
    minHeight: 32,
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 6,
    background: t.appBg,
    color: t.textPrimary,
    padding: '7px 9px',
    fontSize: 12,
    fontFamily: t.font,
  };
}

function buttonStyle(t: Theme, primary: boolean): React.CSSProperties {
  return {
    height: 30,
    border: `1px solid ${primary ? t.accent : t.headerBorder}`,
    background: primary ? `${t.accent}24` : t.appBg,
    color: primary ? t.accent : t.textPrimary,
    borderRadius: 6,
    padding: '0 10px',
    cursor: 'pointer',
    fontSize: 12,
  };
}

function segmentedButtonStyle(t: Theme, active: boolean): React.CSSProperties {
  return {
    height: 28,
    border: 0,
    borderRight: `1px solid ${t.headerBorder}`,
    background: active ? `${t.accent}18` : t.appBg,
    color: active ? t.accent : t.textSecondary,
    padding: '0 10px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: active ? 700 : 500,
  };
}

function activeBadgeStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.accent}44`,
    background: `${t.accent}16`,
    color: t.accent,
    borderRadius: 999,
    padding: '2px 7px',
    fontSize: 10,
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: 0,
  };
}

function checkboxLabelStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 12,
    color: t.textSecondary,
  };
}

function splitCsv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function entriesToMcpConfigJson(entries: RemoteMcpEntry[]): string {
  const servers = entries
    .filter((entry) => entry.kind !== 'connector')
    .map((entry) => compactMcpJson({
      name: entry.name,
      url: entry.url,
      description: entry.description,
      authorizationToken: entry.authorizationToken,
      authorizationTokenEnv: entry.authorizationTokenEnv,
      allowedTools: entry.allowedTools,
      enabled: entry.enabled,
      trusted: entry.trusted,
      deferLoading: entry.deferLoading,
      providers: normalizeMcpEntry(entry).providers,
    }));
  const connectors = entries
    .filter((entry) => entry.kind === 'connector')
    .map((entry) => compactMcpJson({
      name: entry.name,
      connectorId: entry.connectorId,
      description: entry.description,
      authorizationToken: entry.authorizationToken,
      authorizationTokenEnv: entry.authorizationTokenEnv,
      allowedTools: entry.allowedTools,
      enabled: entry.enabled,
      trusted: entry.trusted,
      deferLoading: entry.deferLoading,
      providers: ['openai'],
    }));
  return JSON.stringify({ version: 1, servers, connectors }, null, 2);
}

function parseMcpConfigJson(value: string): RemoteMcpEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error('MCP config must be a JSON object.');

  const entries: RemoteMcpEntry[] = [];
  if (Array.isArray(parsed.servers)) {
    entries.push(...parsed.servers.map((entry, index) => parseMcpEntry(entry, 'server', `servers[${index}]`)));
  }
  if (Array.isArray(parsed.connectors)) {
    entries.push(...parsed.connectors.map((entry, index) => parseMcpEntry(entry, 'connector', `connectors[${index}]`)));
  }
  if (Array.isArray(parsed.tools)) {
    entries.push(...parseOpenAiMcpTools(parsed.tools));
  }
  if (Array.isArray(parsed.mcp_servers)) {
    entries.push(...parseAnthropicMcpServersArray(parsed.mcp_servers));
  }
  if (isRecord(parsed.mcpServers)) {
    entries.push(...parseRemoteMcpServersObject(parsed.mcpServers));
  }
  return entries.map(normalizeMcpEntry);
}

function parseOpenAiMcpTools(tools: unknown[]): RemoteMcpEntry[] {
  return tools.flatMap((tool, index) => {
    if (!isRecord(tool) || tool.type !== 'mcp') return [];
    const connectorId = stringField(tool, ['connectorId', 'connector_id']);
    const authorization = stringField(tool, ['authorization']);
    if (connectorId) {
      return [normalizeMcpEntry({
        kind: 'connector',
        name: stringField(tool, ['name', 'server_label', 'serverLabel']) ?? connectorId,
        connectorId,
        authorizationToken: authorization,
        allowedTools: stringArrayField(tool, ['allowedTools', 'allowed_tools']),
        enabled: true,
        trusted: tool.trusted === true || tool.require_approval === 'never',
        providers: ['openai'],
      })];
    }
    return [parseMcpEntry({
      ...tool,
      name: stringField(tool, ['name', 'server_label', 'serverLabel']),
      url: stringField(tool, ['url', 'server_url', 'serverUrl']),
      authorizationToken: authorization ?? bearerTokenFromHeaders(tool.headers),
      allowedTools: stringArrayField(tool, ['allowedTools', 'allowed_tools']),
      enabled: true,
      trusted: tool.trusted === true || tool.require_approval === 'never',
      providers: ['openai'],
    }, 'server', `tools[${index}]`)];
  });
}

function parseAnthropicMcpServersArray(servers: unknown[]): RemoteMcpEntry[] {
  return servers.map((server, index) => {
    const entry = parseMcpEntry(server, 'server', `mcp_servers[${index}]`);
    return normalizeMcpEntry({
      ...entry,
      authorizationToken: entry.authorizationToken ?? (isRecord(server) ? stringField(server, ['authorization_token']) : undefined),
      providers: ['anthropic'],
    });
  });
}

function parseRemoteMcpServersObject(servers: Record<string, unknown>): RemoteMcpEntry[] {
  return Object.entries(servers).map(([name, raw]) => {
    if (!isRecord(raw)) throw new Error(`mcpServers.${name} must be an object.`);
    const url = stringField(raw, ['url', 'server_url', 'serverUrl']);
    if (!url) {
      throw new Error(`mcpServers.${name} is not a remote HTTP MCP server. App chat SDK config only supports URL-based MCP servers.`);
    }
    return normalizeMcpEntry({
      kind: 'server',
      name,
      url,
      authorizationToken: bearerTokenFromHeaders(raw.headers),
      enabled: raw.enabled !== false,
      trusted: raw.trusted === true,
      allowedTools: stringArrayField(raw, ['allowedTools', 'allowed_tools']),
      providers: providerArrayField(raw, ['providers']) ?? ['openai', 'anthropic'],
    });
  });
}

function parseMcpEntry(raw: unknown, kind: 'server' | 'connector', label: string): RemoteMcpEntry {
  if (!isRecord(raw)) throw new Error(`${label} must be an object.`);
  const name = stringField(raw, ['name', 'server_label', 'serverLabel']);
  if (!name) throw new Error(`${label} needs a name.`);
  const url = stringField(raw, ['url', 'server_url', 'serverUrl']);
  const connectorId = stringField(raw, ['connectorId', 'connector_id']);
  if (kind === 'server' && !url) throw new Error(`${label} needs a url.`);
  if (kind === 'connector' && !connectorId) throw new Error(`${label} needs a connectorId.`);
  return {
    kind,
    name,
    url,
    connectorId,
    description: stringField(raw, ['description', 'server_description', 'serverDescription']),
    authorizationToken: stringField(raw, ['authorizationToken', 'authorization', 'authorization_token']) ?? bearerTokenFromHeaders(raw.headers),
    authorizationTokenEnv: stringField(raw, ['authorizationTokenEnv', 'authorizationEnv', 'authorization_token_env']),
    allowedTools: stringArrayField(raw, ['allowedTools', 'allowed_tools']),
    enabled: raw.enabled !== false,
    trusted: raw.trusted === true,
    deferLoading: raw.deferLoading === true || raw.defer_loading === true,
    providers: providerArrayField(raw, ['providers']),
  };
}

function compactMcpJson(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => {
    if (value === undefined || value === null || value === '') return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function stringArrayField(input: Record<string, unknown>, keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = input[key];
    if (Array.isArray(value)) {
      const out = value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
      return out.length ? Array.from(new Set(out)) : undefined;
    }
  }
  return undefined;
}

function providerArrayField(input: Record<string, unknown>, keys: string[]): Array<'openai' | 'anthropic'> | undefined {
  const values = stringArrayField(input, keys);
  if (!values) return undefined;
  const providers = values.filter((item): item is 'openai' | 'anthropic' => item === 'openai' || item === 'anthropic');
  return providers.length ? providers : undefined;
}

function bearerTokenFromHeaders(headers: unknown): string | undefined {
  if (!isRecord(headers)) return undefined;
  const authorization = stringField(headers, ['Authorization', 'authorization']);
  return authorization?.replace(/^Bearer\s+/i, '').trim() || undefined;
}

function toggleMcpProvider(
  providers: RemoteMcpEntry['providers'],
  provider: 'openai' | 'anthropic',
  checked: boolean,
): Array<'openai' | 'anthropic'> {
  const next = new Set(providers ?? []);
  if (checked) next.add(provider);
  else next.delete(provider);
  return Array.from(next);
}

function normalizeMcpEntry(entry: RemoteMcpEntry): RemoteMcpEntry {
  const providers: Array<'openai' | 'anthropic'> = entry.kind === 'connector'
    ? ['openai']
    : entry.providers?.length ? entry.providers : ['openai', 'anthropic'];
  return {
    ...entry,
    providers,
    allowedTools: entry.allowedTools?.filter(Boolean),
  };
}
