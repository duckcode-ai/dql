import React, { useEffect, useMemo, useState } from 'react';
import { Boxes, CheckCircle2, Columns3, Download, EyeOff, FileCode2, FolderTree, GitBranch, GraduationCap, Link2, Maximize2, Plus, RefreshCw, RotateCcw, Search, ShieldCheck, Sparkles, Table2, XCircle } from 'lucide-react';
import type { DomainExportAuthoringInput, DomainImportAuthoringInput, DbtNodeAuthoringDetail, ManifestModelEntity, ManifestModelRelationship, ModelingAuthoringChange, ModelingChangePreview, RelationshipAuthoringInput } from '@duckcodeailabs/dql-core';
import { api, type ContextBootstrapSession, type DbtFirstModelingResponse } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { SkillsPage } from '../skills/SkillsPage';
import { DomainModelingCanvas, type ColumnDisplayMode, type DiagramDensity, type DiagramLayoutMode, type ModelingLayer, type RelationshipDraft } from './DomainModelingCanvas';

type Theme = (typeof themes)['dark'];
type Tab = 'overview' | 'diagram' | 'interfaces' | 'contracts' | 'skills' | 'assets' | 'ai' | 'quality' | 'dbt';
type Editor =
  | { kind: 'domain' }
  | { kind: 'entity'; dbtUniqueId?: string; relationshipFrom?: { from: string; fromColumn?: string } }
  | {
      kind: 'relationship';
      relationship?: ManifestModelRelationship;
      draft?: RelationshipDraft;
    }
  | { kind: 'contract' }
  | { kind: 'export' }
  | { kind: 'import' };

export function DbtFirstModelingPage() {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const [data, setData] = useState<DbtFirstModelingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodeDetail, setNodeDetail] = useState<DbtNodeAuthoringDetail | null>(null);
  const [detailsByDbtId, setDetailsByDbtId] = useState<Record<string, DbtNodeAuthoringDetail | undefined>>({});
  const [modelingLayer, setModelingLayer] = useState<ModelingLayer>('analytics');
  const savedDiagramPreferences = useMemo(() => readDiagramPreferences(), []);
  const [columnMode, setColumnMode] = useState<ColumnDisplayMode>(savedDiagramPreferences.columnMode ?? 'relevant');
  const [diagramSearch, setDiagramSearch] = useState('');
  const [resetLayoutToken, setResetLayoutToken] = useState(0);
  const [layoutMode, setLayoutMode] = useState<DiagramLayoutMode>(savedDiagramPreferences.layoutMode ?? 'auto');
  const [diagramDensity, setDiagramDensity] = useState<DiagramDensity>(savedDiagramPreferences.density ?? 'normal');
  const [visibleLimit, setVisibleLimit] = useState(savedDiagramPreferences.visibleLimit ?? 0);
  const [dimUnrelated, setDimUnrelated] = useState(savedDiagramPreferences.dimUnrelated ?? true);
  const [showEdgeLabels, setShowEdgeLabels] = useState(savedDiagramPreferences.showEdgeLabels ?? true);
  const [showLegend, setShowLegend] = useState(false);
  const [diagramFullscreen, setDiagramFullscreen] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  useEffect(() => { localStorage.setItem('dql-modeling-preferences', JSON.stringify({ columnMode, layoutMode, density: diagramDensity, visibleLimit, dimUnrelated, showEdgeLabels })); }, [columnMode, layoutMode, diagramDensity, visibleLimit, dimUnrelated, showEdgeLabels]);

  const refresh = async () => {
    setLoading(true);
    const result = await api.getDbtFirstModeling();
    setData(result);
    setError(result ? null : 'dbt-first modeling is not enabled or the local server could not compile manifest v3.');
    if (result && selectedDomain === null) setSelectedDomain(Object.keys(result.modeling.packages).sort()[0] ?? null);
    setLoading(false);
  };
  useEffect(() => {
    void refresh();
  }, []);

  const selectedEntity = data?.modeling.entities[selectedId ?? ''];
  const selectedRelationship = data?.modeling.relationships[selectedId ?? ''];
  useEffect(() => {
    if (!selectedEntity) {
      setNodeDetail(null);
      return;
    }
    void api
      .getDbtModelingNode(selectedEntity.dbtUniqueId)
      .then(setNodeDetail)
      .catch(() => setNodeDetail(null));
  }, [selectedEntity?.dbtUniqueId]);
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    const ids = Object.values(data.modeling.entities).map((entity) => entity.dbtUniqueId);
    void Promise.all(
      ids.map(async (uniqueId) => {
        try {
          return [uniqueId, await api.getDbtModelingNode(uniqueId)] as const;
        } catch {
          return [uniqueId, undefined] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setDetailsByDbtId(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [data?.dbtProvenance.manifestFingerprint]);

  if (loading && !data) return <EmptyState t={t} title="Loading Domain Studio…" detail="Compiling dbt provenance and the sparse DQL analytical overlay." />;
  if (!data) return <EmptyState t={t} title="Domain Studio is unavailable" detail={error ?? 'Enable manifestVersion 3 and dbt-first modeling.'} />;

  const relationByDbtId = Object.fromEntries(Object.values(data.dbtProvenance.nodes).map((node) => [node.uniqueId, node.relation]));
  const domainEntities = Object.values(data.modeling.entities).filter((entity) => !selectedDomain || entity.domain === selectedDomain);
  const domainRelationships = Object.values(data.modeling.relationships).filter((relationship) => {
    const from = data.modeling.entities[relationship.from];
    const to = data.modeling.entities[relationship.to];
    return !selectedDomain || from?.domain === selectedDomain || to?.domain === selectedDomain;
  });
  const unboundNodes = Object.values(data.dbtProvenance.nodes).filter((node) => !Object.values(data.modeling.entities).some((entity) => entity.dbtUniqueId === node.uniqueId));

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: t.appBg,
        color: t.textPrimary,
      }}
    >
      <header
        style={{
          padding: '17px 20px 13px',
          borderBottom: `1px solid ${t.headerBorder}`,
          background: t.cellBg,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 18,
            alignItems: 'center',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <Boxes size={20} color={t.accent} />
              <h1 style={{ margin: 0, fontSize: 19 }}>Domain Studio</h1>
              <Badge t={t}>Manifest v3</Badge>
            </div>
            <p
              style={{
                margin: '5px 0 0 29px',
                color: t.textSecondary,
                fontSize: 12,
              }}
            >
              One Git-versioned workspace for domain context, dbt bindings, safe relationships, interfaces, contracts, blocks, skills, notebooks, and apps.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 7 }}>
            <Button t={t} onClick={() => setEditor({ kind: 'domain' })}>
              <Plus size={14} /> Domain
            </Button>
            <IconButton t={t} title="Recompile" onClick={() => void refresh()}>
              <RefreshCw size={15} />
            </IconButton>
          </div>
        </div>
      </header>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: 'clamp(190px, 15vw, 232px) minmax(460px, 1fr) clamp(270px, 22vw, 380px)',
        }}
      >
        <aside
          style={{
            borderRight: `1px solid ${t.headerBorder}`,
            overflow: 'auto',
            background: t.cellBg,
          }}
        >
          <SideHeading t={t}>Domain packages</SideHeading>
          <button
            onClick={() => {
              setSelectedDomain(null);
              setSelectedId(null);
            }}
            style={treeButton(t, selectedDomain === null)}
          >
            <GitBranch size={14} /> All domains
          </button>
          {sortDomainPackages(data.modeling.packages).map((pkg) => {
            const entities = Object.values(data.modeling.entities).filter((entity) => entity.domain === pkg.id);
            return (
              <div key={pkg.id}>
                <button
                  onClick={() => {
                    setSelectedDomain(pkg.id);
                    setSelectedId(null);
                  }}
                  style={{
                    ...treeButton(t, selectedDomain === pkg.id),
                    paddingLeft: 7 + domainDepth(pkg.id, data.modeling.packages) * 14,
                  }}
                >
                  <Boxes size={14} /> <span style={{ flex: 1 }}>{pkg.id.split('.').pop()}</span>
                  <small>{entities.length}</small>
                </button>
                {selectedDomain === pkg.id &&
                  entities.map((entity) => (
                    <button key={entity.id} onClick={() => setSelectedId(entity.id)} style={entityTreeButton(t, selectedId === entity.id)}>
                      <Table2 size={12} /> {entity.id}
                    </button>
                  ))}
              </div>
            );
          })}
          <SideHeading t={t}>dbt inventory</SideHeading>
          <div style={{ padding: '0 10px 12px', fontSize: 11, color: t.textMuted }}>{unboundNodes.length} unbound models</div>
          {unboundNodes.slice(0, 12).map((node) => (
            <button key={node.uniqueId} draggable onDragStart={(event) => { event.dataTransfer.setData('application/x-dql-dbt-model', node.uniqueId); event.dataTransfer.effectAllowed = 'copy'; }} title="Drag onto the Domain Model or click to bind" onClick={() => setEditor({ kind: 'entity', dbtUniqueId: node.uniqueId })} style={{ ...inventoryButton(t), cursor: 'grab' }}>
              <FileCode2 size={12} />
              <span>{node.name}</span>
              <Plus size={12} />
            </button>
          ))}
        </aside>

        <main
          style={{
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <nav
            style={{
              height: 42,
              display: 'flex',
              alignItems: 'end',
              gap: 2,
              padding: '0 12px',
              borderBottom: `1px solid ${t.headerBorder}`,
              background: t.cellBg,
            }}
          >
            {(['overview', 'diagram', 'interfaces', 'contracts', 'skills', 'assets', 'ai', 'quality', 'dbt'] as Tab[]).map((value) => (
              <button key={value} onClick={() => setTab(value)} style={tabButton(t, tab === value)}>
                {value === 'dbt' ? 'dbt sources' : value === 'ai' ? 'AI setup' : value === 'diagram' ? 'Domain Model' : value[0]!.toUpperCase() + value.slice(1)}
              </button>
            ))}
          </nav>
          <div style={{ flex: 1, minHeight: 0 }}>
            {tab === 'overview' && <DomainOverview data={data} domain={selectedDomain} t={t} />}
            {tab === 'diagram' && (
              <div id="dql-modeling-diagram"
                style={{
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  ...(diagramFullscreen ? { position: 'fixed', inset: 0, zIndex: 90, background: t.appBg } : {}),
                }}
              >
                <LayerToolbar layer={modelingLayer} columnMode={columnMode} search={diagramSearch} layoutMode={layoutMode} density={diagramDensity} visibleLimit={visibleLimit} totalEntities={Object.keys(data.modeling.entities).length} dimUnrelated={dimUnrelated} showEdgeLabels={showEdgeLabels} showLegend={showLegend} fullscreen={diagramFullscreen} onBindModel={() => setEditor({ kind: 'entity' })} onRelationship={() => setEditor({ kind: 'relationship' })} onChange={setModelingLayer} onColumnMode={setColumnMode} onSearch={setDiagramSearch} onLayoutMode={setLayoutMode} onDensity={setDiagramDensity} onVisibleLimit={setVisibleLimit} onDimUnrelated={setDimUnrelated} onEdgeLabels={setShowEdgeLabels} onLegend={setShowLegend} onFullscreen={() => setDiagramFullscreen((value) => !value)} onExport={() => exportDiagramSvg()} onReset={() => setResetLayoutToken((value) => value + 1)} t={t} />
                {showLegend && <DiagramLegend t={t} />}
                <div style={{ flex: 1, minHeight: 0 }}>
                  <DomainModelingCanvas modeling={data.modeling} relationByDbtId={relationByDbtId} detailsByDbtId={detailsByDbtId} selectedDomain={selectedDomain} selectedId={selectedId} layer={modelingLayer} columnMode={columnMode} search={diagramSearch} layoutMode={layoutMode} density={diagramDensity} visibleLimit={visibleLimit} dimUnrelated={dimUnrelated} showEdgeLabels={showEdgeLabels} resetLayoutToken={resetLayoutToken} onSelectEntity={setSelectedId} onSelectRelationship={setSelectedId} onDraftRelationship={(draft) => setEditor({ kind: 'relationship', draft })} onAddRelatedModel={(origin) => setEditor({ kind: 'entity', relationshipFrom: origin })} onDropDbtModel={(dbtUniqueId) => setEditor({ kind: 'entity', dbtUniqueId })} onCreateDomain={() => setEditor({ kind: 'domain' })} onEditEntity={(id) => { const entity = data.modeling.entities[id]; if (entity) setEditor({ kind: 'entity', dbtUniqueId: entity.dbtUniqueId }); }} onOpenAi={(id) => { setSelectedId(id); setTab('ai'); }} theme={t} />
                </div>
              </div>
            )}
            {tab === 'interfaces' && <InterfaceTable data={data} domain={selectedDomain} t={t} onCreateExport={() => setEditor({ kind: 'export' })} onCreateImport={() => setEditor({ kind: 'import' })} />}
            {tab === 'contracts' && <ContractTable data={data} domain={selectedDomain} t={t} onCreate={() => setEditor({ kind: 'contract' })} />}
            {tab === 'skills' && <SkillsPage embedded domainFilter={selectedDomain} />}
            {tab === 'assets' && <DomainAssetsPanel data={data} domain={selectedDomain} t={t} />}
            {tab === 'ai' && <ModelingAiPanel domain={selectedDomain} selectedId={selectedId} data={data} t={t} onOpenSkills={() => setTab('skills')} onDraftRelationship={() => setEditor({ kind: 'relationship', draft: selectedEntity ? { from: selectedEntity.id, to: '' } : undefined })} />}
            {tab === 'quality' && <QualityPanel data={data} relationships={domainRelationships} t={t} />}
            {tab === 'dbt' && <DbtInventory data={data} unbound={unboundNodes} t={t} onBind={(dbtUniqueId) => setEditor({ kind: 'entity', dbtUniqueId })} />}
          </div>
        </main>

        <aside
          style={{
            borderLeft: `1px solid ${t.headerBorder}`,
            overflow: 'auto',
            background: t.cellBg,
            minWidth: 0,
          }}
        >
          <SideHeading t={t}>Inspector</SideHeading>
          {selectedEntity ? (
            <EntityInspector
              entity={selectedEntity}
              detail={nodeDetail}
              t={t}
              onEdit={() =>
                setEditor({
                  kind: 'entity',
                  dbtUniqueId: selectedEntity.dbtUniqueId,
                })
              }
            />
          ) : selectedRelationship ? (
            <RelationshipInspector
              relationship={selectedRelationship}
              t={t}
              onEdit={() =>
                setEditor({
                  kind: 'relationship',
                  relationship: selectedRelationship,
                })
              }
            />
          ) : (
            <StudioSummary data={data} domainEntities={domainEntities} domainRelationships={domainRelationships} t={t} onSelectRelationship={setSelectedId} />
          )}
        </aside>
      </div>
      {editor && (
        <ModelingEditor
          editor={editor}
          data={data}
          selectedDomain={selectedDomain}
          t={t}
          onClose={() => setEditor(null)}
          onApplied={async (applied) => {
            setEditor(null);
            await refresh();
            if (editor.kind === 'entity' && editor.relationshipFrom && applied.operation === 'upsert_entity') {
              setEditor({ kind: 'relationship', draft: { ...editor.relationshipFrom, to: applied.value.id } });
            }
          }}
        />
      )}
    </div>
  );
}

