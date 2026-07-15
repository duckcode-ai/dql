import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Blocks,
  BookOpenText,
  Bot,
  Box,
  Check,
  ChevronLeft,
  Database,
  FileText,
  GitBranch,
  Link2,
  MessageCircle,
  Network,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { api, type ProviderSettings, type ProviderSettingsId } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { BlockStudioDbtStatus } from '../../store/types';
import { SetupWizard } from '../modals/SetupWizard';

const STEP_LABELS = ['How it works', 'dbt', 'Database', 'AI provider', 'Start'];
const WAREHOUSES = [
  { id: 'duckdb', label: 'DuckDB', glyph: '◗' },
  { id: 'snowflake', label: 'Snowflake', glyph: '❄' },
  { id: 'databricks', label: 'Databricks', glyph: '◆' },
  { id: 'file', label: 'Local files', glyph: '▤' },
] as const;

type AsyncState = 'idle' | 'testing' | 'ok' | 'error';
type SetupConnectionFields = { host: string; database: string; schema: string; role: string };
const EMPTY_CONNECTION_FIELDS: SetupConnectionFields = { host: '', database: '', schema: '', role: '' };

function defaultProviderMode(id: ProviderSettingsId) {
  if (id === 'claude-code' || id === 'codex') return 'Subscription CLI';
  if (id === 'ollama') return 'Local runtime';
  return 'API key';
}

