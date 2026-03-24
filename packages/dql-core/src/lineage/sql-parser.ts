/**
 * Lightweight SQL table extractor for lineage analysis.
 *
 * Extracts table references from SQL statements without a full AST parser.
 * Handles FROM, JOIN, subqueries, and CTEs. Filters out CTE names so only
 * external table dependencies are returned.
 */

export interface SqlParseResult {
  /** External table dependencies (CTEs excluded) */
  tables: string[];
  /** CTE names defined in this query */
  ctes: string[];
  /** ref() calls found in the SQL */
  refs: string[];
}

/**
 * Extract table references from a SQL string.
 *
 * Identifies tables in FROM and JOIN clauses, filters out CTE definitions,
 * and detects ref("block_name") calls.
 */
export function extractTablesFromSql(sql: string): SqlParseResult {
  const ctes = extractCteNames(sql);

  // Strip comments first (refs inside comments should be ignored)
  const noComments = stripComments(sql);

  // Strip non-ref string literals, then extract refs from the result.
  // This ensures ref("block") and ref('block') are preserved, but
  // 'ref("fake")' (a string literal containing ref) is stripped.
  const withoutStringLiterals = stripStringLiterals(noComments);
  const refs = extractRefs(withoutStringLiterals);

  // For table extraction, use the fully cleaned version
  const cleaned = withoutStringLiterals;

  const rawTables = new Set<string>();

  // FROM <table> — handles FROM table, FROM schema.table, FROM "table"
  const fromPattern = /\bFROM\s+(?:LATERAL\s+)?([a-zA-Z_][a-zA-Z0-9_.]*|"[^"]+")/gi;
  for (const match of cleaned.matchAll(fromPattern)) {
    addTableRef(rawTables, match[1]);
  }

  // JOIN <table> — all join types
  const joinPattern = /\bJOIN\s+(?:LATERAL\s+)?([a-zA-Z_][a-zA-Z0-9_.]*|"[^"]+")/gi;
  for (const match of cleaned.matchAll(joinPattern)) {
    addTableRef(rawTables, match[1]);
  }

  // INTO <table> (INSERT INTO, MERGE INTO)
  const intoPattern = /\bINTO\s+([a-zA-Z_][a-zA-Z0-9_.]*|"[^"]+")/gi;
  for (const match of cleaned.matchAll(intoPattern)) {
    addTableRef(rawTables, match[1]);
  }

  // Filter out CTEs, SQL keywords that might match, and DuckDB functions
  const sqlKeywords = new Set([
    'select', 'where', 'group', 'order', 'having', 'limit', 'offset',
    'union', 'except', 'intersect', 'values', 'set', 'lateral',
    'unnest', 'generate_series', 'read_csv_auto', 'read_csv', 'read_parquet',
    'read_json', 'read_json_auto', 'range', 'information_schema', 'ref',
  ]);

  const cteNamesLower = new Set(ctes.map((c) => c.toLowerCase()));

  const tables = [...rawTables].filter((t) => {
    const lower = t.toLowerCase();
    return !cteNamesLower.has(lower) && !sqlKeywords.has(lower);
  });

  return { tables, ctes, refs };
}

/** Extract CTE names from WITH ... AS (...) patterns */
function extractCteNames(sql: string): string[] {
  const ctes: string[] = [];
  // Match WITH ... AS and recursive WITH
  const withPattern = /\bWITH\s+(?:RECURSIVE\s+)?/gi;
  const withMatch = withPattern.exec(sql);
  if (!withMatch) return ctes;

  // From the WITH keyword, extract comma-separated CTE definitions
  const afterWith = sql.slice(withMatch.index + withMatch[0].length);
  const cteDefPattern = /([a-zA-Z_][a-zA-Z0-9_]*)\s+AS\s*\(/gi;

  for (const match of afterWith.matchAll(cteDefPattern)) {
    ctes.push(match[1]);
  }

  return ctes;
}

/** Extract ref("block_name") calls from SQL */
function extractRefs(sql: string): string[] {
  const refs: string[] = [];
  const refPattern = /\bref\s*\(\s*["']([^"']+)["']\s*\)/gi;
  for (const match of sql.matchAll(refPattern)) {
    refs.push(match[1]);
  }
  return refs;
}

/** Strip comments only */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/**
 * Strip single-quoted string literals, but preserve those inside ref() calls.
 * This ensures ref('block_name') works, while 'ref("fake")' is stripped.
 */
function stripStringLiterals(sql: string): string {
  // First, temporarily protect ref() arguments by replacing them with placeholders
  const refArgs: string[] = [];
  const withPlaceholders = sql.replace(
    /\bref\s*\(\s*'([^']*)'\s*\)/gi,
    (_match, arg: string) => {
      refArgs.push(arg);
      return `ref("__REF_PLACEHOLDER_${refArgs.length - 1}__")`;
    },
  );
  // Strip all remaining single-quoted strings
  const stripped = withPlaceholders.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  // Restore ref() arguments
  return stripped.replace(
    /ref\("__REF_PLACEHOLDER_(\d+)__"\)/g,
    (_match, idx: string) => `ref('${refArgs[parseInt(idx)]}')`
  );
}

/** Normalize and add a table reference */
function addTableRef(tables: Set<string>, ref: string): void {
  // Remove surrounding quotes
  const cleaned = ref.replace(/^"|"$/g, '');
  if (cleaned.length > 0) {
    tables.add(cleaned);
  }
}
