import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

async function proposedTileCard() {
  // The card imports the API client, which reads window.location at load.
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3000' } });
  return (await import('./ProposedTile')).ProposedTileCard;
}

const tile = {
  i: 'orders-kpi', x: 0, y: 4, w: 3, h: 2,
  viz: { type: 'kpi' }, title: 'Order count', sourceId: 'app:block:commerce:orders',
} as never;

describe('ProposedTileCard (RFC 0008 per-tile accept)', () => {
  it('offers a Keep checkbox only for tiles the author may decline', async () => {
    const ProposedTileCard = await proposedTileCard();
    const declinable = renderToStaticMarkup(
      <ProposedTileCard tile={tile} change="added" columns={12} themeMode="paper" kept onToggleKept={() => undefined} />,
    );
    expect(declinable).toContain('class="proposal-keep"');
    expect(declinable).toContain('aria-label="Keep Order count"');
    expect(declinable).toMatch(/type="checkbox"[^>]*checked/);

    const fixed = renderToStaticMarkup(<ProposedTileCard tile={tile} change="added" columns={12} themeMode="paper" />);
    expect(fixed).not.toContain('proposal-keep');
  });

  it('marks a declined tile as skipped and unchecked', async () => {
    const ProposedTileCard = await proposedTileCard();
    const skipped = renderToStaticMarkup(
      <ProposedTileCard tile={tile} change="added" columns={12} themeMode="paper" kept={false} onToggleKept={() => undefined} />,
    );
    expect(skipped).toContain('proposal-tile added skipped');
    expect(skipped).not.toMatch(/type="checkbox"[^>]*checked/);
  });
});