export function HomePage() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [step, setStep] = useState(0);
  const [dbtStatus, setDbtStatus] = useState<BlockStudioDbtStatus | null>(state.blockStudioDbtStatus);
  const [connections, setConnections] = useState<{ default: string; connections: Record<string, unknown> }>({ default: '', connections: {} });
  const [providers, setProviders] = useState<ProviderSettings[]>([]);
  const [dbtWizardOpen, setDbtWizardOpen] = useState(false);
  const [warehouse, setWarehouse] = useState('duckdb');
  const [authMode, setAuthMode] = useState<'credentials' | 'enterprise'>('credentials');
  const [connectionFields, setConnectionFields] = useState<SetupConnectionFields>(EMPTY_CONNECTION_FIELDS);
  const [enterpriseKey, setEnterpriseKey] = useState('');
  const [dbState, setDbState] = useState<AsyncState>('idle');
  const [dbMessage, setDbMessage] = useState('');
  const [providerId, setProviderId] = useState<ProviderSettingsId>('anthropic');
  const [providerMode, setProviderMode] = useState('API key');
  const [apiKey, setApiKey] = useState('');
  const [providerState, setProviderState] = useState<AsyncState>('idle');
  const [providerMessage, setProviderMessage] = useState('');

  const refresh = async () => {
    const [nextDbt, nextConnections, providerResult] = await Promise.all([
      api.getBlockStudioDbtStatus().catch(() => null),
      api.getConnections(),
      api.getProviderSettings(),
    ]);
    setDbtStatus(nextDbt);
    setConnections(nextConnections);
    const activeConnection = nextConnections.connections[nextConnections.default] as Record<string, unknown> | undefined;
    const activeWarehouse = warehouseForConnection(activeConnection);
    if (activeWarehouse) {
      setWarehouse(activeWarehouse);
      setConnectionFields(fieldsForConnection(activeConnection));
    }
    setProviders(providerResult.providers);
    const active = providerResult.providers.find((provider) => provider.active) ?? providerResult.providers.find((provider) => provider.enabled);
    if (active) {
      setProviderId(active.id);
      setProviderMode(defaultProviderMode(active.id));
      if (active.enabled && (active.hasApiKey || active.authMode === 'subscription_cli' || active.id === 'ollama')) setProviderState('ok');
    }
    if (Object.keys(nextConnections.connections).length) setDbState('ok');
  };

  useEffect(() => { void refresh(); }, []);

  const sourceReady = Boolean(dbtStatus?.artifacts.manifest.exists || dbtStatus?.artifacts.semanticManifest.exists);
  const provider = providers.find((item) => item.id === providerId);
  const providerReady = providerState === 'ok' || Boolean(provider?.enabled && (provider.hasApiKey || provider.authMode === 'subscription_cli' || provider.id === 'ollama'));
  const connectionReady = dbState === 'ok';
  const canContinue = step === 0 || step === 1 ? sourceReady || step === 0 : step === 2 ? connectionReady : step === 3 ? providerReady : true;
  const nextLabel = ['Start setup', 'Next · Database', 'Next · AI provider', 'Next · Choose your start', ''][step];

  const testDatabase = async () => {
    const draftFieldsReady = authMode === 'enterprise'
      ? enterpriseKey.trim().length > 0
      : connectionFields.host.trim().length > 0
        && (warehouse === 'duckdb' || warehouse === 'file' || (connectionFields.database.trim().length > 0 && connectionFields.schema.trim().length > 0));
    if (!draftFieldsReady) {
      setDbState('error');
      setDbMessage(authMode === 'enterprise' ? 'Enter the enterprise connection key before testing.' : 'Complete the required connection fields before testing.');
      return;
    }
    setDbState('testing');
    setDbMessage('Running a read-only test query…');
    const existingEntry = Object.entries(connections.connections).find(([, value]) => warehouseForConnection(value as Record<string, unknown>) === warehouse);
    const draft = {
      ...((existingEntry?.[1] as Record<string, unknown> | undefined) ?? {}),
      ...connectionFromSetup(warehouse, authMode, connectionFields, enterpriseKey),
    };
    const result = await api.testConnection(draft);
    if (result.ok) {
      try {
        const connectionName = existingEntry?.[0] ?? `setup_${warehouse}`;
        const nextConnections = { ...connections.connections, [connectionName]: draft };
        await api.saveConnections(nextConnections, connectionName);
        setConnections({ default: connectionName, connections: nextConnections });
      } catch (error) {
        setDbState('error');
        setDbMessage(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    setDbState(result.ok ? 'ok' : 'error');
    setDbMessage(result.message);
  };

  const testProvider = async () => {
    setProviderState('testing');
    setProviderMessage('Running a test prompt…');
    const result = await api.testProviderSettings(providerId, apiKey ? { apiKey } : undefined);
    if (result.ok) {
      try {
        const saved = await api.saveProviderSettings({ id: providerId, enabled: true, apiKey: apiKey || undefined });
        setProviders(saved.providers);
      } catch (error) {
        setProviderState('error');
        setProviderMessage(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    setProviderState(result.ok ? 'ok' : 'error');
    setProviderMessage(result.message);
  };

  const open = (view: 'ask' | 'modeling' | 'block_studio' | 'apps') => dispatch({ type: 'SET_MAIN_VIEW', view });

  return <div className="dql-setup" style={{ color: t.textPrimary, background: t.appBg }}>
    <style>{SETUP_STYLES}</style>
    <header className="dql-setup-header" style={{ background: t.headerBg, borderColor: t.headerBorder }}>
      <div className="dql-setup-brand"><span>DQL</span><b>Setup</b></div>
      <div className="dql-setup-quiet">Local-first · secrets stay in <code>.dql/</code></div>
    </header>

    <nav className="dql-setup-stepper" aria-label="Setup progress" style={{ background: t.headerBg, borderColor: t.headerBorder }}>
      {STEP_LABELS.map((label, index) => <button key={label} className={index === step ? 'active' : index < step ? 'complete' : ''} disabled={index > step} onClick={() => setStep(index)}><span>{index < step ? <Check size={11} /> : index + 1}</span>{label}</button>)}
    </nav>

    <main className="dql-setup-body">
      {step === 0 && <WelcomeStory />}
      {step === 1 && <SetupSection eyebrow="Step 1 of 4" title="Connect your dbt project" description="DQL reads your manifest, catalog, tests, and semantic layer. dbt keeps ownership; DQL adds governed analytical context on top.">
        <div className="dql-setup-card">
          <Field label="dbt project"><input defaultValue={dbtStatus?.projectName ?? './analytics'} placeholder="./path/to/dbt-project" /></Field>
          <Field label="Target"><select defaultValue="dev"><option>dev</option><option>prod</option></select></Field>
          <div className="dql-setup-inline-actions"><button className="primary" onClick={() => setDbtWizardOpen(true)}>Connect &amp; run manifest</button><button className="secondary" onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'lineage' })}>Preview lineage</button></div>
          {sourceReady ? <Success title="Connected — manifest compiled" body={`${dbtStatus?.counts.models ?? 0} models · ${dbtStatus?.counts.metrics ?? 0} metrics · ${dbtStatus?.projectName ?? 'dbt project'}`} /> : <Notice>Run the manifest to verify the project before continuing.</Notice>}
        </div>
      </SetupSection>}

      {step === 2 && <SetupSection eyebrow="Step 2 of 4" title="Connect your database" description="Where queries run. Pick your warehouse — DQL installs the matching catalog driver for you.">
        <div className="dql-warehouse-grid">{WAREHOUSES.map((item) => <button key={item.id} className={warehouse === item.id ? 'active' : ''} onClick={() => { const existing = Object.values(connections.connections).find((value) => warehouseForConnection(value as Record<string, unknown>) === item.id) as Record<string, unknown> | undefined; setWarehouse(item.id); setConnectionFields(existing ? fieldsForConnection(existing) : EMPTY_CONNECTION_FIELDS); setEnterpriseKey(''); setDbState('idle'); setDbMessage(''); }}><b>{item.glyph}</b><span>{item.label}</span></button>)}</div>
        <div className="dql-setup-card">
          <div className="dql-driver-status"><Check size={13} />{WAREHOUSES.find((item) => item.id === warehouse)?.label} catalog driver installed</div>
          <label className="dql-field"><span>Authenticate with</span><div className="dql-choice-row"><button className={authMode === 'credentials' ? 'active' : ''} onClick={() => { setAuthMode('credentials'); setDbState('idle'); }}><i />Credentials<small>Username, SSO, or key pair</small></button><button className={authMode === 'enterprise' ? 'active' : ''} onClick={() => { setAuthMode('enterprise'); setDbState('idle'); }}><i />Enterprise key<small>Managed by your admin</small></button></div></label>
          {authMode === 'enterprise' ? <Field label="Enterprise connection key"><input type="password" value={enterpriseKey} onChange={(event) => { setEnterpriseKey(event.target.value); setDbState('idle'); }} placeholder="dqlk_….paste from your admin" /></Field> : <WarehouseFields warehouse={warehouse} values={connectionFields} onChange={(key, value) => { setConnectionFields((current) => ({ ...current, [key]: value })); setDbState('idle'); }} />}
          <button className="primary fit" onClick={() => void testDatabase()} disabled={dbState === 'testing'}>{dbState === 'testing' ? 'Running a read-only test query…' : 'Test connection'}</button>
          {dbState === 'ok' && <Success title={`Connected to ${WAREHOUSES.find((item) => item.id === warehouse)?.label}`} body={dbMessage || 'dbt models matched to warehouse tables'} />}
          {dbState === 'error' && <ErrorNotice>{dbMessage}</ErrorNotice>}
        </div>
      </SetupSection>}

      {step === 3 && <SetupSection eyebrow="Step 3 of 4" title="Set up an AI provider" required description="Powers Ask AI, block suggestions, and research — you'll build dramatically faster with it. Use a subscription, an API key, or a local model.">
        <div className="dql-setup-card">
          <div className="dql-two-fields"><Field label="Provider"><select value={providerId} onChange={(event) => { const nextId = event.target.value as ProviderSettingsId; setProviderId(nextId); setProviderMode(defaultProviderMode(nextId)); setProviderState('idle'); }}><option value="claude-code">Claude subscription</option><option value="codex">ChatGPT subscription</option><option value="anthropic">Anthropic Claude</option><option value="openai">OpenAI</option><option value="gemini">Google Gemini</option><option value="ollama">Ollama — local</option></select></Field><Field label="Connect with"><select value={providerMode} onChange={(event) => setProviderMode(event.target.value)}>{providerId === 'ollama' ? <option>Local runtime</option> : ['claude-code', 'codex'].includes(providerId) ? <option>Subscription CLI</option> : <><option>API key</option><option>Environment variable</option></>}</select></Field></div>
          {providerId === 'ollama' ? <Field label="Ollama base URL"><input defaultValue="http://127.0.0.1:11434" /></Field> : providerMode === 'API key' && !['claude-code', 'codex'].includes(providerId) ? <Field label="API key (or set it in your environment)"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={providerId === 'anthropic' ? 'sk-ant-…' : 'sk-…'} /></Field> : <Notice>Your installed provider CLI will open its secure sign-in flow. DQL never reads the subscription credential.</Notice>}
          <div className="dql-setup-inline-actions"><button className="primary fit" onClick={() => void testProvider()} disabled={providerState === 'testing'}>{providerState === 'testing' ? 'Running a test prompt…' : 'Test provider'}</button><button className="secondary" onClick={() => { dispatch({ type: 'SET_SETTINGS_TAB', tab: 'ai' }); dispatch({ type: 'SET_MAIN_VIEW', view: 'settings' }); }}>Advanced provider settings</button></div>
          {providerReady && <Success title={`${provider?.label ?? providerId} ready`} body={providerMessage || 'Governed prompt template verified'} />}
          {providerState === 'error' && <ErrorNotice>{providerMessage}</ErrorNotice>}
        </div>
      </SetupSection>}

      {step === 4 && <SetupSection eyebrow="Step 4 of 4 · You're connected" title="Where do you want to start?" centered>
        <div className="dql-start-grid"><StartCard icon={<Network size={16} />} title="Build your domain" body="Model entities, prove joins, add skills. Domain-level setup gives the AI the highest answer accuracy." hint="~15 min · recommended →" badge="Best accuracy" onClick={() => open('modeling')} /><StartCard icon={<MessageCircle size={16} />} title="Ask AI now" body="Ask your first business question — answers are grounded in your dbt models from day one." hint="instant →" onClick={() => open('ask')} /><StartCard icon={<BookOpenText size={16} />} title="Research notebook" body="Deep-dive with SQL, DQL, and charts — save the good parts as reusable blocks." hint="for analysts →" onClick={() => dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' })} /><StartCard icon={<Blocks size={16} />} title="Build a block" body="Turn a trusted metric or recurring query into a reusable governed answer." hint="Block Studio →" onClick={() => open('block_studio')} /><StartCard icon={<Box size={16} />} title="Generate an app" body="Compose certified blocks into a stakeholder-ready analytics experience." hint="Apps →" onClick={() => open('apps')} /></div>
      </SetupSection>}
    </main>

    <footer className="dql-setup-footer" style={{ background: t.headerBg, borderColor: t.headerBorder }}>
      <button className="back" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0}><ChevronLeft size={14} />Back</button>
      <span>{step < 4 ? 'You can return to Setup at any time.' : 'Your workspace is ready.'}</span>
      {step < 4 && <button className="primary" disabled={!canContinue} onClick={() => setStep((value) => Math.min(4, value + 1))}>{nextLabel}<ArrowRight size={14} /></button>}
    </footer>

    {dbtWizardOpen && <SetupWizard detectedProvider={state.semanticLayer.provider} onClose={() => setDbtWizardOpen(false)} onImported={() => { setDbtWizardOpen(false); void refresh(); }} />}
  </div>;
}

function WelcomeStory() {
  const stages = [
    [Database, 'Sources & dbt', 'Your warehouse and models — dbt keeps ownership'],
    [Network, 'Domains & modeling', 'Business entities, proven joins, skills'],
    [Blocks, 'Certified blocks', 'Reusable governed answers — reviewed & certified'],
    [MessageCircle, 'Ask & research', 'Ask AI answers + notebooks for deep dives'],
    [Box, 'Generative apps', 'Stakeholder apps built from certified blocks'],
  ] as const;
  return <div className="dql-welcome">
    <section className="dql-welcome-hero"><div><span className="eyebrow"><Sparkles size={12} />Welcome to DQL</span><h1>Analytics your AI<br />can't hallucinate</h1><div className="dql-proof-list"><span><Check size={13} />Sits on your dbt project — models and tests stay yours</span><span><Check size={13} />Questions route through <strong>certified blocks</strong> before AI writes SQL</span><span><Check size={13} />Every answer carries a trust label your stakeholders can read</span></div></div><div className="dql-answer-card"><div className="question">What was revenue last quarter?</div><div className="trust"><ShieldCheck size={12} />Certified <small>from total_revenue · 0.3s</small></div><p>Q2 revenue was <strong>$4.82M</strong>, up 6.4% from Q1.</p><div className="trace"><Link2 size={11} />Traceable from source table to this answer</div></div></section>
    <Chapter number="01" title="How a question becomes a trusted answer" subtitle="Five stages, one direction — watch the flow."><div className="dql-pipeline">{stages.map(([Icon, title, body], index) => <React.Fragment key={title}><div><Icon size={14} /><b>{title}</b><span>{body}</span></div>{index < stages.length - 1 && <ArrowRight size={14} />}</React.Fragment>)}</div><div className="dql-rail"><i />Lineage — trace any number from source to app, across domains</div><div className="dql-rail dashed"><i />Everything versioned — review and approve changes together</div></Chapter>
    <Chapter number="02" title="Certify once, everyone reuses" subtitle="The loop that grows trust — and cuts AI cost with every pass." right><div className="dql-loop"><span>Research freely</span><ArrowRight size={12} /><span>Review together</span><ArrowRight size={12} /><span>Certify once</span><ArrowRight size={12} /><span>Reuse everywhere</span></div></Chapter>
    <Chapter number="03" title="What DQL adds to dbt" subtitle="A governed decision layer without copying ownership."><div className="dql-chapter-grid"><div><GitBranch size={16} /><b>dbt stays the source</b><span>Models, columns, tests, lineage, and semantic formulas stay where your team owns them.</span></div><div><ShieldCheck size={16} /><b>DQL proves safe reuse</b><span>Business identity, relationship proof, skills, blocks, and review state guide the agent.</span></div><div><Bot size={16} /><b>AI stays inside the evidence</b><span>Answers show sources, trust state, and the path to review instead of hiding uncertainty.</span></div></div></Chapter>
  </div>;
}

function Chapter({ number, title, subtitle, children, right = false }: { number: string; title: string; subtitle: string; children: React.ReactNode; right?: boolean }) { return <section className={`dql-chapter ${right ? 'right' : ''}`}><header><span>{number}</span><div><b>{title}</b><small>{subtitle}</small></div></header>{children}</section>; }
function SetupSection({ eyebrow, title, description, children, required, centered }: { eyebrow: string; title: string; description?: string; children: React.ReactNode; required?: boolean; centered?: boolean }) { return <section className={`dql-setup-section ${centered ? 'centered' : ''}`}><header><span>{eyebrow}</span><h1>{title}{required && <> <em>Required</em></>}</h1>{description && <p>{description}</p>}</header>{children}</section>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="dql-field"><span>{label}</span>{children}</label>; }
function WarehouseFields({ warehouse, values, onChange }: { warehouse: string; values: SetupConnectionFields; onChange: (key: keyof SetupConnectionFields, value: string) => void }) { const hostLabel = warehouse === 'duckdb' || warehouse === 'file' ? 'Database file' : warehouse === 'snowflake' ? 'Account / host' : 'Server hostname'; return <div className="dql-two-fields"><Field label={hostLabel}><input value={values.host} onChange={(event) => onChange('host', event.target.value)} placeholder={warehouse === 'duckdb' ? './warehouse/analytics.duckdb' : warehouse === 'snowflake' ? 'acme.us-east-1' : 'dbc-…cloud.databricks.com'} /></Field><Field label="Database"><input value={values.database} onChange={(event) => onChange('database', event.target.value)} placeholder="ANALYTICS" /></Field><Field label="Schema"><input value={values.schema} onChange={(event) => onChange('schema', event.target.value)} placeholder="analytics" /></Field><Field label="Role"><input value={values.role} onChange={(event) => onChange('role', event.target.value)} placeholder="ANALYST" /></Field></div>; }

function warehouseForConnection(connection: Record<string, unknown> | undefined): string | null {
  const driver = String(connection?.driver ?? '').toLowerCase();
  if (driver === 'duckdb' || driver === 'snowflake' || driver === 'databricks' || driver === 'file') return driver;
  return null;
}

function fieldsForConnection(connection: Record<string, unknown> | undefined): SetupConnectionFields {
  return {
    host: String(connection?.filepath ?? connection?.account ?? connection?.serverHostname ?? ''),
    database: String(connection?.database ?? connection?.catalog ?? ''),
    schema: String(connection?.schema ?? ''),
    role: String(connection?.role ?? ''),
  };
}

function connectionFromSetup(warehouse: string, authMode: 'credentials' | 'enterprise', fields: SetupConnectionFields, enterpriseKey: string): Record<string, unknown> {
  if (authMode === 'enterprise') return { driver: warehouse === 'file' ? 'duckdb' : warehouse, enterpriseKey: enterpriseKey.trim() };
  if (warehouse === 'duckdb' || warehouse === 'file') return { driver: 'duckdb', filepath: fields.host.trim() };
  if (warehouse === 'snowflake') return { driver: 'snowflake', account: fields.host.trim(), database: fields.database.trim(), schema: fields.schema.trim(), role: fields.role.trim() || undefined };
  return { driver: 'databricks', serverHostname: fields.host.trim(), catalog: fields.database.trim(), schema: fields.schema.trim() };
}
function Success({ title, body }: { title: string; body: string }) { return <div className="dql-success"><b><Check size={13} />{title}</b><span>{body}</span></div>; }
function Notice({ children }: { children: React.ReactNode }) { return <div className="dql-notice">{children}</div>; }
function ErrorNotice({ children }: { children: React.ReactNode }) { return <div className="dql-error">{children}</div>; }
function StartCard({ icon, title, body, hint, badge, onClick }: { icon: React.ReactNode; title: string; body: string; hint: string; badge?: string; onClick: () => void }) { return <button className="dql-start-card" onClick={onClick}>{badge && <em>{badge}</em>}<i>{icon}</i><b>{title}</b><span>{body}</span><small>{hint}</small></button>; }

const SETUP_STYLES = `
.dql-setup{position:relative;height:100%;min-height:0;display:flex;flex-direction:column;font-family:var(--font-ui,Inter,sans-serif)}
.dql-setup *{box-sizing:border-box}.dql-setup button,.dql-setup input,.dql-setup select{font:inherit}.dql-setup button{cursor:pointer}
.dql-setup-header{height:48px;flex:none;border-bottom:1px solid;display:flex;align-items:center;justify-content:space-between;padding:0 18px}.dql-setup-brand{display:flex;align-items:center;gap:10px;font-size:12px}.dql-setup-brand>span{background:var(--accent);color:var(--accent-fg);border-radius:6px;padding:5px 8px;font:800 10px var(--font-mono,monospace);letter-spacing:.06em}.dql-setup-quiet{font-size:10.5px;color:var(--text-muted)}
.dql-setup-stepper{height:52px;flex:none;border-bottom:1px solid;display:flex;align-items:center;justify-content:center;gap:3px}.dql-setup-stepper button{display:flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--text-muted);padding:6px 10px;border-radius:7px;font-size:11px;font-weight:650}.dql-setup-stepper button:disabled{cursor:default;opacity:.72}.dql-setup-stepper button span{width:18px;height:18px;border:1px solid var(--border-default);border-radius:999px;display:grid;place-items:center;font:700 9px var(--font-mono,monospace)}.dql-setup-stepper button.active{background:var(--accent-dim);color:var(--accent)}.dql-setup-stepper button.active span{border-color:var(--accent);background:var(--accent);color:var(--accent-fg)}.dql-setup-stepper button.complete{color:var(--text-secondary)}.dql-setup-stepper button.complete span{background:#2e8b57;border-color:#2e8b57;color:white}
.dql-setup-body{flex:1;min-height:0;overflow:auto;padding:30px 24px 110px}.dql-welcome{width:min(860px,100%);margin:0 auto;display:grid;gap:24px;animation:dql-setup-in .25s ease-out}.dql-welcome-hero{display:grid;grid-template-columns:1.1fr .9fr;gap:28px;align-items:center}.eyebrow{display:inline-flex;align-items:center;gap:7px;border:1px solid color-mix(in srgb,var(--accent) 28%,transparent);background:var(--accent-dim);border-radius:999px;padding:4px 12px;color:var(--accent);font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}.dql-welcome h1{margin:12px 0 0;font-size:27px;line-height:1.25;letter-spacing:-.02em}.dql-proof-list{display:grid;gap:8px;margin-top:14px;font-size:12.5px;color:var(--text-secondary)}.dql-proof-list span{display:flex;gap:8px;align-items:flex-start}.dql-proof-list svg{color:#2e8b57;flex:none;margin-top:2px}.dql-answer-card{border:1px solid var(--border-subtle);border-radius:12px;background:var(--bg-1);padding:13px 14px;box-shadow:0 8px 28px #0000000d}.dql-answer-card .question{margin-left:auto;width:fit-content;background:var(--bg-2);border-radius:12px 12px 3px 12px;padding:7px 11px;font-size:11.5px}.dql-answer-card .trust{margin-top:9px;display:flex;align-items:center;gap:6px;color:#2e8b57;font-size:10px;font-weight:700}.dql-answer-card .trust small{color:var(--text-muted);font-weight:500}.dql-answer-card p{font-size:13px;margin:7px 0}.dql-answer-card .trace{display:flex;justify-content:flex-end;gap:6px;color:var(--text-muted);font-size:10px}
.dql-chapter{display:grid;gap:10px}.dql-chapter>header{display:flex;gap:10px;align-items:baseline}.dql-chapter>header>span{font:700 13px var(--font-mono,monospace);color:var(--text-muted)}.dql-chapter>header div{display:grid}.dql-chapter>header b{font-size:16px}.dql-chapter>header small{color:var(--text-muted);font-size:11.5px;margin-top:2px}.dql-chapter.right>header{justify-content:flex-end;text-align:right}.dql-chapter.right>header>span{order:2}.dql-pipeline{border:1px solid var(--border-subtle);border-radius:14px;background:var(--bg-1);padding:20px;display:grid;grid-template-columns:1fr auto 1fr auto 1fr auto 1fr auto 1fr;align-items:center;gap:6px}.dql-pipeline>div{height:112px;border:1px solid var(--border-default);border-radius:10px;background:var(--bg-0);padding:10px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:5px}.dql-pipeline>div:nth-of-type(3){border-color:color-mix(in srgb,var(--accent) 40%,transparent);background:var(--accent-dim)}.dql-pipeline>div svg{color:var(--accent)}.dql-pipeline b{font-size:11.5px}.dql-pipeline span{font-size:9.5px;line-height:1.4;color:var(--text-muted)}.dql-pipeline>svg{color:var(--accent)}.dql-rail{display:flex;align-items:center;gap:8px;color:var(--text-muted);font-size:9.5px}.dql-rail i{height:5px;flex:1;border-radius:999px;background:linear-gradient(90deg,#4a74c966,#0a6b5e66,var(--accent),#2e8b5773)}.dql-rail.dashed i{background:repeating-linear-gradient(90deg,var(--border-strong) 0 14px,transparent 14px 20px)}.dql-loop{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap}.dql-loop span{border:1px solid var(--border-default);background:var(--bg-1);border-radius:999px;padding:5px 12px;font-size:11px;font-weight:650;color:var(--accent)}.dql-chapter-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.dql-chapter-grid>div{border:1px solid var(--border-subtle);border-radius:11px;background:var(--bg-1);padding:14px;display:grid;gap:7px}.dql-chapter-grid svg{color:var(--accent)}.dql-chapter-grid b{font-size:12.5px}.dql-chapter-grid span{font-size:11px;line-height:1.5;color:var(--text-secondary)}
.dql-setup-section{width:min(560px,100%);margin:0 auto;display:grid;gap:16px;animation:dql-setup-in .2s ease-out}.dql-setup-section.centered{width:min(760px,100%)}.dql-setup-section>header>span{font-size:10.5px;color:var(--accent);font-weight:800;letter-spacing:.06em;text-transform:uppercase}.dql-setup-section h1{font-size:21px;margin:6px 0 0;letter-spacing:-.01em}.dql-setup-section h1 em{margin-left:9px;border:1px solid #c145454d;color:#c14545;background:#fdecea;border-radius:999px;padding:2px 9px;font-size:9.5px;font-style:normal;vertical-align:middle}.dql-setup-section>header>p{margin:6px 0 0;color:var(--text-muted);font-size:12.5px;line-height:1.55}.dql-setup-section.centered>header{text-align:center}
.dql-setup-card{border:1px solid var(--border-subtle);border-radius:12px;background:var(--bg-1);padding:18px;display:grid;gap:12px}.dql-field{display:grid;gap:5px;color:var(--text-secondary);font-size:11px;font-weight:650}.dql-field input,.dql-field select{width:100%;border:1px solid var(--border-default);background:var(--bg-1);color:var(--text-primary);border-radius:8px;padding:8px 10px;font-size:12px;outline:none}.dql-field input:focus,.dql-field select:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-dim)}.dql-two-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}.dql-setup .primary,.dql-setup .secondary,.dql-setup .back{height:34px;border-radius:8px;padding:0 14px;display:inline-flex;align-items:center;justify-content:center;gap:7px;font-size:12px;font-weight:700}.dql-setup .primary{border:0;background:var(--accent);color:var(--accent-fg);box-shadow:0 1px 5px color-mix(in srgb,var(--accent) 30%,transparent)}.dql-setup .primary:disabled{opacity:.38;cursor:not-allowed}.dql-setup .secondary,.dql-setup .back{border:1px solid var(--border-default);background:var(--bg-1);color:var(--text-secondary)}.dql-setup .fit{width:fit-content}.dql-setup-inline-actions{display:flex;gap:8px;flex-wrap:wrap}.dql-notice,.dql-error{border:1px solid var(--border-subtle);background:var(--bg-0);border-radius:8px;padding:9px 11px;font-size:11px;color:var(--text-muted)}.dql-error{border-color:#c145454d;background:#fdecea;color:#a52e2e}.dql-success{border:1px solid #2e8b5740;background:#e8f4ee;border-radius:10px;padding:10px 12px;display:grid;gap:5px;color:#1a5c3a}.dql-success b{display:flex;align-items:center;gap:7px;font-size:12px}.dql-success span{font-size:11px}.dql-driver-status{border:1px solid var(--border-subtle);background:var(--bg-0);border-radius:9px;padding:9px 12px;display:flex;align-items:center;gap:7px;color:#2e8b57;font-size:11.5px;font-weight:650}
.dql-warehouse-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.dql-warehouse-grid button{display:grid;place-items:center;gap:5px;padding:12px 8px;border-radius:10px;border:1.5px solid var(--border-default);background:var(--bg-1);color:var(--text-primary)}.dql-warehouse-grid button.active{border-color:var(--accent);background:var(--accent-dim)}.dql-warehouse-grid b{font:800 16px var(--font-mono,monospace);color:var(--accent)}.dql-warehouse-grid span{font-size:11px;font-weight:700}.dql-choice-row{display:flex;gap:8px}.dql-choice-row button{position:relative;display:grid;grid-template-columns:auto 1fr;gap:2px 7px;text-align:left;border:1.5px solid var(--border-default);background:var(--bg-1);color:var(--text-primary);border-radius:9px;padding:8px 11px}.dql-choice-row button.active{border-color:var(--accent);background:var(--accent-dim)}.dql-choice-row i{grid-row:1/3;width:12px;height:12px;margin-top:2px;border:2px solid var(--border-strong);border-radius:999px}.dql-choice-row button.active i{border:4px solid var(--accent)}.dql-choice-row small{color:var(--text-muted);font-size:9.5px;font-weight:500}
.dql-start-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}.dql-start-card{position:relative;min-height:176px;display:flex;flex-direction:column;align-items:flex-start;gap:8px;text-align:left;border:1.5px solid var(--border-default);background:var(--bg-1);color:var(--text-primary);border-radius:13px;padding:16px}.dql-start-card:first-child{border-color:color-mix(in srgb,var(--accent) 45%,transparent);background:var(--accent-dim)}.dql-start-card:hover{border-color:var(--accent);box-shadow:0 4px 16px #00000012}.dql-start-card>i{width:30px;height:30px;border-radius:8px;background:var(--accent-dim);color:var(--accent);display:grid;place-items:center}.dql-start-card>b{font-size:13px}.dql-start-card>span{font-size:11px;line-height:1.5;color:var(--text-secondary)}.dql-start-card>small{margin-top:auto;color:var(--accent);font-size:10.5px;font-weight:700}.dql-start-card>em{position:absolute;right:11px;top:10px;border:1px solid #2e8b5755;background:#e8f4ee;color:#2e8b57;border-radius:999px;padding:2px 7px;font-size:8.5px;font-style:normal;font-weight:800}
.dql-setup-footer{position:absolute;left:0;right:0;bottom:0;height:58px;border-top:1px solid;display:flex;align-items:center;gap:12px;padding:0 18px;z-index:15}.dql-setup-footer>span{flex:1;text-align:center;color:var(--text-muted);font-size:10.5px}.dql-setup-footer .back:disabled{opacity:0;pointer-events:none}
@keyframes dql-setup-in{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
@media(max-width:980px){.dql-setup-quiet{display:none}.dql-setup-stepper{justify-content:flex-start;overflow:auto;padding:0 8px}.dql-setup-stepper button{font-size:0}.dql-setup-stepper button span{font-size:9px}.dql-welcome-hero{grid-template-columns:1fr}.dql-pipeline{grid-template-columns:1fr}.dql-pipeline>svg{transform:rotate(90deg);margin:auto}.dql-chapter-grid{grid-template-columns:1fr}.dql-setup-body{padding-inline:16px}.dql-two-fields{grid-template-columns:1fr}.dql-warehouse-grid{grid-template-columns:repeat(2,1fr)}.dql-setup-footer>span{display:none}.dql-setup-footer{justify-content:space-between}}
`;
