import type { Hint, HintLesson } from './types.js';

const MAX_RULE_LENGTH = 1_200;
const MAX_LIST_ITEMS = 8;
const MAX_LIST_ITEM_LENGTH = 240;
const MAX_EXPECTED_OUTCOME_LENGTH = 600;

export interface DeriveHintLessonInput {
  question: string;
  wrongAnswer: string;
  correctedSql?: string;
  guidance: string;
  lesson?: Partial<HintLesson>;
}

/**
 * Build the governed experience attached to a new correction. The category is
 * deterministic and advisory; the reviewer can change every lesson field
 * before approval.
 */
export function deriveHintLesson(input: DeriveHintLessonInput): HintLesson {
  return normalizeHintLesson(input.lesson, {
    rule: input.guidance,
    category: inferLessonCategory(input.wrongAnswer, input.correctedSql),
    intentExamples: [input.question],
  });
}

/**
 * Read old Git hints as a useful lesson without rewriting them. This keeps
 * `guidance` the compatibility field while new hints carry richer semantics.
 */
export function lessonForHint(hint: Pick<Hint, 'guidance' | 'lesson'>): HintLesson {
  return normalizeHintLesson(hint.lesson, {
    rule: hint.guidance,
    category: 'semantic_rule',
    intentExamples: [],
  });
}

export function normalizeHintLesson(
  input: Partial<HintLesson> | null | undefined,
  fallback: Pick<HintLesson, 'rule' | 'category' | 'intentExamples'>,
): HintLesson {
  const rule = cleanText(input?.rule, MAX_RULE_LENGTH) || cleanText(fallback.rule, MAX_RULE_LENGTH);
  if (!rule) throw new Error('A governed lesson requires a reusable rule.');
  return {
    version: 1,
    category: isLessonCategory(input?.category) ? input.category : fallback.category,
    rule,
    intentExamples: cleanList(input?.intentExamples ?? fallback.intentExamples),
    avoid: cleanList(input?.avoid),
    expectedOutcome: cleanText(input?.expectedOutcome, MAX_EXPECTED_OUTCOME_LENGTH) || undefined,
  };
}

/** Search text stored only in the rebuildable SQLite projection. */
export function hintLessonSearchText(hint: Pick<Hint, 'guidance' | 'lesson'>): string {
  const lesson = lessonForHint(hint);
  return [
    lesson.rule,
    lesson.category.replace(/_/g, ' '),
    ...lesson.intentExamples,
    ...lesson.avoid,
    lesson.expectedOutcome,
  ].filter(Boolean).join(' ');
}

function inferLessonCategory(wrongAnswer: string, correctedSql?: string): HintLesson['category'] {
  const before = normalizeSql(wrongAnswer);
  const after = normalizeSql(correctedSql ?? '');
  if (clauseChanged(before, after, /\bjoin\b/g)) return 'join_rule';
  if (clauseChanged(before, after, /\b(?:where|having|qualify)\b/g)) return 'filter_rule';
  if (
    clauseChanged(before, after, /\bgroup\s+by\b/g)
    || clauseChanged(before, after, /\b(?:sum|avg|count|min|max)\s*\(/g)
  ) return 'aggregation_rule';
  if (clauseChanged(before, after, /\b(?:distinct|row_number|dense_rank|rank)\b/g)) return 'grain_rule';
  if (clauseChanged(before, after, /\b(?:date_trunc|dateadd|datediff|interval|current_date)\b/g)) return 'time_rule';
  if (clauseChanged(before, after, /\b(?:from|join)\s+[a-z_][\w$.]*/g)) return 'relation_rule';
  return 'semantic_rule';
}

function clauseChanged(before: string, after: string, pattern: RegExp): boolean {
  if (!after) return false;
  return matches(before, pattern).join('\0') !== matches(after, pattern).join('\0');
}

function matches(value: string, pattern: RegExp): string[] {
  return [...value.matchAll(pattern)].map((match) => match[0]);
}

function normalizeSql(value: string): string {
  return value
    .replace(/--.*$/gm, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function cleanList(values: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const cleaned = cleanText(value, MAX_LIST_ITEM_LENGTH);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out;
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength)
    : '';
}

function isLessonCategory(value: unknown): value is HintLesson['category'] {
  return [
    'semantic_rule',
    'filter_rule',
    'join_rule',
    'aggregation_rule',
    'grain_rule',
    'time_rule',
    'relation_rule',
    'dialect_rule',
  ].includes(String(value));
}
