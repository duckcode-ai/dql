import React, { useEffect, useState } from 'react';
import { Boxes, MessageCircle, Settings, ListChecks } from 'lucide-react';
import { Tooltip } from '@duckcodeailabs/dql-ui';
import {
  FileText,
  GitBranch,
  BookOpen,
  HelpCircle,
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

  function handlePanelClick(panel: SidebarPanel | 'home' | 'ask' | 'modeling') {
    if (panel === 'home' || panel === 'ask' || panel === 'modeling') {
      dispatch({ type: 'SET_MAIN_VIEW', view: panel });
      return;
    }
    // Lineage opens as an index list. Selecting a row opens a focused
    // inspector; we avoid mounting the whole-project graph by default.
    if (panel === 'lineage') {
      dispatch({ type: 'SET_SIDEBAR_PANEL', panel: 'lineage' });
      return;
    }
    const fullPagePanel = panel === 'connection' || panel === 'reference' || panel === 'git' || panel === 'apps' || panel === 'readiness' || panel === 'skills' || panel === 'domains' || panel === 'settings';
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

  // Grouped, labelled navigation: Insights (deliver/consume) → Build (analyst
  // create/explore) → Govern (configure/control). Home + Get Started moved into
  // the onboarding flow (Settings → Setup); the app lands on Apps.
  const navGroups: Array<{
    label: string;
    items: Array<{ key: SidebarPanel | 'ask' | 'modeling'; title: string; icon: React.ReactNode; active: boolean }>;
  }> = [
    {
      label: 'Insights',
      items: [
        { key: 'apps', title: 'Apps', icon: <Package size={16} strokeWidth={1.75} />, active: state.mainView === 'apps' },
        { key: 'ask', title: 'Ask', icon: <MessageCircle size={16} strokeWidth={1.75} />, active: state.mainView === 'ask' },
      ],
    },
    {
      label: 'Build',
      items: [
        { key: 'files', title: 'Notebooks', icon: <FileText size={16} strokeWidth={1.75} />, active: state.sidebarPanel === 'files' && state.sidebarOpen },
        { key: 'block_library', title: 'Blocks', icon: <BlockIcon size={16} />, active: state.sidebarPanel === 'block_library' && state.sidebarOpen },
        { key: 'lineage', title: 'Lineage', icon: <LineageNodeIcon size={16} />, active: state.mainView === 'lineage' || state.mainView === 'lineage_detail' },
      ],
    },
    {
      label: 'Govern',
      items: [
        { key: 'domains', title: 'Domains', icon: <Boxes size={16} strokeWidth={1.75} />, active: state.mainView === 'domains' || state.mainView === 'modeling' || state.mainView === 'skills' },
        { key: 'git', title: 'Source control', icon: <GitBranch size={16} strokeWidth={1.75} />, active: state.mainView === 'git' },
      ],
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
      key: 'setup',
      title: 'Setup',
      icon: <ListChecks size={16} strokeWidth={1.75} />,
      active: state.mainView === 'home' || state.mainView === 'readiness',
      onClick: () => dispatch({ type: 'SET_MAIN_VIEW', view: 'home' }),
    },
    {
      key: 'settings',
      title: 'Settings',
      icon: <Settings size={16} strokeWidth={1.75} />,
      active: state.mainView === 'settings' || state.mainView === 'connection',
      onClick: () => handlePanelClick('settings'),
    },
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

      {navGroups.map((group, groupIndex) => (
        <React.Fragment key={group.label}>
          {groupIndex > 0 ? (
            <div style={{ height: 1, margin: expanded ? '8px 10px 2px' : '8px 12px', background: t.headerBorder }} />
          ) : null}
          {expanded ? (
            <div style={{ fontSize: 10, fontWeight: 600, color: t.textMuted, letterSpacing: '0.04em', padding: '4px 12px 2px' }}>
              {group.label}
            </div>
          ) : null}
          {group.items.map((item) => (
            <RailItem
              key={item.key}
              title={item.title}
              icon={item.icon}
              active={item.active}
              expanded={expanded}
              onClick={() => handlePanelClick(item.key)}
              t={t}
            />
          ))}
        </React.Fragment>
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
