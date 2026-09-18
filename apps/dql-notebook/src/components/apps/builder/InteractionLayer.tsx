import { useEffect, useState } from 'react';
import { Blocks, X } from 'lucide-react';
import type { AppStudioBuildDraft } from '../../../api/client';
import type { DatasetDescriptor, DatasetPhysicalField } from '@duckcodeailabs/dql-core/datasets/descriptor';
import { datasetTileVisualizationCompatibility, tileQueryOutputAliases, tileQueryValidationRuns, validateTileQuery, type TileQuery } from '@duckcodeailabs/dql-core/apps/tile-query';
import { TileQueryEditor } from '../builder/TileQueryEditor';
import { humanize } from './studio-ui';

export function DatasetTileQueryInspector({
  descriptor,
  query,
  visualization,
  disabled,
  onChange,
  onOpenSources,
}: {
  descriptor: DatasetDescriptor;
  query: TileQuery;
  visualization: string;
  disabled: boolean;
  onChange: (next: TileQuery, recovery?: { visualization: 'table'; message: string }) => void;
  onOpenSources: () => void;
}): JSX.Element {
  // Saved tiles change only through a query the contract runs. A refused
  // edit leaves the tile as it was and says why.
  const commit = (next: TileQuery): string | void => {
    const validation = validateTileQuery(descriptor, next);
    if (!tileQueryValidationRuns(validation)) {
      return validation.diagnostics[0]?.message ?? 'That change is not covered by this Dataset.';
    }
    const visualizationContract = datasetTileVisualizationCompatibility(next, visualization);
    if (!visualizationContract.compatible) {
      const message = visualizationContract.message ?? 'This field selection needs a Table.';
      if (!visualizationContract.recoveryVisualization) return message;
      onChange(next, { visualization: visualizationContract.recoveryVisualization, message });
      return message;
    }
    onChange(next);
  };
  return <section className="dataset-query-inspector">
    <label>Dataset fields</label>
    <p>{descriptor.label} · changes rerun this tile against the same source revision.</p>
    <TileQueryEditor descriptor={descriptor} query={query} disabled={disabled} onChange={commit} idPrefix={`dataset-inspector-${descriptor.id}`} />
    <button type="button" className="dataset-change-source" disabled={disabled} onClick={onOpenSources}><Blocks size={12} /> Choose another Dataset</button>
  </section>;
}