function ModelingEditor({ editor, data, selectedDomain, t, onClose, onApplied }: { editor: Editor; data: DbtFirstModelingResponse; selectedDomain: string | null; t: Theme; onClose: () => void; onApplied: (change: ModelingAuthoringChange) => Promise<void> }) {
  const existing = editor.kind === 'relationship' ? editor.relationship : undefined;
  const relationshipDraft = editor.kind === 'relationship' ? editor.draft : undefined;
  const [domain, setDomain] = useState(selectedDomain ?? Object.keys(data.modeling.packages)[0] ?? '');
  const [id, setId] = useState(existing?.id ?? '');
  const [owner, setOwner] = useState(existing?.owner ?? '');
  const [parent, setParent] = useState('');
  const [dbtModel, setDbtModel] = useState(editor.kind === 'entity' ? (editor.dbtUniqueId ?? '') : '');
  const [grain, setGrain] = useState('');
  const [keys, setKeys] = useState('');
  const [from, setFrom] = useState(existing?.from ?? relationshipDraft?.from ?? '');
  const [to, setTo] = useState(existing?.to ?? relationshipDraft?.to ?? '');
  const [keyPairs, setKeyPairs] = useState(existing?.keys.map((key) => `${key.from}=${key.to}`).join(', ') ?? (relationshipDraft?.fromColumn && relationshipDraft.toColumn ? `${relationshipDraft.fromColumn}=${relationshipDraft.toColumn}` : ''));
  const [cardinality, setCardinality] = useState<RelationshipAuthoringInput['cardinality']>(existing?.cardinality ?? 'many_to_one');
  const [fanout, setFanout] = useState<RelationshipAuthoringInput['fanout']>(existing?.fanout ?? 'safe');
  const [lifecycle, setLifecycle] = useState<RelationshipAuthoringInput['status']>(existing?.status ?? 'draft');
  const [verb, setVerb] = useState(existing?.verb ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [fromRole, setFromRole] = useState(existing?.roles?.from ?? '');
  const [toRole, setToRole] = useState(existing?.roles?.to ?? '');
  const [fromOptionality, setFromOptionality] = useState(existing?.optionality?.from ?? 'unknown');
  const [toOptionality, setToOptionality] = useState(existing?.optionality?.to ?? 'unknown');
  const [joinTypes, setJoinTypes] = useState(existing?.joinTypes?.join(', ') ?? 'left');
  const [measureSources, setMeasureSources] = useState(existing?.aggregation?.measuresFrom.join(', ') ?? '');
  const [dimensionSources, setDimensionSources] = useState(existing?.aggregation?.dimensionsFrom.join(', ') ?? '');
  const [importRefs, setImportRefs] = useState(existing?.importRefs?.join(', ') ?? '');
  const [attributionBlock, setAttributionBlock] = useState(existing?.attributionBlock ?? '');
  const [evidenceExpiresAt, setEvidenceExpiresAt] = useState(existing?.evidenceExpiresAt ?? '');
  const [entities, setEntities] = useState('');
  const [blocks, setBlocks] = useState('');
  const [purpose, setPurpose] = useState('');
  const [metrics, setMetrics] = useState('');
  const [dimensions, setDimensions] = useState('');
  const [allowedFilters, setAllowedFilters] = useState('');
  const [requiredFilters, setRequiredFilters] = useState('');
  const [evaluationRefs, setEvaluationRefs] = useState('');
  const [exportEntity, setExportEntity] = useState('');
  const [allowedKeys, setAllowedKeys] = useState('');
  const [purposes, setPurposes] = useState('');
  const [consumerDomains, setConsumerDomains] = useState('');
  const [classification, setClassification] = useState('internal');
  const [exportRef, setExportRef] = useState('');
  const [preview, setPreview] = useState<ModelingChangePreview | null>(null);
  const [change, setChange] = useState<ModelingAuthoringChange | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [validation, setValidation] = useState(existing?.validation);
  const [showAdvancedRelationship, setShowAdvancedRelationship] = useState(Boolean(existing && (existing.roles || existing.aggregation || existing.importRefs?.length || existing.attributionBlock || existing.evidenceExpiresAt)));
  useEffect(() => {
    if (editor.kind !== 'relationship' || existing || id || !from || !to) return;
    setId(`${from}_to_${to}`.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase());
  }, [editor.kind, existing, from, to, id]);
  useEffect(() => {
    if (editor.kind !== 'entity' || id || !dbtModel) return;
    const name = data.dbtProvenance.nodes[dbtModel]?.name;
    if (name) setId(name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase());
  }, [editor.kind, id, dbtModel, data.dbtProvenance.nodes]);

  const buildChange = (): ModelingAuthoringChange => {
    if (editor.kind === 'domain')
      return {
        operation: 'upsert_domain',
        value: {
          id,
          name: id,
          owner,
          parent: parent || undefined,
          exports: [],
        },
      };
    if (editor.kind === 'entity')
      return {
        operation: 'upsert_entity',
        value: {
          id,
          domain,
          dbtModel,
          grain: grain || undefined,
          keys: csv(keys),
        },
      };
    if (editor.kind === 'contract')
      return {
        operation: 'upsert_contract',
        value: {
          id,
          domain,
          entities: csv(entities),
          blocks: csv(blocks),
          status: 'draft',
          owner,
          requiredEvaluation: true,
          purpose: purpose || undefined,
          metricRefs: csv(metrics),
          dimensions: csv(dimensions),
          allowedFilters: csv(allowedFilters),
          requiredFilters: csv(requiredFilters),
          evaluationRefs: csv(evaluationRefs),
        },
      };
    if (editor.kind === 'export')
      return {
        operation: 'upsert_export',
        value: {
          id,
          domain,
          entity: exportEntity || undefined,
          metrics: csv(metrics),
          blocks: csv(blocks),
          allowedKeys: csv(allowedKeys),
          allowedDimensions: csv(dimensions),
          allowedFilters: csv(allowedFilters),
          purposes: csv(purposes),
          consumerDomains: csv(consumerDomains),
          classification: classification || undefined,
          status: lifecycle,
          owner: owner || undefined,
        } satisfies DomainExportAuthoringInput,
      };
    if (editor.kind === 'import')
      return {
        operation: 'upsert_import',
        value: {
          id: id || undefined,
          domain,
          exportRef,
          purpose,
          status: lifecycle,
          owner: owner || undefined,
        } satisfies DomainImportAuthoringInput,
      };
    const parsedKeys = relationshipKeys(keyPairs);
    const unchanged = !existing || (existing.from === from && existing.to === to && JSON.stringify(existing.keys) === JSON.stringify(parsedKeys) && existing.cardinality === cardinality && existing.fanout === fanout);
    const currentValidation = unchanged ? validation : undefined;
    const status = lifecycle === 'certified' && currentValidation?.status !== 'passed' ? 'review' : lifecycle;
    const fromEntity = data.modeling.entities[from];
    const toEntity = data.modeling.entities[to];
    return {
      operation: 'upsert_relationship',
      value: {
        id,
        domain,
        from,
        to,
        keys: parsedKeys,
        cardinality,
        fanout,
        status,
        owner: owner || undefined,
        ownerDomain: domain,
        verb: verb || undefined,
        description: description || undefined,
        roles: fromRole || toRole ? { from: fromRole || undefined, to: toRole || undefined } : undefined,
        optionality: { from: fromOptionality, to: toOptionality },
        joinTypes: csv(joinTypes) as Array<'left' | 'inner'>,
        aggregation:
          measureSources || dimensionSources
            ? {
                measuresFrom: csv(measureSources),
                dimensionsFrom: csv(dimensionSources),
                requiresPreAggregation: fanout !== 'safe',
              }
            : undefined,
        attributionBlock: attributionBlock || undefined,
        importRefs: csv(importRefs),
        evidenceExpiresAt: evidenceExpiresAt || undefined,
        crossDomain: fromEntity?.domain !== toEntity?.domain,
        validation: currentValidation,
        certifiedAgainst:
          status === 'certified' && fromEntity?.grain && toEntity?.grain
            ? {
                from: { grain: fromEntity.grain, keys: fromEntity.keys },
                to: { grain: toEntity.grain, keys: toEntity.keys },
              }
            : undefined,
      },
    };
  };
  const previewChange = async () => {
    try {
      setBusy(true);
      setMessage(null);
      const next = buildChange();
      setChange(next);
      setPreview(await api.previewModelingChange(next));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const validate = async () => {
    try {
      setBusy(true);
      setMessage(null);
      const next = buildChange();
      if (next.operation !== 'upsert_relationship') return;
      const evidence = await api.validateModelingRelationship(next.value);
      setValidation(evidence);
      setMessage(evidence.status === 'passed' ? 'Warehouse proof passed. Preview the source change to save it.' : (evidence.message ?? 'Validation failed.'));
      setPreview(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!preview || !change) return;
    try {
      setBusy(true);
      await api.applyModelingChange(change, preview.fingerprint);
      await onApplied(change);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const title = editor.kind === 'domain' ? 'Create Domain Package' : editor.kind === 'entity' ? 'Bind dbt model' : editor.kind === 'contract' ? 'Create analytical contract' : editor.kind === 'export' ? 'Publish domain export' : editor.kind === 'import' ? 'Request domain import' : existing ? 'Edit relationship' : 'Create relationship';
  return (
    <Modal title={title} t={t} onClose={onClose}>
      {!preview ? (
        <div style={{ display: 'grid', gap: 12 }}>
          {editor.kind !== 'domain' && (
            <Field label="Domain">
              <Select value={domain} onChange={setDomain} values={Object.keys(data.modeling.packages)} t={t} />
            </Field>
          )}
          {editor.kind !== 'relationship' && <Field label={editor.kind === 'entity' ? 'Entity id' : editor.kind === 'contract' ? 'Contract id' : editor.kind === 'export' ? 'Export id' : editor.kind === 'import' ? 'Import id (optional)' : 'Domain id'}><Input value={id} onChange={setId} t={t} placeholder="stable_snake_case_id" /></Field>}
          {editor.kind === 'domain' && (
            <Field label="Parent domain (optional)">
              <Select value={parent} onChange={setParent} values={Object.keys(data.modeling.packages)} t={t} />
            </Field>
          )}
          {editor.kind === 'entity' && (
            <>
              <Field label="dbt model">
                <Select value={dbtModel} onChange={setDbtModel} values={Object.keys(data.dbtProvenance.nodes)} labels={Object.fromEntries(Object.values(data.dbtProvenance.nodes).map((node) => [node.uniqueId, `${node.name} · ${node.relation ?? node.uniqueId}`]))} t={t} />
              </Field>
              <div style={twoColumns}>
                <Field label="Grain override (optional)">
                  <Input value={grain} onChange={setGrain} t={t} placeholder="Use dbt meta.dql by default" />
                </Field>
                <Field label="Key overrides (optional)">
                  <Input value={keys} onChange={setKeys} t={t} placeholder="customer_id, order_id" />
                </Field>
              </div>
            </>
          )}
          {editor.kind === 'relationship' && (
            <>
              <Message text="Choose the two analytical entities and their join keys. DQL keeps the relationship in draft until warehouse validation passes." t={t} />
              <div style={twoColumns}>
                <Field label="From entity">
                  <Select value={from} onChange={setFrom} values={Object.keys(data.modeling.entities)} t={t} />
                </Field>
                <Field label="To entity">
                  <Select value={to} onChange={setTo} values={Object.keys(data.modeling.entities)} t={t} />
                </Field>
              </div>
              <Field label="Join key pairs">
                <Input value={keyPairs} onChange={setKeyPairs} t={t} placeholder="customer_id=customer_id, tenant_id=tenant_id" />
              </Field>
              {id && <div style={{ color: t.textMuted, fontSize: 9.5 }}>Relationship id: <code>{id}</code></div>}
              <div style={twoColumns}>
                <Field label="Cardinality">
                  <Select value={cardinality} onChange={(v) => setCardinality(v as RelationshipAuthoringInput['cardinality'])} values={['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']} t={t} />
                </Field>
                <Field label="Fanout policy">
                  <Select value={fanout} onChange={(v) => setFanout(v as RelationshipAuthoringInput['fanout'])} values={['safe', 'attribution_required', 'unsafe', 'unknown']} t={t} />
                </Field>
              </div>
              <div style={twoColumns}>
                <Field label="Business verb (optional)">
                  <Input value={verb} onChange={setVerb} t={t} placeholder="belongs to" />
                </Field>
                <Field label="Description (optional)">
                  <Input value={description} onChange={setDescription} t={t} placeholder="Why this relationship exists" />
                </Field>
              </div>
              {from && to && data.modeling.entities[from]?.domain !== data.modeling.entities[to]?.domain && <Message text="This is a cross-domain relationship. Add the approved provider import in Advanced governance before certification." t={t} />}
              <button type="button" onClick={() => setShowAdvancedRelationship((value) => !value)} style={{ ...linkButton(t), justifySelf: 'start', padding: '6px 0' }}>{showAdvancedRelationship ? 'Hide advanced governance' : 'Advanced governance and aggregation'}</button>
              {showAdvancedRelationship && <div style={{ display: 'grid', gap: 12, padding: 12, border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.cellBg }}>
                <div style={twoColumns}><Field label="Allowed join types"><Input value={joinTypes} onChange={setJoinTypes} t={t} placeholder="left, inner" /></Field><Field label="Lifecycle"><Select value={lifecycle ?? 'draft'} onChange={(v) => setLifecycle(v as RelationshipAuthoringInput['status'])} values={['draft', 'review', 'certified', 'deprecated']} t={t} /></Field></div>
                <div style={twoColumns}><Field label="From role"><Input value={fromRole} onChange={setFromRole} t={t} /></Field><Field label="To role"><Input value={toRole} onChange={setToRole} t={t} /></Field></div>
                <div style={twoColumns}><Field label="From optionality"><Select value={fromOptionality} onChange={(value) => setFromOptionality(value as 'required' | 'optional' | 'unknown')} values={['required', 'optional', 'unknown']} t={t} /></Field><Field label="To optionality"><Select value={toOptionality} onChange={(value) => setToOptionality(value as 'required' | 'optional' | 'unknown')} values={['required', 'optional', 'unknown']} t={t} /></Field></div>
                <div style={twoColumns}><Field label="Measures allowed from"><Input value={measureSources} onChange={setMeasureSources} t={t} placeholder="order" /></Field><Field label="Dimensions allowed from"><Input value={dimensionSources} onChange={setDimensionSources} t={t} placeholder="customer" /></Field></div>
                <div style={twoColumns}><Field label="Required import refs"><Input value={importRefs} onChange={setImportRefs} t={t} placeholder="commerce.customer@1" /></Field><Field label="Attribution block"><Input value={attributionBlock} onChange={setAttributionBlock} t={t} placeholder="growth.revenue_by_channel" /></Field></div>
                <div style={twoColumns}><Field label="Evidence expires"><Input value={evidenceExpiresAt} onChange={setEvidenceExpiresAt} t={t} placeholder="2026-12-31" /></Field><Field label="Owner"><Input value={owner} onChange={setOwner} t={t} placeholder="team@company.com" /></Field></div>
              </div>}
              {validation && <Evidence evidence={validation} t={t} />}
            </>
          )}
          {editor.kind === 'contract' && (
            <>
              <Field label="Covered entities">
                <Input value={entities} onChange={setEntities} t={t} placeholder="order, customer" />
              </Field>
              <Field label="Certified blocks">
                <Input value={blocks} onChange={setBlocks} t={t} placeholder="orders_360" />
              </Field>
              <Field label="Decision purpose">
                <Input value={purpose} onChange={setPurpose} t={t} placeholder="Revenue reporting" />
              </Field>
              <div style={twoColumns}>
                <Field label="Metrics">
                  <Input value={metrics} onChange={setMetrics} t={t} />
                </Field>
                <Field label="Dimensions">
                  <Input value={dimensions} onChange={setDimensions} t={t} />
                </Field>
              </div>
              <div style={twoColumns}>
                <Field label="Allowed filters">
                  <Input value={allowedFilters} onChange={setAllowedFilters} t={t} />
                </Field>
                <Field label="Required filters">
                  <Input value={requiredFilters} onChange={setRequiredFilters} t={t} />
                </Field>
              </div>
              <Field label="Evaluation refs">
                <Input value={evaluationRefs} onChange={setEvaluationRefs} t={t} placeholder="revenue_accuracy" />
              </Field>
            </>
          )}
          {editor.kind === 'export' && (
            <>
              <Field label="Exported entity">
                <Select value={exportEntity} onChange={setExportEntity} values={Object.keys(data.modeling.entities).filter((entityId) => data.modeling.entities[entityId]?.domain === domain)} t={t} />
              </Field>
              <div style={twoColumns}>
                <Field label="Allowed keys">
                  <Input value={allowedKeys} onChange={setAllowedKeys} t={t} />
                </Field>
                <Field label="Allowed dimensions">
                  <Input value={dimensions} onChange={setDimensions} t={t} />
                </Field>
              </div>
              <div style={twoColumns}>
                <Field label="Metrics">
                  <Input value={metrics} onChange={setMetrics} t={t} />
                </Field>
                <Field label="Blocks">
                  <Input value={blocks} onChange={setBlocks} t={t} />
                </Field>
              </div>
              <Field label="Allowed filters">
                <Input value={allowedFilters} onChange={setAllowedFilters} t={t} />
              </Field>
              <div style={twoColumns}>
                <Field label="Approved purposes">
                  <Input value={purposes} onChange={setPurposes} t={t} placeholder="revenue reporting" />
                </Field>
                <Field label="Consumer domains">
                  <Input value={consumerDomains} onChange={setConsumerDomains} t={t} placeholder="growth" />
                </Field>
              </div>
              <div style={twoColumns}>
                <Field label="Classification">
                  <Input value={classification} onChange={setClassification} t={t} />
                </Field>
                <Field label="Lifecycle">
                  <Select value={lifecycle ?? 'draft'} onChange={(v) => setLifecycle(v as RelationshipAuthoringInput['status'])} values={['draft', 'review', 'certified', 'deprecated']} t={t} />
                </Field>
              </div>
            </>
          )}
          {editor.kind === 'import' && (
            <>
              <Field label="Provider export">
                <Select value={exportRef} onChange={setExportRef} values={Object.values(data.modeling.interfaces?.exports ?? {}).map((item) => `${item.domain}.${item.id}@${item.version}`)} t={t} />
              </Field>
              <Field label="Exact analytical purpose">
                <Input value={purpose} onChange={setPurpose} t={t} placeholder="Revenue by acquisition channel" />
              </Field>
              <Field label="Lifecycle">
                <Select value={lifecycle ?? 'draft'} onChange={(v) => setLifecycle(v as RelationshipAuthoringInput['status'])} values={['draft', 'review', 'certified', 'deprecated']} t={t} />
              </Field>
            </>
          )}
          {editor.kind !== 'entity' && editor.kind !== 'relationship' && (
            <Field label="Owner">
              <Input value={owner} onChange={setOwner} t={t} placeholder="team@company.com" />
            </Field>
          )}
          {message && <Message text={message} t={t} />}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {editor.kind === 'relationship' && (
              <Button t={t} onClick={() => void validate()} disabled={busy}>
                <ShieldCheck size={14} /> Validate in warehouse
              </Button>
            )}
            <Button primary t={t} onClick={() => void previewChange()} disabled={busy}>
              Preview source change
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <p style={{ margin: '0 0 12px', fontSize: 12, color: t.textSecondary }}>Review the exact Domain Package source change before it is written.</p>
          {preview.patches.map((patch) => (
            <div key={patch.path} style={{ marginBottom: 12 }}>
              <strong style={{ fontSize: 12 }}>{patch.path}</strong>
              <pre style={sourcePreview(t)}>{patch.after}</pre>
            </div>
          ))}
          {message && <Message text={message} t={t} />}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button t={t} onClick={() => setPreview(null)}>
              Back
            </Button>
            <Button primary t={t} onClick={() => void apply()} disabled={busy}>
              Apply to Domain Package
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function DomainOverview({ data, domain, t }: { data: DbtFirstModelingResponse; domain: string | null; t: Theme }) {
  const packages = Object.values(data.modeling.packages).filter((pkg) => !domain || pkg.id === domain || pkg.parent === domain);
  const entities = Object.values(data.modeling.entities).filter((entity) => !domain || entity.domain === domain);
  const relationships = Object.values(data.modeling.relationships).filter((relationship) => !domain || data.modeling.entities[relationship.from]?.domain === domain || data.modeling.entities[relationship.to]?.domain === domain);
  const exports = Object.values(data.modeling.interfaces?.exports ?? {}).filter((item) => !domain || item.domain === domain);
  const imports = Object.values(data.modeling.interfaces?.imports ?? {}).filter((item) => !domain || item.domain === domain);
  const pkg = domain ? data.modeling.packages[domain] : undefined;
  const assets = domain
    ? (data.domainAssets?.[domain] ?? {})
    : Object.values(data.domainAssets ?? {}).reduce<Record<string, string[]>>((all, packageAssets) => {
        for (const [kind, paths] of Object.entries(packageAssets)) all[kind] = [...(all[kind] ?? []), ...paths];
        return all;
      }, {});
  return (
    <ScrollPanel>
      <PanelHeader title={pkg?.id ?? 'All Domain Packages'} detail="The Domain Package is the ownership and retrieval boundary. Everything below is source-controlled and compiled into one agent context graph." t={t} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, minmax(110px, 1fr))',
          gap: 10,
        }}
      >
        <Metric value={packages.length} label="Packages" color={t.accent} t={t} />
        <Metric value={entities.length} label="dbt bindings" color="#377cc8" t={t} />
        <Metric value={relationships.length} label="join policies" color="#2e9b63" t={t} />
        <Metric value={exports.length} label="exports" color="#9a6b2f" t={t} />
        <Metric value={imports.length} label="imports" color="#8b5fc7" t={t} />
      </div>
      <h3 style={sectionHeading(t)}>Unified package structure</h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(180px, 1fr))',
          gap: 10,
        }}
      >
        {[
          ['Context', 'domain.dql · terms/ · skills/', 'Business meaning, ownership, vocabulary, and reusable agent instructions.'],
          ['Semantic model', 'modeling/ · views/', 'dbt bindings, relationship proof, contracts, conformance, exports, and imports.'],
          ['Analytical products', 'blocks/ · notebooks/ · apps/', 'Certified building blocks, research evidence, and stakeholder experiences.'],
        ].map(([title, path, detail]) => (
          <div key={title} style={overviewCard(t)}>
            <b>{title}</b>
            <code
              style={{
                display: 'block',
                color: t.accent,
                fontSize: 10,
                margin: '7px 0',
              }}
            >
              {path}
            </code>
            <span style={{ color: t.textSecondary, fontSize: 11, lineHeight: 1.5 }}>{detail}</span>
          </div>
        ))}
      </div>
      <h3 style={sectionHeading(t)}>Package assets</h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(120px, 1fr))',
          gap: 8,
        }}
      >
        {['terms', 'skills', 'blocks', 'views', 'notebooks', 'apps', 'evaluations', 'tests'].map((kind) => (
          <div key={kind} style={overviewCard(t)}>
            <b style={{ textTransform: 'capitalize', fontSize: 11 }}>{kind}</b>
            <div style={{ fontSize: 22, marginTop: 7 }}>{assets[kind]?.length ?? 0}</div>
            <div style={{ color: t.textMuted, fontSize: 9, marginTop: 4 }}>{assets[kind]?.[0] ?? `domains/.../${kind}/`}</div>
          </div>
        ))}
      </div>
      <h3 style={sectionHeading(t)}>Accuracy flow</h3>
      <div style={flowRow(t)}>
        {['Question + user scope', 'Domain/skill retrieval', 'Certified block or metric', 'Safe relationship path', 'SQL policy validation', 'Answer + complete lineage'].map((item, index) => (
          <React.Fragment key={item}>
            <div style={flowStep(t)}>
              <small>{index + 1}</small>
              {item}
            </div>
            {index < 5 && <span style={{ color: t.textMuted }}>→</span>}
          </React.Fragment>
        ))}
      </div>
      {pkg && (
        <div style={{ marginTop: 18 }}>
          <Property label="Canonical declaration" value={pkg.filePath} t={t} />
          <Property label="Parent" value={pkg.parent ?? 'Top-level domain'} t={t} />
          <Property label="Owner" value={pkg.owner ?? 'Not declared'} t={t} />
        </div>
      )}
    </ScrollPanel>
  );
}

function LayerToolbar({ layer, columnMode, search, layoutMode, density, visibleLimit, totalEntities, dimUnrelated, showEdgeLabels, showLegend, fullscreen, onBindModel, onRelationship, onChange, onColumnMode, onSearch, onLayoutMode, onDensity, onVisibleLimit, onDimUnrelated, onEdgeLabels, onLegend, onFullscreen, onExport, onReset, t }: { layer: ModelingLayer; columnMode: ColumnDisplayMode; search: string; layoutMode: DiagramLayoutMode; density: DiagramDensity; visibleLimit: number; totalEntities: number; dimUnrelated: boolean; showEdgeLabels: boolean; showLegend: boolean; fullscreen: boolean; onBindModel: () => void; onRelationship: () => void; onChange: (layer: ModelingLayer) => void; onColumnMode: (mode: ColumnDisplayMode) => void; onSearch: (value: string) => void; onLayoutMode: (mode: DiagramLayoutMode) => void; onDensity: (density: DiagramDensity) => void; onVisibleLimit: (limit: number) => void; onDimUnrelated: (value: boolean) => void; onEdgeLabels: (value: boolean) => void; onLegend: (value: boolean) => void; onFullscreen: () => void; onExport: () => void; onReset: () => void; t: Theme }) {
  const copy: Record<ModelingLayer, string> = {
    business: 'Business meaning for the same entities and relationships.',
    analytics: 'Adds agent-safe grain, keys, cardinality, fanout, and governed relationship authoring.',
    implementation: 'Adds read-only dbt columns, types, tests, lineage, and physical join evidence.',
  };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minHeight: 50,
        padding: '0 10px',
        borderBottom: `1px solid ${t.headerBorder}`,
        background: t.cellBg,
        flexWrap: 'nowrap',
        overflowX: 'auto',
        scrollbarWidth: 'thin',
      }}
    >
      <span style={{ color: t.textMuted, fontSize: 9, fontWeight: 700, textTransform: 'uppercase' }}>Detail</span>
      {(['business', 'analytics', 'implementation'] as ModelingLayer[]).map((value) => (
        <button
          key={value}
          onClick={() => onChange(value)}
          style={{
            ...linkButton(t),
            border: `1px solid ${layer === value ? t.accent : t.headerBorder}`,
            borderRadius: 6,
            padding: '6px 9px',
            color: layer === value ? t.accent : t.textSecondary,
            background: layer === value ? `${t.accent}10` : 'transparent',
            textTransform: 'capitalize',
          }}
        >
          {value === 'implementation' ? '+ dbt implementation' : value === 'analytics' ? '+ Analytics' : 'Business'}
        </button>
      ))}
      {layer !== 'business' && <><IconButton t={t} title="Bind dbt model" onClick={onBindModel}><Plus size={14} /></IconButton><IconButton t={t} title="Create relationship" onClick={onRelationship}><Link2 size={14} /></IconButton></>}
      <span title={copy[layer]} style={{ marginLeft: 4, color: t.textMuted, fontSize: 10, maxWidth: 245, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{copy[layer]}</span>
      {layer !== 'business' && <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: t.textMuted, fontSize: 10 }}><Columns3 size={13} /><select aria-label="Visible columns" value={columnMode} onChange={(event) => onColumnMode(event.target.value as ColumnDisplayMode)} style={{ ...inputStyle(t), width: 104, padding: '5px 6px' }}><option value="keys">Keys only</option><option value="relevant">Relevant</option><option value="all">All columns</option></select></label>}
      <label style={{ position: 'relative', width: 138, flex: '0 0 138px' }}><Search size={12} style={{ position: 'absolute', left: 7, top: 8, color: t.textMuted }} /><input aria-label="Search diagram" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Find model or column" style={{ ...inputStyle(t), padding: '6px 7px 6px 24px' }} /></label>
      <select aria-label="Diagram layout" value={layoutMode} onChange={(event) => { onLayoutMode(event.target.value as DiagramLayoutMode); onReset(); }} style={{ ...inputStyle(t), width: 94, padding: '5px 6px' }}><option value="auto">Auto</option><option value="grid">Grid</option><option value="star">Star</option></select>
      <select aria-label="Diagram density" value={density} onChange={(event) => onDensity(event.target.value as DiagramDensity)} style={{ ...inputStyle(t), width: 92, padding: '5px 6px' }}><option value="compact">Compact</option><option value="normal">Normal</option><option value="wide">Wide</option></select>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: t.textMuted, fontSize: 9 }}>Show <input aria-label="Visible model limit" type="number" min={0} max={totalEntities} value={visibleLimit || totalEntities} onChange={(event) => onVisibleLimit(Math.max(0, Number(event.target.value) >= totalEntities ? 0 : Number(event.target.value)))} style={{ ...inputStyle(t), width: 52, padding: '5px' }} /></label>
      <button title="Dim unrelated models" onClick={() => onDimUnrelated(!dimUnrelated)} style={{ ...iconButtonStyle(t), color: dimUnrelated ? t.accent : t.textMuted }}><EyeOff size={14} /></button>
      <button title="Toggle relationship labels" onClick={() => onEdgeLabels(!showEdgeLabels)} style={{ ...iconButtonStyle(t), color: showEdgeLabels ? t.accent : t.textMuted }}><Link2 size={14} /></button>
      <button title="Relationship legend" onClick={() => onLegend(!showLegend)} style={{ ...iconButtonStyle(t), color: showLegend ? t.accent : t.textMuted }}><Boxes size={14} /></button>
      <button title="Export diagram as SVG" onClick={onExport} style={iconButtonStyle(t)}><Download size={14} /></button>
      <button title={fullscreen ? 'Exit fullscreen' : 'Fullscreen diagram'} onClick={onFullscreen} style={iconButtonStyle(t)}>{fullscreen ? <XCircle size={14} /> : <Maximize2 size={14} />}</button>
      <button title="Reset to automatic layout" onClick={onReset} style={iconButtonStyle(t)}><RotateCcw size={14} /></button>
    </div>
  );
}

