import { useCallback, useRef } from "react";
import { useNotebook, makeCellId } from "../store/NotebookStore";
import { api } from "../api/client";
import { useVariableSubstitution } from "./useVariableSubstitution";
import type { Cell } from "../store/types";
import { extractSqlFromText, parseDqlChartConfig } from "../utils/block-studio";
import { planNotebookExecution } from "../utils/notebook-dependencies";
import { findDatasetReferences, findWarehouseReferences } from '../utils/dataset-references';

// Global map of running AbortControllers keyed by cellId
const runningControllers = new Map<string, AbortController>();

/**
 * Extract executable SQL from a cell.
 * - sql cells: use content directly
 * - dql cells: extract the SQL inside query = """...""", or plain SQL keywords
 * - markdown/param cells: return null (not executable)
 */
function extractSql(cell: Cell): string | null {
  if (cell.type === 'markdown' || cell.type === 'param') return null;
  if (cell.type === 'sql') return cell.content.trim() || null;

  const dqlContent = cell.content.trim();
  if (!dqlContent) return null;

  return extractSqlFromText(dqlContent);
}

function normalizeServerChartConfig(value: unknown): Cell['chartConfig'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  return {
    ...(typeof raw.chart === 'string' ? { chart: raw.chart } : {}),
    ...(typeof raw.x === 'string' ? { x: raw.x } : {}),
    ...(typeof raw.y === 'string' ? { y: raw.y } : {}),
    ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
  };
}

