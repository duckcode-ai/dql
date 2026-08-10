import type { AppStudioBuildDraft } from '../../api/client';

export type AppPublicationStepKind = 'questions' | 'review' | 'preview' | 'sources';

export interface AppPublicationStep {
  id: AppPublicationStepKind;
  title: string;
  detail: string;
  count: number;
}

export function publicationIssueSummaries(issues: string[]): Array<{ id: string; title: string; detail: string; action: 'sources' | 'filters' }> {
  const known = /Required App question is unresolved|Review task is still open|Run a current settled preview|requires snapshot-bound semantic approval|is review-required and cannot be published|references app-scoped exploratory DQL|Resolve required Build Frame clarifications/i;
  const summaries = issues.filter((issue) => !known.test(issue)).map((issue) => {
    const filterMatch = issue.match(/^[^/]+\/[^ ]+ does not have a preflighted binding for filter (.+)\.$/i);
    if (filterMatch) {
      const label = filterMatch[1];
      const affected = issues.filter((candidate) => candidate.endsWith(`binding for filter ${label}.`)).length;
      return {
        id: `filters:${label.toLowerCase()}`,
        title: `Limit ${label} to compatible components`,
        detail: `${label} is applied to ${affected} ${affected === 1 ? 'component that cannot' : 'components that cannot'} use it. Open Filters, edit ${label}, and keep only the compatible components selected.`,
        action: 'filters' as const,
      };
    }
    if (/filter|binding/i.test(issue)) return { id: 'filters', title: 'Finish filter wiring', detail: issue, action: 'filters' as const };
    const sourceMatch = issue.match(/^Source (.+?) changed after selection\.$/i);
    if (sourceMatch) {
      const source = publicationHumanize(sourceMatch[1]);
      return { id: `sources:${sourceMatch[1]}`, title: `Review ${source}`, detail: `${source} changed since it was selected. Accept the current certified version; DQL will then request a fresh preview.`, action: 'sources' as const };
    }
    if (/does not resolve to a current certified block/i.test(issue)) return { id: `unavailable:${issue}`, title: 'Replace an unavailable source', detail: issue, action: 'sources' as const };
    if (/changed after selection|certified block|source/i.test(issue)) return { id: 'sources', title: 'Review changed sources', detail: issue, action: 'sources' as const };
    if (/preview|settled run|receipt|runtime/i.test(issue)) return { id: 'preview', title: 'Refresh the settled preview', detail: 'The saved preview no longer matches the current App data contract.', action: 'sources' as const };
    return { id: `validation:${issue}`, title: 'Complete governed validation', detail: issue, action: 'sources' as const };
  });
  return Array.from(new Map(summaries.map((summary) => [summary.id, summary])).values());
}

function publicationHumanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function unresolvedPublicationRequirements(draft: AppStudioBuildDraft): AppStudioBuildDraft['requirements'] {
  return draft.requirements.filter((requirement) => {
    if (!requirement.required) return false;
    if (!appBuildRequirementAppliesToPublication(draft, requirement)) return false;
    const coverage = draft.coverage.find((item) => item.requirementId === requirement.id);
    return coverage?.status !== 'covered';
  });
}

function appBuildRequirementAppliesToPublication(
  draft: AppStudioBuildDraft,
  requirement: AppStudioBuildDraft['requirements'][number],
): boolean {
  // A blank/manual App may later ask AI for layout help. Older planners turned
  // its title into empty-measure placeholder requirements (for example the App
  // name and "primary metric over time"). Manual publication is governed by
  // the sources and components the author actually added; only analytical
  // requirements with a named measure remain coverage gates.
  if (draft.authoringMode === 'manual' && draft.frame.metrics.length === 0 && requirement.measures.length === 0) return false;
  return true;
}

/**
 * Only a review task attached to content that still exists can block
 * publication. Earlier AI plans stored general advice as unscoped open tasks;
 * those reminders are useful context, but are not a publication requirement.
 */
export function blockingPublicationReviewTasks(draft: AppStudioBuildDraft): AppStudioBuildDraft['reviewTasks'] {
  const pageIds = new Set(draft.pages.map((page) => page.id));
  const tileIds = new Set(draft.pages.flatMap((page) => page.layout.items.map((tile) => tile.i)));
  const sourceIds = new Set(draft.sources.map((source) => source.id));
  return draft.reviewTasks.filter((task) => {
    if (task.status !== 'open') return false;
    if (task.sourceId && sourceIds.has(task.sourceId)) return true;
    if (task.tileId && tileIds.has(task.tileId)) return true;
    if (task.pageId && pageIds.has(task.pageId)) return true;
    return false;
  });
}

export function pagesNeedingSettledPreview(draft: AppStudioBuildDraft): AppStudioBuildDraft['pages'] {
  const receipts = draft.previewReceipts ?? (draft.previewReceipt ? [draft.previewReceipt] : []);
  return draft.pages.filter((page) => {
    const hasData = page.layout.items.some((tile) => !tile.text && !tile.aiPin);
    if (!hasData) return false;
    return !receipts.some((receipt) => receipt.pageId === page.id && receipt.revision === draft.revision);
  });
}

export function publicationBlockingSources(draft: AppStudioBuildDraft): AppStudioBuildDraft['sources'] {
  return draft.sources.filter((source) => {
    if (source.kind === 'governed_semantic' || source.kind === 'semantic_query') {
      return source.reviewStatus !== 'approved' || !source.snapshotId || !source.receiptId;
    }
    return source.kind === 'review_block' || source.kind === 'review_dql' || source.kind === 'exploratory_sql';
  });
}

export function localPublicationSteps(draft: AppStudioBuildDraft): AppPublicationStep[] {
  const unansweredClarifications = (draft.frame.clarificationQuestions ?? [])
    .filter((question) => question.required && !question.answerId);
  const unresolvedRequirements = unresolvedPublicationRequirements(draft);
  const reviewTasks = blockingPublicationReviewTasks(draft);
  const previewPages = pagesNeedingSettledPreview(draft);
  const sources = publicationBlockingSources(draft);
  const steps: AppPublicationStep[] = [];

  if (unansweredClarifications.length || unresolvedRequirements.length) {
    const count = unansweredClarifications.length + unresolvedRequirements.length;
    steps.push({
      id: 'questions',
      title: 'Confirm the App questions',
      detail: `${count} ${count === 1 ? 'question needs' : 'questions need'} an answer, governed coverage, or removal from this publish scope.`,
      count,
    });
  }
  if (reviewTasks.length) {
    steps.push({
      id: 'review',
      title: 'Complete scoped review',
      detail: `${reviewTasks.length} review ${reviewTasks.length === 1 ? 'task is' : 'tasks are'} attached to content still in this App.`,
      count: reviewTasks.length,
    });
  }
  if (previewPages.length) {
    steps.push({
      id: 'preview',
      title: 'Run a current preview',
      detail: `${previewPages.length} data ${previewPages.length === 1 ? 'page needs' : 'pages need'} a settled result before publication.`,
      count: previewPages.length,
    });
  }
  if (sources.length) {
    steps.push({
      id: 'sources',
      title: 'Finish source review',
      detail: `${sources.length} ${sources.length === 1 ? 'source needs' : 'sources need'} approval, replacement, or removal.`,
      count: sources.length,
    });
  }
  return steps;
}
