/** Match `{{name}}` dataframe handles in SQL/markdown cell content. */
export const HANDLE_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

export function findHandleNames(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(HANDLE_RE)) out.add(m[1]);
  return [...out];
}
