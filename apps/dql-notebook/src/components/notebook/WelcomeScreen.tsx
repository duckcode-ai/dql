import type { Theme } from '../../themes/notebook-theme';
import React, { useState } from 'react';
import { BookOpenText, Blocks, FileText, Home, Workflow, type LucideIcon } from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { NotebookFile } from '../../store/types';

interface WelcomeScreenProps {
  onOpenFile: (file: NotebookFile) => void;
}

export function WelcomeScreen({ onOpenFile }: WelcomeScreenProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const recentFiles = state.files.filter((file) => file.type === 'notebook' || file.type === 'workbook').slice(0, 5);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: t.appBg,
        padding: 28,
        overflow: 'auto',
      }}
    >
      <div
        style={{
          width: 'min(720px, 100%)',
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 8,
          background: t.cellBg,
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20 }}>
          <div>
            <h1 style={{ margin: 0, color: t.textPrimary, fontSize: 24, lineHeight: 1.2, fontWeight: 800 }}>
              Notebook workspace
            </h1>
            <p style={{ margin: '8px 0 0', color: t.textSecondary, fontSize: 13, lineHeight: 1.55, maxWidth: 520 }}>
              Open an existing notebook or start a focused analysis.
            </p>
          </div>
          <span
            style={{
              width: 38,
              height: 38,
              borderRadius: 8,
              background: 'var(--color-accent-purple-soft)',
              color: 'var(--color-accent-purple)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <BookOpenText size={20} strokeWidth={2} aria-hidden="true" />
          </span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <ActionButton
            label="New Notebook"
            Icon={BookOpenText}
            primary
            onClick={() => dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' })}
            t={t}
          />
          <ActionButton
            label="New Block"
            Icon={Blocks}
            onClick={() => dispatch({ type: 'OPEN_NEW_BLOCK_MODAL' })}
            t={t}
          />
          <ActionButton
            label="Home"
            Icon={Home}
            onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'home' })}
            t={t}
          />
        </div>

        <div style={{ borderTop: `1px solid ${t.cellBorder}`, paddingTop: 16 }}>
          <div
            style={{
              color: t.textMuted,
              fontSize: 11,
              fontWeight: 800,
              textTransform: 'uppercase',
              marginBottom: 10,
            }}
          >
            Recent notebooks
          </div>
          {recentFiles.length === 0 ? (
            <div style={{ color: t.textMuted, fontSize: 13 }}>No notebooks yet.</div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {recentFiles.map((file) => (
                <RecentFile key={file.path} file={file} onOpen={() => onOpenFile(file)} t={t} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  label,
  Icon,
  onClick,
  primary = false,
  t,
}: {
  label: string;
  Icon: LucideIcon;
  onClick: () => void;
  primary?: boolean;
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
        borderRadius: 6,
        border: `1px solid ${primary ? t.accent : hovered ? t.accent : t.cellBorder}`,
        background: primary ? (hovered ? t.accentHover : t.accent) : hovered ? t.sidebarItemHover : t.inputBg,
        color: primary ? 'var(--accent-on, #fff)' : hovered ? t.textPrimary : t.textSecondary,
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
      <Icon size={15} strokeWidth={2} aria-hidden="true" />
      {label}
    </button>
  );
}

function RecentFile({ file, onOpen, t }: { file: NotebookFile; onOpen: () => void; t: Theme }) {
  const [hovered, setHovered] = useState(false);
  const Icon = file.type === 'workbook' ? Workflow : FileText;
  return (
    <button
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        height: 36,
        border: `1px solid ${hovered ? t.accent : t.cellBorder}`,
        borderRadius: 6,
        background: hovered ? t.sidebarItemHover : t.inputBg,
        color: hovered ? t.textPrimary : t.textSecondary,
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '0 10px',
        cursor: 'pointer',
        fontFamily: t.font,
      }}
    >
      <Icon size={15} strokeWidth={2} color={hovered ? t.accent : t.textMuted} aria-hidden="true" />
      <span style={{ flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {file.name.replace(/\.(dqlnb|dql)$/i, '')}
      </span>
      <span style={{ color: t.textMuted, fontSize: 11 }}>{file.type}</span>
    </button>
  );
}
