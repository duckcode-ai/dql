import { describe, expect, it } from 'vitest';
import { applyAppBuildDraftOperations, createAppBuildDraft } from './app-build-draft.js';
import { checkCanvasHtml, fillCanvasHtml } from './canvas-page.js';
import { parseDashboardDocument } from './dashboard-document.js';
import { buildStoryBindingCatalog } from './story-bindings.js';

const catalog = buildStoryBindingCatalog([
  { tileId: 'kpi', status: 'ok', result: { columns: ['revenue'], rows: [{ revenue: 145 }], columnsMeta: [{ name: 'revenue', kind: 'currency', unit: 'USD' }] } },
]);
const page = { catalog, tileIds: new Set(['kpi', 'trend']) };
const codes = (html: string) => checkCanvasHtml(html, page).issues.map((issue) => issue.code);

describe('governed HTML pages (RFC 0008 step 9)', () => {
  it('accepts layout, styles, bound values and tiles, and returns canonical markup', () => {
    const checked = checkCanvasHtml(
      '<style>.hero{display:grid;gap:12px;font-size:32px}</style><section class="hero" aria-label="Summary"><h1>Revenue <dql-value bind="kpi.revenue"/></h1><p>Up in Q1 2026 &amp; still rising.</p><dql-tile tile="trend" height="320"></dql-tile><br></section>',
      page,
    );
    expect(checked.issues).toEqual([]);
    expect(checked.bindings).toEqual(['kpi.revenue']);
    expect(checked.tiles).toEqual(['trend']);
    expect(checked.html).toBe('<style>.hero{display:grid;gap:12px;font-size:32px}</style><section class="hero" aria-label="Summary"><h1>Revenue <dql-value bind="kpi.revenue"></dql-value></h1><p>Up in Q1 2026 &amp; still rising.</p><dql-tile tile="trend" height="320"></dql-tile><br></section>');
  });

  it('refuses anything that could run code, fetch, or leave the page', () => {
    expect(codes('<script>alert(1)</script>')).toContain('UNSAFE_TAG');
    expect(codes('<div onclick="steal()">x</div>')).toContain('UNSAFE_ATTRIBUTE');
    expect(codes('<img src="https://evil.test/p.gif">')).toContain('UNSAFE_TAG');
    expect(codes('<a href="javascript:alert(1)">x</a>')).toContain('UNSAFE_TAG');
    expect(codes('<iframe src="/api/apps"></iframe>')).toContain('UNSAFE_TAG');
    expect(codes('<form action="/x"><input name="a"></form>')).toContain('UNSAFE_TAG');
    expect(codes('<style>@import url(https://evil.test/a.css)</style>')).toContain('UNSAFE_CSS');
    expect(codes('<div style="background:url(https://evil.test/x)">x</div>')).toContain('UNSAFE_CSS');
    expect(codes('<svg><script>x</script></svg>')).toContain('UNSAFE_TAG');
  });

  it('escapes text and attributes so nothing smuggled in becomes markup', () => {
    const smuggled = checkCanvasHtml('<p title="&quot;&gt;&lt;script&gt;x&lt;/script&gt;">&lt;script&gt;alert(one)&lt;/script&gt;</p>', page);
    expect(smuggled.issues).toEqual([]);
    expect(smuggled.html).not.toContain('<script');
    expect(smuggled.html).toContain('&lt;script&gt;');
    const split = checkCanvasHtml('<scr<script>ipt>alert(one)</scr</script>ipt>', page);
    expect(split.issues.map((issue) => issue.code)).toContain('UNSAFE_TAG');
    expect(split.html).not.toContain('<script');
  });

  it('refuses literal numbers and bindings or tiles that are not on the page', () => {
    expect(codes('<p>Revenue is $145, up 12%.</p>')).toEqual(['NAKED_NUMBER', 'NAKED_NUMBER']);
    expect(codes('<p><dql-value bind="kpi.nope"></dql-value></p>')).toEqual(['UNKNOWN_BINDING']);
    expect(codes('<dql-tile tile="ghost"></dql-tile>')).toEqual(['UNKNOWN_TILE']);
    expect(codes('<dql-value bind="kpi.revenue">145</dql-value>')).toContain('MALFORMED');
    expect(codes('<td colspan="two">x</td>')).toContain('UNSAFE_ATTRIBUTE');
  });

  it('fills bindings with escaped values and tiles with DQL-drawn markup', () => {
    const checked = checkCanvasHtml('<p><dql-value bind="kpi.revenue"></dql-value> <dql-value bind="kpi.gone"></dql-value></p><dql-tile tile="kpi"></dql-tile>');
    const filled = fillCanvasHtml(checked.html, catalog, (id) => `<svg data-id="${id}"></svg>`);
    expect(filled).toBe('<p><span class="dql-value" title="kpi — revenue">$145</span> <span class="dql-value missing" title="kpi.gone is not in this run&#39;s results">—</span></p><div class="dql-tile" data-tile="kpi"><svg data-id="kpi"></svg></div>');
  });

  it('stores a checked canvas in the page file and refuses unsafe markup in drafts', () => {
    const doc = {
      version: 1, id: 'overview', metadata: { title: 'Overview' },
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [{ i: 'kpi', x: 0, y: 0, w: 4, h: 2, block: { blockId: 'kpi' }, viz: { type: 'kpi' } }] },
      narrative: { version: 1, presentation: 'canvas', blocks: [] },
      canvas: { version: 1, html: '<h1>Revenue <dql-value bind="kpi.revenue"/></h1>', generatedBy: 'ai', model: 'qwen3.8:27b' },
    };
    const parsed = parseDashboardDocument(JSON.stringify(doc));
    expect(parsed.errors).toEqual([]);
    expect(parsed.document?.canvas?.html).toBe('<h1>Revenue <dql-value bind="kpi.revenue"></dql-value></h1>');
    expect(parseDashboardDocument(JSON.stringify({ ...doc, canvas: { version: 1, html: '<script>x</script>' } })).errors.map((error) => error.message).join(' ')).toContain('<script> is not allowed');

    const draft = createAppBuildDraft({ id: 'canvas-draft', appId: 'canvas-app', authoringMode: 'manual', frame: { goal: 'Explain revenue', metrics: [], dimensions: [], filters: [] } });
    const withPage = applyAppBuildDraftOperations(draft, draft.revision, [{ type: 'upsert_page', page: { ...(parsed.document as object), canvas: undefined, narrative: undefined } as never }]);
    const withCanvas = applyAppBuildDraftOperations(withPage, withPage.revision, [{ type: 'set_canvas', pageId: 'overview', canvas: doc.canvas as never }]);
    expect(withCanvas.pages[0]!.canvas?.model).toBe('qwen3.8:27b');
    expect(() => applyAppBuildDraftOperations(withCanvas, withCanvas.revision, [{ type: 'set_canvas', pageId: 'overview', canvas: { version: 1, html: '<p onclick="x()">We sold 42.</p>' } }])).toThrow(/not allowed|number written/);
  });
});
