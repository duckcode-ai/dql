/**
 * The identifier ledger — provenance for every name that reaches executed SQL.
 *
 * A semantic-layer-mediated agent reached 94.15% on Spider2-snow where frontier
 * models score 17–21% unaided, and the rule doing most of that work is not a
 * better prompt: only identifiers LIFTED FROM A COMPILER OUTPUT may appear in
 * executed SQL. Everything else is a guess wearing a plausible name.
 *
 * The static equivalent already exists — `validateSqlAgainstLocalContext` checks
 * SQL against the context pack's allowed relations. The ledger is its dynamic
 * half: inside a loop the set of PROVEN identifiers grows with every tool
 * observation, so what counts as admissible at step 5 is not what it was at
 * step 1.
 *
 * Division of labour, deliberately: the validator EXTRACTS references from SQL
 * (it owns the dialect handling, CTE scoping, and alias resolution); the ledger
 * only adjudicates where each reference came from. Re-implementing extraction
 * here would fork a parser that has already absorbed a lot of hard-won cases.
 */

/** Where an identifier was proven. Ordered loosely by strength of evidence. */
export type IdentifierSource =
  | 'compiler'      // emitted by the semantic compiler — the strongest evidence
  | 'preview'       // observed in a bounded preview's result columns
  | 'schema_tool'   // returned by an explicit schema inspection
  | 'catalog';      // present in the retrieved context pack

export interface AdmittedIdentifier {
  identifier: string;
  source: IdentifierSource;
  /** The tool call / receipt that proves it, for the audit trail. */
  receiptId: string;
}

export interface LedgerAdjudication {
  ok: boolean;
  /** References that no observation admitted. */
  unadmitted: string[];
  /**
   * Closest admitted identifier per unadmitted reference. The dominant failure
   * mode is a plausible-but-wrong column name, so handing the model the exact
   * correction is worth far more than telling it that something was wrong.
   */
  nearest: Record<string, string>;
}

/** Case-insensitive qualified identity. Qualifiers remain part of authority. */
function normalizeIdentifier(value: string): string {
  return value
    .trim()
    .split('.')
    .map((part) => part.trim().replace(/^["`\[]|["`\]]$/g, '').toLowerCase())
    .filter(Boolean)
    .join('.');
}

/** Last segment of a dotted identifier (`db.schema.orders` → `orders`). */
function leafOf(value: string): string {
  const normalized = normalizeIdentifier(value);
  const parts = normalized.split('.').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

/** Damerau-Levenshtein distance, for "did you mean" corrections. */
export function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  const rows = left.length + 1;
  const cols = right.length + 1;
  const grid: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) grid[i]![0] = i;
  for (let j = 0; j < cols; j += 1) grid[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let best = Math.min(grid[i - 1]![j]! + 1, grid[i]![j - 1]! + 1, grid[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        best = Math.min(best, grid[i - 2]![j - 2]! + 1);
      }
      grid[i]![j] = best;
    }
  }
  return grid[rows - 1]![cols - 1]!;
}

export class IdentifierLedger {
  private readonly admitted = new Map<string, AdmittedIdentifier>();

  /**
   * Record identifiers proven by one observation.
   *
   * Admission is append-only and always carries a receipt: an identifier with no
   * traceable source is exactly what this class exists to keep out of SQL.
   */
  admit(source: IdentifierSource, identifiers: readonly string[], receiptId: string): void {
    for (const raw of identifiers) {
      if (!raw || typeof raw !== 'string') continue;
      const key = normalizeIdentifier(raw);
      if (!key) continue;
      const existing = this.admitted.get(key);
      // Keep the strongest provenance rather than the most recent one.
      if (!existing || sourceRank(source) > sourceRank(existing.source)) {
        this.admitted.set(key, { identifier: raw, source, receiptId });
      }
    }
  }

  isAdmitted(identifier: string, options: { requireObserved?: boolean } = {}): boolean {
    const key = normalizeIdentifier(identifier);
    const entry = this.admitted.get(key);
    return Boolean(entry && (!options.requireObserved || entry.source !== 'catalog'));
  }

  size(): number {
    return this.admitted.size;
  }

  entries(): AdmittedIdentifier[] {
    return [...this.admitted.values()];
  }

  /** The closest admitted identifier, when one is close enough to suggest. */
  nearestAdmitted(identifier: string): string | undefined {
    const needle = leafOf(identifier);
    let best: { identifier: string; distance: number } | undefined;
    for (const entry of this.admitted.values()) {
      const distance = editDistance(needle, leafOf(entry.identifier));
      if (!best || distance < best.distance) best = { identifier: entry.identifier, distance };
    }
    if (!best) return undefined;
    // Only suggest a genuine near-miss. A distant "correction" reads as a
    // confident wrong answer and sends the model further off course.
    const tolerance = Math.max(2, Math.floor(needle.length / 3));
    return best.distance <= tolerance ? best.identifier : undefined;
  }

  /**
   * Adjudicate the references a validator extracted from candidate SQL.
   *
   * Returns a report, never a throw: an unadmitted identifier is a correctable
   * observation to feed back into the loop, not a terminal refusal. That
   * distinction is the whole point — the old pipeline turned this into a
   * `grounding_gap` and stopped.
   */
  adjudicate(
    references: { relations?: readonly string[]; columns?: readonly string[] },
    options: { requireObserved?: boolean } = {},
  ): LedgerAdjudication {
    const unadmitted: string[] = [];
    const nearest: Record<string, string> = {};
    for (const reference of [...(references.relations ?? []), ...(references.columns ?? [])]) {
      if (!reference || this.isAdmitted(reference, options)) continue;
      if (unadmitted.includes(reference)) continue;
      unadmitted.push(reference);
      const suggestion = this.nearestAdmitted(reference);
      if (suggestion) nearest[reference] = suggestion;
    }
    return { ok: unadmitted.length === 0, unadmitted, nearest };
  }

  /** One line of feedback the model can act on directly. */
  static renderCorrection(adjudication: LedgerAdjudication): string | undefined {
    if (adjudication.ok) return undefined;
    const parts = adjudication.unadmitted.map((reference) => {
      const suggestion = adjudication.nearest[reference];
      return suggestion ? `${reference} (did you mean ${suggestion}?)` : reference;
    });
    return `These identifiers were never returned by a tool, so they cannot be executed: ${parts.join(', ')}. `
      + 'Use only names that appeared in a compile, preview, or schema result.';
  }
}

function sourceRank(source: IdentifierSource): number {
  switch (source) {
    case 'compiler': return 4;
    case 'preview': return 3;
    case 'schema_tool': return 2;
    case 'catalog': return 1;
    default: return 0;
  }
}
