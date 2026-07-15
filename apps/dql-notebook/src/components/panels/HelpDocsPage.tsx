import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Blocks, Check, Database, GitBranch, GitPullRequest, Image, MessageCircle, Sparkles, type LucideIcon } from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { ReferencePanel } from './ReferencePanel';

const DOC_SECTIONS = [
  ['installation', 'Installation', '3 min'],
  ['database', 'Connect your database', '4 min'],
  ['dbt', 'Sync your dbt project', '2 min'],
  ['block', 'Create your first block', '5 min'],
  ['ask', 'Ask your first question', '3 min'],
  ['share', 'Share your work', '3 min'],
  ['troubleshooting', 'Troubleshooting', '—'],
  ['reference', 'Technical reference', 'Reference'],
] as const;

export function HelpDocsPage() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<(typeof DOC_SECTIONS)[number][0]>('installation');
  const [helpful, setHelpful] = useState<'yes' | 'no' | null>(null);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible?.target.id) setActive(visible.target.id as (typeof DOC_SECTIONS)[number][0]);
    }, { root, rootMargin: '-12% 0px -72% 0px', threshold: [0, 0.1, 0.5] });
    for (const [id] of DOC_SECTIONS) {
      const element = root.querySelector(`#${id}`);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);

  const navigate = (id: (typeof DOC_SECTIONS)[number][0]) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActive(id);
  };
  const openSettings = (tab: 'database' | 'ai') => {
    dispatch({ type: 'SET_SETTINGS_TAB', tab });
    dispatch({ type: 'SET_MAIN_VIEW', view: 'settings' });
  };

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden', background: t.appBg }}>
      <style>{`@media (max-width: 760px) { .dql-help-toc { display: none !important; } .dql-help-article { width: min(680px, calc(100% - 32px)) !important; padding-top: 24px !important; } }`}</style>
      <aside className="dql-help-toc" style={{ width: 'clamp(200px, 18vw, 252px)', flexShrink: 0, borderRight: `1px solid ${t.headerBorder}`, background: t.cellBg, padding: '16px 8px', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        <div style={{ padding: '0 10px 8px', fontSize: 10, fontWeight: 750, letterSpacing: '0.06em', textTransform: 'uppercase', color: t.textMuted }}>Getting started</div>
        <nav aria-label="Documentation contents" style={{ display: 'grid', gap: 2 }}>
          {DOC_SECTIONS.map(([id, label, mins], index) => <button key={id} type="button" onClick={() => navigate(id)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 'none', borderRadius: 7, background: active === id ? `${t.accent}16` : 'transparent', color: active === id ? t.accent : t.textSecondary, padding: '6.5px 10px', fontSize: 12, fontWeight: active === id ? 700 : 550, fontFamily: t.font, cursor: 'pointer', textAlign: 'left' }}><span aria-hidden="true" style={{ width: 18, height: 18, borderRadius: 5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, background: active === id ? `${t.accent}1f` : t.inputBg, color: active === id ? t.accent : t.textMuted, font: `700 9.5px ${t.fontMono}` }}>{String(index + 1).padStart(2, '0')}</span><span style={{ flex: 1 }}>{label}</span><span style={{ color: t.textMuted, fontSize: 9.5 }}>{mins}</span></button>)}
        </nav>
        <div style={{ height: 1, background: t.headerBorder, margin: '12px 10px' }} />
        <div style={{ padding: '0 10px', display: 'grid', gap: 7, fontSize: 11.5 }}>
          <button type="button" onClick={() => navigate('reference')} style={linkStyle(t)}>Keyboard shortcuts</button>
          <button type="button" onClick={() => navigate('reference')} style={linkStyle(t)}>CLI reference</button>
          <button type="button" onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'ask' })} style={linkStyle(t)}>Community &amp; support</button>
        </div>
        <div style={{ marginTop: 'auto', border: `1px solid ${t.headerBorder}`, borderRadius: 9, background: t.inputBg, padding: 11 }}>
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', color: t.textPrimary, fontSize: 11.5, fontWeight: 700 }}><Sparkles size={13} color={t.accent} /> Stuck?</div>
          <div style={{ color: t.textMuted, fontSize: 10.5, lineHeight: 1.45, marginTop: 5 }}>Ask the assistant. It can use your project context while you work through setup.</div>
          <button type="button" onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'ask' })} style={{ marginTop: 8, border: 'none', background: 'transparent', color: t.accent, padding: 0, fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>Ask about setup →</button>
        </div>
      </aside>

      <div ref={scrollRef} style={{ flex: 1, minWidth: 0, overflow: 'auto', scrollBehavior: 'smooth' }}>
        <article className="dql-help-article" style={{ width: 'min(680px, calc(100% - 56px))', margin: '0 auto', padding: '34px 0 80px', color: t.textSecondary }}>
          <div style={{ color: t.accent, fontSize: 11, fontWeight: 750, letterSpacing: '0.07em', textTransform: 'uppercase' }}>Guide</div>
          <h1 style={{ margin: '7px 0 0', color: t.textPrimary, fontSize: 28, lineHeight: 1.25, letterSpacing: '-0.02em' }}>Getting started with DQL</h1>
          <p style={{ margin: '8px 0 28px', fontSize: 13.5, lineHeight: 1.65, color: t.textMuted }}>From install to your first governed answer — about 20 minutes. Updated July 2026 · v1.3</p>

          <DocSection id="installation" number="01" title="Installation" t={t}>
            <p>Install the CLI, initialize a DQL folder beside or inside your dbt repo, then launch the built workbench.</p>
            <Code code={'npm install -g @duckcodeailabs/dql-cli\ndql init ./dql\ndql compile ./dql\ndql notebook ./dql'} t={t} />
            <Callout t={t}><strong>Requirements:</strong>&nbsp; Node 20+, git, and a dbt project. DQL bundles its supported database drivers.</Callout>
            <ImageSlot label="Terminal after the DQL workbench opens" caption="The workbench opens locally with your project loaded." t={t} />
            <Action onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'home' })} label="Open guided setup" t={t} />
          </DocSection>

          <DocSection id="database" number="02" title="Connect your database" Icon={Database} t={t}>
            <p>Open Settings → Database. Import a dbt profile target or add DuckDB, Snowflake, or Databricks directly, then run the read-only connection test.</p>
            <Callout t={t}>Credentials remain in local DQL state and are never shown back in raw form.</Callout>
            <ImageSlot label="Database settings with a passing connection test" caption="A successful test reports the connection status before Save is enabled." t={t} />
            <Action onClick={() => openSettings('database')} label="Open database settings" t={t} />
          </DocSection>

          <DocSection id="dbt" number="03" title="Sync your dbt project" Icon={GitBranch} t={t}>
            <p>Run dbt first, then compile DQL. DQL reads models, descriptions, tests, groups, owners, lineage, and MetricFlow artifacts; dbt keeps ownership of that metadata.</p>
            <Code code={'dbt build\ndql compile ./dql\ndql sync dbt ./dql'} t={t} />
            <Action onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'modeling' })} label="Open Domain Studio" t={t} />
          </DocSection>

          <DocSection id="block" number="04" title="Create your first block" Icon={Blocks} t={t}>
            <p>Blocks are reusable governed questions. Start from Ask AI, import existing SQL, or use the visual builder. Preview the result, add runtime parameters and tests, then save a draft for review.</p>
            <ol style={{ paddingLeft: 20, lineHeight: 1.7 }}><li>Choose a semantic metric or trusted source.</li><li>Declare grain, dimensions, filters, and outputs.</li><li>Run the block and review its SQL, lineage, parameters, and tests.</li><li>Save and certify only after the evidence is sound.</li></ol>
            <ImageSlot label="Visual Builder with the semantic picker open" caption="Search certified measures and dimensions without writing SQL." t={t} />
            <Action onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'block_studio' })} label="Open Block Studio" t={t} />
          </DocSection>

          <DocSection id="ask" number="05" title="Ask your first question" Icon={MessageCircle} t={t}>
            <p>Ask routes through certified blocks first, semantic metrics next, and generated SQL only when needed. Result cards show the trust state, sources, and steps used to answer.</p>
            <TrustTable t={t} />
            <Callout t={t}>Select any text or table cells in an answer to quote that evidence into a follow-up question.</Callout>
            <Action onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'ask' })} label="Open Ask AI" t={t} />
          </DocSection>

          <DocSection id="share" number="06" title="Share your work" Icon={GitPullRequest} t={t}>
            <p>Everything you author is a file in Git. Source Control lets you pick changes, describe them in plain language, share to a review branch, and open a pull request. Nothing merges automatically.</p>
            <ImageSlot label="Source Control guided share flow" caption="Pick, describe, share, then ask for review." t={t} />
            <Action onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'git' })} label="Open Source Control" t={t} />
          </DocSection>

          <DocSection id="troubleshooting" number="07" title="Troubleshooting" Icon={AlertTriangle} t={t}>
            <Trouble title="No dbt models appear" body="Run dbt parse or dbt build, verify the manifest path in dql.config.json, then run dql compile again." t={t} />
            <Trouble title="A block cannot run" body="Test the selected database connection and confirm every runtime parameter has a value of the declared type." t={t} />
            <Trouble title="Ask has limited context" body="Connect an AI provider, compile the dbt snapshot, and add reviewed domain skills or certified blocks for the question's domain." t={t} />
          </DocSection>

          <div style={{ margin: '16px 0 28px', borderTop: `1px solid ${t.headerBorder}`, paddingTop: 18, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, color: t.textMuted }}>{helpful ? 'Thanks for the feedback.' : 'Was this guide helpful?'}</span>
            <FeedbackButton label="Yes" selected={helpful === 'yes'} color={t.success} onClick={() => setHelpful('yes')} t={t} />
            <FeedbackButton label="Not quite" selected={helpful === 'no'} color={t.error} onClick={() => setHelpful('no')} t={t} />
            <button type="button" onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'modeling' })} style={{ ...linkStyle(t), marginLeft: 'auto' }}>Next: Modeling your domains →</button>
          </div>

          <section id="reference" style={{ scrollMarginTop: 24, paddingTop: 28, borderTop: `1px solid ${t.headerBorder}` }}>
            <ReferencePanel themeMode={state.themeMode} />
          </section>
        </article>
      </div>
    </div>
  );
}

