import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import type { Cell } from '../../store/types';

interface SaveAsBlockModalProps {
  cell: Cell;
  onClose: () => void;
  onSaved?: (result: { path: string; content: string; name: string }) => void;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractSemanticRefs(content: string): string[] {
  const refs = new Set<string>();
  const regex = /@(metric|dim)\(([^)]+)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content))) {
    refs.add(match[2].trim());
  }
  return Array.from(refs);
}

export function SaveAsBlockModal({ cell, onClose, onSaved }: SaveAsBlockModalProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const nameRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(cell.name || 'new_block');
  const [domain, setDomain] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [content, setContent] = useState(cell.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const semanticRefs = useMemo(() => extractSemanticRefs(content), [content]);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const knownDomains = state.semanticLayer.domains;
  const blockPath = `${domain.trim() ? `blocks/${slugify(domain)}/` : 'blocks/'}${slugify(name) || 'new-block'}.dql`;

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Block name is required.');
      return;
    }
    if (!content.trim()) {
      setError('Block content is required.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await api.saveAsBlock({
        cellId: cell.id,
        notebookPath: state.activeFile?.path ?? null,
        name: name.trim(),
        domain: domain.trim() || undefined,
        content,
        description: description.trim() || undefined,
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        metricRefs: semanticRefs,
      });
      const file = {
        name: `${slugify(name) || 'new-block'}.dql`,
        path: result.path,
        type: 'block' as const,
        folder: 'blocks',
      };
      if (!state.files.some((existing) => existing.path === result.path)) {
        dispatch({ type: 'FILE_ADDED', file });
      }
      const payload = await api.openBlockStudio(result.path);
      dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload });
      onSaved?.({ ...result, name: name.trim() });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: t.inputBg,
    border: `1px solid ${error ? t.error : t.inputBorder}`,
    borderRadius: 6,
    color: t.textPrimary,
    fontSize: 13,
    fontFamily: t.font,
    padding: '8px 12px',
    outline: 'none',
    boxSizing: 'border-box',
  };

  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: t.modalOverlay,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1100,
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        style={{
          width: 760,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'calc(100vh - 48px)',
          overflow: 'auto',
          background: t.modalBg,
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div
          style={{
            padding: '20px 24px 0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
            Save as Block
          </h2>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: t.textMuted, cursor: 'pointer', fontSize: 18 }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font }}>Block Name</label>
              <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font }}>Domain</label>
              <input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                list="semantic-domain-options"
                style={inputStyle}
                placeholder="finance"
              />
              <datalist id="semantic-domain-options">
                {knownDomains.map((value) => <option key={value} value={value} />)}
              </datalist>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font }}>Description</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font }}>Tags</label>
              <input value={tags} onChange={(e) => setTags(e.target.value)} style={inputStyle} placeholder="revenue, dashboard" />
            </div>
          </div>

          <div
            style={{
              fontSize: 12,
              color: t.textMuted,
              fontFamily: t.fontMono,
              padding: '8px 12px',
              background: t.pillBg,
              borderRadius: 6,
            }}
          >
            {blockPath}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.font }}>Content Preview</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              style={{
                ...inputStyle,
                minHeight: 220,
                resize: 'vertical',
                fontFamily: t.fontMono,
                lineHeight: 1.5,
              }}
            />
          </div>

          {semanticRefs.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                padding: '10px 12px',
                background: t.pillBg,
                borderRadius: 6,
              }}
            >
              <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>Detected semantic refs:</span>
              {semanticRefs.map((ref) => (
                <span
                  key={ref}
                  style={{
                    fontSize: 11,
                    color: t.accent,
                    fontFamily: t.fontMono,
                    background: `${t.accent}18`,
                    borderRadius: 999,
                    padding: '2px 8px',
                  }}
                >
                  {ref}
                </span>
              ))}
            </div>
          )}

          {error && <div style={{ fontSize: 12, color: t.error, fontFamily: t.font }}>{error}</div>}
        </div>

        <div
          style={{
            padding: '14px 24px',
            borderTop: `1px solid ${t.cellBorder}`,
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
          }}
        >
          <button
            onClick={onClose}
            style={{
              background: t.btnBg,
              border: `1px solid ${t.btnBorder}`,
              borderRadius: 6,
              color: t.textSecondary,
              cursor: 'pointer',
              fontSize: 13,
              fontFamily: t.font,
              padding: '7px 16px',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              background: t.accent,
              border: `1px solid ${t.accent}`,
              borderRadius: 6,
              color: '#fff',
              cursor: saving ? 'not-allowed' : 'pointer',
              fontSize: 13,
              fontFamily: t.font,
              padding: '7px 20px',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving...' : 'Save Block'}
          </button>
        </div>
      </div>
    </div>
  );
}
