import type { AppBlockRecommendation, AppStudioBuildDraft } from '../../api/client';

type StudioPage = AppStudioBuildDraft['pages'][number];
type StudioTile = StudioPage['layout']['items'][number];

export type StudioFilterTileMapping = {
  key: string;
  pageId: string;
  pageTitle: string;
  tileId: string;
  tileTitle: string;
  sourceName: string;
  supported: boolean;
  binding?: string;
  mode?: 'parameter' | 'predicate' | 'semantic';
  reason?: string;
};

export type StudioFilterCandidate = {
  id: string;
  sourceNames: string[];
  affectedTileCount: number;
  pageCount: number;
};

/**
 * Filters are authored only from fields already exposed by a governed source.
 * This gives App Studio a Power BI/Tableau-style field picker without turning
 * arbitrary result columns into an unreviewed SQL contract.
 */
export function discoverAppFilterCandidates(
  pages: StudioPage[],
  catalog: AppBlockRecommendation[],
): StudioFilterCandidate[] {
  const fieldIds = new Set<string>();
  for (const page of pages) {
    for (const filter of page.filters ?? []) {
      const fieldId = filter.field?.name ?? filter.bindsTo ?? filter.id;
      if (fieldId) fieldIds.add(fieldId);
    }
    for (const tile of dataTiles(page)) {
      for (const fieldId of governedFieldsForTile(tile, catalog)) fieldIds.add(fieldId);
      for (const binding of tile.filterBindings ?? []) {
        if (binding.binding && binding.capability !== 'unsupported') fieldIds.add(binding.binding);
      }
    }
  }
  return [...fieldIds]
    .map((id) => {
      const mappings = filterTileMappingsForField(pages, catalog, id).filter((mapping) => mapping.supported);
      return {
        id,
        sourceNames: [...new Set(mappings.map((mapping) => mapping.sourceName))].sort(),
        affectedTileCount: mappings.length,
        pageCount: new Set(mappings.map((mapping) => mapping.pageId)).size,
      };
    })
    .filter((candidate) => candidate.affectedTileCount > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function discoverPageFilterCandidates(
  page: StudioPage | null,
  catalog: AppBlockRecommendation[],
): StudioFilterCandidate[] {
  return page ? discoverAppFilterCandidates([page], catalog) : [];
}

/** Returns every data component, including explicit incompatibility reasons. */
export function filterTileMappingsForField(
  pages: StudioPage[],
  catalog: AppBlockRecommendation[],
  fieldId: string,
): StudioFilterTileMapping[] {
  return pages.flatMap((page) => dataTiles(page).map((tile) => {
    const fields = governedFieldsForTile(tile, catalog);
    const existing = (tile.filterBindings ?? []).find((binding) =>
      binding.filter === fieldId || binding.binding === fieldId,
    );
    const supported = fields.includes(fieldId)
      || Boolean(existing?.binding === fieldId && existing.capability !== 'unsupported');
    const sourceName = sourceNameForTile(tile, catalog);
    return {
      key: studioFilterMappingKey(page.id, tile.i),
      pageId: page.id,
      pageTitle: page.metadata.title,
      tileId: tile.i,
      tileTitle: tile.title || tile.i,
      sourceName,
      supported,
      ...(supported ? {
        binding: fieldId,
        mode: tile.semantic ? 'semantic' as const : existing?.mode ?? 'predicate' as const,
      } : {
        reason: `${fieldId.replace(/_/g, ' ')} is not exposed by ${sourceName}.`,
      }),
    };
  }));
}

export function studioFilterMappingKey(pageId: string, tileId: string): string {
  return `${pageId}:${tileId}`;
}

function dataTiles(page: StudioPage): StudioTile[] {
  return page.layout.items.filter((tile) => Boolean(tile.block || tile.semantic || tile.draftAnalysis));
}

function governedFieldsForTile(tile: StudioTile, catalog: AppBlockRecommendation[]): string[] {
  const blockId = tile.block ? ('blockId' in tile.block ? tile.block.blockId : tile.block.ref) : null;
  const source = blockId ? catalog.find((item) => item.id === blockId || item.name === blockId) : null;
  if (source) return source.filterIds ?? [];
  if (tile.semantic) return tile.semantic.dimensions ?? [];
  if (tile.draftAnalysis) return [];
  return (tile.filterBindings ?? [])
    .filter((binding) => binding.capability !== 'unsupported' && Boolean(binding.binding))
    .map((binding) => binding.binding!);
}

function sourceNameForTile(tile: StudioTile, catalog: AppBlockRecommendation[]): string {
  const blockId = tile.block ? ('blockId' in tile.block ? tile.block.blockId : tile.block.ref) : null;
  const source = blockId ? catalog.find((item) => item.id === blockId || item.name === blockId) : null;
  if (source) return source.name;
  if (tile.semantic) return tile.semantic.id;
  if (tile.draftAnalysis) return tile.draftAnalysis.ref;
  return tile.title || tile.i;
}
