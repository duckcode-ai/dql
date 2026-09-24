/**
 * Driver tiles in the App page run (RFC 0008 step 7).
 *
 * A driver tile never runs SQL of its own. The page run expands it into
 * ordinary governed Dataset comparison tiles (the whole measure, then one
 * per dimension), runs those like any other Dataset tile, and folds their
 * results back into one driver tile. Contract checks, filters, caching and
 * execution evidence are therefore exactly the Dataset tile path.
 */
import {
  readDriverDefinition,
  type DashboardDocument,
  type DashboardGridItem,
  type DatasetDescriptor,
} from '@duckcodeailabs/dql-core';
import {
  driverDimensionTileId,
  driverTotalTileId,
  foldDriverAnalysis,
  planDriverQueries,
  type DriverQueryPlan,
} from '@duckcodeailabs/dql-agent';

export class DriverProbeError extends Error {}

export interface DashboardDriverRun {
  item: DashboardGridItem;
  plan?: DriverQueryPlan;
  error?: string;
}

/** The transient driver tile a reader's "Why did it move?" adds to one run. */
export function dashboardDriverProbeItem(dashboard: DashboardDocument, raw: unknown): DashboardGridItem {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DriverProbeError('driverProbe must name a tile and a driver definition.');
  const probe = raw as Record<string, unknown>;
  const fromTileId = typeof probe.fromTileId === 'string' ? probe.fromTileId.trim() : '';
  const source = dashboard.layout.items.find((item) => item.i === fromTileId);
  if (!source || !source.sourceId || !source.query) throw new DriverProbeError('A driver probe must start from a Dataset tile on this page.');
  const errors: string[] = [];
  const driver = readDriverDefinition(probe.driver, 'driverProbe.driver', (message) => errors.push(message));
  if (!driver) throw new DriverProbeError(errors.join(' ') || 'driverProbe.driver is not a valid driver definition.');
  return {
    i: `${source.i}::why`,
    x: 0,
    y: 0,
    w: 12,
    h: 6,
    sourceId: source.sourceId,
    ...(source.sourceRevision ? { sourceRevision: source.sourceRevision } : {}),
    ...(source.filterBindings ? { filterBindings: source.filterBindings } : {}),
    ...(source.parameterBindings ? { parameterBindings: source.parameterBindings } : {}),
    ...(source.sourceClass ? { sourceClass: source.sourceClass } : {}),
    ...(source.trustState ? { trustState: source.trustState } : {}),
    ...(source.reviewStatus ? { reviewStatus: source.reviewStatus } : {}),
    driver,
    viz: { type: 'waterfall' },
    title: `Why ${source.title ?? 'this'} moved`,
  };
}

/** Replace each driver tile with the governed comparison tiles that feed it. */
export function expandDashboardDriverItems(input: {
  items: DashboardGridItem[];
  descriptorFor: (item: DashboardGridItem) => DatasetDescriptor | undefined;
  sourceErrorFor: (item: DashboardGridItem) => string | undefined;
}): { executionItems: DashboardGridItem[]; runs: Map<string, DashboardDriverRun>; executionOwners: Map<string, string> } {
  const executionItems: DashboardGridItem[] = [];
  const runs = new Map<string, DashboardDriverRun>();
  const executionOwners = new Map<string, string>();
  for (const item of input.items) {
    if (!item.driver) {
      executionItems.push(item);
      continue;
    }
    const sourceError = input.sourceErrorFor(item);
    const descriptor = input.descriptorFor(item);
    if (sourceError || !descriptor) {
      runs.set(item.i, { item, error: sourceError ?? 'This driver tile has no current governed Dataset.' });
      continue;
    }
    const planned = planDriverQueries(item.driver, descriptor);
    if (planned.status !== 'ready') {
      runs.set(item.i, { item, error: planned.reason });
      continue;
    }
    runs.set(item.i, { item, plan: planned.plan });
    const base: Omit<DashboardGridItem, 'i' | 'query'> = {
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      sourceId: item.sourceId,
      ...(item.sourceRevision ? { sourceRevision: item.sourceRevision } : {}),
      ...(item.filterBindings ? { filterBindings: item.filterBindings } : {}),
      ...(item.parameterBindings ? { parameterBindings: item.parameterBindings } : {}),
      ...(item.sourceClass ? { sourceClass: item.sourceClass } : {}),
      ...(item.trustState ? { trustState: item.trustState } : {}),
      ...(item.reviewStatus ? { reviewStatus: item.reviewStatus } : {}),
      viz: { type: 'table' },
    };
    const total = driverTotalTileId(item.i);
    executionItems.push({ ...base, i: total, query: planned.plan.total, title: `${item.title ?? 'Driver'} · total` });
    executionOwners.set(total, item.i);
    for (const dimension of planned.plan.dimensions) {
      const id = driverDimensionTileId(item.i, dimension.field);
      executionItems.push({ ...base, i: id, query: dimension.query, title: `${item.title ?? 'Driver'} · ${dimension.label}` });
      executionOwners.set(id, item.i);
    }
  }
  return { executionItems, runs, executionOwners };
}

