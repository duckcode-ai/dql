import type { Theme } from '../../themes/notebook-theme';
import React, { useState, useEffect, useRef } from 'react';
import { useNotebook, makeCell } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import type { NotebookFile, Cell } from '../../store/types';

interface NewNotebookModalProps {
  onFileOpened: (file: NotebookFile) => void;
}

type Template = 'blank' | 'revenue' | 'pipeline';

const TEMPLATE_LABELS: Record<Template, string> = {
  blank: 'Blank',
  revenue: 'Revenue Analysis',
  pipeline: 'Pipeline Health',
};

const TEMPLATE_DESCRIPTIONS: Record<Template, string> = {
  blank: 'Start with an empty notebook.',
  revenue: 'Pre-built queries for revenue metrics and trends.',
  pipeline: 'Templates for data pipeline health monitoring.',
};

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

function buildTemplateCells(template: Template): Cell[] {
  switch (template) {
    case 'revenue':
      return [
        makeCell(
          'markdown',
          '# Revenue Analysis\n\nThis notebook analyzes revenue metrics and trends over time.'
        ),
        { ...makeCell('sql', 'SELECT\n  DATE_TRUNC(\'month\', order_date) AS month,\n  SUM(amount) AS revenue\nFROM orders\nGROUP BY 1\nORDER BY 1'), name: 'monthly_revenue' },
        { ...makeCell('sql', 'SELECT\n  product_category,\n  SUM(amount) AS total_revenue,\n  COUNT(*) AS orders\nFROM orders\nGROUP BY 1\nORDER BY 2 DESC'), name: 'revenue_by_category' },
      ];
    case 'pipeline':
      return [
        makeCell(
          'markdown',
          '# Pipeline Health\n\nMonitor data pipeline performance, SLA compliance, and error rates.'
        ),
        { ...makeCell('sql', 'SELECT\n  pipeline_name,\n  COUNT(*) AS runs,\n  AVG(duration_seconds) AS avg_duration,\n  SUM(CASE WHEN status = \'failed\' THEN 1 ELSE 0 END) AS failures\nFROM pipeline_runs\nGROUP BY 1\nORDER BY 4 DESC'), name: 'pipeline_summary' },
        { ...makeCell('sql', 'SELECT\n  *\nFROM pipeline_runs\nWHERE status = \'failed\'\n  AND run_date >= CURRENT_DATE - INTERVAL \'7 days\'\nORDER BY run_date DESC'), name: 'recent_failures' },
      ];
    default:
      return [makeCell('sql')];
  }
}

export function NewNotebookModal({ onFileOpened }: NewNotebookModalProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];

  const [name, setName] = useState('');
  const [template, setTemplate] = useState<Template>('blank');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'CLOSE_NEW_NOTEBOOK_MODAL' });
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
    const cells = buildTemplateCells(template);

    try {
      const result = await api.createNotebook(slug, template);
      const file: NotebookFile = {
        name: `${slug}.dqlnb`,
        path: result.path,
        type: 'notebook',
        folder: 'notebooks',
        isNew: true,
      };
      dispatch({ type: 'FILE_ADDED', file });
      dispatch({
        type: 'OPEN_FILE',
        file,
        cells,
        title: name.trim(),
      });
      dispatch({ type: 'CLOSE_NEW_NOTEBOOK_MODAL' });
      onFileOpened(file);
    } catch {
      // Server not available — create locally
      const path = `notebooks/${slug}.dqlnb`;
      const file: NotebookFile = {
        name: `${slug}.dqlnb`,
        path,
        type: 'notebook',
        folder: 'notebooks',
        isNew: true,
      };
      dispatch({ type: 'FILE_ADDED', file });
      dispatch({
        type: 'OPEN_FILE',
        file,
        cells,
        title: name.trim(),
      });
      dispatch({ type: 'CLOSE_NEW_NOTEBOOK_MODAL' });
      onFileOpened(file);
    } finally {
      setCreating(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      dispatch({ type: 'CLOSE_NEW_NOTEBOOK_MODAL' });
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
          width: 480,
          maxWidth: 'calc(100vw - 48px)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}
      >
        {/* Modal header */}
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
            New Notebook
          </h2>
          <button
            onClick={() => dispatch({ type: 'CLOSE_NEW_NOTEBOOK_MODAL' })}
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

        {/* Modal body */}
        <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Name field */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: t.textSecondary,
                fontFamily: t.font,
              }}
            >
              Name
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
              placeholder="my-analysis"
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
                File: {slugify(name)}.dqlnb
              </span>
            )}
          </div>

          {/* Template selector */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: t.textSecondary,
                fontFamily: t.font,
              }}
            >
              Template
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(Object.keys(TEMPLATE_LABELS) as Template[]).map((tmpl) => (
                <TemplateOption
                  key={tmpl}
                  value={tmpl}
                  selected={template === tmpl}
                  onSelect={() => setTemplate(tmpl)}
                  label={TEMPLATE_LABELS[tmpl]}
                  description={TEMPLATE_DESCRIPTIONS[tmpl]}
                  t={t}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Modal footer */}
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
            onClick={() => dispatch({ type: 'CLOSE_NEW_NOTEBOOK_MODAL' })}
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
            {creating ? 'Creating…' : 'Create Notebook'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TemplateOption({
  value,
  selected,
  onSelect,
  label,
  description,
  t,
}: {
  value: Template;
  selected: boolean;
  onSelect: () => void;
  label: string;
  description: string;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '10px 12px',
        borderRadius: 8,
        border: `1px solid ${selected ? t.cellBorderActive : hovered ? t.textMuted : t.inputBorder}`,
        background: selected ? `${t.cellBorderActive}10` : hovered ? t.sidebarItemHover : 'transparent',
        cursor: 'pointer',
        transition: 'all 0.15s',
      }}
    >
      {/* Radio */}
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          border: `2px solid ${selected ? t.accent : t.textMuted}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          marginTop: 1,
          transition: 'border-color 0.15s',
        }}
      >
        {selected && (
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              background: t.accent,
            }}
          />
        )}
      </div>
      <div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: t.textPrimary,
            fontFamily: t.font,
            marginBottom: 2,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 12,
            color: t.textSecondary,
            fontFamily: t.font,
          }}
        >
          {description}
        </div>
      </div>
    </div>
  );
}
