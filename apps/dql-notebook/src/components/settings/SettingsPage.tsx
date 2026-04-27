import React, { useEffect, useMemo, useState } from 'react';
import { api, type SettingsEnvGroup } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';

const dockerExample = `ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-1.5-pro
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_MODEL=llama3.1
DQL_SLACK_WEBHOOK=https://hooks.slack.com/services/...
SLACK_SIGNING_SECRET=...
SLACK_BOT_TOKEN=xoxb-...
DQL_SMTP_URL=smtp://user:pass@smtp.example.com:587
DQL_SMTP_FROM=dql@example.com`;

export function SettingsPage() {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const [groups, setGroups] = useState<SettingsEnvGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getSettingsEnvStatus()
      .then((res) => {
        if (!cancelled) setGroups(res.groups);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const summary = useMemo(() => {
    const vars = groups.flatMap((g) => g.vars);
    const configured = vars.filter((v) => v.present).length;
    return { configured, total: vars.length };
  }, [groups]);

  async function copyExample() {
    try {
      await navigator.clipboard.writeText(dockerExample);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 1080 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Environment Setup</div>
          <div style={{ color: t.textSecondary, fontSize: 13, marginTop: 6, lineHeight: 1.5, maxWidth: 760 }}>
            Configure AI providers, Slack delivery, email schedules, and runtime options from your shell,
            Docker Compose, or a local .env file. DQL never exposes secret values in the browser.
          </div>
        </div>
        <div
          style={{
            border: `1px solid ${t.headerBorder}`,
            borderRadius: 8,
            padding: '10px 12px',
            minWidth: 132,
            textAlign: 'right',
            background: t.cellBg,
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 700 }}>{summary.configured}/{summary.total}</div>
          <div style={{ fontSize: 12, color: t.textSecondary }}>configured</div>
        </div>
      </div>

      {loading ? (
        <div style={{ marginTop: 24, color: t.textSecondary }}>Loading settings...</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14, marginTop: 22 }}>
          {groups.map((group) => (
            <section
              key={group.id}
              style={{
                border: `1px solid ${t.headerBorder}`,
                borderRadius: 8,
                background: t.cellBg,
                overflow: 'hidden',
              }}
            >
              <div style={{ padding: '14px 14px 10px', borderBottom: `1px solid ${t.headerBorder}` }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{group.title}</div>
                <div style={{ color: t.textSecondary, fontSize: 12, lineHeight: 1.45, marginTop: 4 }}>{group.description}</div>
              </div>
              <div>
                {group.vars.map((item) => (
                  <div
                    key={item.key}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto',
                      gap: 10,
                      padding: '11px 14px',
                      borderBottom: `1px solid ${t.headerBorder}`,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <code style={{ fontSize: 12, color: t.textPrimary }}>{item.key}</code>
                        <span style={{ color: t.textSecondary, fontSize: 12 }}>{item.label}</span>
                      </div>
                      <div style={{ color: t.textSecondary, fontSize: 12, lineHeight: 1.4, marginTop: 4 }}>
                        {item.description}
                      </div>
                    </div>
                    <StatusPill present={item.present} />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <section
        style={{
          border: `1px solid ${t.headerBorder}`,
          borderRadius: 8,
          background: t.cellBg,
          marginTop: 18,
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderBottom: `1px solid ${t.headerBorder}` }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Docker Compose / .env Example</div>
            <div style={{ color: t.textSecondary, fontSize: 12, marginTop: 4 }}>
              Leave unused values blank. Provider-specific errors only appear when that provider is selected.
            </div>
          </div>
          <button
            type="button"
            onClick={copyExample}
            style={{
              height: 30,
              border: `1px solid ${t.headerBorder}`,
              background: t.appBg,
              color: t.textPrimary,
              borderRadius: 6,
              padding: '0 10px',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            fontSize: 12,
            overflow: 'auto',
            color: t.textPrimary,
            background: t.appBg,
          }}
        >
          {dockerExample}
        </pre>
      </section>
    </div>
  );
}

function StatusPill({ present }: { present: boolean }) {
  return (
    <span
      style={{
        alignSelf: 'start',
        fontSize: 11,
        fontWeight: 700,
        borderRadius: 999,
        padding: '3px 8px',
        color: present ? '#12613a' : '#7a4a00',
        background: present ? '#d9f8e6' : '#fff0cc',
        whiteSpace: 'nowrap',
      }}
    >
      {present ? 'Set' : 'Optional'}
    </span>
  );
}
