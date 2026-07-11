import type { Cell, CellDependency } from "../store/types";

const HANDLE_PATTERN = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

export interface DependencyPlan {
  ordered: Cell[];
  cycleCellIds: string[];
  missing: Array<{ cellId: string; dependency: string }>;
}

export function inferCellDependencies(
  cell: Cell,
  cells: Cell[],
): CellDependency[] {
  const byHandle = new Map<string, string>();
  for (const candidate of cells) {
    byHandle.set(candidate.id, candidate.id);
    if (candidate.name) byHandle.set(candidate.name, candidate.id);
  }
  const dependencies = new Map<string, CellDependency>();
  for (const dependency of cell.dependencies ?? [])
    dependencies.set(dependency.cellId, dependency);
  for (const match of cell.content.matchAll(HANDLE_PATTERN)) {
    const handle = match[1];
    const cellId = byHandle.get(handle);
    if (cellId && cellId !== cell.id)
      dependencies.set(cellId, { cellId, output: handle });
  }
  if (cell.upstream) {
    const cellId = byHandle.get(cell.upstream);
    if (cellId && cellId !== cell.id)
      dependencies.set(cellId, { cellId, output: cell.upstream });
  }
  return [...dependencies.values()];
}

export function planNotebookExecution(cells: Cell[]): DependencyPlan {
  const executable = cells.filter(
    (cell) => !["markdown", "param", "chat"].includes(cell.type),
  );
  const executableIds = new Set(executable.map((cell) => cell.id));
  const allIds = new Set(cells.map((cell) => cell.id));
  const incoming = new Map(executable.map((cell) => [cell.id, 0]));
  const outgoing = new Map(executable.map((cell) => [cell.id, [] as string[]]));
  const missing: DependencyPlan["missing"] = [];

  for (const cell of executable) {
    for (const dependency of inferCellDependencies(cell, cells)) {
      if (!allIds.has(dependency.cellId)) {
        missing.push({ cellId: cell.id, dependency: dependency.cellId });
        continue;
      }
      if (!executableIds.has(dependency.cellId)) continue;
      outgoing.get(dependency.cellId)!.push(cell.id);
      incoming.set(cell.id, (incoming.get(cell.id) ?? 0) + 1);
    }
  }

  // Preserve notebook order whenever several cells are independently runnable.
  const ready = executable.filter((cell) => incoming.get(cell.id) === 0);
  const ordered: Cell[] = [];
  while (ready.length > 0) {
    const cell = ready.shift()!;
    ordered.push(cell);
    for (const dependentId of outgoing.get(cell.id) ?? []) {
      const count = (incoming.get(dependentId) ?? 0) - 1;
      incoming.set(dependentId, count);
      if (count === 0) {
        const dependent = executable.find(
          (candidate) => candidate.id === dependentId,
        );
        if (dependent) ready.push(dependent);
      }
    }
  }

  return {
    ordered,
    cycleCellIds: executable
      .filter((cell) => !ordered.some((item) => item.id === cell.id))
      .map((cell) => cell.id),
    missing,
  };
}

export function downstreamCellIds(
  sourceId: string,
  cells: Cell[],
): Set<string> {
  const downstream = new Set<string>();
  const queue = [sourceId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const cell of cells) {
      if (downstream.has(cell.id) || cell.id === sourceId) continue;
      if (
        inferCellDependencies(cell, cells).some(
          (dependency) => dependency.cellId === current,
        )
      ) {
        downstream.add(cell.id);
        queue.push(cell.id);
      }
    }
  }
  return downstream;
}
