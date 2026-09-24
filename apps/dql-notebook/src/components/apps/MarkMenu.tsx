import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownRight, ExternalLink, EyeOff, Filter, Layers, MessageSquare, Rows3, Sparkles } from 'lucide-react';
import type { MarkActionId, MarkMenuItem } from './mark-actions';

const ICONS: Record<MarkActionId, typeof Filter> = {
  keep: Filter,
  exclude: EyeOff,
  'drill-down': ArrowDownRight,
  'drill-by': Layers,
  rows: Rows3,
  details: ExternalLink,
  explain: Sparkles,
  ask: MessageSquare,
};

/**
 * The menu a clicked mark opens at the pointer (RFC 0009 step 6a): what the
 * reader can do with this value. Arrow keys move, Enter picks, Esc closes.
 */
export function MarkMenu({
  heading,
  value,
  items,
  at,
  onPick,
  onClose,
}: {
  /** The mark as a reader names it, e.g. "Region US · January 2026". */
  heading: string;
  /** Its formatted measure value, when there is one. */
  value?: string;
  items: MarkMenuItem[];
  at: { x: number; y: number };
  onPick: (id: MarkActionId) => void;
  onClose: () => void;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: at.x, top: at.y });
  // Open beside the pointer and stay inside the window.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const left = Math.max(8, Math.min(at.x + 4, window.innerWidth - box.width - 8));
    const top = at.y + 4 + box.height > window.innerHeight - 8 ? Math.max(8, at.y - box.height - 4) : at.y + 4;
    setPosition({ left, top });
  }, [at.x, at.y]);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    const timer = window.setTimeout(() => document.addEventListener('mousedown', close), 0);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', onClose);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  const move = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={ref} className="dql-mark-menu" role="menu" aria-label={`Actions for ${heading}`} style={{ left: position.left, top: position.top }} onKeyDown={move}>
      <style>{MARK_MENU_STYLES}</style>
      <header>
        <strong>{heading}</strong>
        {value ? <span>{value}</span> : null}
      </header>
      {items.map((item) => {
        const Icon = ICONS[item.id];
        return (
          <button key={item.id} type="button" role="menuitem" disabled={Boolean(item.disabled)} title={item.disabled} onClick={() => onPick(item.id)}>
            <Icon size={14} aria-hidden="true" />
            <span><b>{item.label}</b>{item.hint ? <small>{item.disabled ?? item.hint}</small> : null}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

export const MARK_MENU_STYLES = `
.dql-mark-menu { position: fixed; z-index: 1000; width: 260px; display: grid; gap: 1px; padding: 6px; border: 1px solid var(--dql-app-line, var(--border-default)); border-radius: 12px; background: var(--dql-app-surface, var(--bg-2)); color: var(--dql-app-ink, var(--text-primary)); box-shadow: 0 12px 32px rgba(0,0,0,.18); font: 400 13px/1.35 var(--font-ui, inherit); font-variant-numeric: tabular-nums; }
.dql-mark-menu header { display: grid; gap: 2px; padding: 6px 8px 8px; margin-bottom: 2px; border-bottom: 1px solid var(--dql-app-line, var(--border-subtle)); }
.dql-mark-menu header strong { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.dql-mark-menu header span { color: var(--dql-app-muted, var(--text-secondary)); font-size: 12px; }
.dql-mark-menu button { display: grid; grid-template-columns: 16px minmax(0,1fr); align-items: start; gap: 10px; width: 100%; padding: 7px 8px; border: 0; border-radius: 8px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.dql-mark-menu button svg { margin-top: 1px; color: var(--dql-app-accent, var(--accent)); }
.dql-mark-menu button:hover:not(:disabled), .dql-mark-menu button:focus-visible { background: var(--dql-app-control, var(--bg-1)); outline: none; }
.dql-mark-menu button:disabled { cursor: default; opacity: .5; }
.dql-mark-menu button span { display: grid; gap: 1px; min-width: 0; }
.dql-mark-menu button b { font-weight: 500; overflow-wrap: anywhere; }
.dql-mark-menu button small { color: var(--dql-app-muted, var(--text-secondary)); font-size: 11px; }
`;
