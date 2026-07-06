/**
 * LLM-as-judge for the agent eval harness (R3.2).
 *
 * A single-call judge that scores a generated answer against a rubric — correct
 * objects, correct aggregation, honest trust label — returning a 0..1 score plus
 * a pass/fail. Per Anthropic's finding, a single call with a 0..1 score + pass/fail
 * is more consistent than elaborate multi-call rubrics. The `complete` callback is
 * injected so this is fully unit-testable offline and only reaches a real model
 * when the caller supplies a credentialed completion.
 */

export interface JudgeInput {
  question: string;
  sql?: string;
  answerText?: string;
  trustLabel?: string;
  resultSample?: unknown[];
  /** Optional gold reference (question intent / expected shape) for the rubric. */
  expectation?: string;
}

export interface JudgeVerdict {
  score: number;
  pass: boolean;
  rationale: string;
}

export type JudgeCompletion = (input: { system: string; user: string }) => Promise<string>;

const RUBRIC = [
  'You are grading a data-analytics answer. Score 0.0 to 1.0 on this rubric:',
  '- Correct objects: does the SQL reference the right tables/columns for the question?',
  '- Correct aggregation/grain: are measures aggregated and grouped as the question asks?',
  '- Honest trust label: is the trust label consistent with how the answer was produced (certified vs review-required)?',
  'Respond with ONLY a JSON object, no prose, no code fences:',
  '{"score": number (0..1), "pass": boolean, "rationale": string}',
  'pass is true only when score >= 0.7 and there is no correctness red flag.',
].join('\n');

export async function judgeAnswer(input: JudgeInput, complete: JudgeCompletion): Promise<JudgeVerdict | undefined> {
  const user = [
    `Question: ${input.question}`,
    input.expectation ? `Expected intent/shape: ${input.expectation}` : '',
    input.trustLabel ? `Trust label: ${input.trustLabel}` : '',
    input.sql ? `Generated SQL:\n${input.sql}` : '(no SQL produced)',
    input.answerText ? `Answer prose: ${input.answerText}` : '',
    input.resultSample?.length ? `Result sample (first rows): ${JSON.stringify(input.resultSample.slice(0, 5))}` : '',
    'Grade the answer as JSON.',
  ].filter(Boolean).join('\n\n');

  let raw: string;
  try {
    raw = await complete({ system: RUBRIC, user });
  } catch {
    return undefined;
  }
  return parseJudgeVerdict(raw);
}

export function parseJudgeVerdict(raw: string): JudgeVerdict | undefined {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;
  const score = typeof record.score === 'number' && Number.isFinite(record.score)
    ? Math.max(0, Math.min(1, record.score))
    : undefined;
  if (score === undefined) return undefined;
  const pass = typeof record.pass === 'boolean' ? record.pass : score >= 0.7;
  const rationale = typeof record.rationale === 'string' ? record.rationale.trim() : '';
  return { score, pass, rationale };
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = trimmed.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Aggregate judge verdicts into a mean score and pass rate. */
export function summarizeJudgeVerdicts(verdicts: Array<JudgeVerdict | undefined>): {
  judged: number;
  meanScore: number | null;
  passRate: number | null;
} {
  const present = verdicts.filter((v): v is JudgeVerdict => Boolean(v));
  if (present.length === 0) return { judged: 0, meanScore: null, passRate: null };
  const meanScore = present.reduce((sum, v) => sum + v.score, 0) / present.length;
  const passRate = present.filter((v) => v.pass).length / present.length;
  return { judged: present.length, meanScore, passRate };
}
