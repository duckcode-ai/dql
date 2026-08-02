import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type BlockCertificationOperationResult,
  type LocalOperation,
} from '../api/client';
import { useNotebookStore } from '../store/NotebookStore';

const OPERATIONS_QUERY_KEY = ['local-operations'] as const;

interface OperationsContextValue {
  operations: LocalOperation[];
  activeCount: number;
  loading: boolean;
  cancel: (operationId: string) => Promise<void>;
  track: (operation: LocalOperation) => void;
}

const OperationsContext = createContext<OperationsContextValue | null>(null);

function mergeOperation(current: LocalOperation[], operation: LocalOperation): LocalOperation[] {
  const next = current.filter((item) => item.id !== operation.id);
  next.push(operation);
  return next
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 50);
}

export function OperationsProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const handledTerminalOperations = useRef(new Set<string>());
  const dispatch = useNotebookStore((state) => state.dispatch);
  const query = useQuery({
    queryKey: OPERATIONS_QUERY_KEY,
    queryFn: async () => (await api.listOperations(50)).operations,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const operations = query.data ?? [];

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const events = new EventSource('/api/operations/events');
    const onOperation = (event: MessageEvent<string>) => {
      try {
        const operation = JSON.parse(event.data) as LocalOperation;
        queryClient.setQueryData<LocalOperation[]>(OPERATIONS_QUERY_KEY, (current = []) => (
          mergeOperation(current, operation)
        ));
      } catch {
        // A malformed progress frame must not interrupt later updates.
      }
    };
    events.addEventListener('operation', onOperation as EventListener);
    return () => {
      events.removeEventListener('operation', onOperation as EventListener);
      events.close();
    };
  }, [queryClient]);

  useEffect(() => {
    for (const operation of operations) {
      if (operation.type !== 'block_certification' || operation.status !== 'succeeded') continue;
      if (handledTerminalOperations.current.has(operation.id)) continue;
      const result = operation.result as BlockCertificationOperationResult | undefined;
      if (!result?.block || !result.outcome) continue;
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
      queryClient.setQueryData<LocalOperation[]>(OPERATIONS_QUERY_KEY, (current = []) => (
        mergeOperation(current, operation)
      ));
    },
    track: (operation: LocalOperation) => {
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
