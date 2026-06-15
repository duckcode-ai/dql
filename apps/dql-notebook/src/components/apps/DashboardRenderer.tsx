import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { Bot, GitBranch, GripVertical, Maximize2, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { api, type AppBlockRecommendation, type DashboardDocumentResponse, type DashboardRunResponse } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import type { CellChartConfig, ThemeMode } from '../../store/types';
import { ChartOutput, CHART_TYPE_OPTIONS, type ChartType } from '../output/ChartOutput';
import { TableOutput } from '../output/TableOutput';
import { AgentChatPanel } from '../agent/AgentChatPanel';
import { inferColumnKind, columnKindToChartRole, type ChartColumnRole } from '../../utils/column-kind';
import { classifyColumns } from '../../utils/semantic-fields';
import { NODE_TYPE_COLORS, TYPE_LABELS, TYPE_TITLES } from '../lineage/lineage-constants';

type DashboardLayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];

const SIDE_PANEL_HEIGHT = 'clamp(320px, calc(100vh - 220px), 760px)';
const APP_CHART_TYPE_OPTIONS: Array<{ value: ChartType; label: string }> = [
  { value: 'table', label: 'Table' },
  ...CHART_TYPE_OPTIONS,
];

function sampleRows(rows?: Array<Record<string, unknown>>, columns?: string[]): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const selectedColumns = Array.isArray(columns) && columns.length > 0 ? columns.slice(0, 8) : Object.keys(rows[0] ?? {}).slice(0, 8);
  return rows.slice(0, 5).map((row) => Object.fromEntries(selectedColumns.map((column) => [column, row[column]])));
}

type TileSizePresetId = 'auto' | 'compact' | 'standard' | 'wide' | 'tall' | 'full';

const TILE_SIZE_PRESETS: Array<{ id: TileSizePresetId; label: string; description: string }> = [
  { id: 'auto', label: 'Auto fit', description: 'Choose a practical size from the tile content' },
  { id: 'compact', label: 'Compact', description: 'Small KPI or short summary' },
  { id: 'standard', label: 'Standard', description: 'Default chart or table card' },
  { id: 'wide', label: 'Wide', description: 'Full-row trend or comparison' },
  { id: 'tall', label: 'Tall', description: 'More vertical room for tables and dense charts' },
  { id: 'full', label: 'Full page', description: 'Large focused view across the page' },
];

/**
 * Grid renderer for `.dqld` dashboards backed by the live dashboard run API.
 */
