import React, { useEffect, useState } from 'react';
import { Tooltip } from '@duckcodeailabs/dql-ui';
import {
  Files,
  Database,
  GitBranch,
  Plug,
  BookOpen,
  HelpCircle,
  Settings,
  Package,
  ChevronsLeft,
  ChevronsRight,
  BlockIcon,
  LineageNodeIcon,
} from '@duckcodeailabs/dql-ui/icons';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { SidebarPanel } from '../../store/types';

const RAIL_COLLAPSED = 44;
const RAIL_EXPANDED = 188;
const STORAGE_KEY = 'dql-activitybar-expanded';

type Theme = (typeof themes)['dark'];

function readInitialExpanded(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage?.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistExpanded(v: boolean) {
  try {
    window.localStorage?.setItem(STORAGE_KEY, v ? '1' : '0');
  } catch {
    // ignore quota / privacy-mode failures — it's a preference
  }
}

interface RailItemProps {
  title: string;
  icon: React.ReactNode;
  active: boolean;
  expanded: boolean;
  onClick: () => void;
  t: Theme;
}

function RailItem({ title, icon, active, expanded, onClick, t }: RailItemProps) {
  const [hovered, setHovered] = useState(false);
  const button = (
    <button
      aria-label={title}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: expanded ? RAIL_EXPANDED - 12 : RAIL_COLLAPSED - 8,
        height: 32,
        display: 'flex',
        alignItems: 'center',
        justifyContent: expanded ? 'flex-start' : 'center',
        gap: 10,
        padding: expanded ? '0 10px' : 0,
        marginLeft: expanded ? 6 : 4,
        marginRight: expanded ? 6 : 4,
        background: active
          ? t.accent + '1f'
          : hovered
            ? t.textPrimary + '0f'
            : 'transparent',
        border: 'none',
        borderRadius: 6,
        cursor: 'pointer',
        color: active ? t.accent : hovered ? t.textPrimary : t.textSecondary,
        transition: 'background 0.15s, color 0.15s',
        fontFamily: t.font,
        fontSize: 13,
        fontWeight: active ? 500 : 400,
        textAlign: 'left',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          width: 18,
          height: 18,
        }}
      >
        {icon}
      </span>
      {expanded && (
        <span style={{ flex: 1, textOverflow: 'ellipsis', overflow: 'hidden' }}>
          {title}
        </span>
      )}
    </button>
  );
  // In collapsed mode the label is absent, so keep the tooltip.
  // In expanded mode the label is right there — tooltip would be noise.
  return expanded ? button : <Tooltip content={title} side="right">{button}</Tooltip>;
}

