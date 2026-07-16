import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  Check,
  Database,
  Download,
  FileText,
  GitBranch,
  LayoutGrid,
  MessageCircleQuestion,
  Network,
  Package,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import type { ProviderSettingsId } from '../../api/client';

type Phase = 'idle' | 'testing' | 'ok' | 'error';
type Driver = 'duckdb' | 'snowflake' | 'databricks';
type AiProvider = 'claude' | 'openai' | 'gemini' | 'ollama';

const STEP_LABELS = ['How it works', 'dbt', 'Database', 'AI provider', 'Start'];
const NEXT_LABELS = ['Start setup', 'Next · Database', 'Next · AI provider', 'Next · Choose your start', ''];

const BLUE = '#4a74c9';

type ConnectorStatus = {
  driver: Driver;
  label: string;
  installed: boolean;
  builtIn: boolean;
  installPath: string;
};

const WH_META: Record<Driver, { name: string; glyph: string; color: string; host: string; ph: string }> = {
  duckdb: { name: 'DuckDB', glyph: '◗', color: '#b26b1f', host: 'Database file', ph: './warehouse/analytics.duckdb' },
  snowflake: { name: 'Snowflake', glyph: '❄', color: BLUE, host: 'Account URL', ph: 'acme-xy12345.snowflakecomputing.com' },
  databricks: { name: 'Databricks', glyph: '▲', color: '#c14545', host: 'Workspace URL', ph: 'dbc-1234.cloud.databricks.com' },
};
const DRIVER_ORDER: Driver[] = ['duckdb', 'snowflake', 'databricks'];

const PROVIDER_META: Record<AiProvider, { name: string; modes: { name: string; id: ProviderSettingsId }[]; keyPh: string; needsKey: boolean }> = {
  claude: {
    name: 'Anthropic Claude',
    modes: [
      { name: 'Subscription — sign in with Claude', id: 'claude-code' },
      { name: 'API key', id: 'anthropic' },
    ],
    keyPh: 'sk-ant-…',
    needsKey: true,
  },
  openai: {
    name: 'OpenAI',
    modes: [
      { name: 'Subscription — sign in with ChatGPT', id: 'codex' },
      { name: 'API key', id: 'openai' },
    ],
    keyPh: 'sk-…',
    needsKey: true,
  },
  gemini: {
    name: 'Google Gemini',
    modes: [{ name: 'API key', id: 'gemini' }],
    keyPh: 'AIza…',
    needsKey: true,
  },
  ollama: {
    name: 'Ollama (local)',
    modes: [{ name: 'Local — runs on this machine', id: 'ollama' }],
    keyPh: '',
    needsKey: false,
  },
};

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{3,6}$/.test(value)) return hex;
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value.padEnd(6, '0');
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function pruneEmpty(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v.trim().length > 0));
}