export function DashboardRenderer({
  appId,
  dashboard,
  variables,
  editable = false,
  onDashboardChanged,
  selectedBlockId,
  onBlockFocus,
  onOpenLineageNode,
  copilotOpen,
  onCopilotChange,
  onRunChange,
}: {
  appId: string;
  dashboard: DashboardDocumentResponse['dashboard'];
  variables?: Record<string, unknown>;
  editable?: boolean;
  onDashboardChanged?: (dashboard: DashboardDocumentResponse['dashboard']) => void;
  selectedBlockId?: string | null;
  onBlockFocus?: (blockId: string) => void;
  onOpenLineageNode?: (nodeId: string) => void;
  copilotOpen?: boolean;
  onCopilotChange?: (open: boolean) => void;
  onRunChange?: (run: DashboardRunResponse | null) => void;
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
  const [textDialogKind, setTextDialogKind] = useState<'text' | 'heading' | null>(null);
  const [textDialogValue, setTextDialogValue] = useState('');
  const gridRef = useRef<HTMLDivElement | null>(null);
  const cols = dashboard.layout.cols;
  const rowHeight = dashboard.layout.rowHeight;
  const variablesKey = useMemo(() => JSON.stringify(variables ?? {}), [variables]);
  const runVariables = useMemo<Record<string, unknown>>(() => JSON.parse(variablesKey), [variablesKey]);
  const tileResults = useMemo(() => {
    const map = new Map<string, DashboardRunResponse['tiles'][number]>();
    for (const tile of run?.tiles ?? []) map.set(tile.tileId, tile);
    return map;
  }, [run]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.runDashboard(appId, dashboard.id, runVariables).then((result) => {
      if (cancelled) return;
      setRun(result);
      onRunChange?.(result);
      if (!result) setError('Dashboard run failed.');
    }).catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err));
        onRunChange?.(null);
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [appId, dashboard.id, dashboard.layout.items.length, onRunChange, runVariables, state.activePersona?.userId]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ appId?: string; dashboardId?: string }>).detail;
      if (detail?.appId !== appId || detail.dashboardId !== dashboard.id) return;
      void api.getDashboard(appId, dashboard.id).then((next) => {
        if (next?.dashboard) onDashboardChanged?.(next.dashboard);
      });
      void api.runDashboard(appId, dashboard.id, runVariables).then((nextRun) => {
        if (nextRun) {
          setRun(nextRun);
          onRunChange?.(nextRun);
        }
      });
    };
    window.addEventListener('dql-app-dashboard-updated', handler);
    return () => window.removeEventListener('dql-app-dashboard-updated', handler);
  }, [appId, dashboard.id, onDashboardChanged, onRunChange, runVariables]);

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
        columns: tile?.result?.columns?.slice(0, 8),
        sampleRows: sampleRows(tile?.result?.rows, tile?.result?.columns),
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
      variables: runVariables,
      tiles,
    }, null, 2);
  }, [appId, dashboard, runVariables, tileResults]);

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
    const vizType = normalizeViz(block.chartType);
    const size = autoTileSizeForViz(vizType, cols);
    const tile = {
      i: nextTileId(dashboard, block.name),
      ...nextTilePosition(dashboard, size),
      block: { blockId: block.name },
      viz: { type: vizType },
      title: block.name,
    };
    await saveItems([...dashboard.layout.items, tile]);
    setCatalogOpen(false);
  }, [cols, dashboard, saveItems]);

  const addTextTile = useCallback(async () => {
    setTextDialogKind('text');
    setTextDialogValue('');
  }, []);

  const addHeadingTile = useCallback(async () => {
    setTextDialogKind('heading');
    setTextDialogValue('');
  }, []);

  const saveTextTile = useCallback(async () => {
    const value = textDialogValue.trim();
    if (!value || !textDialogKind) return;
    if (textDialogKind === 'heading') {
      await saveItems([
        ...dashboard.layout.items,
        {
          i: nextTileId(dashboard, 'section'),
          ...nextTilePosition(dashboard, tileSizeForPreset('wide', cols, 'heading')),
          text: { markdown: value },
          viz: { type: 'heading' },
          title: value,
        },
      ]);
    } else {
      const title = value.split(/\r?\n/)[0]?.slice(0, 60) || 'Summary';
      await saveItems([
        ...dashboard.layout.items,
        {
          i: nextTileId(dashboard, 'text'),
          ...nextTilePosition(dashboard, tileSizeForPreset('standard', cols, 'text')),
          text: { markdown: value },
          viz: { type: 'text' },
          title,
        },
      ]);
    }
    setTextDialogKind(null);
    setTextDialogValue('');
  }, [cols, dashboard, saveItems, textDialogKind, textDialogValue]);

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

  const openLineage = useCallback(() => {
    if (onOpenLineageNode) {
      onOpenLineageNode(`dashboard:${appId}/${dashboard.id}`);
      return;
    }
    void loadLineage();
  }, [appId, dashboard.id, loadLineage, onOpenLineageNode]);

  const effectiveCopilotOpen = onCopilotChange ? Boolean(copilotOpen) : chatOpen;
  const openCopilot = useCallback(() => {
    setAddMenuOpen(false);
    if (onCopilotChange) {
      onCopilotChange(true);
      return;
    }
    setChatOpen(true);
  }, [onCopilotChange]);
  const toggleCopilot = useCallback(() => {
    setAddMenuOpen(false);
    if (onCopilotChange) {
      onCopilotChange(!copilotOpen);
      return;
    }
    setChatOpen((value) => !value);
  }, [copilotOpen, onCopilotChange]);

  return (
    <div style={{ display: 'block', minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
      <div style={dashboardToolbarStyle}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 20, lineHeight: 1.18, fontWeight: 780 }}>{dashboard.metadata.title}</h2>
        {dashboard.metadata.description ? (
          <div style={{ fontSize: 13, opacity: 0.72, marginTop: 4, maxWidth: 680, lineHeight: 1.4 }}>
            {dashboard.metadata.description}
          </div>
        ) : null}
        </div>
        {editable && dashboard.layout.items.length > 0 && (
          <AddTileMenu
            open={addMenuOpen}
            onToggle={() => setAddMenuOpen((value) => !value)}
            buttonLabel="Add tile"
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
            onAi={openCopilot}
          />
        )}
        {editable && dashboard.layout.items.length > 0 && (
          <span style={dashboardEditStatusStyle}>{saving ? 'Saving...' : `${dashboard.layout.items.length} tiles`}</span>
        )}
        <button
          type="button"
          onClick={toggleCopilot}
          style={toolbarButtonStyle(effectiveCopilotOpen)}
        >
          <Bot size={14} strokeWidth={2} />
          {effectiveCopilotOpen ? 'Hide copilot' : 'AI Copilot'}
        </button>
        <button type="button" onClick={openLineage} style={toolbarButtonStyle(false)} title="Open focused dashboard lineage">
          <GitBranch size={14} strokeWidth={2} />
          Lineage
        </button>
      </div>
      {editable && <div style={dashboardEditHintStyle}>Drag tiles, select a block to research it, or use the tile controls for sizing and chart settings.</div>}

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
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Build this dashboard page</div>
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
              onAi={openCopilot}
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
              selected={Boolean(getDashboardItemBlockId(item) && getDashboardItemBlockId(item) === selectedBlockId)}
              onFocusBlock={onBlockFocus}
              onMove={(point) => void moveTileToPoint(item.i, point)}
              onPatch={(patch) => void patchTile(item.i, patch)}
            />
          ))}
        </div>
      )}
      </div>

      {lineageOpen && !onOpenLineageNode && (
        <aside style={{ width: 340, minWidth: 300, maxWidth: '34vw', border: '1px solid var(--border-color, rgba(0,0,0,0.08))', borderRadius: 8, overflow: 'auto', alignSelf: 'flex-start', height: SIDE_PANEL_HEIGHT, position: 'sticky', top: 12, padding: 12 }}>
          <ScopedLineagePanel lineage={lineage} />
        </aside>
      )}

      {chatOpen && !onCopilotChange && (
        <aside style={dashboardChatDrawerStyle(chatExpanded)}>
          <AgentChatPanel
            title="Dashboard AI"
            scopeHint="Scoped to this App dashboard first"
            upstreamContext={chatContext}
            themeMode={state.themeMode}
            hideSqlByDefault
            addToAppTarget={{ appId, dashboardId: dashboard.id }}
            conversationTarget={{ appId, dashboardId: dashboard.id }}
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
      {textDialogKind && (
        <TextTileDialog
          kind={textDialogKind}
          value={textDialogValue}
          onChange={setTextDialogValue}
          onClose={() => {
            setTextDialogKind(null);
            setTextDialogValue('');
          }}
          onSave={() => void saveTextTile()}
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
  selected,
  onFocusBlock,
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
  selected?: boolean;
  onFocusBlock?: (blockId: string) => void;
  onMove: (point: { clientX: number; clientY: number }) => void;
  onPatch: (patch: Partial<DashboardDocumentResponse['dashboard']['layout']['items'][number]> | null) => void;
}): JSX.Element {
  const tileRef = useRef<HTMLDivElement | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const blockId = getDashboardItemBlockId(item);
  const blockRef = blockId
    ? `block:${blockId}`
    : item.aiPin
      ? `aiPin:${item.aiPin.id}`
      : 'text';
  const vizType = normalizeViz(String(item.viz.type ?? 'table'));
  const isCompactMetric = item.h <= 2 && (vizType === 'single_value' || vizType === 'kpi' || vizType === 'gauge');
  const [hovered, setHovered] = useState(false);
  const showEditChrome = editable && (hovered || selected || settingsOpen);
  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
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
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => {
        if (blockId) onFocusBlock?.(blockId);
      }}
      style={{
        gridColumn: `${item.x + 1} / span ${item.w}`,
        gridRow: `${item.y + 1} / span ${item.h}`,
        transform: dragOffset ? `translate(${dragOffset.x}px, ${dragOffset.y}px)` : undefined,
        opacity: dragOffset ? 0.72 : 1,
        zIndex: dragOffset ? 20 : undefined,
        position: 'relative',
        background: 'var(--dql-app-surface, var(--surface, rgba(0,0,0,0.02)))',
        border: selected
          ? '1.5px solid var(--dql-app-accent, var(--accent, #4f46e5))'
          : '1px solid var(--dql-app-line, var(--border-color, rgba(0,0,0,0.08)))',
        borderRadius: 10,
        padding: isCompactMetric ? 12 : 14,
        display: 'flex',
        flexDirection: 'column',
        gap: isCompactMetric ? 4 : 6,
        minHeight: 0,
        overflow: 'visible',
        boxShadow: selected ? '0 0 0 3px var(--dql-app-accent-soft, rgba(79,70,229,0.12))' : undefined,
        cursor: blockId ? 'pointer' : undefined,
      }}
    >
      {editable ? (
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: 10,
            zIndex: 3,
            opacity: showEditChrome ? 1 : 0,
            pointerEvents: showEditChrome ? 'auto' : 'none',
            transition: 'opacity 120ms ease',
          }}
        >
            <button
              type="button"
              title="Drag to move tile"
              onPointerDown={startDrag}
              style={dragHandleButtonStyle}
            >
              <GripVertical size={14} strokeWidth={2.2} />
            </button>
        </div>
      ) : null}
      {editable ? (
          <div
            style={{
              position: 'absolute',
              top: 10,
              right: 10,
              zIndex: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              opacity: showEditChrome ? 1 : 0,
              pointerEvents: showEditChrome ? 'auto' : 'none',
              transition: 'opacity 120ms ease',
            }}
          >
            {!isCompactMetric ? (
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
            ) : null}
            <TileEditorControls
              item={item}
              cols={cols}
              settingsOpen={settingsOpen}
              onToggleSettings={() => setSettingsOpen((value) => !value)}
              onPatch={onPatch}
            />
          </div>
        ) : null}
      <div
        style={{
          minHeight: isCompactMetric ? 22 : 26,
          paddingLeft: showEditChrome ? 30 : 0,
          paddingRight: showEditChrome ? (isCompactMetric ? 82 : 134) : 0,
          transition: 'padding 120ms ease',
        }}
      >
        <div style={{ fontSize: isCompactMetric ? 12 : 13, fontWeight: 720, lineHeight: 1.25, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.title ?? blockRef}
        </div>
        {!isCompactMetric ? (
          <div style={{ marginTop: 5, fontSize: 10.5, opacity: 0.58, fontFamily: 'var(--font-mono, monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{blockRef}</div>
        ) : null}
      </div>
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
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: isCompactMetric ? 0 : 2,
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
  onPatch,
}: {
  item: DashboardDocumentResponse['dashboard']['layout']['items'][number];
  cols: number;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  onPatch: (patch: Partial<DashboardDocumentResponse['dashboard']['layout']['items'][number]> | null) => void;
}) {
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);
  const applyPreset = (preset: TileSizePresetId) => {
    setSizeMenuOpen(false);
    onPatch(tileSizePatch(item, cols, preset));
  };
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          title="Choose tile size"
          onClick={() => setSizeMenuOpen((value) => !value)}
          style={iconTileButtonStyle}
        >
          <Maximize2 size={13} strokeWidth={2} />
        </button>
        {sizeMenuOpen ? (
          <TileSizeMenu
            onPick={applyPreset}
            onClose={() => setSizeMenuOpen(false)}
          />
        ) : null}
      </div>
      <button
        type="button"
        title="Chart and field settings"
        onClick={onToggleSettings}
        style={iconTileButtonStyle}
      >
        <SlidersHorizontal size={13} strokeWidth={2} color={settingsOpen ? 'var(--accent, #4f46e5)' : undefined} />
      </button>
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

function TileSizeMenu({
  onPick,
  onClose,
}: {
  onPick: (preset: TileSizePresetId) => void;
  onClose: () => void;
}) {
  return (
    <div
      style={tileSizeMenuStyle}
      onMouseLeave={onClose}
    >
      {TILE_SIZE_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          onClick={() => onPick(preset.id)}
          style={tileSizeMenuItemStyle}
        >
          <span style={{ fontSize: 12, fontWeight: 750 }}>{preset.label}</span>
          <span style={{ fontSize: 11, opacity: 0.66 }}>{preset.description}</span>
        </button>
      ))}
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

  return (
    <div style={tileSettingsPanelStyle}>
      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', opacity: 0.58 }}>Tile size</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {TILE_SIZE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              title={preset.description}
              onClick={() => onPatch(tileSizePatch(item, cols, preset.id))}
              style={sizePresetChipStyle(presetMatches(item, cols, preset.id))}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
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
        {buttonLabel === 'Add tile' ? <Plus size={14} strokeWidth={2} /> : null}
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

function TextTileDialog({
  kind,
  value,
  onChange,
  onClose,
  onSave,
}: {
  kind: 'text' | 'heading';
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const isHeading = kind === 'heading';
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,0.36)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: 'min(520px, 92vw)', display: 'grid', gap: 12, background: 'var(--color-bg, #fff)', color: 'inherit', borderRadius: 8, boxShadow: '0 18px 60px rgba(0,0,0,0.35)', padding: 16 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>{isHeading ? 'Add heading' : 'Add text tile'}</div>
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>
            {isHeading ? 'Create a section heading on this dashboard page.' : 'Create a narrative text tile on this dashboard page.'}
          </div>
        </div>
        {isHeading ? (
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSave();
              if (event.key === 'Escape') onClose();
            }}
            placeholder="Executive summary"
            autoFocus
            style={dialogInputStyle}
          />
        ) : (
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onSave();
            }}
            placeholder="Add context, assumptions, or decisions..."
            rows={6}
            autoFocus
            style={{ ...dialogInputStyle, resize: 'vertical', lineHeight: 1.45 }}
          />
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} style={toolbarButtonStyle(false)}>Cancel</button>
          <button type="button" onClick={onSave} disabled={!value.trim()} style={{ ...primaryBuilderButtonStyle, opacity: value.trim() ? 1 : 0.65 }}>
            Add
          </button>
        </div>
      </div>
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
        <div style={{ fontSize: 12, opacity: 0.72 }}>Terms and business views connect the App back to DQL blocks, dbt models, and source tables.</div>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span
                style={{
                  color: '#0d1117',
                  background: NODE_TYPE_COLORS[node.type] ?? '#8b949e',
                  borderRadius: 3,
                  padding: '1px 4px',
                  fontSize: 9,
                  fontWeight: 800,
                  flexShrink: 0,
                }}
              >
                {TYPE_LABELS[node.type] ?? node.type.slice(0, 4).toUpperCase()}
              </span>
              <div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</div>
            </div>
            <div style={{ fontSize: 11, opacity: 0.62, fontFamily: 'monospace', marginTop: 4 }}>
              {TYPE_TITLES[node.type] ?? node.type} · {node.id}
            </div>
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

