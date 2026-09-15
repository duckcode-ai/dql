// Controls shared by the Modeling page and its editors (the relationship
// builder, the model and subject area editors).

import React, { useEffect, useRef, useState } from 'react';
import { Search, XCircle } from 'lucide-react';
import type { themes } from '../../themes/notebook-theme';
import { rankModelingOptions, type ModelingSearchOption } from './modeling-search';

type Theme = (typeof themes)['dark'];

/**
 * A centered dialog. It takes focus when it opens so Escape works without a
 * click first; `onClose` receives every close request (Escape, the close
 * button, a click on the backdrop), so an editor with unsaved input can ask
 * before discarding it.
 */
export function Modal({ title, t, onClose, children, width = 720 }: { title: string; t: Theme; onClose: () => void; children: React.ReactNode; width?: number }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
  }, []);
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#0008', display: 'grid', placeItems: 'center', padding: 20 }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}
        style={{ width: `min(${width}px, 94vw)`, maxHeight: '88vh', overflow: 'auto', background: t.appBg, border: `1px solid ${t.headerBorder}`, borderRadius: 12, boxShadow: '0 24px 80px #0006', outline: 'none' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '15px 18px', borderBottom: `1px solid ${t.headerBorder}` }}>
          <strong>{title}</strong>
          <button aria-label={`Close ${title}`} title="Close" onClick={onClose} style={iconButtonStyle(t)}>
            <XCircle size={17} />
          </button>
        </div>
        <div style={{ padding: 18 }}>{children}</div>
      </div>
    </div>
  );
}

/** A searchable single-choice picker for large option lists (models across a project). */
export function SearchPicker({ ariaLabel, value, onChange, options, placeholder, disabled = false, t }: { ariaLabel?: string; value: string; onChange: (value: string) => void; options: ModelingSearchOption[]; placeholder: string; disabled?: boolean; t: Theme }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = options.find((option) => option.value === value);
  const results = rankModelingOptions(options, query, 50);
  const listId = `modeling-search-results-${(ariaLabel ?? 'picker').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  return (
    <div style={{ position: 'relative', minWidth: 0 }}>
      <div style={{ position: 'relative' }}>
        <Search size={13} aria-hidden="true" style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: t.textMuted, pointerEvents: 'none' }} />
        <input
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          disabled={disabled}
          value={open ? query : (selected?.label ?? value)}
          placeholder={placeholder}
          onFocus={() => { setOpen(true); setQuery(''); }}
          onBlur={() => { setOpen(false); setQuery(''); }}
          onChange={(event) => { setOpen(true); setQuery(event.target.value); }}
          // Escape closes the list, not the dialog around it.
          onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); setQuery(''); } }}
          style={{ ...inputStyle(t), paddingLeft: 29, paddingRight: value ? 29 : 8, opacity: disabled ? 0.6 : 1 }}
        />
        {value && !disabled && <button type="button" aria-label="Clear selection" onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(''); setQuery(''); setOpen(true); }} style={{ ...iconButtonStyle(t), position: 'absolute', right: 3, top: '50%', transform: 'translateY(-50%)', width: 24, height: 24, border: 'none' }}><XCircle size={13} /></button>}
      </div>
      {open && !disabled && (
        <div id={listId} role="listbox" style={{ position: 'absolute', zIndex: 90, top: 'calc(100% + 4px)', left: 0, right: 0, maxHeight: 230, overflowY: 'auto', border: `1px solid ${t.headerBorder}`, borderRadius: 7, background: t.cellBg, boxShadow: '0 12px 32px #0004', padding: 4 }}>
          {results.length ? results.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === value} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(option.value); setOpen(false); setQuery(''); }} style={{ display: 'grid', width: '100%', gap: 2, padding: '8px 9px', border: 'none', borderRadius: 5, textAlign: 'left', background: option.value === value ? 'var(--accent-dim)' : 'transparent', color: t.textPrimary, cursor: 'pointer' }}><strong style={{ fontSize: 10.5 }}>{option.label}</strong>{option.description && <span style={{ color: t.textMuted, fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.description}</span>}</button>) : <div style={{ padding: 12, color: t.textMuted, fontSize: 10 }}>No matching results.</div>}
          {options.length > 50 && <div style={{ padding: '6px 9px 4px', borderTop: `1px solid ${t.headerBorder}`, color: t.textMuted, fontSize: 9 }}>Showing the best 50 of {options.length.toLocaleString()}. Refine your search for a specific result.</div>}
        </div>
      )}
    </div>
  );
}

export const inputStyle = (t: Theme): React.CSSProperties => ({
  width: '100%',
  boxSizing: 'border-box',
  border: `1px solid ${t.headerBorder}`,
  background: t.cellBg,
  color: t.textPrimary,
  borderRadius: 6,
  padding: '8px 9px',
  fontSize: 11,
});

export const iconButtonStyle = (t: Theme): React.CSSProperties => ({
  border: `1px solid ${t.headerBorder}`,
  background: t.appBg,
  color: t.textSecondary,
  borderRadius: 6,
  padding: 7,
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
});

export const linkButton = (t: Theme): React.CSSProperties => ({
  border: 0,
  background: 'transparent',
  color: t.accent,
  fontSize: 10,
  fontWeight: 650,
  cursor: 'pointer',
});
