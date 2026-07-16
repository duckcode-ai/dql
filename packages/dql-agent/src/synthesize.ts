/**
 * Answer synthesis — turn a governed result into a reply whose *shape* matches the
 * question, instead of one static template for everything.
 *
 * The answer loop already produces a correct result (rows) and a draft summary from
 * its SQL-generation call. This step composes the final prose the user reads, with
 * format rules keyed on the question type and audience:
 *   - lookup → the number + one sentence, nothing else
 *   - comparison / breakdown → a short table (supplied rows only) + one insight
 *   - research → sections (What I found / What's driving it / Caveats / Next step)
 *   - stakeholder → plain language, no SQL talk; analyst → may reference SQL
 * Trust boilerplate ("uncertified until reviewed") is NOT prose — the badge owns it.
 *
 * Provider-agnostic and offline-safe: the completion is injected (like `narrate`),
 * and any failure falls back to a deterministic reply built from the draft + rows.
 */

export type SynthesisFormat = "lookup" | "comparison" | "research" | "prose";

export interface SynthesizeResultPreview {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  /**
   * Deterministic statistics computed over the FULL result (not the sampled
   * rows above). The narrator must source every aggregate claim (ranges,
   * totals, "all rows are X") from these — a sample described as the
   * population is the last hallucination surface in the pipeline.
   */
  stats?: SynthesizeColumnStat[];
}

export interface SynthesizeColumnStat {
  column: string;
  kind: 'numeric' | 'categorical';
  min?: number;
  max?: number;
  sum?: number;
  distinctCount?: number;
  /** Top distinct values with occurrence counts (low-cardinality columns only). */
  values?: Array<{ value: string; count: number }>;
}

/**
 * Compute verified per-column statistics over the FULL result set so narration
 * never has to derive aggregates from a truncated sample. Deterministic and
 * cheap (single pass, capped).
 */
export function computeResultStats(
  columns: string[],
  rows: Array<Record<string, unknown>>,
): SynthesizeColumnStat[] {
  const scanned = rows.slice(0, 10_000);
  const stats: SynthesizeColumnStat[] = [];
  for (const column of columns.slice(0, 16)) {
    let min: number | undefined;
    let max: number | undefined;
    let sum = 0;
    let numericCount = 0;
    const distinct = new Map<string, number>();
    for (const row of scanned) {
      const value = row[column];
      if (typeof value === 'number' && Number.isFinite(value)) {
        numericCount += 1;
        sum += value;
        min = min === undefined ? value : Math.min(min, value);
        max = max === undefined ? value : Math.max(max, value);
      } else if (typeof value === 'string' && value.trim()) {
        if (distinct.size <= 48) distinct.set(value, (distinct.get(value) ?? 0) + 1);
      }
    }
    if (numericCount > 0 && numericCount >= scanned.length / 2) {
      stats.push({ column, kind: 'numeric', min, max, sum: Number(sum.toFixed(4)) });
    } else if (distinct.size > 0) {
      stats.push({
        column,
        kind: 'categorical',
        distinctCount: distinct.size,
        values: distinct.size <= 12
          ? [...distinct.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([value, count]) => ({ value, count }))
          : undefined,
      });
    }
  }
  return stats;
}

export interface SynthesizeInput {
  question: string;
  /** Router/metadata category, if known (drives the default format). */
  category?: string;
  audience?: "analyst" | "stakeholder";
  /** The bounded result the answer is grounded in (columns + up to ~20 rows). */
  resultPreview?: SynthesizeResultPreview;
  /** The SQL that produced the result (analyst-facing only). */
  sql?: string;
  /** The loop's draft summary — the deterministic floor when no LLM is available. */
  draftText?: string;
  /** Research findings (from narrateResult) to weave into a sectioned answer. */
  findings?: string[];
  /** Known gaps/caveats to surface honestly. */
  gaps?: string[];
}

/** Injected text completion, optionally streaming token deltas. */
export type SynthesizeCompletion = (input: {
  system: string;
  user: string;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}) => Promise<string>;

export interface SynthesizeOptions {
  complete?: SynthesizeCompletion;
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
  /** Force a format; otherwise inferred from category + result shape. */
  format?: SynthesisFormat;
}

export interface SynthesizeResult {
  text: string;
  format: SynthesisFormat;
  source: "llm" | "deterministic";
}

