import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type NotebookResearchListResponse, type NotebookResearchNextActionFilter } from '../../api/client';
import { NOTEBOOK_RESEARCH_CHANGED_EVENT } from '../../utils/notebook-research';

export type NotebookResearchSummary = NotebookResearchListResponse['notebooks'][number];
export type NotebookResearchOwnerSummary = NotebookResearchListResponse['owners'][number];
export type NotebookResearchSummaryTone = 'error' | 'warning' | 'success' | 'accent' | 'neutral';

const SUMMARY_CACHE_TTL_MS = 2_000;
type NotebookResearchProjectSummary = {
  notebooks: NotebookResearchSummary[];
  owners: NotebookResearchOwnerSummary[];
};

const EMPTY_PROJECT_SUMMARY: NotebookResearchProjectSummary = {
  notebooks: [],
  owners: [],
};

let summaryCache: NotebookResearchProjectSummary = EMPTY_PROJECT_SUMMARY;
let summaryCacheAt = 0;
let summaryCacheActiveOnly = true;
let summaryRequest: Promise<NotebookResearchProjectSummary> | null = null;
let summaryRequestActiveOnly = true;

interface UseNotebookResearchSummaryOptions {
  refreshKey?: string;
  pollMs?: number;
  activeOnly?: boolean;
}

export function useNotebookResearchSummary(options: UseNotebookResearchSummaryOptions = {}) {
  const { refreshKey = '', pollMs = 30_000, activeOnly = true } = options;
  const [projectSummary, setProjectSummary] = useState<NotebookResearchProjectSummary>(EMPTY_PROJECT_SUMMARY);
  const [loading, setLoading] = useState(false);
  const loadIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const load = (force = false) => {
      const loadId = loadIdRef.current + 1;
      loadIdRef.current = loadId;
      setLoading(true);
      loadNotebookResearchSummaries(force, activeOnly)
        .then((next) => {
          if (!cancelled && loadIdRef.current === loadId) setProjectSummary(next);
        })
        .catch(() => {
          if (!cancelled && loadIdRef.current === loadId) setProjectSummary(EMPTY_PROJECT_SUMMARY);
        })
        .finally(() => {
          if (!cancelled && loadIdRef.current === loadId) setLoading(false);
        });
    };

    const handleResearchChanged = () => load(true);

    load();
    window.addEventListener(NOTEBOOK_RESEARCH_CHANGED_EVENT, handleResearchChanged);
    if (pollMs > 0) {
      timer = window.setInterval(load, pollMs);
    }

    return () => {
      cancelled = true;
      window.removeEventListener(NOTEBOOK_RESEARCH_CHANGED_EVENT, handleResearchChanged);
      if (timer) window.clearInterval(timer);
    };
  }, [activeOnly, pollMs, refreshKey]);

  const byPath = useMemo(() => {
    const map = new Map<string, NotebookResearchSummary>();
    for (const summary of projectSummary.notebooks) {
      map.set(summary.path, summary);
    }
    return map;
  }, [projectSummary.notebooks]);

  return {
    summaries: projectSummary.notebooks,
    ownerSummaries: projectSummary.owners,
    byPath,
    loading,
  };
}

function loadNotebookResearchSummaries(force = false, activeOnly = true): Promise<NotebookResearchProjectSummary> {
  const now = Date.now();
  if (!force && summaryRequest && summaryRequestActiveOnly === activeOnly) return summaryRequest;
  if (!force && summaryCacheActiveOnly === activeOnly && summaryCacheAt > 0 && now - summaryCacheAt < SUMMARY_CACHE_TTL_MS) {
    return Promise.resolve(summaryCache);
  }
  summaryRequestActiveOnly = activeOnly;
  summaryRequest = api.listNotebookResearch({ activeOnly, limit: 1 })
    .then((page) => {
      summaryCache = {
        notebooks: page.notebooks,
        owners: page.owners,
      };
      summaryCacheActiveOnly = activeOnly;
      summaryCacheAt = Date.now();
      return summaryCache;
    })
    .finally(() => {
      summaryRequest = null;
    });
  return summaryRequest;
}

export function notebookResearchSummaryLabel(
  summary: NotebookResearchSummary,
  options: { includeCount?: boolean } = {},
): string {
  if (summary.blocked > 0) return `${formatCompactCount(summary.blocked)} blocked`;
  if (summary.expiredOpen > 0) return `${formatCompactCount(summary.expiredOpen)} 30d+`;
  if (summary.staleOpen > 0) return `${formatCompactCount(summary.staleOpen)} stale`;
  const nextActionLabel = notebookResearchNextActionLabel(summary.nextAction);
  if (nextActionLabel) {
    const count = typeof summary.nextActionCount === 'number' && summary.nextActionCount > 0
      ? summary.nextActionCount
      : undefined;
    return options.includeCount && count
      ? `${nextActionLabel} · ${formatCompactCount(count)}`
      : nextActionLabel;
  }
  if (summary.certificationReady > 0) return `${formatCompactCount(summary.certificationReady)} cert`;
  if (summary.draftReady > 0) return `${formatCompactCount(summary.draftReady)} draft`;
  return `${formatCompactCount(summary.total)} AI`;
}

