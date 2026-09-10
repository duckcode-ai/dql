import type { LocalContextPack } from '../metadata/catalog.js';
import type { ResearchAssets } from './research-agent.js';

/**
 * RESEARCH READS THE SAME PROJECTION AS ASK (CTX-010). The hypothesis planner
 * used to see a bare list of every metric name in the project; now it sees
 * the eligible set of the request's envelope — what retrieval ranked first,
 * then the rest — under a bound, so a 3,000-model project does not put
 * 27,000 dimension names into one prompt. Without an eligible set the pack's
 * ranked objects alone are the assets.
 */
export function researchAssetsFromPack(
  pack: Pick<LocalContextPack, 'objects' | 'eligible'>,
  caps: { metrics?: number; blocks?: number; dimensions?: number } = {},
): ResearchAssets {
  const limit = { metrics: caps.metrics ?? 200, blocks: caps.blocks ?? 60, dimensions: caps.dimensions ?? 120 };
  const pick = (types: string[], cap: number): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (name: string | undefined) => {
      if (!name || seen.has(name) || out.length >= cap) return;
      seen.add(name); out.push(name);
    };
    for (const object of pack.objects) if (types.includes(object.objectType)) add(object.name);
    for (const object of pack.eligible?.objects ?? []) if (types.includes(object.objectType)) add(object.name);
    return out;
  };
  return {
    metrics: pick(['semantic_metric'], limit.metrics),
    blocks: pick(['dql_block'], limit.blocks),
    dimensions: pick(['semantic_dimension'], limit.dimensions),
  };
}
