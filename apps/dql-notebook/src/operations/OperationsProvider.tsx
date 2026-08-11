import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type LocalOperation,
} from '../api/client';
import { useNotebookStore } from '../store/NotebookStore';
import { streamServerEvents } from '../api/server-auth';
import {
  blockCertificationOperationsForReconciliation,
  isTerminalOperation,
  mergeOperation,
  mergeOperationLists,
  recoverTrackedOperationsById,
  seedListedNonterminalOperationIds,
} from './operation-state';

const OPERATIONS_QUERY_KEY = ['local-operations'] as const;

interface OperationsContextValue {
  operations: LocalOperation[];
  activeCount: number;
  loading: boolean;
  cancel: (operationId: string) => Promise<void>;
  track: (operation: LocalOperation) => void;
}

const OperationsContext = createContext<OperationsContextValue | null>(null);

export function OperationsProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const handledTerminalOperations = useRef(new Set<string>());
  const trackedOperationIds = useRef(new Set<string>());
  const dispatch = useNotebookStore((state) => state.dispatch);
  const query = useQuery({
    queryKey: OPERATIONS_QUERY_KEY,
    queryFn: async () => {
      const listed = (await api.listOperations(50)).operations;
      const current = queryClient.getQueryData<LocalOperation[]>(OPERATIONS_QUERY_KEY) ?? [];
      return mergeOperationLists(current, listed);
    },
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    // Polling is a recovery path if the authenticated event stream is dropped.
    refetchInterval: 1_500,
  });
  const operations = query.data ?? [];

  useEffect(() => {
    let alive = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const connect = () => {
      controller = new AbortController();
      void streamServerEvents('/api/operations/events', (frame) => {
        if (frame.event !== 'operation') return;
        try {
          const operation = JSON.parse(frame.data) as LocalOperation;
          queryClient.setQueryData<LocalOperation[]>(OPERATIONS_QUERY_KEY, (current = []) => (
            mergeOperation(current, operation)
          ));
        } catch {
          // A malformed progress frame must not interrupt later updates.
        }
      }, controller.signal).catch(() => {
        if (!alive || controller?.signal.aborted) return;
        reconnectTimer = setTimeout(connect, 5_000);
      });
    };
    connect();
    return () => {
      alive = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      controller?.abort();
    };
  }, [queryClient]);

  useEffect(() => {
    // A provider remount loses its component-local ref even though durable
    // queued/running operations survive. Seed exact-id recovery from every
    // nonterminal operation returned by the list endpoint.
    seedListedNonterminalOperationIds(trackedOperationIds.current, operations);
  }, [operations]);

  useEffect(() => {
    let alive = true;
    let recovering = false;
    const recoverTrackedOperations = async () => {
      if (recovering || trackedOperationIds.current.size === 0) return;
      recovering = true;
      try {
        await recoverTrackedOperationsById(
          trackedOperationIds.current,
          (operationId) => api.getOperation(operationId),
          (operation) => {
            if (!alive) return false;
            queryClient.setQueryData<LocalOperation[]>(OPERATIONS_QUERY_KEY, (current = []) => (
              mergeOperation(current, operation)
            ));
          },
        );
      } finally {
        recovering = false;
      }
    };
    void recoverTrackedOperations();
    const timer = window.setInterval(() => void recoverTrackedOperations(), 1_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [queryClient]);

  useEffect(() => {
    for (const operation of blockCertificationOperationsForReconciliation(
      operations,
      handledTerminalOperations.current,
    )) {
      const result = operation.result;
      handledTerminalOperations.current.add(operation.id);
      dispatch({
        type: 'RECONCILE_BLOCK_CERTIFICATION',
        outcome: result.outcome,
        oldPath: result.oldPath,
        draftPath: result.draftPath,
        newPath: result.newPath,
        payload: result.block,
      });
      window.dispatchEvent(new CustomEvent('dql:block-library-invalidated', {
        detail: { operationId: operation.id, outcome: result.outcome },
      }));
    }
  }, [dispatch, operations]);

  const value = useMemo<OperationsContextValue>(() => ({
    operations,
    activeCount: operations.filter((operation) => operation.status === 'queued' || operation.status === 'running').length,
    loading: query.isLoading,
    cancel: async (operationId: string) => {
      const operation = await api.cancelOperation(operationId);
      trackedOperationIds.current.delete(operationId);
      queryClient.setQueryData<LocalOperation[]>(OPERATIONS_QUERY_KEY, (current = []) => (
        mergeOperation(current, operation)
      ));
    },
    track: (operation: LocalOperation) => {
      if (isTerminalOperation(operation)) trackedOperationIds.current.delete(operation.id);
      else trackedOperationIds.current.add(operation.id);
      queryClient.setQueryData<LocalOperation[]>(OPERATIONS_QUERY_KEY, (current = []) => (
        mergeOperation(current, operation)
      ));
    },
  }), [operations, query.isLoading, queryClient]);

  return <OperationsContext.Provider value={value}>{children}</OperationsContext.Provider>;
}

export function useOperations(): OperationsContextValue {
  const value = useContext(OperationsContext);
  if (!value) throw new Error('useOperations must be used inside OperationsProvider.');
  return value;
}