export function ActivityBar() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [expanded, setExpanded] = useState<boolean>(readInitialExpanded);

  useEffect(() => {
    persistExpanded(expanded);
  }, [expanded]);

  function handlePanelClick(panel: SidebarPanel) {
    // Lineage: show the list panel on the left AND the full-page DAG in main.
    // SET_SIDEBAR_PANEL resets lineageFullscreen to false, so we re-toggle it
    // on after to keep the DAG mounted.
    if (panel === 'lineage') {
      if (state.lineageFullscreen && state.sidebarPanel === 'lineage' && state.sidebarOpen) {
        dispatch({ type: 'TOGGLE_LINEAGE_FULLSCREEN' });
        dispatch({ type: 'TOGGLE_SIDEBAR' });
        return;
      }
      dispatch({ type: 'SET_SIDEBAR_PANEL', panel: 'lineage' });
      dispatch({ type: 'TOGGLE_LINEAGE_FULLSCREEN' });
      return;
    }
    const fullPagePanel = panel === 'connection' || panel === 'reference' || panel === 'git';
    if (fullPagePanel) {
      dispatch({ type: 'SET_SIDEBAR_PANEL', panel });
      return;
    }
    if (state.sidebarPanel === panel && state.sidebarOpen) {
      dispatch({ type: 'TOGGLE_SIDEBAR' });
    } else {
      dispatch({ type: 'SET_SIDEBAR_PANEL', panel });
    }
  }

  const items: Array<{
    key: SidebarPanel | 'connection' | 'reference';
    title: string;
    icon: React.ReactNode;
    active: boolean;
  }> = [
    {
      key: 'files',
      title: 'Files',
      icon: <Files size={16} strokeWidth={1.75} />,
      active: state.sidebarPanel === 'files' && state.sidebarOpen,
    },
    {
      key: 'schema',
      title: 'Schema',
      icon: <Database size={16} strokeWidth={1.75} />,
      active: state.sidebarPanel === 'schema' && state.sidebarOpen,
    },
    {
      key: 'block_library',
      title: 'Block Library',
      icon: <BlockIcon size={16} />,
      active: state.sidebarPanel === 'block_library' && state.sidebarOpen,
    },
    {
      key: 'apps',
      title: 'Apps',
      icon: <Package size={16} strokeWidth={1.75} />,
      active: state.sidebarPanel === 'apps' && state.sidebarOpen,
    },
    {
      key: 'lineage',
      title: 'Lineage',
      icon: <LineageNodeIcon size={16} />,
      active: state.lineageFullscreen,
    },
    {
      key: 'git',
      title: 'Source control',
      icon: <GitBranch size={16} strokeWidth={1.75} />,
      active: state.mainView === 'git',
    },
    {
      key: 'connection',
      title: 'Connections',
      icon: <Plug size={16} strokeWidth={1.75} />,
      active: state.mainView === 'connection',
    },
  ];

  const bottomItems: Array<{
    key: string;
    title: string;
    icon: React.ReactNode;
    active: boolean;
    onClick: () => void;
  }> = [
    {
      key: 'reference',
      title: 'Reference',
      icon: <BookOpen size={16} strokeWidth={1.75} />,
      active: state.mainView === 'reference',
      onClick: () => handlePanelClick('reference'),
    },
    {
      key: 'help',
      title: 'Help',
      icon: <HelpCircle size={16} strokeWidth={1.75} />,
      active: false,
      onClick: () => handlePanelClick('reference'),
    },
    {
      key: 'settings',
      title: 'Settings',
      icon: <Settings size={16} strokeWidth={1.75} />,
      active: false,
      onClick: () => {},
    },
  ];

  return (
    <div
      style={{
        width: expanded ? RAIL_EXPANDED : RAIL_COLLAPSED,
        flexShrink: 0,
        background: t.activityBarBg,
        borderRight: `1px solid ${t.headerBorder}`,
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 6,
        paddingBottom: 6,
        gap: 2,
        userSelect: 'none',
        transition: 'width 0.18s ease',
        overflow: 'hidden',
      }}
    >
      {/* Collapse/expand toggle */}
      <div
        style={{
          display: 'flex',
          justifyContent: expanded ? 'flex-end' : 'center',
          paddingLeft: expanded ? 6 : 0,
          paddingRight: expanded ? 6 : 0,
          marginBottom: 4,
        }}
      >
        <Tooltip content={expanded ? 'Collapse' : 'Expand'} side="right">
          <button
            aria-label={expanded ? 'Collapse sidebar rail' : 'Expand sidebar rail'}
            onClick={() => setExpanded((v) => !v)}
            style={{
              width: 28,
              height: 26,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: 'none',
              borderRadius: 5,
              cursor: 'pointer',
              color: t.textMuted,
              padding: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = t.textPrimary;
              e.currentTarget.style.background = t.textPrimary + '0f';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = t.textMuted;
              e.currentTarget.style.background = 'transparent';
            }}
          >
            {expanded ? <ChevronsLeft size={14} strokeWidth={2} /> : <ChevronsRight size={14} strokeWidth={2} />}
          </button>
        </Tooltip>
      </div>

      {items.map((item) => (
        <RailItem
          key={item.key}
          title={item.title}
          icon={item.icon}
          active={item.active}
          expanded={expanded}
          onClick={() => handlePanelClick(item.key as SidebarPanel)}
          t={t}
        />
      ))}

      <div style={{ flex: 1 }} />

      {bottomItems.map((item) => (
        <RailItem
          key={item.key}
          title={item.title}
          icon={item.icon}
          active={item.active}
          expanded={expanded}
          onClick={item.onClick}
          t={t}
        />
      ))}
    </div>
  );
}
