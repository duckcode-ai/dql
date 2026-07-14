import type { Theme } from "../../themes/notebook-theme";
import React, { useState, useRef, useEffect } from "react";
import { MoreHorizontal, Upload } from "lucide-react";
import { useNotebook, makeCell } from "../../store/NotebookStore";
import { themes } from "../../themes/notebook-theme";
import type { Cell, CellType } from "../../store/types";
import {
  parseSemanticDragRef,
  SEMANTIC_REF_MIME,
} from "../../editor/semantic-completions";
import { api } from "../../api/client";
import { BlockPicker, type BlockEntry } from "../blocks/BlockPicker";
import { extractSqlFromText } from "../../utils/block-studio";
import {
  BlockIcon,
  SQLCellIcon,
  ChartCellIcon,
  PivotCellIcon,
  SingleValueCellIcon,
  ParamCellIcon,
  FilterCellIcon,
  FileText,
  Sparkles,
  Table,
} from '@duckcodeailabs/dql-ui/icons';

interface AddCellBarProps {
  afterId?: string;
}

type PaletteType = CellType | "block" | "ai_sql" | "import_data";

type PaletteEntry = {
  type: PaletteType;
  label: string;
  shortLabel?: string;
  Icon: React.ComponentType<any>;
  color: string;
  group: "core" | "input" | "transform" | "presentation";
};

const CORE_PALETTE: PaletteEntry[] = [
  {
    type: "dql",
    label: "DQL Query",
    Icon: BlockIcon,
    color: "#6b8afd",
    group: "core",
  },
  {
    type: "sql",
    label: "SQL (advanced)",
    Icon: SQLCellIcon,
    color: "#3b8ef0",
    group: "core",
  },
  {
    type: "markdown",
    label: "Text",
    Icon: FileText,
    color: "#2fb97a",
    group: "core",
  },
  {
    type: "ai_sql",
    label: "Ask AI",
    Icon: Sparkles,
    color: "#f0883e",
    group: "core",
  },
  {
    type: "import_data",
    label: "Import data",
    Icon: Upload,
    color: "#5dd1c8",
    group: "core",
  },
  {
    type: "block",
    label: "Use block",
    Icon: BlockIcon,
    color: "#6b8afd",
    group: "core",
  },
];

const MORE_PALETTE: PaletteEntry[] = [
  {
    type: "param",
    label: "Parameter",
    Icon: ParamCellIcon,
    color: "#9aa0ae",
    group: "input",
  },
  {
    type: "filter",
    label: "Filter",
    Icon: FilterCellIcon,
    color: "#f26a6a",
    group: "transform",
  },
  {
    type: "pivot",
    label: "Pivot",
    Icon: PivotCellIcon,
    color: "#e5a84d",
    group: "transform",
  },
  {
    type: "chart",
    label: "Chart",
    Icon: ChartCellIcon,
    color: "#b067f7",
    group: "presentation",
  },
  {
    type: "table",
    label: "Table",
    Icon: Table,
    color: "#5dd1c8",
    group: "presentation",
  },
  {
    type: "single_value",
    label: "Single value",
    shortLabel: "Value",
    Icon: SingleValueCellIcon,
    color: "#b067f7",
    group: "presentation",
  },
];

