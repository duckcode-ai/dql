import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Database, Link2, X } from 'lucide-react';
import { api, type DatasetSource, type MixedSourceNotebookPlan } from '../../api/client';
import type { Theme } from '../../themes/notebook-theme';
import { estimateJoinCardinality, suggestJoinPairs, type JoinCardinality } from '../../utils/dataset-references';

export interface CombineDataRequest {
  dataset: DatasetSource;
  warehouseKey: string;
  localKey: string;
  joinType: 'left' | 'inner';
  cardinality: JoinCardinality;
}

export function CombineDataPanel({
  warehouseColumns,
  warehouseRows,
  warehouseRowCount,
  busy,
  t,
  onCancel,
  onCombine,
  suggestedPlan,
}: {
  warehouseColumns: string[];
  warehouseRows: Array<Record<string, unknown>>;
  warehouseRowCount: number;
  busy: boolean;
  t: Theme;
  onCancel: () => void;
  onCombine: (request: CombineDataRequest) => void;
  suggestedPlan?: MixedSourceNotebookPlan;
}) {
  const [datasets, setDatasets] = useState<DatasetSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [datasetId, setDatasetId] = useState('');
  const [warehouseKey, setWarehouseKey] = useState('');
  const [localKey, setLocalKey] = useState('');
  const [joinType, setJoinType] = useState<'left' | 'inner'>('left');
  const [acceptedManyToMany, setAcceptedManyToMany] = useState(false);
  const [acceptedUnmatchedKeys, setAcceptedUnmatchedKeys] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api.getDatasets()
      .then((payload) => {
        if (cancelled) return;
        const reusable = payload.datasets.filter((dataset) => dataset.storageMode !== 'staged');
        setDatasets(reusable);
        const suggested = reusable.find((dataset) =>
          dataset.id === suggestedPlan?.datasetId || dataset.alias === suggestedPlan?.localDataset,
        );
        setDatasetId((current) => current || suggested?.id || reusable[0]?.id || '');
      })
      .catch((failure) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [suggestedPlan?.datasetId, suggestedPlan?.localDataset]);

  const dataset = datasets.find((item) => item.id === datasetId);
  const suggestions = useMemo(
    () => dataset ? suggestJoinPairs(warehouseColumns, dataset.profile.columns) : [],
    [dataset, warehouseColumns],
  );

  useEffect(() => {
    const matchesSuggested = dataset && (
      dataset.id === suggestedPlan?.datasetId || dataset.alias === suggestedPlan?.localDataset
    );
    if (matchesSuggested && suggestedPlan) {
      setWarehouseKey(warehouseColumns.includes(suggestedPlan.warehouseKey) ? suggestedPlan.warehouseKey : '');
      setLocalKey(dataset.profile.columns.some((column) => column.name === suggestedPlan.localKey) ? suggestedPlan.localKey : '');
      setAcceptedManyToMany(false);
      setAcceptedUnmatchedKeys(false);
      return;
    }
    const best = suggestions[0];
    setWarehouseKey(best?.warehouseKey ?? '');
    setLocalKey(best?.localKey ?? '');
    setAcceptedManyToMany(false);
    setAcceptedUnmatchedKeys(false);
  }, [dataset, datasetId, suggestedPlan, suggestions, warehouseColumns]);

  const localColumn = dataset?.profile.columns.find((column) => column.name === localKey);
  const cardinality = estimateJoinCardinality({
    warehouseRows,
    warehouseKey,
    localDistinctCount: localColumn?.distinctCount,
    localSampledRows: dataset?.profile.sampledRows,
  });
  const manyToMany = cardinality === 'many_to_many';
  const noSuggestedKey = suggestions.length === 0;
  const canCombine = Boolean(
    dataset
      && warehouseKey
      && localKey
      && (!manyToMany || acceptedManyToMany)
      && (!noSuggestedKey || acceptedUnmatchedKeys),
  );

  return (
    <div style={{ padding: 12, borderBottom: `1px solid ${t.cellBorder}`, background: `${t.accent}08`, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Link2 size={14} color={t.accent} />
        <div style={{ flex: 1 }}>
          <div style={{ color: t.textPrimary, font: `800 12px ${t.font}` }}>Combine warehouse result with local data</div>
          <div style={{ color: t.textMuted, font: `10px ${t.font}` }}>The warehouse query is staged with limits, then the join runs in the local analysis workspace.</div>
          {suggestedPlan && <div style={{ color: t.accent, font: `700 10px ${t.font}`, marginTop: 2 }}>AI prepared this handoff · confirm {suggestedPlan.warehouseKey} = {suggestedPlan.localKey}</div>}
        </div>
        <button aria-label="Close combine data" onClick={onCancel} style={{ border: 0, background: 'transparent', color: t.textMuted, cursor: 'pointer' }}><X size={15} /></button>
      </div>

      {loading ? (
        <div style={{ color: t.textMuted, fontSize: 11 }}>Loading local datasets…</div>
      ) : error ? (
        <div style={{ color: t.error, fontSize: 11 }}>{error}</div>
      ) : datasets.length === 0 ? (
        <div style={{ border: `1px dashed ${t.btnBorder}`, borderRadius: 7, padding: 12, color: t.textSecondary, fontSize: 11 }}>
          Import a CSV from <strong>Import data</strong> first, then return to this warehouse result.
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 8, alignItems: 'end' }}>
            <Field label="Local dataset" t={t}>
              <select value={datasetId} onChange={(event) => setDatasetId(event.target.value)} style={selectStyle(t)}>
                {datasets.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.profile.rowCount.toLocaleString()} rows</option>)}
              </select>
            </Field>
            <Field label="Warehouse key" t={t}>
              <select value={warehouseKey} onChange={(event) => { setWarehouseKey(event.target.value); setAcceptedManyToMany(false); }} style={selectStyle(t)}>
                {!warehouseKey && <option value="">Choose warehouse key…</option>}
                {warehouseColumns.map((column) => <option key={column} value={column}>{column}</option>)}
              </select>
            </Field>
            <Field label="Local key (=)" t={t}>
              <select value={localKey} onChange={(event) => { setLocalKey(event.target.value); setAcceptedManyToMany(false); }} style={selectStyle(t)}>
                {!localKey && <option value="">Choose local key…</option>}
                {dataset?.profile.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
              </select>
            </Field>
            <Field label="Join" t={t}>
              <select value={joinType} onChange={(event) => setJoinType(event.target.value as 'left' | 'inner')} style={selectStyle(t)}>
                <option value="left">Keep warehouse rows</option>
                <option value="inner">Matching rows only</option>
              </select>
            </Field>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center', color: t.textMuted, font: `10px ${t.font}` }}>
            <span><Database size={11} style={{ verticalAlign: '-2px' }} /> Up to {warehouseRowCount.toLocaleString()} current rows</span>
            <span>· staging limits 100,000 rows / 250 MB / 120 sec</span>
            <span>· CSV refreshed {dataset ? new Date(dataset.refreshedAt).toLocaleString() : '—'}</span>
            <span>· sample relationship: {cardinality.replace(/_/g, ' ')}</span>
            {suggestions[0] && warehouseKey === suggestions[0].warehouseKey && localKey === suggestions[0].localKey && (
              <span style={{ color: t.accent }}>· suggested: {suggestions[0].reason.toLowerCase()}</span>
            )}
          </div>

          {manyToMany && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, padding: 9, border: `1px solid ${t.warning}`, borderRadius: 7, color: t.warning, font: `10px ${t.font}` }}>
              <AlertTriangle size={13} style={{ flexShrink: 0 }} />
              <input type="checkbox" checked={acceptedManyToMany} onChange={(event) => setAcceptedManyToMany(event.target.checked)} />
              Both keys repeat in the bounded samples. This may multiply rows. Confirm that repeated matches are expected before continuing.
            </label>
          )}

          {noSuggestedKey && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, padding: 9, border: `1px solid ${t.warning}`, borderRadius: 7, color: t.warning, font: `10px ${t.font}` }}>
              <AlertTriangle size={13} style={{ flexShrink: 0 }} />
              <input type="checkbox" checked={acceptedUnmatchedKeys} onChange={(event) => setAcceptedUnmatchedKeys(event.target.checked)} />
              No likely business key was found. Choose both keys and confirm they represent the same entity. If they do not, refine the warehouse query or ask Notebook AI instead of forcing a join.
            </label>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
            <span style={{ color: t.warning, font: `700 10px ${t.font}` }}>Local mixed-source analysis · review required · never auto-certified</span>
            <div style={{ display: 'flex', gap: 7 }}>
              <button onClick={onCancel} style={secondaryButton(t)}>Cancel</button>
              <button
                disabled={!canCombine || busy}
                onClick={() => dataset && onCombine({ dataset, warehouseKey, localKey, joinType, cardinality })}
                style={{ ...primaryButton(t), opacity: canCombine && !busy ? 1 : .5 }}
              >
                {busy ? 'Staging and building…' : suggestedPlan ? 'Create joined analysis' : 'Stage and create analysis'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, t, children }: { label: string; t: Theme; children: React.ReactNode }) {
  return <label style={{ display: 'grid', gap: 4, color: t.textMuted, font: `700 9px ${t.font}`, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}{children}</label>;
}

function selectStyle(t: Theme): React.CSSProperties {
  return { width: '100%', minWidth: 0, height: 30, border: `1px solid ${t.btnBorder}`, borderRadius: 5, background: t.cellBg, color: t.textPrimary, padding: '0 7px', font: `11px ${t.font}` };
}

function secondaryButton(t: Theme): React.CSSProperties {
  return { border: `1px solid ${t.btnBorder}`, borderRadius: 5, background: t.btnBg, color: t.textSecondary, padding: '6px 10px', cursor: 'pointer', font: `700 10px ${t.font}` };
}

function primaryButton(t: Theme): React.CSSProperties {
  return { border: `1px solid ${t.accent}`, borderRadius: 5, background: t.accent, color: '#fff', padding: '6px 11px', cursor: 'pointer', font: `800 10px ${t.font}` };
}
