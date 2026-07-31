import { useCallback, useEffect, useState } from 'react';

/**
 * Persist one server conversation id per AI surface so a page refresh resumes
 * that surface without pulling the full agent-rendering bundle into unrelated
 * pages.
 */
export function usePersistedAgentThreadId(scope: string): {
  threadId: string | undefined;
  onThreadIdChange: (id: string) => void;
  resetThreadId: () => void;
} {
  const storageKey = `dql.agent.threadId.${scope}`;
  const [threadId, setThreadId] = useState<string | undefined>(() => readStoredThreadId(storageKey));
  useEffect(() => {
    setThreadId(readStoredThreadId(storageKey));
  }, [storageKey]);
  const onThreadIdChange = useCallback((id: string) => {
    setThreadId(id);
    try { window.localStorage.setItem(storageKey, id); } catch { /* best-effort */ }
  }, [storageKey]);
  const resetThreadId = useCallback(() => {
    setThreadId(undefined);
    try { window.localStorage.removeItem(storageKey); } catch { /* best-effort */ }
  }, [storageKey]);
  return { threadId, onThreadIdChange, resetThreadId };
}

function readStoredThreadId(storageKey: string): string | undefined {
  try {
    return window.localStorage.getItem(storageKey) ?? undefined;
  } catch {
    return undefined;
  }
}