function getDashboardItemBlockId(item: DashboardLayoutItem): string | null {
  if (!item.block) return null;
  return 'blockId' in item.block ? item.block.blockId ?? null : item.block.ref ?? null;
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
    colorPalette: options.colorPalette ?? base?.colorPalette ?? 'corporate',
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
    border: '1px solid var(--dql-app-line, var(--border-color, rgba(0,0,0,0.12)))',
    borderRadius: 8,
    background: active ? 'var(--dql-app-accent-soft, var(--surface-hover, rgba(0,0,0,0.06)))' : 'var(--dql-app-surface, var(--surface, rgba(0,0,0,0.02)))',
    color: 'inherit',
    padding: '7px 10px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 720,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    minHeight: 32,
  };
}

const dashboardToolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 10,
  padding: '10px 12px',
  border: '1px solid var(--dql-app-line, var(--border-color, rgba(0,0,0,0.08)))',
  borderRadius: 10,
  background: 'var(--dql-app-surface, var(--surface, rgba(255,255,255,0.82)))',
  boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
};

const dashboardEditStatusStyle: CSSProperties = {
  border: '1px solid var(--dql-app-line, var(--border-color, rgba(0,0,0,0.1)))',
  borderRadius: 999,
  background: 'var(--dql-app-control, rgba(0,0,0,0.04))',
  color: 'var(--dql-app-muted, rgba(0,0,0,0.62))',
  padding: '5px 9px',
  fontSize: 11,
  fontWeight: 750,
  whiteSpace: 'nowrap',
};

