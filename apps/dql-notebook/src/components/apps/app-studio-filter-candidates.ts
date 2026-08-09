import type { AppBlockRecommendation, AppStudioBuildDraft } from '../../api/client';

export type StudioFilterCandidate = { id: string; sourceNames: string[]; affectedTileCount: number };

export function discoverPageFilterCandidates(
  page: AppStudioBuildDraft['pages'][number] | null,
  catalog: AppBlockRecommendation[],
): StudioFilterCandidate[] {
  if (!page) return [];
  const byId = new Map<string, { sourceNames: Set<string>; tileIds: Set<string> }>();
  for (const tile of page.layout.items) {
    const blockId = tile.block ? ('blockId' in tile.block ? tile.block.blockId : tile.block.ref) : null;
    const source = blockId ? catalog.find((item) => item.id === blockId) : null;
    if (!source) continue;
    for (const filterId of source.filterIds ?? []) {
      const candidate = byId.get(filterId) ?? { sourceNames: new Set<string>(), tileIds: new Set<string>() };
      candidate.sourceNames.add(source.name);
      candidate.tileIds.add(tile.i);
      byId.set(filterId, candidate);
    }
  }
  return [...byId.entries()]
    .map(([id, candidate]) => ({
      id,
      sourceNames: [...candidate.sourceNames].sort(),
      affectedTileCount: candidate.tileIds.size,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
