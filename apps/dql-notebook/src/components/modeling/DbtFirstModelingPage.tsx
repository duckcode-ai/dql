import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Blocks, Boxes, CheckCircle2, Columns3, Download, EyeOff, FolderTree, GitBranch, GraduationCap, Link2, Maximize2, MessageCircle, PanelRightClose, PanelRightOpen, Plus, RefreshCw, RotateCcw, Search, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
import type { DomainExportAuthoringInput, DomainImportAuthoringInput, DbtNodeAuthoringDetail, DbtSourceAuthoringInput, DbtSourcePatchPreview, ManifestModelArea, ManifestModelEntity, ManifestModelRelationship, ModelingAuthoringChange, ModelingChangePreview, RelationshipAuthoringInput } from '@duckcodeailabs/dql-core';
import { api, type ContextBootstrapSession, type DbtFirstModelingResponse } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { SkillsPage } from '../skills/SkillsPage';
import { DomainModelingCanvas, type ColumnDisplayMode, type DiagramDensity, type DiagramLayoutMode, type ModelingViewMode, type RelationshipDraft } from './DomainModelingCanvas';
import { DOMAIN_STUDIO_NAVIGATION, domainEntityRecords, isDomainStudioSection, type DomainStudioSection } from './domain-studio-model';

type Theme = (typeof themes)['dark'];
type Tab = DomainStudioSection;
type Editor =
  | { kind: 'domain' }
  | { kind: 'area'; area?: ManifestModelArea }
  | { kind: 'entity'; entity?: ManifestModelEntity; dbtUniqueId?: string; relationshipFrom?: { from: string; fromColumn?: string } }
  | {
      kind: 'relationship';
      relationship?: ManifestModelRelationship;
      draft?: RelationshipDraft;
    }
  | { kind: 'contract' }
  | { kind: 'export' }
  | { kind: 'import' };

