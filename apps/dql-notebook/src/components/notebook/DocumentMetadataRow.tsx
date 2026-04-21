import React, { useEffect, useRef, useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import type { NotebookDocMetadata } from '../../store/types';

type PopoverKind = 'status' | 'categories' | 'description' | 'projectFilter' | null;

const STATUS_OPTIONS: Array<{ value: string; label: string; dot: string }> = [
  { value: 'draft', label: 'Draft', dot: '#f59e0b' },
  { value: 'in_review', label: 'In review', dot: '#5b8def' },
  { value: 'certified', label: 'Certified', dot: '#4ade80' },
  { value: 'deprecated', label: 'Deprecated', dot: '#ef4444' },
];

function statusLabel(value?: string) {
  if (!value) return null;
  return STATUS_OPTIONS.find((s) => s.value === value) ?? { value, label: value, dot: '#888' };
}

export function DocumentMetadataRow() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [open, setOpen] = useState<PopoverKind>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!state.activeFile) return null;

  const title = state.activeFile.name.replace(/\.dqlnb$/, '');
  const meta = state.notebookMetadata;

  const update = (patch: Partial<NotebookDocMetadata>) => {
    dispatch({ type: 'UPDATE_NOTEBOOK_METADATA', updates: patch });
  };

  const status = statusLabel(meta.status);
  const categoriesSet = (meta.categories ?? []).length > 0;
  const descriptionSet = !!meta.description;
  const projectFilterSet = !!meta.projectFilter;

  return (
    <div
      ref={rowRef}
      style={{
        maxWidth: 1080,
        margin: '0 auto',
        padding: '32px 48px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', position: 'relative' }}>
        <PillAnchor
          t={t}
          active={open === 'status'}
          filled={!!status}
          icon={<span style={{ color: status?.dot ?? t.textMuted, fontSize: 12 }}>●</span>}
          label={status?.label ?? 'Add status'}
          onClick={() => setOpen(open === 'status' ? null : 'status')}
        >
          {open === 'status' && (
            <Popover t={t}>
              {STATUS_OPTIONS.map((s) => (
                <button
                  key={s.value}
                  onClick={() => {
                    update({ status: s.value });
                    setOpen(null);
                  }}
                  style={popoverItemStyle(t, meta.status === s.value)}
                >
                  <span style={{ color: s.dot, fontSize: 12 }}>●</span>
                  <span>{s.label}</span>
                </button>
              ))}
              {meta.status && (
                <button
                  onClick={() => {
                    update({ status: undefined });
                    setOpen(null);
                  }}
                  style={{ ...popoverItemStyle(t, false), color: t.textMuted }}
                >
                  <span>Clear</span>
                </button>
              )}
            </Popover>
          )}
        </PillAnchor>

        <PillAnchor
          t={t}
          active={open === 'categories'}
          filled={categoriesSet}
          icon={<span style={{ fontFamily: t.fontMono, fontSize: 10 }}>#</span>}
          label={
            categoriesSet
              ? (meta.categories ?? []).slice(0, 3).join(', ') + ((meta.categories ?? []).length > 3 ? '…' : '')
              : 'Add categories'
          }
          onClick={() => setOpen(open === 'categories' ? null : 'categories')}
        >
          {open === 'categories' && (
            <Popover t={t} width={260}>
              <CategoriesEditor
                t={t}
                value={meta.categories ?? []}
                onChange={(next) => update({ categories: next.length ? next : undefined })}
              />
            </Popover>
          )}
        </PillAnchor>

        <PillAnchor
          t={t}
          active={open === 'description'}
          filled={descriptionSet}
          icon={<span style={{ fontFamily: t.fontMono, fontSize: 10 }}>✎</span>}
          label={descriptionSet ? truncate(meta.description!, 48) : 'Add description'}
          onClick={() => setOpen(open === 'description' ? null : 'description')}
        >
          {open === 'description' && (
            <Popover t={t} width={320}>
              <DraftInput
                multiline
                initial={meta.description ?? ''}
                onCommit={(v) => update({ description: v || undefined })}
                placeholder="What does this notebook answer?"
                style={textareaStyle(t)}
              />
            </Popover>
          )}
        </PillAnchor>

        <PillAnchor
          t={t}
          active={open === 'projectFilter'}
          filled={projectFilterSet}
          icon={<span style={{ fontFamily: t.fontMono, fontSize: 10 }}>⌕</span>}
          label={projectFilterSet ? truncate(meta.projectFilter!, 32) : 'Add project filter'}
          onClick={() => setOpen(open === 'projectFilter' ? null : 'projectFilter')}
        >
          {open === 'projectFilter' && (
            <Popover t={t} width={280}>
              <DraftInput
                initial={meta.projectFilter ?? ''}
                onCommit={(v) => update({ projectFilter: v || undefined })}
                placeholder="e.g. team:analytics"
                style={inputStyle(t)}
              />
            </Popover>
          )}
        </PillAnchor>
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          color: t.textPrimary,
          fontFamily: t.font,
          letterSpacing: '-0.01em',
        }}
      >
        {title}
      </div>
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function DraftInput({
  initial,
  onCommit,
  multiline,
  placeholder,
  style,
}: {
  initial: string;
  onCommit: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  style: React.CSSProperties;
}) {
  const [draft, setDraft] = useState(initial);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const commit = () => {
    const next = draftRef.current.trim();
    if (next !== initial.trim()) onCommit(next);
  };
  useEffect(() => () => commit(), []);
  if (multiline) {
    return (
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        placeholder={placeholder}
        rows={4}
        style={style}
      />
    );
  }
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder={placeholder}
      style={style}
    />
  );
}

