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

export type StudioRuntimeFilterFields = Record<string, Record<string, Array<{
  column: string;
  predicateTarget: string;
}>>>;

export function defaultStudioFilterType(fieldId: string): 'daterange' | 'number' | 'select' {
  if (/date|time|month|week|quarter|year|created|updated|ordered|(_at|_on)$/i.test(fieldId)) return 'daterange';
  if (/count|amount|limit|top_?n|score/i.test(fieldId)) return 'number';
  return 'select';
}

/**
 * Filters are authored only from fields already exposed by a governed source.
 * This gives App Studio a Power BI/Tableau-style field picker without turning
 * arbitrary result columns into an unreviewed SQL contract.
 */
export function discoverAppFilterCandidates(
  pages: StudioPage[],
  catalog: AppBlockRecommendation[],
  runtimeFields: StudioRuntimeFilterFields = {},
  boundSources: AppStudioBuildDraft['sources'] = [],
): StudioFilterCandidate[] {
  const fieldIds = new Set<string>();
  for (const page of pages) {
    for (const filter of page.filters ?? []) {
      const fieldId = filter.field?.name ?? filter.bindsTo ?? filter.id;
      if (fieldId) fieldIds.add(fieldId);
    }
    for (const tile of dataTiles(page)) {
      for (const fieldId of governedFieldsForTile(tile, catalog, boundSources)) fieldIds.add(fieldId);
      for (const field of runtimeFields[page.id]?.[tile.i] ?? []) fieldIds.add(field.column);
      for (const binding of tile.filterBindings ?? []) {
        if (binding.binding && binding.capability !== 'unsupported') fieldIds.add(binding.binding);
      }
    }
  }
  return [...fieldIds]
    .map((id) => {
      const mappings = filterTileMappingsForField(pages, catalog, id, runtimeFields, boundSources).filter((mapping) => mapping.supported);
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
  runtimeFields: StudioRuntimeFilterFields = {},
  boundSources: AppStudioBuildDraft['sources'] = [],
): StudioFilterCandidate[] {
  return page ? discoverAppFilterCandidates([page], catalog, runtimeFields, boundSources) : [];
}

/** Returns every data component, including explicit incompatibility reasons. */
export function filterTileMappingsForField(
  pages: StudioPage[],
  catalog: AppBlockRecommendation[],
  fieldId: string,
  runtimeFields: StudioRuntimeFilterFields = {},
  boundSources: AppStudioBuildDraft['sources'] = [],
): StudioFilterTileMapping[] {
  return pages.flatMap((page) => dataTiles(page).map((tile) => {
    const fields = governedFieldsForTile(tile, catalog, boundSources);
    const runtimeField = (runtimeFields[page.id]?.[tile.i] ?? []).find((field) => sameStudioFilterField(field.column, fieldId));
    const existing = (tile.filterBindings ?? []).find((binding) =>
      binding.filter === fieldId || binding.binding === fieldId,
    );
    const supported = fields.includes(fieldId)
      || Boolean(runtimeField)
      || Boolean(existing?.binding === fieldId && existing.capability !== 'unsupported');
    const sourceName = sourceNameForTile(tile, catalog, boundSources);
    return {
      key: studioFilterMappingKey(page.id, tile.i),
      pageId: page.id,
      pageTitle: page.metadata.title,
      tileId: tile.i,
      tileTitle: tile.title || tile.i,
      sourceName,
      supported,
      ...(supported ? {
        // App execution filters the settled tile's outer result. Use the
        // approved output column here; predicateTarget is retained only as the
        // server-side proof that this output is a safe, non-aggregate field.
        binding: runtimeField?.column ?? fieldId,
        mode: tile.semantic ? 'semantic' as const : existing?.mode ?? 'predicate' as const,
      } : {
        reason: `${fieldId.replace(/_/g, ' ')} is not exposed by ${sourceName}.`,
      }),
    };
  }));
}

function sameStudioFilterField(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const parts = value.trim().toLowerCase().replace(/["`\[\]]/g, '').split('.');
    return (parts[parts.length - 1] ?? '').replace(/[^a-z0-9]/g, '');
  };
  return normalize(left) === normalize(right);
}

export function studioFilterMappingKey(pageId: string, tileId: string): string {
  return `${pageId}:${tileId}`;
}

function dataTiles(page: StudioPage): StudioTile[] {
  return page.layout.items.filter((tile) => Boolean(tile.block || tile.semantic || tile.draftAnalysis));
}

function governedFieldsForTile(
  tile: StudioTile,
  catalog: AppBlockRecommendation[],
  boundSources: AppStudioBuildDraft['sources'],
): string[] {
  const bound = tile.sourceId ? boundSources.find((source) => source.id === tile.sourceId) : undefined;
  if (bound?.capabilities) {
    return [...new Set([...bound.capabilities.filters, ...bound.capabilities.dimensions])];
  }
  const blockId = tile.block ? ('blockId' in tile.block ? tile.block.blockId : tile.block.ref) : null;
  const source = blockId ? catalog.find((item) => item.id === blockId || item.name === blockId) : null;
  if (source) return [...new Set([...(source.filterIds ?? []), ...(source.dimensionIds ?? [])])];
  if (tile.semantic) return tile.semantic.dimensions ?? [];
  if (tile.draftAnalysis) return [];
  return (tile.filterBindings ?? [])
    .filter((binding) => binding.capability !== 'unsupported' && Boolean(binding.binding))
    .map((binding) => binding.binding!);
}

function sourceNameForTile(
  tile: StudioTile,
  catalog: AppBlockRecommendation[],
  boundSources: AppStudioBuildDraft['sources'],
): string {
  const bound = tile.sourceId ? boundSources.find((source) => source.id === tile.sourceId) : undefined;
  if (bound) return bound.qualifiedIdentity ?? bound.sourceRef;
  const blockId = tile.block ? ('blockId' in tile.block ? tile.block.blockId : tile.block.ref) : null;
  const source = blockId ? catalog.find((item) => item.id === blockId || item.name === blockId) : null;
  if (source) return source.name;
  if (tile.semantic) return tile.semantic.id;
  if (tile.draftAnalysis) return tile.draftAnalysis.ref;
  return tile.title || tile.i;
}
