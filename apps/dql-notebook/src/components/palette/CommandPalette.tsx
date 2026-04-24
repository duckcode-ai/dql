import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as RDialog from '@radix-ui/react-dialog';
import {
  cssVar,
  radius,
  space,
  fontSize,
  fontWeight,
  z,
  Kbd,
  StatusPill,
} from '@duckcodeailabs/dql-ui';
import {
  Eye,
  EyeOff,
  Palette,
  Command,
  PanelLeft,
  Activity,
  LayoutDashboard,
  Terminal,
  GitFork,
  Files,
  Database,
  Network,
  GitBranch,
  Blocks,
  Plug,
  BookOpen,
  FilePlus,
  BoxSelect,
  Play,
  Eye as EyeIcon,
  Wrench,
} from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import type { NotebookAction, AppMode } from '../../store/types';

type PaletteMode = 'studio' | 'app' | 'both';

interface PaletteAction {
  id: string;
  label: string;
  group: string;
  icon?: React.ComponentType<any>;
  keywords?: string;
  shortcut?: string;
  /** Controls visibility based on appMode. 'both' (default) shows in either mode. */
  mode?: PaletteMode;
  run: () => void;
}

function scoreAction(a: PaletteAction, q: string): number {
  if (!q) return 1;
  const hay = (a.label + ' ' + a.group + ' ' + (a.keywords || '')).toLowerCase();
  const needle = q.toLowerCase();
  if (hay.includes(needle)) return 100 - hay.indexOf(needle);
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return 10;
  }
  return 0;
}

