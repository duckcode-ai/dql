export const NOTEBOOK_CELL_FOCUS_EVENT = "dql:focus-notebook-cell";

/** Focus a newly inserted cell after React has committed it to the notebook. */
export function focusInsertedNotebookCell(cellId: string): void {
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent(NOTEBOOK_CELL_FOCUS_EVENT, {
      detail: { cellId },
    }));
  }, 0);
}
