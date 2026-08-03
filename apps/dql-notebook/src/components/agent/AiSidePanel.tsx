import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Loader2, Maximize2, MessageSquarePlus, Minimize2, Sparkles, X } from 'lucide-react';
import type { Theme } from '../../themes/notebook-theme';

export const AI_SIDE_PANEL_WIDTH = 420;
export const AI_SIDE_PANEL_EXPANDED_WIDTH = 720;

interface AiSidePanelProps {
  t: Theme;
  title: string;
  subtitle: string;
  children: ReactNode;
  onClose: () => void;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  onNewChat?: () => void;
  headerActions?: ReactNode;
  running?: boolean;
  compact?: boolean;
  floating?: boolean;
  /** Let the user drag the panel's left edge when a wide result needs more room. */
  resizable?: boolean;
  minResizeWidth?: number;
  maxResizeWidth?: number;
  /** Fit the panel between its live top edge and the viewport bottom. */
  fitViewportHeight?: boolean;
  /** Let the user drag the bottom edge to adjust the visible conversation area. */
  heightResizable?: boolean;
  minResizeHeight?: number;
  maxResizeHeight?: number;
  /**
   * How the panel sits in its surface. Geometry lives HERE, not in each caller,
   * so Notebook AI / Block AI / App AI are literally the same panel at the same
   * size. They previously hand-rolled their own widths (520 vs 420 vs CSS), so
   * the "same" copilot looked different on every screen.
   */
  dock?: 'column' | 'overlay';
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

/** Shared right-side AI chrome used by Notebook, Block Studio, Apps, and dashboards. */
export function AiSidePanel({
  t,
  title,
  subtitle,
  children,
  onClose,
  expanded = false,
  onToggleExpanded,
  onNewChat,
  headerActions,
  running = false,
  compact = false,
  floating = false,
  resizable = false,
  minResizeWidth = 360,
  maxResizeWidth,
  fitViewportHeight = false,
  heightResizable = false,
  minResizeHeight = 420,
  maxResizeHeight,
  dock = 'column',
  ariaLabel = title,
  className,
  style,
}: AiSidePanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [manualWidth, setManualWidth] = useState<number | null>(null);
  const [manualHeight, setManualHeight] = useState<number | null>(null);
  const [viewportFitHeight, setViewportFitHeight] = useState<number | null>(null);
  const [resizingWidth, setResizingWidth] = useState(false);
  const [resizingHeight, setResizingHeight] = useState(false);

  const clampWidth = useCallback((width: number) => {
    const viewportMaximum = typeof window === 'undefined'
      ? Math.max(minResizeWidth, maxResizeWidth ?? AI_SIDE_PANEL_EXPANDED_WIDTH)
      : Math.max(minResizeWidth, window.innerWidth - 96);
    return Math.min(Math.max(width, minResizeWidth), Math.min(maxResizeWidth ?? viewportMaximum, viewportMaximum));
  }, [maxResizeWidth, minResizeWidth]);

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizable || !panelRef.current) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelRef.current.getBoundingClientRect().width;
    setResizingWidth(true);
    const onMove = (moveEvent: PointerEvent) => {
      setManualWidth(clampWidth(startWidth + startX - moveEvent.clientX));
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      dragCleanupRef.current = null;
      setResizingWidth(false);
    };
    dragCleanupRef.current?.();
    dragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  }, [clampWidth, resizable]);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const availableHeightAt = useCallback((top: number) => {
    if (typeof window === 'undefined') return maxResizeHeight ?? AI_SIDE_PANEL_EXPANDED_WIDTH;
    return Math.max(240, Math.min(maxResizeHeight ?? Number.POSITIVE_INFINITY, window.innerHeight - Math.max(0, top) - 16));
  }, [maxResizeHeight]);

  const clampHeight = useCallback((height: number, top?: number) => {
    const available = availableHeightAt(top ?? panelRef.current?.getBoundingClientRect().top ?? 0);
    const safeMinimum = Math.min(minResizeHeight, available);
    return Math.min(Math.max(height, safeMinimum), available);
  }, [availableHeightAt, minResizeHeight]);

  useEffect(() => {
    if (!fitViewportHeight) {
      setViewportFitHeight(null);
      return undefined;
    }
    let frame: number | null = null;
    const update = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const top = panelRef.current?.getBoundingClientRect().top ?? 0;
        // A stacked mobile/tablet panel can begin below the current viewport.
        // Keep its surface-owned height until it actually enters view.
        const nextHeight = top < window.innerHeight - 80 ? availableHeightAt(top) : null;
        setViewportFitHeight(nextHeight);
        if (nextHeight !== null) {
          setManualHeight((current) => current === null ? current : clampHeight(current, top));
        }
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [availableHeightAt, clampHeight, fitViewportHeight]);

  const adjustWidthFromKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!resizable || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    const current = manualWidth ?? panelRef.current?.getBoundingClientRect().width ?? AI_SIDE_PANEL_WIDTH;
    setManualWidth(clampWidth(current + (event.key === 'ArrowLeft' ? 40 : -40)));
  }, [clampWidth, manualWidth, resizable]);

  const startHeightResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!heightResizable || !panelRef.current) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = panelRef.current.getBoundingClientRect().height;
    setResizingHeight(true);
    const onMove = (moveEvent: PointerEvent) => {
      setManualHeight(clampHeight(startHeight + moveEvent.clientY - startY));
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      dragCleanupRef.current = null;
      setResizingHeight(false);
    };
    dragCleanupRef.current?.();
    dragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  }, [clampHeight, heightResizable]);

  const adjustHeightFromKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!heightResizable) return;
    if (event.key === 'Enter' || event.key === 'Home') {
      event.preventDefault();
      setManualHeight(null);
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const current = manualHeight ?? panelRef.current?.getBoundingClientRect().height ?? viewportFitHeight ?? minResizeHeight;
    setManualHeight(clampHeight(current + (event.key === 'ArrowDown' ? 40 : -40)));
  }, [clampHeight, heightResizable, manualHeight, minResizeHeight, viewportFitHeight]);

  const toggleExpanded = useCallback(() => {
    setManualWidth(null);
    onToggleExpanded?.();
  }, [onToggleExpanded]);

  return (
    <aside
      ref={panelRef}
      aria-label={ariaLabel}
      className={className}
      data-ai-side-panel="true"
      data-expanded={expanded ? 'true' : 'false'}
      data-resizable={resizable ? 'true' : 'false'}
      data-height-resizable={heightResizable ? 'true' : 'false'}
      data-height-mode={manualHeight !== null ? 'manual' : fitViewportHeight ? 'viewport' : 'surface'}
      style={{
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: t.cellBg,
        ...(dock === 'overlay' && !compact
          ? {
              position: 'absolute' as const,
              inset: '0 0 0 auto',
              zIndex: 30,
              width: expanded
                ? `min(${AI_SIDE_PANEL_EXPANDED_WIDTH}px, calc(100% - 40px))`
                : `min(${AI_SIDE_PANEL_WIDTH}px, calc(100% - 40px))`,
              maxWidth: expanded ? '72vw' : '52vw',
              minWidth: Math.min(AI_SIDE_PANEL_WIDTH, 400),
              flex: '0 0 auto',
              boxShadow: '-16px 0 36px rgba(0,0,0,0.18)',
            }
          : {}),
        ...(dock === 'overlay' && compact
          ? { position: 'relative' as const, width: '100%', flex: '0 0 auto' }
          : {}),
        borderLeft: compact ? 'none' : `1px solid ${t.headerBorder}`,
        border: floating ? `1px solid ${t.headerBorder}` : undefined,
        borderRadius: floating ? 12 : undefined,
        boxShadow: floating ? '0 18px 60px rgba(15, 23, 42, 0.22)' : undefined,
        transition: 'width 180ms ease, max-width 180ms ease',
        ...style,
        ...(manualWidth !== null
          ? {
              width: manualWidth,
              maxWidth: maxResizeWidth ?? 'calc(100vw - 96px)',
              flexBasis: manualWidth,
              transition: resizingWidth ? 'none' : 'width 120ms ease, max-width 120ms ease',
            }
          : {}),
        ...((manualHeight ?? viewportFitHeight) !== null
          ? {
              height: manualHeight ?? viewportFitHeight ?? undefined,
              minHeight: Math.min(minResizeHeight, manualHeight ?? viewportFitHeight ?? minResizeHeight),
              maxHeight: manualHeight ?? viewportFitHeight ?? undefined,
              transition: resizingHeight ? 'none' : 'height 120ms ease, max-height 120ms ease',
            }
          : {}),
      }}
    >
      {resizable ? (
        <div
          role="separator"
          aria-label={`Resize ${title}`}
          aria-orientation="vertical"
          tabIndex={0}
          title={`Drag to resize ${title}. Use left and right arrow keys for precise adjustment.`}
          onPointerDown={startResize}
          onKeyDown={adjustWidthFromKeyboard}
          style={{
            position: 'absolute',
            inset: '0 auto 0 -5px',
            width: 10,
            zIndex: 4,
            cursor: 'col-resize',
            outline: 'none',
            touchAction: 'none',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 4,
              top: '42%',
              width: 2,
              height: 48,
              borderRadius: 999,
              background: resizingWidth ? t.accent : t.headerBorder,
              transition: 'background 120ms ease',
            }}
          />
        </div>
      ) : null}
      {heightResizable ? (
        <div
          role="separator"
          aria-label={`Resize ${title} height`}
          aria-orientation="horizontal"
          tabIndex={0}
          title={`Drag to adjust ${title} height. Use up and down arrow keys; press Enter to fit the viewport.`}
          onPointerDown={startHeightResize}
          onDoubleClick={() => setManualHeight(null)}
          onKeyDown={adjustHeightFromKeyboard}
          style={{
            position: 'absolute',
            inset: 'auto 0 -5px 0',
            height: 10,
            zIndex: 4,
            cursor: 'row-resize',
            outline: 'none',
            touchAction: 'none',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 'calc(50% - 24px)',
              top: 4,
              width: 48,
              height: 2,
              borderRadius: 999,
              background: resizingHeight ? t.accent : t.headerBorder,
              transition: 'background 120ms ease',
            }}
          />
        </div>
      ) : null}
      <div
        style={{
          minHeight: 52,
          padding: '9px 12px',
          borderBottom: `1px solid ${t.headerBorder}`,
          background: t.cellBg,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flex: '0 0 auto',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: `${t.accent}14`,
            border: `1px solid ${t.accent}36`,
            color: t.accent,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: '0 0 auto',
          }}
        >
          <Sparkles size={16} strokeWidth={2.1} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: t.textPrimary, fontFamily: t.font }}>
              {title}
            </span>
            {running ? <Loader2 size={12} aria-label="AI is working" style={{ color: t.accent, animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> : null}
          </div>
          <div
            title={subtitle}
            style={{
              marginTop: 2,
              color: t.textMuted,
              fontSize: 11,
              fontFamily: t.font,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {subtitle}
          </div>
        </div>

        {headerActions}
        {onNewChat ? (
          <AiSidePanelAction t={t} label="New AI chat" onClick={onNewChat}>
            <MessageSquarePlus size={15} strokeWidth={2} />
          </AiSidePanelAction>
        ) : null}
        {!compact && onToggleExpanded ? (
          <AiSidePanelAction
            t={t}
            label={expanded ? 'Return AI panel to standard width' : 'Expand AI panel'}
            onClick={toggleExpanded}
          >
            {expanded ? <Minimize2 size={15} strokeWidth={2} /> : <Maximize2 size={15} strokeWidth={2} />}
          </AiSidePanelAction>
        ) : null}
        <AiSidePanelAction t={t} label={`Close ${title}`} onClick={onClose}>
          <X size={15} strokeWidth={2} />
        </AiSidePanelAction>
      </div>

      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {children}
      </div>
    </aside>
  );
}

export function AiSidePanelAction({
  t,
  label,
  onClick,
  active = false,
  children,
}: {
  t: Theme;
  label: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        width: 30,
        height: 30,
        borderRadius: 7,
        border: `1px solid ${active ? `${t.accent}66` : t.btnBorder}`,
        background: active ? `${t.accent}14` : t.btnBg,
        color: active ? t.accent : t.textSecondary,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
      }}
    >
      {children}
    </button>
  );
}