export function SetupOnboarding() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [step, setStep] = useState(0);

  // ── Step 1 · dbt ──────────────────────────────────────────────
  const [dbtRepo, setDbtRepo] = useState('');
  const [dbtPhase, setDbtPhase] = useState<Phase>('idle');
  const [dbtSummary, setDbtSummary] = useState('');
  const [dbtError, setDbtError] = useState('');

  // ── Step 2 · database ─────────────────────────────────────────
  const [wh, setWh] = useState<Driver>('duckdb');
  const [dbAuth, setDbAuth] = useState<'creds' | 'enterprise'>('creds');
  const [dbFields, setDbFields] = useState({ host: '', database: '', schema: '' });
  const [enterpriseKey, setEnterpriseKey] = useState('');
  const [dbPhase, setDbPhase] = useState<Phase>('idle');
  const [dbSummary, setDbSummary] = useState('');
  const [dbError, setDbError] = useState('');
  const [connectorStatus, setConnectorStatus] = useState<ConnectorStatus[]>([]);
  const [installing, setInstalling] = useState<Partial<Record<Driver, boolean>>>({});

  // ── Step 3 · AI provider ──────────────────────────────────────
  const [aiProvider, setAiProvider] = useState<AiProvider>('claude');
  const [aiModeIdx, setAiModeIdx] = useState(0);
  const [aiKey, setAiKey] = useState('');
  const [aiPhase, setAiPhase] = useState<Phase>('idle');
  const [aiSummary, setAiSummary] = useState('');
  const [aiError, setAiError] = useState('');

  // Prefill from live server state on open.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [conns, onboarding, providers] = await Promise.all([
        api.getConnections().catch(() => null),
        api.getOnboardingStatus().catch(() => null),
        api.getProviderSettings().catch(() => null),
      ]);
      if (!alive) return;
      if (conns?.connectorStatus?.length) {
        setConnectorStatus(conns.connectorStatus as ConnectorStatus[]);
        const def = typeof conns.default === 'string' ? (conns.connections?.[conns.default] as any) : null;
        const defDriver = def?.driver as Driver | undefined;
        if (defDriver && WH_META[defDriver]) setWh(defDriver);
      }
      if (onboarding?.dbt?.projectDir) setDbtRepo(onboarding.dbt.projectDir);
      const active = providers?.providers?.find((p) => p.active || p.enabled);
      if (active) {
        const match = (Object.keys(PROVIDER_META) as AiProvider[]).find((k) =>
          PROVIDER_META[k].modes.some((m) => m.id === active.id),
        );
        if (match) setAiProvider(match);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const done = useMemo(
    () => [true, dbtPhase === 'ok', dbPhase === 'ok', aiPhase === 'ok', false],
    [dbtPhase, dbPhase, aiPhase],
  );
  const hints = [
    '≈ 2 minute read',
    done[1] ? 'dbt connected — continue' : 'You can test later, but answers need the manifest',
    done[2] ? 'Database connected' : 'Test to verify credentials',
    done[3] ? 'AI ready' : 'Required for AI assistance',
    'Setup complete',
  ];

  const whMeta = WH_META[wh];
  const selectedConnector = connectorStatus.find((c) => c.driver === wh);
  const catalogReady = selectedConnector ? selectedConnector.builtIn || selectedConnector.installed : wh === 'duckdb';
  const catalogInstalling = Boolean(installing[wh]);
  const providerMeta = PROVIDER_META[aiProvider];
  const activeMode = providerMeta.modes[Math.min(aiModeIdx, providerMeta.modes.length - 1)];

  // ── Actions ───────────────────────────────────────────────────
  const runDbt = useCallback(async () => {
    setDbtPhase('testing');
    setDbtError('');
    try {
      const projectDir = dbtRepo.trim();
      const res = await api.previewDbtOnboarding(projectDir ? { projectDir } : {});
      const c = res.counts ?? ({} as Record<string, number>);
      const parts = [
        `${c.models ?? 0} models`,
        `${c.sources ?? 0} sources`,
        `${c.metrics ?? 0} metrics`,
      ];
      if (res.projectName) parts.push(res.projectName);
      setDbtSummary(parts.join(' · '));
      setDbtPhase('ok');
    } catch (e) {
      setDbtError(e instanceof Error ? e.message : 'Could not compile the dbt manifest');
      setDbtPhase('error');
    }
  }, [dbtRepo]);

  const installCatalog = useCallback(async () => {
    setInstalling((s) => ({ ...s, [wh]: true }));
    try {
      const res = await api.installConnector(wh);
      if (res.connectorStatus) setConnectorStatus(res.connectorStatus as ConnectorStatus[]);
      else if (res.status) {
        setConnectorStatus((prev) => {
          const next = prev.filter((c) => c.driver !== res.status!.driver);
          next.push(res.status as ConnectorStatus);
          return next;
        });
      }
    } catch {
      /* surfaced by the row staying in the un-installed state */
    } finally {
      setInstalling((s) => ({ ...s, [wh]: false }));
    }
  }, [wh]);

  const testDb = useCallback(async () => {
    setDbPhase('testing');
    setDbError('');
    try {
      const current = await api.getConnections();
      const connections = { ...(current.connections ?? {}) } as Record<string, any>;
      const name =
        typeof current.default === 'string' && connections[current.default]
          ? current.default
          : Object.keys(connections)[0] ?? 'default';
      const existing = connections[name] ?? {};
      const patch =
        dbAuth === 'creds'
          ? pruneEmpty({ host: dbFields.host, database: dbFields.database, schema: dbFields.schema })
          : pruneEmpty({ enterpriseKey });
      connections[name] = { ...existing, driver: wh, ...patch };
      await api.saveConnections(connections, name);
      const res = await api.testConnection();
      if (res.ok) {
        setDbSummary(res.message || `Connected to ${whMeta.name}`);
        setDbPhase('ok');
      } else {
        setDbError(res.message || 'Connection failed');
        setDbPhase('error');
      }
    } catch (e) {
      setDbError(e instanceof Error ? e.message : 'Connection failed');
      setDbPhase('error');
    }
  }, [dbAuth, dbFields, enterpriseKey, wh, whMeta.name]);

  const testAi = useCallback(async () => {
    setAiPhase('testing');
    setAiError('');
    try {
      const id = activeMode.id;
      const overrides = providerMeta.needsKey && aiKey.trim() ? { apiKey: aiKey.trim() } : undefined;
      const res = await api.testProviderSettings(id, overrides);
      if (res.ok) {
        await api.saveProviderSettings({ id, enabled: true, apiKey: overrides?.apiKey });
        setAiSummary(res.message || `${providerMeta.name} ready`);
        setAiPhase('ok');
      } else {
        setAiError(res.message || 'Provider test failed');
        setAiPhase('error');
      }
    } catch (e) {
      setAiError(e instanceof Error ? e.message : 'Provider test failed');
      setAiPhase('error');
    }
  }, [activeMode.id, aiKey, providerMeta.name, providerMeta.needsKey]);

  const close = useCallback(() => dispatch({ type: 'CLOSE_SETUP' }), [dispatch]);
  const finishTo = useCallback(
    (view: 'domains' | 'ask' | 'notebook', newNotebook?: boolean) => {
      dispatch({ type: 'SET_MAIN_VIEW', view });
      if (newNotebook) dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' });
      dispatch({ type: 'CLOSE_SETUP' });
    },
    [dispatch],
  );

  // ── Shared styles ─────────────────────────────────────────────
  const card: React.CSSProperties = {
    border: `1px solid ${t.tableBorder}`,
    borderRadius: 12,
    background: t.cellBg,
    padding: 18,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  };
  const label: React.CSSProperties = { fontSize: 11, fontWeight: 650, color: t.textSecondary };
  const inputStyle: React.CSSProperties = {
    border: `1px solid ${t.inputBorder}`,
    background: t.cellBg,
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 12,
    fontFamily: t.fontMono,
    color: t.textPrimary,
    outline: 'none',
  };
  const eyebrow: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: t.accent,
  };
  const primaryBtn: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    height: 34,
    padding: '0 16px',
    borderRadius: 8,
    border: 'none',
    background: t.accent,
    color: '#ffffff',
    fontSize: 12.5,
    fontWeight: 650,
    cursor: 'pointer',
    fontFamily: 'inherit',
    width: 'fit-content',
    boxShadow: `0 1px 5px ${hexToRgba(t.accent, 0.3)}`,
  };
  const shimmer: React.CSSProperties = {
    fontSize: 12.5,
    fontWeight: 700,
    backgroundImage: `linear-gradient(100deg, ${t.textPrimary} 25%, ${t.accent} 50%, ${t.textPrimary} 75%)`,
    backgroundSize: '220% 100%',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
    WebkitTextFillColor: 'transparent',
    animation: 'dql-setup-shimmer 2s linear infinite',
  };
  const okBox = (title: React.ReactNode, detail: string): React.ReactNode => (
    <div
      style={{
        border: `1px solid ${hexToRgba(t.success, 0.28)}`,
        background: hexToRgba(t.success, 0.1),
        borderRadius: 10,
        padding: '11px 13px',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        animation: 'dql-setup-fadein 0.2s ease-out',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 700, color: '#1a5c3a' }}>
        <Check size={13} strokeWidth={2} color={t.success} />
        {title}
      </span>
      <span style={{ fontSize: 11.5, color: '#1a5c3a' }}>{detail}</span>
    </div>
  );
  const errBox = (msg: string): React.ReactNode => (
    <div
      style={{
        border: `1px solid ${hexToRgba(t.error, 0.28)}`,
        background: hexToRgba(t.error, 0.08),
        borderRadius: 10,
        padding: '10px 13px',
        fontSize: 11.5,
        color: t.error,
      }}
    >
      {msg}
    </div>
  );

  const hasPrev = step > 0;
  const hasNext = step < 4;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        background: t.appBg,
        fontFamily: t.font,
        color: t.textPrimary,
        fontSize: 13,
      }}
    >
      <style>{`
        @keyframes dql-setup-fadein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        @keyframes dql-setup-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        @keyframes dql-setup-arrow { 0%, 100% { opacity: 0.35; transform: translateX(0); } 50% { opacity: 1; transform: translateX(3px); } }
        @keyframes dql-setup-flowrail { 0% { background-position: 0% 0; } 100% { background-position: 200% 0; } }
        @keyframes dql-setup-gitdash { 0% { background-position: 0 0; } 100% { background-position: 40px 0; } }
        @keyframes dql-setup-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
      `}</style>

      {/* ══ Header ══ */}
      <div
        style={{
          height: 52,
          flexShrink: 0,
          background: t.headerBg,
          borderBottom: `1px solid ${t.headerBorder}`,
          display: 'flex',
          alignItems: 'center',
          padding: '0 18px',
          gap: 10,
          userSelect: 'none',
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            background: 'linear-gradient(135deg, #5b8cff 0%, #7c5cff 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <span style={{ color: '#ffffff', fontSize: 10, fontWeight: 700, fontFamily: t.fontMono, letterSpacing: '-0.5px' }}>DQL</span>
        </div>
        <span style={{ fontSize: 13.5, fontWeight: 650, color: t.textPrimary }}>Set up your workspace</span>
        <div style={{ flex: 1 }} />

        {/* stepper */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {STEP_LABELS.map((s, i) => {
            const isCurrent = step === i;
            const isDone = done[i] && i < 4;
            return (
              <button
                key={s}
                onClick={() => setStep(i)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 10px',
                  borderRadius: 999,
                  border: `1px solid ${isCurrent ? hexToRgba(t.accent, 0.4) : t.headerBorder}`,
                  background: isCurrent ? t.sidebarItemActive : t.cellBg,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 999,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 9,
                    fontWeight: 700,
                    background: isCurrent ? t.accent : isDone ? hexToRgba(t.success, 0.14) : t.pillBg,
                    color: isCurrent ? '#ffffff' : isDone ? t.success : t.textMuted,
                  }}
                >
                  {isDone && !isCurrent ? '✓' : i + 1}
                </span>
                <span style={{ fontSize: 11, fontWeight: 650, color: isCurrent ? t.accent : isDone ? t.success : t.textMuted }}>{s}</span>
              </button>
            );
          })}
        </div>
        <div style={{ flex: 1 }} />
        <button
          onClick={close}
          style={{
            height: 28,
            padding: '0 11px',
            borderRadius: 7,
            border: 'none',
            background: 'none',
            color: t.textMuted,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Skip for now
        </button>
      </div>

      {/* ══ Body ══ */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div style={{ width: 'min(860px, 100% - 48px)', margin: '0 auto', padding: '30px 0 40px' }}>
          {step === 0 && <WelcomeStep t={t} />}

          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560, margin: '0 auto', animation: 'dql-setup-fadein 0.25s ease-out' }}>
              <div>
                <div style={eyebrow}>Step 1 of 4</div>
                <h2 style={{ margin: '6px 0 0', fontSize: 21, fontWeight: 700, letterSpacing: '-0.01em', color: t.textPrimary }}>Connect your dbt project</h2>
                <div style={{ marginTop: 6, fontSize: 12.5, color: t.textMuted, lineHeight: 1.55 }}>
                  DQL reads your dbt manifest for models, tests, and lineage. dbt keeps ownership — DQL never edits your models.
                </div>
              </div>
              <div style={card}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={label}>dbt repo</span>
                  <input
                    value={dbtRepo}
                    onChange={(e) => setDbtRepo(e.target.value)}
                    placeholder="git@github.com:acme/analytics-dbt.git"
                    style={inputStyle}
                    onFocus={(e) => (e.currentTarget.style.borderColor = t.accent)}
                    onBlur={(e) => (e.currentTarget.style.borderColor = t.inputBorder)}
                  />
                  <span style={{ fontSize: 10.5, color: t.textMuted }}>Git URL or a local folder path. Leave blank to use the configured project.</span>
                </label>
                {dbtPhase === 'idle' || dbtPhase === 'error' ? (
                  <button onClick={runDbt} style={primaryBtn}>Connect &amp; run manifest</button>
                ) : dbtPhase === 'testing' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={shimmer}>Compiling manifest…</span>
                    <span style={{ fontSize: 11, color: t.textMuted }}>
                      Runs <span style={{ fontFamily: t.fontMono, fontSize: 10.5 }}>dbt compile</span> and reads the artifacts.
                    </span>
                  </div>
                ) : (
                  okBox('Connected — manifest compiled', dbtSummary)
                )}
                {dbtPhase === 'error' && errBox(dbtError)}
              </div>
            </div>
          )}

          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560, margin: '0 auto', animation: 'dql-setup-fadein 0.25s ease-out' }}>
              <div>
                <div style={eyebrow}>Step 2 of 4</div>
                <h2 style={{ margin: '6px 0 0', fontSize: 21, fontWeight: 700, letterSpacing: '-0.01em', color: t.textPrimary }}>Connect your database</h2>
                <div style={{ marginTop: 6, fontSize: 12.5, color: t.textMuted, lineHeight: 1.55 }}>
                  Where queries run. Pick your warehouse — DQL installs the matching catalog driver for you.
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${DRIVER_ORDER.length}, 1fr)`, gap: 8 }}>
                {DRIVER_ORDER.map((driver) => {
                  const meta = WH_META[driver];
                  const on = wh === driver;
                  return (
                    <button
                      key={driver}
                      onClick={() => {
                        setWh(driver);
                        setDbPhase('idle');
                      }}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 6,
                        padding: '13px 8px',
                        borderRadius: 10,
                        border: `1.5px solid ${on ? t.accent : t.headerBorder}`,
                        background: on ? t.sidebarItemActive : t.cellBg,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      <span style={{ fontSize: 16, fontWeight: 700, fontFamily: t.fontMono, color: meta.color }}>{meta.glyph}</span>
                      <span style={{ fontSize: 11.5, fontWeight: 650, color: t.textPrimary }}>{meta.name}</span>
                    </button>
                  );
                })}
              </div>
              <div style={card}>
                {/* catalog row */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    border: `1px solid ${t.tableBorder}`,
                    background: t.appBg,
                    borderRadius: 9,
                    padding: '9px 12px',
                  }}
                >
                  {catalogInstalling ? (
                    <span style={{ flex: 1, ...shimmer }}>Installing {whMeta.name} catalog driver…</span>
                  ) : catalogReady ? (
                    <>
                      <Check size={13} strokeWidth={2} color={t.success} />
                      <span style={{ flex: 1, fontSize: 12, color: t.success, fontWeight: 600 }}>
                        {selectedConnector?.builtIn ? `${whMeta.name} catalog is built in — no driver needed` : `${whMeta.name} catalog driver installed`}
                      </span>
                    </>
                  ) : (
                    <>
                      <Download size={13} strokeWidth={1.75} color={t.textMuted} />
                      <span style={{ flex: 1, fontSize: 12, color: t.textSecondary }}>
                        Catalog driver for <strong>{whMeta.name}</strong> is not installed
                      </span>
                      <button
                        onClick={installCatalog}
                        style={{
                          height: 26,
                          padding: '0 11px',
                          borderRadius: 6,
                          border: `1px solid ${t.accent}`,
                          background: t.sidebarItemActive,
                          color: t.accent,
                          fontSize: 11,
                          fontWeight: 650,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Install catalog
                      </button>
                    </>
                  )}
                </div>

                {/* auth mode */}
                <div>
                  <span style={{ ...label, display: 'block', marginBottom: 6 }}>Authenticate with</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {(
                      [
                        { key: 'creds' as const, title: 'Credentials', sub: 'Username, SSO, or key pair' },
                        { key: 'enterprise' as const, title: 'Enterprise key', sub: 'Managed by your admin' },
                      ]
                    ).map((opt) => {
                      const on = dbAuth === opt.key;
                      return (
                        <button
                          key={opt.key}
                          onClick={() => setDbAuth(opt.key)}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 7,
                            padding: '8px 13px',
                            borderRadius: 9,
                            border: `1.5px solid ${on ? t.accent : t.headerBorder}`,
                            background: on ? t.sidebarItemActive : t.cellBg,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          <span
                            style={{
                              width: 13,
                              height: 13,
                              borderRadius: 999,
                              border: `1.5px solid ${on ? t.accent : t.scrollbarThumb}`,
                              background: on ? t.accent : t.cellBg,
                              boxShadow: on ? `inset 0 0 0 2.5px ${t.sidebarItemActive}` : 'none',
                            }}
                          />
                          <span style={{ display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
                            <span style={{ fontSize: 12, fontWeight: 650, color: t.textPrimary }}>{opt.title}</span>
                            <span style={{ fontSize: 10, color: t.textMuted }}>{opt.sub}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {dbAuth === 'creds' ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, animation: 'dql-setup-fadein 0.18s ease-out' }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: '1 / -1' }}>
                      <span style={label}>{whMeta.host}</span>
                      <input
                        value={dbFields.host}
                        onChange={(e) => setDbFields((f) => ({ ...f, host: e.target.value }))}
                        placeholder={whMeta.ph}
                        style={inputStyle}
                        onFocus={(e) => (e.currentTarget.style.borderColor = t.accent)}
                        onBlur={(e) => (e.currentTarget.style.borderColor = t.inputBorder)}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={label}>Database</span>
                      <input
                        value={dbFields.database}
                        onChange={(e) => setDbFields((f) => ({ ...f, database: e.target.value }))}
                        placeholder="ANALYTICS"
                        style={inputStyle}
                        onFocus={(e) => (e.currentTarget.style.borderColor = t.accent)}
                        onBlur={(e) => (e.currentTarget.style.borderColor = t.inputBorder)}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={label}>Schema</span>
                      <input
                        value={dbFields.schema}
                        onChange={(e) => setDbFields((f) => ({ ...f, schema: e.target.value }))}
                        placeholder="analytics"
                        style={inputStyle}
                        onFocus={(e) => (e.currentTarget.style.borderColor = t.accent)}
                        onBlur={(e) => (e.currentTarget.style.borderColor = t.inputBorder)}
                      />
                    </label>
                  </div>
                ) : (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, animation: 'dql-setup-fadein 0.18s ease-out' }}>
                    <span style={label}>Enterprise connection key</span>
                    <input
                      type="password"
                      value={enterpriseKey}
                      onChange={(e) => setEnterpriseKey(e.target.value)}
                      placeholder="dqlk_….paste from your admin"
                      style={inputStyle}
                      onFocus={(e) => (e.currentTarget.style.borderColor = t.accent)}
                      onBlur={(e) => (e.currentTarget.style.borderColor = t.inputBorder)}
                    />
                    <span style={{ fontSize: 10.5, color: t.textMuted }}>One key carries the warehouse, role, and access policy set by your data team.</span>
                  </label>
                )}

                {dbPhase === 'idle' || dbPhase === 'error' ? (
                  <button onClick={testDb} style={primaryBtn}>Test connection</button>
                ) : dbPhase === 'testing' ? (
                  <span style={shimmer}>Running a read-only test query…</span>
                ) : (
                  okBox(`Connected to ${whMeta.name}`, dbSummary)
                )}
                {dbPhase === 'error' && errBox(dbError)}
              </div>
            </div>
          )}

          {step === 3 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560, margin: '0 auto', animation: 'dql-setup-fadein 0.25s ease-out' }}>
              <div>
                <div style={eyebrow}>Step 3 of 4</div>
                <h2 style={{ margin: '6px 0 0', fontSize: 21, fontWeight: 700, letterSpacing: '-0.01em', color: t.textPrimary, display: 'flex', alignItems: 'center', gap: 9 }}>
                  Set up an AI provider
                  <span style={{ border: `1px solid ${hexToRgba(t.error, 0.3)}`, color: t.error, background: hexToRgba(t.error, 0.08), borderRadius: 999, padding: '2px 9px', fontSize: 10, fontWeight: 700 }}>
                    Required
                  </span>
                </h2>
                <div style={{ marginTop: 6, fontSize: 12.5, color: t.textMuted, lineHeight: 1.55 }}>
                  Powers Ask AI, block suggestions, and research — you'll build dramatically faster with it. Use a subscription, an API key, or a local model.
                </div>
              </div>
              <div style={card}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={label}>Provider</span>
                    <select
                      value={aiProvider}
                      onChange={(e) => {
                        setAiProvider(e.target.value as AiProvider);
                        setAiModeIdx(0);
                        setAiPhase('idle');
                      }}
                      style={{ ...inputStyle, fontFamily: 'inherit', fontSize: 12.5, padding: '8px 9px' }}
                    >
                      <option value="claude">Anthropic Claude</option>
                      <option value="openai">OpenAI</option>
                      <option value="gemini">Google Gemini</option>
                      <option value="ollama">Ollama — local</option>
                    </select>
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={label}>Connect with</span>
                    <select
                      value={aiModeIdx}
                      onChange={(e) => {
                        setAiModeIdx(Number(e.target.value));
                        setAiPhase('idle');
                      }}
                      style={{ ...inputStyle, fontFamily: 'inherit', fontSize: 12.5, padding: '8px 9px' }}
                    >
                      {providerMeta.modes.map((m, i) => (
                        <option key={m.id} value={i}>{m.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {providerMeta.needsKey && activeMode.id !== 'claude-code' && activeMode.id !== 'codex' && (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={label}>
                      API key <span style={{ color: t.textMuted, fontWeight: 500 }}>(or sign in via CLI on the next screen)</span>
                    </span>
                    <input
                      type="password"
                      value={aiKey}
                      onChange={(e) => setAiKey(e.target.value)}
                      placeholder={providerMeta.keyPh}
                      style={inputStyle}
                      onFocus={(e) => (e.currentTarget.style.borderColor = t.accent)}
                      onBlur={(e) => (e.currentTarget.style.borderColor = t.inputBorder)}
                    />
                  </label>
                )}
                {aiPhase === 'idle' || aiPhase === 'error' ? (
                  <button onClick={testAi} style={primaryBtn}>Test provider</button>
                ) : aiPhase === 'testing' ? (
                  <span style={shimmer}>Running a test prompt…</span>
                ) : (
                  okBox(`${providerMeta.name} ready`, aiSummary)
                )}
                {aiPhase === 'error' && errBox(aiError)}
              </div>
            </div>
          )}

          {step === 4 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 640, margin: '0 auto', animation: 'dql-setup-fadein 0.25s ease-out' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={eyebrow}>Step 4 of 4 · You're connected</div>
                <h2 style={{ margin: '6px 0 0', fontSize: 21, fontWeight: 700, letterSpacing: '-0.01em', color: t.textPrimary }}>Where do you want to start?</h2>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
                <StartCard
                  t={t}
                  primary
                  badge="Best accuracy"
                  icon={<Boxes size={15} strokeWidth={1.75} />}
                  iconColor={t.accent}
                  title="Build your domain"
                  body="Model entities, prove joins, add skills. Domain-level setup gives the AI the highest answer accuracy."
                  cta="~15 min · recommended →"
                  ctaColor={t.accent}
                  onClick={() => finishTo('domains')}
                />
                <StartCard
                  t={t}
                  icon={<MessageCircleQuestion size={15} strokeWidth={1.75} />}
                  iconColor={t.warning}
                  title="Ask AI now"
                  body="Ask your first business question — answers are grounded in your dbt models from day one."
                  cta="instant →"
                  ctaColor={t.textMuted}
                  onClick={() => finishTo('ask')}
                />
                <StartCard
                  t={t}
                  icon={<FileText size={15} strokeWidth={1.75} />}
                  iconColor={BLUE}
                  title="Research notebook"
                  body="Deep-dive with SQL, DQL, and charts — save the good parts as reusable blocks."
                  cta="for analysts →"
                  ctaColor={t.textMuted}
                  onClick={() => finishTo('notebook', true)}
                />
              </div>
              <div style={{ textAlign: 'center', fontSize: 11.5, color: t.textMuted }}>You can do all three — this just picks your first screen.</div>
            </div>
          )}
        </div>
      </div>

      {/* ══ Footer ══ */}
      <div
        style={{
          flexShrink: 0,
          borderTop: `1px solid ${t.headerBorder}`,
          background: t.headerBg,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 22px',
        }}
      >
        {hasPrev && (
          <button
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 34,
              padding: '0 14px',
              borderRadius: 8,
              border: `1px solid ${t.headerBorder}`,
              background: t.cellBg,
              color: t.textSecondary,
              fontSize: 12.5,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <ArrowLeft size={13} strokeWidth={2} />
            Back
          </button>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: t.textMuted }}>{hints[step]}</span>
        {hasNext ? (
          <button onClick={() => setStep((s) => Math.min(4, s + 1))} style={{ ...primaryBtn, padding: '0 18px' }}>
            {NEXT_LABELS[step]}
            <ArrowRight size={13} strokeWidth={2} />
          </button>
        ) : (
          <button
            onClick={() => finishTo('ask')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              height: 34,
              padding: '0 18px',
              borderRadius: 8,
              border: 'none',
              background: t.success,
              color: '#ffffff',
              fontSize: 12.5,
              fontWeight: 650,
              cursor: 'pointer',
              fontFamily: 'inherit',
              boxShadow: `0 1px 5px ${hexToRgba(t.success, 0.3)}`,
            }}
          >
            Finish setup
          </button>
        )}
      </div>
    </div>
  );
}

function StartCard({
  t,
  primary,
  badge,
  icon,
  iconColor,
  title,
  body,
  cta,
  ctaColor,
  onClick,
}: {
  t: (typeof themes)[keyof typeof themes];
  primary?: boolean;
  badge?: string;
  icon: React.ReactNode;
  iconColor: string;
  title: string;
  body: string;
  cta: string;
  ctaColor: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '17px 16px',
        borderRadius: 13,
        border: `1.5px solid ${primary ? (hover ? t.accent : hexToRgba(t.accent, 0.4)) : hover ? t.accent : t.headerBorder}`,
        background: primary ? t.sidebarItemActive : t.cellBg,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        position: 'relative',
        boxShadow: hover ? `0 4px 16px ${hexToRgba(primary ? t.accent : '#1a1a1a', primary ? 0.15 : 0.07)}` : 'none',
      }}
    >
      {badge && (
        <span
          style={{
            position: 'absolute',
            top: 11,
            right: 12,
            border: `1px solid ${hexToRgba(t.success, 0.33)}`,
            color: t.success,
            background: hexToRgba(t.success, 0.1),
            borderRadius: 999,
            padding: '1.5px 8px',
            fontSize: 9,
            fontWeight: 700,
          }}
        >
          {badge}
        </span>
      )}
      <span
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          background: hexToRgba(iconColor, 0.13),
          color: iconColor,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </span>
      <span style={{ fontSize: 13.5, fontWeight: 700, color: t.textPrimary }}>{title}</span>
      <span style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.55 }}>{body}</span>
      <span style={{ fontSize: 11, color: ctaColor, fontWeight: 650 }}>{cta}</span>
    </button>
  );
}

function WelcomeStep({ t }: { t: (typeof themes)[keyof typeof themes] }) {
  const stages = [
    { icon: <Database size={13} strokeWidth={1.75} />, color: BLUE, title: 'Sources & dbt', body: 'Your warehouse and models — dbt keeps ownership', tint: false },
    { icon: <Boxes size={13} strokeWidth={1.75} />, color: '#0a6b5e', title: 'Domains & modeling', body: 'Business entities, proven joins, skills', tint: 'green' },
    { icon: <LayoutGrid size={13} strokeWidth={1.75} />, color: t.accent, title: 'Certified blocks', body: 'Reusable governed answers — reviewed & certified', tint: 'accent' },
    { icon: <MessageCircleQuestion size={13} strokeWidth={1.75} />, color: t.warning, title: 'Ask & research', body: 'Ask AI answers + SQL notebooks for deep dives', tint: false },
    { icon: <Package size={13} strokeWidth={1.75} />, color: t.success, title: 'Generative apps', body: 'Stakeholder apps built from certified blocks', tint: 'success' },
  ];
  const guarantees = [
    { icon: <ShieldCheck size={13} strokeWidth={1.75} color={t.success} />, title: 'High confidence', body: 'Certified answers at stakeholder precision — every answer carries its trust label.' },
    { icon: <LayoutGrid size={13} strokeWidth={1.75} color={t.accent} />, title: 'Lower AI cost', body: 'Reusable blocks answer repeat questions instantly — no regenerated SQL, no wasted tokens.' },
    { icon: <GitBranch size={13} strokeWidth={1.75} color={t.warning} />, title: 'Git-versioned', body: 'Blocks, domains, and apps are files — branch, review, and approve like code.' },
    { icon: <Network size={13} strokeWidth={1.75} color={BLUE} />, title: 'Full lineage', body: 'Trace any number from source table to app — including across domains.' },
  ];
  const arrow = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.accent }}>
      <ArrowRight size={14} strokeWidth={2} style={{ animation: 'dql-setup-arrow 1.6s ease-in-out infinite' }} />
    </div>
  );
  const stageBg = (tint: string | boolean) =>
    tint === 'green' ? hexToRgba('#0a6b5e', 0.05) : tint === 'accent' ? t.sidebarItemActive : tint === 'success' ? hexToRgba(t.success, 0.05) : t.appBg;
  const stageBorder = (tint: string | boolean) =>
    tint === 'green' ? hexToRgba('#0a6b5e', 0.3) : tint === 'accent' ? hexToRgba(t.accent, 0.35) : tint === 'success' ? hexToRgba(t.success, 0.3) : t.headerBorder;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, animation: 'dql-setup-fadein 0.25s ease-out' }}>
      {/* hero */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: 28, alignItems: 'center' }}>
        <div>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              border: `1px solid ${hexToRgba(t.accent, 0.25)}`,
              background: t.sidebarItemActive,
              borderRadius: 999,
              padding: '4px 13px',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: t.accent,
            }}
          >
            <Sparkles size={12} strokeWidth={1.75} />
            Welcome to DQL
          </div>
          <h1 style={{ margin: '12px 0 0', fontSize: 27, fontWeight: 700, letterSpacing: '-0.02em', color: t.textPrimary, lineHeight: 1.25 }}>
            Analytics your AI<br />can't hallucinate
          </h1>
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
            {[
              'Sits on your dbt project — models and tests stay yours',
              'Questions route through certified blocks before AI writes SQL',
              'Every answer carries a trust label your stakeholders can read',
            ].map((line) => (
              <div key={line} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                <Check size={13} strokeWidth={2} color={t.success} style={{ flexShrink: 0, marginTop: 3 }} />
                <span style={{ fontSize: 13, color: t.textSecondary, lineHeight: 1.55 }}>{line}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, animation: 'dql-setup-float 4s ease-in-out infinite' }}>
          <div style={{ border: `1px solid ${t.tableBorder}`, borderRadius: 12, background: t.cellBg, padding: '12px 14px', boxShadow: '0 8px 28px rgba(26,26,26,0.06)' }}>
            <div style={{ background: t.pillBg, borderRadius: '12px 12px 3px 12px', padding: '7px 11px', fontSize: 11.5, color: t.textPrimary, width: 'fit-content', marginLeft: 'auto' }}>
              What was revenue last quarter?
            </div>
            <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', gap: 6 }}>
              <ShieldCheck size={12} strokeWidth={2} color={t.success} />
              <span style={{ fontSize: 10, fontWeight: 700, color: t.success, background: hexToRgba(t.success, 0.12), border: `1px solid ${hexToRgba(t.success, 0.3)}`, borderRadius: 999, padding: '1.5px 8px' }}>
                Certified
              </span>
              <span style={{ fontSize: 10, color: t.textMuted }}>from total_revenue · 0.3s</span>
            </div>
            <div style={{ marginTop: 6, fontSize: 13, color: t.textPrimary }}>
              Q2 revenue was <strong>$4.82M</strong>, up 6.4% from Q1.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'flex-end', fontSize: 10.5, color: t.textMuted, paddingRight: 4 }}>
            <Network size={11} strokeWidth={1.75} color={t.accent} />
            Traceable from source table to this answer
          </div>
        </div>
      </div>

      {/* chapter 01 */}
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#b0b2ba', fontFamily: t.fontMono }}>01</span>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: t.textPrimary, letterSpacing: '-0.01em' }}>How a question becomes a trusted answer</div>
          <div style={{ fontSize: 12, color: t.textMuted, marginTop: 2 }}>Five stages, one direction.</div>
        </div>
      </div>
      <div style={{ border: `1px solid ${t.tableBorder}`, borderRadius: 14, background: t.cellBg, padding: '22px 20px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 26px 1fr 26px 1fr 26px 1fr 26px 1fr', alignItems: 'stretch' }}>
          {stages.map((s, i) => (
            <React.Fragment key={s.title}>
              {i > 0 && arrow}
              <div style={{ border: `1.5px solid ${stageBorder(s.tint)}`, borderRadius: 10, background: stageBg(s.tint), padding: '11px 10px', textAlign: 'center' }}>
                <div style={{ width: 26, height: 26, borderRadius: 7, background: hexToRgba(s.color, 0.12), color: s.color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                  {s.icon}
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary, marginTop: 6 }}>{s.title}</div>
                <div style={{ fontSize: 10, color: t.textMuted, lineHeight: 1.45, marginTop: 3 }}>{s.body}</div>
              </div>
            </React.Fragment>
          ))}
        </div>
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                flex: 1,
                height: 5,
                borderRadius: 999,
                background: `linear-gradient(90deg, ${hexToRgba(BLUE, 0.35)}, ${hexToRgba('#0a6b5e', 0.4)}, ${hexToRgba(t.accent, 0.5)}, ${hexToRgba(t.warning, 0.4)}, ${hexToRgba(t.success, 0.45)}, ${hexToRgba(BLUE, 0.35)})`,
                backgroundSize: '200% 100%',
                animation: 'dql-setup-flowrail 5s linear infinite',
              }}
            />
            <span style={{ fontSize: 10, color: t.textMuted, whiteSpace: 'nowrap' }}>Lineage — trace any number from source to app, across domains</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, height: 5, borderRadius: 999, background: `repeating-linear-gradient(90deg, ${t.scrollbarThumb} 0 14px, transparent 14px 20px)`, animation: 'dql-setup-gitdash 1.6s linear infinite' }} />
            <span style={{ fontSize: 10, color: t.textMuted, whiteSpace: 'nowrap' }}>Everything Git-versioned — branch, review, approve like code</span>
          </div>
        </div>
      </div>

      {/* chapter 03 */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#b0b2ba', fontFamily: t.fontMono }}>02</span>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: t.textPrimary, letterSpacing: '-0.01em' }}>Why it holds up in the boardroom</div>
          <div style={{ fontSize: 12, color: t.textMuted, marginTop: 2 }}>Four guarantees behind every number.</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        {guarantees.map((g) => (
          <div key={g.title} style={{ border: `1px solid ${t.tableBorder}`, borderRadius: 11, background: t.cellBg, padding: '12px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 700, color: t.textPrimary }}>
              {g.icon}
              {g.title}
            </div>
            <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.5, marginTop: 4 }}>{g.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