function DiagramLegend({ t }: { t: Theme }) { return <div style={{ display: 'flex', gap: 14, padding: '7px 12px', borderBottom: `1px solid ${t.headerBorder}`, background: t.cellBg, color: t.textSecondary, fontSize: 9.5 }}>{[['Safe certified', '#2e9b63'], ['Validated review', '#5b73d6'], ['Attribution / draft', '#9a6b2f'], ['Stale certification', '#d47822']].map(([label, color]) => <span key={label} style={{ display: 'flex', gap: 5, alignItems: 'center' }}><i style={{ display: 'inline-block', width: 18, height: 3, background: color, borderRadius: 2 }} />{label}</span>)}<span style={{ marginLeft: 'auto' }}>1:1 · 1:N · N:1 · N:N</span></div>; }

function exportDiagramSvg() {
  const source = document.querySelector('#dql-modeling-diagram .react-flow__renderer');
  if (!(source instanceof HTMLElement)) return;
  const clone = source.cloneNode(true) as HTMLElement;
  const rect = source.getBoundingClientRect();
  const serialized = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(rect.width)}" height="${Math.ceil(rect.height)}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${serialized}</div></foreignObject></svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = 'dql-domain-model.svg'; anchor.click();
  URL.revokeObjectURL(url);
}

