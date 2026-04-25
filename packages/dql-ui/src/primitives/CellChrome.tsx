// v1.3 Track 6 — Hex-style cell chrome primitive.
//
// CellChrome is the shared visual wrapper around every notebook cell body.
// It renders the card (rounded rect, 1px border, subtle left accent) and the
// header row (muted type label top-left, trust badge, status, actions).
//
// The cell-body content is injected via children; the header content is
// composed via the `typeLabel`, `typeColor`, `trustBadge`, `actions`, and
// `status` slots so each call site stays thin.
//
// Consumers drop their existing outermost <div> and wrap the body in:
//
//   <CellChrome
//     typeLabel="SQL"
//     typeColor="#388bfd"
//     accent={borderColor}
//     status={<ExecutionBadge ... />}
//     actions={<>…</>}
//     onMouseEnter={...} onMouseLeave={...}
//   >
//     {/* body editor + output */}
//   </CellChrome>
//
// State-driven visuals (idle / running / error) are controlled via the
// `accent` prop — the accent tints the left border. Hover surfaces go
// through the full border via the `hoverAccent` prop.

import React from 'react';
import type { TrustState } from './TrustBadge.js';

export interface CellChromeProps {
  /** Short uppercase label shown top-left. "SQL", "CHART", "PIVOT", etc. */
  typeLabel: string;
  /** Accent color for the type pill (solid text + tinted background). */
  typeColor?: string;
  /** Border/left-edge accent color. Drives run/error state. */
  accent?: string;
  /** Border color when the cell is not focused or running. */
  idleBorder?: string;
  /** Background color of the card body. */
  background?: string;
  /** Background color of the header row. */
  headerBackground?: string;
  /** Whether the border should use `accent` (hover or running). */
  active?: boolean;
  /** Optional name / title shown after the type label. */
  title?: React.ReactNode;
  /** Trust state hint; plug slot for v1.4. */
  trustState?: TrustState;
  /** Right-side status pill (execution badge). */
  status?: React.ReactNode;
  /** Right-side action row (Run, overflow, save-as-block). */
  actions?: React.ReactNode;
  /** Left-side action row after the type label. */
  toolbar?: React.ReactNode;
  /** Optional row under the header (binding chip, governance bar). */
  subheader?: React.ReactNode;
  /** Output row (table / chart / error panel). */
  footer?: React.ReactNode;
  /** Main body (editor). */
  children?: React.ReactNode;

  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;

  /** Render a gutter column to the left (matches existing ExecutionBadge layout). */
  gutter?: React.ReactNode;

  className?: string;
  style?: React.CSSProperties;
}

export function CellChrome({
  typeLabel,
  typeColor,
  accent,
  idleBorder,
  background,
  headerBackground,
  active = false,
  title,
  status,
  actions,
  toolbar,
  subheader,
  footer,
  children,
  onMouseEnter,
  onMouseLeave,
  onClick,
  gutter,
  className,
  style,
}: CellChromeProps) {
  const pillColor = typeColor ?? 'var(--color-accent-blue, #388bfd)';
  const edge = accent ?? idleBorder ?? 'var(--color-border-subtle, rgba(148,163,184,0.18))';
  const idle = idleBorder ?? 'var(--color-border-subtle, rgba(148,163,184,0.18))';
  const bg = background ?? 'var(--color-bg-1, rgba(22,27,34,0.5))';
  const headerBg = headerBackground ?? 'transparent';

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      className={className}
      style={{
        display: 'flex',
        gap: 0,
        marginBottom: 2,
        ...style,
      }}
    >
      {gutter !== undefined && gutter}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          borderRadius: 8,
          border: `1px solid ${active ? edge : idle}`,
          background: bg,
          overflow: 'hidden',
          transition: 'border-color 0.2s, box-shadow 0.2s',
          boxShadow: active
            ? `0 0 0 3px ${pillColor}14, 0 1px 2px rgba(0,0,0,0.04)`
            : '0 1px 2px rgba(0,0,0,0.02)',
        }}
      >
        <div
          style={{
            minHeight: 32,
            display: 'flex',
            alignItems: 'center',
            padding: '8px 14px',
            gap: 8,
            background: headerBg,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: pillColor,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.2px',
              color: 'var(--color-text-secondary, #4a4a52)',
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            {typeLabel}
          </span>
          {title !== undefined && (
            <>
              <span style={{ color: 'var(--color-text-tertiary, #8a8d96)', fontSize: 11 }}>·</span>
              {title}
            </>
          )}
          {toolbar !== undefined && toolbar}
          <span style={{ flex: 1 }} />
          {status !== undefined && status}
          {actions !== undefined && actions}
        </div>
        {subheader !== undefined && subheader}
        {children}
        {footer !== undefined && footer}
      </div>
    </div>
  );
}