export function DbtFirstModelingPage() {
  // UI-001: keep OSS domain authoring focused on Model + Skills, while Ask and
  // global products remain outside this contextual workspace.
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [data, setData] = useState<DbtFirstModelingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const initialLocation = useMemo(() => readDomainStudioLocation(), []);
  const [tab, setTab] = useState<Tab>(initialLocation.section);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(initialLocation.domain);
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodeDetail, setNodeDetail] = useState<DbtNodeAuthoringDetail | null>(null);
  const [detailsByDbtId, setDetailsByDbtId] = useState<Record<string, DbtNodeAuthoringDetail | undefined>>({});
  const detailRequests = useRef(new Map<string, Promise<DbtNodeAuthoringDetail | undefined>>());
  const loadedDetailIds = useRef(new Set<string>());
  const savedDiagramPreferences = useMemo(() => readDiagramPreferences(), []);
  const [modelingView, setModelingView] = useState<ModelingViewMode>(savedDiagramPreferences.viewMode ?? 'business');
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
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [narrowLayout, setNarrowLayout] = useState(() => typeof window !== 'undefined' && window.innerWidth < 980);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [dbtSourceEntity, setDbtSourceEntity] = useState<ManifestModelEntity | null>(null);
  useEffect(() => { localStorage.setItem('dql-modeling-preferences', JSON.stringify({ modelingView, columnMode, layoutMode, density: diagramDensity, visibleLimit, dimUnrelated, showEdgeLabels })); }, [modelingView, columnMode, layoutMode, diagramDensity, visibleLimit, dimUnrelated, showEdgeLabels]);
  useEffect(() => {
    const onResize = () => setNarrowLayout(window.innerWidth < 980);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const toggleInspector = useCallback(() => {
    setInspectorOpen((open) => {
      const next = !open;
      if (next) window.requestAnimationFrame(() => inspectorRef.current?.focus());
      else window.requestAnimationFrame(() => inspectorToggleRef.current?.focus());
      return next;
    });
  }, []);

  const selectSection = useCallback((section: Tab) => {
    if (section === 'blocks' && selectedDomain) {
      try { window.localStorage.setItem('dql.block-studio.domain', selectedDomain); } catch { /* best effort */ }
      dispatch({ type: 'SET_MAIN_VIEW', view: 'block_studio' });
      return;
    }
    setTab(section);
    writeDomainStudioLocation(selectedDomain, section);
  }, [dispatch, selectedDomain]);
  const selectDomain = useCallback((domain: string | null) => {
    setSelectedDomain(domain);
    setSelectedAreaId(null);
    setSelectedId(null);
    writeDomainStudioLocation(domain, tab);
  }, [tab]);

  useEffect(() => {
    const onPopState = () => {
      const next = readDomainStudioLocation();
      setSelectedDomain(next.domain);
      setSelectedAreaId(null);
      setSelectedId(null);
      setTab(next.section);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const refresh = async () => {
    setLoading(true);
    const result = await api.getDbtFirstModeling();
    setData(result);
    setError(result ? null : 'dbt-first modeling is not enabled or the local server could not compile manifest v3.');
    if (result) {
      const nextDomain = selectedDomain && result.modeling.packages[selectedDomain]
        ? selectedDomain
        : (Object.keys(result.modeling.packages).sort()[0] ?? null);
      if (nextDomain !== selectedDomain) {
        setSelectedDomain(nextDomain);
        writeDomainStudioLocation(nextDomain, tab, true);
      }
    }
    setLoading(false);
  };
  useEffect(() => {
    void refresh();
  }, []);

  const selectedEntity = data?.modeling.entities[selectedId ?? ''];
  const selectedRelationship = data?.modeling.relationships[selectedId ?? ''];
  const domainAreas = useMemo(
    () => data ? Object.values(data.modeling.areas).filter((area) => !selectedDomain || area.domain === selectedDomain).sort((a, b) => a.name.localeCompare(b.name)) : [],
    [data, selectedDomain],
  );
  const selectedArea = data?.modeling.areas[selectedAreaId ?? ''];
  useEffect(() => {
    if (selectedAreaId && !domainAreas.some((area) => area.qualifiedId === selectedAreaId)) setSelectedAreaId(null);
  }, [domainAreas, selectedAreaId]);
  const loadNodeDetail = useCallback((uniqueId: string): Promise<DbtNodeAuthoringDetail | undefined> => {
    const active = detailRequests.current.get(uniqueId);
    if (active) return active;
    if (loadedDetailIds.current.has(uniqueId)) return Promise.resolve(undefined);
    const request = api
      .getDbtModelingNode(uniqueId)
      .then((detail) => {
        loadedDetailIds.current.add(uniqueId);
        setDetailsByDbtId((current) => ({ ...current, [uniqueId]: detail }));
        return detail;
      })
      .catch(() => {
        loadedDetailIds.current.add(uniqueId);
        return undefined;
      })
      .finally(() => detailRequests.current.delete(uniqueId));
    detailRequests.current.set(uniqueId, request);
    return request;
  }, []);
  useEffect(() => {
    if (!selectedEntity) {
      setNodeDetail(null);
      return;
    }
    const cached = detailsByDbtId[selectedEntity.dbtUniqueId];
    if (cached) {
      setNodeDetail(cached);
      return;
    }
    let cancelled = false;
    void loadNodeDetail(selectedEntity.dbtUniqueId).then((detail) => {
      if (!cancelled) setNodeDetail(detail ?? null);
    });
    return () => { cancelled = true; };
  }, [detailsByDbtId, loadNodeDetail, selectedEntity?.dbtUniqueId]);
  useEffect(() => {
    detailRequests.current.clear();
    loadedDetailIds.current.clear();
    setDetailsByDbtId({});
  }, [data?.dbtProvenance.manifestFingerprint]);

  const loadVisibleNodeDetails = useCallback((uniqueIds: string[]) => {
    // A graph may contain thousands of dbt models. Hydrate only a small visible
    // window; selecting any other node loads it immediately through the same cache.
    for (const uniqueId of uniqueIds.slice(0, 24)) void loadNodeDetail(uniqueId);
  }, [loadNodeDetail]);

  if (loading && !data) return <EmptyState t={t} title="Loading Domain Studio…" detail="Compiling dbt provenance and the sparse DQL analytical overlay." />;
  if (!data) return <EmptyState t={t} title="Domain Studio is unavailable" detail={error ?? 'Enable manifestVersion 3 and dbt-first modeling.'} />;

  const relationByDbtId = Object.fromEntries(Object.values(data.dbtProvenance.nodes).map((node) => [node.uniqueId, node.relation]));
  const selectedAreaEntityIds = selectedArea ? new Set([...selectedArea.entityIds, ...selectedArea.referencedEntityIds]) : undefined;
  const domainEntities = domainEntityRecords(data.modeling, selectedDomain).filter(({ recordKey }) => !selectedAreaEntityIds || selectedAreaEntityIds.has(recordKey));
  const domainRelationships = Object.values(data.modeling.relationships).filter((relationship) => {
    const from = data.modeling.entities[relationship.from];
    const to = data.modeling.entities[relationship.to];
    if (selectedArea) return selectedArea.relationshipIds.includes(relationship.qualifiedId);
    return !selectedDomain || from?.domain === selectedDomain || to?.domain === selectedDomain;
  });
  const unboundNodes = Object.values(data.dbtProvenance.nodes).filter((node) => !Object.values(data.modeling.entities).some((entity) => entity.dbtUniqueId === node.uniqueId));
  const inspectorVisible = inspectorOpen && tab === 'diagram';

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
          minHeight: 52,
          padding: '0 14px',
          borderBottom: `1px solid ${t.headerBorder}`,
          background: t.headerBg,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            alignItems: 'center',
            width: '100%',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <Boxes size={16} color={t.accent} />
            <h1 style={{ margin: 0, fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap' }}>Domain workspace</h1>
            <span style={{ color: t.textMuted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedDomain ? `/${selectedDomain}` : '/all domains'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 7 }}>
            {selectedDomain && (
              <Button t={t} onClick={() => {
                try { window.sessionStorage.setItem('dql-ask-domain-context', JSON.stringify({ domain: selectedDomain, modelAreaId: selectedArea?.qualifiedId })); } catch { /* best effort */ }
                dispatch({ type: 'SET_MAIN_VIEW', view: 'ask' });
              }}>
                <MessageCircle size={14} /> Ask
              </Button>
            )}
            <Button t={t} onClick={() => setEditor(selectedDomain ? { kind: 'area' } : { kind: 'domain' })}>
              <Plus size={14} /> {selectedDomain ? 'New model area' : 'New domain'}
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
          gridTemplateColumns: inspectorVisible && !narrowLayout ? 'clamp(190px, 15vw, 232px) minmax(460px, 1fr) clamp(270px, 22vw, 380px)' : 'clamp(190px, 15vw, 232px) minmax(0, 1fr)',
        }}
      >
        <aside
          style={{
            borderRight: `1px solid ${t.headerBorder}`,
            overflow: 'auto',
            // This is the domain workspace context rail, not the global app
            // navigation. Keep it on the canvas surface so Paper remains warm
            // and visually continuous from the header into the workspace.
            background: t.appBg,
          }}
        >
          <div style={{ padding: '12px 10px 10px', borderBottom: `1px solid ${t.headerBorder}` }}>
            <label style={{ display: 'grid', gap: 6, color: t.textMuted, fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em' }}>
              Domain
              <select aria-label="Active domain" value={selectedDomain ?? ''} onChange={(event) => selectDomain(event.target.value || null)} style={{ ...inputStyle(t), minHeight: 32, padding: '6px 8px' }}>
                <option value="">All domains</option>
                {sortDomainPackages(data.modeling.packages).map((pkg) => <option key={pkg.id} value={pkg.id}>{pkg.id}</option>)}
              </select>
            </label>
          </div>
          <DomainWorkspaceNavigation
            data={data}
            domain={selectedDomain}
            active={tab}
            onSelect={selectSection}
            t={t}
          />
          {/* Prototype sync footer: dbt + proven-relationship status. */}
          <div style={{ padding: '10px 12px', borderTop: `1px solid ${t.headerBorder}`, display: 'flex', flexDirection: 'column', gap: 5, fontSize: 10.5, color: t.textMuted, fontFamily: t.font }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--status-success)', flexShrink: 0 }} />
              dbt synced · {Object.keys(data.modeling.entities).length} model{Object.keys(data.modeling.entities).length === 1 ? '' : 's'}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--accent)', flexShrink: 0 }} />
              {Object.keys(data.modeling.relationships).length} relationship{Object.keys(data.modeling.relationships).length === 1 ? '' : 's'}
            </span>
          </div>
        </aside>

        <main
          style={{
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              minHeight: 42,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '0 10px 0 14px',
              borderBottom: `1px solid ${t.headerBorder}`,
              background: t.headerBg,
            }}
          >
            {domainSectionIcon(tab, 14, t)}
            <strong style={{ fontSize: 11 }}>{domainStudioSectionLabel(tab)}</strong>
            <span style={{ width: 1, height: 15, background: t.headerBorder }} />
            <span style={{ color: t.textMuted, fontSize: 10 }}>{selectedDomain ?? 'All domains'}</span>
            {tab === 'diagram' && selectedDomain && <label style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 5, color: t.textMuted, fontSize: 10 }}>Area <select aria-label="Active model area" value={selectedAreaId ?? ''} onChange={(event) => { setSelectedAreaId(event.target.value || null); setSelectedId(null); }} style={{ ...inputStyle(t), minWidth: 146, padding: '4px 6px' }}><option value="">All domain</option>{domainAreas.map((area) => <option key={area.qualifiedId} value={area.qualifiedId}>{area.name}</option>)}</select></label>}
            {tab === 'diagram' && <button ref={inspectorToggleRef} aria-expanded={inspectorOpen} aria-controls="domain-studio-inspector" aria-label={inspectorOpen ? 'Hide inspector' : 'Show inspector'} title={inspectorOpen ? 'Hide inspector' : 'Show inspector'} onClick={toggleInspector} style={{ ...iconButtonStyle(t), marginLeft: 'auto' }}>
              {inspectorOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
            </button>}
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            {tab === 'overview' && <DomainOverview data={data} domain={selectedDomain} t={t} onOpen={selectSection} />}
            {tab === 'diagram' && (
              <div id="dql-modeling-diagram"
                style={{
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  ...(diagramFullscreen ? { position: 'fixed', inset: 0, zIndex: 90, background: t.appBg } : {}),
                }}
              >
                <LayerToolbar modelingView={modelingView} columnMode={columnMode} search={diagramSearch} layoutMode={layoutMode} density={diagramDensity} visibleLimit={visibleLimit} totalEntities={selectedAreaEntityIds?.size ?? Object.keys(data.modeling.entities).length} dimUnrelated={dimUnrelated} showEdgeLabels={showEdgeLabels} showLegend={showLegend} fullscreen={diagramFullscreen} onBindModel={() => setEditor({ kind: 'entity' })} onRelationship={() => setEditor({ kind: 'relationship' })} onNewArea={() => setEditor({ kind: 'area' })} onModelingView={setModelingView} onColumnMode={setColumnMode} onSearch={setDiagramSearch} onLayoutMode={setLayoutMode} onDensity={setDiagramDensity} onVisibleLimit={setVisibleLimit} onDimUnrelated={setDimUnrelated} onEdgeLabels={setShowEdgeLabels} onLegend={setShowLegend} onFullscreen={() => setDiagramFullscreen((value) => !value)} onExport={() => exportDiagramSvg()} onReset={() => setResetLayoutToken((value) => value + 1)} t={t} />
                {showLegend && <DiagramLegend t={t} />}
                <div style={{ flex: 1, minHeight: 0 }}>
                  <DomainModelingCanvas modeling={data.modeling} relationByDbtId={relationByDbtId} detailsByDbtId={detailsByDbtId} selectedDomain={selectedDomain} selectedAreaId={selectedAreaId} selectedId={selectedId} viewMode={modelingView} columnMode={columnMode} search={diagramSearch} layoutMode={layoutMode} density={diagramDensity} visibleLimit={visibleLimit} dimUnrelated={dimUnrelated} showEdgeLabels={showEdgeLabels} resetLayoutToken={resetLayoutToken} onVisibleDbtIdsChange={loadVisibleNodeDetails} onSelectEntity={setSelectedId} onSelectRelationship={setSelectedId} onDraftRelationship={(draft) => setEditor({ kind: 'relationship', draft })} onAddRelatedModel={(origin) => setEditor({ kind: 'entity', relationshipFrom: origin })} onDropDbtModel={(dbtUniqueId) => setEditor({ kind: 'entity', dbtUniqueId })} onCreateDomain={() => setEditor({ kind: 'domain' })} onEditEntity={(id) => { const entity = data.modeling.entities[id]; if (entity) setEditor({ kind: 'entity', entity, dbtUniqueId: entity.dbtUniqueId }); }} onOpenAi={(id) => { setSelectedId(id); selectSection('ai'); }} theme={t} />
                </div>
              </div>
            )}
            {tab === 'terms' && <DomainAssetsPanel data={data} domain={selectedDomain} kinds={['terms']} title="Domain terms" detail="Business vocabulary owned by this domain and available to governed retrieval." t={t} />}
            {tab === 'skills' && <SkillsPage embedded domainFilter={selectedDomain} />}
            {tab === 'blocks' && <DomainAssetsPanel data={data} domain={selectedDomain} kinds={['blocks']} title="Certified blocks" detail="Reusable analytical building blocks governed by this domain." t={t} />}
            {tab === 'views' && <DomainAssetsPanel data={data} domain={selectedDomain} kinds={['views']} title="Business views" detail="Domain-owned business views that compose governed models and blocks." t={t} />}
            {tab === 'ai' && <ModelingAiPanel domain={selectedDomain} selectedId={selectedId} data={data} t={t} onOpenSkills={() => selectSection('skills')} onDraftRelationship={() => setEditor({ kind: 'relationship', draft: selectedEntity && selectedId ? { from: selectedId, to: '' } : undefined })} />}
            {tab === 'join-proofs' && <RelationshipTable relationships={domainRelationships} entities={data.modeling.entities} t={t} onSelect={(relationship) => setSelectedId(relationshipRecordKey(data.modeling.relationships, relationship))} onEdit={(relationship) => setEditor({ kind: 'relationship', relationship })} />}
            {tab === 'contracts' && <ContractTable data={data} domain={selectedDomain} t={t} onCreate={() => setEditor({ kind: 'contract' })} />}
            {tab === 'interfaces' && <InterfaceTable data={data} domain={selectedDomain} t={t} onCreateExport={() => setEditor({ kind: 'export' })} onCreateImport={() => setEditor({ kind: 'import' })} />}
            {tab === 'evaluations' && <DomainAssetsPanel data={data} domain={selectedDomain} kinds={['evaluations', 'tests']} title="Evaluations" detail="Evidence and regression checks required before governed assets guide agents." t={t} />}
            {tab === 'notebooks' && <RelatedProductsPanel data={data} domain={selectedDomain} kind="notebooks" t={t} />}
            {tab === 'apps' && <RelatedProductsPanel data={data} domain={selectedDomain} kind="apps" t={t} />}
            {tab === 'dbt' && <DbtInventory data={data} domain={selectedDomain} unbound={unboundNodes} t={t} onBind={(dbtUniqueId) => setEditor({ kind: 'entity', dbtUniqueId })} />}
          </div>
        </main>

        {inspectorVisible && <aside
          id="domain-studio-inspector"
          ref={inspectorRef}
          role="complementary"
          aria-label="Domain Studio inspector"
          tabIndex={-1}
          onKeyDown={(event) => { if (event.key === 'Escape') toggleInspector(); }}
          style={{
            borderLeft: `1px solid ${t.headerBorder}`,
            overflow: 'auto',
            // The inspector is part of the same domain workspace context.
            background: t.appBg,
            minWidth: 0,
            ...(narrowLayout ? { position: 'fixed', inset: '0 0 0 auto', width: 'min(90vw, 380px)', zIndex: 95, boxShadow: '-12px 0 30px rgba(0,0,0,.18)' } : {}),
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
                  entity: selectedEntity,
                  dbtUniqueId: selectedEntity.dbtUniqueId,
                })
              }
              onEditDbtSource={() => setDbtSourceEntity(selectedEntity)}
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
            <StudioSummary data={data} domainEntities={domainEntities.map(({ entity }) => entity)} domainRelationships={domainRelationships} t={t} onSelectRelationship={(relationship) => setSelectedId(relationshipRecordKey(data.modeling.relationships, relationship))} />
          )}
        </aside>}
      </div>
      {editor && (
        <ModelingEditor
          editor={editor}
          data={data}
          selectedDomain={selectedDomain}
          selectedArea={selectedArea}
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
      {dbtSourceEntity && nodeDetail && (
        <DbtSourceEditor
          entity={dbtSourceEntity}
          detail={nodeDetail}
          snapshotId={data.snapshotId}
          t={t}
          onClose={() => setDbtSourceEntity(null)}
          onApplied={async () => { setDbtSourceEntity(null); await refresh(); }}
        />
      )}
    </div>
  );
}

function DomainWorkspaceNavigation({ data, domain, active, onSelect, t }: { data: DbtFirstModelingResponse; domain: string | null; active: Tab; onSelect: (section: Tab) => void; t: Theme }) {
  const assets = domain ? (data.domainAssets?.[domain] ?? {}) : {};
  const entities = domainEntityRecords(data.modeling, domain);
  const relationships = Object.values(data.modeling.relationships).filter((relationship) => {
    if (!domain) return true;
    return data.modeling.entities[relationship.from]?.domain === domain || data.modeling.entities[relationship.to]?.domain === domain;
  });
  const counts: Partial<Record<Tab, number>> = {
    diagram: entities.length,
    skills: assets.skills?.length ?? 0,
    blocks: assets.blocks?.length ?? 0,
  };
  return (
    <nav aria-label={domain ? `${domain} workspace` : 'All domains workspace'} style={{ padding: '10px 7px 14px' }}>
      <div style={{ padding: '0 8px 6px', color: t.textMuted, fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em' }}>Workspace</div>
      {DOMAIN_STUDIO_NAVIGATION.flatMap((group) => group.items).map((item) => (
        <button
          key={item.id}
          onClick={() => onSelect(item.id)}
          aria-current={active === item.id ? 'page' : undefined}
          style={workspaceNavButton(t, active === item.id, false)}
        >
          {domainSectionIcon(item.id, 14, t, active === item.id)}
          <span style={{ flex: 1 }}>{item.label}</span>
          {counts[item.id] !== undefined && <small style={{ color: active === item.id ? t.accent : t.textMuted }}>{counts[item.id]}</small>}
        </button>
      ))}
    </nav>
  );
}

function domainSectionIcon(section: Tab, size: number, t: Theme, active = false) {
  const Icon = section === 'blocks' ? Blocks : section === 'diagram' ? GitBranch : section === 'skills' ? GraduationCap : Boxes;
  return <Icon size={size} color={active ? t.accent : t.textMuted} />;
}

function domainStudioSectionLabel(section: Tab): string {
  if (section === 'ai') return 'Draft context';
  return DOMAIN_STUDIO_NAVIGATION.flatMap((group) => group.items).find((item) => item.id === section)?.label ?? section;
}

function readDomainStudioLocation(): { domain: string | null; section: Tab } {
  if (typeof window === 'undefined') return { domain: null, section: 'diagram' };
  const params = new URL(window.location.href).searchParams;
  const section = params.get('domainSection');
  return {
    domain: params.get('domain'),
    section: isDomainStudioSection(section) ? section : 'diagram',
  };
}

function writeDomainStudioLocation(domain: string | null, section: Tab, replace = false) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (domain) url.searchParams.set('domain', domain);
  else url.searchParams.delete('domain');
  url.searchParams.set('domainSection', section);
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (replace) window.history.replaceState(window.history.state, '', next);
  else window.history.pushState(window.history.state, '', next);
}

function relationshipRecordKey(relationships: Record<string, ManifestModelRelationship>, relationship: ManifestModelRelationship): string {
  const exact = Object.entries(relationships).find(([, value]) => value === relationship);
  if (exact) return exact[0];
  return relationship.qualifiedId ?? relationship.id;
}

function ModelingEditor({ editor, data, selectedDomain, selectedArea, t, onClose, onApplied }: { editor: Editor; data: DbtFirstModelingResponse; selectedDomain: string | null; selectedArea?: ManifestModelArea; t: Theme; onClose: () => void; onApplied: (change: ModelingAuthoringChange) => Promise<void> }) {
  const existing = editor.kind === 'relationship' ? editor.relationship : undefined;
  const existingEntity = editor.kind === 'entity' ? editor.entity : undefined;
  const existingArea = editor.kind === 'area' ? editor.area : undefined;
  const relationshipDraft = editor.kind === 'relationship' ? editor.draft : undefined;
  const [domain, setDomain] = useState(existingArea?.domain ?? existingEntity?.domain ?? selectedDomain ?? Object.keys(data.modeling.packages)[0] ?? '');
  const [areaId, setAreaId] = useState(
    existingArea?.localId
      ?? data.modeling.areas[existingEntity?.areaId ?? existing?.areaId ?? '']?.localId
      ?? selectedArea?.localId
      ?? '',
  );
  const [id, setId] = useState(existing?.localId ?? existingEntity?.localId ?? existingArea?.localId ?? '');
  const [owner, setOwner] = useState(existing?.owner ?? existingEntity?.owner ?? '');
  const [parent, setParent] = useState('');
  const [dbtModel, setDbtModel] = useState(editor.kind === 'entity' ? (existingEntity?.dbtUniqueId ?? editor.dbtUniqueId ?? '') : '');
  const [businessName, setBusinessName] = useState(existingEntity?.businessName ?? '');
  const [businessContext, setBusinessContext] = useState(existingEntity?.businessContext ?? '');
  const [conceptRefs, setConceptRefs] = useState(existingEntity?.conceptRefs?.join(', ') ?? '');
  const [analyticalRole, setAnalyticalRole] = useState<NonNullable<ManifestModelEntity['analyticalRole']>>(existingEntity?.analyticalRole ?? 'unknown');
  const [entityStatus, setEntityStatus] = useState<NonNullable<ManifestModelEntity['status']>>(existingEntity?.status ?? 'draft');
  const [grain, setGrain] = useState(existingEntity?.grain ?? '');
  const [keys, setKeys] = useState(existingEntity?.keys.join(', ') ?? '');
  const [areaName, setAreaName] = useState(existingArea?.name ?? '');
  const [areaDescription, setAreaDescription] = useState(existingArea?.description ?? '');
  const [areaIntents, setAreaIntents] = useState(existingArea?.intentExamples.join(', ') ?? '');
  const [areaReferences, setAreaReferences] = useState(existingArea?.referencedEntityIds.map((reference) => data.modeling.entities[reference]?.localId ?? reference).join(', ') ?? '');
  const [from, setFrom] = useState(existing?.from ?? relationshipDraft?.from ?? '');
  const [to, setTo] = useState(existing?.to ?? relationshipDraft?.to ?? '');
  const [keyPairs, setKeyPairs] = useState(existing?.keys.map((key) => `${key.from}=${key.to}`).join(', ') ?? (relationshipDraft?.fromColumn && relationshipDraft.toColumn ? `${relationshipDraft.fromColumn}=${relationshipDraft.toColumn}` : ''));
  const [cardinality, setCardinality] = useState<RelationshipAuthoringInput['cardinality']>(existing?.cardinality ?? 'unknown');
  const [fanout, setFanout] = useState<RelationshipAuthoringInput['fanout']>(existing?.fanout ?? 'unknown');
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
    if (editor.kind === 'area')
      return {
        operation: 'upsert_area',
        value: {
          id,
          domain,
          name: areaName || id,
          description: areaDescription || undefined,
          intentExamples: csv(areaIntents),
          references: csv(areaReferences),
        },
      };
    if (editor.kind === 'entity')
      return {
        operation: 'upsert_entity',
        value: {
          id,
          domain,
          dbtModel,
          areaId: areaId || undefined,
          businessName: businessName || undefined,
          businessContext: businessContext || undefined,
          conceptRefs: csv(conceptRefs),
          analyticalRole,
          status: entityStatus,
          owner: owner || undefined,
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
        areaId: areaId || undefined,
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
      setPreview(await api.previewModelingChange(next, data.snapshotId));
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
      const evidence = await api.validateModelingRelationship(next.value, data.snapshotId);
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
      await api.applyModelingChange(change, preview.fingerprint, data.snapshotId);
      await onApplied(change);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const title = editor.kind === 'domain' ? 'Create Domain Package' : editor.kind === 'area' ? (existingArea ? 'Edit model area' : 'Create model area') : editor.kind === 'entity' ? (existingEntity ? 'Edit business entity' : 'Add dbt model') : editor.kind === 'contract' ? 'Create analytical contract' : editor.kind === 'export' ? 'Publish domain export' : editor.kind === 'import' ? 'Request domain import' : existing ? 'Edit relationship' : 'Create relationship';
  return (
    <Modal title={title} t={t} onClose={onClose}>
      {!preview ? (
        <div style={{ display: 'grid', gap: 12 }}>
          {editor.kind !== 'domain' && (
            <Field label="Domain">
              <Select value={domain} onChange={setDomain} values={Object.keys(data.modeling.packages)} t={t} />
            </Field>
          )}
          {editor.kind !== 'relationship' && <Field label={editor.kind === 'entity' ? 'Entity id' : editor.kind === 'area' ? 'Area id' : editor.kind === 'contract' ? 'Contract id' : editor.kind === 'export' ? 'Export id' : editor.kind === 'import' ? 'Import id (optional)' : 'Domain id'}><Input value={id} onChange={setId} t={t} placeholder="stable_snake_case_id" /></Field>}
          {editor.kind === 'domain' && (
            <Field label="Parent domain (optional)">
              <Select value={parent} onChange={setParent} values={Object.keys(data.modeling.packages)} t={t} />
            </Field>
          )}
          {editor.kind === 'area' && (
            <>
              <Message text="A Model Area is one small, reviewable source file. It filters the same domain graph; it never creates a competing semantic model." t={t} />
              <Field label="Area name"><Input value={areaName} onChange={setAreaName} t={t} placeholder="Customer lifecycle" /></Field>
              <Field label="Business question or scope"><Input value={areaDescription} onChange={setAreaDescription} t={t} placeholder="How customers progress from first order to repeat purchase." /></Field>
              <Field label="Example questions (comma-separated)"><Input value={areaIntents} onChange={setAreaIntents} t={t} placeholder="Which customers made a second purchase?" /></Field>
              <Field label="Read-only boundary entities (comma-separated)"><Input value={areaReferences} onChange={setAreaReferences} t={t} placeholder="customer" /></Field>
            </>
          )}
          {editor.kind === 'entity' && (
            <>
              <Message text="Start with the business meaning. dbt remains the physical source of truth for columns, descriptions, and tests." t={t} />
              <Field label="Model area"><Select value={areaId} onChange={setAreaId} values={Object.values(data.modeling.areas).filter((area) => area.domain === domain).map((area) => area.localId)} labels={Object.fromEntries(Object.values(data.modeling.areas).filter((area) => area.domain === domain).map((area) => [area.localId, area.name]))} t={t} /></Field>
              <Field label="dbt model">
                <Select value={dbtModel} onChange={setDbtModel} values={Object.keys(data.dbtProvenance.nodes)} labels={Object.fromEntries(Object.values(data.dbtProvenance.nodes).map((node) => [node.uniqueId, `${node.name} · ${node.relation ?? node.uniqueId}`]))} t={t} />
              </Field>
              <Field label="Business name"><Input value={businessName} onChange={setBusinessName} t={t} placeholder="Customer order" /></Field>
              <Field label="Business context"><Input value={businessContext} onChange={setBusinessContext} t={t} placeholder="One order used to understand repeat purchasing and revenue." /></Field>
              <div style={twoColumns}>
                <Field label="Business concepts"><Input value={conceptRefs} onChange={setConceptRefs} t={t} placeholder="customer_lifecycle, revenue" /></Field>
                <Field label="Analytical role"><Select value={analyticalRole} onChange={(value) => setAnalyticalRole(value as NonNullable<ManifestModelEntity['analyticalRole']>)} values={['event', 'dimension', 'snapshot', 'bridge', 'unknown']} t={t} /></Field>
              </div>
              <div style={twoColumns}>
                <Field label="Grain override (optional)">
                  <Input value={grain} onChange={setGrain} t={t} placeholder="Use dbt meta.dql by default" />
                </Field>
                <Field label="Key overrides (optional)">
                  <Input value={keys} onChange={setKeys} t={t} placeholder="customer_id, order_id" />
                </Field>
              </div>
              <div style={twoColumns}>
                <Field label="Lifecycle"><Select value={entityStatus} onChange={(value) => setEntityStatus(value as NonNullable<ManifestModelEntity['status']>)} values={['draft', 'review', 'certified', 'deprecated']} t={t} /></Field>
                <Field label="Owner"><Input value={owner} onChange={setOwner} t={t} placeholder="team@company.com" /></Field>
              </div>
            </>
          )}
          {editor.kind === 'relationship' && (
            <>
              <Message text="Choose the two analytical entities and their join keys. DQL keeps the relationship in draft until warehouse validation passes." t={t} />
              <Field label="Model area"><Select value={areaId} onChange={setAreaId} values={Object.values(data.modeling.areas).filter((area) => area.domain === domain).map((area) => area.localId)} labels={Object.fromEntries(Object.values(data.modeling.areas).filter((area) => area.domain === domain).map((area) => [area.localId, area.name]))} t={t} /></Field>
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
                  <Select value={cardinality} onChange={(v) => setCardinality(v as RelationshipAuthoringInput['cardinality'])} values={['unknown', 'one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']} t={t} />
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
                <Select value={exportRef} onChange={setExportRef} values={Object.values(data.modeling.interfaces?.exports ?? {}).map((item) => `${item.domain}.${item.localId}@${item.version}`)} t={t} />
              </Field>
              <Field label="Exact analytical purpose">
                <Input value={purpose} onChange={setPurpose} t={t} placeholder="Revenue by acquisition channel" />
              </Field>
              <Field label="Lifecycle">
                <Select value={lifecycle ?? 'draft'} onChange={(v) => setLifecycle(v as RelationshipAuthoringInput['status'])} values={['draft', 'review', 'certified', 'deprecated']} t={t} />
              </Field>
            </>
          )}
          {editor.kind !== 'entity' && editor.kind !== 'relationship' && editor.kind !== 'area' && (
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

function DomainOverview({ data, domain, t, onOpen }: { data: DbtFirstModelingResponse; domain: string | null; t: Theme; onOpen: (section: Tab) => void }) {
  const entities = Object.values(data.modeling.entities).filter((entity) => !domain || entity.domain === domain);
  const pkg = domain ? data.modeling.packages[domain] : undefined;
  const assets = domain
    ? (data.domainAssets?.[domain] ?? {})
    : Object.values(data.domainAssets ?? {}).reduce<Record<string, string[]>>((all, packageAssets) => {
        for (const [kind, paths] of Object.entries(packageAssets)) all[kind] = [...(all[kind] ?? []), ...paths];
        return all;
      }, {});
  return (
    <ScrollPanel>
      <PanelHeader title={pkg?.id ?? 'Domains'} detail={pkg ? 'Business context for reusable blocks, safe models, and agent instructions.' : 'Choose a domain to work with its blocks, modeling, and skills.'} t={t} />
      {pkg && (
        <div style={{ display: 'grid', gap: 16, maxWidth: 980 }}>
          <section style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.cellBg, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))' }}>
            <DomainFact label="Owner" value={pkg.owner ?? 'Not declared'} t={t} />
            <DomainFact label="Parent" value={pkg.parent ?? 'Top-level domain'} t={t} />
            <DomainFact label="Source" value={pkg.filePath} t={t} />
          </section>
          <section>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: 12 }}>Continue building</h3>
              <span style={{ color: t.textMuted, fontSize: 10 }}>Everything here is scoped to {pkg.id}.</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 }}>
              {[
                { id: 'blocks' as const, title: 'Blocks', count: assets.blocks?.length ?? 0, detail: 'Reusable analytics.', icon: <Blocks size={16} /> },
                { id: 'diagram' as const, title: 'Modeling', count: entities.length, detail: 'Models and relationships.', icon: <GitBranch size={16} /> },
                { id: 'skills' as const, title: 'Skills', count: assets.skills?.length ?? 0, detail: 'Agent instructions.', icon: <GraduationCap size={16} /> },
              ].map((item) => (
                <button key={item.id} type="button" onClick={() => onOpen(item.id)} style={domainActionCard(t)}>
                  <span style={{ display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: 6, color: t.accent, background: `${t.accent}12` }}>{item.icon}</span>
                  <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 2, textAlign: 'left' }}><b style={{ fontSize: 11 }}>{item.title}</b><span style={{ color: t.textSecondary, fontSize: 10 }}>{item.detail}</span></span>
                  <strong style={{ color: t.accent, fontSize: 16 }}>{item.count}</strong>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </ScrollPanel>
  );
}

function DomainFact({ label, value, t }: { label: string; value: string; t: Theme }) {
  return (
    <div style={{ minWidth: 0, padding: '10px 12px', borderRight: `1px solid ${t.headerBorder}` }}>
      <div style={{ color: t.textMuted, fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
      <div title={value} style={{ marginTop: 4, color: t.textSecondary, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  );
}

function LayerToolbar({ modelingView, columnMode, search, layoutMode, density, visibleLimit, totalEntities, dimUnrelated, showEdgeLabels, showLegend, fullscreen, onBindModel, onRelationship, onNewArea, onModelingView, onColumnMode, onSearch, onLayoutMode, onDensity, onVisibleLimit, onDimUnrelated, onEdgeLabels, onLegend, onFullscreen, onExport, onReset, t }: { modelingView: ModelingViewMode; columnMode: ColumnDisplayMode; search: string; layoutMode: DiagramLayoutMode; density: DiagramDensity; visibleLimit: number; totalEntities: number; dimUnrelated: boolean; showEdgeLabels: boolean; showLegend: boolean; fullscreen: boolean; onBindModel: () => void; onRelationship: () => void; onNewArea: () => void; onModelingView: (mode: ModelingViewMode) => void; onColumnMode: (mode: ColumnDisplayMode) => void; onSearch: (value: string) => void; onLayoutMode: (mode: DiagramLayoutMode) => void; onDensity: (density: DiagramDensity) => void; onVisibleLimit: (limit: number) => void; onDimUnrelated: (value: boolean) => void; onEdgeLabels: (value: boolean) => void; onLegend: (value: boolean) => void; onFullscreen: () => void; onExport: () => void; onReset: () => void; t: Theme }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minHeight: 50,
        padding: '0 10px',
        borderBottom: `1px solid ${t.headerBorder}`,
        background: t.headerBg,
        flexWrap: 'nowrap',
        overflowX: 'auto',
        scrollbarWidth: 'thin',
      }}
    >
      {/* Prototype segmented Business/Data toggle. */}
      <div role="group" aria-label="Modeling view" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, border: `1px solid ${t.headerBorder}`, borderRadius: 7, background: t.appBg, flexShrink: 0 }}>
        <button type="button" onClick={() => onModelingView('business')} style={{ border: 'none', borderRadius: 5, padding: '4px 11px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: t.font, whiteSpace: 'nowrap', background: modelingView === 'business' ? 'var(--accent-dim)' : 'transparent', color: modelingView === 'business' ? t.accent : t.textMuted }}>Business modeling</button>
        <button type="button" onClick={() => onModelingView('data')} style={{ border: 'none', borderRadius: 5, padding: '4px 11px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: t.font, whiteSpace: 'nowrap', background: modelingView === 'data' ? 'var(--accent-dim)' : 'transparent', color: modelingView === 'data' ? t.accent : t.textMuted }}>Data modeling</button>
      </div>
      <IconButton t={t} title="Bind model" onClick={onBindModel}><Plus size={14} /></IconButton><IconButton t={t} title="Create relationship" onClick={onRelationship}><Link2 size={14} /></IconButton><IconButton t={t} title="Create model area" onClick={onNewArea}><Boxes size={14} /></IconButton>
      {modelingView === 'data' && <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: t.textMuted, fontSize: 10 }}><Columns3 size={13} /><select aria-label="Visible columns" value={columnMode} onChange={(event) => onColumnMode(event.target.value as ColumnDisplayMode)} style={{ ...inputStyle(t), width: 104, padding: '5px 6px' }}><option value="keys">Keys only</option><option value="relevant">Relevant</option><option value="all">All columns</option></select></label>}
      <label style={{ position: 'relative', width: 138, flex: '0 0 138px' }}><Search size={12} style={{ position: 'absolute', left: 7, top: 8, color: t.textMuted }} /><input aria-label="Search diagram" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Find model or column" style={{ ...inputStyle(t), padding: '6px 7px 6px 24px' }} /></label>
      <select aria-label="Diagram layout" value={layoutMode} onChange={(event) => { onLayoutMode(event.target.value as DiagramLayoutMode); onReset(); }} style={{ ...inputStyle(t), width: 94, padding: '5px 6px' }}><option value="auto">Auto</option><option value="grid">Grid</option><option value="star">Star</option></select>
      <select aria-label="Diagram density" value={density} onChange={(event) => onDensity(event.target.value as DiagramDensity)} style={{ ...inputStyle(t), width: 92, padding: '5px 6px' }}><option value="compact">Compact</option><option value="normal">Normal</option><option value="wide">Wide</option></select>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: t.textMuted, fontSize: 9 }}>Show <input aria-label="Visible model limit" type="number" min={0} max={totalEntities} value={visibleLimit || totalEntities} onChange={(event) => onVisibleLimit(Math.max(0, Number(event.target.value) >= totalEntities ? 0 : Number(event.target.value)))} style={{ ...inputStyle(t), width: 52, padding: '5px' }} /></label>
      <button aria-label="Dim unrelated models" title="Dim unrelated models" onClick={() => onDimUnrelated(!dimUnrelated)} style={{ ...iconButtonStyle(t), color: dimUnrelated ? t.accent : t.textMuted }}><EyeOff size={14} /></button>
      <button aria-label="Toggle relationship labels" title="Toggle relationship labels" onClick={() => onEdgeLabels(!showEdgeLabels)} style={{ ...iconButtonStyle(t), color: showEdgeLabels ? t.accent : t.textMuted }}><Link2 size={14} /></button>
      <button aria-label="Relationship legend" title="Relationship legend" onClick={() => onLegend(!showLegend)} style={{ ...iconButtonStyle(t), color: showLegend ? t.accent : t.textMuted }}><Boxes size={14} /></button>
      <button aria-label="Export diagram as SVG" title="Export diagram as SVG" onClick={onExport} style={iconButtonStyle(t)}><Download size={14} /></button>
      <button aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen diagram'} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen diagram'} onClick={onFullscreen} style={iconButtonStyle(t)}>{fullscreen ? <XCircle size={14} /> : <Maximize2 size={14} />}</button>
      <button aria-label="Reset to automatic layout" title="Reset to automatic layout" onClick={onReset} style={iconButtonStyle(t)}><RotateCcw size={14} /></button>
    </div>
  );
}

function DiagramLegend({ t }: { t: Theme }) { return <div style={{ display: 'flex', gap: 14, padding: '7px 12px', borderBottom: `1px solid ${t.headerBorder}`, background: t.headerBg, color: t.textSecondary, fontSize: 9.5 }}>{[['Safe certified', '#2e9b63'], ['Validated review', '#5b73d6'], ['Attribution / draft', '#9a6b2f'], ['Stale certification', '#d47822']].map(([label, color]) => <span key={label} style={{ display: 'flex', gap: 5, alignItems: 'center' }}><i style={{ display: 'inline-block', width: 18, height: 3, background: color, borderRadius: 2 }} />{label}</span>)}<span style={{ marginLeft: 'auto' }}>1:1 · 1:N · N:1 · N:N</span></div>; }

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

function DomainAssetsPanel({ data, domain, kinds, title, detail, t }: { data: DbtFirstModelingResponse; domain: string | null; kinds: string[]; title: string; detail: string; t: Theme }) {
  const assets = domain
    ? (data.domainAssets?.[domain] ?? {})
    : Object.values(data.domainAssets ?? {}).reduce<Record<string, string[]>>((all, current) => {
        for (const [kind, paths] of Object.entries(current)) all[kind] = [...(all[kind] ?? []), ...paths];
        return all;
      }, {});
  return (
    <ScrollPanel>
      <PanelHeader title={title} detail={detail} t={t} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(250px, 1fr))',
          gap: 12,
        }}
      >
        {kinds.map((kind) => (
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

function RelatedProductsPanel({ data, domain, kind, t }: { data: DbtFirstModelingResponse; domain: string | null; kind: 'notebooks' | 'apps'; t: Theme }) {
  const [products, setProducts] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(Boolean(domain));
  useEffect(() => {
    let active = true;
    if (!domain) {
      setProducts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    void api.getRelatedDomainProducts(domain)
      .then((result) => { if (active) setProducts(result[kind] as unknown as Array<Record<string, unknown>>); })
      .catch(() => { if (active) setProducts([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [domain, kind]);
  const legacyPaths = domain
    ? (data.domainAssets?.[domain]?.[kind] ?? [])
    : Object.values(data.domainAssets ?? {}).flatMap((assets) => assets[kind] ?? []);
  const label = kind === 'notebooks' ? 'Notebooks' : 'Apps';
  return (
    <ScrollPanel>
      <PanelHeader
        title={`Related ${label}`}
        detail={`${label} are global shared products. This view is a backlink from their owner/uses-domain metadata; it does not create a second copy inside the Domain Package.`}
        t={t}
      />
      {loading ? <Blank title={`Loading related ${label.toLowerCase()}…`} detail="Resolving global product backlinks from the compiled project snapshot." t={t} /> : products.length ? (
        <div style={{ display: 'grid', gap: 10 }}>
          {products.map((product) => {
            const id = String(product.id ?? product.filePath ?? product.title ?? 'product');
            const usesDomains = Array.isArray(product.usesDomains) ? product.usesDomains.map(String) : [];
            return <div key={id} style={overviewCard(t)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <FolderTree size={14} color={t.accent} />
                <b>{String(product.name ?? product.title ?? id)}</b>
                {product.lifecycle ? <Badge t={t}>{String(product.lifecycle)}</Badge> : null}
              </div>
              <p style={{ color: t.textSecondary, fontSize: 11, margin: '7px 0 0' }}>{String(product.purpose ?? 'No analytical purpose declared yet.')}</p>
              <code style={{ display: 'block', marginTop: 7, color: t.textMuted, fontSize: 10 }}>{String(product.filePath ?? '')}</code>
              <div style={{ marginTop: 7, color: t.textMuted, fontSize: 10 }}>Owner: {String(product.ownerDomain ?? 'Shared')} · Uses: {usesDomains.join(', ') || 'none declared'}</div>
            </div>;
          })}
        </div>
      ) : legacyPaths.length ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <Message text="These paths use the legacy domain-local layout. They remain readable during migration, but new products should be global and declare ownerDomain / usesDomains." t={t} />
          {legacyPaths.map((path) => (
            <div key={path} style={overviewCard(t)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <FolderTree size={14} color={t.accent} />
                <code style={{ color: t.textPrimary, fontSize: 11 }}>{path}</code>
              </div>
              <p style={{ color: t.textMuted, fontSize: 10, margin: '7px 0 0' }}>Legacy backlink · migrate without duplicating the product.</p>
            </div>
          ))}
        </div>
      ) : (
        <Blank title={`No related ${label.toLowerCase()} yet`} detail={`Create the ${kind === 'notebooks' ? 'notebook' : 'app'} from the global ${label} surface, then declare this domain in its product context to make the backlink appear here.`} t={t} />
      )}
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
              <tr key={item.qualifiedId}>
                <Td>
                  <b>
                    {item.domain}.{item.localId}@{item.version}
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
                  <b>{item.localId}</b>
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

function RelationshipTable({ relationships, entities, t, onSelect, onEdit }: { relationships: ManifestModelRelationship[]; entities: Record<string, ManifestModelEntity>; t: Theme; onSelect: (relationship: ManifestModelRelationship) => void; onEdit: (r: ManifestModelRelationship) => void }) {
  return (
    <ScrollPanel>
      <PanelHeader title="Analytical relationships" detail="Transformation lineage is context; only these governed edges can prove an analytical join." t={t} />
      {relationships.length ? <table style={tableStyle}>
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
            <tr key={r.qualifiedId ?? r.id} onClick={() => onSelect(r)} style={{ cursor: 'pointer' }}>
              <Td>
                <b>{r.localId}</b>
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
      </table> : <Blank title="No join proofs in this domain" detail="Drag from a source column handle to a target column handle in Domain Model to create a draft, then validate its cardinality and fanout." t={t} />}
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

function ReadinessPanel({ data, domain, relationships, t, onCreateExport, onCreateImport, onCreateContract, onEditRelationship }: { data: DbtFirstModelingResponse; domain: string | null; relationships: ManifestModelRelationship[]; t: Theme; onCreateExport: () => void; onCreateImport: () => void; onCreateContract: () => void; onEditRelationship: (relationship: ManifestModelRelationship) => void }) {
  const safe = relationships.filter((r) => r.automaticJoinAllowed).length;
  const stale = relationships.filter((r) => r.staleCertification).length;
  const unvalidated = relationships.filter((r) => !r.validation).length;
  const blocking = data.diagnostics.filter((d) => d.severity === 'error').length;
  const exports = Object.values(data.modeling.interfaces?.exports ?? {}).filter((item) => !domain || item.domain === domain);
  const imports = Object.values(data.modeling.interfaces?.imports ?? {}).filter((item) => !domain || item.domain === domain);
  const contracts = Object.values(data.modeling.contracts).filter((contract) => !domain || contract.domain === domain);
  const crossDomain = relationships.filter((relationship) => data.modeling.entities[relationship.from]?.domain !== data.modeling.entities[relationship.to]?.domain);
  const score = Math.max(0, 100 - blocking * 25 - stale * 15 - unvalidated * 10 - crossDomain.filter((relationship) => !relationship.importRefs?.length).length * 15);
  return (
    <ScrollPanel>
      <PanelHeader title={`${domain ?? 'Domain'} readiness`} detail="What must be resolved before agents can execute, reuse, or cross domain boundaries safely." t={t} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, minmax(120px, 1fr))',
          gap: 12,
        }}
      >
        <Metric value={score} label="Readiness score" color={score >= 80 ? '#2e9b63' : score >= 60 ? '#d47822' : '#c94b55'} t={t} />
        <Metric value={safe} label="Safe join proofs" color="#2e9b63" t={t} />
        <Metric value={stale} label="Stale certifications" color="#d47822" t={t} />
        <Metric value={unvalidated} label="Need validation" color="#9a6b2f" t={t} />
        <Metric value={blocking} label="Blocking diagnostics" color="#c94b55" t={t} />
      </div>
      <h3 style={sectionHeading(t)}>Next actions</h3>
      <div
        style={{
          border: `1px solid ${t.headerBorder}`,
          borderRadius: 9,
          overflow: 'hidden',
        }}
      >
        {data.diagnostics.length || unvalidated ? (
          <>{data.diagnostics.map((d, i) => (
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
          ))}{relationships.filter((relationship) => !relationship.validation).map((relationship) => <button key={relationship.id} onClick={() => onEditRelationship(relationship)} style={{ display: 'block', width: '100%', border: 0, borderBottom: `1px solid ${t.headerBorder}`, background: 'transparent', color: t.textPrimary, padding: '10px 12px', textAlign: 'left', cursor: 'pointer', fontSize: 12 }}><b style={{ color: '#9a6b2f' }}>validate</b> · Prove {relationship.from} → {relationship.to} before agents may use this route.</button>)}</>
        ) : (
          <div style={{ padding: 18, color: '#2e9b63', fontSize: 13 }}>
            <CheckCircle2 size={15} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            No compile diagnostics.
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 22, gap: 8 }}><h3 style={{ ...sectionHeading(t), flex: 1, margin: 0 }}>Cross-domain access</h3><Button t={t} onClick={onCreateImport}><Plus size={13} /> Request access</Button><Button t={t} onClick={onCreateExport}><Plus size={13} /> Publish access</Button></div>
      <p style={{ color: t.textSecondary, fontSize: 11, margin: '7px 0 12px' }}>Only needed when another domain consumes an approved entity, key, metric, or block.</p>
      {exports.length || imports.length ? <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(2, minmax(240px, 1fr))' }}>
        {exports.map((item) => <ReadinessCard key={item.qualifiedId} title={domainExportRef(item.domain, item.localId, item.version)} badge="Published" detail={`${item.entity ?? 'Shared analytics'} · ${item.consumerDomains.join(', ') || 'no consumers'}`} status={item.status} t={t} />)}
        {imports.map((item) => <ReadinessCard key={item.id} title={item.exportRef} badge="Imported" detail={`${item.domain} · ${item.purpose}`} status={item.status} t={t} />)}
      </div> : <Blank title="No cross-domain access needed" detail="DQL will prompt for an export/import when a relationship crosses a domain boundary." t={t} />}
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 22, gap: 8 }}><h3 style={{ ...sectionHeading(t), flex: 1, margin: 0 }}>Certified analytics</h3><Button primary t={t} onClick={onCreateContract}><Plus size={13} /> Certify use case</Button></div>
      <p style={{ color: t.textSecondary, fontSize: 11, margin: '7px 0 12px' }}>Bind a proven analytical purpose to its approved entities, blocks, filters, and evaluations.</p>
      {contracts.length ? <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(2, minmax(240px, 1fr))' }}>{contracts.map((contract) => <ReadinessCard key={contract.qualifiedId} title={contract.localId} badge="Use case" detail={`${contract.entities.join(', ') || 'No entities'} · ${contract.blocks.join(', ') || 'No certified blocks'}`} status={contract.status} t={t} />)}</div> : <Blank title="No certified use cases yet" detail="Start from a validated block or notebook, then certify it for repeatable agent use." t={t} />}
    </ScrollPanel>
  );
}

function ReadinessCard({ title, badge, detail, status, t }: { title: string; badge: string; detail: string; status: string; t: Theme }) {
  return <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, padding: 11, background: t.cellBg }}><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><b style={{ fontSize: 12, flex: 1 }}>{title}</b><Badge t={t}>{badge}</Badge></div><p style={{ color: t.textSecondary, fontSize: 10.5, margin: '7px 0 9px' }}>{detail}</p><Status status={status} t={t} /></div>;
}

function domainExportRef(domain: string, id: string, version: number): string {
  const qualified = id.startsWith(`${domain}.`) ? id : `${domain}.${id}`;
  return qualified.includes('@') ? qualified : `${qualified}@${version}`;
}

function DbtInventory({ data, domain, unbound, t, onBind }: { data: DbtFirstModelingResponse; domain: string | null; unbound: DbtFirstModelingResponse['dbtProvenance']['nodes'][string][]; t: Theme; onBind: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 50;
  const boundIds = new Set(domainEntityRecords(data.modeling, domain).map(({ entity }) => entity.dbtUniqueId));
  const normalizedSearch = search.trim().toLowerCase();
  const nodes = Object.values(data.dbtProvenance.nodes).filter((node) => {
    if (domain && !boundIds.has(node.uniqueId)) return false;
    if (!normalizedSearch) return true;
    return [node.name, node.uniqueId, node.relation, node.sourcePath].some((value) => String(value ?? '').toLowerCase().includes(normalizedSearch));
  });
  const pageCount = Math.max(1, Math.ceil(nodes.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleNodes = nodes.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  return (
    <ScrollPanel>
      <PanelHeader title="dbt-owned scope" detail={`Read on demand from ${data.dbtProvenance.manifestPath}. Columns, descriptions, tests, and MetricFlow formulas remain dbt-owned.${domain ? ' This view shows dbt models already bound to this domain.' : ''}`} t={t} action={<label style={{ position: 'relative', width: 230 }}><Search size={13} style={{ position: 'absolute', top: 9, left: 8, color: t.textMuted }} /><input aria-label="Search dbt scope" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="Find model, relation, or path" style={{ ...inputStyle(t), paddingLeft: 27 }} /></label>} />
      {visibleNodes.length ? <><table style={tableStyle}>
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
          {visibleNodes.map((node) => {
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, color: t.textMuted, fontSize: 10 }}>
        <span>{nodes.length} models · page {currentPage + 1} of {pageCount}</span>
        <div style={{ display: 'flex', gap: 6 }}><Button t={t} disabled={currentPage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous</Button><Button t={t} disabled={currentPage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>Next</Button></div>
      </div></> : <Blank title={search ? 'No dbt models match this search' : domain ? 'No dbt models are bound to this domain' : 'No dbt models found'} detail={domain ? 'Use Bind model in Domain Model to add a dbt model without copying its schema.' : 'Compile the dbt project, then refresh Domain Studio.'} t={t} />}
    </ScrollPanel>
  );
}

function EntityInspector({ entity, detail, t, onEdit, onEditDbtSource }: { entity: ManifestModelEntity; detail: DbtNodeAuthoringDetail | null; t: Theme; onEdit: () => void; onEditDbtSource: () => void }) {
  return (
    <Inspector t={t}>
      <InspectorTitle title={entity.businessName || entity.localId} subtitle={entity.domain} t={t} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Button t={t} onClick={onEdit}>Edit DQL binding</Button>
        <Button t={t} onClick={onEditDbtSource}>Preview dbt source patch</Button>
      </div>
      <h3 style={inspectorHeading(t)}>Business context</h3>
      <p style={{ margin: '0 0 8px', color: t.textSecondary, fontSize: 11, lineHeight: 1.55 }}>{entity.businessContext || `Add the DQL-owned business context for ${entity.localId}. dbt descriptions remain physical-source documentation.`}</p>
      <Property label="concepts" value={entity.conceptRefs?.join(', ') || 'Not mapped'} t={t} />
      <Property label="analytical role" value={entity.analyticalRole ?? 'Not declared'} t={t} />
      <Property label="owner" value={entity.owner ?? 'Not declared'} t={t} />
      <h3 style={inspectorHeading(t)}>Analytics identity</h3>
      <Property label="dbt unique id" value={entity.dbtUniqueId} t={t} />
      <Property label="relation" value={detail?.relation ?? 'Loading…'} t={t} />
      <Property label="grain" value={entity.grain ?? detail?.dqlMeta?.grain ?? 'Not declared'} t={t} />
      <Property label="keys" value={(entity.keys.length ? entity.keys : (detail?.dqlMeta?.keys ?? [])).join(', ') || 'Not declared'} t={t} />
      <Property label="source" value={detail?.sourcePath ?? entity.sourcePath} t={t} />
      <Property label="dbt description" value={detail?.description ?? 'Not declared'} t={t} />
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

function DbtSourceEditor({ entity, detail, snapshotId, t, onClose, onApplied }: {
  entity: ManifestModelEntity;
  detail: DbtNodeAuthoringDetail;
  snapshotId: string;
  t: Theme;
  onClose: () => void;
  onApplied: () => Promise<void>;
}) {
  const initialTests = detail.columns
    .filter((column) => column.tests.length > 0)
    .map((column) => `${column.name}: ${column.tests.join(', ')}`)
    .join('\n');
  const [description, setDescription] = useState(detail.description ?? '');
  const [tests, setTests] = useState(initialTests);
  const [preview, setPreview] = useState<(DbtSourcePatchPreview & { snapshotId: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const change = (): DbtSourceAuthoringInput => ({
    uniqueId: entity.dbtUniqueId,
    description,
    columns: tests.split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf(':');
      if (separator < 1) return [];
      const name = line.slice(0, separator).trim();
      const dataTests = csv(line.slice(separator + 1));
      return name ? [{ name, tests: dataTests }] : [];
    }),
  });
  const previewPatch = async () => {
    try {
      setBusy(true);
      setMessage(null);
      setPreview(await api.previewDbtSourcePatch(change(), snapshotId));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const applyPatch = async () => {
    if (!preview) return;
    try {
      setBusy(true);
      setMessage(null);
      await api.applyDbtSourcePatch(change(), preview.fingerprint, preview.snapshotId);
      await onApplied();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Edit dbt source · ${detail.name}`} t={t} onClose={onClose}>
      <Message text="dbt owns descriptions and tests. DQL will preview a guarded patch to the dbt YAML source; no dbt metadata is copied into the Domain Package." t={t} />
      {!preview ? <div style={{ display: 'grid', gap: 12 }}>
        <Field label="Model description">
          <textarea aria-label="Model description" value={description} onChange={(event) => setDescription(event.target.value)} rows={5} style={{ ...inputStyle(t), resize: 'vertical' }} />
        </Field>
        <Field label="Column tests (one column per line)">
          <textarea aria-label="Column tests" value={tests} onChange={(event) => setTests(event.target.value)} rows={6} placeholder="order_id: unique, not_null" style={{ ...inputStyle(t), resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }} />
        </Field>
        <p style={{ margin: 0, color: t.textMuted, fontSize: 10 }}>Descriptions/tests stay in dbt YAML. Business meaning, relationships, contracts, and policies stay in the DQL Domain Package.</p>
        {message && <Message text={message} t={t} />}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7 }}><Button t={t} onClick={onClose}>Cancel</Button><Button primary t={t} disabled={busy} onClick={() => void previewPatch()}>Preview source patch</Button></div>
      </div> : <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ color: t.textSecondary, fontSize: 11 }}>Source: <code>{preview.patch.path}</code></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <SourcePreview title="Current dbt YAML" source={preview.patch.before || '# New dbt schema YAML'} t={t} />
          <SourcePreview title="Proposed dbt YAML" source={preview.patch.after} t={t} />
        </div>
        {message && <Message text={message} t={t} />}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7 }}><Button t={t} onClick={() => setPreview(null)}>Back</Button><Button primary t={t} disabled={busy || !preview.patch.changed} onClick={() => void applyPatch()}>{preview.patch.changed ? 'Apply dbt source patch' : 'No changes'}</Button></div>
      </div>}
    </Modal>
  );
}

function SourcePreview({ title, source, t }: { title: string; source: string; t: Theme }) {
  return <section><strong style={{ fontSize: 10 }}>{title}</strong><pre tabIndex={0} style={{ maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', background: t.appBg, border: `1px solid ${t.headerBorder}`, borderRadius: 6, padding: 10, fontSize: 9.5, color: t.textSecondary }}>{source}</pre></section>;
}

function RelationshipInspector({ relationship, t, onEdit }: { relationship: ManifestModelRelationship; t: Theme; onEdit: () => void }) {
  return (
    <Inspector t={t}>
      <InspectorTitle title={relationship.localId} subtitle={`${relationship.from} → ${relationship.to}`} t={t} />
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

function StudioSummary({ data, domainEntities, domainRelationships, t, onSelectRelationship }: { data: DbtFirstModelingResponse; domainEntities: ManifestModelEntity[]; domainRelationships: ManifestModelRelationship[]; t: Theme; onSelectRelationship: (relationship: ManifestModelRelationship) => void }) {
  return (
    <Inspector t={t}>
      <InspectorTitle title="Domain overview" subtitle="Select a model or relationship to inspect it." t={t} />
      <Metric value={domainEntities.length} label="Analytical entities" color={t.accent} t={t} />
      <div style={{ height: 8 }} />
      <Metric value={domainRelationships.length} label="Relationships" color="#377cc8" t={t} />
      <h3 style={inspectorHeading(t)}>Relationships</h3>
      {domainRelationships.length ? domainRelationships.map((relationship) => <button key={relationship.qualifiedId} onClick={() => onSelectRelationship(relationship)} style={{ width: '100%', textAlign: 'left', border: 0, borderBottom: `1px solid ${t.headerBorder}`, background: 'transparent', color: t.textPrimary, padding: '8px 2px', cursor: 'pointer', fontSize: 10.5 }}><b>{relationship.localId}</b><span style={{ display: 'block', color: t.textMuted, marginTop: 3 }}>{relationship.from} → {relationship.to} · {relationship.cardinality.replace(/_/g, ' ')}</span></button>) : <p style={{ color: t.textMuted, fontSize: 10.5 }}>Drag between two column handles to create the first relationship.</p>}
      <div style={{ height: 8 }} />
      <Metric value={Object.keys(data.modeling.contracts).length} label="Contracts" color="#2e9b63" t={t} />
      <h3 style={inspectorHeading(t)}>Ownership boundary</h3>
      <p style={{ color: t.textSecondary, fontSize: 11, lineHeight: 1.55 }}>dbt owns tables, columns, descriptions, tests, and metrics. DQL owns domain membership, analytical identity, safe relationship proof, contracts, certified blocks, and agent policy. Shared apps and notebooks reference this domain without moving inside it.</p>
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
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
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
          <button aria-label={`Close ${title}`} title="Close" onClick={onClose} style={iconButtonStyle(t)}>
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
    <button aria-label={title} title={title} onClick={onClick} style={iconButtonStyle(t)}>
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
function readDiagramPreferences(): Partial<{ viewMode: ModelingViewMode; columnMode: ColumnDisplayMode; layoutMode: DiagramLayoutMode; density: DiagramDensity; visibleLimit: number; dimUnrelated: boolean; showEdgeLabels: boolean }> {
  try { return JSON.parse(localStorage.getItem('dql-modeling-preferences') ?? '{}') as Partial<{ viewMode: ModelingViewMode; columnMode: ColumnDisplayMode; layoutMode: DiagramLayoutMode; density: DiagramDensity; visibleLimit: number; dimUnrelated: boolean; showEdgeLabels: boolean }>; }
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
const workspaceNavButton = (t: Theme, active: boolean, nested: boolean): React.CSSProperties => ({
  width: '100%',
  minHeight: 30,
  padding: nested ? '6px 8px 6px 14px' : '7px 8px',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  border: 0,
  borderRadius: 6,
  background: active ? `${t.accent}18` : 'transparent',
  color: active ? t.accent : t.textSecondary,
  fontSize: 10.5,
  fontWeight: active ? 700 : 500,
  textAlign: 'left',
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
const domainActionCard = (t: Theme): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  minHeight: 58,
  border: `1px solid ${t.headerBorder}`,
  background: t.cellBg,
  borderRadius: 8,
  padding: '9px 10px',
  color: t.textPrimary,
  cursor: 'pointer',
  fontFamily: t.font,
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