function DomainAssetsPanel({ data, domain, t }: { data: DbtFirstModelingResponse; domain: string | null; t: Theme }) {
  const assets = domain
    ? (data.domainAssets?.[domain] ?? {})
    : Object.values(data.domainAssets ?? {}).reduce<Record<string, string[]>>((all, current) => {
        for (const [kind, paths] of Object.entries(current)) all[kind] = [...(all[kind] ?? []), ...paths];
        return all;
      }, {});
  return (
    <ScrollPanel>
      <PanelHeader title="Domain assets" detail="Blocks, views, notebooks, apps, tests, and evaluations live inside the selected Domain Package and compile into the same governed context graph." t={t} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(250px, 1fr))',
          gap: 12,
        }}
      >
        {['terms', 'blocks', 'views', 'notebooks', 'apps', 'evaluations', 'tests'].map((kind) => (
          <section key={kind} style={overviewCard(t)}>
            <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
              <FolderTree size={14} color={t.accent} />
              <b style={{ textTransform: 'capitalize' }}>{kind}</b>
              <Badge t={t}>{assets[kind]?.length ?? 0}</Badge>
            </div>
            {assets[kind]?.length ? (
              assets[kind]!.map((path) => (
                <code
                  key={path}
                  style={{
                    display: 'block',
                    padding: '7px 0',
                    borderBottom: `1px solid ${t.headerBorder}`,
                    color: t.textSecondary,
                    fontSize: 10,
                  }}
                >
                  {path}
                </code>
              ))
            ) : (
              <p style={{ color: t.textMuted, fontSize: 11 }}>No {kind} in this domain yet.</p>
            )}
          </section>
        ))}
      </div>
    </ScrollPanel>
  );
}

