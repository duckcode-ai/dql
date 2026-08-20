/**
 * Turn the branch outcomes into the story the dossier was missing.
 *
 * Measured on a live run: five grounded hypotheses were planned, all five
 * branches executed, and the answer the reader got was a single fact from one
 * of them — "2025-05-01T00:00:00.000Z is the largest order_month at 31.1K". The
 * other four findings existed and were discarded. The real story was sitting in
 * the data: one explanation was answerable, four were blocked by uncertified
 * joins. That is a useful answer about the project, and it never surfaced.
 *
 * This layer is DELIBERATELY DETERMINISTIC. It reports what was tested and what
 * each branch established or could not establish, and it never says which
 * hypothesis is TRUE — that is a judgment the branch summaries do not license,
 * and inventing it here would put an unverified causal claim into a governed
 * dossier. Narration of the numbers stays with the verified-fact narrator.
 */

import {
  applyFinding,
  concludeResearch,
  createResearchState,
  type ResearchLimits,
} from './hypothesis.js';

export interface ResearchBranchOutcome {
  /** The hypothesis this branch was testing. */
  statement: string;
  /** Did the branch actually produce data? */
  produced: boolean;
  /** The branch's own summary, used to explain a blocked branch. */
  summary?: string;
  status?: string;
}

/** Why a branch produced nothing, in the reader's language. */
function blockedReason(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  if (/isn't certified yet|not certified|uncertified/i.test(summary)) {
    return 'the join it needs is not certified yet';
  }
  if (/not bound to any modeled entity|unmodelled|unmodeled/i.test(summary)) {
    return 'it references data that is not modeled';
  }
  if (/missing|no result|0 rows|empty/i.test(summary)) {
    return 'the query returned nothing to compare';
  }
  return undefined;
}

function sentenceList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join('; ')}; and ${items[items.length - 1]}`;
}

export function synthesizeResearchNarrative(input: {
  question: string;
  branches: ResearchBranchOutcome[];
  limits?: ResearchLimits;
}): string | undefined {
  const branches = input.branches.filter((branch) => branch.statement.trim().length > 0);
  if (branches.length === 0) return undefined;

  let state = createResearchState(
    input.question,
    branches.map((branch, index) => ({
      id: `h${index + 1}`,
      statement: branch.statement.trim(),
      priorConfidence: 1 - index / (branches.length + 1),
    })),
  );
  branches.forEach((branch, index) => {
    state = applyFinding(state, {
      id: `f${index + 1}`,
      hypothesisId: `h${index + 1}`,
      // `supports` here means EVIDENCE WAS GATHERED, never that the explanation
      // is true. Nothing available at this layer can judge that.
      verdict: branch.produced ? 'supports' : 'inconclusive',
      summary: branch.summary ?? '',
      strength: branch.produced ? 0.6 : 0.1,
    }, input.limits);
  });

  const conclusion = concludeResearch(state, input.limits);
  const investigated = conclusion.supported;
  const blocked = conclusion.unresolved;

  const lines: string[] = [
    `I tested ${branches.length} competing explanation${branches.length === 1 ? '' : 's'} for this question.`,
  ];

  if (investigated.length > 0) {
    lines.push(
      '',
      `**Investigated (${investigated.length}):**`,
      ...investigated.map((hypothesis) => `- ${hypothesis.statement}`),
    );
  }

  if (blocked.length > 0) {
    const reasons = new Set(
      blocked
        .map((hypothesis) => {
          const branch = branches.find((candidate) => candidate.statement.trim() === hypothesis.statement);
          return blockedReason(branch?.summary);
        })
        .filter((reason): reason is string => Boolean(reason)),
    );
    lines.push(
      '',
      `**Could not be settled (${blocked.length}):**`,
      ...blocked.map((hypothesis) => `- ${hypothesis.statement}`),
    );
    if (reasons.size > 0) {
      lines.push('', `These were blocked because ${sentenceList([...reasons])}.`);
    }
  }

  if (investigated.length === 0) {
    // The honest headline when nothing could be established: say so first,
    // rather than leading with a number from the one branch that ran.
    lines.splice(1, 0, '', 'None of them could be settled with the governed model as it stands.');
  }

  return lines.join('\n');
}
