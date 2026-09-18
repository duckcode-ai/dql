import type { AppStudioBuildDraft, AppStudioDraftOperation } from '../../../api/client';

type Page = AppStudioBuildDraft['pages'][number];
type Tile = Page['layout']['items'][number];

export type ProposedTileChange = 'unchanged' | 'added' | 'updated' | 'removed';

export type ProposedPage = {
  id: string;
  title: string;
  /** True when the page itself does not exist in the draft yet. */
  isNew: boolean;
  items: Array<{ tile: Tile; change: ProposedTileChange; before?: Tile }>;
  /** Tiles whose click behaviour the proposal changes (cross-filter or navigation). */
  linkedTileIds: Set<string>;
  changeCount: number;
};

/**
 * What an AI proposal would do to each page, computed in the browser from its
 * typed operations so the Studio can draw the proposal on the canvas before
 * anything is saved. It mirrors only what the canvas shows (tiles and links);
 * the server's reducer stays the authority when the proposal is applied.
 */
export function projectProposal(pages: Page[], operations: AppStudioDraftOperation[]): ProposedPage[] {
  const working = new Map<string, Page>(pages.map((page) => [page.id, structuredCloneSafe(page)]));
  const order = pages.map((page) => page.id);
  const touchedLinks = new Map<string, Set<string>>();
  for (const operation of operations) {
    switch (operation.type) {
      case 'upsert_page': {
        if (!working.has(operation.page.id)) order.push(operation.page.id);
        working.set(operation.page.id, structuredCloneSafe(operation.page));
        break;
      }
      case 'remove_page':
        working.delete(operation.pageId);
        break;
      case 'add_tile': {
        const page = working.get(operation.pageId);
        if (page) page.layout = { ...page.layout, items: [...page.layout.items.filter((item) => item.i !== operation.tile.i), operation.tile] };
        break;
      }
      case 'update_tile': {
        const page = working.get(operation.pageId);
        if (page) page.layout = { ...page.layout, items: page.layout.items.map((item) => item.i === operation.tileId ? { ...item, ...operation.patch } as Tile : item) };
        break;
      }
      case 'remove_tile': {
        const page = working.get(operation.pageId);
        if (page) page.layout = { ...page.layout, items: page.layout.items.filter((item) => item.i !== operation.tileId) };
        break;
      }
      case 'set_layout': {
        const page = working.get(operation.pageId);
        if (page) page.layout = operation.layout;
        break;
      }
      case 'set_interactions': {
        const page = working.get(operation.pageId);
        if (!page) break;
        const before = interactionSources(page.interactions);
        page.interactions = operation.interactions;
        const after = interactionSources(operation.interactions);
        const changed = touchedLinks.get(page.id) ?? new Set<string>();
        for (const tileId of after) if (!before.has(tileId) || changedLinkTarget(pages.find((item) => item.id === page.id)?.interactions, operation.interactions, tileId)) changed.add(tileId);
        touchedLinks.set(page.id, changed);
        break;
      }
      default:
        break;
    }
  }
  const original = new Map(pages.map((page) => [page.id, page]));
  return order.filter((id) => working.has(id)).map((id) => {
    const page = working.get(id)!;
    const before = original.get(id);
    const beforeTiles = new Map((before?.layout.items ?? []).map((tile) => [tile.i, tile]));
    const afterIds = new Set(page.layout.items.map((tile) => tile.i));
    const items: ProposedPage['items'] = [...page.layout.items]
      .sort((left, right) => left.y - right.y || left.x - right.x)
      .map((tile) => {
        const prior = beforeTiles.get(tile.i);
        if (!prior) return { tile, change: 'added' as const };
        return tileContentChanged(prior, tile) ? { tile, change: 'updated' as const, before: prior } : { tile, change: 'unchanged' as const };
      });
    for (const [tileId, tile] of beforeTiles) if (!afterIds.has(tileId)) items.push({ tile, change: 'removed' });
    const linkedTileIds = touchedLinks.get(id) ?? new Set<string>();
    return {
      id,
      title: page.metadata.title,
      isNew: !before,
      items,
      linkedTileIds,
      changeCount: items.filter((item) => item.change !== 'unchanged').length + linkedTileIds.size,
    };
  });
}

function tileContentChanged(before: Tile, after: Tile): boolean {
  const pick = (tile: Tile) => JSON.stringify({ title: tile.title, query: tile.query, viz: tile.viz, text: tile.text, sourceId: tile.sourceId, block: tile.block, semantic: tile.semantic, w: tile.w, h: tile.h });
  return pick(before) !== pick(after);
}

function interactionSources(interactions: Page['interactions'] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const mapping of interactions?.crossFilter?.mappings ?? []) if (mapping.fromTileId) ids.add(mapping.fromTileId);
  for (const navigation of interactions?.navigate ?? []) if (navigation.fromTile) ids.add(navigation.fromTile);
  return ids;
}

function changedLinkTarget(before: Page['interactions'] | undefined, after: Page['interactions'] | undefined, tileId: string): boolean {
  const pick = (interactions: Page['interactions'] | undefined) => JSON.stringify([
    (interactions?.crossFilter?.mappings ?? []).filter((mapping) => mapping.fromTileId === tileId),
    (interactions?.navigate ?? []).filter((navigation) => navigation.fromTile === tileId),
  ]);
  return pick(before) !== pick(after);
}

function structuredCloneSafe<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)) as T;
}