function ModelingAiPanel({ domain, selectedId, data, t, onOpenSkills, onDraftRelationship }: { domain: string | null; selectedId: string | null; data: DbtFirstModelingResponse; t: Theme; onOpenSkills: () => void; onDraftRelationship: () => void }) {
  const [session, setSession] = useState<ContextBootstrapSession | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const start = async () => {
    try {
      setBusy(true);
      setMessage(null);
      const next = await api.startContextBootstrap({ ai: true });
      setSession(next);
      setSelected(next.candidates.filter((candidate) => !domain || candidate.kind !== 'domain' || candidate.domain?.id === domain).map((candidate) => candidate.id));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!session) return;
    try {
      setBusy(true);
      await api.saveContextBootstrapSelected(session.id, selected);
      setMessage('Selected domain and skill drafts were saved. Review them in Git before activation.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollPanel>
      <PanelHeader
        title="Modeling Copilot"
        detail="AI can propose business context and modeling work from dbt evidence. It writes drafts only; relationships, contracts, blocks, and skills still require explicit review."
        t={t}
        action={
          <Button primary t={t} onClick={() => void start()} disabled={busy}>
            <Sparkles size={14} /> Analyze project
          </Button>
        }
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(190px, 1fr))',
          gap: 10,
          marginBottom: 18,
        }}
      >
        <AiCapability icon={<Boxes size={16} />} title="Domains and concepts" detail="Detect ownership boundaries, vocabulary, concepts, and candidate subdomains." t={t} />
        <AiCapability
          icon={<Link2 size={16} />}
          title="Relationship proposals"
          detail="Suggest keys and cardinality from dbt evidence, then require warehouse validation."
          t={t}
          action={
            <button style={linkButton(t)} onClick={onDraftRelationship}>
              Draft manually
            </button>
          }
        />
        <AiCapability
          icon={<GraduationCap size={16} />}
          title="Domain skills"
          detail="Draft governed vocabulary, preferred metrics, blocks, and clarification rules."
          t={t}
          action={
            <button style={linkButton(t)} onClick={onOpenSkills}>
              Manage skills
            </button>
          }
        />
      </div>
    <Message text={`Active scope: ${domain ?? 'all domains'}${selectedId ? ` · focused object: ${selectedId}` : ''} · ${Object.keys(data.modeling.entities).length} bindings · ${Object.keys(data.modeling.relationships).length} governed relationships. AI proposals never treat dbt lineage as join proof and never auto-certify.`} t={t} />
      {session && (
        <div style={{ marginTop: 16 }}>
          <h3 style={sectionHeading(t)}>Review proposal pack</h3>
          {session.candidates.length ? (
            session.candidates.map((candidate) => (
              <label
                key={candidate.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '20px 110px 1fr 70px',
                  gap: 8,
                  padding: '10px 8px',
                  borderBottom: `1px solid ${t.headerBorder}`,
                  fontSize: 11,
                }}
              >
                <input type="checkbox" checked={selected.includes(candidate.id)} onChange={(event) => setSelected((current) => (event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id)))} />
                <b>{candidate.kind}</b>
                <span>
                  {candidate.domain?.name ?? candidate.domain?.id ?? candidate.skill?.id ?? candidate.id}
                  <small
                    style={{
                      display: 'block',
                      color: t.textMuted,
                      marginTop: 3,
                    }}
                  >
                    {candidate.evidence.slice(0, 2).join(' · ') || 'Evidence review required'}
                  </small>
                </span>
                <span>{Math.round(candidate.confidence * 100)}%</span>
              </label>
            ))
          ) : (
            <Blank title="No proposals" detail="The current project evidence did not produce a safe domain or skill proposal." t={t} />
          )}
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              marginTop: 12,
            }}
          >
            <Button primary t={t} onClick={() => void apply()} disabled={busy || selected.length === 0}>
              Save selected drafts
            </Button>
          </div>
        </div>
      )}
      {message && (
        <div style={{ marginTop: 12 }}>
          <Message text={message} t={t} />
        </div>
      )}
    </ScrollPanel>
  );
}

