import type { Theme } from '../../themes/notebook-theme';
import React, { useCallback } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { WelcomeScreen } from './WelcomeScreen';
import { CellList } from './CellList';
import { DashboardView } from './DashboardView';
import type { NotebookFile } from '../../store/types';

interface NotebookEditorProps {
  onOpenFile: (file: NotebookFile) => void;
  registerCellRef: (id: string, el: HTMLDivElement | null) => void;
}

export function NotebookEditor({ onOpenFile, registerCellRef }: NotebookEditorProps) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];

  if (!state.activeFile) {
    return <WelcomeScreen onOpenFile={onOpenFile} />;
  }

  // Dashboard / presentation mode
  if (state.dashboardMode) {
    return <DashboardView />;
  }

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: t.appBg,
      }}
    >
      {/* Notebook toolbar */}
      <NotebookToolbar t={t} />

      {/* Scrollable cell area */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '24px 0 40px',
        }}
      >
        <CellList registerCellRef={registerCellRef} />
      </div>
    </div>
  );
}

function NotebookToolbar({
  t,
}: {
  t: Theme;
}) {
  const { state } = useNotebook();

  // Format last saved placeholder (we don't track real save times yet)
  const cellCount = state.cells.length;

  return (
    <div
      style={{
        height: 32,
        flexShrink: 0,
        borderBottom: `1px solid ${t.headerBorder}`,
        background: t.cellBg,
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        gap: 12,
      }}
    >
      {/* Breadcrumb */}
      <Breadcrumb t={t} />

      <div style={{ flex: 1 }} />

      {/* Meta info */}
      <span
        style={{
          fontSize: 11,
          color: t.textMuted,
          fontFamily: t.font,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <span>
          {cellCount} {cellCount === 1 ? 'cell' : 'cells'}
        </span>
        {state.notebookDirty && (
          <span style={{ color: t.warning }}>● unsaved</span>
        )}
      </span>
    </div>
  );
}

function Breadcrumb({ t }: { t: Theme }) {
  const { state } = useNotebook();
  if (!state.activeFile) return null;

  const parts = state.activeFile.path.split('/').filter(Boolean);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 12,
        fontFamily: t.fontMono,
        color: t.textMuted,
        overflow: 'hidden',
      }}
    >
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <span style={{ color: t.textMuted, opacity: 0.5 }}>/</span>
          )}
          <span
            style={{
              color: i === parts.length - 1 ? t.textSecondary : t.textMuted,
              fontWeight: i === parts.length - 1 ? 500 : 400,
              whiteSpace: 'nowrap' as const,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: i === parts.length - 1 ? 200 : 100,
            }}
          >
            {part}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}
