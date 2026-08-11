import { createHash } from 'node:crypto';
import type { DashboardDocument, DashboardFilter, DashboardGridItem, DashboardGridLayout } from './dashboard-document.js';

export type AppBuildAuthoringMode = 'ai' | 'manual';
export type AppBuildSourcePolicy = 'governed_only' | 'include_review_required';
export type AppBuildTemplateId = 'executive_brief' | 'operational_dashboard' | 'investigation' | 'blank';

export interface AppBuildClarification {
  id: string;
  question: string;
  choices: Array<{ id: string; label: string; description?: string }>;
  required: boolean;
  answerId?: string;
}

export interface AppBuildFrame {
  goal: string;
  decision?: string;
  audience?: string;
  metrics: string[];
  dimensions: string[];
  grain?: string;
  timeRange?: string;
  comparison?: string;
  filters: string[];
  desiredOutput?: string;
  clarificationQuestions?: AppBuildClarification[];
}

export interface AppBuildRequirement {
  id: string;
  question: string;
  role: 'kpi' | 'trend' | 'breakdown' | 'detail' | 'narrative' | 'evidence';
  required: boolean;
  measures: string[];
  dimensions: string[];
  filters: string[];
  grain?: string;
}

export interface AppBuildRequirementCoverage {
  requirementId: string;
  status: 'covered' | 'partial' | 'gap';
  sourceIds: string[];
  componentIds: string[];
  reasons: string[];
}

export type AppBuildDraftSourceKind =
  | 'block'
  | 'certified_block'
  | 'governed_semantic'
  | 'review_block'
  | 'review_dql'
  | 'text'
  /** v1 read compatibility; new drafts use governed_semantic. */
  | 'semantic_query'
  /** v1 read compatibility; generated exploration is materialized as review_dql. */
  | 'exploratory_sql';

export type AppBuildSourceLifecycle =
  | 'certified'
  | 'review'
  | 'draft'
  | 'pending_recertification'
  | 'deprecated'
  | 'unknown';

export interface AppBuildSourceCapabilities {
  measures: string[];
  dimensions: string[];
  outputs: string[];
  filters: string[];
  grain?: string;
  chartType?: string;
  allowedVisualizations?: string[];
  parameters: Array<{
    name: string;
    type?: string;
    required: boolean;
    hasDefault: boolean;
  }>;
}

export type AppBuildDraftSource = {
  /** Canonical, path-disambiguated source id used by tiles and coverage. */
  id: string;
  kind: AppBuildDraftSourceKind;
  /** Legacy display/execution reference retained for v1/v2 readers. */
  sourceRef: string;
  qualifiedIdentity?: string;
  sourcePath?: string;
  executionRef?: string;
  snapshotId?: string;
  sourceRevision?: string;
  sourceFingerprint?: string;
  receiptId?: string;
  lifecycle?: AppBuildSourceLifecycle;
  capabilities?: AppBuildSourceCapabilities;
  trustState: 'certified' | 'review_required' | 'draft_ready';
  reviewStatus: 'not_required' | 'required' | 'approved';
};

export interface AppBuildReviewTask {
  id: string;
  message: string;
  status: 'open' | 'resolved';
  sourceId?: string;
  pageId?: string;
  tileId?: string;
}

export interface AppBuildRunReceipt {
  id: string;
  pageId: string;
  revision: number;
  snapshotId: string;
  filterFingerprint: string;
  resultFingerprint: string;
  createdAt: string;
}

export interface AppBuildPreflightReceipt {
  id: string;
  revision: number;
  proposalHash: string;
  sourceFingerprint: string;
  createdAt: string;
}

/**
 * The one durable authoring aggregate for AI, manual, CLI, and Copilot work.
 * Drafts are local-only. Git-owned App source is produced only by explicit
 * Publish to Project and is never used as the mutable editor backing store.
 */
