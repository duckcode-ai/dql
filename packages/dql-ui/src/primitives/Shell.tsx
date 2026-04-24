// v1.3 Track 4 — Shell layout primitives.
//
// Minimal scaffold for the notebook's TopBar / ActivityBar / LeftPanel /
// Canvas / RightPanel / BottomDrawer / StatusBar composition. The current
// AppShell.tsx uses hand-rolled flex; in Track 8 it will be replaced by
// composition of these primitives. Shape only — no logic, no animations,
// no resize handles. Sizes + colors are Luna tokens so theme switches
// propagate for free.

import React from 'react';

export interface ShellProps {
  children: React.ReactNode;
  style?: React.CSSProperties;
}

export function Shell({ children, style }: ShellProps) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: 'auto 1fr auto',
        height: '100vh',
        width: '100vw',
        background: 'var(--bg-0)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-ui)',
        overflow: 'hidden',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export interface TopBarProps {
  left?: React.ReactNode;
  center?: React.ReactNode;
  right?: React.ReactNode;
  height?: number;
}

export function TopBar({ left, center, right, height = 40 }: TopBarProps) {
  return (
    <header
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
        height,
        padding: '0 12px',
        background: 'var(--bg-2)',
        borderBottom: '1px solid var(--border-default)',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{left}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifySelf: 'center' }}>{center}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifySelf: 'end' }}>{right}</div>
    </header>
  );
}

export interface CanvasBodyProps {
  activityBar?: React.ReactNode;
  leftPanel?: React.ReactNode;
  center: React.ReactNode;
  rightPanel?: React.ReactNode;
}

export function CanvasBody({ activityBar, leftPanel, center, rightPanel }: CanvasBodyProps) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `${activityBar ? 'auto ' : ''}${leftPanel ? 'auto ' : ''}1fr${rightPanel ? ' auto' : ''}`,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {activityBar}
      {leftPanel}
      <div style={{ minWidth: 0, overflow: 'auto', background: 'var(--bg-1)' }}>{center}</div>
      {rightPanel}
    </div>
  );
}

export interface SidePanelProps {
  side: 'left' | 'right';
  width?: number;
  children: React.ReactNode;
}

export function LeftPanel({ width = 280, children }: { width?: number; children: React.ReactNode }) {
  return (
    <aside
      style={{
        width,
        minWidth: 0,
        borderRight: '1px solid var(--border-default)',
        background: 'var(--bg-1)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {children}
    </aside>
  );
}

export function RightPanel({ width = 320, children }: { width?: number; children: React.ReactNode }) {
  return (
    <aside
      style={{
        width,
        minWidth: 0,
        borderLeft: '1px solid var(--border-default)',
        background: 'var(--bg-1)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {children}
    </aside>
  );
}

export function BottomDrawer({ height = 240, children }: { height?: number; children: React.ReactNode }) {
  return (
    <section
      style={{
        height,
        background: 'var(--bg-1)',
        borderTop: '1px solid var(--border-default)',
        overflow: 'auto',
      }}
    >
      {children}
    </section>
  );
}

export interface StatusBarProps {
  left?: React.ReactNode;
  right?: React.ReactNode;
  height?: number;
}

export function StatusBar({ left, right, height = 24 }: StatusBarProps) {
  return (
    <footer
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height,
        padding: '0 12px',
        background: 'var(--bg-2)',
        borderTop: '1px solid var(--border-default)',
        fontSize: 11,
        color: 'var(--text-tertiary)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>{left}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>{right}</div>
    </footer>
  );
}
