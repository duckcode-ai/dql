import React, { useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { FilesPanel } from '../sidebar/FilesPanel';
import { SchemaPanel } from '../sidebar/SchemaPanel';
import { OutlinePanel } from '../sidebar/OutlinePanel';
import { ConnectionPanel } from '../sidebar/ConnectionPanel';
import { ReferencePanel } from '../sidebar/ReferencePanel';
import type { NotebookFile } from '../../store/types';

interface SidebarProps {
  onOpenFile: (file: NotebookFile) => void;
  onNavigateToCell: (cellId: string) => void;
}

const PANEL_TITLES: Record<string, string> = {
  files: 'Explorer',
  schema: 'Schema',
  outline: 'Outline',
  connection: 'Connection',
  reference: 'Quick Reference',
};

export function Sidebar({ onOpenFile, onNavigateToCell }: SidebarProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [collapseHover, setCollapseHover] = useState(false);

  const panel = state.sidebarPanel;

  return (
    <div
      style={{
        width: 240,
        flexShrink: 0,
        background: t.sidebarBg,
        borderRight: `1px solid ${t.headerBorder}`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Panel header */}
      <div
        style={{
          height: 36,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 10px 0 14px',
          borderBottom: `1px solid ${t.headerBorder}`,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase' as const,
            color: t.textSecondary,
            fontFamily: t.font,
          }}
        >
          {PANEL_TITLES[panel ?? ''] ?? ''}
        </span>
        <button
          title="Collapse sidebar"
          onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
          onMouseEnter={() => setCollapseHover(true)}
          onMouseLeave={() => setCollapseHover(false)}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: collapseHover ? t.textPrimary : t.textMuted,
            padding: '2px 4px',
            borderRadius: 4,
            fontSize: 14,
            lineHeight: 1,
            transition: 'color 0.15s',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          ‹
        </button>
      </div>

      {/* Panel content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {panel === 'files' && <FilesPanel onOpenFile={onOpenFile} />}
        {panel === 'schema' && <SchemaPanel />}
        {panel === 'outline' && <OutlinePanel onNavigate={onNavigateToCell} />}
        {panel === 'connection' && <ConnectionPanel />}
        {panel === 'reference' && <ReferencePanel themeMode={state.themeMode} />}
      </div>
    </div>
  );
}
