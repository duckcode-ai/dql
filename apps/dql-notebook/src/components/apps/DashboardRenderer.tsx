import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { GripVertical, SlidersHorizontal, Trash2 } from 'lucide-react';
import { api, type AppBlockRecommendation, type DashboardDocumentResponse, type DashboardRunResponse } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import type { CellChartConfig, ThemeMode } from '../../store/types';
import { ChartOutput, CHART_TYPE_OPTIONS, type ChartType } from '../output/ChartOutput';
import { TableOutput } from '../output/TableOutput';
import { AgentChatPanel } from '../agent/AgentChatPanel';
import { inferColumnKind, columnKindToChartRole, type ChartColumnRole } from '../../utils/column-kind';
import { classifyColumns } from '../../utils/semantic-fields';

type DashboardLayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];

const SIDE_PANEL_HEIGHT = 'clamp(320px, calc(100vh - 220px), 760px)';
const APP_CHART_TYPE_OPTIONS: Array<{ value: ChartType; label: string }> = [
  { value: 'table', label: 'Table' },
  ...CHART_TYPE_OPTIONS,
];

/**
 * Grid renderer for `.dqld` dashboards backed by the live dashboard run API.
 */
export function DashboardRenderer({
  appId,
  dashboard,
  editable = false,
  onDashboardChanged,
}: {
  appId: string;
  dashboard: DashboardDocumentResponse['dashboard'];
  editable?: boolean;
  onDashboardChanged?: (dashboard: DashboardDocumentResponse['dashboard']) => void;
}): JSX.Element {
  const { state } = useNotebook();
  const [run, setRun] = useState<DashboardRunResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalog, setCatalog] = useState<AppBlockRecommendation[]>([]);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [lineageOpen, setLineageOpen] = useState(false);
  const [lineage, setLineage] = useState<any | null>(null);
  const [saving, setSaving] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);
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
  }, [appId, dashboard.id, dashboard.layout.items.length, state.activePersona?.userId]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ appId?: string; dashboardId?: string }>).detail;
      if (detail?.appId !== appId || detail.dashboardId !== dashboard.id) return;
      void api.getDashboard(appId, dashboard.id).then((next) => {
        if (next?.dashboard) onDashboardChanged?.(next.dashboard);
      });
      void api.runDashboard(appId, dashboard.id).then((nextRun) => {
        if (nextRun) setRun(nextRun);
      });
    };
    window.addEventListener('dql-app-dashboard-updated', handler);
    return () => window.removeEventListener('dql-app-dashboard-updated', handler);
  }, [appId, dashboard.id, onDashboardChanged]);

  const chatContext = useMemo(() => {
    const tiles = dashboard.layout.items.map((item) => {
      const tile = tileResults.get(item.i);
      const blockRef = item.block ? ('blockId' in item.block ? item.block.blockId : item.block.ref) : item.aiPin ? `aiPin:${item.aiPin.id}` : 'text';
      return {
        title: item.title,
        blockRef,
        viz: item.viz.type,
        certificationStatus: tile?.certificationStatus,
        status: tile?.status,
        rowCount: tile?.result?.rowCount,
      };
    });
    return JSON.stringify({
      scope: 'dashboard',
      appId,
      dashboardId: dashboard.id,
      title: dashboard.metadata.title,
      description: dashboard.metadata.description,
      domain: dashboard.metadata.domain,
      filters: dashboard.filters,
      tiles,
    }, null, 2);
  }, [appId, dashboard, tileResults]);

  const saveItems = useCallback(async (items: DashboardDocumentResponse['dashboard']['layout']['items']) => {
    setSaving(true);
    const next = {
      ...dashboard,
      layout: {
        ...dashboard.layout,
        items,
      },
    };
    const result = await api.patchDashboardLayout(appId, dashboard.id, next.layout);
    setSaving(false);
    if (result.ok) {
      onDashboardChanged?.(result.dashboard);
    } else {
      setError(result.error);
    }
  }, [appId, dashboard, onDashboardChanged]);

  const openCatalog = useCallback(async () => {
    setCatalogOpen(true);
    const result = await api.getAppEditorCatalog(appId);
    setCatalog(result?.blocks ?? []);
  }, [appId]);

  const addBlockTile = useCallback(async (block: AppBlockRecommendation) => {
    const tile = {
      i: nextTileId(dashboard, block.name),
      ...nextTilePosition(dashboard),
      block: { blockId: block.name },
      viz: { type: normalizeViz(block.chartType) },
      title: block.name,
    };
    await saveItems([...dashboard.layout.items, tile]);
    setCatalogOpen(false);
  }, [dashboard, saveItems]);

  const addTextTile = useCallback(async () => {
    const markdown = window.prompt('Text for this App tile');
    if (!markdown?.trim()) return;
    const title = markdown.trim().split(/\r?\n/)[0]?.slice(0, 60) || 'Summary';
    await saveItems([
      ...dashboard.layout.items,
      {
        i: nextTileId(dashboard, 'text'),
        ...nextTilePosition(dashboard),
        text: { markdown: markdown.trim() },
        viz: { type: 'text' },
        title,
      },
    ]);
  }, [dashboard, saveItems]);

  const addHeadingTile = useCallback(async () => {
    const title = window.prompt('Section heading');
    if (!title?.trim()) return;
    await saveItems([
      ...dashboard.layout.items,
      {
        i: nextTileId(dashboard, 'section'),
        ...nextTilePosition(dashboard, { w: 12, h: 1 }),
        text: { markdown: title.trim() },
        viz: { type: 'heading' },
        title: title.trim(),
      },
    ]);
  }, [dashboard, saveItems]);

  const patchTile = useCallback(async (tileId: string, patch: Partial<DashboardLayoutItem> | null) => {
    const items = patch === null
      ? dashboard.layout.items.filter((item) => item.i !== tileId)
      : dashboard.layout.items.map((item) => item.i === tileId ? { ...item, ...patch } : item);
    await saveItems(packDashboardItems(items, cols));
  }, [cols, dashboard.layout.items, saveItems]);

  const moveTileToPoint = useCallback(async (tileId: string, point: { clientX: number; clientY: number }) => {
    const grid = gridRef.current;
    const item = dashboard.layout.items.find((candidate) => candidate.i === tileId);
    if (!grid || !item) return;
    const rect = grid.getBoundingClientRect();
    const gap = 12;
    const colWidth = (rect.width - gap * (cols - 1)) / cols;
    const stepX = colWidth + gap;
    const stepY = rowHeight + gap;
    const rawX = Math.round((point.clientX - rect.left) / stepX);
    const rawY = Math.round((point.clientY - rect.top) / stepY);
    const moved = {
      ...item,
      x: clamp(rawX, 0, Math.max(0, cols - item.w)),
      y: Math.max(0, rawY),
    };
    const ordered = reorderTileForDrop(dashboard.layout.items, moved, cols);
    await saveItems(packDashboardItems(ordered, cols));
  }, [cols, dashboard.layout.items, rowHeight, saveItems]);

  const loadLineage = useCallback(async () => {
    setLineageOpen((value) => !value);
    if (!lineage) {
      const result = await api.fetchScopedLineage({
        domain: dashboard.metadata.domain,
        appId,
        dashboardId: dashboard.id,
      });
      setLineage(result);
    }
  }, [appId, dashboard.id, dashboard.metadata.domain, lineage]);

  return (
    <div style={{ display: 'flex', gap: 16, minHeight: 0, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{dashboard.metadata.title}</h2>
        {dashboard.metadata.description ? (
          <div style={{ fontSize: 13, opacity: 0.7, marginTop: 4 }}>
            {dashboard.metadata.description}
          </div>
        ) : null}
        </div>
        {editable && dashboard.layout.items.length > 0 && (
          <AddTileMenu
            open={addMenuOpen}
            onToggle={() => setAddMenuOpen((value) => !value)}
            onCertifiedBlock={() => {
              setAddMenuOpen(false);
              void openCatalog();
            }}
            onText={() => {
              setAddMenuOpen(false);
              void addTextTile();
            }}
            onHeading={() => {
              setAddMenuOpen(false);
              void addHeadingTile();
            }}
            onAi={() => {
              setAddMenuOpen(false);
              setChatOpen(true);
            }}
          />
        )}
        <button
          type="button"
          onClick={() => {
            setAddMenuOpen(false);
            setChatOpen((v) => !v);
          }}
          style={toolbarButtonStyle(chatOpen)}
        >
          {chatOpen ? 'Hide AI' : 'Ask AI'}
        </button>
        <button type="button" onClick={() => void loadLineage()} style={toolbarButtonStyle(lineageOpen)}>
          Lineage
        </button>
      </div>
      {editable && (
        <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--color-text-secondary, rgba(0,0,0,0.64))' }}>
          <span>{saving ? 'Saving layout...' : 'Edit layout'}</span>
          <span>{dashboard.layout.items.length} tile{dashboard.layout.items.length === 1 ? '' : 's'}</span>
        </div>
      )}

      {dashboard.layout.items.length === 0 ? (
        <div
          style={{
            border: '1px dashed var(--border-color, rgba(0,0,0,0.15))',
            borderRadius: 8,
            padding: 36,
            textAlign: 'center',
            fontSize: 13,
            minHeight: 260,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Build this App tab</div>
          <div style={{ maxWidth: 520, opacity: 0.68, lineHeight: 1.45 }}>
            Add certified domain blocks, narrative text, or use the scoped AI drawer and pin an answer into this layout.
          </div>
          <div style={{ marginTop: 18, display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <AddTileMenu
              open={addMenuOpen}
              onToggle={() => setAddMenuOpen((value) => !value)}
              buttonLabel="+ Add"
              buttonStyle={primaryBuilderButtonStyle}
              onCertifiedBlock={() => {
                setAddMenuOpen(false);
                void openCatalog();
              }}
              onText={() => {
                setAddMenuOpen(false);
                void addTextTile();
              }}
              onHeading={() => {
                setAddMenuOpen(false);
                void addHeadingTile();
              }}
              onAi={() => {
                setAddMenuOpen(false);
                setChatOpen(true);
              }}
            />
          </div>
        </div>
      ) : (
        <div
          ref={gridRef}
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
              editable={editable}
              cols={cols}
              onMove={(point) => void moveTileToPoint(item.i, point)}
              onPatch={(patch) => void patchTile(item.i, patch)}
            />
          ))}
        </div>
      )}
      </div>

      {lineageOpen && (
        <aside style={{ width: 340, minWidth: 300, maxWidth: '34vw', border: '1px solid var(--border-color, rgba(0,0,0,0.08))', borderRadius: 8, overflow: 'auto', alignSelf: 'flex-start', height: SIDE_PANEL_HEIGHT, position: 'sticky', top: 12, padding: 12 }}>
          <ScopedLineagePanel lineage={lineage} />
        </aside>
      )}

      {chatOpen && (
        <aside
          style={{
            width: chatExpanded ? 'min(720px, 52vw)' : 390,
            minWidth: chatExpanded ? 520 : 340,
            maxWidth: chatExpanded ? '58vw' : '40vw',
            border: '1px solid var(--border-color, rgba(0,0,0,0.08))',
            borderRadius: 8,
            overflow: 'hidden',
            alignSelf: 'flex-start',
            height: SIDE_PANEL_HEIGHT,
            position: 'sticky',
            top: 12,
          }}
        >
          <AgentChatPanel
            title="Dashboard AI"
            scopeHint="Scoped to this App dashboard first"
            upstreamContext={chatContext}
            themeMode={state.themeMode}
            hideSqlByDefault
            addToAppTarget={{ appId, dashboardId: dashboard.id }}
            expanded={chatExpanded}
            onToggleExpanded={() => setChatExpanded((value) => !value)}
            onClose={() => {
              setChatOpen(false);
              setChatExpanded(false);
            }}
          />
        </aside>
      )}

      {catalogOpen && (
        <BlockCatalogDialog
          blocks={catalog}
          search={catalogSearch}
          onSearch={setCatalogSearch}
          onClose={() => setCatalogOpen(false)}
          onAdd={(block) => void addBlockTile(block)}
        />
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
  editable,
  cols,
  onMove,
  onPatch,
}: {
  item: DashboardDocumentResponse['dashboard']['layout']['items'][number];
  tile?: DashboardRunResponse['tiles'][number];
  loading: boolean;
  error: string | null;
  themeMode: ThemeMode;
  editable: boolean;
  cols: number;
  onMove: (point: { clientX: number; clientY: number }) => void;
  onPatch: (patch: Partial<DashboardDocumentResponse['dashboard']['layout']['items'][number]> | null) => void;
}): JSX.Element {
  const tileRef = useRef<HTMLDivElement | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const blockRef = item.block
    ? ('blockId' in item.block ? `block:${item.block.blockId}` : item.block.ref ?? '(unknown)')
    : item.aiPin
      ? `aiPin:${item.aiPin.id}`
      : 'text';
  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const tileEl = tileRef.current;
    if (!tileEl) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = tileEl.getBoundingClientRect();
    const grabOffset = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const start = {
      x: event.clientX,
      y: event.clientY,
    };
    const onPointerMove = (moveEvent: PointerEvent) => {
      setDragOffset({
        x: moveEvent.clientX - start.x,
        y: moveEvent.clientY - start.y,
      });
    };
    const onPointerUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      setDragOffset(null);
      onMove({
        clientX: upEvent.clientX - grabOffset.x,
        clientY: upEvent.clientY - grabOffset.y,
      });
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  };
  return (
    <div
      ref={tileRef}
      style={{
        gridColumn: `${item.x + 1} / span ${item.w}`,
        gridRow: `${item.y + 1} / span ${item.h}`,
        transform: dragOffset ? `translate(${dragOffset.x}px, ${dragOffset.y}px)` : undefined,
        opacity: dragOffset ? 0.72 : 1,
        zIndex: dragOffset ? 20 : undefined,
        position: 'relative',
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
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
          {editable && (
            <TileEditorControls
              item={item}
              cols={cols}
              settingsOpen={settingsOpen}
              onToggleSettings={() => setSettingsOpen((value) => !value)}
              onDragStart={startDrag}
              onPatch={onPatch}
            />
          )}
        </div>
      </div>
      <div style={{ fontSize: 11, opacity: 0.6, fontFamily: 'monospace' }}>{blockRef}</div>
      {editable && settingsOpen ? (
        <TileSettingsPanel
          item={item}
          tile={tile}
          cols={cols}
          onPatch={onPatch}
        />
      ) : null}
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
        <TileBody item={item} tile={tile} loading={loading} error={error} themeMode={themeMode} />
      </div>
    </div>
  );
}

function TileBody({
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
  if (loading && !tile) return <span>Loading data...</span>;
  if (tile?.tileType === 'text') return <MarkdownTile markdown={tile.text?.markdown ?? ''} variant={tile.viz?.type === 'heading' ? 'heading' : 'text'} />;
  if (tile?.tileType === 'aiPin' && tile.aiPin && !tile.result) {
    return <AiPinSummary pin={tile.aiPin} />;
  }
  if (error && !tile) return <span>{error}</span>;
  if (!tile) return <span>No run result.</span>;
  if (tile.status === 'unauthorized') return <span>Not authorized.</span>;
  if (tile.status === 'unresolved') return <span>{tile.error ?? 'Block reference unresolved.'}</span>;
  if (tile.status === 'error') return <span>{tile.error ?? 'Tile failed.'}</span>;
  if (!tile.result) return <span>No result.</span>;

  const chartConfig = mergeTileChartConfig(item, tile.chartConfig as CellChartConfig | undefined);
  const chart = String(chartConfig.chart ?? tile.viz?.type ?? '').toLowerCase();
  if (chart === 'table' || item.viz.type === 'table') {
    return <div style={{ width: '100%', alignSelf: 'stretch' }}><TableOutput result={tile.result} themeMode={themeMode} /></div>;
  }
  return <div style={{ width: '100%', alignSelf: 'stretch' }}><ChartOutput result={tile.result} themeMode={themeMode} chartConfig={chartConfig} /></div>;
}

function TileEditorControls({
  item,
  cols,
  settingsOpen,
  onToggleSettings,
  onDragStart,
  onPatch,
}: {
  item: DashboardDocumentResponse['dashboard']['layout']['items'][number];
  cols: number;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  onDragStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPatch: (patch: Partial<DashboardDocumentResponse['dashboard']['layout']['items'][number]> | null) => void;
}) {
  const applyColumns = (tilesPerRow: 1 | 2 | 3) => {
    const width = Math.max(1, Math.floor(cols / tilesPerRow));
    onPatch({ w: width, x: clamp(item.x, 0, Math.max(0, cols - width)) });
  };
  const applyHeight = (height: number) => onPatch({ h: height });
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <button
        type="button"
        title="Tile settings"
        onClick={onToggleSettings}
        style={iconTileButtonStyle}
      >
        <SlidersHorizontal size={13} strokeWidth={2} color={settingsOpen ? 'var(--accent, #4f46e5)' : undefined} />
      </button>
      <button
        type="button"
        title="Drag tile"
        onPointerDown={onDragStart}
        style={iconTileButtonStyle}
      >
        <GripVertical size={13} strokeWidth={2} />
      </button>
      <div style={segmentedControlStyle} aria-label="Tile width">
        <button type="button" title="One tile per row" onClick={() => applyColumns(1)} style={segmentPillStyle(item.w === cols)}>1</button>
        <button type="button" title="Two tiles per row" onClick={() => applyColumns(2)} style={segmentPillStyle(item.w === Math.floor(cols / 2))}>2</button>
        <button type="button" title="Three tiles per row" onClick={() => applyColumns(3)} style={segmentPillStyle(item.w === Math.floor(cols / 3))}>3</button>
      </div>
      <div style={segmentedControlStyle} aria-label="Tile height">
        <button type="button" title="Compact height" onClick={() => applyHeight(2)} style={segmentPillStyle(item.h === 2)}>S</button>
        <button type="button" title="Standard height" onClick={() => applyHeight(3)} style={segmentPillStyle(item.h === 3)}>M</button>
        <button type="button" title="Large height" onClick={() => applyHeight(5)} style={segmentPillStyle(item.h >= 5)}>L</button>
      </div>
      <button
        type="button"
        title="Remove tile"
        onClick={() => onPatch(null)}
        style={iconTileButtonStyle}
      >
        <Trash2 size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

function TileSettingsPanel({
  item,
  tile,
  cols,
  onPatch,
}: {
  item: DashboardDocumentResponse['dashboard']['layout']['items'][number];
  tile?: DashboardRunResponse['tiles'][number];
  cols: number;
  onPatch: (patch: Partial<DashboardDocumentResponse['dashboard']['layout']['items'][number]> | null) => void;
}) {
  const result = tile?.result;
  const chartConfig = mergeTileChartConfig(item, tile?.chartConfig as CellChartConfig | undefined);
  const chart = normalizeChartType(chartConfig.chart);
  const classified = useMemo(() => classifyColumns(result), [result]);
  const columnKinds = useMemo(() => {
    const map = new Map<string, ChartColumnRole>();
    if (!result) return map;
    const metricSet = new Set(classified.metrics);
    const dimSet = new Set(classified.dimensions);
    for (const column of result.columns) {
      if (metricSet.has(column)) map.set(column, 'measure');
      else if (dimSet.has(column)) map.set(column, 'dimension');
      else map.set(column, columnKindToChartRole(inferColumnKind(column, result.rows)));
    }
    return map;
  }, [result, classified]);
  const measures = result?.columns.filter((column) => columnKinds.get(column) === 'measure') ?? [];
  const dimensions = result?.columns.filter((column) => columnKinds.get(column) !== 'measure') ?? [];

  const patchConfig = (patch: Partial<CellChartConfig>) => {
    const next = compactChartConfig({ ...chartConfig, ...patch });
    onPatch({
      title: next.title || item.title,
      viz: {
        ...item.viz,
        type: chartToDashboardViz(next.chart),
        options: next as Record<string, unknown>,
      },
    });
  };

  const patchSize = (patch: Partial<Pick<DashboardLayoutItem, 'w' | 'h'>>) => {
    onPatch({
      ...patch,
      w: patch.w !== undefined ? clamp(Math.round(patch.w), 1, cols) : item.w,
      h: patch.h !== undefined ? Math.max(1, Math.round(patch.h)) : item.h,
      x: patch.w !== undefined ? clamp(item.x, 0, Math.max(0, cols - clamp(Math.round(patch.w), 1, cols))) : item.x,
    });
  };

  return (
    <div style={tileSettingsPanelStyle}>
      <div style={tileSettingsGridStyle}>
        <label style={tileSettingsLabelStyle}>
          Title
          <input
            value={chartConfig.title ?? item.title ?? ''}
            onChange={(event) => patchConfig({ title: event.target.value || undefined })}
            style={tileSettingsInputStyle}
          />
        </label>
        <label style={tileSettingsLabelStyle}>
          Chart
          <select
            value={chart}
            onChange={(event) => patchConfig({ chart: event.target.value as ChartType })}
            style={tileSettingsInputStyle}
          >
            {APP_CHART_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <FieldSelect label="X" value={chartConfig.x} columns={result?.columns ?? []} onChange={(value) => patchConfig({ x: value })} />
        <FieldSelect label="Y" value={chartConfig.y} columns={result?.columns ?? []} onChange={(value) => patchConfig({ y: value })} />
        <FieldSelect label="Color" value={chartConfig.color} columns={result?.columns ?? []} onChange={(value) => patchConfig({ color: value })} />
        <FieldSelect label="Facet" value={chartConfig.facet} columns={result?.columns ?? []} onChange={(value) => patchConfig({ facet: value })} />
        <label style={tileSettingsLabelStyle}>
          Width
          <input
            type="number"
            min={1}
            max={cols}
            value={item.w}
            onChange={(event) => patchSize({ w: Number(event.target.value) })}
            style={tileSettingsInputStyle}
          />
        </label>
        <label style={tileSettingsLabelStyle}>
          Height
          <input
            type="number"
            min={1}
            max={12}
            value={item.h}
            onChange={(event) => patchSize({ h: Number(event.target.value) })}
            style={tileSettingsInputStyle}
          />
        </label>
      </div>
      {result ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <ColumnPickList title="Measures" columns={measures} onPick={(column) => patchConfig({ y: column })} />
          <ColumnPickList title="Dimensions" columns={dimensions} onPick={(column) => patchConfig({ x: column })} />
        </div>
      ) : (
        <div style={{ fontSize: 11, opacity: 0.64 }}>Run results are needed before field slots can be inferred.</div>
      )}
    </div>
  );
}

function FieldSelect({
  label,
  value,
  columns,
  onChange,
}: {
  label: string;
  value?: string;
  columns: string[];
  onChange: (value: string | undefined) => void;
}) {
  return (
    <label style={tileSettingsLabelStyle}>
      {label}
      <select value={value ?? ''} onChange={(event) => onChange(event.target.value || undefined)} style={tileSettingsInputStyle}>
        <option value="">Auto</option>
        {columns.map((column) => <option key={column} value={column}>{column}</option>)}
      </select>
    </label>
  );
}

function ColumnPickList({
  title,
  columns,
  onPick,
}: {
  title: string;
  columns: string[];
  onPick: (column: string) => void;
}) {
  return (
    <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', opacity: 0.58 }}>{title}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {columns.length === 0 ? <span style={{ fontSize: 11, opacity: 0.55 }}>None</span> : columns.slice(0, 10).map((column) => (
          <button key={column} type="button" onClick={() => onPick(column)} style={fieldChipStyle}>
            {column}
          </button>
        ))}
      </div>
    </div>
  );
}

function AddTileMenu({
  open,
  onToggle,
  onCertifiedBlock,
  onText,
  onHeading,
  onAi,
  buttonLabel = '+ Add',
  buttonStyle,
}: {
  open: boolean;
  onToggle: () => void;
  onCertifiedBlock: () => void;
  onText: () => void;
  onHeading: () => void;
  onAi: () => void;
  buttonLabel?: string;
  buttonStyle?: CSSProperties;
}) {
  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button type="button" onClick={onToggle} style={buttonStyle ?? toolbarButtonStyle(open)}>
        {buttonLabel}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 30,
            width: 260,
            border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
            borderRadius: 8,
            background: 'var(--color-bg, #fff)',
            boxShadow: '0 14px 38px rgba(0,0,0,0.16)',
            padding: 6,
            display: 'grid',
            gap: 4,
            textAlign: 'left',
          }}
        >
          <AddTileMenuItem title="Certified block" description="Chart, table, or KPI from this App domain" onClick={onCertifiedBlock} />
          <AddTileMenuItem title="Text / summary" description="Narrative, notes, caveats, or CXO context" onClick={onText} />
          <AddTileMenuItem title="Section heading" description="Separate an App page into readable groups" onClick={onHeading} />
          <AddTileMenuItem title="AI answer" description="Open scoped AI, then pin the answer to this App" onClick={onAi} />
        </div>
      )}
    </div>
  );
}

