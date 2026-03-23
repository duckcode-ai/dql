import { useEffect, useRef } from 'react';
import { useNotebook } from '../store/NotebookStore';
import { api } from '../api/client';

interface WatchEvent {
  type: 'file-changed' | 'file-added' | 'file-deleted' | 'semantic-reload';
  path?: string;
}

/**
 * Connects to the server's SSE /api/watch endpoint and reacts to
 * file-system changes in the project's notebook directories.
 *
 * - file-added / file-deleted → refresh the file list
 * - file-changed → if it's the active file, re-read and prompt user
 */
export function useHotReload() {
  const { state, dispatch } = useNotebook();
  const activePathRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // Keep activePathRef in sync without re-subscribing SSE
  useEffect(() => {
    activePathRef.current = state.activeFile?.path ?? null;
  }, [state.activeFile]);

  useEffect(() => {
    // Only connect if the browser supports SSE and the server is reachable
    if (typeof EventSource === 'undefined') return;

    const connect = () => {
      const es = new EventSource(`${window.location.origin}/api/watch`);
      esRef.current = es;

      es.addEventListener('change', (e: MessageEvent) => {
        try {
          const event: WatchEvent = JSON.parse(e.data as string);

          if (event.type === 'file-added' || event.type === 'file-deleted') {
            // Refresh the file list
            api.listNotebooks().then((files) => {
              dispatch({ type: 'SET_FILES', files });
            });
          }

          if (event.type === 'file-changed') {
            // Refresh file list
            api.listNotebooks().then((files) => {
              dispatch({ type: 'SET_FILES', files });
            });
          }

          if (event.type === 'semantic-reload') {
            // Re-fetch semantic layer so the panel reflects the updated YAML
            dispatch({ type: 'SET_SEMANTIC_LOADING', loading: true });
            api.getSemanticLayer().then((layer) => {
              dispatch({ type: 'SET_SEMANTIC_LAYER', layer });
            });
          }
        } catch {
          // ignore parse errors
        }
      });

      es.addEventListener('error', () => {
        es.close();
        // Reconnect after 5s
        setTimeout(connect, 5000);
      });
    };

    connect();

    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, [dispatch]); // only mount/unmount once
}