function AiCapability({ icon, title, detail, t, action }: { icon: React.ReactNode; title: string; detail: string; t: Theme; action?: React.ReactNode }) {
  return (
    <div style={overviewCard(t)}>
      <div style={{ display: 'flex', gap: 7, color: t.accent }}>
        {icon}
        <b style={{ color: t.textPrimary }}>{title}</b>
      </div>
      <p style={{ color: t.textSecondary, fontSize: 11, lineHeight: 1.5 }}>{detail}</p>
      {action}
    </div>
  );
}

function InterfaceTable({ data, domain, t, onCreateExport, onCreateImport }: { data: DbtFirstModelingResponse; domain: string | null; t: Theme; onCreateExport: () => void; onCreateImport: () => void }) {
  const exports = Object.values(data.modeling.interfaces?.exports ?? {}).filter((item) => !domain || item.domain === domain);
  const imports = Object.values(data.modeling.interfaces?.imports ?? {}).filter((item) => !domain || item.domain === domain);
  return (
    <ScrollPanel>
      <PanelHeader
        title="Cross-domain interfaces"
        detail="Domains never join through discovery alone. Providers certify a narrow export; consumers import it for an explicit purpose."
        t={t}
        action={
          <div style={{ display: 'flex', gap: 7 }}>
            <Button t={t} onClick={onCreateImport}>
              <Plus size={14} /> Import
            </Button>
            <Button primary t={t} onClick={onCreateExport}>
              <Plus size={14} /> Export
            </Button>
          </div>
        }
      />
      <h3 style={sectionHeading(t)}>Published exports</h3>
      {exports.length ? (
        <table style={tableStyle}>
          <thead>
            <tr>
              <Th>Interface</Th>
              <Th>Entity</Th>
              <Th>Allowed surface</Th>
              <Th>Consumers</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {exports.map((item) => (
              <tr key={`${item.domain}.${item.id}`}>
                <Td>
                  <b>
                    {item.domain}.{item.id}@{item.version}
                  </b>
                </Td>
                <Td>{item.entity ?? '—'}</Td>
                <Td>{[...item.metrics, ...item.blocks, ...item.allowedDimensions].join(', ') || 'keys only'}</Td>
                <Td>{item.consumerDomains.join(', ') || 'none'}</Td>
                <Td>
                  <Status status={item.status} t={t} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Blank title="No exports in this scope" detail="Publish only the entity, metrics, blocks, dimensions, keys, filters, purposes, and consumers another domain may use." t={t} />
      )}
      <h3 style={sectionHeading(t)}>Approved imports</h3>
      {imports.length ? (
        <table style={tableStyle}>
          <thead>
            <tr>
              <Th>Import</Th>
              <Th>Consumer</Th>
              <Th>Provider export</Th>
              <Th>Purpose</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {imports.map((item) => (
              <tr key={item.id}>
                <Td>
                  <b>{item.id}</b>
                </Td>
                <Td>{item.domain}</Td>
                <Td>{item.exportRef}</Td>
                <Td>{item.purpose}</Td>
                <Td>
                  <Status status={item.status} t={t} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Blank title="No imports in this scope" detail="A consumer import is required before an automatic cross-domain path can use the provider export." t={t} />
      )}
    </ScrollPanel>
  );
}

function RelationshipTable({ relationships, entities, t, onSelect, onEdit }: { relationships: ManifestModelRelationship[]; entities: Record<string, ManifestModelEntity>; t: Theme; onSelect: (id: string) => void; onEdit: (r: ManifestModelRelationship) => void }) {
  return (
    <ScrollPanel>
      <PanelHeader title="Analytical relationships" detail="Transformation lineage is context; only these governed edges can prove an analytical join." t={t} />
      <table style={tableStyle}>
        <thead>
          <tr>
            <Th>Relationship</Th>
            <Th>Path</Th>
            <Th>Cardinality</Th>
            <Th>Safety</Th>
            <Th>Status</Th>
            <Th>Proof</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {relationships.map((r) => (
            <tr key={r.id} onClick={() => onSelect(r.id)} style={{ cursor: 'pointer' }}>
              <Td>
                <b>{r.id}</b>
              </Td>
              <Td>
                {r.from} <span style={{ color: t.textMuted }}>→</span> {r.to}
                {entities[r.from]?.domain !== entities[r.to]?.domain && <Badge t={t}>cross-domain</Badge>}
              </Td>
              <Td>{r.cardinality.replace(/_/g, ' ')}</Td>
              <Td>{r.fanout}</Td>
              <Td>
                <Status status={r.status} t={t} />
              </Td>
              <Td>{r.automaticJoinAllowed ? <span style={{ color: '#2e9b63' }}>certified</span> : r.staleCertification ? <span style={{ color: '#d47822' }}>stale</span> : (r.validation?.status ?? 'not run')}</Td>
              <Td>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onEdit(r);
                  }}
                  style={linkButton(t)}
                >
                  Edit
                </button>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollPanel>
  );
}

function ContractTable({ data, domain, t, onCreate }: { data: DbtFirstModelingResponse; domain: string | null; t: Theme; onCreate: () => void }) {
  const contracts = Object.values(data.modeling.contracts).filter((contract) => !domain || contract.domain === domain);
  return (
    <ScrollPanel>
      <PanelHeader
        title="Analytical contracts"
        detail="Contracts bind governed entities and blocks to evaluation and review requirements."
        t={t}
        action={
          <Button primary t={t} onClick={onCreate}>
            <Plus size={14} /> Contract
          </Button>
        }
      />
      {contracts.length ? (
        <table style={tableStyle}>
          <thead>
            <tr>
              <Th>Contract</Th>
              <Th>Domain</Th>
              <Th>Entities</Th>
              <Th>Blocks</Th>
              <Th>Status</Th>
              <Th>Evaluation</Th>
            </tr>
          </thead>
          <tbody>
            {contracts.map((c) => (
              <tr key={c.id}>
                <Td>
                  <b>{c.id}</b>
                </Td>
                <Td>{c.domain}</Td>
                <Td>{c.entities.join(', ') || '—'}</Td>
                <Td>{c.blocks.join(', ') || '—'}</Td>
                <Td>
                  <Status status={c.status} t={t} />
                </Td>
                <Td>{c.requiredEvaluation ? 'Required' : 'Optional'}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Blank title="No contracts in this scope" detail="Create a contract when a set of entities and certified blocks must move through evaluation and review together." t={t} />
      )}
    </ScrollPanel>
  );
}

function QualityPanel({ data, relationships, t }: { data: DbtFirstModelingResponse; relationships: ManifestModelRelationship[]; t: Theme }) {
  const safe = relationships.filter((r) => r.automaticJoinAllowed).length;
  const stale = relationships.filter((r) => r.staleCertification).length;
  const unvalidated = relationships.filter((r) => !r.validation).length;
  return (
    <ScrollPanel>
      <PanelHeader title="Model quality" detail="Trust gates for agentic SQL: identity, warehouse proof, fanout policy, freshness, and cross-domain exports." t={t} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(130px, 1fr))',
          gap: 12,
        }}
      >
        <Metric value={safe} label="Safe join proofs" color="#2e9b63" t={t} />
        <Metric value={stale} label="Stale certifications" color="#d47822" t={t} />
        <Metric value={unvalidated} label="Need validation" color="#9a6b2f" t={t} />
        <Metric value={data.diagnostics.filter((d) => d.severity === 'error').length} label="Blocking diagnostics" color="#c94b55" t={t} />
      </div>
      <div
        style={{
          marginTop: 18,
          border: `1px solid ${t.headerBorder}`,
          borderRadius: 9,
          overflow: 'hidden',
        }}
      >
        {data.diagnostics.length ? (
          data.diagnostics.map((d, i) => (
            <div
              key={i}
              style={{
                padding: '10px 12px',
                borderBottom: `1px solid ${t.headerBorder}`,
                fontSize: 12,
              }}
            >
              <b
                style={{
                  color: d.severity === 'error' ? '#c94b55' : '#d47822',
                }}
              >
                {d.severity}
              </b>{' '}
              · {d.message}
            </div>
          ))
        ) : (
          <div style={{ padding: 18, color: '#2e9b63', fontSize: 13 }}>
            <CheckCircle2 size={15} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            No compile diagnostics.
          </div>
        )}
      </div>
    </ScrollPanel>
  );
}

function DbtInventory({ data, unbound, t, onBind }: { data: DbtFirstModelingResponse; unbound: DbtFirstModelingResponse['dbtProvenance']['nodes'][string][]; t: Theme; onBind: (id: string) => void }) {
  return (
    <ScrollPanel>
      <PanelHeader title="dbt-owned sources" detail={`Read on demand from ${data.dbtProvenance.manifestPath}. Columns, descriptions, tests, and MetricFlow formulas remain dbt-owned.`} t={t} />
      <table style={tableStyle}>
        <thead>
          <tr>
            <Th>dbt model</Th>
            <Th>Relation</Th>
            <Th>Source</Th>
            <Th>Metadata</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {Object.values(data.dbtProvenance.nodes).map((node) => {
            const isUnbound = unbound.some((item) => item.uniqueId === node.uniqueId);
            return (
              <tr key={node.uniqueId}>
                <Td>
                  <b>{node.name}</b>
                </Td>
                <Td>{node.relation ?? '—'}</Td>
                <Td>{node.sourcePath ?? '—'}</Td>
                <Td>
                  {Object.entries(node.available)
                    .filter(([, yes]) => yes)
                    .map(([name]) => name)
                    .join(', ')}
                </Td>
                <Td>
                  {isUnbound ? (
                    <button onClick={() => onBind(node.uniqueId)} style={linkButton(t)}>
                      Bind
                    </button>
                  ) : (
                    <span style={{ color: '#2e9b63' }}>Bound</span>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollPanel>
  );
}

function EntityInspector({ entity, detail, t, onEdit }: { entity: ManifestModelEntity; detail: DbtNodeAuthoringDetail | null; t: Theme; onEdit: () => void }) {
  return (
    <Inspector t={t}>
      <InspectorTitle title={entity.id} subtitle={entity.domain} t={t} />
      <Button t={t} onClick={onEdit}>
        Edit binding
      </Button>
      <h3 style={inspectorHeading(t)}>Business context</h3>
      <p style={{ margin: '0 0 8px', color: t.textSecondary, fontSize: 11, lineHeight: 1.55 }}>{detail?.description || `Add a business definition for ${entity.id} in dbt, then enrich its agent guidance with domain skills.`}</p>
      <Property label="concepts" value={entity.conceptRefs?.join(', ') || 'Not mapped'} t={t} />
      <Property label="analytical role" value={entity.analyticalRole ?? 'Not declared'} t={t} />
      <h3 style={inspectorHeading(t)}>Analytics identity</h3>
      <Property label="dbt unique id" value={entity.dbtUniqueId} t={t} />
      <Property label="relation" value={detail?.relation ?? 'Loading…'} t={t} />
      <Property label="grain" value={entity.grain ?? detail?.dqlMeta?.grain ?? 'Not declared'} t={t} />
      <Property label="keys" value={(entity.keys.length ? entity.keys : (detail?.dqlMeta?.keys ?? [])).join(', ') || 'Not declared'} t={t} />
      <Property label="source" value={detail?.sourcePath ?? entity.sourcePath} t={t} />
      <h3 style={inspectorHeading(t)}>dbt columns ({detail?.columns.length ?? '…'})</h3>
      {detail?.columns.slice(0, 16).map((column) => (
        <div
          key={column.name}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
            padding: '6px 0',
            borderBottom: `1px solid ${t.headerBorder}`,
            fontSize: 11,
          }}
        >
          <span>{column.name}</span>
          <span style={{ color: t.textMuted }}>{column.type ?? '—'}</span>
        </div>
      ))}
    </Inspector>
  );
}

function RelationshipInspector({ relationship, t, onEdit }: { relationship: ManifestModelRelationship; t: Theme; onEdit: () => void }) {
  return (
    <Inspector t={t}>
      <InspectorTitle title={relationship.id} subtitle={`${relationship.from} → ${relationship.to}`} t={t} />
      <Button primary t={t} onClick={onEdit}>
        Validate / edit
      </Button>
      <h3 style={inspectorHeading(t)}>Business meaning</h3>
      <Property label="verb" value={relationship.verb ?? 'Not described'} t={t} />
      <p style={{ margin: '0 0 8px', color: t.textSecondary, fontSize: 11, lineHeight: 1.55 }}>{relationship.description || `${relationship.from} relates to ${relationship.to}. Add a business description so agents can distinguish this route from similarly shaped joins.`}</p>
      <h3 style={inspectorHeading(t)}>Join route</h3>
      <Property label="cardinality" value={relationship.cardinality} t={t} />
      <Property label="fanout" value={relationship.fanout} t={t} />
      <Property label="lifecycle" value={relationship.status} t={t} />
      <Property label="join keys" value={relationship.keys.map((key) => `${key.from} = ${key.to}`).join(', ')} t={t} />
      <Property label="endpoint roles" value={[relationship.roles?.from, relationship.roles?.to].filter(Boolean).join(' → ') || 'Not declared'} t={t} />
      <Property label="allowed joins" value={relationship.joinTypes?.join(', ') || 'left'} t={t} />
      <Property label="automatic agent join" value={relationship.automaticJoinAllowed ? 'Allowed' : 'Blocked'} t={t} />
      {relationship.validation ? <Evidence evidence={relationship.validation} t={t} /> : <Message text="No warehouse proof has been captured. This edge cannot authorize automatic SQL joins." t={t} />}
    </Inspector>
  );
}

function StudioSummary({ data, domainEntities, domainRelationships, t, onSelectRelationship }: { data: DbtFirstModelingResponse; domainEntities: ManifestModelEntity[]; domainRelationships: ManifestModelRelationship[]; t: Theme; onSelectRelationship: (id: string) => void }) {
  return (
    <Inspector t={t}>
      <InspectorTitle title="Domain overview" subtitle="Select a model or relationship to inspect it." t={t} />
      <Metric value={domainEntities.length} label="Analytical entities" color={t.accent} t={t} />
      <div style={{ height: 8 }} />
      <Metric value={domainRelationships.length} label="Relationships" color="#377cc8" t={t} />
      <h3 style={inspectorHeading(t)}>Relationships</h3>
      {domainRelationships.length ? domainRelationships.map((relationship) => <button key={relationship.id} onClick={() => onSelectRelationship(relationship.id)} style={{ width: '100%', textAlign: 'left', border: 0, borderBottom: `1px solid ${t.headerBorder}`, background: 'transparent', color: t.textPrimary, padding: '8px 2px', cursor: 'pointer', fontSize: 10.5 }}><b>{relationship.id}</b><span style={{ display: 'block', color: t.textMuted, marginTop: 3 }}>{relationship.from} → {relationship.to} · {relationship.cardinality.replace(/_/g, ' ')}</span></button>) : <p style={{ color: t.textMuted, fontSize: 10.5 }}>Drag between two column handles to create the first relationship.</p>}
      <div style={{ height: 8 }} />
      <Metric value={Object.keys(data.modeling.contracts).length} label="Contracts" color="#2e9b63" t={t} />
      <h3 style={inspectorHeading(t)}>Ownership boundary</h3>
      <p style={{ color: t.textSecondary, fontSize: 11, lineHeight: 1.55 }}>dbt owns tables, columns, descriptions, tests, and metrics. DQL owns domain membership, analytical identity, safe relationship proof, contracts, blocks, apps, and agent policy.</p>
    </Inspector>
  );
}

function Evidence({ evidence, t }: { evidence: NonNullable<ManifestModelRelationship['validation']>; t: Theme }) {
  return (
    <div
      style={{
        marginTop: 12,
        padding: 10,
        border: `1px solid ${evidence.status === 'passed' ? '#2e9b6355' : '#c94b5555'}`,
        background: evidence.status === 'passed' ? '#2e9b630d' : '#c94b550d',
        borderRadius: 7,
        fontSize: 11,
      }}
    >
      <b style={{ color: evidence.status === 'passed' ? '#2e9b63' : '#c94b55' }}>{evidence.status === 'passed' ? 'Warehouse proof passed' : 'Warehouse proof failed'}</b>
      <div style={{ color: t.textSecondary, marginTop: 7, lineHeight: 1.55 }}>
        Rows: {evidence.fromRows} → {evidence.toRows}
        <br />
        Joined: {evidence.joinedRows} · unmatched: {evidence.unmatchedFrom}
        <br />
        Max rows/key: {evidence.maxFromPerKey} → {evidence.maxToPerKey}
      </div>
    </div>
  );
}

function EmptyState({ t, title, detail }: { t: Theme; title: string; detail: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'grid',
        placeItems: 'center',
        background: t.appBg,
        color: t.textPrimary,
      }}
    >
      <div style={{ maxWidth: 560, textAlign: 'center' }}>
        <Boxes size={34} color={t.accent} />
        <h1 style={{ fontSize: 20 }}>{title}</h1>
        <p style={{ color: t.textSecondary, lineHeight: 1.6 }}>{detail}</p>
        <code style={{ fontSize: 12 }}>manifestVersion: 3 · modeling.mode: dbt-first</code>
      </div>
    </div>
  );
}
function Modal({ title, t, onClose, children }: { title: string; t: Theme; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: '#0008',
        display: 'grid',
        placeItems: 'center',
        padding: 20,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 'min(720px, 94vw)',
          maxHeight: '88vh',
          overflow: 'auto',
          background: t.appBg,
          border: `1px solid ${t.headerBorder}`,
          borderRadius: 12,
          boxShadow: '0 24px 80px #0006',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '15px 18px',
            borderBottom: `1px solid ${t.headerBorder}`,
          }}
        >
          <strong>{title}</strong>
          <button onClick={onClose} style={iconButtonStyle(t)}>
            <XCircle size={17} />
          </button>
        </div>
        <div style={{ padding: 18 }}>{children}</div>
      </div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 6, fontSize: 11, fontWeight: 650 }}>
      {label}
      {children}
    </label>
  );
}
function Input({ value, onChange, t, placeholder }: { value: string; onChange: (v: string) => void; t: Theme; placeholder?: string }) {
  return <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={inputStyle(t)} />;
}
function Select({ value, onChange, values, labels, t }: { value: string; onChange: (v: string) => void; values: string[]; labels?: Record<string, string>; t: Theme }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle(t)}>
      <option value="">Select…</option>
      {values.map((item) => (
        <option key={item} value={item}>
          {labels?.[item] ?? item}
        </option>
      ))}
    </select>
  );
}
function Button({ children, t, onClick, primary, disabled }: { children: React.ReactNode; t: Theme; onClick: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        border: `1px solid ${primary ? t.accent : t.headerBorder}`,
        background: primary ? t.accent : t.appBg,
        color: primary ? '#fff' : t.textPrimary,
        borderRadius: 6,
        padding: '7px 10px',
        fontSize: 11,
        fontWeight: 650,
        cursor: disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.65 : 1,
      }}
    >
      {children}
    </button>
  );
}
function IconButton({ children, title, t, onClick }: { children: React.ReactNode; title: string; t: Theme; onClick: () => void }) {
  return (
    <button title={title} onClick={onClick} style={iconButtonStyle(t)}>
      {children}
    </button>
  );
}
function Badge({ children, t }: { children: React.ReactNode; t: Theme }) {
  return (
    <span
      style={{
        marginLeft: 5,
        border: `1px solid ${t.accent}55`,
        color: t.accent,
        background: `${t.accent}10`,
        borderRadius: 999,
        padding: '3px 7px',
        fontSize: 9,
        fontWeight: 750,
      }}
    >
      {children}
    </span>
  );
}
function SideHeading({ children, t }: { children: React.ReactNode; t: Theme }) {
  return (
    <div
      style={{
        padding: '15px 12px 8px',
        color: t.textMuted,
        fontSize: 10,
        fontWeight: 750,
        textTransform: 'uppercase',
        letterSpacing: '.07em',
      }}
    >
      {children}
    </div>
  );
}
function ScrollPanel({ children }: { children: React.ReactNode }) {
  return <div style={{ height: '100%', overflow: 'auto', padding: 20 }}>{children}</div>;
}
function PanelHeader({ title, detail, t, action }: { title: string; detail: string; t: Theme; action?: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 20,
        alignItems: 'start',
        marginBottom: 18,
      }}
    >
      <div>
        <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
        <p style={{ margin: '5px 0 0', color: t.textSecondary, fontSize: 11 }}>{detail}</p>
      </div>
      {action}
    </div>
  );
}
function Blank({ title, detail, t }: { title: string; detail: string; t: Theme }) {
  return (
    <div
      style={{
        border: `1px dashed ${t.headerBorder}`,
        borderRadius: 10,
        padding: 30,
        textAlign: 'center',
      }}
    >
      <strong>{title}</strong>
      <p style={{ color: t.textSecondary, fontSize: 12 }}>{detail}</p>
    </div>
  );
}
function Inspector({ children }: { children: React.ReactNode; t: Theme }) {
  return <div style={{ padding: '4px 14px 20px' }}>{children}</div>;
}
function InspectorTitle({ title, subtitle, t }: { title: string; subtitle: string; t: Theme }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
      <div style={{ color: t.textMuted, fontSize: 11, marginTop: 4 }}>{subtitle}</div>
    </div>
  );
}
function Property({ label, value, t }: { label: string; value: string; t: Theme }) {
  return (
    <div style={{ padding: '9px 0', borderBottom: `1px solid ${t.headerBorder}` }}>
      <div
        style={{
          color: t.textMuted,
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: '.05em',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 11, marginTop: 4, overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  );
}
function Metric({ value, label, color, t }: { value: number; label: string; color: string; t: Theme }) {
  return (
    <div
      style={{
        border: `1px solid ${t.headerBorder}`,
        borderLeft: `3px solid ${color}`,
        background: t.cellBg,
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 750 }}>{value}</div>
      <div style={{ color: t.textSecondary, fontSize: 10, marginTop: 3 }}>{label}</div>
    </div>
  );
}
function Status({ status, t }: { status: string; t: Theme }) {
  const color = status === 'certified' ? '#2e9b63' : status === 'deprecated' ? t.textMuted : status === 'review' ? '#377cc8' : '#9a6b2f';
  return (
    <span
      style={{
        color,
        background: `${color}15`,
        borderRadius: 999,
        padding: '3px 7px',
        fontSize: 10,
      }}
    >
      {status}
    </span>
  );
}
function Message({ text, t }: { text: string; t: Theme }) {
  return (
    <div
      style={{
        borderLeft: `3px solid ${t.accent}`,
        background: `${t.accent}0d`,
        padding: '9px 10px',
        color: t.textSecondary,
        fontSize: 11,
        lineHeight: 1.5,
      }}
    >
      {text}
    </div>
  );
}
function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: 'left',
        padding: '9px 10px',
        fontSize: 9,
        textTransform: 'uppercase',
        letterSpacing: '.05em',
        opacity: 0.65,
      }}
    >
      {children}
    </th>
  );
}
function Td({ children }: { children: React.ReactNode }) {
  return (
    <td
      style={{
        padding: '11px 10px',
        borderTop: '1px solid var(--border-subtle)',
        fontSize: 11,
      }}
    >
      {children}
    </td>
  );
}
function csv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
function relationshipKeys(value: string): Array<{ from: string; to: string }> {
  return csv(value).map((pair) => {
    const [from, to] = pair.split('=').map((item) => item.trim());
    if (!from || !to) throw new Error(`Invalid join key pair "${pair}". Use from_key=to_key.`);
    return { from, to };
  });
}
function readDiagramPreferences(): Partial<{ columnMode: ColumnDisplayMode; layoutMode: DiagramLayoutMode; density: DiagramDensity; visibleLimit: number; dimUnrelated: boolean; showEdgeLabels: boolean }> {
  try { return JSON.parse(localStorage.getItem('dql-modeling-preferences') ?? '{}') as Partial<{ columnMode: ColumnDisplayMode; layoutMode: DiagramLayoutMode; density: DiagramDensity; visibleLimit: number; dimUnrelated: boolean; showEdgeLabels: boolean }>; }
  catch { return {}; }
}
function domainDepth(id: string, packages: DbtFirstModelingResponse['modeling']['packages']): number {
  let depth = 0;
  let current = packages[id]?.parent;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    depth += 1;
    current = packages[current]?.parent;
  }
  return depth;
}
function sortDomainPackages(packages: DbtFirstModelingResponse['modeling']['packages']) {
  return Object.values(packages).sort((a, b) => `${a.parent ?? ''}/${a.id}`.localeCompare(`${b.parent ?? ''}/${b.id}`));
}

