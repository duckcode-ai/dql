import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Blocks, Check, Database, GitBranch, GitPullRequest, MessageCircle, Search, Sparkles, type LucideIcon } from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { ReferencePanel } from './ReferencePanel';

const DOC_SECTIONS = [
  ['installation', 'Installation'],
  ['database', 'Connect your database'],
  ['dbt', 'Sync your dbt project'],
  ['block', 'Create your first block'],
  ['ask', 'Ask your first question'],
  ['share', 'Share your work'],
  ['troubleshooting', 'Troubleshooting'],
  ['reference', 'Technical reference'],
] as const;

export function HelpDocsPage() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<(typeof DOC_SECTIONS)[number][0]>('installation');
  const [query, setQuery] = useState('');

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

  const visibleSections = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? DOC_SECTIONS.filter(([, label]) => label.toLowerCase().includes(normalized)) : DOC_SECTIONS;
  }, [query]);

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
      <aside style={{ width: 'clamp(200px, 18vw, 252px)', flexShrink: 0, borderRight: `1px solid ${t.headerBorder}`, background: t.cellBg, padding: '14px 8px', display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto' }}>
        <div style={{ position: 'relative', margin: '0 2px 4px' }}>
          <Search size={13} aria-hidden="true" style={{ position: 'absolute', left: 9, top: 8, color: t.textMuted }} />
          <input aria-label="Search documentation" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the docs…" style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${t.inputBorder}`, background: t.inputBg, color: t.textPrimary, borderRadius: 7, padding: '7px 8px 7px 28px', fontSize: 12, outline: 'none' }} />
        </div>
        <div style={{ padding: '0 10px 3px', fontSize: 10, fontWeight: 750, letterSpacing: '0.06em', textTransform: 'uppercase', color: t.textMuted }}>Getting started</div>
        <nav aria-label="Documentation contents" style={{ display: 'grid', gap: 2 }}>
          {visibleSections.map(([id, label]) => <button key={id} type="button" onClick={() => navigate(id)} style={{ border: 'none', borderRadius: 7, background: active === id ? `${t.accent}16` : 'transparent', color: active === id ? t.accent : t.textSecondary, padding: '7px 10px', fontSize: 12.5, fontWeight: active === id ? 700 : 550, fontFamily: t.font, cursor: 'pointer', textAlign: 'left' }}>{label}</button>)}
          {visibleSections.length === 0 && <span style={{ padding: '8px 10px', color: t.textMuted, fontSize: 11.5 }}>No matching section.</span>}
        </nav>
        <div style={{ marginTop: 'auto', border: `1px solid ${t.headerBorder}`, borderRadius: 9, background: t.inputBg, padding: 11 }}>
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', color: t.textPrimary, fontSize: 11.5, fontWeight: 700 }}><Sparkles size={13} color={t.accent} /> Stuck?</div>
          <div style={{ color: t.textMuted, fontSize: 10.5, lineHeight: 1.45, marginTop: 5 }}>Ask the assistant. It can use your project context while you work through setup.</div>
          <button type="button" onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'ask' })} style={{ marginTop: 8, border: 'none', background: 'transparent', color: t.accent, padding: 0, fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>Ask about setup →</button>
        </div>
      </aside>

      <div ref={scrollRef} style={{ flex: 1, minWidth: 0, overflow: 'auto', scrollBehavior: 'smooth' }}>
        <article style={{ width: 'min(760px, calc(100% - 48px))', margin: '0 auto', padding: '34px 0 64px', color: t.textSecondary }}>
          <div style={{ color: t.accent, fontSize: 11, fontWeight: 750, letterSpacing: '0.07em', textTransform: 'uppercase' }}>Help & documentation</div>
          <h1 style={{ margin: '7px 0 0', color: t.textPrimary, fontSize: 28, lineHeight: 1.25, letterSpacing: '-0.02em' }}>Getting started with DQL</h1>
          <p style={{ margin: '10px 0 28px', fontSize: 13.5, lineHeight: 1.65, maxWidth: 650 }}>Connect dbt and a database, add an AI provider, then turn reviewed answers into governed blocks, notebooks, and Apps. Every step stays local and source controlled.</p>

          <DocSection id="installation" number="01" title="Installation" t={t}>
            <p>Install the CLI, initialize a DQL folder beside or inside your dbt repo, then launch the built workbench.</p>
            <Code code={'npm install -g @duckcodeailabs/dql-cli\ndql init ./dql\ndql compile ./dql\ndql notebook ./dql'} t={t} />
            <Action onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'home' })} label="Open guided setup" t={t} />
          </DocSection>

          <DocSection id="database" number="02" title="Connect your database" Icon={Database} t={t}>
            <p>Open Settings → Database. Import a dbt profile target or add DuckDB, Snowflake, or Databricks directly, then run the read-only connection test.</p>
            <Callout t={t}>Credentials remain in local DQL state and are never shown back in raw form.</Callout>
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
            <Action onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'block_studio' })} label="Open Block Studio" t={t} />
          </DocSection>

          <DocSection id="ask" number="05" title="Ask your first question" Icon={MessageCircle} t={t}>
            <p>Ask routes through certified blocks first, semantic metrics next, and generated SQL only when needed. Result cards show the trust state, sources, and steps used to answer.</p>
            <Callout t={t}>Select any text or table cells in an answer to quote that evidence into a follow-up question.</Callout>
            <Action onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'ask' })} label="Open Ask AI" t={t} />
          </DocSection>

          <DocSection id="share" number="06" title="Share your work" Icon={GitPullRequest} t={t}>
            <p>Everything you author is a file in Git. Source Control lets you pick changes, describe them in plain language, share to a review branch, and open a pull request. Nothing merges automatically.</p>
            <Action onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'git' })} label="Open Source Control" t={t} />
          </DocSection>

          <DocSection id="troubleshooting" number="07" title="Troubleshooting" Icon={AlertTriangle} t={t}>
            <Trouble title="No dbt models appear" body="Run dbt parse or dbt build, verify the manifest path in dql.config.json, then run dql compile again." t={t} />
            <Trouble title="A block cannot run" body="Test the selected database connection and confirm every runtime parameter has a value of the declared type." t={t} />
            <Trouble title="Ask has limited context" body="Connect an AI provider, compile the dbt snapshot, and add reviewed domain skills or certified blocks for the question's domain." t={t} />
          </DocSection>

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
  return <pre style={{ margin: '12px 0', padding: '12px 14px', border: `1px solid ${t.headerBorder}`, borderRadius: 9, background: t.editorBg, color: t.textPrimary, font: `11.5px/1.7 ${t.fontMono}`, overflowX: 'auto' }}>{code}</pre>;
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
