import type { Theme } from '../../themes/notebook-theme';
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useNotebook, makeCell } from '../../store/NotebookStore';
import { useQueryExecution } from '../../hooks/useQueryExecution';
import { themes } from '../../themes/notebook-theme';
import { CellComponent } from '../cells/Cell';
import { AddCellBar } from './AddCellBar';

interface CellListProps {
  registerCellRef: (id: string, el: HTMLDivElement | null) => void;
}

export function CellList({ registerCellRef }: CellListProps) {
  const { state, dispatch } = useNotebook();
  const { executeCell } = useQueryExecution();
  const t = themes[state.themeMode];

  // focusedCellId: the cell selected in command mode (not editing)
  const [focusedCellId, setFocusedCellId] = useState<string | null>(null);
  // Track last "d" keypress time for double-d detection
  const lastDPressRef = useRef<number>(0);

  // Drag-and-drop state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const handleGutterClick = useCallback((cellId: string) => {
    setFocusedCellId(cellId);
  }, []);

  useEffect(() => {
    if (focusedCellId && state.inspectorOpen) {
      dispatch({ type: 'SET_INSPECTOR_CONTEXT', context: { kind: 'cell', cellId: focusedCellId } });
    }
  }, [focusedCellId, state.inspectorOpen, dispatch]);

  // Global keyboard handler for command mode shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!focusedCellId) return;

      // If the event target is an input/textarea/contenteditable, skip
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'INPUT' ||
        target.isContentEditable ||
        // CodeMirror editor is focused
        target.closest('.cm-editor')
      ) {
        setFocusedCellId(null);
        return;
      }

      const cells = state.cells;
      const idx = cells.findIndex((c) => c.id === focusedCellId);
      if (idx === -1) return;

      switch (e.key) {
        case 'a': {
          e.preventDefault();
          const cell = makeCell('sql');
          if (idx === 0) {
            // Prepend: add then move up from position 1 → 0
            dispatch({ type: 'ADD_CELL', cell, afterId: cells[0].id });
            dispatch({ type: 'MOVE_CELL', id: cell.id, direction: 'up' });
          } else {
            const afterId = cells[idx - 1].id;
            dispatch({ type: 'ADD_CELL', cell, afterId });
          }
          setFocusedCellId(cell.id);
          break;
        }

        case 'b': {
          e.preventDefault();
          const cell = makeCell('sql');
          dispatch({ type: 'ADD_CELL', cell, afterId: focusedCellId });
          setFocusedCellId(cell.id);
          break;
        }

        case 'd': {
          e.preventDefault();
          const now = Date.now();
          if (now - lastDPressRef.current <= 500) {
            // Double-d: delete cell
            dispatch({ type: 'DELETE_CELL', id: focusedCellId });
            // Focus adjacent cell
            if (cells.length > 1) {
              const newFocusIdx = idx > 0 ? idx - 1 : 1;
              setFocusedCellId(cells[newFocusIdx]?.id ?? null);
            } else {
              setFocusedCellId(null);
            }
            lastDPressRef.current = 0;
          } else {
            lastDPressRef.current = now;
          }
          break;
        }

        case 'Enter': {
          if (e.shiftKey) {
            e.preventDefault();
            const cell = cells[idx];
            if (cell && cell.type !== 'markdown') {
              executeCell(cell.id);
            }
          }
          break;
        }

        default:
          break;
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [focusedCellId, state.cells, dispatch, executeCell]);

  // Clear focus when clicking outside any cell
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-cell-id]')) {
        setFocusedCellId(null);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  // Drag handlers
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    // Make the dragged element semi-transparent
    const target = e.currentTarget as HTMLElement;
    setTimeout(() => { target.style.opacity = '0.4'; }, 0);
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).style.opacity = '1';
    setDragIndex(null);
    setDropIndex(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropIndex(index);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== toIndex) {
      dispatch({ type: 'REORDER_CELL', fromIndex: dragIndex, toIndex });
    }
    setDragIndex(null);
    setDropIndex(null);
  }, [dragIndex, dispatch]);

  if (state.cells.length === 0) {
    return (
      <div
        style={{
          maxWidth: 1200,
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
        maxWidth: 1200,
        margin: '0 auto',
        padding: '0 24px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <AddCellBar afterId={undefined} />

      {state.cells.map((cell, index) => (
        <React.Fragment key={cell.id}>
          <div
            ref={(el) => registerCellRef(cell.id, el)}
            data-cell-id={cell.id}
            draggable
            onDragStart={(e) => handleDragStart(e, index)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, index)}
            onDrop={(e) => handleDrop(e, index)}
            onClick={(e) => {
              // Select cell on gutter/header click but not editor area
              const target = e.target as HTMLElement;
              if (
                !target.closest('.cm-editor') &&
                !target.closest('textarea') &&
                !target.closest('input')
              ) {
                setFocusedCellId(cell.id);
              }
            }}
            style={{
              outline: focusedCellId === cell.id ? `2px solid ${t.accent}40` : 'none',
              outlineOffset: 2,
              borderRadius: 10,
              transition: 'outline 0.1s, transform 0.15s',
              position: 'relative',
              // Drop indicator
              ...(dropIndex === index && dragIndex !== null && dragIndex !== index
                ? { borderTop: `2px solid ${t.accent}` }
                : {}),
            }}
          >
            {/* Drag handle — visible on hover */}
            <div
              style={{
                position: 'absolute',
                left: -20,
                top: 8,
                width: 16,
                height: 24,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'grab',
                color: t.textMuted,
                opacity: 0,
                transition: 'opacity 0.15s',
                zIndex: 5,
              }}
              className="drag-handle"
            >
              <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor">
                <circle cx="2" cy="2" r="1.2" />
                <circle cx="6" cy="2" r="1.2" />
                <circle cx="2" cy="7" r="1.2" />
                <circle cx="6" cy="7" r="1.2" />
                <circle cx="2" cy="12" r="1.2" />
                <circle cx="6" cy="12" r="1.2" />
              </svg>
            </div>
            <CellComponent cell={cell} index={index} />
          </div>
          <AddCellBar afterId={cell.id} />
        </React.Fragment>
      ))}

      {/* Global style for drag handle visibility */}
      <style>{`
        [data-cell-id]:hover .drag-handle { opacity: 0.5 !important; }
        [data-cell-id]:hover .drag-handle:hover { opacity: 1 !important; }
      `}</style>
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
