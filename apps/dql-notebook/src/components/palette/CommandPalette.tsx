import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as RDialog from '@radix-ui/react-dialog';
import { cssVar, radius, space, fontSize, fontWeight, z } from '@duckcodeailabs/dql-ui';
import { useNotebook } from '../../store/NotebookStore';
import type { NotebookAction } from '../../store/types';

interface PaletteAction {
  id: string;
  label: string;
  group: string;
  keywords?: string;
  shortcut?: string;
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
    const panels: Array<[string, NonNullable<typeof state.sidebarPanel>]> = [
      ['Files', 'files'],
      ['Schema', 'schema'],
      ['Semantic Layer', 'semantic'],
      ['Lineage', 'lineage'],
      ['Block Library', 'block_library'],
      ['Connections', 'connection'],
      ['Reference', 'reference'],
    ];
    const result: PaletteAction[] = [
      {
        id: 'sidebar.toggle',
        label: state.sidebarOpen ? 'Hide sidebar' : 'Show sidebar',
        group: 'View',
        shortcut: '⌘B',
        run: wrap(() => d({ type: 'TOGGLE_SIDEBAR' })),
      },
      {
        id: 'theme.toggle',
        label: state.themeMode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        group: 'View',
        keywords: 'appearance color mode',
        run: wrap(() =>
          d({ type: 'SET_THEME', mode: state.themeMode === 'dark' ? 'light' : 'dark' })
        ),
      },
      {
        id: 'inspector.toggle',
        label: state.inspectorOpen ? 'Hide inspector' : 'Show inspector',
        group: 'View',
        shortcut: '⌘⇧I',
        run: wrap(() => d({ type: 'TOGGLE_INSPECTOR' })),
      },
      {
        id: 'dashboard.toggle',
        label: state.dashboardMode ? 'Exit dashboard mode' : 'Enter dashboard mode',
        group: 'View',
        shortcut: '⌘D',
        run: wrap(() => d({ type: 'TOGGLE_DASHBOARD_MODE' })),
      },
      {
        id: 'dev.toggle',
        label: 'Toggle dev panel',
        group: 'View',
        shortcut: '⌘J',
        run: wrap(() => d({ type: 'TOGGLE_DEV_PANEL' })),
      },
      {
        id: 'lineage.fullscreen',
        label: state.lineageFullscreen ? 'Exit full-screen lineage' : 'Open full-screen lineage',
        group: 'Lineage',
        keywords: 'graph dag',
        run: wrap(() => d({ type: 'TOGGLE_LINEAGE_FULLSCREEN' })),
      },
      ...panels.map(
        ([label, panel]): PaletteAction => ({
          id: `panel.${panel}`,
          label: `Go to ${label}`,
          group: 'Navigate',
          run: wrap(() => {
            d({ type: 'SET_SIDEBAR_PANEL', panel });
            if (!state.sidebarOpen) d({ type: 'TOGGLE_SIDEBAR' });
          }),
        })
      ),
      {
        id: 'notebook.new',
        label: 'New notebook…',
        group: 'Create',
        run: wrap(() => d({ type: 'OPEN_NEW_NOTEBOOK_MODAL' })),
      },
      {
        id: 'block.new',
        label: 'New block…',
        group: 'Create',
        run: wrap(() => d({ type: 'OPEN_NEW_BLOCK_MODAL' })),
      },
    ];
    return result;
  }, [state.sidebarOpen, state.themeMode, state.dashboardMode, state.lineageFullscreen, state.inspectorOpen, dispatch, onClose]);

  const filtered = useMemo(() => {
    const scored = actions
      .map((a) => ({ a, s: scoreAction(a, q) }))
      .filter((x) => x.s > 0);
    scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.a);
  }, [actions, q]);

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
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Type a command…"
            style={{
              padding: `${space[3]}px ${space[4]}px`,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: cssVar('textPrimary'),
              fontSize: fontSize.md,
              borderBottom: `1px solid ${cssVar('borderSubtle')}`,
            }}
          />
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
              return (
                <React.Fragment key={a.id}>
                  {showGroup && (
                    <div
                      style={{
                        padding: `${space[2]}px ${space[4]}px ${space[1]}px`,
                        fontSize: fontSize.xs,
                        fontWeight: fontWeight.medium,
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                        color: cssVar('textMuted'),
                      }}
                    >
                      {a.group}
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
                      padding: `${space[2]}px ${space[4]}px`,
                      fontSize: fontSize.sm,
                      cursor: 'pointer',
                      background: active ? cssVar('surfaceHover') : 'transparent',
                      color: cssVar('textPrimary'),
                    }}
                  >
                    <span>{a.label}</span>
                    {a.shortcut && (
                      <span
                        style={{
                          fontSize: fontSize.xs,
                          color: cssVar('textMuted'),
                          fontFamily: 'var(--dql-font-mono, monospace)',
                        }}
                      >
                        {a.shortcut}
                      </span>
                    )}
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