function AddTileMenuItem({
  title,
  description,
  onClick,
}: {
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} style={addMenuItemStyle}>
      <span style={{ fontSize: 12, fontWeight: 700 }}>{title}</span>
      <span style={{ fontSize: 11, opacity: 0.66 }}>{description}</span>
    </button>
  );
}

function MarkdownTile({ markdown, variant = 'text' }: { markdown: string; variant?: 'text' | 'heading' }) {
  return (
    <div
      style={{
        width: '100%',
        alignSelf: 'stretch',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        lineHeight: 1.45,
        fontStyle: 'normal',
        opacity: 1,
        fontSize: variant === 'heading' ? 18 : undefined,
        fontWeight: variant === 'heading' ? 800 : undefined,
        display: variant === 'heading' ? 'flex' : undefined,
        alignItems: variant === 'heading' ? 'center' : undefined,
      }}
    >
      {markdown}
    </div>
  );
}

function AiPinSummary({ pin }: { pin: NonNullable<DashboardRunResponse['tiles'][number]['aiPin']> }) {
  const [message, setMessage] = useState<string | null>(null);
  const refresh = async () => {
    setMessage('Refreshing...');
    const result = await api.refreshAiPin(pin.appId, pin.id);
    setMessage(result.ok ? 'Refreshed.' : result.error ?? 'Refresh failed.');
    window.dispatchEvent(new CustomEvent('dql-app-dashboard-updated', { detail: { appId: pin.appId, dashboardId: pin.dashboardId } }));
  };
  const promote = async () => {
    setMessage('Creating draft...');
    const result = await api.promoteAiPin(pin.appId, pin.id);
    setMessage(result.ok ? `Draft created: ${result.blockPath}` : result.error ?? 'Promotion failed.');
    window.dispatchEvent(new CustomEvent('dql-app-dashboard-updated', { detail: { appId: pin.appId, dashboardId: pin.dashboardId } }));
  };
  return (
    <div style={{ width: '100%', alignSelf: 'stretch', overflow: 'auto', fontStyle: 'normal', lineHeight: 1.45 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: pin.certification === 'certified' ? '#3fb950' : '#f0883e', marginBottom: 6 }}>
        {pin.certification === 'certified' ? 'Certified' : 'AI generated / needs review'}
      </div>
      <div style={{ whiteSpace: 'pre-wrap' }}>{pin.answer}</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {pin.sql && <button type="button" onClick={() => void refresh()} style={miniButtonStyle}>Refresh</button>}
        {pin.sql && pin.reviewStatus === 'needs_review' && <button type="button" onClick={() => void promote()} style={miniButtonStyle}>Promote</button>}
        {pin.refreshCadence === 'daily' && <span style={{ fontSize: 11, opacity: 0.62 }}>daily</span>}
      </div>
      {message && <div style={{ marginTop: 6, fontSize: 11, opacity: 0.72 }}>{message}</div>}
      {pin.lastRefreshError && <div style={{ marginTop: 8, color: '#f85149' }}>{pin.lastRefreshError}</div>}
    </div>
  );
}

