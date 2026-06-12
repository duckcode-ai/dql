import type { Theme } from '../../themes/notebook-theme';
import React from 'react';
import {
  ArrowRight,
  Bot,
  Blocks,
  BookOpenText,
  Database,
  FileJson,
  GitBranch,
  Network,
  Play,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { NotebookFile, SidebarPanel } from '../../store/types';

const VALUE_SECTIONS = [
  {
    title: 'Language',
    heading: 'Domain Query Language',
    body: 'DQL puts business context next to SQL: domain, owner, terms, tests, decision use, and review cadence.',
    Icon: BookOpenText,
    tone: 'var(--color-accent-blue)',
  },
  {
    title: 'Composition',
    heading: 'Blocks to business views',
    body: 'Single SQL answers become reusable blocks, then business_view files compose them into Customer 360 and other decision surfaces.',
    Icon: Workflow,
    tone: 'var(--color-accent-yellow)',
  },
  {
    title: 'Trust',
    heading: 'Lineage and manifest',
    body: 'Compile once into dql-manifest.json so people and agents can trace source data, dbt models, blocks, apps, and dashboards.',
    Icon: ShieldCheck,
    tone: 'var(--color-accent-green)',
  },
];

const FLOW_NODES = [
  { label: 'Source', detail: 'tables, files', Icon: Database, tone: 'var(--color-accent-blue)' },
  { label: 'Model', detail: 'dbt, semantic', Icon: GitBranch, tone: 'var(--color-accent-cyan)' },
  { label: 'Block', detail: 'SQL + meaning', Icon: Blocks, tone: 'var(--color-accent-green)' },
  { label: 'View', detail: 'business_view', Icon: Workflow, tone: 'var(--color-accent-yellow)' },
  { label: 'Use', detail: 'apps, AI, teams', Icon: Bot, tone: 'var(--color-accent-purple)' },
];

const STRUCTURE_ITEMS = [
  ['blocks/', 'Reusable SQL and semantic blocks'],
  ['terms/', 'Shared business vocabulary'],
  ['business-views/', 'Compositions that model outcomes'],
  ['notebooks/', 'Analysis workspaces and stories'],
  ['apps/', 'Published consumption surfaces'],
  ['dql-manifest.json', 'Compiled lineage and AI context'],
];

export function HomePage() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const counts = countFiles(state.files);

  const openPanel = (panel: SidebarPanel) => {
    dispatch({ type: 'SET_SIDEBAR_PANEL', panel });
  };

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        overflow: 'auto',
        background: t.appBg,
      }}
    >
      <style>{HOME_PAGE_STYLES}</style>
      <main className="dql-home-page">
        <section className="dql-home-hero dql-home-reveal" style={{ borderColor: t.cellBorder, background: t.cellBg }}>
          <div className="dql-home-hero-copy">
            <div className="dql-home-brand-row">
              <span className="dql-home-logo">DQL</span>
              <span style={{ color: t.textSecondary }}>Domain Query Language</span>
            </div>
            <h1 style={{ color: t.textPrimary }}>DQL Workbench</h1>
            <p className="dql-home-lead" style={{ color: t.textSecondary }}>
              Build a Git-versioned domain layer where SQL, dbt lineage, business terms,
              business views, notebooks, dashboards, apps, and AI answers share the same
              trusted context.
            </p>
            <div className="dql-home-cta-row">
              <button
                className="dql-home-primary-btn"
                onClick={() => dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' })}
              >
                <Play size={15} strokeWidth={2.2} aria-hidden="true" />
                Start workbench
              </button>
              <button className="dql-home-secondary-btn" onClick={() => dispatch({ type: 'OPEN_NEW_BLOCK_MODAL' })}>
                <Blocks size={15} strokeWidth={2} aria-hidden="true" />
                Create block
              </button>
              <button className="dql-home-secondary-btn" onClick={() => openPanel('lineage')}>
                <Network size={15} strokeWidth={2} aria-hidden="true" />
                Browse lineage
              </button>
            </div>
          </div>

          <div className="dql-home-flow" aria-label="DQL lineage flow">
            <div className="dql-home-flow-header">
              <span style={{ color: t.textMuted }}>Lineage path</span>
              <span style={{ color: t.textSecondary }}>technical {'->'} business {'->'} consumption</span>
            </div>
            <div className="dql-home-flow-track">
              {FLOW_NODES.map((node, index) => (
                <React.Fragment key={node.label}>
                  <FlowNode {...node} t={t} />
                  {index < FLOW_NODES.length - 1 && <span className="dql-home-flow-line" aria-hidden="true" />}
                </React.Fragment>
              ))}
            </div>
            <div className="dql-home-manifest-strip" style={{ borderColor: t.cellBorder, background: t.inputBg }}>
              <FileJson size={15} strokeWidth={2} color="var(--color-accent-blue)" aria-hidden="true" />
              <span style={{ color: t.textPrimary }}>dql-manifest.json</span>
              <span style={{ color: t.textMuted }}>the local source of truth for lineage, trust, and agent context</span>
            </div>
          </div>
        </section>

        <section className="dql-home-stats" aria-label="Current project summary">
          <Stat label="Notebooks" value={counts.notebooks} t={t} />
          <Stat label="Blocks" value={counts.blocks} t={t} />
          <Stat label="Business terms" value={counts.terms} t={t} />
          <Stat label="Business views" value={counts.businessViews} t={t} />
        </section>

        <section className="dql-home-grid">
          {VALUE_SECTIONS.map((section, index) => (
            <ValueSection key={section.heading} {...section} delay={index} t={t} />
          ))}
        </section>

        <section className="dql-home-bottom">
          <div className="dql-home-structure" style={{ borderColor: t.cellBorder, background: t.cellBg }}>
            <div>
              <h2 style={{ color: t.textPrimary }}>Project structure that ships out of the box</h2>
              <p style={{ color: t.textSecondary }}>
                DQL stays OSS-friendly and file-first. Every artifact is reviewable,
                versioned, and compiled into the same manifest.
              </p>
            </div>
            <div className="dql-home-file-list">
              {STRUCTURE_ITEMS.map(([name, description]) => (
                <div key={name} className="dql-home-file-row" style={{ borderColor: t.cellBorder }}>
                  <code style={{ color: t.textPrimary }}>{name}</code>
                  <span style={{ color: t.textSecondary }}>{description}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="dql-home-next" style={{ borderColor: t.cellBorder, background: t.cellBg }}>
            <h2 style={{ color: t.textPrimary }}>What DQL makes different</h2>
            <p style={{ color: t.textSecondary }}>
              Most tools stop at technical lineage. DQL adds the missing business
              lineage layer: where an answer starts, how it becomes a business
              block, where it is composed, and where it is consumed.
            </p>
            <button className="dql-home-link-btn" onClick={() => openPanel('reference')}>
              Open language reference
              <ArrowRight size={15} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

function FlowNode({
  label,
  detail,
  Icon,
  tone,
  t,
}: {
  label: string;
  detail: string;
  Icon: LucideIcon;
  tone: string;
  t: Theme;
}) {
  return (
    <div className="dql-home-flow-node" style={{ borderColor: t.cellBorder, background: t.inputBg }}>
      <Icon size={17} strokeWidth={2} color={tone} aria-hidden="true" />
      <strong style={{ color: t.textPrimary }}>{label}</strong>
      <span style={{ color: t.textMuted }}>{detail}</span>
    </div>
  );
}

function ValueSection({
  title,
  heading,
  body,
  Icon,
  tone,
  delay,
  t,
}: {
  title: string;
  heading: string;
  body: string;
  Icon: LucideIcon;
  tone: string;
  delay: number;
  t: Theme;
}) {
  return (
    <article
      className="dql-home-value dql-home-reveal"
      style={{
        borderColor: t.cellBorder,
        background: t.cellBg,
        animationDelay: `${delay * 90}ms`,
      }}
    >
      <div className="dql-home-value-icon" style={{ color: tone, background: `${tone}16` }}>
        <Icon size={20} strokeWidth={2} aria-hidden="true" />
      </div>
      <span style={{ color: t.textMuted }}>{title}</span>
      <h2 style={{ color: t.textPrimary }}>{heading}</h2>
      <p style={{ color: t.textSecondary }}>{body}</p>
    </article>
  );
}

function Stat({ label, value, t }: { label: string; value: number; t: Theme }) {
  return (
    <div className="dql-home-stat" style={{ borderColor: t.cellBorder, background: t.cellBg }}>
      <strong style={{ color: t.textPrimary }}>{value}</strong>
      <span style={{ color: t.textMuted }}>{label}</span>
    </div>
  );
}

function countFiles(files: NotebookFile[]) {
  return files.reduce(
    (acc, file) => {
      if (file.type === 'block') acc.blocks += 1;
      else if (file.type === 'term') acc.terms += 1;
      else if (file.type === 'business_view') acc.businessViews += 1;
      else if (file.type === 'notebook' || file.type === 'workbook') acc.notebooks += 1;
      return acc;
    },
    { notebooks: 0, blocks: 0, terms: 0, businessViews: 0 },
  );
}

const HOME_PAGE_STYLES = `
.dql-home-page {
  width: min(1180px, calc(100% - 48px));
  margin: 0 auto;
  padding: 30px 0 44px;
}

.dql-home-hero {
  display: grid;
  grid-template-columns: minmax(320px, 0.95fr) minmax(420px, 1.05fr);
  gap: 28px;
  align-items: stretch;
  border: 1px solid;
  border-radius: 8px;
  padding: 28px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
}

.dql-home-hero-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 20px;
}

.dql-home-brand-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
}

.dql-home-logo {
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  background: var(--color-accent-blue);
  color: var(--accent-on, #fff);
  font-weight: 900;
  font-family: var(--font-mono);
}

.dql-home-hero h1 {
  margin: 0;
  font-size: clamp(38px, 6vw, 76px);
  line-height: 0.94;
  font-weight: 900;
  letter-spacing: 0;
  overflow-wrap: break-word;
}

.dql-home-lead {
  max-width: 680px;
  margin: 0;
  font-size: 17px;
  line-height: 1.6;
}

.dql-home-cta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.dql-home-primary-btn,
.dql-home-secondary-btn,
.dql-home-link-btn {
  height: 36px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 13px;
  border: 1px solid var(--color-border-primary);
  font: 800 12px var(--font-ui);
  cursor: pointer;
  max-width: 100%;
  transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
}

.dql-home-primary-btn {
  background: var(--color-accent-blue);
  color: var(--accent-on, #fff);
  border-color: var(--color-accent-blue);
}

.dql-home-secondary-btn,
.dql-home-link-btn {
  background: var(--color-bg-sunken);
  color: var(--color-text-secondary);
}

.dql-home-primary-btn:hover,
.dql-home-secondary-btn:hover,
.dql-home-link-btn:hover {
  transform: translateY(-1px);
  border-color: var(--color-accent-blue);
}

.dql-home-flow {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
  justify-content: center;
}

.dql-home-flow-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
}

.dql-home-flow-track {
  display: flex;
  gap: 8px;
  align-items: center;
}

.dql-home-flow-node {
  min-height: 118px;
  flex: 1 1 0;
  min-width: 0;
  border: 1px solid;
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  position: relative;
  z-index: 1;
}

.dql-home-flow-node strong {
  font-size: 14px;
}

.dql-home-flow-node span {
  font-size: 11px;
  line-height: 1.3;
}

.dql-home-flow-line {
  display: block;
  flex: 0 0 22px;
  height: 3px;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--color-accent-blue), var(--color-accent-green), var(--color-accent-yellow));
  background-size: 200% 100%;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent-blue) 12%, transparent);
  animation: dql-home-line-scan 4s linear infinite;
}

.dql-home-manifest-strip {
  min-height: 44px;
  border: 1px solid;
  border-radius: 8px;
  padding: 10px 12px;
  display: grid;
  grid-template-columns: 18px max-content 1fr;
  gap: 9px;
  align-items: center;
  font-size: 12px;
}

.dql-home-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.dql-home-stat {
  border: 1px solid;
  border-radius: 8px;
  padding: 14px;
}

.dql-home-stat strong {
  display: block;
  font-size: 28px;
  line-height: 1;
}

.dql-home-stat span {
  display: block;
  margin-top: 8px;
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
}

.dql-home-grid {
  margin-top: 14px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.dql-home-value {
  border: 1px solid;
  border-radius: 8px;
  padding: 18px;
  min-height: 230px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dql-home-value-icon {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.dql-home-value span {
  font-size: 11px;
  font-weight: 900;
  text-transform: uppercase;
}

.dql-home-value h2,
.dql-home-structure h2,
.dql-home-next h2 {
  margin: 0;
  font-size: 22px;
  line-height: 1.15;
}

.dql-home-value p,
.dql-home-structure p,
.dql-home-next p {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
}

.dql-home-bottom {
  margin-top: 14px;
  display: grid;
  grid-template-columns: minmax(420px, 1fr) minmax(320px, 0.72fr);
  gap: 14px;
}

.dql-home-structure,
.dql-home-next {
  border: 1px solid;
  border-radius: 8px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.dql-home-file-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.dql-home-file-row {
  border: 1px solid;
  border-radius: 6px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dql-home-file-row code {
  font: 800 12px var(--font-mono);
}

.dql-home-file-row span {
  font-size: 12px;
  line-height: 1.35;
}

.dql-home-reveal {
  animation: dql-home-reveal 420ms ease both;
}

@keyframes dql-home-reveal {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes dql-home-line-scan {
  from { background-position: 0% 0; }
  to { background-position: 200% 0; }
}

@media (max-width: 980px) {
  .dql-home-page {
    width: min(100% - 28px, 760px);
    padding-top: 20px;
  }

  .dql-home-hero,
  .dql-home-bottom {
    grid-template-columns: 1fr;
  }

  .dql-home-grid,
  .dql-home-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 700px) {
  .dql-home-flow-track {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .dql-home-flow-line {
    display: block;
    width: 3px;
    height: 22px;
    flex: 0 0 22px;
    align-self: center;
    background: linear-gradient(180deg, var(--color-accent-blue), var(--color-accent-green), var(--color-accent-yellow));
    background-size: 100% 200%;
  }

  .dql-home-flow-node {
    min-height: auto;
  }
}

@media (max-width: 620px) {
  .dql-home-page {
    width: min(100% - 16px, 520px);
  }

  .dql-home-hero {
    padding: 14px;
  }

  .dql-home-hero h1 {
    font-size: 32px;
    line-height: 1.02;
    overflow-wrap: anywhere;
  }

  .dql-home-lead {
    font-size: 14px;
  }

  .dql-home-primary-btn,
  .dql-home-secondary-btn,
  .dql-home-link-btn {
    width: 100%;
  }

  .dql-home-grid,
  .dql-home-stats,
  .dql-home-file-list {
    grid-template-columns: 1fr;
  }

  .dql-home-manifest-strip {
    grid-template-columns: 18px 1fr;
  }

  .dql-home-manifest-strip span:last-child {
    grid-column: 2;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dql-home-reveal,
  .dql-home-primary-btn,
  .dql-home-secondary-btn,
  .dql-home-link-btn {
    animation: none;
    transition: none;
  }
}
`;
