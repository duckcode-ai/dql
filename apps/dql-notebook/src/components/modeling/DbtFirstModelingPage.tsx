import React, { useEffect, useMemo, useState } from 'react';
import { Boxes, CheckCircle2, FileCode2, GitBranch, Link2, Plus, RefreshCw, ShieldCheck, Table2, XCircle } from 'lucide-react';
import type {
  DbtNodeAuthoringDetail,
  ManifestModelEntity,
  ManifestModelRelationship,
  ModelingAuthoringChange,
  ModelingChangePreview,
  RelationshipAuthoringInput,
} from '@duckcodeailabs/dql-core';
import { api, type DbtFirstModelingResponse } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { DomainModelingCanvas } from './DomainModelingCanvas';

type Theme = (typeof themes)['dark'];
type Tab = 'diagram' | 'relationships' | 'contracts' | 'quality' | 'dbt';
type Editor = { kind: 'domain' } | { kind: 'entity'; dbtUniqueId?: string } | { kind: 'relationship'; relationship?: ManifestModelRelationship } | { kind: 'contract' };

export function DbtFirstModelingPage() {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const [data, setData] = useState<DbtFirstModelingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('diagram');
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodeDetail, setNodeDetail] = useState<DbtNodeAuthoringDetail | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);

  const refresh = async () => {
    setLoading(true);
    const result = await api.getDbtFirstModeling();
    setData(result);
    setError(result ? null : 'dbt-first modeling is not enabled or the local server could not compile manifest v3.');
    if (result && selectedDomain === null) setSelectedDomain(Object.keys(result.modeling.packages).sort()[0] ?? null);
    setLoading(false);
  };
  useEffect(() => { void refresh(); }, []);

  const selectedEntity = data?.modeling.entities[selectedId ?? ''];
  const selectedRelationship = data?.modeling.relationships[selectedId ?? ''];
  useEffect(() => {
    if (!selectedEntity) { setNodeDetail(null); return; }
    void api.getDbtModelingNode(selectedEntity.dbtUniqueId).then(setNodeDetail).catch(() => setNodeDetail(null));
  }, [selectedEntity?.dbtUniqueId]);

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
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: t.appBg, color: t.textPrimary }}>
      <header style={{ padding: '17px 20px 13px', borderBottom: `1px solid ${t.headerBorder}`, background: t.cellBg }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18, alignItems: 'center' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><Boxes size={20} color={t.accent} /><h1 style={{ margin: 0, fontSize: 19 }}>Domain Studio</h1><Badge t={t}>Manifest v3</Badge></div>
            <p style={{ margin: '5px 0 0 29px', color: t.textSecondary, fontSize: 12 }}>Design analytical entities, prove relationships, and govern cross-domain joins without copying dbt schema.</p>
          </div>
          <div style={{ display: 'flex', gap: 7 }}>
            <Button t={t} onClick={() => setEditor({ kind: 'domain' })}><Plus size={14} /> Domain</Button>
            <Button t={t} onClick={() => setEditor({ kind: 'entity' })}><Plus size={14} /> Bind model</Button>
            <Button primary t={t} onClick={() => setEditor({ kind: 'relationship' })}><Link2 size={14} /> Relationship</Button>
            <IconButton t={t} title="Recompile" onClick={() => void refresh()}><RefreshCw size={15} /></IconButton>
          </div>
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '232px minmax(500px, 1fr) 310px' }}>
        <aside style={{ borderRight: `1px solid ${t.headerBorder}`, overflow: 'auto', background: t.cellBg }}>
          <SideHeading t={t}>Domain packages</SideHeading>
          <button onClick={() => { setSelectedDomain(null); setSelectedId(null); }} style={treeButton(t, selectedDomain === null)}><GitBranch size={14} /> All domains</button>
          {sortDomainPackages(data.modeling.packages).map((pkg) => {
            const entities = Object.values(data.modeling.entities).filter((entity) => entity.domain === pkg.id);
            return <div key={pkg.id}>
              <button onClick={() => { setSelectedDomain(pkg.id); setSelectedId(null); }} style={{ ...treeButton(t, selectedDomain === pkg.id), paddingLeft: 7 + domainDepth(pkg.id, data.modeling.packages) * 14 }}><Boxes size={14} /> <span style={{ flex: 1 }}>{pkg.id.split('.').pop()}</span><small>{entities.length}</small></button>
              {selectedDomain === pkg.id && entities.map((entity) => <button key={entity.id} onClick={() => setSelectedId(entity.id)} style={entityTreeButton(t, selectedId === entity.id)}><Table2 size={12} /> {entity.id}</button>)}
            </div>;
          })}
          <SideHeading t={t}>dbt inventory</SideHeading>
          <div style={{ padding: '0 10px 12px', fontSize: 11, color: t.textMuted }}>{unboundNodes.length} unbound models</div>
          {unboundNodes.slice(0, 12).map((node) => <button key={node.uniqueId} onClick={() => setEditor({ kind: 'entity', dbtUniqueId: node.uniqueId })} style={inventoryButton(t)}><FileCode2 size={12} /><span>{node.name}</span><Plus size={12} /></button>)}
        </aside>

        <main style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <nav style={{ height: 42, display: 'flex', alignItems: 'end', gap: 2, padding: '0 12px', borderBottom: `1px solid ${t.headerBorder}`, background: t.cellBg }}>
            {(['diagram', 'relationships', 'contracts', 'quality', 'dbt'] as Tab[]).map((value) => <button key={value} onClick={() => setTab(value)} style={tabButton(t, tab === value)}>{value === 'dbt' ? 'dbt sources' : value[0]!.toUpperCase() + value.slice(1)}</button>)}
          </nav>
          <div style={{ flex: 1, minHeight: 0 }}>
            {tab === 'diagram' && <DomainModelingCanvas modeling={data.modeling} relationByDbtId={relationByDbtId} selectedDomain={selectedDomain} selectedId={selectedId} onSelectEntity={setSelectedId} onSelectRelationship={setSelectedId} theme={t} />}
            {tab === 'relationships' && <RelationshipTable relationships={domainRelationships} entities={data.modeling.entities} t={t} onSelect={setSelectedId} onEdit={(relationship) => setEditor({ kind: 'relationship', relationship })} />}
            {tab === 'contracts' && <ContractTable data={data} domain={selectedDomain} t={t} onCreate={() => setEditor({ kind: 'contract' })} />}
            {tab === 'quality' && <QualityPanel data={data} relationships={domainRelationships} t={t} />}
            {tab === 'dbt' && <DbtInventory data={data} unbound={unboundNodes} t={t} onBind={(dbtUniqueId) => setEditor({ kind: 'entity', dbtUniqueId })} />}
          </div>
        </main>

        <aside style={{ borderLeft: `1px solid ${t.headerBorder}`, overflow: 'auto', background: t.cellBg }}>
          <SideHeading t={t}>Inspector</SideHeading>
          {selectedEntity ? <EntityInspector entity={selectedEntity} detail={nodeDetail} t={t} onEdit={() => setEditor({ kind: 'entity', dbtUniqueId: selectedEntity.dbtUniqueId })} />
            : selectedRelationship ? <RelationshipInspector relationship={selectedRelationship} t={t} onEdit={() => setEditor({ kind: 'relationship', relationship: selectedRelationship })} />
              : <StudioSummary data={data} domainEntities={domainEntities} domainRelationships={domainRelationships} t={t} />}
        </aside>
      </div>
      {editor && <ModelingEditor editor={editor} data={data} selectedDomain={selectedDomain} t={t} onClose={() => setEditor(null)} onApplied={async () => { setEditor(null); await refresh(); }} />}
    </div>
  );
}

