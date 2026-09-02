/**
 * Let a model write an ordinary Ask answer, from the host's facts only, and
 * prove every number it used before the reader sees it.
 *
 * The deterministic narrative is correct and dull: it states the total, the
 * leader and the share, then lists rows. A model can say the same thing in a
 * sentence a person actually wants to read. What it must not do is add a
 * number nobody computed, infer a cause, or claim something is absent — the
 * three ways a fluent answer becomes a wrong one.
 *
 * So the contract is narrow on purpose. The model receives the FACT BRIEF and
 * never the result rows, and everything it returns is checked back against
 * those facts. A single unverifiable number sends the whole narration back and
 * the deterministic text ships instead, which means the worst case of turning
 * this on is the answer the reader already gets.
 */

export interface AskNarrationFactV1 {
  factId: string;
  kind: string;
  rowIndex?: number;
  /** The result's own column values for this fact. */
  values?: Record<string, unknown>;
  /** Host-computed detail: row counts, totals, the leader's share. */
  details?: Record<string, unknown>;
}

export interface AskNarrationFactSetV1 {
  factSetId: string;
  facts: AskNarrationFactV1[];
}

export type AskNarrationRejection =
  | 'CAUSAL_CLAIM'
  | 'ABSENCE_CLAIM'
  | 'UNVERIFIED_NUMBER'
  | 'EMPTY_NARRATION'
  | 'TOO_LONG';

export interface AskNarrationVerification {
  ok: boolean;
  failures: AskNarrationRejection[];
  /** The numbers the narration used that no fact supports. */
  unverified: string[];
}

/** Words that turn a description of a result into an explanation of the world. */
const CAUSAL_LANGUAGE = /\b(?:because|caused?|causing|drove|driven by|led to|due to|resulted in|responsible for|explains?|thanks to)\b/i;

/**
 * Absence is the claim a bounded result can never support: the rows are a top
 * N, so "no other account" or "none of the segments" is about data the answer
 * never looked at.
 */
const ABSENCE_LANGUAGE = /\b(?:no other|none of|nothing else|no accounts?|no customers?|there are no|zero other|only one)\b/i;

const MAX_NARRATION_CHARS = 1200;

/** Every numeric token in a piece of text, normalized for comparison. */
function numericTokens(text: string): string[] {
  const matches = text.match(/-?\d[\d,]*(?:\.\d+)?%?/g) ?? [];
  return matches.map(normalizeNumber).filter((token): token is string => token !== undefined);
}

function normalizeNumber(raw: string): string | undefined {
  const cleaned = raw.replace(/[,%]/g, '');
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return undefined;
  // Compare at two decimals so "$2,465,098.60" and "2465098.6" are one number,
  // and a rounded restatement ("11.1%") still has to match a computed one.
  return value.toFixed(2);
}

/** A field the host stores as a fraction but every reader states as a percent. */
const SHARE_FIELD = /(?:share|rate|ratio|percent|pct)$/i;

/** Every number the host actually computed, in the same normalized form. */
export function verifiableNumbersFromFacts(factSet: AskNarrationFactSetV1): Set<string> {
  const numbers = new Set<string>();
  const addNumber = (value: number): void => {
    numbers.add(value.toFixed(2));
    // A reader-facing restatement may round; accept the rounded forms too.
    numbers.add(Number(value.toFixed(1)).toFixed(2));
    numbers.add(Math.round(value).toFixed(2));
  };
  const add = (value: unknown, key?: string): void => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      addNumber(value);
      // The host stores a share as a fraction (0.1112) and every human answer
      // states it as a percentage (11.1%). Rejecting the percentage form threw
      // away otherwise perfect narration over a unit convention. Bounded to
      // fields whose NAME says they are a share, so this can never quietly
      // admit an arbitrary hundredfold restatement of a revenue figure.
      if (key && SHARE_FIELD.test(key) && value > 0 && value <= 1) addNumber(value * 100);
      return;
    }
    if (typeof value === 'string') for (const token of numericTokens(value)) numbers.add(token);
  };
  for (const fact of factSet.facts) {
    if (typeof fact.rowIndex === 'number') add(fact.rowIndex + 1);
    for (const [key, value] of Object.entries(fact.values ?? {})) add(value, key);
    for (const [key, detail] of Object.entries(fact.details ?? {})) add(detail, key);
  }
  return numbers;
}

/**
 * Check a proposed narration against the facts that produced it.
 *
 * Deliberately mechanical. It does not judge whether the sentence is a good
 * summary — only whether every number in it is one the host computed and
 * whether it stays inside what a bounded result can support.
 */
export function verifyAskNarration(input: {
  text: string;
  factSet: AskNarrationFactSetV1;
}): AskNarrationVerification {
  const text = input.text.trim();
  const failures: AskNarrationRejection[] = [];
  if (!text) return { ok: false, failures: ['EMPTY_NARRATION'], unverified: [] };
  if (text.length > MAX_NARRATION_CHARS) failures.push('TOO_LONG');
  if (CAUSAL_LANGUAGE.test(text)) failures.push('CAUSAL_CLAIM');
  if (ABSENCE_LANGUAGE.test(text)) failures.push('ABSENCE_CLAIM');
  const known = verifiableNumbersFromFacts(input.factSet);
  const unverified = [...new Set(numericTokens(text).filter((token) => !known.has(token)))];
  if (unverified.length > 0) failures.push('UNVERIFIED_NUMBER');
  return { ok: failures.length === 0, failures, unverified: unverified.slice(0, 8) };
}

/**
 * The facts, as text a model can write from — and the only result information
 * that leaves the host for an ordinary Ask.
 */
export function renderAskNarrationBrief(input: {
  question: string;
  factSet: AskNarrationFactSetV1;
  maxFacts?: number;
}): string {
  const limit = Math.min(Math.max(1, input.maxFacts ?? 40), 120);
  const render = (record: Record<string, unknown> | undefined): string => Object.entries(record ?? {})
    .map(([key, value]) => (typeof value === 'number' && SHARE_FIELD.test(key) && value > 0 && value <= 1
      // Give the percentage rather than making the model derive it: a derived
      // number is exactly the kind the verifier cannot confirm.
      ? `${key}=${(value * 100).toFixed(1)}%`
      : `${key}=${String(value)}`))
    .join(', ');
  const lines = input.factSet.facts.slice(0, limit).map((fact) => {
    const parts = [render(fact.values), render(fact.details)].filter(Boolean).join('; ');
    const position = typeof fact.rowIndex === 'number' ? ` #${fact.rowIndex + 1}` : '';
    return `- ${fact.kind}${position}: ${parts}`;
  });
  return [
    `Question: ${input.question}`,
    '',
    'Facts computed by the host from the executed result. These are the ONLY facts you have:',
    ...lines,
  ].join('\n');
}

/** The instruction that goes with the brief. */
export const ASK_NARRATION_SYSTEM_PROMPT = [
  'You write the final answer for a governed analytics system.',
  'You are given facts the host computed from a query it already ran. You do not have the rows.',
  'Write two to four sentences that tell the reader what the result says: lead with the headline number,',
  'name the leader and its share when the facts give them, and note the scope of the result.',
  'Rules that are checked mechanically before your text is shown, so breaking one discards all of it:',
  'use ONLY numbers that appear in the facts; never explain WHY something happened;',
  'never say anything is absent, missing, or the only one — the result is a bounded slice, not the whole warehouse.',
  'Return the answer text only, with no preamble and no bullet list.',
].join(' ');