function DocSection({ id, number, title, Icon, t, children }: { id: string; number: string; title: string; Icon?: LucideIcon; t: Theme; children: React.ReactNode }) {
  return <section id={id} style={{ scrollMarginTop: 24, padding: '28px 0', borderTop: `1px solid ${t.headerBorder}`, fontSize: 13, lineHeight: 1.65 }}><h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 9, color: t.textPrimary, fontSize: 20, letterSpacing: '-0.01em' }}><span style={{ color: t.textMuted, fontFamily: t.fontMono, fontSize: 14 }}>{number}</span>{Icon && <Icon size={17} color={t.accent} />}{title}</h2><div style={{ marginTop: 11 }}>{children}</div></section>;
}

function Code({ code, t }: { code: string; t: Theme }) {
  return <pre style={{ margin: '12px 0', padding: '13px 16px', border: `1px solid ${t.headerBorder}`, borderRadius: 10, background: '#1e1c26', color: '#e8e6f0', font: `12.5px/1.7 ${t.fontMono}`, overflowX: 'auto' }}>{code}</pre>;
}

function Action({ onClick, label, t }: { onClick: () => void; label: string; t: Theme }) {
  return <button type="button" onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginTop: 8, border: `1px solid ${t.accent}`, borderRadius: 8, background: t.accent, color: '#fff', padding: '7px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>{label} →</button>;
}

