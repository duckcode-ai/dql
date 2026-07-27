import { useCallback } from 'react';
import { api, type DatasetSource } from '../api/client';
import { makeCell, useNotebook } from '../store/NotebookStore';
import type { Cell, NotebookFile } from '../store/types';
import type { InsertDqlPayload } from '../components/agent/UnifiedAgentRunPanel';
import { focusInsertedNotebookCell } from './notebook-cell-focus';

/** Cell names are used as identifiers downstream, so keep them safe and bounded. */
export function safeCellName(value: string): string {
  const clean = value
    .replace(/[^a-zA-Z0-9_ -]+/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return clean || 'ai_analysis';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turn a governed answer into the notebook cells that reproduce it.
 *
 * A mixed-source plan is inherently several cells (a markdown contract, then the
 * bounded warehouse extraction); everything else is one self-contained query cell
 * carrying the compiled SQL, the executed result, and the DQL provenance so the
 * user can re-run and edit it rather than just read it.
 */
export function buildNotebookCellsFromAnswer(
  payload: InsertDqlPayload,
  datasets: DatasetSource[],
): Cell[] {
  const dqlSource = payload.dqlArtifact?.source?.trim();
  const sql = (payload.sql ?? dqlSource ?? '').trim();
  if (!sql && !dqlSource) return [];

  if (payload.mixedSourcePlan) {
    const plan = payload.mixedSourcePlan;
    const contextCell = makeCell('markdown', [
      `### ${payload.title ?? 'Mixed-source analysis'}`,
      '',
      `This analysis combines a bounded warehouse extraction with the local dataset \`${plan.localDataset}\`.`,
      '',
      ...(plan.warehouseRelations?.length ? [`- Warehouse sources: ${plan.warehouseRelations.map((relation) => `\`${relation}\``).join(', ')}`] : []),
      `- Join: \`${plan.warehouseKey}\` = \`${plan.localKey}\``,
      '- Trust: local mixed-source analysis · review required',
    ].join('\n'));
    contextCell.name = safeCellName('Analysis context');
    const extractionCell = makeCell('sql', sql);
    extractionCell.name = safeCellName(payload.title ?? 'Warehouse extraction');
    extractionCell.mixedSourcePlan = plan;
    extractionCell.executionTarget = { target: 'connection' };
    extractionCell.datasetRefs = [{
      id: plan.datasetId ?? plan.localDataset,
      alias: plan.localDataset,
      role: 'source',
    }];
    return [contextCell, extractionCell];
  }

  const cell = makeCell(dqlSource ? 'dql' : 'sql', dqlSource || sql);
  cell.name = safeCellName(payload.title ?? payload.dqlArtifact?.name ?? 'AI analysis');
  if (payload.result) {
    cell.result = payload.result;
    cell.status = 'success';
    cell.executionCount = 1;
  }
  if (payload.chartConfig) cell.chartConfig = payload.chartConfig;
  if (payload.dqlArtifact) {
    cell.dqlArtifact = {
      source: payload.dqlArtifact.source,
      sql: payload.sql,
      name: payload.dqlArtifact.name,
      sourcePath: payload.dqlArtifact.sourcePath,
      kind: payload.dqlArtifact.kind,
      metrics: payload.dqlArtifact.metrics,
      dimensions: payload.dqlArtifact.dimensions,
      parameters: payload.dqlArtifact.parameters,
      parameterValues: payload.dqlArtifact.parameterValues,
      persistence: payload.dqlArtifact.persistence,
      trustState: payload.dqlArtifact.trustState,
      compiledSql: payload.dqlArtifact.compiledSql ?? payload.sql,
      ...(payload.question ? { question: payload.question } : {}),
    };
    cell.dqlParameterValues = payload.dqlArtifact.parameterValues;
  }
  const datasetRefs = datasets
    .filter((dataset) => new RegExp(`\\b${escapeRegExp(dataset.alias)}\\b`, 'i').test(sql))
    .map((dataset) => ({
      id: dataset.id,
      alias: dataset.alias,
      role: dataset.storageMode === 'staged' ? ('staged' as const) : ('source' as const),
      fingerprint: dataset.fileFingerprint,
    }));
  if (datasetRefs.length > 0) {
    cell.executionTarget = { target: 'local' };
    cell.datasetRefs = datasetRefs;
    if (cell.dqlArtifact) cell.dqlArtifact.reviewState = 'review_required';
  }
  return [cell];
}

function notebookSlugFor(title: string | undefined): string {
  const base = (title ?? 'ai analysis')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'ai-analysis';
}

/**
 * Send a governed answer into the notebook workspace.
 *
 * When a notebook is open the cells are appended to it. When none is open the
 * cells used to be dispatched into an empty store and silently vanish — the
 * NotebookEditor renders its welcome screen whenever there is no active file, so
 * nothing was ever shown. Now a real notebook is created and opened with the
 * answer already in it, which is the whole point of the handoff: the user lands
 * somewhere they can run and modify the query.
 */
export function useOpenAnswerInNotebook(): (
  payload: InsertDqlPayload,
  options?: { afterId?: string; datasets?: DatasetSource[] },
) => Promise<void> {
  const { state, dispatch } = useNotebook();
  return useCallback(async (payload, options) => {
    const cells = buildNotebookCellsFromAnswer(payload, options?.datasets ?? []);
    if (cells.length === 0) return;

    if (state.activeFile && state.activeFile.type !== 'block') {
      let afterId = options?.afterId;
      for (const cell of cells) {
        dispatch({ type: 'ADD_CELL', cell, ...(afterId ? { afterId } : {}) });
        afterId = cell.id;
      }
      focusInsertedNotebookCell(cells[cells.length - 1]!.id);
      return;
    }

    const title = payload.title ?? payload.dqlArtifact?.name ?? 'AI analysis';
    const slug = notebookSlugFor(title);
    let path = `notebooks/${slug}.dqlnb`;
    try {
      const created = await api.createNotebook(slug, 'blank');
      path = created.path;
    } catch {
      // Server unavailable — still open the notebook locally so the answer is
      // never dropped; the first save will create the file.
    }
    const file: NotebookFile = {
      name: path.split('/').pop() ?? `${slug}.dqlnb`,
      path,
      type: 'notebook',
      folder: 'notebooks',
      isNew: true,
    };
    dispatch({ type: 'FILE_ADDED', file });
    dispatch({ type: 'OPEN_FILE', file, cells, title });
    focusInsertedNotebookCell(cells[cells.length - 1]!.id);
  }, [dispatch, state.activeFile]);
}