const dashboardEditHintStyle: CSSProperties = {
  marginBottom: 12,
  color: 'var(--dql-app-muted, var(--color-text-secondary, rgba(0,0,0,0.64)))',
  fontSize: 12,
  lineHeight: 1.45,
};

function dashboardChatDrawerStyle(expanded: boolean): CSSProperties {
  return {
    position: 'fixed',
    right: 24,
    top: 76,
    bottom: 24,
    zIndex: 70,
    width: expanded ? 'min(760px, calc(100vw - 96px))' : 'min(420px, calc(100vw - 64px))',
    minWidth: 0,
    border: '1px solid var(--dql-app-line-2, var(--border-color, rgba(0,0,0,0.12)))',
    borderRadius: 10,
    overflow: 'hidden',
    boxShadow: '0 18px 60px rgba(15,23,42,0.22)',
    background: 'var(--dql-app-surface, var(--color-bg, #fff))',
  };
}

const dialogInputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 6,
  background: 'var(--surface, transparent)',
  color: 'inherit',
  fontSize: 12,
  padding: '8px 10px',
};

const primaryBuilderButtonStyle: CSSProperties = {
  border: '1px solid var(--accent, #4f46e5)',
  borderRadius: 6,
  background: 'var(--accent, #4f46e5)',
  color: 'var(--color-text-on-accent, #fff)',
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
  cursor: 'pointer',
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const dragHandleButtonStyle: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 6,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  background: 'var(--surface, rgba(255,255,255,0.72))',
  color: 'inherit',
  cursor: 'grab',
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const tileSizeMenuStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  zIndex: 40,
  width: 240,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  borderRadius: 8,
  background: 'var(--color-bg, #fff)',
  boxShadow: '0 14px 38px rgba(0,0,0,0.16)',
  padding: 6,
  display: 'grid',
  gap: 4,
};