function Callout({ t, children }: { t: Theme; children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '12px 0', border: `1px solid ${t.success}40`, borderRadius: 9, background: `${t.success}0d`, color: t.textSecondary, padding: '10px 12px', fontSize: 12 }}><Check size={14} color={t.success} style={{ marginTop: 2, flexShrink: 0 }} />{children}</div>;
}

function Trouble({ title, body, t }: { title: string; body: string; t: Theme }) {
  return <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 9, background: t.cellBg, padding: '10px 12px', marginTop: 8 }}><strong style={{ color: t.textPrimary }}>{title}</strong><div style={{ color: t.textMuted, fontSize: 12, marginTop: 3 }}>{body}</div></div>;
}

function ImageSlot({ label, caption, t }: { label: string; caption: string; t: Theme }) {
  return <figure style={{ margin: '16px 0 14px' }}><div role="img" aria-label={label} style={{ height: 190, border: `1px dashed ${t.inputBorder}`, borderRadius: 10, background: t.inputBg, display: 'grid', placeItems: 'center', color: t.textMuted }}><div style={{ display: 'grid', justifyItems: 'center', gap: 8 }}><Image size={24} strokeWidth={1.5} /><span style={{ fontSize: 11.5 }}>{label}</span></div></div><figcaption style={{ marginTop: 6, textAlign: 'center', color: t.textMuted, fontSize: 11.5 }}>{caption}</figcaption></figure>;
}

function TrustTable({ t }: { t: Theme }) {
  const rows = [
    ['Certified', 'Answered from a certified block — immediate and reviewed.', t.success],
    ['Governed', 'Composed from semantic metrics and proven joins.', t.accent],
    ['AI-generated', 'Fresh SQL grounded in the schema, verified, and clearly labeled.', t.warning],
  ] as const;
  return <div style={{ margin: '14px 0', border: `1px solid ${t.headerBorder}`, borderRadius: 10, overflow: 'hidden', background: t.cellBg }}>{rows.map(([label, description, color], index) => <div key={label} style={{ display: 'grid', gridTemplateColumns: '110px 1fr', borderBottom: index < rows.length - 1 ? `1px solid ${t.headerBorder}` : 'none', fontSize: 12.5 }}><div style={{ padding: '9px 13px', background: t.inputBg, color, fontWeight: 700 }}>{label}</div><div style={{ padding: '9px 13px', color: t.textSecondary }}>{description}</div></div>)}</div>;
}

function FeedbackButton({ label, selected, color, onClick, t }: { label: string; selected: boolean; color: string; onClick: () => void; t: Theme }) {
  return <button type="button" aria-pressed={selected} onClick={onClick} style={{ height: 26, padding: '0 11px', borderRadius: 999, border: `1px solid ${selected ? color : t.inputBorder}`, background: selected ? `${color}12` : t.cellBg, color: selected ? color : t.textSecondary, fontSize: 11.5, fontWeight: 600, fontFamily: t.font, cursor: 'pointer' }}>{label}</button>;
}

function linkStyle(t: Theme): React.CSSProperties {
  return { border: 'none', background: 'transparent', color: t.accent, padding: 0, fontSize: 11.5, fontFamily: t.font, cursor: 'pointer', textAlign: 'left' };
}