const COMPARISON_RE = /\b(compare|versus|vs\.?|by |per |breakdown|break down|top \d+|rank|distribution|segment|cohort|across)\b/i;
const RESEARCH_RE = /\b(why|driver|drivers|root cause|what happened|what changed|investigate|anomal|trend|explain)\b/i;

/** Pick the answer shape from category + question + result cardinality. */
export function inferFormat(input: SynthesizeInput): SynthesisFormat {
  if (input.category === "data_analysis" || (input.findings && input.findings.length > 0)) return "research";
  if (RESEARCH_RE.test(input.question)) return "research";
  const rowCount = input.resultPreview?.rowCount ?? input.resultPreview?.rows.length ?? 0;
  if (COMPARISON_RE.test(input.question) && rowCount > 1) return "comparison";
  if (rowCount <= 1) return "lookup";
  return "prose";
}

function buildSystemPrompt(format: SynthesisFormat, audience: "analyst" | "stakeholder"): string {
  const lines = [
    "You compose the final answer a user reads in DQL, a governed analytics tool.",
    "Lead with the business meaning of the executed result, not how the query was planned or run.",
    "Use ONLY numbers that appear in the provided rows or VERIFIED STATISTICS — never invent, estimate, or round beyond them.",
    "The rows shown may be a SAMPLE of a larger result. Any aggregate claim — ranges (min/max), totals, counts, or 'all/most rows are X' — MUST come from the VERIFIED STATISTICS section when present. NEVER derive aggregates from the sample rows.",
    "Do not do arithmetic in prose (no 'over 100', 'roughly', 'around'); quote exact values from the rows or statistics, or omit the claim.",
    "Do NOT add trust disclaimers (e.g. 'uncertified', 'review required') — the UI shows a trust badge separately.",
    "Do NOT mention query plans, grain, routing, tools, SQL, tables, columns, row counts, missing-output checks, or implementation details. Those appear in a separate inspector.",
    "Do NOT say 'As an AI' or narrate your process. Be direct and concrete.",
    "Return concise GitHub-flavored Markdown only. Never return HTML.",
  ];
  if (audience === "stakeholder") {
    lines.push("Audience: a business stakeholder. Use plain language; do NOT mention SQL, tables, or columns.");
  } else {
    lines.push("Audience: an analyst. You may reference tables/columns; keep SQL talk minimal.");
  }
  switch (format) {
    case "lookup":
      lines.push("Format: state the single value and one short sentence of context. Nothing else — no headings, no table.");
      break;
    case "comparison":
      lines.push("Format: one answer-first sentence followed by at most 3 short bullets for the most decision-useful comparisons. Do not repeat the result as a table; the UI renders it directly below the answer.");
      break;
    case "research":
      lines.push(
        "Format: one answer-first sentence, then at most 3 short bullets naming the strongest evidence-backed drivers or comparisons.",
        "Add one final caveat only when the result cannot establish causation or a required baseline is missing. Do not create section headings for a short answer.",
      );
      break;
    default:
      lines.push("Format: 1-3 tight sentences. Add a small markdown table only if it genuinely aids clarity.");
  }
  return lines.join("\n");
}

function previewToText(preview: SynthesizeResultPreview | undefined, limit = 20): string {
  if (!preview || preview.rows.length === 0) return "(no rows)";
  const cols = preview.columns.length > 0 ? preview.columns : Object.keys(preview.rows[0] ?? {});
  const header = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = preview.rows.slice(0, limit).map((row) =>
    `| ${cols.map((col) => formatCell(row[col])).join(" | ")} |`,
  );
  const more = preview.rows.length > limit ? `\n(${preview.rows.length - limit} more rows not shown)` : "";
  return [header, sep, ...body].join("\n") + more;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  return String(value).replace(/\|/g, "\\|");
}

