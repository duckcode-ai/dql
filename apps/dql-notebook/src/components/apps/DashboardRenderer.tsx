import { useEffect, useMemo, useState } from 'react';
import { api, type DashboardDocumentResponse, type DashboardRunResponse } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import type { ThemeMode } from '../../store/types';
import { ChartOutput } from '../output/ChartOutput';
import { TableOutput } from '../output/TableOutput';

/**
 * Grid renderer for `.dqld` dashboards backed by the live dashboard run API.
 */
export function DashboardRenderer({
  appId,
  dashboard,
}: {
  appId: string;
  dashboard: DashboardDocumentResponse['dashboard'];
}): JSX.Element {
  const { state } = useNotebook();
  const [run, setRun] = useState<DashboardRunResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cols = dashboard.layout.cols;
  const rowHeight = dashboard.layout.rowHeight;
  const tileResults = useMemo(() => {
    const map = new Map<string, DashboardRunResponse['tiles'][number]>();
    for (const tile of run?.tiles ?? []) map.set(tile.tileId, tile);
    return map;
  }, [run]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.runDashboard(appId, dashboard.id).then((result) => {
      if (cancelled) return;
      setRun(result);
      if (!result) setError('Dashboard run failed.');
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [appId, dashboard.id, state.activePersona?.userId]);

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
            <DashboardTile
              key={item.i}
              item={item}
              tile={tileResults.get(item.i)}
              loading={loading}
              error={error}
              themeMode={state.themeMode}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DashboardTile({
  item,
  tile,
  loading,
  error,
  themeMode,
}: {
  item: DashboardDocumentResponse['dashboard']['layout']['items'][number];
  tile?: DashboardRunResponse['tiles'][number];
  loading: boolean;
  error: string | null;
  themeMode: ThemeMode;
}): JSX.Element {
  const blockRef = 'blockId' in item.block
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
          opacity: tile?.status === 'ok' ? 1 : 0.7,
          fontStyle: tile?.status === 'ok' ? 'normal' : 'italic',
        }}
      >
        <TileBody tile={tile} loading={loading} error={error} themeMode={themeMode} />
      </div>
    </div>
  );
}

function TileBody({
  tile,
  loading,
  error,
  themeMode,
}: {
  tile?: DashboardRunResponse['tiles'][number];
  loading: boolean;
  error: string | null;
  themeMode: ThemeMode;
}): JSX.Element {
  if (loading && !tile) return <span>Loading data...</span>;
  if (error && !tile) return <span>{error}</span>;
  if (!tile) return <span>No run result.</span>;
  if (tile.status === 'unauthorized') return <span>Not authorized.</span>;
  if (tile.status === 'unresolved') return <span>{tile.error ?? 'Block reference unresolved.'}</span>;
  if (tile.status === 'error') return <span>{tile.error ?? 'Tile failed.'}</span>;
  if (!tile.result) return <span>No result.</span>;

  const chart = String((tile.chartConfig as { chart?: unknown } | undefined)?.chart ?? tile.viz?.type ?? '').toLowerCase();
  if (chart === 'table' || tile.viz?.type === 'table') {
    return <div style={{ width: '100%', alignSelf: 'stretch' }}><TableOutput result={tile.result} themeMode={themeMode} /></div>;
  }
  return <div style={{ width: '100%', alignSelf: 'stretch' }}><ChartOutput result={tile.result} themeMode={themeMode} chartConfig={tile.chartConfig as any} /></div>;
}