const tileSizeMenuItemStyle: CSSProperties = {
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  padding: '8px 9px',
  cursor: 'pointer',
  textAlign: 'left',
  display: 'grid',
  gap: 2,
};

function sizePresetChipStyle(active: boolean): CSSProperties {
  return {
    border: `1px solid ${active ? 'var(--accent, #4f46e5)' : 'var(--border-color, rgba(0,0,0,0.12))'}`,
    borderRadius: 999,
    background: active ? 'var(--color-bg-active, rgba(79,70,229,0.12))' : 'var(--surface, rgba(0,0,0,0.02))',
    color: active ? 'var(--accent, #4f46e5)' : 'inherit',
    padding: '4px 8px',
    fontSize: 11,
    fontWeight: active ? 750 : 600,
    cursor: 'pointer',
  };
}

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
    color: active ? 'var(--color-text-on-accent, #fff)' : 'inherit',
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

function autoTileSizeForViz(vizType: string, cols: number): { w: number; h: number } {
  const normalized = normalizeViz(vizType);
  if (normalized === 'heading') return tileSizeForPreset('wide', cols, 'heading');
  if (normalized === 'text') return tileSizeForPreset('standard', cols, 'text');
  if (normalized === 'single_value' || normalized === 'kpi' || normalized === 'gauge') {
    return tileSizeForPreset('compact', cols, normalized);
  }
  if (normalized === 'table' || normalized === 'pivot') return tileSizeForPreset('tall', cols, normalized);
  if (normalized === 'line' || normalized === 'area') return tileSizeForPreset('wide', cols, normalized);
  return tileSizeForPreset('standard', cols, normalized);
}

