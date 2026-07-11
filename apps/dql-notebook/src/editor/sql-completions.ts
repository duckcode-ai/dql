import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";

type RankedCompletion = {
  type: string;
  name: string;
  label: string;
  description?: string;
  detail?: string;
  relation?: string;
  governance?: string;
  apply?: string;
};

const cache = new Map<
  string,
  { expiresAt: number; items: RankedCompletion[] }
>();

async function ranked(
  kind: string,
  query: string,
  relation?: string,
): Promise<RankedCompletion[]> {
  const key = `${kind}:${relation ?? ""}:${query}`.toLowerCase();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.items;
  const params = new URLSearchParams({ kind, q: query, limit: "60" });
  if (relation) params.set("relation", relation);
  const response = await fetch(
    `${window.location.origin}/api/editor/completions?${params}`,
  );
  if (!response.ok) return [];
  const payload = (await response.json()) as {
    completions?: RankedCompletion[];
  };
  const items = Array.isArray(payload.completions) ? payload.completions : [];
  cache.set(key, { items, expiresAt: Date.now() + 20_000 });
  return items;
}

export const rankedSqlCompletionSource: CompletionSource = async (
  context: CompletionContext,
): Promise<CompletionResult | null> => {
  const before = context.state.sliceDoc(0, context.pos);
  const relationMatch = /\b(?:from|join)\s+([\w."-]*)$/i.exec(before);
  if (relationMatch) {
    const query = relationMatch[1].replace(/^"/, "");
    const items = await ranked("relation", query);
    return completionResult(context.pos - relationMatch[1].length, items);
  }

  const propertyMatch = /([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)?$/.exec(before);
  if (propertyMatch) {
    const alias = propertyMatch[1];
    const query = propertyMatch[2] ?? "";
    const relation = relationForAlias(before, alias) ?? alias;
    const items = await ranked("column", query, relation.replace(/^"|"$/g, ""));
    return completionResult(context.pos - query.length, items);
  }

  const word = context.matchBefore(/[A-Za-z_][\w]*$/);
  if (context.explicit && word) {
    const items = await ranked("column", word.text);
    return completionResult(word.from, items);
  }
  return null;
};

function completionResult(
  from: number,
  items: RankedCompletion[],
): CompletionResult {
  return {
    from,
    options: items.map((item) => ({
      label: item.label || item.name,
      apply: item.apply ?? item.name,
      detail: [item.detail, item.relation, item.governance]
        .filter(Boolean)
        .join(" · "),
      info: item.description,
      type:
        item.type === "column"
          ? "property"
          : item.type === "dataset"
            ? "class"
            : "variable",
      boost:
        item.governance === "semantic" ||
        item.governance === "project_controlled"
          ? 20
          : 0,
    })),
    validFor: /^[\w."-]*$/,
  };
}

function relationForAlias(sql: string, alias: string): string | undefined {
  const matcher = new RegExp(
    `\\b(?:from|join)\\s+([\\w."-]+)(?:\\s+(?:as\\s+)?${escapeRegExp(alias)})\\b`,
    "i",
  );
  return matcher.exec(sql)?.[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