export interface AppBuildDraft {
  version: 3;
  id: string;
  appId: string;
  name: string;
  baseApp?: { appId: string; fingerprint: string };
  revision: number;
  proposalHash: string;
  authoringMode: AppBuildAuthoringMode;
  template: AppBuildTemplateId;
  sourcePolicy: AppBuildSourcePolicy;
  state: 'local_draft' | 'clarification_required' | 'preflight_ready' | 'project_published';
  frame: AppBuildFrame;
  requirements: AppBuildRequirement[];
  coverage: AppBuildRequirementCoverage[];
  sources: AppBuildDraftSource[];
  pages: DashboardDocument[];
  reviewTasks: AppBuildReviewTask[];
  /** One settled run receipt per page. Any content edit invalidates the set. */
  previewReceipts?: AppBuildRunReceipt[];
  /** @deprecated Early v2 alias for the most recently run page. */
  previewReceipt?: AppBuildRunReceipt;
  preflightReceipt?: AppBuildPreflightReceipt;
  publishedFingerprint?: string;
  createdAt: string;
  updatedAt: string;
}

export type AppBuildDraftOperation =
  | { type: 'set_name'; name: string }
  | { type: 'set_template'; template: AppBuildTemplateId }
  | { type: 'set_frame'; frame: AppBuildFrame }
  | { type: 'set_source_policy'; sourcePolicy: AppBuildSourcePolicy }
  | { type: 'set_requirements'; requirements: AppBuildRequirement[]; coverage?: AppBuildRequirementCoverage[] }
  | { type: 'set_coverage'; coverage: AppBuildRequirementCoverage[] }
  | { type: 'upsert_source'; source: AppBuildDraftSource }
  | { type: 'remove_source'; sourceId: string }
  | { type: 'upsert_page'; page: DashboardDocument }
  | { type: 'remove_page'; pageId: string }
  | { type: 'add_tile'; pageId: string; tile: DashboardGridItem }
  | { type: 'update_tile'; pageId: string; tileId: string; patch: Partial<DashboardGridItem> }
  | { type: 'remove_tile'; pageId: string; tileId: string }
  | { type: 'set_filter'; pageId: string; filter: DashboardFilter }
  | { type: 'remove_filter'; pageId: string; filterId: string }
  | { type: 'set_layout'; pageId: string; layout: DashboardGridLayout & { responsive?: DashboardDocument['layout']['responsive'] } }
  | { type: 'set_review_task'; task: AppBuildReviewTask }
  | { type: 'remove_review_task'; taskId: string }
  | { type: 'set_preview_receipt'; receipt: AppBuildRunReceipt };

export function createAppBuildDraft(input: {
  id: string;
  appId: string;
  name?: string;
  baseApp?: AppBuildDraft['baseApp'];
  authoringMode: AppBuildAuthoringMode;
  template?: AppBuildTemplateId;
  sourcePolicy?: AppBuildSourcePolicy;
  frame: AppBuildFrame;
  requirements?: AppBuildRequirement[];
  coverage?: AppBuildRequirementCoverage[];
  sources?: AppBuildDraftSource[];
  pages?: DashboardDocument[];
  reviewTasks?: AppBuildReviewTask[];
  now?: string;
}): AppBuildDraft {
  const now = input.now ?? new Date().toISOString();
  const clarifications = input.frame.clarificationQuestions ?? [];
  const needsClarification = clarifications.some((question) => question.required && !question.answerId);
  const draftWithoutHash = {
    version: 3 as const,
    id: input.id,
    appId: input.appId,
    name: input.name?.trim() || input.frame.goal.trim() || input.appId,
    ...(input.baseApp ? { baseApp: input.baseApp } : {}),
    revision: 1,
    authoringMode: input.authoringMode,
    template: input.template ?? 'blank',
    sourcePolicy: input.sourcePolicy ?? 'governed_only',
    state: needsClarification ? 'clarification_required' as const : 'local_draft' as const,
    frame: input.frame,
    requirements: input.requirements ?? [],
    coverage: input.coverage ?? [],
    sources: input.sources ?? [],
    pages: input.pages ?? [],
    reviewTasks: input.reviewTasks ?? [],
    createdAt: now,
    updatedAt: now,
  };
  assertAppBuildDraftPolicy(draftWithoutHash);
  return { ...draftWithoutHash, proposalHash: appBuildDraftHash(draftWithoutHash) };
}