function tileSizeForPreset(preset: TileSizePresetId, cols: number, vizType = 'table'): { w: number; h: number } {
  const safeCols = Math.max(1, cols);
  const half = Math.max(1, Math.ceil(safeCols / 2));
  const third = Math.max(1, Math.ceil(safeCols / 3));
  if (preset === 'auto') return autoTileSizeForViz(vizType, safeCols);
  if (preset === 'compact') return { w: third, h: 2 };
  if (preset === 'wide') return { w: safeCols, h: vizType === 'heading' ? 1 : 4 };
  if (preset === 'tall') return { w: half, h: 6 };
  if (preset === 'full') return { w: safeCols, h: 7 };
  return { w: half, h: vizType === 'text' ? 2 : 4 };
}

function tileSizePatch(item: DashboardLayoutItem, cols: number, preset: TileSizePresetId): Partial<DashboardLayoutItem> {
  const vizType = String(item.viz.type ?? 'table');
  const size = preset === 'auto'
    ? autoTileSizeForViz(vizType, cols)
    : tileSizeForPreset(preset, cols, vizType);
  return {
    w: size.w,
    h: size.h,
    x: clamp(item.x, 0, Math.max(0, cols - size.w)),
  };
}

function presetMatches(item: DashboardLayoutItem, cols: number, preset: TileSizePresetId): boolean {
  if (preset === 'auto') return false;
  const size = tileSizeForPreset(preset, cols, String(item.viz.type ?? 'table'));
  return item.w === size.w && item.h === size.h;
}

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
  if (value === 'single_value' || value === 'kpi' || value === 'gauge' || value === 'line' || value === 'bar' || value === 'area'
    || value === 'pie' || value === 'pivot' || value === 'map' || value === 'funnel' || value === 'heading' || value === 'text') {
    return value;
  }
  return 'table';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