function visibleInMode(a: PaletteAction, appMode: AppMode): boolean {
  const m = a.mode ?? 'both';
  return m === 'both' || m === appMode;
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { state, dispatch } = useNotebook();
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setIndex(0);
    }
  }, [open]);

  const actions = useMemo<PaletteAction[]>(() => {
    const d = (a: NotebookAction) => dispatch(a);
    const close = () => onClose();
    const wrap = (fn: () => void): (() => void) => () => {
      fn();
      close();
    };
    const panels: Array<[string, NonNullable<typeof state.sidebarPanel>, React.ComponentType<any>]> = [
      ['Files', 'files', Files],
      ['Schema', 'schema', Database],
      ['Lineage', 'lineage', GitFork],
      ['Git', 'git', GitBranch],
      ['Block Library', 'block_library', Blocks],
      ['Apps', 'apps', Network],
      ['Connections', 'connection', Plug],
      ['Reference', 'reference', BookOpen],
    ];
    const themeOptions: Array<{ mode: 'midnight' | 'obsidian' | 'paper' | 'arctic'; label: string }> = [
      { mode: 'midnight', label: 'Midnight' },
      { mode: 'obsidian', label: 'Obsidian' },
      { mode: 'paper', label: 'Paper' },
      { mode: 'arctic', label: 'Arctic' },
    ];

    const result: PaletteAction[] = [];

    // App mode toggle — surfaces first result when in App mode per v1.3 spec.
    result.push({
      id: 'mode.toggle',
      label: state.appMode === 'studio' ? 'Switch to App mode' : 'Switch to Studio',
      group: 'Mode',
      icon: state.appMode === 'studio' ? EyeIcon : Wrench,
      keywords: 'studio app preview publish read-only editor',
      shortcut: '⌘⇧M',
      run: wrap(() => d({ type: 'SET_APP_MODE', mode: state.appMode === 'studio' ? 'app' : 'studio' })),
    });

    result.push(
      {
        id: 'sidebar.toggle',
        label: state.sidebarOpen ? 'Hide sidebar' : 'Show sidebar',
        group: 'View',
        icon: PanelLeft,
        shortcut: '⌘B',
        mode: 'studio',
        run: wrap(() => d({ type: 'TOGGLE_SIDEBAR' })),
      },
      {
        id: 'inspector.toggle',
        label: state.inspectorOpen ? 'Hide inspector' : 'Show inspector',
        group: 'View',
        icon: state.inspectorOpen ? EyeOff : Eye,
        shortcut: '⌘⇧I',
        mode: 'studio',
        run: wrap(() => d({ type: 'TOGGLE_INSPECTOR' })),
      },
      {
        id: 'dashboard.toggle',
        label: state.dashboardMode ? 'Exit dashboard mode' : 'Enter dashboard mode',
        group: 'View',
        icon: LayoutDashboard,
        shortcut: '⌘D',
        run: wrap(() => d({ type: 'TOGGLE_DASHBOARD_MODE' })),
      },
      {
        id: 'dev.toggle',
        label: 'Toggle dev panel',
        group: 'View',
        icon: Terminal,
        shortcut: '⌘J',
        mode: 'studio',
        run: wrap(() => d({ type: 'TOGGLE_DEV_PANEL' })),
      },
      {
        id: 'lineage.fullscreen',
        label: state.lineageFullscreen ? 'Exit full-screen lineage' : 'Open full-screen lineage',
        group: 'Lineage',
        icon: Activity,
        keywords: 'graph dag',
        run: wrap(() => d({ type: 'TOGGLE_LINEAGE_FULLSCREEN' })),
      },
    );

    // Navigate — hidden in App mode.
    for (const [label, panel, icon] of panels) {
      result.push({
        id: `panel.${panel}`,
        label: `Go to ${label}`,
        group: 'Navigate',
        icon,
        mode: 'studio',
        run: wrap(() => {
          d({ type: 'SET_SIDEBAR_PANEL', panel });
          if (!state.sidebarOpen) d({ type: 'TOGGLE_SIDEBAR' });
        }),
      });
    }

    // Create — authoring is Studio-only.
    result.push(
      {
        id: 'notebook.new',
        label: 'New notebook…',
        group: 'Create',
        icon: FilePlus,
        mode: 'studio',
        run: wrap(() => d({ type: 'OPEN_NEW_NOTEBOOK_MODAL' })),
      },
      {
        id: 'block.new',
        label: 'New block…',
        group: 'Create',
        icon: BoxSelect,
        mode: 'studio',
        run: wrap(() => d({ type: 'OPEN_NEW_BLOCK_MODAL' })),
      },
    );

    // Theme — four explicit entries per v1.3 Track 9/10 spec.
    const currentThemeKey =
      state.themeMode === 'dark' ? 'midnight'
      : state.themeMode === 'light' ? 'paper'
      : state.themeMode;
    for (const th of themeOptions) {
      if (th.mode === currentThemeKey) continue;
      result.push({
        id: `theme.${th.mode}`,
        label: `Switch to ${th.label}`,
        group: 'Theme',
        icon: Palette,
        keywords: 'appearance color',
        run: wrap(() => d({ type: 'SET_THEME', mode: th.mode })),
      });
    }

    return result;
  }, [
    state.sidebarOpen,
    state.inspectorOpen,
    state.themeMode,
    state.dashboardMode,
    state.lineageFullscreen,
    state.appMode,
    state.sidebarPanel,
    dispatch,
    onClose,
  ]);

  const filtered = useMemo(() => {
    const visible = actions.filter((a) => visibleInMode(a, state.appMode));
    const scored = visible
      .map((a) => ({ a, s: scoreAction(a, q) }))
      .filter((x) => x.s > 0);
    scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.a);
  }, [actions, q, state.appMode]);

  useEffect(() => {
    setIndex(0);
  }, [q]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-palette-idx="${index}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      filtered[index]?.run();
    }
  };

  let lastGroup = '';

  return (
    <RDialog.Root open={open} onOpenChange={(o: boolean) => !o && onClose()}>
      <RDialog.Portal>
        <RDialog.Overlay
          style={{
            position: 'fixed',
            inset: 0,
            background: cssVar('surfaceOverlay'),
            zIndex: z.overlay,
          }}
        />
        <RDialog.Content
          aria-label="Command palette"
          style={{
            position: 'fixed',
            top: '18vh',
            left: '50%',
            transform: 'translateX(-50%)',
            width: '92vw',
            maxWidth: 620,
            background: cssVar('surfaceRaised'),
            color: cssVar('textPrimary'),
            border: `1px solid ${cssVar('borderDefault')}`,
            borderRadius: radius.lg,
            boxShadow: cssVar('shadowLg'),
            zIndex: z.modal,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
          onKeyDown={onKeyDown}
        >
          <RDialog.Title style={{ position: 'absolute', left: -9999 }}>Command palette</RDialog.Title>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: space[2],
              padding: `${space[3]}px ${space[4]}px`,
              borderBottom: `1px solid ${cssVar('borderSubtle')}`,
            }}
          >
            <Command size={14} strokeWidth={1.75} color={cssVar('textMuted')} />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Type a command…"
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: cssVar('textPrimary'),
                fontSize: fontSize.md,
              }}
            />
          </div>
          <div
            ref={listRef}
            style={{
              maxHeight: 360,
              overflowY: 'auto',
              padding: `${space[1]}px 0`,
            }}
          >
            {filtered.length === 0 && (
              <div
                style={{
                  padding: space[4],
                  fontSize: fontSize.sm,
                  color: cssVar('textMuted'),
                  textAlign: 'center',
                }}
              >
                No matching commands
              </div>
            )}
            {filtered.map((a, i) => {
              const showGroup = a.group !== lastGroup;
              lastGroup = a.group;
              const active = i === index;
              const Icon = a.icon;
              return (
                <React.Fragment key={a.id}>
                  {showGroup && (
                    <div
                      style={{
                        padding: `${space[2]}px ${space[4]}px ${space[1]}px`,
                      }}
                    >
                      <StatusPill tone="neutral">{a.group}</StatusPill>
                    </div>
                  )}
                  <div
                    data-palette-idx={i}
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => setIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      a.run();
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: space[3],
                      padding: `${space[2]}px ${space[4]}px`,
                      fontSize: fontSize.sm,
                      cursor: 'pointer',
                      background: active ? cssVar('surfaceHover') : 'transparent',
                      color: cssVar('textPrimary'),
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0, flex: 1 }}>
                      {Icon && (
                        <Icon
                          size={14}
                          strokeWidth={1.75}
                        />
                      )}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {a.label}
                      </span>
                    </span>
                    {a.shortcut && <Kbd shortcut={a.shortcut} />}
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
