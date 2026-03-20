import type { Theme } from '../../themes/notebook-theme';
import React from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { CellComponent } from '../cells/Cell';
import { AddCellBar } from './AddCellBar';

interface CellListProps {
  registerCellRef: (id: string, el: HTMLDivElement | null) => void;
}

export function CellList({ registerCellRef }: CellListProps) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];

  if (state.cells.length === 0) {
    return (
      <div
        style={{
          maxWidth: 860,
          margin: '0 auto',
          padding: '0 24px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <AddCellBar />
        <EmptyState t={t} />
      </div>
    );
  }

  return (
    <div
      style={{
        maxWidth: 860,
        margin: '0 auto',
        padding: '0 24px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <AddCellBar afterId={undefined} />

      {state.cells.map((cell, index) => (
        <React.Fragment key={cell.id}>
          <div ref={(el) => registerCellRef(cell.id, el)}>
            <CellComponent cell={cell} index={index} />
          </div>
          <AddCellBar afterId={cell.id} />
        </React.Fragment>
      ))}
    </div>
  );
}

function EmptyState({ t }: { t: Theme }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 0',
        gap: 12,
        color: t.textMuted,
      }}
    >
      <svg
        width="40"
        height="40"
        viewBox="0 0 16 16"
        fill="currentColor"
        style={{ opacity: 0.3 }}
      >
        <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 8.75 4.25V1.5ZM8.75 5.5h2.836L10.25 3.664V4.25c0 .138.112.25.25.25H8.75Z" />
      </svg>
      <span style={{ fontSize: 13, fontFamily: t.font }}>
        Empty notebook. Click + to add your first cell.
      </span>
    </div>
  );
}