function ModelingEditor({ editor, data, selectedDomain, t, onClose, onApplied }: { editor: Editor; data: DbtFirstModelingResponse; selectedDomain: string | null; t: Theme; onClose: () => void; onApplied: () => Promise<void> }) {
  const existing = editor.kind === 'relationship' ? editor.relationship : undefined;
  const [domain, setDomain] = useState(selectedDomain ?? Object.keys(data.modeling.packages)[0] ?? '');
  const [id, setId] = useState(existing?.id ?? '');
  const [owner, setOwner] = useState(existing?.owner ?? '');
  const [parent, setParent] = useState('');
  const [dbtModel, setDbtModel] = useState(editor.kind === 'entity' ? editor.dbtUniqueId ?? '' : '');
  const [grain, setGrain] = useState('');
  const [keys, setKeys] = useState('');
  const [from, setFrom] = useState(existing?.from ?? '');
  const [to, setTo] = useState(existing?.to ?? '');
  const [fromKey, setFromKey] = useState(existing?.keys[0]?.from ?? '');
  const [toKey, setToKey] = useState(existing?.keys[0]?.to ?? '');
  const [cardinality, setCardinality] = useState<RelationshipAuthoringInput['cardinality']>(existing?.cardinality ?? 'many_to_one');
  const [fanout, setFanout] = useState<RelationshipAuthoringInput['fanout']>(existing?.fanout ?? 'safe');
  const [lifecycle, setLifecycle] = useState<RelationshipAuthoringInput['status']>(existing?.status ?? 'draft');
  const [entities, setEntities] = useState('');
  const [preview, setPreview] = useState<ModelingChangePreview | null>(null);
  const [change, setChange] = useState<ModelingAuthoringChange | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [validation, setValidation] = useState(existing?.validation);

  const buildChange = (): ModelingAuthoringChange => {
    if (editor.kind === 'domain') return { operation: 'upsert_domain', value: { id, name: id, owner, parent: parent || undefined, exports: [] } };
    if (editor.kind === 'entity') return { operation: 'upsert_entity', value: { id, domain, dbtModel, grain: grain || undefined, keys: csv(keys) } };
    if (editor.kind === 'contract') return { operation: 'upsert_contract', value: { id, domain, entities: csv(entities), status: 'draft', owner, requiredEvaluation: true } };
    const unchanged = !existing || (
      existing.from === from && existing.to === to && existing.keys[0]?.from === fromKey && existing.keys[0]?.to === toKey
      && existing.cardinality === cardinality && existing.fanout === fanout
    );
    const currentValidation = unchanged ? validation : undefined;
    const status = lifecycle === 'certified' && currentValidation?.status !== 'passed' ? 'review' : lifecycle;
    const fromEntity = data.modeling.entities[from];
    const toEntity = data.modeling.entities[to];
    return { operation: 'upsert_relationship', value: {
      id, domain, from, to, keys: [{ from: fromKey, to: toKey }], cardinality, fanout, status,
      owner: owner || undefined,
      crossDomain: fromEntity?.domain !== toEntity?.domain,
      validation: currentValidation,
      certifiedAgainst: status === 'certified' && fromEntity?.grain && toEntity?.grain
        ? { from: { grain: fromEntity.grain, keys: fromEntity.keys }, to: { grain: toEntity.grain, keys: toEntity.keys } }
        : undefined,
    } };
  };
  const previewChange = async () => {
    try { setBusy(true); setMessage(null); const next = buildChange(); setChange(next); setPreview(await api.previewModelingChange(next)); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const validate = async () => {
    try {
      setBusy(true); setMessage(null);
      const next = buildChange();
      if (next.operation !== 'upsert_relationship') return;
      const evidence = await api.validateModelingRelationship(next.value);
      setValidation(evidence); setMessage(evidence.status === 'passed' ? 'Warehouse proof passed. Preview the source change to save it.' : evidence.message ?? 'Validation failed.'); setPreview(null);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!preview || !change) return;
    try { setBusy(true); await api.applyModelingChange(change, preview.fingerprint); await onApplied(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const title = editor.kind === 'domain' ? 'Create Domain Package' : editor.kind === 'entity' ? 'Bind dbt model' : editor.kind === 'contract' ? 'Create analytical contract' : existing ? 'Edit relationship' : 'Create relationship';
  return <Modal title={title} t={t} onClose={onClose}>
    {!preview ? <div style={{ display: 'grid', gap: 12 }}>
      {editor.kind !== 'domain' && <Field label="Domain"><Select value={domain} onChange={setDomain} values={Object.keys(data.modeling.packages)} t={t} /></Field>}
      <Field label={editor.kind === 'entity' ? 'Entity id' : editor.kind === 'relationship' ? 'Relationship id' : editor.kind === 'contract' ? 'Contract id' : 'Domain id'}><Input value={id} onChange={setId} t={t} placeholder="stable_snake_case_id" /></Field>
      {editor.kind === 'domain' && <Field label="Parent domain (optional)"><Select value={parent} onChange={setParent} values={Object.keys(data.modeling.packages)} t={t} /></Field>}
      {editor.kind === 'entity' && <><Field label="dbt model"><Select value={dbtModel} onChange={setDbtModel} values={Object.keys(data.dbtProvenance.nodes)} labels={Object.fromEntries(Object.values(data.dbtProvenance.nodes).map((node) => [node.uniqueId, `${node.name} · ${node.relation ?? node.uniqueId}`]))} t={t} /></Field><div style={twoColumns}><Field label="Grain override (optional)"><Input value={grain} onChange={setGrain} t={t} placeholder="Use dbt meta.dql by default" /></Field><Field label="Key overrides (optional)"><Input value={keys} onChange={setKeys} t={t} placeholder="customer_id, order_id" /></Field></div></>}
      {editor.kind === 'relationship' && <><div style={twoColumns}><Field label="From entity"><Select value={from} onChange={setFrom} values={Object.keys(data.modeling.entities)} t={t} /></Field><Field label="To entity"><Select value={to} onChange={setTo} values={Object.keys(data.modeling.entities)} t={t} /></Field></div><div style={twoColumns}><Field label="From key"><Input value={fromKey} onChange={setFromKey} t={t} placeholder="customer_id" /></Field><Field label="To key"><Input value={toKey} onChange={setToKey} t={t} placeholder="customer_id" /></Field></div><div style={twoColumns}><Field label="Cardinality"><Select value={cardinality} onChange={(v) => setCardinality(v as RelationshipAuthoringInput['cardinality'])} values={['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']} t={t} /></Field><Field label="Fanout policy"><Select value={fanout} onChange={(v) => setFanout(v as RelationshipAuthoringInput['fanout'])} values={['safe', 'attribution_required', 'unsafe', 'unknown']} t={t} /></Field></div><Field label="Lifecycle"><Select value={lifecycle ?? 'draft'} onChange={(v) => setLifecycle(v as RelationshipAuthoringInput['status'])} values={['draft', 'review', 'certified', 'deprecated']} t={t} /></Field>{validation && <Evidence evidence={validation} t={t} />}</>}
      {editor.kind === 'contract' && <Field label="Covered entities"><Input value={entities} onChange={setEntities} t={t} placeholder="order, customer" /></Field>}
      {(editor.kind === 'domain' || editor.kind === 'relationship' || editor.kind === 'contract') && <Field label="Owner"><Input value={owner} onChange={setOwner} t={t} placeholder="team@company.com" /></Field>}
      {message && <Message text={message} t={t} />}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>{editor.kind === 'relationship' && <Button t={t} onClick={() => void validate()} disabled={busy}><ShieldCheck size={14} /> Validate in warehouse</Button>}<Button primary t={t} onClick={() => void previewChange()} disabled={busy}>Preview source change</Button></div>
    </div> : <div>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: t.textSecondary }}>Review the exact Domain Package source change before it is written.</p>
      {preview.patches.map((patch) => <div key={patch.path} style={{ marginBottom: 12 }}><strong style={{ fontSize: 12 }}>{patch.path}</strong><pre style={sourcePreview(t)}>{patch.after}</pre></div>)}
      {message && <Message text={message} t={t} />}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><Button t={t} onClick={() => setPreview(null)}>Back</Button><Button primary t={t} onClick={() => void apply()} disabled={busy}>Apply to Domain Package</Button></div>
    </div>}
  </Modal>;
}

function RelationshipTable({ relationships, entities, t, onSelect, onEdit }: { relationships: ManifestModelRelationship[]; entities: Record<string, ManifestModelEntity>; t: Theme; onSelect: (id: string) => void; onEdit: (r: ManifestModelRelationship) => void }) {
  return <ScrollPanel><PanelHeader title="Analytical relationships" detail="Transformation lineage is context; only these governed edges can prove an analytical join." t={t} />
    <table style={tableStyle}><thead><tr><Th>Relationship</Th><Th>Path</Th><Th>Cardinality</Th><Th>Safety</Th><Th>Status</Th><Th>Proof</Th><Th /></tr></thead><tbody>{relationships.map((r) => <tr key={r.id} onClick={() => onSelect(r.id)} style={{ cursor: 'pointer' }}><Td><b>{r.id}</b></Td><Td>{r.from} <span style={{ color: t.textMuted }}>→</span> {r.to}{entities[r.from]?.domain !== entities[r.to]?.domain && <Badge t={t}>cross-domain</Badge>}</Td><Td>{r.cardinality.replace(/_/g, ' ')}</Td><Td>{r.fanout}</Td><Td><Status status={r.status} t={t} /></Td><Td>{r.automaticJoinAllowed ? <span style={{ color: '#2e9b63' }}>certified</span> : r.staleCertification ? <span style={{ color: '#d47822' }}>stale</span> : r.validation?.status ?? 'not run'}</Td><Td><button onClick={(event) => { event.stopPropagation(); onEdit(r); }} style={linkButton(t)}>Edit</button></Td></tr>)}</tbody></table>
  </ScrollPanel>;
}

function ContractTable({ data, domain, t, onCreate }: { data: DbtFirstModelingResponse; domain: string | null; t: Theme; onCreate: () => void }) {
  const contracts = Object.values(data.modeling.contracts).filter((contract) => !domain || contract.domain === domain);
  return <ScrollPanel><PanelHeader title="Analytical contracts" detail="Contracts bind governed entities and blocks to evaluation and review requirements." t={t} action={<Button primary t={t} onClick={onCreate}><Plus size={14} /> Contract</Button>} />
    {contracts.length ? <table style={tableStyle}><thead><tr><Th>Contract</Th><Th>Domain</Th><Th>Entities</Th><Th>Blocks</Th><Th>Status</Th><Th>Evaluation</Th></tr></thead><tbody>{contracts.map((c) => <tr key={c.id}><Td><b>{c.id}</b></Td><Td>{c.domain}</Td><Td>{c.entities.join(', ') || '—'}</Td><Td>{c.blocks.join(', ') || '—'}</Td><Td><Status status={c.status} t={t} /></Td><Td>{c.requiredEvaluation ? 'Required' : 'Optional'}</Td></tr>)}</tbody></table> : <Blank title="No contracts in this scope" detail="Create a contract when a set of entities and certified blocks must move through evaluation and review together." t={t} />}
  </ScrollPanel>;
}

function QualityPanel({ data, relationships, t }: { data: DbtFirstModelingResponse; relationships: ManifestModelRelationship[]; t: Theme }) {
  const safe = relationships.filter((r) => r.automaticJoinAllowed).length;
  const stale = relationships.filter((r) => r.staleCertification).length;
  const unvalidated = relationships.filter((r) => !r.validation).length;
  return <ScrollPanel><PanelHeader title="Model quality" detail="Trust gates for agentic SQL: identity, warehouse proof, fanout policy, freshness, and cross-domain exports." t={t} />
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(130px, 1fr))', gap: 12 }}><Metric value={safe} label="Safe join proofs" color="#2e9b63" t={t} /><Metric value={stale} label="Stale certifications" color="#d47822" t={t} /><Metric value={unvalidated} label="Need validation" color="#9a6b2f" t={t} /><Metric value={data.diagnostics.filter((d) => d.severity === 'error').length} label="Blocking diagnostics" color="#c94b55" t={t} /></div>
    <div style={{ marginTop: 18, border: `1px solid ${t.headerBorder}`, borderRadius: 9, overflow: 'hidden' }}>{data.diagnostics.length ? data.diagnostics.map((d, i) => <div key={i} style={{ padding: '10px 12px', borderBottom: `1px solid ${t.headerBorder}`, fontSize: 12 }}><b style={{ color: d.severity === 'error' ? '#c94b55' : '#d47822' }}>{d.severity}</b> · {d.message}</div>) : <div style={{ padding: 18, color: '#2e9b63', fontSize: 13 }}><CheckCircle2 size={15} style={{ verticalAlign: 'middle', marginRight: 6 }} />No compile diagnostics.</div>}</div>
  </ScrollPanel>;
}

function DbtInventory({ data, unbound, t, onBind }: { data: DbtFirstModelingResponse; unbound: DbtFirstModelingResponse['dbtProvenance']['nodes'][string][]; t: Theme; onBind: (id: string) => void }) {
  return <ScrollPanel><PanelHeader title="dbt-owned sources" detail={`Read on demand from ${data.dbtProvenance.manifestPath}. Columns, descriptions, tests, and MetricFlow formulas remain dbt-owned.`} t={t} />
    <table style={tableStyle}><thead><tr><Th>dbt model</Th><Th>Relation</Th><Th>Source</Th><Th>Metadata</Th><Th /></tr></thead><tbody>{Object.values(data.dbtProvenance.nodes).map((node) => { const isUnbound = unbound.some((item) => item.uniqueId === node.uniqueId); return <tr key={node.uniqueId}><Td><b>{node.name}</b></Td><Td>{node.relation ?? '—'}</Td><Td>{node.sourcePath ?? '—'}</Td><Td>{Object.entries(node.available).filter(([, yes]) => yes).map(([name]) => name).join(', ')}</Td><Td>{isUnbound ? <button onClick={() => onBind(node.uniqueId)} style={linkButton(t)}>Bind</button> : <span style={{ color: '#2e9b63' }}>Bound</span>}</Td></tr>; })}</tbody></table>
  </ScrollPanel>;
}

function EntityInspector({ entity, detail, t, onEdit }: { entity: ManifestModelEntity; detail: DbtNodeAuthoringDetail | null; t: Theme; onEdit: () => void }) {
  return <Inspector t={t}><InspectorTitle title={entity.id} subtitle={entity.domain} t={t} /><Button t={t} onClick={onEdit}>Edit binding</Button><Property label="dbt unique id" value={entity.dbtUniqueId} t={t} /><Property label="relation" value={detail?.relation ?? 'Loading…'} t={t} /><Property label="grain" value={entity.grain ?? detail?.dqlMeta?.grain ?? 'Not declared'} t={t} /><Property label="keys" value={(entity.keys.length ? entity.keys : detail?.dqlMeta?.keys ?? []).join(', ') || 'Not declared'} t={t} /><Property label="source" value={detail?.sourcePath ?? entity.sourcePath} t={t} />
    <h3 style={inspectorHeading(t)}>dbt columns ({detail?.columns.length ?? '…'})</h3>{detail?.columns.slice(0, 16).map((column) => <div key={column.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: `1px solid ${t.headerBorder}`, fontSize: 11 }}><span>{column.name}</span><span style={{ color: t.textMuted }}>{column.type ?? '—'}</span></div>)}
  </Inspector>;
}

function RelationshipInspector({ relationship, t, onEdit }: { relationship: ManifestModelRelationship; t: Theme; onEdit: () => void }) {
  return <Inspector t={t}><InspectorTitle title={relationship.id} subtitle={`${relationship.from} → ${relationship.to}`} t={t} /><Button primary t={t} onClick={onEdit}>Validate / edit</Button><Property label="cardinality" value={relationship.cardinality} t={t} /><Property label="fanout" value={relationship.fanout} t={t} /><Property label="lifecycle" value={relationship.status} t={t} /><Property label="join keys" value={relationship.keys.map((key) => `${key.from} = ${key.to}`).join(', ')} t={t} /><Property label="automatic agent join" value={relationship.automaticJoinAllowed ? 'Allowed' : 'Blocked'} t={t} />{relationship.validation ? <Evidence evidence={relationship.validation} t={t} /> : <Message text="No warehouse proof has been captured. This edge cannot authorize automatic SQL joins." t={t} />}</Inspector>;
}

function StudioSummary({ data, domainEntities, domainRelationships, t }: { data: DbtFirstModelingResponse; domainEntities: ManifestModelEntity[]; domainRelationships: ManifestModelRelationship[]; t: Theme }) {
  return <Inspector t={t}><InspectorTitle title="Domain overview" subtitle="Select a node or edge to inspect it." t={t} /><Metric value={domainEntities.length} label="Analytical entities" color={t.accent} t={t} /><div style={{ height: 8 }} /><Metric value={domainRelationships.length} label="Relationships" color="#377cc8" t={t} /><div style={{ height: 8 }} /><Metric value={Object.keys(data.modeling.contracts).length} label="Contracts" color="#2e9b63" t={t} /><h3 style={inspectorHeading(t)}>Ownership boundary</h3><p style={{ color: t.textSecondary, fontSize: 11, lineHeight: 1.55 }}>dbt owns tables, columns, descriptions, tests, and metrics. DQL owns domain membership, analytical identity, safe relationship proof, contracts, blocks, apps, and agent policy.</p></Inspector>;
}

function Evidence({ evidence, t }: { evidence: NonNullable<ManifestModelRelationship['validation']>; t: Theme }) { return <div style={{ marginTop: 12, padding: 10, border: `1px solid ${evidence.status === 'passed' ? '#2e9b6355' : '#c94b5555'}`, background: evidence.status === 'passed' ? '#2e9b630d' : '#c94b550d', borderRadius: 7, fontSize: 11 }}><b style={{ color: evidence.status === 'passed' ? '#2e9b63' : '#c94b55' }}>{evidence.status === 'passed' ? 'Warehouse proof passed' : 'Warehouse proof failed'}</b><div style={{ color: t.textSecondary, marginTop: 7, lineHeight: 1.55 }}>Rows: {evidence.fromRows} → {evidence.toRows}<br />Joined: {evidence.joinedRows} · unmatched: {evidence.unmatchedFrom}<br />Max rows/key: {evidence.maxFromPerKey} → {evidence.maxToPerKey}</div></div>; }

function EmptyState({ t, title, detail }: { t: Theme; title: string; detail: string }) { return <div style={{ flex: 1, display: 'grid', placeItems: 'center', background: t.appBg, color: t.textPrimary }}><div style={{ maxWidth: 560, textAlign: 'center' }}><Boxes size={34} color={t.accent} /><h1 style={{ fontSize: 20 }}>{title}</h1><p style={{ color: t.textSecondary, lineHeight: 1.6 }}>{detail}</p><code style={{ fontSize: 12 }}>manifestVersion: 3 · modeling.mode: dbt-first</code></div></div>; }
function Modal({ title, t, onClose, children }: { title: string; t: Theme; onClose: () => void; children: React.ReactNode }) { return <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#0008', display: 'grid', placeItems: 'center', padding: 20 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div style={{ width: 'min(720px, 94vw)', maxHeight: '88vh', overflow: 'auto', background: t.appBg, border: `1px solid ${t.headerBorder}`, borderRadius: 12, boxShadow: '0 24px 80px #0006' }}><div style={{ display: 'flex', justifyContent: 'space-between', padding: '15px 18px', borderBottom: `1px solid ${t.headerBorder}` }}><strong>{title}</strong><button onClick={onClose} style={iconButtonStyle(t)}><XCircle size={17} /></button></div><div style={{ padding: 18 }}>{children}</div></div></div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label style={{ display: 'grid', gap: 6, fontSize: 11, fontWeight: 650 }}>{label}{children}</label>; }
function Input({ value, onChange, t, placeholder }: { value: string; onChange: (v: string) => void; t: Theme; placeholder?: string }) { return <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={inputStyle(t)} />; }
function Select({ value, onChange, values, labels, t }: { value: string; onChange: (v: string) => void; values: string[]; labels?: Record<string, string>; t: Theme }) { return <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle(t)}><option value="">Select…</option>{values.map((item) => <option key={item} value={item}>{labels?.[item] ?? item}</option>)}</select>; }
function Button({ children, t, onClick, primary, disabled }: { children: React.ReactNode; t: Theme; onClick: () => void; primary?: boolean; disabled?: boolean }) { return <button disabled={disabled} onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, border: `1px solid ${primary ? t.accent : t.headerBorder}`, background: primary ? t.accent : t.appBg, color: primary ? '#fff' : t.textPrimary, borderRadius: 6, padding: '7px 10px', fontSize: 11, fontWeight: 650, cursor: disabled ? 'wait' : 'pointer', opacity: disabled ? 0.65 : 1 }}>{children}</button>; }
function IconButton({ children, title, t, onClick }: { children: React.ReactNode; title: string; t: Theme; onClick: () => void }) { return <button title={title} onClick={onClick} style={iconButtonStyle(t)}>{children}</button>; }
function Badge({ children, t }: { children: React.ReactNode; t: Theme }) { return <span style={{ marginLeft: 5, border: `1px solid ${t.accent}55`, color: t.accent, background: `${t.accent}10`, borderRadius: 999, padding: '3px 7px', fontSize: 9, fontWeight: 750 }}>{children}</span>; }
function SideHeading({ children, t }: { children: React.ReactNode; t: Theme }) { return <div style={{ padding: '15px 12px 8px', color: t.textMuted, fontSize: 10, fontWeight: 750, textTransform: 'uppercase', letterSpacing: '.07em' }}>{children}</div>; }
function ScrollPanel({ children }: { children: React.ReactNode }) { return <div style={{ height: '100%', overflow: 'auto', padding: 20 }}>{children}</div>; }
function PanelHeader({ title, detail, t, action }: { title: string; detail: string; t: Theme; action?: React.ReactNode }) { return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'start', marginBottom: 18 }}><div><h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2><p style={{ margin: '5px 0 0', color: t.textSecondary, fontSize: 11 }}>{detail}</p></div>{action}</div>; }
function Blank({ title, detail, t }: { title: string; detail: string; t: Theme }) { return <div style={{ border: `1px dashed ${t.headerBorder}`, borderRadius: 10, padding: 30, textAlign: 'center' }}><strong>{title}</strong><p style={{ color: t.textSecondary, fontSize: 12 }}>{detail}</p></div>; }
function Inspector({ children }: { children: React.ReactNode; t: Theme }) { return <div style={{ padding: '4px 14px 20px' }}>{children}</div>; }
function InspectorTitle({ title, subtitle, t }: { title: string; subtitle: string; t: Theme }) { return <div style={{ marginBottom: 14 }}><h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2><div style={{ color: t.textMuted, fontSize: 11, marginTop: 4 }}>{subtitle}</div></div>; }
function Property({ label, value, t }: { label: string; value: string; t: Theme }) { return <div style={{ padding: '9px 0', borderBottom: `1px solid ${t.headerBorder}` }}><div style={{ color: t.textMuted, fontSize: 9, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div><div style={{ fontSize: 11, marginTop: 4, overflowWrap: 'anywhere' }}>{value}</div></div>; }
function Metric({ value, label, color, t }: { value: number; label: string; color: string; t: Theme }) { return <div style={{ border: `1px solid ${t.headerBorder}`, borderLeft: `3px solid ${color}`, background: t.cellBg, borderRadius: 8, padding: 12 }}><div style={{ fontSize: 22, fontWeight: 750 }}>{value}</div><div style={{ color: t.textSecondary, fontSize: 10, marginTop: 3 }}>{label}</div></div>; }
function Status({ status, t }: { status: string; t: Theme }) { const color = status === 'certified' ? '#2e9b63' : status === 'deprecated' ? t.textMuted : status === 'review' ? '#377cc8' : '#9a6b2f'; return <span style={{ color, background: `${color}15`, borderRadius: 999, padding: '3px 7px', fontSize: 10 }}>{status}</span>; }
function Message({ text, t }: { text: string; t: Theme }) { return <div style={{ borderLeft: `3px solid ${t.accent}`, background: `${t.accent}0d`, padding: '9px 10px', color: t.textSecondary, fontSize: 11, lineHeight: 1.5 }}>{text}</div>; }
function Th({ children }: { children?: React.ReactNode }) { return <th style={{ textAlign: 'left', padding: '9px 10px', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.05em', opacity: .65 }}>{children}</th>; }
function Td({ children }: { children: React.ReactNode }) { return <td style={{ padding: '11px 10px', borderTop: '1px solid var(--border-subtle)', fontSize: 11 }}>{children}</td>; }
function csv(value: string): string[] { return value.split(',').map((item) => item.trim()).filter(Boolean); }
function domainDepth(id: string, packages: DbtFirstModelingResponse['modeling']['packages']): number { let depth = 0; let current = packages[id]?.parent; const seen = new Set<string>(); while (current && !seen.has(current)) { seen.add(current); depth += 1; current = packages[current]?.parent; } return depth; }
function sortDomainPackages(packages: DbtFirstModelingResponse['modeling']['packages']) { return Object.values(packages).sort((a, b) => `${a.parent ?? ''}/${a.id}`.localeCompare(`${b.parent ?? ''}/${b.id}`)); }

const twoColumns: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse' };
const sourcePreview = (t: Theme): React.CSSProperties => ({ whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto', padding: 12, borderRadius: 7, background: t.activityBarBg, color: t.textSecondary, fontSize: 10, lineHeight: 1.5 });
const inputStyle = (t: Theme): React.CSSProperties => ({ width: '100%', boxSizing: 'border-box', border: `1px solid ${t.headerBorder}`, background: t.cellBg, color: t.textPrimary, borderRadius: 6, padding: '8px 9px', fontSize: 11 });
const iconButtonStyle = (t: Theme): React.CSSProperties => ({ border: `1px solid ${t.headerBorder}`, background: t.appBg, color: t.textSecondary, borderRadius: 6, padding: 7, display: 'grid', placeItems: 'center', cursor: 'pointer' });
const treeButton = (t: Theme, active: boolean): React.CSSProperties => ({ width: 'calc(100% - 12px)', margin: '2px 6px', padding: '8px 7px', display: 'flex', alignItems: 'center', gap: 7, border: 0, borderRadius: 6, background: active ? `${t.accent}18` : 'transparent', color: active ? t.accent : t.textPrimary, fontSize: 11, textAlign: 'left', cursor: 'pointer' });
const entityTreeButton = (t: Theme, active: boolean): React.CSSProperties => ({ width: 'calc(100% - 26px)', margin: '1px 6px 1px 20px', padding: '6px 8px', display: 'flex', gap: 6, alignItems: 'center', border: 0, background: 'transparent', color: active ? t.accent : t.textSecondary, fontSize: 10, textAlign: 'left', cursor: 'pointer' });
const inventoryButton = (t: Theme): React.CSSProperties => ({ width: 'calc(100% - 12px)', margin: '1px 6px', padding: '6px 7px', display: 'grid', gridTemplateColumns: '14px 1fr 14px', gap: 5, alignItems: 'center', border: 0, background: 'transparent', color: t.textSecondary, fontSize: 10, textAlign: 'left', cursor: 'pointer' });
const tabButton = (t: Theme, active: boolean): React.CSSProperties => ({ height: 34, padding: '0 12px', border: 0, borderBottom: `2px solid ${active ? t.accent : 'transparent'}`, background: 'transparent', color: active ? t.textPrimary : t.textSecondary, fontSize: 11, fontWeight: active ? 700 : 500, cursor: 'pointer' });
const linkButton = (t: Theme): React.CSSProperties => ({ border: 0, background: 'transparent', color: t.accent, fontSize: 10, fontWeight: 650, cursor: 'pointer' });
const inspectorHeading = (t: Theme): React.CSSProperties => ({ margin: '18px 0 7px', paddingBottom: 7, borderBottom: `1px solid ${t.headerBorder}`, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: t.textMuted });