export function notebookResearchSummaryTitle(summary: NotebookResearchSummary): string {
  const nextActionLabel = notebookResearchNextActionLabel(summary.nextAction);
  return [
    `${summary.total.toLocaleString()} AI histor${summary.total === 1 ? 'y item' : 'y items'}`,
    nextActionLabel && summary.nextActionCount
      ? `Next: ${nextActionLabel} (${summary.nextActionCount.toLocaleString()})`
      : undefined,
    `${summary.draftReady.toLocaleString()} draft ready`,
    `${summary.certificationReady.toLocaleString()} certification ready`,
    `${summary.blocked.toLocaleString()} blocked`,
    `${summary.staleOpen.toLocaleString()} stale open`,
    `${summary.expiredOpen.toLocaleString()} open 30d+`,
  ].filter(Boolean).join(' · ');
}

export function notebookResearchSummaryDetail(summary: NotebookResearchSummary): string {
  const nextActionLabel = notebookResearchNextActionLabel(summary.nextAction);
  const nextActionCount = typeof summary.nextActionCount === 'number' && summary.nextActionCount > 0
    ? summary.nextActionCount
    : undefined;
  const readiness = [
    summary.blocked > 0 ? `${formatCompactCount(summary.blocked)} blocked` : undefined,
    summary.expiredOpen > 0 ? `${formatCompactCount(summary.expiredOpen)} 30d+` : undefined,
    summary.staleOpen > 0 ? `${formatCompactCount(summary.staleOpen)} stale` : undefined,
    summary.certificationReady > 0 ? `${formatCompactCount(summary.certificationReady)} cert ready` : undefined,
    summary.draftReady > 0 ? `${formatCompactCount(summary.draftReady)} draft ready` : undefined,
  ].filter(Boolean);
  const parts = [
    nextActionLabel && nextActionCount
      ? `Next: ${nextActionLabel} for ${formatCompactCount(nextActionCount)} ${nextActionCount === 1 ? 'item' : 'items'}`
      : `${formatCompactCount(summary.total)} AI histor${summary.total === 1 ? 'y item' : 'y items'}`,
    ...readiness,
  ];
  return parts.join(' · ');
}

export function notebookResearchNextActionLabel(action?: NotebookResearchNextActionFilter): string | undefined {
  switch (action) {
    case 'fix_blockers':
      return 'Fix blockers';
    case 'review_sql':
      return 'Review SQL';
    case 'review_context':
      return 'Review context';
    case 'run_preview':
      return 'Run preview';
    case 'reuse_existing':
      return 'Reuse';
    case 'create_dql_draft':
      return 'Create draft';
    case 'open_certification':
      return 'Certify';
    case 'complete_review':
      return 'Complete';
    case 'continue_review':
      return 'Continue';
    default:
      return undefined;
  }
}

export function notebookResearchSummaryTone(summary: NotebookResearchSummary): NotebookResearchSummaryTone {
  if (summary.blocked > 0 || summary.expiredOpen > 0) return 'error';
  if (summary.staleOpen > 0) return 'warning';
  switch (summary.nextAction) {
    case 'fix_blockers':
      return 'error';
    case 'review_sql':
    case 'review_context':
    case 'run_preview':
    case 'reuse_existing':
      return 'warning';
    case 'open_certification':
      return 'success';
    case 'create_dql_draft':
    case 'complete_review':
      return 'accent';
    case 'continue_review':
      return 'neutral';
    default:
      break;
  }
  if (summary.certificationReady > 0) return 'success';
  if (summary.draftReady > 0) return 'accent';
  return 'neutral';
}

export function compareNotebookResearchSummaries(a: NotebookResearchSummary, b: NotebookResearchSummary): number {
  return notebookResearchNextActionPriority(a.nextAction) - notebookResearchNextActionPriority(b.nextAction)
    || b.blocked - a.blocked
    || b.expiredOpen - a.expiredOpen
    || b.staleOpen - a.staleOpen
    || b.certificationReady - a.certificationReady
    || b.draftReady - a.draftReady
    || b.total - a.total
    || a.title.localeCompare(b.title);
}

export function notebookResearchNextActionPriority(action?: NotebookResearchNextActionFilter): number {
  switch (action) {
    case 'fix_blockers':
      return 0;
    case 'review_sql':
      return 1;
    case 'review_context':
      return 2;
    case 'run_preview':
      return 3;
    case 'reuse_existing':
      return 4;
    case 'create_dql_draft':
      return 5;
    case 'open_certification':
      return 6;
    case 'complete_review':
      return 7;
    case 'continue_review':
      return 8;
    default:
      return 9;
  }
}

function formatCompactCount(value: number): string {
  if (value > 99) return '99+';
  return value.toLocaleString();
}
