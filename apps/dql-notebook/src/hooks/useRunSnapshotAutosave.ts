import { useEffect, useRef } from 'react';
import { useNotebook } from '../store/NotebookStore';
import { api } from '../api/client';
import type { Cell, RunSnapshot, RunSnapshotCell } from '../store/types';

const DEBOUNCE_MS = 600;

function buildSnapshot(path: string, cells: Cell[]): RunSnapshot {
  const entries: RunSnapshotCell[] = cells
    .filter((c) => c.result || c.error || (c.executionCount ?? 0) > 0)
    .map((c) => ({
      cellId: c.id,
      status: c.status,
      result: c.result,
      error: c.error,
      executionCount: c.executionCount,
      executedAt: new Date().toISOString(),
    }));
  return {
    version: 1,
    notebookPath: path,
    capturedAt: new Date().toISOString(),
    cells: entries,
  };
}

function snapshotSignature(cells: Cell[]): string {
  // Cheap change-detector — hash of (cellId, executionCount, rowCount, errorLen).
  // Avoids saving when nothing materially changed (e.g. pure UI edits).
  return cells
    .map((c) => `${c.id}:${c.executionCount ?? 0}:${c.result?.rowCount ?? -1}:${(c.error ?? '').length}`)
    .join('|');
}

/**
 * Watches the current notebook's cells for result changes and debounce-saves
 * a `.run.json` sibling so the next open can rehydrate without re-executing.
 * Only fires when an actual execution landed (signature change); pure edits
 * don't trigger writes.
 */
export function useRunSnapshotAutosave(): void {
  const { state } = useNotebook();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSignature = useRef<string>('');
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    const path = state.activeFile?.path ?? null;
    if (!path) return;

    // When the notebook changes, reset the signature so we don't save stale.
    if (path !== lastPath.current) {
      lastPath.current = path;
      lastSignature.current = snapshotSignature(state.cells);
      return;
    }

    const sig = snapshotSignature(state.cells);
    if (sig === lastSignature.current) return;
    lastSignature.current = sig;

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const snapshot = buildSnapshot(path, state.cells);
      void api.saveRunSnapshot(path, snapshot).catch(() => {
        // Best-effort; snapshot saves should never surface errors to the user.
      });
    }, DEBOUNCE_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [state.cells, state.activeFile?.path]);
}
