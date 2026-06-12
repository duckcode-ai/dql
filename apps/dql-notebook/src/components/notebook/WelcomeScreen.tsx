import type { Theme } from '../../themes/notebook-theme';
import React, { useState } from 'react';
import {
  BookOpenText,
  Bot,
  Blocks,
  Database,
  FileText,
  GitBranch,
  Network,
  Plus,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { NotebookFile, SidebarPanel } from '../../store/types';

interface WelcomeScreenProps {
  onOpenFile: (file: NotebookFile) => void;
}

const WORKFLOW_STEPS = [
  {
    label: '1. Connect data',
    detail: 'Use DuckDB, warehouse tables, dbt artifacts, or local files as the technical base.',
    Icon: Database,
    tone: 'var(--color-accent-blue)',
    toneBg: 'var(--color-accent-blue-soft)',
  },
  {
    label: '2. Create blocks',
    detail: 'Wrap SQL or semantic queries with domain, owner, tests, and business meaning.',
    Icon: Blocks,
    tone: 'var(--color-accent-green)',
    toneBg: 'var(--color-accent-green-soft)',
  },
  {
    label: '3. Compose business views',
    detail: 'Group blocks and terms into Customer 360, Growth Pulse, and other decision views.',
    Icon: Workflow,
    tone: 'var(--color-accent-yellow)',
    toneBg: 'var(--color-accent-yellow-soft)',
  },
  {
    label: '4. Trace and reuse',
    detail: 'Compile one manifest for lineage, notebooks, dashboards, apps, and AI context.',
    Icon: Network,
    tone: 'var(--color-accent-purple)',
    toneBg: 'var(--color-accent-purple-soft)',
  },
];

const VALUE_CARDS = [
  {
    label: 'Domain-first analytics',
    detail: 'DQL names the business domain, owner, status, and decision use next to the query.',
    Icon: ShieldCheck,
  },
  {
    label: 'Business + technical lineage',
    detail: 'Follow the chain from source tables and dbt models into blocks, views, apps, and dashboards.',
    Icon: Network,
  },
  {
    label: 'Git-versioned work',
    detail: 'Blocks, terms, notebooks, and business views are plain files that can be reviewed and released.',
    Icon: GitBranch,
  },
  {
    label: 'AI-ready context',
    detail: 'Agents can answer with the same manifest, definitions, lineage, and certified blocks humans use.',
    Icon: Bot,
  },
];

export function WelcomeScreen({ onOpenFile }: WelcomeScreenProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const recentFiles = state.files.slice(0, 5);

  const openPanel = (panel: SidebarPanel) => {
    dispatch({ type: 'SET_SIDEBAR_PANEL', panel });
  };

  return (
    <div
      style={{
        flex: 1,
        background: t.appBg,
        overflow: 'auto',
        padding: '22px 24px 36px',
      }}
    >
      <div
        style={{
          maxWidth: 1180,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))',
            gap: 14,
            alignItems: 'stretch',
          }}
        >
          <div
            style={{
              border: `1px solid ${t.cellBorder}`,
              borderRadius: 8,
              background: t.cellBg,
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span
                style={{
                  height: 26,
                  padding: '0 9px',
                  borderRadius: 5,
                  display: 'inline-flex',
                  alignItems: 'center',
                  background: 'var(--color-accent-blue)',
                  color: 'var(--accent-on, #fff)',
                  fontSize: 11,
                  fontWeight: 800,
                  fontFamily: t.fontMono,
                }}
              >
                DQL
              </span>
              <span
                style={{
                  color: t.textSecondary,
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: 0,
                  textTransform: 'uppercase',
                }}
              >
                Domain Query Language
              </span>
              <span
                style={{
                  border: `1px solid ${t.cellBorder}`,
                  borderRadius: 999,
                  padding: '3px 8px',
                  color: t.textMuted,
                  fontSize: 11,
                }}
              >
                OSS core
              </span>
            </div>

            <div>
              <h1
                style={{
                  margin: 0,
                  color: t.textPrimary,
                  fontSize: 28,
                  lineHeight: 1.15,
                  fontWeight: 800,
                  letterSpacing: 0,
                  maxWidth: 720,
                }}
              >
                Build trusted analytics from source data to business decisions.
              </h1>
              <p
                style={{
                  margin: '12px 0 0',
                  color: t.textSecondary,
                  fontSize: 15,
                  lineHeight: 1.55,
                  maxWidth: 740,
                }}
              >
                DQL is the domain layer for analytics: reusable SQL blocks, business terms,
                business views, notebooks, dashboards, apps, and lineage compiled into one
                manifest for people and AI agents.
              </p>
            </div>

            <div
              style={{
                display: 'flex',
                gap: 10,
                flexWrap: 'wrap',
                marginTop: 'auto',
              }}
            >
              <PrimaryAction
                label="New Notebook"
                Icon={BookOpenText}
                onClick={() => dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' })}
                t={t}
              />
              <SecondaryAction
                label="New Block"
                Icon={Blocks}
                onClick={() => dispatch({ type: 'OPEN_NEW_BLOCK_MODAL' })}
                t={t}
              />
              <SecondaryAction
                label="Open Lineage"
                Icon={Network}
                onClick={() => openPanel('lineage')}
                t={t}
              />
              <SecondaryAction
                label="Connections"
                Icon={Database}
                onClick={() => openPanel('connection')}
                t={t}
              />
            </div>
          </div>

          <div
            style={{
              border: `1px solid ${t.cellBorder}`,
              borderRadius: 8,
              background: t.cellBg,
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <SectionLabel label="How DQL works" t={t} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {WORKFLOW_STEPS.map((step) => (
                <WorkflowStep key={step.label} {...step} t={t} />
              ))}
            </div>
          </div>
        </section>

        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
            gap: 14,
            alignItems: 'stretch',
          }}
        >
          <RecentWork recentFiles={recentFiles} onOpenFile={onOpenFile} t={t} />

          <div
            style={{
              border: `1px solid ${t.cellBorder}`,
              borderRadius: 8,
              background: t.cellBg,
              padding: 18,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
              gap: 10,
            }}
          >
            {VALUE_CARDS.map((item) => (
              <ValueCard key={item.label} {...item} t={t} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function SectionLabel({ label, t }: { label: string; t: Theme }) {
  return (
    <div
      style={{
        color: t.textMuted,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: 0,
        textTransform: 'uppercase',
      }}
    >
      {label}
    </div>
  );
}

function WorkflowStep({
  label,
  detail,
  Icon,
  tone,
  toneBg,
  t,
}: {
  label: string;
  detail: string;
  Icon: LucideIcon;
  tone: string;
  toneBg: string;
  t: Theme;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '30px 1fr',
        gap: 10,
        alignItems: 'start',
        padding: 10,
        borderRadius: 6,
        background: t.inputBg,
        border: `1px solid ${t.cellBorder}`,
      }}
    >
      <span
        style={{
          width: 30,
          height: 30,
          borderRadius: 6,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tone,
          background: toneBg,
        }}
      >
        <Icon size={16} strokeWidth={2} aria-hidden="true" />
      </span>
      <span style={{ minWidth: 0 }}>
        <div style={{ color: t.textPrimary, fontSize: 13, fontWeight: 800, marginBottom: 3 }}>
          {label}
        </div>
        <div style={{ color: t.textSecondary, fontSize: 12, lineHeight: 1.45 }}>
          {detail}
        </div>
      </span>
    </div>
  );
}

function ValueCard({
  label,
  detail,
  Icon,
  t,
}: {
  label: string;
  detail: string;
  Icon: LucideIcon;
  t: Theme;
}) {
  return (
    <div
      style={{
        minHeight: 112,
        borderRadius: 6,
        border: `1px solid ${t.cellBorder}`,
        background: t.inputBg,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon size={16} strokeWidth={2} color={t.accent} aria-hidden="true" />
        <div style={{ color: t.textPrimary, fontSize: 13, fontWeight: 800 }}>
          {label}
        </div>
      </div>
      <div style={{ color: t.textSecondary, fontSize: 12, lineHeight: 1.45 }}>
        {detail}
      </div>
    </div>
  );
}

function RecentWork({
  recentFiles,
  onOpenFile,
  t,
}: {
  recentFiles: NotebookFile[];
  onOpenFile: (file: NotebookFile) => void;
  t: Theme;
}) {
  return (
    <div
      style={{
        border: `1px solid ${t.cellBorder}`,
        borderRadius: 8,
        background: t.cellBg,
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        minHeight: 216,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <SectionLabel label="Open project work" t={t} />
        <span style={{ color: t.textMuted, fontSize: 11 }}>{recentFiles.length} files</span>
      </div>
      {recentFiles.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: `1px dashed ${t.cellBorder}`,
            borderRadius: 6,
            color: t.textMuted,
            fontSize: 13,
            textAlign: 'center',
            padding: 18,
            lineHeight: 1.45,
          }}
        >
          No files yet. Create a notebook or block to start building your domain layer.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {recentFiles.map((file) => (
            <RecentFileButton key={file.path} file={file} onOpen={() => onOpenFile(file)} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function RecentFileButton({
  file,
  onOpen,
  t,
}: {
  file: NotebookFile;
  onOpen: () => void;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  const Icon = iconForFile(file.type);
  return (
    <button
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        height: 38,
        border: `1px solid ${hovered ? t.accent : t.cellBorder}`,
        borderRadius: 6,
        background: hovered ? t.sidebarItemHover : t.inputBg,
        color: hovered ? t.textPrimary : t.textSecondary,
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '0 10px',
        cursor: 'pointer',
        transition: 'border-color 0.14s, background 0.14s, color 0.14s',
        fontFamily: t.font,
      }}
    >
      <Icon size={15} strokeWidth={2} color={hovered ? t.accent : t.textMuted} aria-hidden="true" />
      <span style={{ flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {displayName(file)}
      </span>
      <span style={{ color: t.textMuted, fontSize: 11 }}>{file.type.replace('_', ' ')}</span>
    </button>
  );
}

function PrimaryAction({
  label,
  Icon,
  onClick,
  t,
}: {
  label: string;
  Icon: LucideIcon;
  onClick: () => void;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        height: 34,
        border: `1px solid ${t.accent}`,
        borderRadius: 6,
        background: hovered ? t.accentHover : t.accent,
        color: 'var(--accent-on, #fff)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 12px',
        fontSize: 12,
        fontWeight: 800,
        fontFamily: t.font,
        cursor: 'pointer',
      }}
    >
      <Plus size={15} strokeWidth={2.2} aria-hidden="true" />
      <span>{label}</span>
      <Icon size={15} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

function SecondaryAction({
  label,
  Icon,
  onClick,
  t,
}: {
  label: string;
  Icon: LucideIcon;
  onClick: () => void;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        height: 34,
        border: `1px solid ${hovered ? t.accent : t.cellBorder}`,
        borderRadius: 6,
        background: hovered ? t.sidebarItemHover : t.inputBg,
        color: hovered ? t.textPrimary : t.textSecondary,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 11px',
        fontSize: 12,
        fontWeight: 700,
        fontFamily: t.font,
        cursor: 'pointer',
        transition: 'border-color 0.14s, background 0.14s, color 0.14s',
      }}
    >
      <Icon size={15} strokeWidth={2} color={hovered ? t.accent : t.textMuted} aria-hidden="true" />
      {label}
    </button>
  );
}

function iconForFile(type: NotebookFile['type']): LucideIcon {
  switch (type) {
    case 'block':
      return Blocks;
    case 'term':
      return FileText;
    case 'business_view':
      return Workflow;
    case 'dashboard':
      return Network;
    default:
      return BookOpenText;
  }
}

function displayName(file: NotebookFile): string {
  return file.name.replace(/\.(dqlnb|dql)$/i, '');
}
