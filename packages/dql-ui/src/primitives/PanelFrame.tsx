// v1.3 Track 4 — PanelFrame primitive set, TSX port of DataLex's PanelFrame.jsx.
//
// Shared primitives that every sidebar/drawer panel can adopt so they share
// one layout language (padding, section breathing, tone colors, table style)
// and track the active Luna theme automatically. All styles come from
// `packages/dql-ui/src/styles/panel.css`, which globals.css imports.
//
// Primitives:
//   PanelFrame    — root wrapper with header + optional toolbar + scroll body
//   PanelSection  — titled content group with count + trailing action
//   PanelCard     — labelled surface card with a semantic `tone`
//   StatusPill    — small pill badge
//   PanelEmpty    — centred icon + title + description for zero-states
//   PanelToolbar  — horizontal bar for search / filter controls
//   KeyValueGrid  — responsive 2-column label/value grid

import React from 'react';

type Tone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'error';

/* ──────────────────────────────────────────────────────────────────────── */
/* PanelFrame                                                               */
/* ──────────────────────────────────────────────────────────────────────── */
export interface PanelFrameProps {
  icon?: React.ReactNode;
  eyebrow?: React.ReactNode;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  toolbar?: React.ReactNode;
  bodyPadding?: number | string;
  children?: React.ReactNode;
}

export function PanelFrame({
  icon,
  eyebrow,
  title,
  subtitle,
  status,
  actions,
  toolbar,
  bodyPadding = 14,
  children,
}: PanelFrameProps) {
  return (
    <div className="panel-frame">
      <div className="panel-frame-header">
        <div className="panel-frame-heading">
          {icon && <span className="panel-frame-icon">{icon}</span>}
          <div className="panel-frame-title-col">
            {eyebrow && <div className="panel-frame-eyebrow">{eyebrow}</div>}
            <div className="panel-frame-title-row">
              {title && <h2 className="panel-frame-title">{title}</h2>}
              {status && <span className="panel-frame-status">{status}</span>}
            </div>
            {subtitle && <div className="panel-frame-subtitle">{subtitle}</div>}
          </div>
        </div>
        {actions && <div className="panel-frame-actions">{actions}</div>}
      </div>
      {toolbar && <div className="panel-frame-toolbar">{toolbar}</div>}
      <div className="panel-frame-body" style={{ padding: bodyPadding }}>
        {children}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* PanelSection                                                             */
/* ──────────────────────────────────────────────────────────────────────── */
export interface PanelSectionProps {
  title?: React.ReactNode;
  count?: number;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  description?: React.ReactNode;
  padded?: boolean;
  children?: React.ReactNode;
}

export function PanelSection({
  title,
  count,
  icon,
  action,
  description,
  padded = true,
  children,
}: PanelSectionProps) {
  return (
    <section className="panel-section">
      <header className="panel-section-header">
        <div className="panel-section-title-wrap">
          {icon && <span className="panel-section-icon">{icon}</span>}
          {title && <h3 className="panel-section-title">{title}</h3>}
          {typeof count === 'number' && <span className="panel-section-count">{count}</span>}
        </div>
        {action && <div className="panel-section-action">{action}</div>}
      </header>
      {description && <p className="panel-section-desc">{description}</p>}
      <div className={`panel-section-body ${padded ? 'padded' : ''}`}>{children}</div>
    </section>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* PanelCard                                                                */
/* ──────────────────────────────────────────────────────────────────────── */
export interface PanelCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: React.ReactNode;
  eyebrow?: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  tone?: Tone;
  dense?: boolean;
  children?: React.ReactNode;
}

export function PanelCard({
  title,
  eyebrow,
  subtitle,
  icon,
  actions,
  tone = 'neutral',
  dense = false,
  children,
  className = '',
  ...rest
}: PanelCardProps) {
  return (
    <div className={`panel-card tone-${tone} ${dense ? 'dense' : ''} ${className}`} {...rest}>
      {(title || eyebrow || subtitle || actions || icon) && (
        <div className="panel-card-header">
          <div className="panel-card-heading">
            {icon && <span className="panel-card-icon">{icon}</span>}
            <div className="panel-card-title-col">
              {eyebrow && <div className="panel-card-eyebrow">{eyebrow}</div>}
              {title && <div className="panel-card-title">{title}</div>}
              {subtitle && <div className="panel-card-subtitle">{subtitle}</div>}
            </div>
          </div>
          {actions && <div className="panel-card-actions">{actions}</div>}
        </div>
      )}
      {children != null && <div className="panel-card-body">{children}</div>}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* StatusPill                                                               */
/* ──────────────────────────────────────────────────────────────────────── */
export interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  icon?: React.ReactNode;
  children?: React.ReactNode;
}

export function StatusPill({
  tone = 'neutral',
  icon,
  children,
  className = '',
  ...rest
}: StatusPillProps) {
  return (
    <span className={`status-pill tone-${tone} ${className}`} {...rest}>
      {icon && <span className="status-pill-icon">{icon}</span>}
      {children}
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* PanelEmpty                                                               */
/* Self-contained zero-state. DataLex uses a shared EmptyState; DQL inlines */
/* it to avoid dragging in the rest of the DataLex shared-component tree.  */
/* ──────────────────────────────────────────────────────────────────────── */
export interface PanelEmptyProps {
  icon?: React.ReactNode;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}

export function PanelEmpty({ icon, title, description, action }: PanelEmptyProps) {
  return (
    <div className="panel-empty">
      {icon && <span className="panel-empty-icon">{icon}</span>}
      {title && <p className="panel-empty-title">{title}</p>}
      {description && <p className="panel-empty-desc">{description}</p>}
      {action}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* PanelToolbar                                                             */
/* ──────────────────────────────────────────────────────────────────────── */
export interface PanelToolbarProps {
  left?: React.ReactNode;
  right?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

export function PanelToolbar({ left, right, children, className = '' }: PanelToolbarProps) {
  return (
    <div className={`panel-toolbar ${className}`}>
      {left && <div className="panel-toolbar-left">{left}</div>}
      {children && <div className="panel-toolbar-center">{children}</div>}
      {right && <div className="panel-toolbar-right">{right}</div>}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* KeyValueGrid                                                             */
/* ──────────────────────────────────────────────────────────────────────── */
export interface KVItem {
  label: React.ReactNode;
  value: React.ReactNode;
}

export interface KeyValueGridProps {
  items?: KVItem[];
  columns?: 1 | 2;
  children?: React.ReactNode;
}

export function KeyValueGrid({ items, columns = 2, children }: KeyValueGridProps) {
  const gridTemplate = `repeat(auto-fit, minmax(${columns === 1 ? '100%' : '220px'}, 1fr))`;
  if (items && items.length > 0) {
    return (
      <dl className="panel-kv-grid" style={{ gridTemplateColumns: gridTemplate }}>
        {items.map((it, idx) => (
          <div key={idx} className="panel-kv-row">
            <dt className="panel-kv-label">{it.label}</dt>
            <dd className="panel-kv-value">{it.value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className="panel-kv-grid" style={{ gridTemplateColumns: gridTemplate }}>
      {children}
    </dl>
  );
}