export function applyAppBuildDraftOperations(
  draft: AppBuildDraft,
  expectedRevision: number,
  operations: AppBuildDraftOperation[],
  now = new Date().toISOString(),
): AppBuildDraft {
  if (draft.revision !== expectedRevision) {
    throw new Error(`APP_BUILD_REVISION_CONFLICT: expected ${expectedRevision}, current ${draft.revision}`);
  }
  if (operations.length === 0) return draft;
  let next: AppBuildDraft = structuredClone(draft);
  for (const operation of operations) next = applyOperation(next, operation);
  next = reconcileCoverageReferences(next);
  const contentChanged = operations.some((operation) => operation.type !== 'set_preview_receipt');
  const settledDataChanged = operations.some((operation) => !operationPreservesSettledData(draft, operation));
  next.updatedAt = now;
  if (contentChanged) {
    next.revision += 1;
    if (settledDataChanged) {
      delete next.previewReceipts;
      delete next.previewReceipt;
    } else {
      if (next.previewReceipts) next.previewReceipts = next.previewReceipts.map((receipt) => ({ ...receipt, revision: next.revision }));
      if (next.previewReceipt) next.previewReceipt = { ...next.previewReceipt, revision: next.revision };
    }
    delete next.preflightReceipt;
    delete next.publishedFingerprint;
    const needsClarification = (next.frame.clarificationQuestions ?? [])
      .some((question) => question.required && !question.answerId);
    next.state = needsClarification ? 'clarification_required' : 'local_draft';
    next.proposalHash = appBuildDraftHash({ ...next, proposalHash: undefined });
  }
  assertAppBuildDraftPolicy(next);
  return next;
}

/**
 * Coverage is part of the aggregate, not an independent planner memo. Keep its
 * references aligned after source/page/tile mutations so a removed component
 * can never remain reported as covered or block publication as a ghost gap.
 */
function reconcileCoverageReferences(draft: AppBuildDraft): AppBuildDraft {
  const sourceIds = new Set(draft.sources.map((source) => source.id));
  const componentIds = new Set(draft.pages.flatMap((page) => page.layout.items.map((item) => item.i)));
  return {
    ...draft,
    coverage: draft.coverage.map((item) => {
      const validSourceIds = item.sourceIds.filter((sourceId) => sourceIds.has(sourceId));
      const validComponentIds = item.componentIds.filter((componentId) => componentIds.has(componentId));
      return {
        ...item,
        sourceIds: validSourceIds,
        componentIds: validComponentIds,
        status: validSourceIds.length > 0 && validComponentIds.length > 0 ? item.status : 'gap',
      };
    }),
  };
}

function operationPreservesSettledData(draft: AppBuildDraft, operation: AppBuildDraftOperation): boolean {
  if (operation.type === 'set_preview_receipt') return true;
  if (operation.type === 'update_tile') {
    const presentationKeys = new Set(['title', 'viz', 'display', 'x', 'y', 'w', 'h', 'sectionId']);
    return Object.keys(operation.patch).every((key) => presentationKeys.has(key));
  }
  if (operation.type !== 'set_layout') return false;
  const page = draft.pages.find((candidate) => candidate.id === operation.pageId);
  if (!page || page.layout.items.length !== operation.layout.items.length) return false;
  const currentById = new Map(page.layout.items.map((item) => [item.i, item]));
  return operation.layout.items.every((item) => {
    const current = currentById.get(item.i);
    return current !== undefined && JSON.stringify(withoutTileGeometry(item)) === JSON.stringify(withoutTileGeometry(current));
  });
}

function withoutTileGeometry<T extends { x: number; y: number; w: number; h: number }>(item: T): Omit<T, 'x' | 'y' | 'w' | 'h'> {
  const { x: _x, y: _y, w: _w, h: _h, ...contract } = item;
  return contract;
}

