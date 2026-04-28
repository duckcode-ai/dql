import React, { useEffect, useMemo, useState } from 'react';
import {
  api,
  type AgentMemory,
  type ProviderSettings,
  type ProviderSettingsId,
  type SettingsEnvGroup,
} from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';

const PROVIDER_ORDER: ProviderSettingsId[] = ['anthropic', 'openai', 'gemini', 'ollama', 'custom-openai'];

export function SettingsPage() {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const [groups, setGroups] = useState<SettingsEnvGroup[]>([]);
  const [providers, setProviders] = useState<ProviderSettings[]>([]);
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [env, providerRes, memoryRes] = await Promise.all([
        api.getSettingsEnvStatus(),
        api.getProviderSettings(),
        api.listAgentMemory(),
      ]);
      setGroups(env.groups);
      setProviders(providerRes.providers);
      setMemories(memoryRes.memories);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const configured = useMemo(() => providers.filter((p) => p.enabled && (p.hasApiKey || p.id === 'ollama')).length, [providers]);

  return (
    <div style={{ padding: 24, maxWidth: 1180 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>AI & Memory Settings</div>
          <div style={{ color: t.textSecondary, fontSize: 13, marginTop: 6, lineHeight: 1.5, maxWidth: 820 }}>
            Configure local AI providers and the project memory used by governed analytics chat. Secrets stay under <code>.dql/</code> and are never returned raw.
          </div>
        </div>
        <SummaryCard configured={configured} total={providers.length || PROVIDER_ORDER.length} t={t} />
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
            <SectionTitle title="Provider Setup" detail="Use env vars or save project-local provider settings." t={t} />
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

          <section style={{ marginTop: 22 }}>
            <SectionTitle title="Local Agent Memory" detail="Memory helps interpret business language but never overrides certified metadata." t={t} />
            <MemoryEditor
              memories={memories}
              t={t}
              onChange={setMemories}
              onStatus={setStatus}
            />
          </section>

          <section style={{ marginTop: 22 }}>
            <SectionTitle title="Environment Status" detail="Runtime variables remain supported for Docker, CI, and shell-based setup." t={t} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
              {groups.map((group) => (
                <EnvGroupCard key={group.id} group={group} t={t} />
              ))}
            </div>
          </section>
        </>
      )}
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
          <div style={{ fontSize: 14, fontWeight: 700 }}>{provider.label}</div>
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
        {(provider.id === 'openai' || provider.id === 'ollama' || provider.id === 'custom-openai') && (
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={provider.id === 'ollama' ? 'http://host.docker.internal:11434 or http://127.0.0.1:11434' : 'Base URL'}
            style={inputStyle(t)}
          />
        )}
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Default model"
          style={inputStyle(t)}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" onClick={save} disabled={busy} style={buttonStyle(t, true)}>Save</button>
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
          <div style={{ padding: 14, color: t.textSecondary, fontSize: 12 }}>No local memory yet.</div>
        ) : memories.slice(0, 20).map((memory) => (
          <div key={memory.id} style={{ padding: 12, borderBottom: `1px solid ${t.headerBorder}` }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 10, fontFamily: t.fontMono, color: t.accent, textTransform: 'uppercase' }}>{memory.scope}</span>
              <strong style={{ fontSize: 13 }}>{memory.title}</strong>
              <button type="button" onClick={() => remove(memory.id)} style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: t.textMuted, cursor: 'pointer' }}>Delete</button>
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: t.textSecondary, whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{memory.content}</div>
            {memory.tags.length > 0 && <div style={{ marginTop: 6, fontSize: 11, color: t.textMuted }}>{memory.tags.join(', ')}</div>}
          </div>
        ))}
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

function SummaryCard({ configured, total, t }: { configured: number; total: number; t: Theme }) {
  return (
    <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, padding: '10px 12px', minWidth: 132, textAlign: 'right', background: t.cellBg }}>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{configured}/{total}</div>
      <div style={{ fontSize: 12, color: t.textSecondary }}>providers ready</div>
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