export function useQueryExecution() {
  const { state, dispatch } = useNotebook();
  const { substituteVariables } = useVariableSubstitution();

  const executeCell = useCallback(
    async (cellId: string) => {
      const cell = state.cells.find((c) => c.id === cellId);
      if (!cell) return;

      if (cell.type === 'dql') {
        const start = Date.now();
        const prev = runningControllers.get(cellId);
        if (prev) prev.abort();

        const controller = new AbortController();
        runningControllers.set(cellId, controller);

        dispatch({
          type: 'UPDATE_CELL',
          id: cellId,
          updates: { status: 'running', error: undefined, result: undefined, fromSnapshot: false },
        });

        try {
          const payload = await api.executeNotebookCell(cell, controller.signal, {
            notebookPath: state.activeFile?.path,
            cellId: cell.id,
            cellName: cell.name,
            source: 'notebook_dql_cell',
          });
          if (!payload.result) {
            throw new Error('DQL cell produced no executable result.');
          }
          const elapsed = Date.now() - start;
          const nextCount = (cell.executionCount ?? 0) + 1;
          const chartConfig = normalizeServerChartConfig(payload.chartConfig) ?? parseDqlChartConfig(cell.content);

          dispatch({
            type: 'UPDATE_CELL',
            id: cellId,
            updates: {
              status: 'success',
              result: {
                ...payload.result,
                executionTime: payload.result.executionTime ?? elapsed,
                rowCount: payload.result.rowCount ?? payload.result.rows.length,
              },
              ...(chartConfig ? { chartConfig } : {}),
              executionCount: nextCount,
              stale: false,
            },
          });

          dispatch({
            type: 'APPEND_QUERY_LOG',
            entry: {
              id: makeCellId(),
              cellName: payload.blockName ?? cell.name ?? cell.id,
              rows: payload.result.rowCount ?? payload.result.rows.length,
              time: payload.result.executionTime ?? elapsed,
              ts: new Date(),
            },
          });

          setTimeout(() => {
            dispatch({
              type: 'UPDATE_CELL',
              id: cellId,
              updates: { status: 'idle' },
            });
          }, 2000);
        } catch (err) {
          if (controller.signal.aborted) {
            dispatch({
              type: 'UPDATE_CELL',
              id: cellId,
              updates: { status: 'idle', error: undefined },
            });
            return;
          }

          const elapsed = Date.now() - start;
          const message = err instanceof Error ? err.message : String(err);
          dispatch({
            type: 'UPDATE_CELL',
            id: cellId,
            updates: {
              status: 'error',
              error: message,
              executionCount: (cell.executionCount ?? 0) + 1,
            },
          });
          dispatch({
            type: 'APPEND_QUERY_LOG',
            entry: {
              id: makeCellId(),
              cellName: cell.name ?? cell.id,
              rows: 0,
              time: elapsed,
              ts: new Date(),
              error: message,
            },
          });
        } finally {
          runningControllers.delete(cellId);
        }
        return;
      }

      const rawSql = extractSql(cell);
      if (!rawSql) return;

      const referencedDatasets = findDatasetReferences(rawSql, state.schemaTables);
      const referencedWarehouseTables = findWarehouseReferences(rawSql, state.schemaTables);
      if (referencedDatasets.length > 0 && referencedWarehouseTables.length > 0) {
        dispatch({
          type: 'UPDATE_CELL',
          id: cellId,
          updates: {
            status: 'error',
            datasetRefs: referencedDatasets,
            error: [
              `Mixed-source query detected: ${referencedWarehouseTables.join(', ')} runs in the warehouse, while ${referencedDatasets.map((dataset) => dataset.alias ?? dataset.id).join(', ')} is local data.`,
              'Direct cross-engine joins are not executed. Run the warehouse-only extraction first, then choose Combine with local data on its result.',
            ].join(' '),
          },
        });
        return;
      }
      const executionTarget = referencedDatasets.length > 0
        ? { target: 'local' as const }
        : cell.executionTarget;
      if (referencedDatasets.length > 0 && cell.executionTarget?.target !== 'local') {
        dispatch({
          type: 'UPDATE_CELL',
          id: cellId,
          updates: { executionTarget, datasetRefs: referencedDatasets },
        });
      }

      // Substitute {{cell_name}} references with inline CTEs
      const { sql } = substituteVariables(rawSql);

      const start = Date.now();

      // Cancel any previous execution for this cell
      const prev = runningControllers.get(cellId);
      if (prev) prev.abort();

      const controller = new AbortController();
      runningControllers.set(cellId, controller);

      // Mark running
      dispatch({
        type: 'UPDATE_CELL',
        id: cellId,
        updates: { status: 'running', error: undefined, result: undefined, fromSnapshot: false },
      });

      try {
        const result = await api.executeQuery(
          sql,
          controller.signal,
          {
            notebookPath: state.activeFile?.path,
            cellId: cell.id,
            cellName: cell.name,
            source: "notebook_sql_cell",
          },
          executionTarget,
        );
        const elapsed = Date.now() - start;

        const nextCount = (cell.executionCount ?? 0) + 1;
        const datasetRefs = cell.executionTarget?.target === 'local'
          ? findDatasetReferences(sql, state.schemaTables)
          : cell.datasetRefs;

        dispatch({
          type: 'UPDATE_CELL',
          id: cellId,
          updates: {
            status: 'success',
            result: {
              ...result,
              executionTime: result.executionTime ?? elapsed,
              rowCount: result.rowCount ?? result.rows.length,
            },
            executionCount: nextCount,
            stale: false,
            datasetRefs,
          },
        });

        dispatch({
          type: 'APPEND_QUERY_LOG',
          entry: {
            id: makeCellId(),
            cellName: cell.name ?? cell.id,
            rows: result.rowCount ?? result.rows.length,
            time: result.executionTime ?? elapsed,
            ts: new Date(),
          },
        });

        // Reset border color after 2 seconds
        setTimeout(() => {
          dispatch({
            type: 'UPDATE_CELL',
            id: cellId,
            updates: { status: 'idle' },
          });
        }, 2000);
      } catch (err) {
        // If aborted, show cancelled status instead of error
        if (controller.signal.aborted) {
          dispatch({
            type: 'UPDATE_CELL',
            id: cellId,
            updates: { status: 'idle', error: undefined },
          });
          return;
        }

        const elapsed = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);

        dispatch({
          type: 'UPDATE_CELL',
          id: cellId,
          updates: {
            status: 'error',
            error: message,
            executionCount: (cell.executionCount ?? 0) + 1,
          },
        });

        dispatch({
          type: 'APPEND_QUERY_LOG',
          entry: {
            id: makeCellId(),
            cellName: cell.name ?? cell.id,
            rows: 0,
            time: elapsed,
            ts: new Date(),
            error: message,
          },
        });
      } finally {
        runningControllers.delete(cellId);
      }
    },
    [state.cells, state.activeFile?.path, state.schemaTables, dispatch, substituteVariables]
  );

  const executeAll = useCallback(async () => {
    const plan = planNotebookExecution(state.cells);
    if (plan.cycleCellIds.length > 0) {
      for (const cellId of plan.cycleCellIds) {
        dispatch({
          type: "UPDATE_CELL",
          id: cellId,
          updates: {
            status: "error",
            error:
              "Dependency cycle detected. Update the cell dependencies before running all.",
          },
        });
      }
      return;
    }
    for (const missing of plan.missing) {
      dispatch({
        type: "UPDATE_CELL",
        id: missing.cellId,
        updates: {
          status: "error",
          error: `Missing dependency: ${missing.dependency}`,
        },
      });
    }
    if (plan.missing.length > 0) return;
    for (const cell of plan.ordered) {
      await executeCell(cell.id);
    }
  }, [state.cells, executeCell, dispatch]);

  const executeDependents = useCallback(
    async (paramName: string) => {
      if (!paramName) return;
      const pattern = `{{${paramName}}}`;
      for (const cell of state.cells) {
        if (cell.type === 'markdown' || cell.type === 'param') continue;
        if (cell.content.includes(pattern)) {
          await executeCell(cell.id);
        }
      }
    },
    [state.cells, executeCell]
  );

  const cancelCell = useCallback((cellId: string) => {
    const controller = runningControllers.get(cellId);
    if (controller) {
      controller.abort();
      runningControllers.delete(cellId);
    }
    dispatch({
      type: 'UPDATE_CELL',
      id: cellId,
      updates: { status: 'idle' },
    });
  }, [dispatch]);

  return { executeCell, executeAll, executeDependents, cancelCell };
}
