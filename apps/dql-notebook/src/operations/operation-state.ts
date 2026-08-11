import type {
  BlockCertificationOperationResult,
  LocalOperation,
} from '../api/client';

const TERMINAL_OPERATION_STATUSES = new Set<LocalOperation['status']>([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);

export function isTerminalOperation(operation: LocalOperation): boolean {
  return TERMINAL_OPERATION_STATUSES.has(operation.status);
}

/**
 * Select the durable operation state when POST, SSE, list polling, and exact-ID
 * recovery arrive out of order.
 */
export function preferredOperation(
  current: LocalOperation,
  incoming: LocalOperation,
): LocalOperation {
  if (current.id !== incoming.id) return incoming;
  const currentTerminal = isTerminalOperation(current);
  const incomingTerminal = isTerminalOperation(incoming);

  // A queued/running response can never reopen a terminal operation, even if
  // an intermediary assigned it a later timestamp.
  if (currentTerminal && !incomingTerminal) return current;
  if (incoming.updatedAt < current.updatedAt) return current;
  if (incoming.updatedAt > current.updatedAt) return incoming;
  if (currentTerminal !== incomingTerminal) return incomingTerminal ? incoming : current;
  if (incoming.progress !== current.progress) return incoming.progress > current.progress ? incoming : current;
  return incoming;
}

export function mergeOperation(
  current: LocalOperation[],
  operation: LocalOperation,
): LocalOperation[] {
  const existing = current.find((item) => item.id === operation.id);
  const preferred = existing ? preferredOperation(existing, operation) : operation;
  return boundOperationHistory([...current.filter((item) => item.id !== operation.id), preferred]);
}

export function mergeOperationLists(
  current: LocalOperation[],
  incoming: LocalOperation[],
): LocalOperation[] {
  return incoming.reduce(mergeOperation, current);
}

/** Nonterminal ids returned by durable list recovery on provider mount. */
export function listedNonterminalOperationIds(operations: LocalOperation[]): string[] {
  return operations
    .filter((operation) => !isTerminalOperation(operation))
    .map((operation) => operation.id);
}

export function seedListedNonterminalOperationIds(
  trackedOperationIds: Set<string>,
  operations: LocalOperation[],
): void {
  for (const operationId of listedNonterminalOperationIds(operations)) {
    trackedOperationIds.add(operationId);
  }
}

export async function recoverTrackedOperationsById(
  trackedOperationIds: Set<string>,
  getOperation: (operationId: string) => Promise<LocalOperation>,
  acceptOperation: (operation: LocalOperation) => boolean | void,
): Promise<void> {
  await Promise.all([...trackedOperationIds].map(async (operationId) => {
    try {
      const operation = await getOperation(operationId);
      if (acceptOperation(operation) === false) return;
      if (isTerminalOperation(operation)) trackedOperationIds.delete(operationId);
    } catch {
      // Exact durable recovery is retried by the provider interval.
    }
  }));
}

export type ReconciliableBlockCertificationOperation = LocalOperation & {
  result: BlockCertificationOperationResult;
};

/**
 * Terminal block results must be applied oldest-to-newest. The task-center
 * list is newest-first for display, but replaying it in that order lets an
 * older certification overwrite the newest block state after a remount.
 */
export function blockCertificationOperationsForReconciliation(
  operations: LocalOperation[],
  handledOperationIds: ReadonlySet<string> = new Set(),
): ReconciliableBlockCertificationOperation[] {
  return operations
    .filter((operation) => operation.type === 'block_certification' && operation.status === 'succeeded')
    .filter((operation) => !handledOperationIds.has(operation.id))
    .filter((operation): operation is ReconciliableBlockCertificationOperation => {
      const result = operation.result as BlockCertificationOperationResult | undefined;
      return Boolean(result?.block && result.outcome);
    })
    .sort((left, right) => (
      left.updatedAt.localeCompare(right.updatedAt)
      || left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id)
    ));
}

export function newestMatchingBlockCertificationOperation(
  operations: LocalOperation[],
  input: {
    operationId?: string | null;
    activePath?: string | null;
    sourceFingerprint?: string | null;
  },
): LocalOperation | undefined {
  if (input.operationId) {
    const exact = operations.find((operation) => (
      operation.type === 'block_certification' && operation.id === input.operationId
    ));
    if (exact) return exact;
  }
  const activePath = normalizeBlockPath(input.activePath);
  const sourceFingerprint = input.sourceFingerprint?.trim();
  return operations
    .filter((operation) => operation.type === 'block_certification')
    .filter((operation) => {
      const result = operationResult(operation);
      const paths = [
        normalizeBlockPath(operation.scope.startsWith('block:') ? operation.scope.slice('block:'.length) : undefined),
        normalizeBlockPath(result?.oldPath),
        normalizeBlockPath(result?.draftPath),
        normalizeBlockPath(result?.newPath),
      ].filter((value): value is string => Boolean(value));
      const pathMatches = Boolean(activePath && paths.includes(activePath));
      const revisionMatches = Boolean(
        sourceFingerprint
        && operation.resourceRevision
        && (operation.resourceRevision === sourceFingerprint
          || operation.resourceRevision.startsWith(`${sourceFingerprint}:`)),
      );
      return pathMatches || revisionMatches;
    })
    .sort((left, right) => (
      right.updatedAt.localeCompare(left.updatedAt)
      || right.createdAt.localeCompare(left.createdAt)
    ))[0];
}

function operationResult(operation: LocalOperation): Record<string, unknown> | undefined {
  return operation.result && typeof operation.result === 'object' && !Array.isArray(operation.result)
    ? operation.result as Record<string, unknown>
    : undefined;
}

function normalizeBlockPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function boundOperationHistory(operations: LocalOperation[], terminalLimit = 50): LocalOperation[] {
  let terminalCount = 0;
  return [...operations]
    .sort((left, right) => (
      right.updatedAt.localeCompare(left.updatedAt)
      || right.createdAt.localeCompare(left.createdAt)
      || right.id.localeCompare(left.id)
    ))
    .filter((operation) => {
      if (!isTerminalOperation(operation)) return true;
      terminalCount += 1;
      return terminalCount <= terminalLimit;
    });
}
