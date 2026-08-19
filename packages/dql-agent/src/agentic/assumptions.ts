/**
 * Assumptions — the mechanism that lets a turn ANSWER where it would otherwise
 * ask a question with only one sensible reply.
 *
 * The measured baseline on the jaffle fixture was: false-refusal 0%, but
 * clarification 100%. Nothing dead-ended, yet every answerable question came
 * back as a question. That is a dead end with extra steps whenever the user's
 * only real move is to accept the obvious candidate.
 *
 * The rule is a MARGIN, not a count. One candidate is not the same as no
 * ambiguity: a lone `top_beverage_customers` block is a poor answer to "who are
 * the top customers", and binding it silently would narrow the question without
 * saying so. What makes an assumption safe is that the leading candidate is
 * clearly better than the alternatives — and that we say which one we took and
 * offer the others.
 */

/** What part of the question was assumed rather than proven. */
export type AssumptionAbout =
  | 'metric'
  | 'grain'
  | 'timeframe'
  | 'filter'
  | 'entity'
  | 'join';

export interface AnswerAssumption {
  about: AssumptionAbout;
  /** The governed identifier actually used. */
  chose: string;
  /** Human label for `chose`, when it differs from the id. */
  choseLabel?: string;
  /** One line the user can check at a glance. */
  because: string;
  /** Other candidates, offered as one-click corrections. */
  alternatives: Array<{ id: string; label: string }>;
}

/**
 * How far ahead the leader must be before binding it without asking.
 *
 * Set from the shape of the failure it prevents rather than tuned for a score:
 * at 1.25 a near-tie between two plausible measures still asks, which is the
 * case where guessing wrong produces a confidently wrong number.
 */
export const ASSUMPTION_DOMINANCE_RATIO = 1.25;

export interface AssumptionCandidate {
  id: string;
  label: string;
  score: number;
}

/**
 * Decide whether the leading candidate is safe to assume.
 *
 * Returns `undefined` when the field is genuinely ambiguous, so the caller
 * clarifies instead — that path stays intact on purpose. "Never dead-end" must
 * not become "always guess": a wrong silent binding is worse than a good
 * question, because the user cannot see that it happened.
 */
export function assumeDominantCandidate(input: {
  about: AssumptionAbout;
  candidates: AssumptionCandidate[];
  because: (chosen: AssumptionCandidate) => string;
  dominanceRatio?: number;
}): AnswerAssumption | undefined {
  const ranked = [...input.candidates]
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const leader = ranked[0];
  if (!leader) return undefined;
  const runnerUp = ranked[1];
  const ratio = input.dominanceRatio ?? ASSUMPTION_DOMINANCE_RATIO;
  // A single candidate is dominant by definition — there is nothing to confuse
  // it with. Whether it FITS the question is a separate check the caller owns.
  if (runnerUp) {
    if (runnerUp.score <= 0) {
      // Leader is the only scoring candidate; the rest carry no signal.
    } else if (leader.score < runnerUp.score * ratio) {
      return undefined;
    }
  }
  return {
    about: input.about,
    chose: leader.id,
    ...(leader.label && leader.label !== leader.id ? { choseLabel: leader.label } : {}),
    because: input.because(leader),
    alternatives: ranked.slice(1, 4).map((candidate) => ({ id: candidate.id, label: candidate.label })),
  };
}

/** One line the user reads above the answer. */
export function renderAssumptionPreamble(assumptions: AnswerAssumption[]): string | undefined {
  if (assumptions.length === 0) return undefined;
  const lines = assumptions.map((assumption) => {
    const chosen = assumption.choseLabel ?? assumption.chose;
    const alternatives = assumption.alternatives.length > 0
      ? ` Other options: ${assumption.alternatives.map((alternative) => alternative.label).join(', ')}.`
      : '';
    return `Assumed ${assumption.about}: **${chosen}** — ${assumption.because}${alternatives}`;
  });
  return lines.join('\n');
}
