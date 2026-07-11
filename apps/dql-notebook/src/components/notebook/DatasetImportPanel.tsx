import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Database,
  FileUp,
  FolderOpen,
  Link2,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { api, type DatasetSource } from "../../api/client";
import { makeCell, useNotebook } from "../../store/NotebookStore";
import { themes } from "../../themes/notebook-theme";
import type { Theme } from "../../themes/notebook-theme";

export function DatasetImportPanel({
  afterId,
  onClose,
}: {
  afterId?: string;
  onClose: () => void;
}) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [mode, setMode] = useState<"upload" | "path" | "existing">("upload");
  const [storageMode, setStorageMode] = useState<"local" | "project">("local");
  const [file, setFile] = useState<File | null>(null);
  const [sourcePath, setSourcePath] = useState("");
  const [link, setLink] = useState(true);
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [datasets, setDatasets] = useState<DatasetSource[]>([]);
  const [selected, setSelected] = useState<DatasetSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refreshList = async () => {
    const payload = await api.getDatasets();
    setDatasets(payload.datasets);
    window.dispatchEvent(
      new CustomEvent("dql:datasets-changed", {
        detail: { count: payload.datasets.length },
      }),
    );
  };

  useEffect(() => {
    void refreshList().catch(() => undefined);
  }, []);

  const canImport =
    mode === "upload" ? Boolean(file) : Boolean(sourcePath.trim());
  const addQuery = (dataset: DatasetSource) => {
    const cell = makeCell(
      "sql",
      `SELECT *\nFROM "${dataset.alias.replace(/"/g, '""')}"\nLIMIT 100`,
    );
    cell.name = `${dataset.alias}_query`;
    cell.executionTarget = { target: "local" };
    cell.datasetRefs = [
      {
        id: dataset.id,
        alias: dataset.alias,
        role: dataset.storageMode === "staged" ? "staged" : "source",
        fingerprint: dataset.fileFingerprint,
      },
    ];
    dispatch({ type: "ADD_CELL", cell, afterId });
    dispatch({
      type: "SET_SCHEMA",
      tables: [
        ...state.schemaTables.filter((table) => table.name !== dataset.alias),
        {
          name: dataset.alias,
          path: dataset.sourcePath,
          source: "file",
          objectType: "dataset",
          datasetId: dataset.id,
          fileFingerprint: dataset.fileFingerprint,
          storageMode: dataset.storageMode,
          refreshedAt: dataset.refreshedAt,
          trustState: dataset.trustState,
          columns: dataset.profile.columns.map((column) => ({
            name: column.name,
            type: column.type,
          })),
        },
      ],
    });
    onClose();
  };

  const exposeDataset = (dataset: DatasetSource) => {
    dispatch({
      type: "SET_SCHEMA",
      tables: [
        ...state.schemaTables.filter((table) => table.name !== dataset.alias),
        {
          name: dataset.alias,
          path: dataset.sourcePath,
          source: "file",
          objectType:
            dataset.storageMode === "staged" ? "staged_dataset" : "dataset",
          datasetId: dataset.id,
          fileFingerprint: dataset.fileFingerprint,
          storageMode: dataset.storageMode,
          refreshedAt: dataset.refreshedAt,
          trustState: dataset.trustState,
          columns: dataset.profile.columns.map((column) => ({
            name: column.name,
            type: column.type,
          })),
        },
      ],
    });
  };

  const importData = async () => {
    if (!canImport) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.importDataset({
        filename: file?.name,
        file: file ?? undefined,
        sourcePath: mode === "path" ? sourcePath.trim() : undefined,
        storageMode,
        link: mode === "path" && storageMode === "local" ? link : false,
        name: name.trim() || undefined,
        owner: owner.trim() || undefined,
        description: description.trim() || undefined,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      setSelected(result.dataset);
      exposeDataset(result.dataset);
      await refreshList();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Import data"
      style={{
        margin: "12px 18px 18px",
        border: `1px solid ${t.cellBorder}`,
        background: t.cellBg,
        borderRadius: 10,
        boxShadow: "0 8px 24px rgba(0,0,0,.08)",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          minHeight: 44,
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "0 14px",
          borderBottom: `1px solid ${t.cellBorder}`,
        }}
      >
        <Database size={16} color={t.accent} />
        <div style={{ flex: 1 }}>
          <div style={{ color: t.textPrimary, fontSize: 13, fontWeight: 800 }}>
            Import data
          </div>
          <div style={{ color: t.textMuted, fontSize: 10 }}>
            Create a reusable local dataset for research. CSV freshness is
            point-in-time.
          </div>
        </div>
        <button
          aria-label="Close import data"
          onClick={onClose}
          style={{
            border: 0,
            background: "transparent",
            color: t.textMuted,
            cursor: "pointer",
          }}
        >
          <X size={16} />
        </button>
      </header>

      <div
        style={{ display: "flex", borderBottom: `1px solid ${t.cellBorder}` }}
      >
        {(
          [
            ["upload", FileUp, "Upload CSV"],
            ["path", Link2, "Local path"],
            ["existing", FolderOpen, "Available data"],
          ] as const
        ).map(([value, Icon, label]) => (
          <button
            key={value}
            onClick={() => {
              setMode(value);
              setSelected(null);
              setError(null);
            }}
            style={{
              flex: 1,
              height: 38,
              border: 0,
              borderBottom: `2px solid ${mode === value ? t.accent : "transparent"}`,
              background: mode === value ? `${t.accent}0d` : "transparent",
              color: mode === value ? t.accent : t.textSecondary,
              cursor: "pointer",
              font: `700 11px ${t.font}`,
              display: "inline-flex",
              justifyContent: "center",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {mode === "existing" ? (
        <DatasetList
          datasets={datasets}
          busy={busy}
          onUse={addQuery}
          onRefresh={async (dataset) => {
            setBusy(true);
            try {
              setSelected((await api.refreshDataset(dataset.id)).dataset);
              await refreshList();
            } finally {
              setBusy(false);
            }
          }}
          onRename={async (dataset) => {
            const next = window.prompt("Dataset name", dataset.name)?.trim();
            if (!next || next === dataset.name) return;
            setBusy(true);
            try {
              await api.renameDataset(dataset.id, next);
              await refreshList();
            } finally {
              setBusy(false);
            }
          }}
          onPin={async (dataset) => {
            setBusy(true);
            try {
              await api.pinDataset(dataset.id, !dataset.pinned);
              await refreshList();
            } finally {
              setBusy(false);
            }
          }}
          onRemove={async (dataset) => {
            if (!window.confirm(`Remove ${dataset.name}?`)) return;
            setBusy(true);
            try {
              await api.removeDataset(dataset.id);
              dispatch({
                type: "SET_SCHEMA",
                tables: state.schemaTables.filter(
                  (table) => table.name !== dataset.alias,
                ),
              });
              await refreshList();
            } finally {
              setBusy(false);
            }
          }}
          t={t}
        />
      ) : selected ? (
        <DatasetReview
          dataset={selected}
          onAdd={() => addQuery(selected)}
          onBack={() => setSelected(null)}
          onUpdateSchema={async (overrides) => {
            setBusy(true);
            try {
              const updated = (
                await api.updateDatasetSchema(selected.id, overrides)
              ).dataset;
              setSelected(updated);
              await refreshList();
            } finally {
              setBusy(false);
            }
          }}
          busy={busy}
          t={t}
        />
      ) : (
        <div style={{ padding: 14, display: "grid", gap: 12 }}>
          {mode === "upload" ? (
            <div>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv,.parquet,.json,.jsonl,.ndjson"
                hidden
                onChange={(event) => {
                  const next = event.target.files?.[0] ?? null;
                  setFile(next);
                  if (next && !name) setName(next.name.replace(/\.[^.]+$/, ""));
                }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                style={{
                  width: "100%",
                  minHeight: 72,
                  border: `1px dashed ${file ? t.accent : t.inputBorder}`,
                  background: file ? `${t.accent}0c` : t.inputBg,
                  color: file ? t.accent : t.textSecondary,
                  borderRadius: 8,
                  cursor: "pointer",
                  font: `600 11px ${t.font}`,
                }}
              >
                <FileUp
                  size={18}
                  style={{ display: "block", margin: "0 auto 6px" }}
                />
                {file
                  ? `${file.name} · ${formatBytes(file.size)}`
                  : "Choose a CSV file"}
              </button>
            </div>
          ) : (
            <label
              style={{
                display: "grid",
                gap: 5,
                color: t.textSecondary,
                fontSize: 11,
              }}
            >
              Local file path
              <input
                value={sourcePath}
                onChange={(event) => setSourcePath(event.target.value)}
                placeholder="/Users/me/Downloads/customers.csv"
                style={inputStyle(t)}
              />
            </label>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(160px, 1fr) minmax(160px, 1fr)",
              gap: 10,
            }}
          >
            <label style={labelStyle(t)}>
              Dataset name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Customer targets"
                style={inputStyle(t)}
              />
            </label>
            <label style={labelStyle(t)}>
              Owner (optional)
              <input
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
                placeholder="analytics"
                style={inputStyle(t)}
              />
            </label>
            <label style={labelStyle(t)}>
              Description
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this snapshot represents"
                style={inputStyle(t)}
              />
            </label>
            <label style={labelStyle(t)}>
              Tags
              <input
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="forecast, local"
                style={inputStyle(t)}
              />
            </label>
          </div>

          <div
            style={{
              border: `1px solid ${t.cellBorder}`,
              borderRadius: 7,
              padding: 10,
            }}
          >
            <div
              style={{
                color: t.textSecondary,
                fontSize: 11,
                fontWeight: 800,
                marginBottom: 7,
              }}
            >
              Storage
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <StorageChoice
                active={storageMode === "local"}
                title="Local only"
                description="Ignored by Git. Best for private or temporary analysis."
                onClick={() => setStorageMode("local")}
                t={t}
              />
              <StorageChoice
                active={storageMode === "project"}
                title="Add to project"
                description="Copies into data/ and writes data/sources.yml."
                onClick={() => {
                  setStorageMode("project");
                  setLink(false);
                }}
                t={t}
              />
            </div>
            {mode === "path" && storageMode === "local" && (
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginTop: 8,
                  color: t.textMuted,
                  fontSize: 10,
                }}
              >
                <input
                  type="checkbox"
                  checked={link}
                  onChange={(event) => setLink(event.target.checked)}
                />{" "}
                Link the original file instead of copying it
              </label>
            )}
          </div>

          {error && (
            <div role="alert" style={{ color: t.error, fontSize: 11 }}>
              {error}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              disabled={!canImport || busy}
              onClick={() => void importData()}
              style={{
                border: `1px solid ${t.accent}`,
                background: t.accent,
                color: "#fff",
                borderRadius: 6,
                padding: "7px 13px",
                cursor: canImport && !busy ? "pointer" : "not-allowed",
                opacity: canImport && !busy ? 1 : 0.55,
                font: `700 11px ${t.font}`,
              }}
            >
              {busy ? "Profiling…" : "Import and profile"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function DatasetReview({
  dataset,
  onAdd,
  onBack,
  onUpdateSchema,
  busy,
  t,
}: {
  dataset: DatasetSource;
  onAdd: () => void;
  onBack: () => void;
  onUpdateSchema: (overrides: Record<string, string>) => Promise<void>;
  busy: boolean;
  t: Theme;
}) {
  const [overrides, setOverrides] = useState<Record<string, string>>(
    dataset.schemaOverrides ?? {},
  );
  return (
    <div style={{ padding: 14, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: t.textPrimary, fontSize: 13, fontWeight: 800 }}>
            {dataset.name}
          </div>
          <div style={{ color: t.textMuted, font: `10px ${t.fontMono}` }}>
            {dataset.alias} · {dataset.profile.rowCount.toLocaleString()} rows ·
            refreshed {new Date(dataset.refreshedAt).toLocaleString()}
          </div>
        </div>
        <span
          style={{
            color:
              dataset.trustState === "project_controlled"
                ? t.success
                : t.warning,
            border: `1px solid ${dataset.trustState === "project_controlled" ? t.success : t.warning}`,
            borderRadius: 999,
            padding: "2px 7px",
            fontSize: 9,
            fontWeight: 800,
          }}
        >
          {dataset.trustState.replace(/_/g, " ")}
        </span>
      </div>
      {dataset.profile.warnings.map((warning) => (
        <div key={warning} style={{ color: t.warning, fontSize: 10 }}>
          {warning}
        </div>
      ))}
      <div
        style={{
          overflow: "auto",
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 7,
        }}
      >
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}
        >
          <thead>
            <tr>
              {[
                "Column",
                "Type (editable)",
                "Nulls in preview",
                "Distinct",
                "Signals",
              ].map((heading) => (
                <th
                  key={heading}
                  style={{
                    textAlign: "left",
                    padding: 6,
                    color: t.textMuted,
                    borderBottom: `1px solid ${t.cellBorder}`,
                  }}
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dataset.profile.columns.map((column) => (
              <tr key={column.name}>
                <td style={cellStyle(t)}>{column.name}</td>
                <td style={cellStyle(t)}>
                  <select
                    value={overrides[column.name] ?? column.type}
                    onChange={(event) =>
                      setOverrides((current) => ({
                        ...current,
                        [column.name]: event.target.value,
                      }))
                    }
                    style={{
                      ...inputStyle(t),
                      padding: "3px 5px",
                      fontSize: 9,
                    }}
                  >
                    {[
                      "VARCHAR",
                      "BOOLEAN",
                      "BIGINT",
                      "DOUBLE",
                      "DECIMAL(18,2)",
                      "DATE",
                      "TIMESTAMP",
                      "JSON",
                    ].map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                    {![
                      "VARCHAR",
                      "BOOLEAN",
                      "BIGINT",
                      "DOUBLE",
                      "DECIMAL(18,2)",
                      "DATE",
                      "TIMESTAMP",
                      "JSON",
                    ].includes(column.type) && (
                      <option value={column.type}>{column.type}</option>
                    )}
                  </select>
                </td>
                <td style={cellStyle(t)}>{column.nullCount ?? 0}</td>
                <td style={cellStyle(t)}>{column.distinctCount ?? "—"}</td>
                <td style={cellStyle(t)}>{column.flags?.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <button onClick={onBack} style={secondaryButton(t)}>
          Import another
        </button>
        <div style={{ display: "flex", gap: 7 }}>
          <button
            disabled={busy}
            onClick={() => void onUpdateSchema(overrides)}
            style={secondaryButton(t)}
          >
            {busy ? "Saving…" : "Save types"}
          </button>
          <button onClick={onAdd} style={primaryButton(t)}>
            <Plus size={12} /> Add starter query
          </button>
        </div>
      </div>
      <div style={{ color: t.textMuted, font: `10px ${t.font}`, textAlign: 'right' }}>
        To combine with warehouse data: run a warehouse Query cell, then choose <strong>Combine with local data</strong> on its result.
      </div>
    </div>
  );
}

function DatasetList({
  datasets,
  busy,
  onUse,
  onRefresh,
  onRename,
  onPin,
  onRemove,
  t,
}: {
  datasets: DatasetSource[];
  busy: boolean;
  onUse: (dataset: DatasetSource) => void;
  onRefresh: (dataset: DatasetSource) => void;
  onRename: (dataset: DatasetSource) => void;
  onPin: (dataset: DatasetSource) => void;
  onRemove: (dataset: DatasetSource) => void;
  t: Theme;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(
    () =>
      datasets.filter((dataset) =>
        `${dataset.name} ${dataset.alias} ${dataset.tags.join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [datasets, query],
  );
  return (
    <div style={{ padding: 14, display: "grid", gap: 8 }}>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search datasets"
        style={inputStyle(t)}
      />
      {visible.length === 0 ? (
        <div
          style={{
            padding: 24,
            textAlign: "center",
            color: t.textMuted,
            fontSize: 11,
          }}
        >
          No imported datasets yet.
        </div>
      ) : (
        visible.map((dataset) => (
          <div
            key={dataset.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              border: `1px solid ${t.cellBorder}`,
              borderRadius: 7,
              padding: 9,
            }}
          >
            <Database size={14} color={t.accent} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{ color: t.textPrimary, fontSize: 11, fontWeight: 800 }}
              >
                {dataset.name}
                {dataset.pinned ? " · pinned" : ""}
              </div>
              <div style={{ color: t.textMuted, fontSize: 9 }}>
                {dataset.alias} · {dataset.profile.rowCount.toLocaleString()}{" "}
                rows · {dataset.storageMode} ·{" "}
                {new Date(dataset.refreshedAt).toLocaleString()}
              </div>
            </div>
            <button
              disabled={busy}
              title="Refresh"
              onClick={() => onRefresh(dataset)}
              style={iconButton(t)}
            >
              <RefreshCw size={12} />
            </button>
            <button
              disabled={busy}
              title="Rename"
              onClick={() => onRename(dataset)}
              style={iconButton(t)}
            >
              Aa
            </button>
            {dataset.storageMode === "staged" && (
              <button
                disabled={busy}
                title={dataset.pinned ? "Unpin" : "Pin"}
                onClick={() => onPin(dataset)}
                style={iconButton(t)}
              >
                {dataset.pinned ? "●" : "○"}
              </button>
            )}
            <button
              disabled={busy}
              title="Remove"
              onClick={() => onRemove(dataset)}
              style={iconButton(t)}
            >
              <Trash2 size={12} />
            </button>
            <button onClick={() => onUse(dataset)} style={primaryButton(t)}>
              Use
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function StorageChoice({
  active,
  title,
  description,
  onClick,
  t,
}: {
  active: boolean;
  title: string;
  description: string;
  onClick: () => void;
  t: Theme;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        textAlign: "left",
        border: `1px solid ${active ? t.accent : t.cellBorder}`,
        background: active ? `${t.accent}0c` : "transparent",
        borderRadius: 6,
        padding: 8,
        cursor: "pointer",
      }}
    >
      <div
        style={{
          color: active ? t.accent : t.textPrimary,
          fontSize: 10,
          fontWeight: 800,
        }}
      >
        {title}
      </div>
      <div style={{ color: t.textMuted, fontSize: 9, marginTop: 3 }}>
        {description}
      </div>
    </button>
  );
}
function labelStyle(t: Theme): React.CSSProperties {
  return { display: "grid", gap: 5, color: t.textSecondary, fontSize: 10 };
}
function inputStyle(t: Theme): React.CSSProperties {
  return {
    background: t.inputBg,
    color: t.textPrimary,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 6,
    padding: "7px 8px",
    font: `11px ${t.font}`,
  };
}
function primaryButton(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.accent}`,
    background: `${t.accent}15`,
    color: t.accent,
    borderRadius: 5,
    padding: "5px 9px",
    cursor: "pointer",
    font: `700 10px ${t.font}`,
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
  };
}
function secondaryButton(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.btnBorder}`,
    background: t.btnBg,
    color: t.textSecondary,
    borderRadius: 5,
    padding: "5px 9px",
    cursor: "pointer",
    font: `700 10px ${t.font}`,
  };
}
function iconButton(t: Theme): React.CSSProperties {
  return {
    width: 26,
    height: 26,
    border: `1px solid ${t.btnBorder}`,
    background: t.btnBg,
    color: t.textMuted,
    borderRadius: 5,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  };
}
function cellStyle(t: Theme): React.CSSProperties {
  return {
    padding: 6,
    color: t.textSecondary,
    borderBottom: `1px solid ${t.cellBorder}`,
  };
}
function formatBytes(value: number): string {
  return value < 1_000_000
    ? `${(value / 1_000).toFixed(1)} KB`
    : `${(value / 1_000_000).toFixed(1)} MB`;
}
