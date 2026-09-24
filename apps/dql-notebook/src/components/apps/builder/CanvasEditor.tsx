import { useEffect, useState, type ReactNode } from 'react';
import { checkCanvasHtml } from '@duckcodeailabs/dql-core/apps/canvas-page';
import type { StoryBindingCatalog } from '@duckcodeailabs/dql-core/apps/story-bindings';
import type { DashboardCanvasV1 } from '../../../api/client';

/**
 * Studio's governed HTML page editor (RFC 0008 step 9). Design shows the
 * page as readers see it; Code shows the markup, checked as the author
 * types. Markup that fails the check is never saved.
 */
export function CanvasEditor({
  canvas,
  catalog,
  pageTiles,
  disabled,
  preview,
  onChange,
  onDraft,
  drafting,
  draftBlockedReason,
}: {
  canvas: DashboardCanvasV1 | undefined;
  catalog: StoryBindingCatalog;
  pageTiles: Array<{ tileId: string; title: string }>;
  disabled: boolean;
  /** Renders a canvas the way readers see it. */
  preview: (canvas: DashboardCanvasV1) => ReactNode;
  onChange: (canvas: DashboardCanvasV1) => void;
  onDraft: (instruction: string) => void;
  drafting: boolean;
  draftBlockedReason?: string | null;
}): JSX.Element {
  const [tab, setTab] = useState<'design' | 'code'>('design');
  const [html, setHtml] = useState(canvas?.html ?? '');
  const [instruction, setInstruction] = useState('');
  useEffect(() => setHtml(canvas?.html ?? ''), [canvas?.html]);
  const tileIds = new Set(pageTiles.map((tile) => tile.tileId));
  const checked = checkCanvasHtml(html, { catalog, tileIds });
  // Unknown bindings show as a dash until the page returns them; everything else blocks saving.
  const blocking = checked.issues.filter((issue) => issue.code !== 'UNKNOWN_BINDING');
  const save = () => {
    if (!html.trim() || blocking.length || html === canvas?.html) return;
    onChange({ version: 1, html, generatedBy: 'author' });
  };
  const startFromTemplate = () => {
    const figures = Object.values(catalog).filter((binding) => binding.kind === 'number' && !binding.key.includes('[')).slice(0, 3);
    const next = [
      '<style>.page{display:grid;gap:20px}.band{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.figure{padding:14px;border:1px solid var(--dql-line);border-radius:12px;background:var(--dql-surface)}.figure strong{display:block;font-size:24px}</style>',
      '<article class="page">',
      '<h1>Headline</h1>',
      figures.length ? `<section class="band">${figures.map((binding) => `<div class="figure"><small>${binding.label.replace(/[<>&"]/g, '').replace(/\S*\d\S*/g, '')}</small><strong><dql-value bind="${binding.key}"></dql-value></strong></div>`).join('')}</section>` : '',
      ...pageTiles.slice(0, 3).map((tile) => `<dql-tile tile="${tile.tileId}"></dql-tile>`),
      '</article>',
    ].join('\n');
    setHtml(next);
    setTab('code');
    if (checkCanvasHtml(next).issues.length === 0) onChange({ version: 1, html: next, generatedBy: 'author' });
  };
  return (
    <div className="studio-canvas-editor">
      <section className="studio-story-draft" aria-label="Design the layout with AI">
        <input
          aria-label="What should the layout show?"
          placeholder="Optional: what should the page show, and for whom?"
          value={instruction}
          disabled={disabled || drafting}
          onChange={(event) => setInstruction(event.target.value)}
        />
        <button type="button" className="primary" disabled={disabled || drafting || Boolean(draftBlockedReason)} onClick={() => onDraft(instruction.trim())}>
          {drafting ? 'Designing…' : canvas ? 'Redesign layout with AI' : 'Design layout with AI'}
        </button>
        <small className="field-help">{draftBlockedReason ?? 'The model designs layout and wording only: data comes in through bound values and DQL-drawn tiles, and every draft is checked (no scripts, no network, no typed-in figures). A local model can take a few minutes.'}</small>
      </section>
      <div className="studio-canvas-tabs" role="tablist" aria-label="Layout view">
        <button type="button" role="tab" aria-selected={tab === 'design'} className={tab === 'design' ? 'on' : ''} onClick={() => setTab('design')}>Design</button>
        <button type="button" role="tab" aria-selected={tab === 'code'} className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}>HTML (advanced)</button>
        {!canvas && !html ? <button type="button" className="studio-canvas-template" disabled={disabled} onClick={startFromTemplate}>Start from a template</button> : null}
      </div>
      {tab === 'design'
        ? (html.trim() && blocking.length === 0
          ? preview({ version: 1, html, ...(canvas?.generatedBy ? { generatedBy: canvas.generatedBy } : {}), ...(canvas?.model ? { model: canvas.model } : {}) })
          : <p className="studio-story-empty">{html.trim() ? 'The HTML has problems; open HTML (advanced) to fix them.' : 'No layout yet. Design it with AI, or start from a template.'}</p>)
        : <div className="studio-canvas-code">
          <textarea aria-label="Page markup" spellCheck={false} disabled={disabled} value={html} onChange={(event) => setHtml(event.target.value)} onBlur={save} />
          <p className="field-help">Show figures with <code>{'<dql-value bind="…"></dql-value>'}</code> and tiles with <code>{'<dql-tile tile="…"></dql-tile>'}</code>. Values on this page: {Object.keys(catalog).length}; tiles: {pageTiles.map((tile) => tile.tileId).join(', ') || 'none'}.</p>
          {checked.issues.length ? (
            <ul className="studio-story-issues" role="alert">
              {checked.issues.slice(0, 8).map((issue, index) => <li key={index} className={issue.code === 'UNKNOWN_BINDING' ? 'warn' : ''}>{issue.message}</li>)}
            </ul>
          ) : <p className="field-help">Checked: safe to publish.</p>}
        </div>}
    </div>
  );
}
