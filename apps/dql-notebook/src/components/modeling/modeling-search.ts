export interface ModelingSearchOption {
  value: string;
  label: string;
  description?: string;
  keywords?: string[];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Deterministic, bounded ranking for project-sized modeling pickers.
 * Exact and prefix matches beat token matches; callers never render the full
 * catalog even when an enterprise manifest contains thousands of objects.
 */
export function rankModelingOptions(
  options: ModelingSearchOption[],
  query: string,
  limit = 50,
): ModelingSearchOption[] {
  const normalizedQuery = normalize(query);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  return options
    .map((option) => {
      const label = normalize(option.label);
      const value = normalize(option.value);
      const description = normalize(option.description ?? '');
      const keywords = normalize(option.keywords?.join(' ') ?? '');
      const haystack = `${label} ${value} ${description} ${keywords}`;
      if (tokens.length && !tokens.every((token) => haystack.includes(token))) return null;
      let score = 0;
      if (normalizedQuery) {
        if (label === normalizedQuery || value === normalizedQuery) score += 1000;
        if (label.startsWith(normalizedQuery)) score += 500;
        if (value.startsWith(normalizedQuery)) score += 350;
        if (label.includes(normalizedQuery)) score += 200;
        score += tokens.reduce((total, token) => total + (label.startsWith(token) ? 80 : label.includes(token) ? 40 : 10), 0);
      }
      return { option, score };
    })
    .filter((entry): entry is { option: ModelingSearchOption; score: number } => Boolean(entry))
    .sort((a, b) => b.score - a.score || a.option.label.localeCompare(b.option.label) || a.option.value.localeCompare(b.option.value))
    .slice(0, Math.max(1, limit))
    .map(({ option }) => option);
}
