import React, { useEffect, useMemo, useState } from 'react';
import {
  api,
  type AgentMemory,
  type ProviderSettings,
  type ProviderSettingsId,
  type RemoteMcpEntry,
  type RemoteMcpSettings,
  type SettingsEnvGroup,
} from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';

const PROVIDER_ORDER: ProviderSettingsId[] = ['anthropic', 'openai', 'gemini', 'ollama', 'custom-openai'];

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
}: {
  includeMemory?: boolean;
  embedded?: boolean;
}) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const [groups, setGroups] = useState<SettingsEnvGroup[]>([]);
  const [providers, setProviders] = useState<ProviderSettings[]>([]);
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

  const configured = useMemo(() => providers.filter((p) => p.enabled && (p.hasApiKey || p.id === 'ollama')).length, [providers]);
  const activeProvider = providers.find((provider) => provider.active);

  return (
    <div style={{ padding: embedded ? 0 : 24, maxWidth: embedded ? undefined : 1180 }}>
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

      {status && (
        <div style={{ marginTop: 14, border: `1px solid ${t.headerBorder}`, borderRadius: 8, padding: '10px 12px', fontSize: 12, color: t.textSecondary, background: t.cellBg }}>
          {status}
        </div>
      )}

      {loading ? (
        <div style={{ marginTop: 24, color: t.textSecondary }}>Loading settings...</div>
      ) : (
        <>
          <section style={{ marginTop: 22 }}>
            <SectionTitle title="Model providers" detail="Use environment variables or save project-local provider settings for OpenAI, Anthropic, Gemini, Ollama, or compatible endpoints." t={t} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
              {PROVIDER_ORDER.map((id) => {
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

          {includeMemory && (
            <section style={{ marginTop: 22 }}>
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

function ProviderCard({
  provider,
  t,
  onSaved,
  onStatus,
}: {
  provider: ProviderSettings;
  t: Theme;
  onSaved: (providers: ProviderSettings[]) => void;
  onStatus: (message: string | null) => void;
}) {
  const [enabled, setEnabled] = useState(provider.enabled);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '');
  const [model, setModel] = useState(provider.model ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEnabled(provider.enabled);
    setBaseUrl(provider.baseUrl ?? '');
    setModel(provider.model ?? '');
    setApiKey('');
  }, [provider.id, provider.enabled, provider.baseUrl, provider.model]);

  const save = async () => {
    setBusy(true);
    try {
      const result = await api.saveProviderSettings({
        id: provider.id,
        enabled,
        apiKey: apiKey || undefined,
        baseUrl,
        model,
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
    setBusy(true);
    try {
      const result = await api.testProviderSettings(provider.id);
      onStatus(result.message);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
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
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Default model"
          style={inputStyle(t)}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" onClick={save} disabled={busy} style={buttonStyle(t, true)}>
          {provider.active ? 'Save active provider' : 'Save and use'}
        </button>
        <button type="button" onClick={test} disabled={busy} style={buttonStyle(t, false)}>Test</button>
      </div>

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

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
      <section style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.cellBg, padding: 14 }}>
        <div style={{ display: 'grid', gap: 8 }}>
          <select value={scope} onChange={(e) => setScope(e.target.value as AgentMemory['scope'])} style={inputStyle(t)}>
            <option value="project">Project context</option>
            <option value="user">User preference</option>
            <option value="artifact">Artifact note</option>
            <option value="notebook">Notebook context</option>
            <option value="thread">Thread summary</option>
          </select>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Memory title" style={inputStyle(t)} />
          <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="Business context, glossary term, rule, or analyst correction" rows={5} style={{ ...inputStyle(t), resize: 'vertical' }} />
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags, comma separated" style={inputStyle(t)} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="button" onClick={save} disabled={!title.trim() || !content.trim()} style={buttonStyle(t, true)}>Save Memory</button>
          <button type="button" onClick={ensureFiles} style={buttonStyle(t, false)}>Create .dql/memory</button>
        </div>
      </section>

      <section style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.cellBg, overflow: 'hidden' }}>
        {memories.length === 0 ? (
          <div style={{ padding: 14, color: t.textSecondary, fontSize: 12 }}>
            No memory yet. Add business context by hand, or correct/certify a draft and the agent will
            remember it here automatically.
          </div>
        ) : memories.slice(0, 20).map((memory) => {
          const learned = !['settings-ui', 'manual', ''].includes(memory.source);
          return (
            <div key={memory.id} style={{ padding: 12, borderBottom: `1px solid ${t.headerBorder}` }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, fontFamily: t.fontMono, color: t.accent, textTransform: 'uppercase' }}>{memory.scope}</span>
                <strong style={{ fontSize: 13 }}>{memory.title}</strong>
                <span
                  title={learned ? `Learned from ${memory.source}` : 'Added by hand'}
                  style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: learned ? `${t.accent}1f` : `${t.textMuted}1f`, color: learned ? t.accent : t.textMuted }}
                >
                  {learned ? 'learned' : 'manual'}
                </span>
                {typeof memory.confidence === 'number' && (
                  <span style={{ fontSize: 10, color: t.textMuted }}>{Math.round(memory.confidence * 100)}%</span>
                )}
                <button type="button" onClick={() => remove(memory.id)} style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: t.textMuted, cursor: 'pointer' }}>Delete</button>
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: t.textSecondary, whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{memory.content}</div>
              {memory.tags.length > 0 && <div style={{ marginTop: 6, fontSize: 11, color: t.textMuted }}>{memory.tags.join(', ')}</div>}
            </div>
          );
        })}
      </section>
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
