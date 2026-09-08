import type { DashboardDocumentResponse } from '../../api/client';

type DashboardLayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];

/**
 * The header badge is a rollup of what the app's tiles actually are, not a
 * count of tiles that happen to reference a block. A tile whose review is
 * required, whose trust says review_required, or whose evidence is a saved
 * insight, a draft analysis or an unapproved semantic result is not certified,
 * and one such tile is enough for the app not to be "All certified".
 */
export function appCertificationRollup(
  items: ReadonlyArray<DashboardLayoutItem> | undefined,
  draftCount = 0,
): { certified: number; total: number; allCertified: boolean } {
  // Prose tiles carry no evidence of their own and are not counted either way.
  const dataTiles = (items ?? []).filter((item) => !item.text);
  const certified = dataTiles.filter((item) => Boolean(item.block)
    && item.review?.status !== 'required'
    && item.trustState !== 'review_required'
    && item.reviewStatus !== 'review_required'
    && (item.sourceClass === undefined || item.sourceClass === 'certified_block')
    && !item.aiPin && !item.draftAnalysis).length;
  return { certified, total: dataTiles.length, allCertified: draftCount === 0 && dataTiles.length > 0 && certified === dataTiles.length };
}
