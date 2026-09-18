import type { CSSProperties } from 'react';
import type { AppStudioBuildDraft } from '../../../api/client';
import type { DatasetDescriptor } from '@duckcodeailabs/dql-core/datasets/descriptor';
import type { ThemeMode } from '../../../themes/notebook-theme';
import { DatasetQueryPreview } from './DraftTile';
import type { ProposedTileChange } from './proposal-preview';
import { humanize } from './studio-ui';

type Tile = AppStudioBuildDraft['pages'][number]['layout']['items'][number];

/**
 * A tile an AI proposal would add or change, drawn on the canvas before
 * anything is saved. Dataset tiles run their proposed query live; other
 * sources run when the proposal is applied.
 */
export function ProposedTileCard({
  tile,
  change,
  before,
  descriptor,
  columns,
  themeMode,
}: {
  tile: Tile;
  change: Extract<ProposedTileChange, 'added' | 'updated'>;
  before?: Tile;
  descriptor?: DatasetDescriptor;
  /** Grid columns available at the current preview width. */
  columns: number;
  themeMode: ThemeMode;
}): JSX.Element {
  const title = tile.title || humanize(tile.i);
  const renamed = change === 'updated' && before && (before.title || humanize(before.i)) !== title;
  const bodyHeight = Math.max(120, tile.h * 68 - 64);
  return <article
    className={`studio-component-card proposal-tile ${change}`}
    aria-label={`${change === 'added' ? 'Proposed tile' : 'Proposed change'}: ${title}`}
    style={{ '--studio-tile-width': Math.min(tile.w, columns), minHeight: tile.text ? undefined : Math.max(150, tile.h * 68) } as CSSProperties}
  >
    <header>
      <span className={`proposal-badge ${change}`}>{change === 'added' ? 'PROPOSED' : 'PROPOSED CHANGE'}</span>
      <strong>{title}</strong>
      {renamed ? <small className="proposal-was">was “{before!.title || humanize(before!.i)}”</small> : null}
    </header>
    <div className="draft-body" style={{ minHeight: tile.text ? 0 : bodyHeight }}>
      {tile.text
        ? <div className={tile.viz.type === 'heading' ? 'tile-heading' : 'tile-text'}>{tile.text.markdown.replace(/^#+\s*/, '')}</div>
        : tile.query && tile.sourceId
          ? <DatasetQueryPreview sourceId={tile.sourceId} descriptor={descriptor} query={tile.query} visualization={tile.viz.type} themeMode={themeMode} height={bodyHeight - 20} />
          : <div className="draft-empty loading"><span>{humanize(tile.viz.type)} · runs when you apply</span></div>}
    </div>
  </article>;
}
