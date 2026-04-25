import type { DashboardDocumentResponse } from '../../api/client';

/**
 * Minimal grid renderer for `.dqld` dashboards.
 *
 * Renders the layout as CSS-grid tiles. Each tile shows the block ref + viz
 * type as metadata; live block execution and chart rendering will be wired
 * in when the dashboard executor lands. This keeps the surface visible and
 * iterable without blocking the UI on the executor work.
 */
export function DashboardRenderer({
  dashboard,
}: {
  dashboard: DashboardDocumentResponse['dashboard'];
}): JSX.Element {
  const cols = dashboard.layout.cols;
  const rowHeight = dashboard.layout.rowHeight;
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{dashboard.metadata.title}</h2>
        {dashboard.metadata.description ? (
          <div style={{ fontSize: 13, opacity: 0.7, marginTop: 4 }}>
            {dashboard.metadata.description}
          </div>
        ) : null}
      </div>

      {dashboard.layout.items.length === 0 ? (
        <div
          style={{
            border: '1px dashed var(--border-color, rgba(0,0,0,0.15))',
            borderRadius: 8,
            padding: 32,
            textAlign: 'center',
            opacity: 0.7,
            fontSize: 13,
          }}
        >
          This dashboard has no blocks yet. Edit the <code>.dqld</code> file or use the upcoming
          DashboardEditor to add tiles.
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gridAutoRows: `${rowHeight}px`,
            gap: 12,
          }}
        >
          {dashboard.layout.items.map((item) => (
            <DashboardTile key={item.i} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function DashboardTile({
  item,
}: {
  item: DashboardDocumentResponse['dashboard']['layout']['items'][number];
}): JSX.Element {
  const blockRef = item.block.blockId
    ? `block:${item.block.blockId}`
    : item.block.ref ?? '(unknown)';
  return (
    <div
      style={{
        gridColumn: `${item.x + 1} / span ${item.w}`,
        gridRow: `${item.y + 1} / span ${item.h}`,
        background: 'var(--surface, rgba(0,0,0,0.02))',
        border: '1px solid var(--border-color, rgba(0,0,0,0.08))',
        borderRadius: 8,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{item.title ?? blockRef}</div>
        <span
          style={{
            fontSize: 10,
            padding: '2px 8px',
            borderRadius: 999,
            background: 'var(--surface-hover, rgba(0,0,0,0.06))',
            opacity: 0.85,
          }}
        >
          {item.viz.type}
        </span>
      </div>
      <div style={{ fontSize: 11, opacity: 0.6, fontFamily: 'monospace' }}>{blockRef}</div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          opacity: 0.55,
          fontStyle: 'italic',
        }}
      >
        Live data preview lands when the dashboard executor ships.
      </div>
    </div>
  );
}
