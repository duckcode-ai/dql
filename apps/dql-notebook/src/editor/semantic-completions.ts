import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { api } from '../api/client';

type SemanticCompletionItem = {
  type: 'metric' | 'dimension';
  name: string;
  label: string;
  description: string;
  sql: string;
  domain?: string;
  tags: string[];
};

const COMPLETION_TTL_MS = 30_000;
export const SEMANTIC_REF_MIME = 'application/dql-semantic-ref';

let cachedItems: SemanticCompletionItem[] = [];
let cacheExpiresAt = 0;
let activeEditor: EditorView | null = null;

function notifySemanticUsage(name: string): void {
  void api.trackUsage(name);
  window.dispatchEvent(new CustomEvent('dql:semantic-used', { detail: { name } }));
}

async function loadSemanticCompletions(): Promise<SemanticCompletionItem[]> {
  if (Date.now() < cacheExpiresAt && cachedItems.length > 0) {
    return cachedItems;
  }

  const response = await fetch(`${window.location.origin}/api/semantic-completions`);
  if (!response.ok) {
    throw new Error(`Failed to load semantic completions: HTTP ${response.status}`);
  }
  const data = (await response.json()) as { completions?: SemanticCompletionItem[] };
  cachedItems = Array.isArray(data.completions) ? data.completions : [];
  cacheExpiresAt = Date.now() + COMPLETION_TTL_MS;
  return cachedItems;
}

function buildSemanticReference(type: 'metric' | 'dimension', name: string): string {
  return type === 'metric' ? `@metric(${name})` : `@dim(${name})`;
}

function insertIntoView(view: EditorView, reference: string, position?: number): void {
  const from = position ?? view.state.selection.main.from;
  view.dispatch({
    changes: { from, to: position ?? view.state.selection.main.to, insert: reference },
    selection: { anchor: from + reference.length },
  });
  view.focus();
}

export function setActiveSemanticEditor(view: EditorView): void {
  activeEditor = view;
}

export function clearActiveSemanticEditor(view: EditorView): void {
  if (activeEditor === view) {
    activeEditor = null;
  }
}

export function insertSemanticReference(reference: string): boolean {
  if (!activeEditor) return false;
  insertIntoView(activeEditor, reference);
  return true;
}

export function insertSemanticReferenceAtCoords(
  view: EditorView,
  reference: string,
  coords?: { x: number; y: number },
): void {
  const position = coords ? view.posAtCoords(coords) ?? view.state.selection.main.from : view.state.selection.main.from;
  insertIntoView(view, reference, position);
}

function buildItemCompletion(
  item: SemanticCompletionItem,
  from: number,
  to: number,
): Completion {
  return {
    label: item.name,
    detail: item.type === 'metric' ? '@metric' : '@dim',
    type: item.type === 'metric' ? 'function' : 'variable',
    info: `${item.label}${item.description ? `\n${item.description}` : ''}${item.sql ? `\n${item.sql}` : ''}`,
    apply(view) {
      const nextChar = view.state.sliceDoc(to, to + 1);
      const insert = nextChar === ')' ? item.name : `${item.name})`;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
      });
      notifySemanticUsage(item.name);
    },
  };
}

function buildWrapperCompletions(from: number): CompletionResult {
  return {
    from,
    options: [
      {
        label: '@metric(',
        detail: 'semantic metric',
        type: 'function',
        apply(view, _completion, applyFrom, applyTo) {
          view.dispatch({
            changes: { from: applyFrom, to: applyTo, insert: '@metric(' },
            selection: { anchor: applyFrom + '@metric('.length },
          });
        },
      },
      {
        label: '@dim(',
        detail: 'semantic dimension',
        type: 'function',
        apply(view, _completion, applyFrom, applyTo) {
          view.dispatch({
            changes: { from: applyFrom, to: applyTo, insert: '@dim(' },
            selection: { anchor: applyFrom + '@dim('.length },
          });
        },
      },
    ],
  };
}

export const semanticCompletionSource: CompletionSource = async (
  context: CompletionContext,
): Promise<CompletionResult | null> => {
  const { state, pos } = context;
  const before = state.sliceDoc(Math.max(0, pos - 120), pos);

  const metricMatch = /@metric\(([^)]*)$/i.exec(before);
  if (metricMatch) {
    const query = metricMatch[1].trim().toLowerCase();
    const from = pos - metricMatch[1].length;
    const items = (await loadSemanticCompletions())
      .filter((item) => item.type === 'metric')
      .filter((item) =>
        !query ||
        item.name.toLowerCase().includes(query) ||
        item.label.toLowerCase().includes(query) ||
        (item.domain ?? '').toLowerCase().includes(query) ||
        item.tags.some((tag) => tag.toLowerCase().includes(query)),
      )
      .slice(0, 50);
    return {
      from,
      options: items.map((item) => buildItemCompletion(item, from, pos)),
      validFor: /^[\w-]*$/,
    };
  }

  const dimensionMatch = /@dim\(([^)]*)$/i.exec(before);
  if (dimensionMatch) {
    const query = dimensionMatch[1].trim().toLowerCase();
    const from = pos - dimensionMatch[1].length;
    const items = (await loadSemanticCompletions())
      .filter((item) => item.type === 'dimension')
      .filter((item) =>
        !query ||
        item.name.toLowerCase().includes(query) ||
        item.label.toLowerCase().includes(query) ||
        (item.domain ?? '').toLowerCase().includes(query) ||
        item.tags.some((tag) => tag.toLowerCase().includes(query)),
      )
      .slice(0, 50);
    return {
      from,
      options: items.map((item) => buildItemCompletion(item, from, pos)),
      validFor: /^[\w-]*$/,
    };
  }

  const wrapperMatch = /@([md][a-z_]*)?$/i.exec(before);
  if (wrapperMatch) {
    return buildWrapperCompletions(pos - wrapperMatch[0].length);
  }

  if (!context.explicit) return null;
  return null;
};

export function serializeSemanticDragRef(type: 'metric' | 'dimension', name: string): string {
  return JSON.stringify({ type, name, reference: buildSemanticReference(type, name) });
}

export function parseSemanticDragRef(raw: string | null): { type: 'metric' | 'dimension'; name: string; reference: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { type?: 'metric' | 'dimension'; name?: string; reference?: string };
    if ((parsed.type === 'metric' || parsed.type === 'dimension') && parsed.name && parsed.reference) {
      return {
        type: parsed.type,
        name: parsed.name,
        reference: parsed.reference,
      };
    }
    return null;
  } catch {
    return null;
  }
}