export function appBuildDraftHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function applyOperation(draft: AppBuildDraft, operation: AppBuildDraftOperation): AppBuildDraft {
  switch (operation.type) {
    case 'set_name': {
      const name = operation.name.trim();
      if (!name) throw new Error('App name is required');
      return { ...draft, name };
    }
    case 'set_template': return { ...draft, template: operation.template };
    case 'set_frame': return { ...draft, frame: operation.frame };
    case 'set_source_policy': return { ...draft, sourcePolicy: operation.sourcePolicy };
    case 'set_requirements': return { ...draft, requirements: operation.requirements, coverage: operation.coverage ?? draft.coverage };
    case 'set_coverage': return { ...draft, coverage: operation.coverage };
    case 'upsert_source': return { ...draft, sources: upsertById(draft.sources, operation.source) };
    case 'remove_source': return {
      ...draft,
      sources: draft.sources.filter((source) => source.id !== operation.sourceId),
      coverage: draft.coverage.map((item) => ({ ...item, sourceIds: item.sourceIds.filter((id) => id !== operation.sourceId) })),
    };
    case 'upsert_page': return { ...draft, pages: upsertById(draft.pages, normalizeEditedPage(operation.page)) };
    case 'remove_page': return { ...draft, pages: draft.pages.filter((page) => page.id !== operation.pageId) };
    case 'set_review_task': return { ...draft, reviewTasks: upsertById(draft.reviewTasks, operation.task) };
    case 'remove_review_task': return { ...draft, reviewTasks: draft.reviewTasks.filter((task) => task.id !== operation.taskId) };
    case 'set_preview_receipt': return {
      ...draft,
      previewReceipt: operation.receipt,
      previewReceipts: upsertReceiptByPage(
        draft.previewReceipts ?? (draft.previewReceipt ? [draft.previewReceipt] : []),
        operation.receipt,
      ),
    };
    default:
      return updatePage(draft, operation.pageId, (page) => {
        if (operation.type === 'add_tile') {
          if (page.layout.items.some((tile) => tile.i === operation.tile.i)) throw new Error(`Tile already exists: ${operation.tile.i}`);
          return { ...page, layout: { ...page.layout, items: [...page.layout.items, operation.tile] } };
        }
        if (operation.type === 'update_tile') {
          return { ...page, layout: { ...page.layout, items: page.layout.items.map((tile) => tile.i === operation.tileId ? { ...tile, ...operation.patch, i: tile.i } : tile) } };
        }
        if (operation.type === 'remove_tile') {
          return { ...page, layout: { ...page.layout, items: page.layout.items.filter((tile) => tile.i !== operation.tileId) } };
        }
        if (operation.type === 'set_filter') {
          return { ...page, filters: upsertById(page.filters ?? [], operation.filter) };
        }
        if (operation.type === 'remove_filter') {
          return { ...page, filters: (page.filters ?? []).filter((filter) => filter.id !== operation.filterId) };
        }
        return { ...page, layout: operation.layout };
      });
  }
}

function updatePage(draft: AppBuildDraft, pageId: string, update: (page: DashboardDocument) => DashboardDocument): AppBuildDraft {
  let found = false;
  const pages = draft.pages.map((page) => {
    if (page.id !== pageId) return page;
    found = true;
    return normalizeEditedPage(update(page));
  });
  if (!found) throw new Error(`Page not found: ${pageId}`);
  return { ...draft, pages };
}

/** A v1 page is upgraded only when an explicit App Studio edit reaches it. */
function normalizeEditedPage(page: DashboardDocument): DashboardDocument {
  const items = packDashboardLayoutItems(page.layout.items, 12);
  return {
    ...page,
    version: 2,
    layout: {
      ...page.layout,
      items,
      responsive: projectResponsiveLayouts(items, page.layout.rowHeight),
    },
  };
}

/**
 * Produce a compact, non-overlapping row layout while preserving the author's
 * visual reading order. App Studio uses this after every explicit edit so
 * imported or stale geometry can never place a tile outside the active grid.
 */
