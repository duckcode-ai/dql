import React, { useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { FilesPanel } from '../sidebar/FilesPanel';
import { SchemaPanel } from '../sidebar/SchemaPanel';
import { ConnectionPanel } from '../sidebar/ConnectionPanel';
import { ReferencePanel } from '../sidebar/ReferencePanel';
import { SemanticPanel } from '../sidebar/SemanticPanel';
import { LineagePanel } from '../sidebar/LineagePanel';
import { BlockLibraryPanel } from '../sidebar/BlockLibraryPanel';
import type { NotebookFile } from '../../store/types';

interface SidebarProps {
  onOpenFile: (file: NotebookFile) => void;
}

const PANEL_TITLES: Record<string, string> = {
  files: 'Explorer',
  schema: 'Schema',
  block_library: 'Block Library',
  semantic: 'Semantic Layer',
  lineage: 'Lineage',
  connection: 'Connection',
  reference: 'Quick Reference',
};

export function Sidebar({ onOpenFile }: SidebarProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [collapseHover, setCollapseHover] = useState(false);

  const panel = state.mainView === 'block_studio' && state.sidebarPanel === 'semantic'
    ? 'files'
    : state.sidebarPanel;

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
        {panel === 'block_library' && <BlockLibraryPanel />}
        {panel === 'semantic' && <SemanticPanel />}
        {panel === 'lineage' && <LineagePanel />}
        {panel === 'connection' && <ConnectionPanel />}
        {panel === 'reference' && <ReferencePanel themeMode={state.themeMode} />}
      </div>
    </div>
  );
}
