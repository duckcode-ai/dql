/**
 * Governed HTML pages (RFC 0008 step 9).
 *
 * A canvas page is an HTML fragment an author or AI writes for layout and
 * wording. Data enters only through two elements:
 *
 *   <dql-value bind="tile.field"></dql-value>   one bound figure (story binding keys)
 *   <dql-tile tile="tileId"></dql-tile>         one tile, drawn by DQL
 *
 * The fragment is checked, not repaired: anything outside a small allowlist
 * (scripts, event handlers, links, images, forms, external URLs, CSS that
 * fetches) is refused with a reason, and so is a number written into the
 * text. The host fills the bindings with escaped values and shows the page in
 * a sandboxed frame with no scripts and no network, and draws the trust frame
 * outside it, so generated markup can neither fetch data nor fake a badge.
 * Browser-safe: no Node imports, no DOM.
 */
import { validateStoryText, type StoryBindingCatalog } from './story-bindings.js';

export const MAX_CANVAS_HTML = 60_000;
const MAX_DEPTH = 40;

const ALLOWED_TAGS = new Set([
  'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'div', 'span', 'p',
  'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'small', 'mark', 'br', 'hr',
  'blockquote', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'dl', 'dt', 'dd', 'style', 'dql-value', 'dql-tile',
]);
const VOID_TAGS = new Set(['br', 'hr']);
const GLOBAL_ATTRS = new Set(['class', 'id', 'style', 'title', 'role', 'lang', 'dir']);
const TAG_ATTRS: Record<string, Set<string>> = {
  'dql-value': new Set(['bind']),
  'dql-tile': new Set(['tile', 'height']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  td: new Set(['colspan', 'rowspan']),
  ol: new Set(['start', 'reversed']),
};
/** CSS that could fetch, run code or break out of the frame. */
const UNSAFE_CSS = /@import|url\s*\(|expression\s*\(|javascript:|behavior\s*:|-moz-binding|<\/?\s*style|@font-face|image-set\s*\(|src\s*\(/i;

export interface CanvasIssue {
  code: 'TOO_LONG' | 'UNSAFE_TAG' | 'UNSAFE_ATTRIBUTE' | 'UNSAFE_CSS' | 'MALFORMED' | 'NAKED_NUMBER' | 'UNKNOWN_BINDING' | 'UNKNOWN_TILE' | 'MISSING_BINDING';
  message: string;
}

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'open'; tag: string; attrs: Array<[string, string]>; selfClosing: boolean }
  | { kind: 'close'; tag: string };

const decode = (value: string) => value
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&amp;/g, '&');
export const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function tokenize(html: string, issues: CanvasIssue[]): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let rawStyle = false;
  while (index < html.length) {
    if (rawStyle) {
      const end = html.toLowerCase().indexOf('</style', index);
      const css = html.slice(index, end < 0 ? html.length : end);
      tokens.push({ kind: 'text', text: css });
      index = end < 0 ? html.length : end;
      rawStyle = false;
      continue;
    }
    const lt = html.indexOf('<', index);
    if (lt < 0) { tokens.push({ kind: 'text', text: decode(html.slice(index)) }); break; }
    if (lt > index) tokens.push({ kind: 'text', text: decode(html.slice(index, lt)) });
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    const match = /^<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/.exec(html.slice(lt));
    if (!match) {
      issues.push({ code: 'MALFORMED', message: `Could not read the markup near "${html.slice(lt, lt + 24)}".` });
      tokens.push({ kind: 'text', text: '<' });
      index = lt + 1;
      continue;
    }
    const tag = match[2]!.toLowerCase();
    if (match[1]) tokens.push({ kind: 'close', tag });
    else {
      const attrs: Array<[string, string]> = [];
      for (const attr of match[3]!.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
        attrs.push([attr[1]!.toLowerCase(), decode(attr[2] ?? attr[3] ?? attr[4] ?? '')]);
      }
      tokens.push({ kind: 'open', tag, attrs, selfClosing: Boolean(match[4]) || VOID_TAGS.has(tag) });
      if (tag === 'style' && !match[4]) rawStyle = true;
    }
    index = lt + match[0].length;
  }
  return tokens;
}

export interface CheckedCanvas {
  /** Canonical markup: re-serialized from the checked tokens. */
  html: string;
  bindings: string[];
  tiles: string[];
  issues: CanvasIssue[];
}

/**
 * Check a canvas fragment. With a catalog and tile ids, bindings and tiles
 * must also exist on the page. The returned `html` is only safe to use when
 * `issues` is empty.
 */
export function checkCanvasHtml(html: string, page?: { catalog?: StoryBindingCatalog; tileIds?: ReadonlySet<string> }): CheckedCanvas {
  const issues: CanvasIssue[] = [];
  if (html.length > MAX_CANVAS_HTML) issues.push({ code: 'TOO_LONG', message: `The page must be at most ${MAX_CANVAS_HTML} characters.` });
  const tokens = tokenize(html, issues);
  const out: string[] = [];
  const stack: string[] = [];
  const bindings = new Set<string>();
  const tiles = new Set<string>();
  const prose: string[] = [];
  for (const token of tokens) {
    if (token.kind === 'text') {
      if (stack.at(-1) === 'style') {
        if (UNSAFE_CSS.test(token.text)) issues.push({ code: 'UNSAFE_CSS', message: 'Styles may not load fonts, images or other files, or import other styles.' });
        out.push(token.text.replace(/<\/?\s*style/gi, ''));
      } else {
        if (stack.includes('dql-value') || stack.includes('dql-tile')) {
          if (token.text.trim()) issues.push({ code: 'MALFORMED', message: '<dql-value> and <dql-tile> must be empty; DQL fills them.' });
          continue;
        }
        prose.push(token.text);
        out.push(escapeHtml(token.text));
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(token.tag)) {
      issues.push({ code: 'UNSAFE_TAG', message: `<${token.tag}> is not allowed on a governed page. Use layout and text elements, <dql-value> and <dql-tile>.` });
      continue;
    }
    if (token.kind === 'close') {
      if (VOID_TAGS.has(token.tag)) continue;
      const at = stack.lastIndexOf(token.tag);
      if (at < 0) { issues.push({ code: 'MALFORMED', message: `</${token.tag}> closes nothing.` }); continue; }
      while (stack.length > at) out.push(`</${stack.pop()}>`);
      continue;
    }
    const allowed = TAG_ATTRS[token.tag];
    const kept: string[] = [];
    for (const [name, value] of token.attrs) {
      const ok = GLOBAL_ATTRS.has(name) || name.startsWith('aria-') || allowed?.has(name);
      if (!ok) {
        issues.push({ code: 'UNSAFE_ATTRIBUTE', message: `The ${name} attribute is not allowed${name.startsWith('on') ? ': pages cannot run code' : ''}.` });
        continue;
      }
      if (name === 'style' && UNSAFE_CSS.test(value)) { issues.push({ code: 'UNSAFE_CSS', message: 'Inline styles may not load files or run code.' }); continue; }
      if ((name === 'colspan' || name === 'rowspan' || name === 'start' || name === 'height') && !/^\d{1,4}$/.test(value)) {
        issues.push({ code: 'UNSAFE_ATTRIBUTE', message: `${name} must be a whole number.` });
        continue;
      }
      kept.push(value === '' && name === 'reversed' ? name : `${name}="${escapeHtml(value)}"`);
    }
    if (token.tag === 'dql-value') {
      const key = token.attrs.find(([name]) => name === 'bind')?.[1]?.trim();
      if (!key) issues.push({ code: 'MISSING_BINDING', message: '<dql-value> needs bind="…".' });
      else {
        bindings.add(key);
        if (page?.catalog && !page.catalog[key]) issues.push({ code: 'UNKNOWN_BINDING', message: `bind="${key}" is not a value on this page.` });
      }
    }
    if (token.tag === 'dql-tile') {
      const id = token.attrs.find(([name]) => name === 'tile')?.[1]?.trim();
      if (!id) issues.push({ code: 'MISSING_BINDING', message: '<dql-tile> needs tile="…".' });
      else {
        tiles.add(id);
        if (page?.tileIds && !page.tileIds.has(id)) issues.push({ code: 'UNKNOWN_TILE', message: `tile="${id}" is not a tile on this page.` });
      }
    }
    out.push(`<${token.tag}${kept.length ? ` ${kept.join(' ')}` : ''}>`);
    if (VOID_TAGS.has(token.tag)) continue;
    if (token.selfClosing) { out.push(`</${token.tag}>`); continue; }
    stack.push(token.tag);
    if (stack.length > MAX_DEPTH) { issues.push({ code: 'MALFORMED', message: `Elements nest more than ${MAX_DEPTH} deep.` }); break; }
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  for (const issue of validateStoryText(prose.join(' '))) {
    if (issue.code === 'NAKED_NUMBER') issues.push({ code: 'NAKED_NUMBER', message: `${issue.message.replace('Bind it with {{…}}', 'Use <dql-value bind="…"> instead')}` });
  }
  return { html: out.join(''), bindings: [...bindings], tiles: [...tiles], issues: dedupeIssues(issues) };
}

function dedupeIssues(issues: CanvasIssue[]): CanvasIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => (seen.has(issue.message) ? false : (seen.add(issue.message), true)));
}

/**
 * Fill a checked fragment: each <dql-value> becomes its escaped display
 * value, each <dql-tile> the markup DQL drew for it. Anything the run did
 * not return shows as a dash.
 */
export function fillCanvasHtml(checkedHtml: string, catalog: StoryBindingCatalog, drawTile: (tileId: string, height?: number) => string): string {
  return checkedHtml
    .replace(/<dql-value([^>]*)><\/dql-value>/g, (_, attrs: string) => {
      const key = decode(/bind="([^"]*)"/.exec(attrs)?.[1] ?? '');
      const binding = catalog[key];
      return binding
        ? `<span class="dql-value" title="${escapeHtml(binding.label)}">${escapeHtml(binding.display)}</span>`
        : `<span class="dql-value missing" title="${escapeHtml(`${key} is not in this run's results`)}">—</span>`;
    })
    .replace(/<dql-tile([^>]*)><\/dql-tile>/g, (_, attrs: string) => {
      const id = decode(/tile="([^"]*)"/.exec(attrs)?.[1] ?? '');
      const height = Number(/height="(\d+)"/.exec(attrs)?.[1]) || undefined;
      return `<div class="dql-tile" data-tile="${escapeHtml(id)}">${drawTile(id, height)}</div>`;
    });
}