function PillAnchor({
  t,
  active,
  filled,
  icon,
  label,
  onClick,
  children,
}: {
  t: Theme;
  active: boolean;
  filled: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <button
        className="dql-meta-pill"
        onClick={onClick}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 9px',
          borderRadius: 12,
          border: filled ? `1px solid ${t.cellBorder}` : `1px dashed ${t.cellBorder}`,
          background: active ? `${t.accent}12` : filled ? t.pillBg : 'transparent',
          color: filled ? t.textPrimary : t.textMuted,
          fontSize: 11,
          fontFamily: t.font,
          cursor: 'pointer',
          transition: 'background-color 80ms, border-color 80ms',
          ['--dql-pill-hover-bg' as string]: `${t.accent}10`,
          ['--dql-pill-hover-border' as string]: t.textMuted,
        }}
      >
        {icon}
        <span>{label}</span>
      </button>
      {children}
    </div>
  );
}

function Popover({ t, width = 200, children }: { t: Theme; width?: number; children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 'calc(100% + 6px)',
        left: 0,
        zIndex: 20,
        width,
        background: t.modalBg,
        border: `1px solid ${t.cellBorder}`,
        borderRadius: 6,
        padding: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      {children}
    </div>
  );
}

function popoverItemStyle(t: Theme, selected: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 8px',
    borderRadius: 4,
    border: 'none',
    background: selected ? `${t.accent}18` : 'transparent',
    color: t.textPrimary,
    fontSize: 12,
    fontFamily: t.font,
    textAlign: 'left',
    cursor: 'pointer',
  };
}

function textareaStyle(t: Theme): React.CSSProperties {
  return {
    width: '100%',
    background: t.editorBg,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 4,
    color: t.textPrimary,
    fontSize: 12,
    fontFamily: t.font,
    padding: 8,
    outline: 'none',
    resize: 'vertical',
  };
}

function inputStyle(t: Theme): React.CSSProperties {
  return {
    width: '100%',
    background: t.editorBg,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 4,
    color: t.textPrimary,
    fontSize: 12,
    fontFamily: t.fontMono,
    padding: '6px 8px',
    outline: 'none',
  };
}

function CategoriesEditor({
  t,
  value,
  onChange,
}: {
  t: Theme;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    const v = draft.trim();
    if (!v) return;
    if (value.includes(v)) {
      setDraft('');
      return;
    }
    onChange([...value, v]);
    setDraft('');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {value.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {value.map((c) => (
            <span
              key={c}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 6px',
                borderRadius: 10,
                background: t.pillBg,
                border: `1px solid ${t.cellBorder}`,
                color: t.textPrimary,
                fontSize: 11,
                fontFamily: t.font,
              }}
            >
              {c}
              <button
                onClick={() => onChange(value.filter((x) => x !== c))}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: t.textMuted,
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: 12,
                  lineHeight: 1,
                }}
                aria-label={`Remove ${c}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Backspace' && !draft && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        placeholder="Add category, press Enter"
        style={inputStyle(t)}
      />
    </div>
  );
}
