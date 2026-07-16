import type { CSSProperties, ReactNode } from 'react';
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
  ariaLabel = title,
  className,
  style,
}: AiSidePanelProps) {
  return (
    <aside
      aria-label={ariaLabel}
      className={className}
      data-ai-side-panel="true"
      data-expanded={expanded ? 'true' : 'false'}
      style={{
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: t.cellBg,
        borderLeft: compact ? 'none' : `1px solid ${t.headerBorder}`,
        border: floating ? `1px solid ${t.headerBorder}` : undefined,
        borderRadius: floating ? 12 : undefined,
        boxShadow: floating ? '0 18px 60px rgba(15, 23, 42, 0.22)' : undefined,
        transition: 'width 180ms ease, max-width 180ms ease',
        ...style,
      }}
    >
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
            onClick={onToggleExpanded}
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