const twoColumns: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 12,
};
const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
};
const sourcePreview = (t: Theme): React.CSSProperties => ({
  whiteSpace: 'pre-wrap',
  maxHeight: 300,
  overflow: 'auto',
  padding: 12,
  borderRadius: 7,
  background: t.activityBarBg,
  color: t.textSecondary,
  fontSize: 10,
  lineHeight: 1.5,
});
const inputStyle = (t: Theme): React.CSSProperties => ({
  width: '100%',
  boxSizing: 'border-box',
  border: `1px solid ${t.headerBorder}`,
  background: t.cellBg,
  color: t.textPrimary,
  borderRadius: 6,
  padding: '8px 9px',
  fontSize: 11,
});
const iconButtonStyle = (t: Theme): React.CSSProperties => ({
  border: `1px solid ${t.headerBorder}`,
  background: t.appBg,
  color: t.textSecondary,
  borderRadius: 6,
  padding: 7,
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
});
const treeButton = (t: Theme, active: boolean): React.CSSProperties => ({
  width: 'calc(100% - 12px)',
  margin: '2px 6px',
  padding: '8px 7px',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  border: 0,
  borderRadius: 6,
  background: active ? `${t.accent}18` : 'transparent',
  color: active ? t.accent : t.textPrimary,
  fontSize: 11,
  textAlign: 'left',
  cursor: 'pointer',
});
const entityTreeButton = (t: Theme, active: boolean): React.CSSProperties => ({
  width: 'calc(100% - 26px)',
  margin: '1px 6px 1px 20px',
  padding: '6px 8px',
  display: 'flex',
  gap: 6,
  alignItems: 'center',
  border: 0,
  background: 'transparent',
  color: active ? t.accent : t.textSecondary,
  fontSize: 10,
  textAlign: 'left',
  cursor: 'pointer',
});
const inventoryButton = (t: Theme): React.CSSProperties => ({
  width: 'calc(100% - 12px)',
  margin: '1px 6px',
  padding: '6px 7px',
  display: 'grid',
  gridTemplateColumns: '14px 1fr 14px',
  gap: 5,
  alignItems: 'center',
  border: 0,
  background: 'transparent',
  color: t.textSecondary,
  fontSize: 10,
  textAlign: 'left',
  cursor: 'pointer',
});
const tabButton = (t: Theme, active: boolean): React.CSSProperties => ({
  height: 34,
  padding: '0 12px',
  border: 0,
  borderBottom: `2px solid ${active ? t.accent : 'transparent'}`,
  background: 'transparent',
  color: active ? t.textPrimary : t.textSecondary,
  fontSize: 11,
  fontWeight: active ? 700 : 500,
  cursor: 'pointer',
});
const linkButton = (t: Theme): React.CSSProperties => ({
  border: 0,
  background: 'transparent',
  color: t.accent,
  fontSize: 10,
  fontWeight: 650,
  cursor: 'pointer',
});
const inspectorHeading = (t: Theme): React.CSSProperties => ({
  margin: '18px 0 7px',
  paddingBottom: 7,
  borderBottom: `1px solid ${t.headerBorder}`,
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '.05em',
  color: t.textMuted,
});
const sectionHeading = (t: Theme): React.CSSProperties => ({
  margin: '22px 0 10px',
  paddingBottom: 8,
  borderBottom: `1px solid ${t.headerBorder}`,
  fontSize: 12,
  color: t.textPrimary,
});
const overviewCard = (t: Theme): React.CSSProperties => ({
  border: `1px solid ${t.headerBorder}`,
  background: t.cellBg,
  borderRadius: 9,
  padding: 14,
});
const flowRow = (t: Theme): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  overflowX: 'auto',
  border: `1px solid ${t.headerBorder}`,
  borderRadius: 9,
  padding: 12,
  background: t.cellBg,
});
const flowStep = (t: Theme): React.CSSProperties => ({
  minWidth: 118,
  display: 'grid',
  gap: 5,
  padding: 9,
  borderRadius: 7,
  background: t.appBg,
  color: t.textSecondary,
  fontSize: 10,
  lineHeight: 1.35,
});