export function packDashboardLayoutItems(
  items: DashboardDocument['layout']['items'],
  cols: number,
): DashboardDocument['layout']['items'] {
  const columnCount = Math.max(1, Math.floor(cols));
  let x = 0;
  let y = 0;
  let currentRowHeight = 0;
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.y - right.item.y || left.item.x - right.item.x || left.index - right.index)
    .map(({ item }) => {
      const width = Math.min(columnCount, Math.max(1, Math.floor(item.w)));
      const height = Math.max(1, Math.floor(item.h));
      if (x + width > columnCount) {
        x = 0;
        y += currentRowHeight || height;
        currentRowHeight = 0;
      }
      const next = { ...item, x, y, w: width, h: height };
      x += width;
      currentRowHeight = Math.max(currentRowHeight, height);
      if (x >= columnCount) {
        x = 0;
        y += currentRowHeight;
        currentRowHeight = 0;
      }
      return next;
    });
}

function projectResponsiveLayouts(
  items: DashboardDocument['layout']['items'],
  rowHeight: number,
): NonNullable<DashboardDocument['layout']['responsive']> {
  const project = (cols: number): DashboardDocument['layout']['items'] => {
    const projected = items.map((item) => {
      const width = cols === 1 ? 1 : Math.min(cols, Math.max(2, Math.ceil(item.w / 2)));
      return { ...item, w: width };
    });
    return packDashboardLayoutItems(projected, cols);
  };
  return {
    wide: { kind: 'grid', cols: 12, rowHeight, items: packDashboardLayoutItems(items, 12) },
    medium: { kind: 'grid', cols: 6, rowHeight, items: project(6) },
    narrow: { kind: 'grid', cols: 1, rowHeight, items: project(1) },
  };
}

function upsertById<T extends { id: string }>(values: T[], next: T): T[] {
  return values.some((value) => value.id === next.id)
    ? values.map((value) => value.id === next.id ? next : value)
    : [...values, next];
}

function upsertReceiptByPage(values: AppBuildRunReceipt[], next: AppBuildRunReceipt): AppBuildRunReceipt[] {
  return values.some((value) => value.pageId === next.pageId)
    ? values.map((value) => value.pageId === next.pageId ? next : value)
    : [...values, next];
}

function assertAppBuildDraftPolicy(draft: Omit<AppBuildDraft, 'proposalHash'> | AppBuildDraft): void {
  if (!draft.id.trim() || !draft.appId.trim()) throw new Error('App Build Draft requires id and appId');
  if (!draft.name.trim()) throw new Error('App Build Draft requires a name');
  if (!draft.frame.goal.trim()) throw new Error('App Build Frame requires a goal');
  const sourceIds = new Set<string>();
  for (const source of draft.sources) {
    if (sourceIds.has(source.id)) throw new Error(`Duplicate App source id: ${source.id}`);
    sourceIds.add(source.id);
    if (source.sourceRevision && source.sourceFingerprint && source.sourceRevision !== source.sourceFingerprint) {
      throw new Error(`Source ${source.id} has conflicting revision fingerprints`);
    }
  }
  for (const coverage of draft.coverage) {
    for (const sourceId of coverage.sourceIds) {
      if (!sourceIds.has(sourceId)) throw new Error(`Coverage ${coverage.requirementId} references missing source ${sourceId}`);
    }
  }
  for (const page of draft.pages) {
    for (const tile of page.layout.items) {
      if (tile.sourceId && !sourceIds.has(tile.sourceId)) {
        throw new Error(`Tile ${page.id}/${tile.i} references missing source ${tile.sourceId}`);
      }
    }
  }
  if (draft.sourcePolicy === 'governed_only') {
    const reviewSource = draft.sources.find((source) =>
      (source.kind === 'block' && source.trustState !== 'certified')
      || source.kind === 'review_block'
      || source.kind === 'review_dql'
      || source.kind === 'exploratory_sql');
    if (reviewSource) throw new Error(`Source ${reviewSource.id} requires include_review_required policy`);
  }
}