export function DatasetInteractionInspector({
  tile,
  page,
  pages,
  sources,
  descriptor,
  disabled,
  onChange,
}: {
  tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number];
  page: AppStudioBuildDraft['pages'][number];
  pages: AppStudioBuildDraft['pages'];
  sources: AppStudioBuildDraft['sources'];
  descriptor: DatasetDescriptor;
  disabled: boolean;
  onChange: (interactions: AppStudioBuildDraft['pages'][number]['interactions']) => void;
}): JSX.Element {
  const sourceFields = tile.query
    ? tileQueryOutputAliases(tile.query).filter((output) => output.kind === 'dimension').map((output) => output.alias)
    : [];
  const targetDatasets = (page.datasets ?? []).flatMap((binding) => {
    const source = sources.find((candidate) => candidate.id === binding.sourceId && candidate.sourceRevision === binding.sourceRevision);
    const target = source?.capabilities?.dataset;
    return target ? [{ binding, descriptor: target, source }] : [];
  });
  const targetIds = targetDatasets.map((target) => target.binding.id).join('|');
  const [fromField, setFromField] = useState(sourceFields[0] ?? '');
  const [targetDatasetId, setTargetDatasetId] = useState(targetDatasets.find((target) => target.binding.sourceId !== tile.sourceId)?.binding.id ?? targetDatasets[0]?.binding.id ?? '');
  const [targetField, setTargetField] = useState('');
  const [navigationPageId, setNavigationPageId] = useState(pages.find((candidate) => candidate.id !== page.id)?.id ?? '');
  const [carryFilters, setCarryFilters] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const selectedTarget = targetDatasets.find((target) => target.binding.id === targetDatasetId);
  const targetFields = (selectedTarget?.descriptor.fields ?? []).filter((field): field is DatasetPhysicalField => field.kind === 'physical' && field.status === 'approved');
  const ownMappings = (page.interactions?.crossFilter?.mappings ?? []).filter((mapping) => mapping.fromTileId === tile.i);
  const ownNavigation = page.interactions?.navigate?.find((interaction) => interaction.fromTile === tile.i);
  const carryableFilters = page.filters?.map((filter) => filter.id) ?? [];

  useEffect(() => {
    if (!sourceFields.includes(fromField)) setFromField(sourceFields[0] ?? '');
  }, [fromField, sourceFields.join('|')]);
  useEffect(() => {
    if (!targetDatasets.some((target) => target.binding.id === targetDatasetId)) {
      setTargetDatasetId(targetDatasets.find((target) => target.binding.sourceId !== tile.sourceId)?.binding.id ?? targetDatasets[0]?.binding.id ?? '');
    }
  }, [targetDatasetId, targetIds, tile.sourceId]);
  useEffect(() => {
    if (!targetFields.some((field) => field.name === targetField)) setTargetField(targetFields[0]?.name ?? '');
  }, [targetDatasetId, targetField, targetFields.map((field) => field.name).join('|')]);
  useEffect(() => {
    if (!pages.some((candidate) => candidate.id === navigationPageId && candidate.id !== page.id)) {
      setNavigationPageId(pages.find((candidate) => candidate.id !== page.id)?.id ?? '');
    }
  }, [navigationPageId, page.id, pages.map((candidate) => candidate.id).join('|')]);
  useEffect(() => setCarryFilters(ownNavigation?.carryFilters ?? []), [ownNavigation?.carryFilters?.join('|'), tile.i]);

  const saveCrossFilter = () => {
    if (!fromField || !selectedTarget || !targetField) {
      setMessage('Choose an output field and an approved target Dataset field before saving this mapping.');
      return;
    }
    const existing = page.interactions?.crossFilter?.mappings ?? [];
    const mappings = [
      ...existing.filter((mapping) => !(mapping.fromTileId === tile.i && mapping.fromField === fromField && mapping.toDataset === selectedTarget.binding.id)),
      { fromTileId: tile.i, fromField, toDataset: selectedTarget.binding.id, toField: targetField },
    ];
    onChange({
      ...(page.interactions ?? {}),
      crossFilter: { ...(page.interactions?.crossFilter ?? {}), mappings },
    });
    setMessage(`Mapped ${humanize(fromField)} to ${selectedTarget.descriptor.label}.${humanize(targetField)}. Preview result marks can now filter that Dataset.`);
  };
  const removeCrossFilter = (index: number) => {
    const existing = page.interactions?.crossFilter?.mappings ?? [];
    const target = ownMappings[index];
    if (!target) return;
    const mappings = existing.filter((mapping) => mapping !== target);
    const next = { ...(page.interactions ?? {}) };
    if (mappings.length) next.crossFilter = { ...(page.interactions?.crossFilter ?? {}), mappings };
    else delete next.crossFilter;
    onChange(next);
  };
  const saveNavigation = () => {
    if (!navigationPageId) {
      setMessage('Add another App page before configuring detail navigation.');
      return;
    }
    const navigate = [
      ...(page.interactions?.navigate ?? []).filter((interaction) => interaction.fromTile !== tile.i),
      { fromTile: tile.i, toPage: navigationPageId, carryFilters },
    ];
    onChange({ ...(page.interactions ?? {}), navigate });
    setMessage(`Detail navigation now opens ${pages.find((candidate) => candidate.id === navigationPageId)?.metadata.title ?? navigationPageId} and carries the selected shared filters.`);
  };
  const removeNavigation = () => {
    const navigate = (page.interactions?.navigate ?? []).filter((interaction) => interaction.fromTile !== tile.i);
    const next = { ...(page.interactions ?? {}) };
    if (navigate.length) next.navigate = navigate;
    else delete next.navigate;
    onChange(next);
    setMessage('Detail navigation removed.');
  };

  return <section className="dataset-interaction-inspector">
    <label>Interactions</label>
    <p>Map a selected output to a specific approved field. Matching display names never create a cross-filter.</p>
    {sourceFields.length && targetDatasets.length ? <div className="dataset-interaction-form">
      <select aria-label="Source result field" value={fromField} disabled={disabled} onChange={(event) => setFromField(event.target.value)}>{sourceFields.map((field) => <option key={field} value={field}>{humanize(field)}</option>)}</select>
      <select aria-label="Target Dataset" value={targetDatasetId} disabled={disabled} onChange={(event) => setTargetDatasetId(event.target.value)}>{targetDatasets.map((target) => <option key={target.binding.id} value={target.binding.id}>{target.descriptor.label}</option>)}</select>
      <select aria-label="Target Dataset field" value={targetField} disabled={disabled || !targetFields.length} onChange={(event) => setTargetField(event.target.value)}>{targetFields.map((field) => <option key={field.qualifiedId} value={field.name}>{humanize(field.name)}</option>)}</select>
      <button type="button" disabled={disabled} onClick={saveCrossFilter}>Map cross-filter</button>
    </div> : <small className="field-help">Add a grouped Dataset tile and a second bound Dataset to map result marks across sources.</small>}
    {ownMappings.length ? <div className="dataset-interaction-list">{ownMappings.map((mapping, index) => <span key={`${mapping.fromField}:${mapping.toDataset}:${mapping.toField}`}>{humanize(mapping.fromField)} → {humanize(mapping.toField)}<button type="button" disabled={disabled} onClick={() => removeCrossFilter(index)} aria-label={`Remove ${mapping.fromField} mapping`}><X size={11} /></button></span>)}</div> : null}
    <div className="dataset-navigation-form">
      <small>Details navigation</small>
      <select aria-label="Detail page" value={navigationPageId} disabled={disabled || pages.length < 2} onChange={(event) => setNavigationPageId(event.target.value)}>{pages.filter((candidate) => candidate.id !== page.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.metadata.title}</option>)}</select>
      {carryableFilters.length ? <div className="dataset-navigation-filters">{carryableFilters.map((filterId) => <label key={filterId}><input type="checkbox" checked={carryFilters.includes(filterId)} disabled={disabled} onChange={() => setCarryFilters((current) => current.includes(filterId) ? current.filter((id) => id !== filterId) : [...current, filterId])} /> Carry {humanize(filterId)}</label>)}</div> : <small className="field-help">Add a shared filter to carry it into the detail page.</small>}
      <span><button type="button" disabled={disabled || pages.length < 2} onClick={saveNavigation}>Save details navigation</button>{ownNavigation ? <button type="button" disabled={disabled} onClick={removeNavigation}>Remove</button> : null}</span>
    </div>
    {message ? <small className="dataset-interaction-message" role="status">{message}</small> : null}
  </section>;
}
