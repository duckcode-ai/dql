import React, { useRef, useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { FilesPanel } from '../panels/FilesPanel';
import { SchemaPanel } from '../panels/SchemaPanel';
import { ConnectionPanel } from '../panels/ConnectionPanel';
import { ReferencePanel } from '../panels/ReferencePanel';
import { LineagePanel } from '../panels/LineagePanel';
import { BlockLibraryPanel } from '../panels/BlockLibraryPanel';
import { GitPanel } from '../panels/GitPanel';
import { AppsPanel } from '../panels/AppsPanel';
import type { NotebookFile } from '../../store/types';

interface SidebarProps {
  onOpenFile: (file: NotebookFile) => void;
}

const PANEL_TITLES: Record<string, string> = {
  files: 'Explorer',
  schema: 'Schema',
  block_library: 'Block Library',
  lineage: 'Lineage',
  connection: 'Connection',
  reference: 'Quick Reference',
  git: 'Git',
  apps: 'Apps',
};

export function Sidebar({ onOpenFile }: SidebarProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [collapseHover, setCollapseHover] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(sidebarWidth);

  const panel = state.sidebarPanel;

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    setResizing(true);
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(560, Math.max(180, startW + (ev.clientX - startX)));
      widthRef.current = next;
      setSidebarWidth(next);
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      style={{
        width: sidebarWidth,
        flexShrink: 0,
        background: t.sidebarBg,
        borderRight: `1px solid ${t.headerBorder}`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
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
        {panel === 'lineage' && <LineagePanel />}
        {panel === 'connection' && <ConnectionPanel />}
        {panel === 'reference' && <ReferencePanel themeMode={state.themeMode} />}
        {panel === 'git' && <GitPanel />}
        {panel === 'apps' && <AppsPanel onOpenFile={onOpenFile} />}
      </div>

      {/* Resize handle on right edge */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        style={{
          position: 'absolute',
          top: 0,
          right: -3,
          width: 6,
          height: '100%',
          cursor: 'col-resize',
          background: resizing ? t.accent : 'transparent',
          zIndex: 10,
          transition: resizing ? 'none' : 'background 0.15s',
        }}
        onMouseEnter={(e) => { if (!resizing) (e.currentTarget as HTMLElement).style.background = `${t.accent}40`; }}
        onMouseLeave={(e) => { if (!resizing) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      />
    </div>
  );
}
