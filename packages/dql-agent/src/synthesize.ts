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
    "Use ONLY numbers that appear in the provided rows — never invent or estimate values.",
    "Do NOT add trust disclaimers (e.g. 'uncertified', 'review required') — the UI shows a trust badge separately.",
    "Do NOT say 'As an AI' or narrate your process. Be direct and concrete.",
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
      lines.push("Format: a short GitHub-flavored markdown table built ONLY from the provided rows, then ONE insight sentence beneath it.");
      break;
    case "research":
      lines.push(
        "Format: use these sections as `## ` headings, omitting any that would be empty:",
        "## What I found\n## What's driving it\n## Caveats\n## Suggested next step",
        "Keep each section to 1-3 sentences. Ground every claim in the provided findings/rows.",
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

function buildUserPrompt(input: SynthesizeInput): string {
  const lines: string[] = [];
  lines.push(`Question: ${input.question}`);
  if (input.resultPreview) lines.push(`Result (${input.resultPreview.rowCount} rows):\n${previewToText(input.resultPreview)}`);
  if (input.findings?.length) lines.push(`Findings:\n${input.findings.map((f) => `- ${f}`).join("\n")}`);
  if (input.gaps?.length) lines.push(`Known gaps/caveats:\n${input.gaps.map((g) => `- ${g}`).join("\n")}`);
  if (input.sql && input.audience !== "stakeholder") lines.push(`SQL used:\n${input.sql}`);
  lines.push("Write the answer now.");
  return lines.join("\n\n");
}

/** Deterministic floor — the loop's draft, or a line built from the top row. */
function deterministicSynthesis(input: SynthesizeInput, format: SynthesisFormat): SynthesizeResult {
  if (input.draftText && input.draftText.trim().length > 0) {
    return { text: input.draftText.trim(), format, source: "deterministic" };
  }
  const preview = input.resultPreview;
  if (format === "comparison" && preview && preview.rows.length > 1) {
    return { text: previewToText(preview), format, source: "deterministic" };
  }
  if (preview && preview.rows.length >= 1) {
    const cols = preview.columns.length > 0 ? preview.columns : Object.keys(preview.rows[0] ?? {});
    const first = preview.rows[0];
    const parts = cols.slice(0, 3).map((col) => `${col}: ${formatCell(first[col])}`);
    return { text: parts.join(", "), format, source: "deterministic" };
  }
  if (input.findings?.length) {
    return { text: input.findings.map((f) => `- ${f}`).join("\n"), format, source: "deterministic" };
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
    const text = raw.trim();
    if (text.length > 0) return { text, format, source: "llm" };
  } catch {
    // fall through to deterministic
  }
  return floor;
}
