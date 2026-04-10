import React, { useState, useEffect, useRef } from 'react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import type { NotebookFile } from '../../store/types';

interface NewBlockModalProps {
  onFileOpened: (file: NotebookFile) => void;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\-_\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 64);
}

function validateName(name: string): string | null {
  if (!name.trim()) return 'Name is required.';
  if (!/^[a-zA-Z0-9\-_ ]+$/.test(name)) return 'Only letters, numbers, hyphens, underscores, and spaces allowed.';
  return null;
}

export function NewBlockModal({ onFileOpened }: NewBlockModalProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];

  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'CLOSE_NEW_BLOCK_MODAL' });
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [dispatch]);

  const handleCreate = async () => {
    const validationError = validateName(name);
    if (validationError) {
      setError(validationError);
      return;
    }

    setCreating(true);
    setError(null);

    const slug = slugify(name);

    try {
      const result = await api.createBlock(name.trim());
      const file: NotebookFile = {
        name: `${slug}.dql`,
        path: result.path,
        type: 'block',
        folder: 'blocks',
        isNew: true,
      };
      dispatch({ type: 'FILE_ADDED', file });
      dispatch({ type: 'CLOSE_NEW_BLOCK_MODAL' });
      onFileOpened(file);
    } catch (e: any) {
      if (e.message?.includes('already exists')) {
        setError('A block with this name already exists.');
      } else {
        setError(e.message ?? 'Failed to create block.');
      }
    } finally {
      setCreating(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      dispatch({ type: 'CLOSE_NEW_BLOCK_MODAL' });
    }
  };

  return (
    <div
      onClick={handleOverlayClick}
      style={{
        position: 'fixed',
        inset: 0,
        background: t.modalOverlay,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        style={{
          background: t.modalBg,
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 12,
          width: 420,
          maxWidth: 'calc(100vw - 48px)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px 0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h2
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: t.textPrimary,
              fontFamily: t.font,
              margin: 0,
            }}
          >
            New Block
          </h2>
          <button
            onClick={() => dispatch({ type: 'CLOSE_NEW_BLOCK_MODAL' })}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: t.textMuted,
              fontSize: 18,
              lineHeight: 1,
              padding: '2px 4px',
              borderRadius: 4,
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: t.textSecondary,
                fontFamily: t.font,
              }}
            >
              Block Name
            </label>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
              }}
              placeholder="revenue-summary"
              style={{
                background: t.inputBg,
                border: `1px solid ${error ? t.error : t.inputBorder}`,
                borderRadius: 6,
                color: t.textPrimary,
                fontSize: 13,
                fontFamily: t.font,
                padding: '8px 12px',
                outline: 'none',
                transition: 'border-color 0.15s',
              }}
            />
            {error && (
              <span style={{ fontSize: 11, color: t.error, fontFamily: t.font }}>
                {error}
              </span>
            )}
            {name && !error && (
              <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono }}>
                blocks/{slugify(name)}.dql
              </span>
            )}
          </div>

          <div
            style={{
              fontSize: 12,
              color: t.textMuted,
              fontFamily: t.font,
              lineHeight: 1.5,
              padding: '8px 12px',
              background: t.pillBg,
              borderRadius: 6,
            }}
          >
            Blocks are reusable SQL queries stored in the <code style={{ fontFamily: t.fontMono, fontSize: 11 }}>blocks/</code> folder.
            They can be referenced from notebooks and other blocks.
          </div>
        </div>

        {/* Footer */}
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
            onClick={() => dispatch({ type: 'CLOSE_NEW_BLOCK_MODAL' })}
            style={{
              background: t.btnBg,
              border: `1px solid ${t.btnBorder}`,
              borderRadius: 6,
              color: t.textSecondary,
              cursor: 'pointer',
              fontSize: 13,
              fontFamily: t.font,
              fontWeight: 500,
              padding: '7px 16px',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !name.trim()}
            style={{
              background: t.accent,
              border: `1px solid ${t.accent}`,
              borderRadius: 6,
              color: '#ffffff',
              cursor: creating || !name.trim() ? 'not-allowed' : 'pointer',
              fontSize: 13,
              fontFamily: t.font,
              fontWeight: 500,
              padding: '7px 20px',
              opacity: creating || !name.trim() ? 0.6 : 1,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {creating ? 'Creating...' : 'Create Block'}
          </button>
        </div>
      </div>
    </div>
  );
}