export function AddCellBar({ afterId }: AddCellBarProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [hovered, setHovered] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [blockPickerOpen, setBlockPickerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!popoverOpen) return;
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
        setBlockPickerOpen(false);
        setMoreOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [popoverOpen]);

  const closeAll = () => {
    setPopoverOpen(false);
    setBlockPickerOpen(false);
    setMoreOpen(false);
  };

  const addCell = (type: CellType) => {
    const cell = makeCell(type, type === 'dql' ? newNotebookDqlSource() : '');
    dispatch({ type: 'ADD_CELL', cell, afterId });
    closeAll();
  };

  const insertBoundBlockCell = async (block: BlockEntry) => {
    try {
      await api.openBlockStudio(block.path);
    } catch (error) {
      console.error('Failed to bind block cell', error);
      window.alert(`Couldn't load block ${block.path}. Check the console for details.`);
      closeAll();
      return;
    }
    const blockReference = `@block(${JSON.stringify(block.name)})`;
    const cell = makeCell('dql', blockReference);
    cell.name = block.name;
    cell.blockBinding = { path: block.path, state: 'bound', originalContent: blockReference };
    dispatch({ type: 'ADD_CELL', cell, afterId });
    closeAll();
  };

  return (
    <div
      ref={containerRef}
      data-testid="add-cell-bar"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(SEMANTIC_REF_MIME)) return;
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(event) => {
        const payload = parseSemanticDragRef(event.dataTransfer.getData(SEMANTIC_REF_MIME));
        if (!payload) return;
        event.preventDefault();
        setDropActive(false);
        const cell = makeCell('sql', payload.reference);
        dispatch({ type: 'ADD_CELL', cell, afterId });
        void api.trackUsage(payload.name);
        window.dispatchEvent(new CustomEvent('dql:semantic-used', { detail: { name: payload.name } }));
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setDropActive(false);
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        setHovered(true);
        setPopoverOpen(true);
      }}
      style={{
        position: 'relative',
        height: 28,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: popoverOpen ? 'default' : 'pointer',
      }}
    >
      {(hovered || popoverOpen || dropActive) && (
        <button
          aria-label="Add cell"
          onClick={() => setPopoverOpen((p) => !p)}
          style={{
            position: 'relative',
            zIndex: 2,
            height: 22,
            padding: '0 10px',
            borderRadius: 11,
            border: `1px solid ${dropActive ? t.accent : t.cellBorderActive}`,
            background: dropActive ? `${t.accent}28` : `${t.accent}18`,
            color: t.accent,
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: t.font,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            transition: 'background 0.15s',
          }}
        >
          <span style={{ fontSize: 14, lineHeight: 1, marginTop: -1 }}>+</span>
          Add cell
        </button>
      )}

      {popoverOpen && (
        <div
          style={{
            position: 'absolute',
            top: 26,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 100,
            background: t.modalBg,
            border: `1px solid ${t.cellBorder}`,
            borderRadius: 10,
            boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            width: blockPickerOpen ? 'min(760px, calc(100vw - 48px))' : 'max-content',
            maxWidth: 'calc(100vw - 48px)',
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: 4,
              flexWrap: 'nowrap',
              alignItems: 'center',
              justifyContent: 'flex-start',
              overflowX: 'auto',
              overflowY: 'hidden',
              maxWidth: '100%',
              paddingBottom: 1,
            }}
          >
            {CORE_PALETTE.map((entry) => (
              <PaletteTile
                key={entry.type}
                entry={entry}
                active={entry.type === 'block' && blockPickerOpen}
                onClick={() => {
                  if (entry.type === "block") {
                    setMoreOpen(false);
                    setBlockPickerOpen((v) => !v);
                    return;
                  }
                  if (entry.type === 'ai_sql') {
                    // Open the governed Notebook AI drawer at this position — the
                    // same DQL-first cascade as Ask AI, not the legacy SQL dialog.
                    window.dispatchEvent(new CustomEvent('dql:open-notebook-ai', { detail: { afterId } }));
                    closeAll();
                    return;
                  }
                  if (entry.type === "import_data") {
                    window.dispatchEvent(
                      new CustomEvent("dql:open-dataset-import", {
                        detail: { afterId },
                      }),
                    );
                    closeAll();
                    return;
                  }
                  addCell(entry.type as CellType);
                }}
                t={t}
              />
            ))}
            <button
              type="button"
              aria-label="More cell types"
              data-testid="add-cell-more"
              onClick={() => {
                setBlockPickerOpen(false);
                setMoreOpen((value) => !value);
              }}
              style={{
                height: 48,
                minWidth: 52,
                borderRadius: 8,
                border: `1px solid ${moreOpen ? t.accent : t.cellBorder}`,
                background: moreOpen ? `${t.accent}12` : "transparent",
                color: moreOpen ? t.accent : t.textSecondary,
                display: "inline-flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                font: `600 11px ${t.font}`,
                cursor: "pointer",
              }}
            >
              <MoreHorizontal size={17} aria-hidden="true" />
              More
            </button>
          </div>

          {moreOpen && (
            <div
              style={{ borderTop: `1px solid ${t.cellBorder}`, paddingTop: 8 }}
            >
              {(["input", "transform", "presentation"] as const).map(
                (group) => (
                  <div
                    key={group}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      marginTop: group === "input" ? 0 : 6,
                    }}
                  >
                    <span
                      style={{
                        width: 72,
                        color: t.textMuted,
                        fontSize: 10,
                        textTransform: "uppercase",
                        letterSpacing: ".06em",
                      }}
                    >
                      {group}
                    </span>
                    {MORE_PALETTE.filter((entry) => entry.group === group).map(
                      (entry) => (
                        <PaletteTile
                          key={entry.type}
                          entry={entry}
                          onClick={() => addCell(entry.type as CellType)}
                          t={t}
                        />
                      ),
                    )}
                  </div>
                ),
              )}
            </div>
          )}

          {blockPickerOpen && (
            <div
              style={{
                padding: '6px 2px 2px',
                borderTop: `1px solid ${t.cellBorder}`,
              }}
            >
              <BlockPicker
                themeMode={state.themeMode}
                onPick={(block) => void insertBoundBlockCell(block)}
              />
            </div>
          )}

        </div>
      )}
    </div>
  );
}

function newNotebookDqlSource(): string {
  return `block "notebook_analysis" {
  status = "draft"
  domain = "uncategorized"
  type = "custom"
  description = "Notebook analysis"

  params {
    top_n: number = 10
  }
  parameterPolicy {
    top_n = "dynamic"
  }

  query = """
SELECT 1 AS value
LIMIT \${top_n}
  """
}
`;
}

function PaletteTile({
  entry,
  onClick,
  t,
  active = false,
}: {
  entry: PaletteEntry;
  onClick: () => void;
  t: Theme;
  active?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const highlighted = active || hovered;
  const Icon = entry.Icon;
  return (
    <button
      aria-label={
        entry.type === "ai_sql"
          ? "Ask AI"
          : entry.type === "import_data"
            ? "Import data"
            : `Add ${entry.label} cell`
      }
      data-testid={`add-cell-${entry.type}`}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={entry.label}
      style={{
        background: highlighted ? `${entry.color}18` : 'transparent',
        border: `1px solid ${highlighted ? entry.color : t.cellBorder}`,
        borderRadius: 8,
        cursor: 'pointer',
        color: highlighted ? entry.color : t.textSecondary,
        fontSize: 11,
        fontFamily: t.font,
        fontWeight: 600,
        padding: '5px 6px',
        width: 52,
        height: 48,
        flex: '0 0 52px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        transition: 'all 0.12s',
      }}
    >
      <span style={{ color: entry.color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={16} strokeWidth={1.85} />
      </span>
      <span
        style={{
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          letterSpacing: 0,
        }}
      >
        {entry.shortLabel ?? entry.label}
      </span>
    </button>
  );
}