function BlockCatalogDialog({
  blocks,
  search,
  onSearch,
  onClose,
  onAdd,
}: {
  blocks: AppBlockRecommendation[];
  search: string;
  onSearch: (value: string) => void;
  onClose: () => void;
  onAdd: (block: AppBlockRecommendation) => void;
}) {
  const filtered = blocks.filter((block) => {
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return [block.name, block.description, block.domain, ...(block.tags ?? [])].join(' ').toLowerCase().includes(needle);
  });
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,0.36)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: 'min(860px, 94vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg, #fff)', color: 'inherit', borderRadius: 8, overflow: 'hidden', boxShadow: '0 18px 60px rgba(0,0,0,0.35)' }}>
        <div style={{ padding: 14, borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.1))', display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>Add Certified Block</div>
          <button type="button" onClick={onClose} style={toolbarButtonStyle(false)}>Close</button>
        </div>
        <div style={{ padding: 14, borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.08))' }}>
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search domain blocks..."
            style={{ width: '100%', boxSizing: 'border-box', border: '1px solid var(--border-color, rgba(0,0,0,0.12))', borderRadius: 6, padding: '8px 10px', background: 'var(--surface, transparent)', color: 'inherit' }}
          />
        </div>
        <div style={{ overflow: 'auto', padding: 12, display: 'grid', gap: 8 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 18, fontSize: 12, opacity: 0.66 }}>No certified blocks match this App scope.</div>
          ) : filtered.map((block) => (
            <button
              key={block.id}
              type="button"
              onClick={() => onAdd(block)}
              style={{ textAlign: 'left', border: '1px solid var(--border-color, rgba(0,0,0,0.1))', borderRadius: 7, background: 'transparent', color: 'inherit', padding: 10, cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{block.name}</span>
                <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 999, background: 'rgba(63,185,80,0.14)', color: '#2ea043' }}>{block.status}</span>
                <span style={{ fontSize: 10, opacity: 0.68 }}>{block.domain}</span>
                <span style={{ fontSize: 10, opacity: 0.68 }}>{block.chartType ?? 'table'}</span>
              </div>
              <div style={{ fontSize: 12, opacity: 0.72 }}>{block.description || block.path}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ScopedLineagePanel({ lineage }: { lineage: any | null }) {
  const nodes = lineage?.graph?.nodes ?? [];
  const edges = lineage?.graph?.edges ?? [];
  const breadcrumbs = lineage?.breadcrumbs ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', opacity: 0.62, marginBottom: 6 }}>App Lineage</div>
        <div style={{ fontSize: 12, opacity: 0.72 }}>Domain &gt; App &gt; Dashboard tab &gt; Tile &gt; Block &gt; dbt/source</div>
      </div>
      {breadcrumbs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {breadcrumbs.map((node: any, index: number) => (
            <div key={`${node.id}-${index}`} style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 8, fontSize: 12 }}>
              <span style={{ fontFamily: 'monospace', opacity: 0.6 }}>{node.type}</span>
              <span>{node.name}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <LineageStat label="Nodes" value={nodes.length} />
        <LineageStat label="Edges" value={edges.length} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {nodes.slice(0, 18).map((node: any) => (
          <div key={node.id} style={{ border: '1px solid var(--border-color, rgba(0,0,0,0.08))', borderRadius: 6, padding: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700 }}>{node.name}</div>
            <div style={{ fontSize: 11, opacity: 0.62, fontFamily: 'monospace' }}>{node.type} · {node.id}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LineageStat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ border: '1px solid var(--border-color, rgba(0,0,0,0.08))', borderRadius: 6, padding: 8 }}>
      <div style={{ fontSize: 11, opacity: 0.62 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800 }}>{value}</div>
    </div>
  );
}

function mergeTileChartConfig(
  item: DashboardDocumentResponse['dashboard']['layout']['items'][number],
  base?: CellChartConfig,
): CellChartConfig {
  const options = (item.viz.options ?? {}) as Partial<CellChartConfig>;
  return {
    ...(base ?? {}),
    ...options,
    chart: normalizeChartType(String(options.chart ?? base?.chart ?? item.viz.type)),
    title: options.title ?? base?.title ?? item.title,
  };
}

function normalizeChartType(value: unknown): ChartType {
  const normalized = String(value ?? 'table').toLowerCase().replace(/_/g, '-');
  if (normalized === 'single-value') return 'kpi';
  if (APP_CHART_TYPE_OPTIONS.some((option) => option.value === normalized)) return normalized as ChartType;
  return 'table';
}

function chartToDashboardViz(value: unknown): string {
  const chart = normalizeChartType(value);
  if (chart === 'table') return 'table';
  return chart.replace(/-/g, '_');
}

function compactChartConfig(config: CellChartConfig): CellChartConfig {
  const out: CellChartConfig = {};
  for (const [key, value] of Object.entries(config) as Array<[keyof CellChartConfig, unknown]>) {
    if (value === undefined || value === '') continue;
    (out as Record<string, unknown>)[key] = value;
  }
  if (!out.chart) out.chart = 'table';
  return out;
}

function toolbarButtonStyle(active: boolean): CSSProperties {
  return {
    border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
    borderRadius: 6,
    background: active ? 'var(--surface-hover, rgba(0,0,0,0.06))' : 'var(--surface, rgba(0,0,0,0.02))',
    color: 'inherit',
    padding: '7px 10px',
    cursor: 'pointer',
    fontSize: 12,
  };
}

const primaryBuilderButtonStyle: CSSProperties = {
  border: '1px solid var(--accent, #4f46e5)',
  borderRadius: 6,
  background: 'var(--accent, #4f46e5)',
  color: '#fff',
  padding: '7px 11px',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 700,
};

const addMenuItemStyle: CSSProperties = {
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  padding: '9px 10px',
  cursor: 'pointer',
  textAlign: 'left',
  display: 'grid',
  gap: 2,
};

const tileSettingsPanelStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderRadius: 6,
  padding: 8,
  background: 'var(--color-bg, rgba(255,255,255,0.72))',
  display: 'grid',
  gap: 8,
  fontStyle: 'normal',
};

const tileSettingsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: 6,
};

const tileSettingsLabelStyle: CSSProperties = {
  display: 'grid',
  gap: 3,
  fontSize: 10,
  fontWeight: 700,
  opacity: 0.78,
};

const tileSettingsInputStyle: CSSProperties = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 5,
  background: 'var(--surface, transparent)',
  color: 'inherit',
  padding: '5px 6px',
  fontSize: 11,
};

const fieldChipStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderRadius: 4,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  color: 'inherit',
  padding: '2px 5px',
  fontSize: 10,
  cursor: 'pointer',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const iconTileButtonStyle: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 5,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  background: 'var(--surface, rgba(255,255,255,0.72))',
  color: 'inherit',
  cursor: 'grab',
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const segmentedControlStyle: CSSProperties = {
  display: 'inline-flex',
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 5,
  overflow: 'hidden',
  background: 'var(--surface, rgba(255,255,255,0.66))',
};

function segmentPillStyle(active: boolean): CSSProperties {
  return {
    width: 24,
    height: 24,
    border: 'none',
    borderRight: '1px solid var(--border-color, rgba(0,0,0,0.08))',
    background: active ? 'var(--accent, #4f46e5)' : 'transparent',
    color: active ? '#fff' : 'inherit',
    padding: 0,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: active ? 800 : 600,
  };
}

const miniButtonStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 4,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  color: 'inherit',
  padding: '3px 7px',
  cursor: 'pointer',
  fontSize: 11,
};