/** Page filters scoped to a driver tile also apply to its comparison tiles. */
export function withDriverFilterScopes(dashboard: DashboardDocument, owners: Map<string, string>): DashboardDocument {
  if (!dashboard.filters?.some((filter) => filter.scope?.tileIds?.length)) return dashboard;
  const byOwner = new Map<string, string[]>();
  for (const [id, owner] of owners) byOwner.set(owner, [...(byOwner.get(owner) ?? []), id]);
  return {
    ...dashboard,
    filters: dashboard.filters.map((filter) => {
      const tileIds = filter.scope?.tileIds;
      if (!tileIds?.length) return filter;
      const extra = tileIds.flatMap((id) => byOwner.get(id) ?? []);
      return extra.length ? { ...filter, scope: { ...filter.scope, tileIds: [...tileIds, ...extra] } } : filter;
    }),
  };
}

type RunTile = { tileId: string; status: string; [key: string]: any };

/** Fold the comparison tile results back into one result per driver tile. */
export function foldDashboardDriverTiles(tiles: RunTile[], runs: Map<string, DashboardDriverRun>): void {
  for (const [tileId, run] of runs) {
    const { item } = run;
    const header = { tileId, tileType: 'driver', title: item.title, viz: item.viz };
    if (!run.plan || run.error) {
      tiles.push({ ...header, status: 'error', error: run.error ?? 'This driver tile could not be planned.' });
      continue;
    }
    const taken = (id: string) => {
      const index = tiles.findIndex((tile) => tile.tileId === id);
      return index >= 0 ? tiles.splice(index, 1)[0] : undefined;
    };
    const total = taken(driverTotalTileId(tileId));
    const dimensionTiles = run.plan.dimensions.map((dimension) => ({ dimension, tile: taken(driverDimensionTileId(tileId, dimension.field)) }));
    if (!total || total.status !== 'ok' || !total.result) {
      tiles.push({
        ...header,
        status: total?.status && total.status !== 'ok' ? total.status : 'error',
        error: total?.error ?? 'The comparison for the whole measure did not run.',
      });
      continue;
    }
    const analysis = foldDriverAnalysis({
      definition: item.driver!,
      plan: run.plan,
      totalRows: total.result.rows ?? [],
      dimensionResults: dimensionTiles.map(({ dimension, tile }) => (tile?.status === 'ok' && tile.result
        ? { field: dimension.field, rows: tile.result.rows ?? [] }
        : { field: dimension.field, error: tile?.error ?? 'This breakdown did not run.' })),
    });
    const rows = analysis.dimensions.flatMap((dimension) => dimension.members.map((member) => ({
      dimension: dimension.label,
      member: member.label,
      current: member.current ?? null,
      prior: member.prior ?? null,
      change: member.delta ?? null,
      share_of_change: member.share ?? null,
    })));
    tiles.push({
      ...header,
      status: 'ok',
      driver: analysis,
      // The whole-measure comparison carries the governed evidence: its
      // Dataset trust, contract validation, SQL and result fingerprints.
      ...(total.dataset ? { dataset: total.dataset } : {}),
      ...(total.artifact ? { artifact: { ...total.artifact, name: item.title ?? total.artifact.name } } : {}),
      ...(total.certificationStatus ? { certificationStatus: total.certificationStatus } : {}),
      ...(total.filters ? { filters: total.filters } : {}),
      driverEvidence: dimensionTiles.map(({ dimension, tile }) => ({
        field: dimension.field,
        status: tile?.status ?? 'missing',
        resultFingerprint: tile?.result?.resultFingerprint ?? tile?.dataset?.executionProvenance?.resultFingerprint,
        executedSqlFingerprint: tile?.dataset?.executionProvenance?.executedSqlFingerprint,
      })),
      result: {
        columns: ['dimension', 'member', 'current', 'prior', 'change', 'share_of_change'],
        rows,
        rowCount: rows.length,
        executionTime: [total, ...dimensionTiles.map(({ tile }) => tile)].reduce((sum, tile) => sum + (Number(tile?.result?.executionTime) || 0), 0),
        ...(total.result.resultFingerprint ? { resultFingerprint: total.result.resultFingerprint } : {}),
      },
    });
  }
}
