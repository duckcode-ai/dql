import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Theme } from '../../themes/notebook-theme';
import type { ClassifiedField, FieldKind } from '../../utils/semantic-fields';
import { fieldKindColor, fieldKindIcon, fieldKindLabel } from '../../utils/semantic-fields';

interface SemanticFieldPickerProps {
  theme: Theme;
  /** Current selection (field name). */
  value: string | undefined;
  /** Ordered list of fields to display (already classified, metrics → dims → cols). */
  fields: ClassifiedField[];
  /** Only these kinds are selectable; the rest render as disabled rows. */
  allowKinds?: FieldKind[];
  /** Placeholder when no value is set. */
  placeholder?: string;
  /** Minimum width of the button; the dropdown inherits it. */
  minWidth?: number;
  onChange: (name: string | undefined) => void;
}

/**
 * Typed field picker: renders a button showing the current selection's kind +
 * name; on click, opens a searchable list grouped metric → dimension → column.
 * Rows whose kind is not in `allowKinds` render muted and non-selectable.
 */
export function SemanticFieldPicker({
  theme,
  value,
  fields,
  allowKinds,
  placeholder = 'Select field',
  minWidth = 180,
  onChange,
}: SemanticFieldPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 20);
      return () => clearTimeout(t);
    }
    setQuery('');
  }, [open]);

  const selected = useMemo(() => fields.find((f) => f.name === value), [fields, value]);

  const filtered = useMemo(() => {
    if (!query) return fields;
    const q = query.toLowerCase();
    return fields.filter((f) => f.name.toLowerCase().includes(q));
  }, [fields, query]);

  const isAllowed = (kind: FieldKind) => (allowKinds ? allowKinds.includes(kind) : true);

  return (
    <div ref={ref} style={{ position: 'relative', minWidth }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          background: theme.editorBg,
          border: `1px solid ${theme.cellBorder}`,
          borderRadius: 3,
          cursor: 'pointer',
          color: selected ? theme.textPrimary : theme.textMuted,
          fontFamily: theme.fontMono,
          fontSize: 11,
          textAlign: 'left',
        }}
      >
        {selected ? (
          <>
            <span style={{ color: fieldKindColor(selected.kind, theme.accent), fontWeight: 700, width: 12 }}>
              {fieldKindIcon(selected.kind)}
            </span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selected.name}
            </span>
          </>
        ) : (
          <span style={{ flex: 1 }}>{placeholder}</span>
        )}
        <span style={{ color: theme.textMuted, fontSize: 9 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 2px)',
            left: 0,
            right: 0,
            zIndex: 20,
            background: theme.cellBg,
            border: `1px solid ${theme.cellBorder}`,
            borderRadius: 6,
            boxShadow: '0 6px 16px rgba(0,0,0,0.28)',
            padding: 4,
            maxHeight: 260,
            overflow: 'auto',
            minWidth: Math.max(minWidth, 200),
          }}
        >
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search fields..."
            style={{
              width: '100%',
              padding: '4px 6px',
              marginBottom: 4,
              background: theme.editorBg,
              border: `1px solid ${theme.cellBorder}`,
              borderRadius: 3,
              color: theme.textPrimary,
              fontFamily: theme.font,
              fontSize: 11,
              outline: 'none',
            }}
          />
          {value && (
            <button
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '3px 6px',
                background: 'transparent',
                border: 'none',
                borderRadius: 3,
                color: theme.textMuted,
                fontSize: 10,
                fontFamily: theme.font,
                cursor: 'pointer',
                fontStyle: 'italic',
              }}
            >
              Clear selection
            </button>
          )}
          {filtered.length === 0 && (
            <div style={{ padding: '6px 8px', fontSize: 11, color: theme.textMuted, fontFamily: theme.font }}>
              No matches
            </div>
          )}
          {filtered.map((field) => {
            const allowed = isAllowed(field.kind);
            return (
              <button
                key={field.name}
                onClick={() => {
                  if (!allowed) return;
                  onChange(field.name);
                  setOpen(false);
                }}
                disabled={!allowed}
                title={allowed ? field.name : `${fieldKindLabel(field.kind)} — not selectable here`}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 6px',
                  background: 'transparent',
                  border: 'none',
                  borderRadius: 3,
                  cursor: allowed ? 'pointer' : 'not-allowed',
                  textAlign: 'left',
                  color: allowed ? theme.textPrimary : theme.textMuted,
                  fontFamily: theme.fontMono,
                  fontSize: 11,
                  opacity: allowed ? 1 : 0.55,
                }}
                onMouseEnter={(e) => {
                  if (allowed) (e.currentTarget as HTMLButtonElement).style.background = theme.tableRowHover;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                }}
              >
                <span
                  style={{
                    color: fieldKindColor(field.kind, theme.accent),
                    fontWeight: 700,
                    width: 12,
                    textAlign: 'center',
                  }}
                >
                  {fieldKindIcon(field.kind)}
                </span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {field.name}
                </span>
                <span
                  style={{
                    fontSize: 9,
                    color: theme.textMuted,
                    fontFamily: theme.font,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  {fieldKindLabel(field.kind)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Muted strip shown when upstream has no semantic binding (no @metric/@dim). */
export function NoSemanticBindingNote({ theme }: { theme: Theme }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontFamily: theme.font,
        color: theme.textMuted,
        background: `${theme.cellBorder}60`,
        borderRadius: 3,
        padding: '3px 8px',
        letterSpacing: '0.02em',
      }}
    >
      No semantic binding — metrics and dimensions unavailable. Use <code>@metric(...)</code> or <code>@dim(...)</code> upstream to populate typed pickers.
    </div>
  );
}