function humanizeColumn(column: string): string {
  return column
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function isTechnicalColumn(column: string): boolean {
  return /(?:^|_)(?:id|uuid|key|code)$/i.test(column);
}

function numericCell(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function formatBusinessValue(column: string, value: unknown): string {
  const numeric = numericCell(value);
  if (numeric === undefined) return formatCell(value).replace(/_/g, " ");
  if (/percent|percentage|pct/i.test(column)) return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(numeric)}%`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(numeric);
}

function labelColumn(preview: SynthesizeResultPreview): string | undefined {
  const sample = preview.rows[0] ?? {};
  const candidates = preview.columns.filter((column) => numericCell(sample[column]) === undefined && !isTechnicalColumn(column));
  return candidates.find((column) => /name|title|label|customer|account|product|region|segment|category|channel|status|type/i.test(column))
    ?? candidates[0];
}

function measureColumn(input: SynthesizeInput): string | undefined {
  const preview = input.resultPreview;
  if (!preview?.rows.length) return undefined;
  const numeric = preview.columns.filter((column) => preview.rows.some((row) => numericCell(row[column]) !== undefined) && !isTechnicalColumn(column));
  if (numeric.length === 0) return undefined;
  const questionTerms = new Set(input.question.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2));
  const scored = numeric.map((column, index) => {
    const terms = column.toLowerCase().split(/[_-]+/);
    const overlap = terms.filter((term) => questionTerms.has(term)).length;
    const businessMeasure = /revenue|sales|spend|amount|value|profit|margin|cost|price|tax|orders?|count|rate|score|total/i.test(column) ? 1 : 0;
    const lifetime = /lifetime/i.test(column) && /revenue|spend|value|sales/i.test(input.question) ? 1 : 0;
    return { column, score: overlap * 10 + businessMeasure * 3 + lifetime * 4 - index / 100 };
  });
  scored.sort((left, right) => right.score - left.score);
  return scored[0]?.column;
}

function visibleProfileFields(preview: SynthesizeResultPreview, identityColumn?: string): string[] {
  return preview.columns
    .filter((column) => column !== identityColumn && !isTechnicalColumn(column))
    .sort((left, right) => {
      const priority = (column: string) => /status|type|tier|segment/i.test(column) ? 0
        : /revenue|sales|spend|amount|value|profit|orders?|count/i.test(column) ? 1
          : /first|last|date|time|at$/i.test(column) ? 2
            : 3;
      return priority(left) - priority(right);
    });
}

/** Offline-safe stakeholder prose built only from executed values. */
function deterministicBusinessNarrative(input: SynthesizeInput, format: SynthesisFormat): string | undefined {
  const preview = input.resultPreview;
  if (!preview) return undefined;
  if (preview.rows.length === 0) return "No matching records were found for this question.";

  const identityColumn = labelColumn(preview);
  const measure = measureColumn(input);
  if (preview.rows.length === 1) {
    const row = preview.rows[0];
    const identityValue = identityColumn ? formatBusinessValue(identityColumn, row[identityColumn]) : undefined;
    const fields = visibleProfileFields(preview, identityColumn).filter((column) => row[column] !== null && row[column] !== undefined && row[column] !== "");
    const leadFields = fields.slice(0, 3);
    const lead = leadFields.map((column) => `**${humanizeColumn(column)}:** ${formatBusinessValue(column, row[column])}`).join(" · ");
    const headline = identityValue
      ? `**${identityValue}**${lead ? ` — ${lead}.` : "."}`
      : lead || "One matching record was found.";
    const remaining = fields.slice(3, 7);
    return remaining.length > 0
      ? `${headline}\n${remaining.map((column) => `- **${humanizeColumn(column)}:** ${formatBusinessValue(column, row[column])}`).join("\n")}`
      : headline;
  }

  if (measure) {
    const ranked = preview.rows
      .map((row) => ({ row, value: numericCell(row[measure]) }))
      .filter((entry): entry is { row: Record<string, unknown>; value: number } => entry.value !== undefined)
      .sort((left, right) => right.value - left.value);
    const top = ranked[0];
    if (top) {
      const topLabel = identityColumn ? formatBusinessValue(identityColumn, top.row[identityColumn]) : "The leading result";
      const scope = preview.rowCount > preview.rows.length ? "Among the displayed results, " : "";
      const headline = `${scope}**${topLabel}** has the highest ${humanizeColumn(measure).toLowerCase()} at **${formatBusinessValue(measure, top.value)}**.`;
      const next = ranked.slice(1, 3).map((entry) => {
        const label = identityColumn ? formatBusinessValue(identityColumn, entry.row[identityColumn]) : "Another result";
        return `- **${label}:** ${formatBusinessValue(measure, entry.value)}`;
      });
      const causationCaveat = format === "research"
        ? "\nThis result shows the pattern, but it does not by itself establish the underlying cause."
        : "";
      return [headline, ...next].join("\n") + causationCaveat;
    }
  }

  const first = preview.rows[0];
  const fields = preview.columns.filter((column) => !isTechnicalColumn(column)).slice(0, 4);
  return fields.map((column) => `**${humanizeColumn(column)}:** ${formatBusinessValue(column, first[column])}`).join(" · ");
}

/** Keep model output safe for the Markdown renderer while accepting common HTML-ish completions. */
function normalizeSynthesisText(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<(?:b)\b[^>]*>([\s\S]*?)<\/(?:b)>/gi, "**$1**")
    .replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/(?:li|div|p|span|ul|ol)>/gi, "\n")
    .replace(/<(?:div|p|span|ul|ol)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripMarkdownResultTables(value: string): string {
  const lines = value.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index].trim();
    const next = lines[index + 1]?.trim() ?? "";
    const startsTable = current.startsWith("|") && current.endsWith("|")
      && next.startsWith("|") && /^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(next);
    if (!startsTable) {
      out.push(lines[index]);
      continue;
    }
    index += 2;
    while (index < lines.length && lines[index].trim().startsWith("|") && lines[index].trim().endsWith("|")) index += 1;
    index -= 1;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function statsToText(stats: SynthesizeColumnStat[] | undefined, rowCount: number): string | undefined {
  if (!stats || stats.length === 0) return undefined;
  const lines = stats.slice(0, 16).map((stat) => {
    if (stat.kind === 'numeric') {
      return `- ${stat.column}: min ${stat.min}, max ${stat.max}, sum ${stat.sum}`;
    }
    const values = stat.values
      ? ` (${stat.values.slice(0, 12).map((entry) => `${entry.value}: ${entry.count}`).join(', ')})`
      : '';
    return `- ${stat.column}: ${stat.distinctCount} distinct value${stat.distinctCount === 1 ? '' : 's'}${values}`;
  });
  return `VERIFIED STATISTICS (computed over ALL ${rowCount} rows — the ONLY source for aggregate claims):\n${lines.join('\n')}`;
}

function buildUserPrompt(input: SynthesizeInput): string {
  const lines: string[] = [];
  lines.push(`Question: ${input.question}`);
  if (input.resultPreview) {
    const shown = Math.min(input.resultPreview.rows.length, 20);
    const sampleLabel = input.resultPreview.rowCount > shown
      ? `Result (${input.resultPreview.rowCount} rows total; SAMPLE of first ${shown} shown):`
      : `Result (${input.resultPreview.rowCount} rows):`;
    lines.push(`${sampleLabel}\n${previewToText(input.resultPreview)}`);
    const statsText = statsToText(input.resultPreview.stats, input.resultPreview.rowCount);
    if (statsText) lines.push(statsText);
  }
  if (input.findings?.length) lines.push(`Findings:\n${input.findings.map((f) => `- ${f}`).join("\n")}`);
  if (input.gaps?.length) lines.push(`Known gaps/caveats:\n${input.gaps.map((g) => `- ${g}`).join("\n")}`);
  if (input.sql && input.audience !== "stakeholder") lines.push(`SQL used:\n${input.sql}`);
  lines.push("Write the answer now.");
  return lines.join("\n\n");
}

/** Deterministic floor — the loop's draft, or a line built from the top row. */
function deterministicSynthesis(input: SynthesizeInput, format: SynthesisFormat): SynthesizeResult {
  const businessNarrative = deterministicBusinessNarrative(input, format);
  if (businessNarrative) return { text: businessNarrative, format, source: "deterministic" };
  if (input.findings?.length) {
    return { text: input.findings.map((f) => `- ${f}`).join("\n"), format, source: "deterministic" };
  }
  if (input.draftText && input.draftText.trim().length > 0) {
    return { text: normalizeSynthesisText(input.draftText), format, source: "deterministic" };
  }
  return { text: "No result was available for this question.", format, source: "deterministic" };
}

/**
 * Compose the final answer. Streams token deltas through `options.onDelta` when the
 * injected completion supports it; always returns the full text (and a deterministic
 * floor on any failure).
 */
export async function synthesizeAnswer(input: SynthesizeInput, options: SynthesizeOptions = {}): Promise<SynthesizeResult> {
  const format = options.format ?? inferFormat(input);
  const floor = deterministicSynthesis(input, format);
  if (!options.complete) return floor;
  try {
    const raw = await options.complete({
      system: buildSystemPrompt(format, input.audience ?? "analyst"),
      user: buildUserPrompt(input),
      signal: options.signal,
      onDelta: options.onDelta,
    });
    const normalized = normalizeSynthesisText(raw);
    const text = input.resultPreview ? stripMarkdownResultTables(normalized) : normalized;
    if (text.length > 0) return { text, format, source: "llm" };
  } catch {
    // fall through to deterministic
  }
  return floor;
}
