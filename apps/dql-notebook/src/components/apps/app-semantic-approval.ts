import type { DashboardRunResponse } from '../../api/client';

/**
 * Only compiler-owned semantic executions can become governed approval
 * evidence. A bounded SQL repair may recover a useful preview, but it is a
 * review-required analytical derivation rather than the original semantic run.
 */
export function semanticApprovalState(
  semanticTileIds: string[],
  run: DashboardRunResponse | null,
): { ready: boolean; repairedTileIds: string[] } {
  const repairedTileIds = semanticTileIds.filter((tileId) => (
    run?.tiles.some((tile) => tile.tileId === tileId && tile.repair?.approvalEligible === false)
  ));
  return {
    ready: semanticTileIds.length > 0 && semanticTileIds.every((tileId) => (
      run?.tiles.some((tile) => tile.tileId === tileId && tile.status === 'ok' && tile.repair?.approvalEligible !== false)
    )),
    repairedTileIds,
  };
}