function nextTilePosition(
  dashboard: DashboardDocumentResponse['dashboard'],
  size: { w: number; h: number } = { w: 6, h: 3 },
): { x: number; y: number; w: number; h: number } {
  const y = dashboard.layout.items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  return { x: 0, y, w: size.w, h: size.h };
}

function nextTileId(dashboard: DashboardDocumentResponse['dashboard'], raw: string): string {
  const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tile';
  const used = new Set(dashboard.layout.items.map((item) => item.i));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function packDashboardItems(items: DashboardLayoutItem[], cols: number): DashboardLayoutItem[] {
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  return items
    .map((item) => {
      const w = clamp(Math.round(item.w || 1), 1, cols);
      const h = Math.max(1, Math.round(item.h || 1));
      if (x > 0 && x + w > cols) {
        y += rowHeight;
        x = 0;
        rowHeight = 0;
      }
      const packed = { ...item, x, y, w, h };
      x += w;
      rowHeight = Math.max(rowHeight, h);
      if (x >= cols) {
        y += rowHeight;
        x = 0;
        rowHeight = 0;
      }
      return packed;
    });
}

function reorderTileForDrop(items: DashboardLayoutItem[], moved: DashboardLayoutItem, cols: number): DashboardLayoutItem[] {
  const others = items
    .filter((item) => item.i !== moved.i)
    .sort((a, b) => layoutScore(a, cols) - layoutScore(b, cols));
  const targetScore = layoutScore(moved, cols);
  const insertAt = others.findIndex((item) => layoutScore(item, cols) > targetScore);
  if (insertAt === -1) return [...others, moved];
  return [
    ...others.slice(0, insertAt),
    moved,
    ...others.slice(insertAt),
  ];
}

function layoutScore(item: DashboardLayoutItem, cols: number): number {
  return item.y * cols + item.x;
}

function normalizeViz(chartType?: string): string {
  const value = (chartType ?? 'table').toLowerCase().replace(/-/g, '_');
  if (value === 'single_value' || value === 'kpi' || value === 'line' || value === 'bar' || value === 'area'
    || value === 'pie' || value === 'pivot' || value === 'map' || value === 'funnel') {
    return value;
  }
  return 'table';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
