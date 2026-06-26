import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import {
  getCloudEmbedConfig,
  openCloudObjectDetail,
  openCloudLineage,
  postDqlCloudEvent,
  type CloudContextTab,
} from '../../cloud/cloud-mode';
import { useNotebook } from '../../store/NotebookStore';
import { makeCell } from '../../store/NotebookStore';
import type { SemanticDimension, SemanticMetric, SchemaTable } from '../../store/types';
import type { Theme } from '../../themes/notebook-theme';
import { themes } from '../../themes/notebook-theme';
import { parseNotebookFile } from '../../utils/parse-workbook';
import type { BlockEntry } from '../blocks/block-types';
import { SchemaPanel } from '../panels/SchemaPanel';

interface CloudContextDrawerProps {
  open: boolean;
  activeTab: CloudContextTab;
  onTabChange: (tab: CloudContextTab) => void;
  onClose: () => void;
}

const TABS: Array<{ id: CloudContextTab; label: string }> = [
  { id: 'notebooks', label: 'Notebooks' },
  { id: 'semantic', label: 'Semantic' },
  { id: 'schema', label: 'Schema' },
  { id: 'contracts', label: 'DataLex Contracts' },
  { id: 'lineage', label: 'Lineage' },
  { id: 'blocks', label: 'Blocks' },
];

type ContractHit = {
  object_id?: string;
  object_type?: string;
  name?: string;
  full_name?: string;
  description?: string;
  payload?: {
    domain?: string;
    owner?: string;
    status?: string;
    grain?: string[] | string;
    accepted_sources?: string[];
    metrics?: string[];
    dimensions?: string[];
    certification_policy?: { required_approvals?: number };
    [key: string]: unknown;
  };
};

type LineageEdge = {
  id?: string;
  target_model?: string;
  target_column?: string;
  source_model?: string;
  source_column?: string;
  expression?: string | null;
  confidence?: number | null;
};

type CloudNotebook = {
  id: string;
  name: string;
  description?: string | null;
  owner_id?: string | null;
  visibility?: 'private' | 'shared' | 'tenant';
  status?: 'draft' | 'review' | 'published' | 'archived';
  source_kind?: string;
  sidecar_path?: string | null;
  updated_at?: string;
};

async function fetchCloudJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

export function CloudContextDrawer({
  open,
  activeTab,
  onTabChange,
  onClose,
}: CloudContextDrawerProps) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const cloud = getCloudEmbedConfig();
  const [blocks, setBlocks] = useState<BlockEntry[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [contracts, setContracts] = useState<ContractHit[]>([]);
  const [contractsLoading, setContractsLoading] = useState(false);
  const [lineageEdges, setLineageEdges] = useState<LineageEdge[]>([]);
  const [lineageLoading, setLineageLoading] = useState(false);
  const [sidecarLineage, setSidecarLineage] = useState<{ nodes: any[]; edges: any[] }>({ nodes: [], edges: [] });
  const [notebooks, setNotebooks] = useState<CloudNotebook[]>([]);
  const [notebooksLoading, setNotebooksLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    postDqlCloudEvent('dql.context.open', { tab: activeTab });
  }, [activeTab, open]);

  useEffect(() => {
    if (!open || activeTab !== 'notebooks' || !cloud?.project_id) return;
    setNotebooksLoading(true);
    void fetchCloudJson<{ notebooks?: CloudNotebook[] }>(
      `/v1/projects/${encodeURIComponent(cloud.project_id)}/notebooks`,
    )
      .then((result) => setNotebooks(result.notebooks ?? []))
      .catch((error) => {
        console.warn('Cloud notebook governance load failed:', error);
        setNotebooks([]);
      })
      .finally(() => setNotebooksLoading(false));
  }, [activeTab, cloud?.project_id, open]);

  useEffect(() => {
    if (!open || activeTab !== 'contracts' || !cloud?.project_id) return;
    const domain = cloud.warehouse_context?.business_domain ?? '';
    const query = domain || 'contract';
    setContractsLoading(true);
    void fetchCloudJson<{ hits?: ContractHit[] }>(
      `/v1/projects/${encodeURIComponent(cloud.project_id)}/metadata/search?q=${encodeURIComponent(query)}&types=datalex_contract&limit=30`,
    )
      .then(async (result) => {
        if (result.hits?.length) return result;
        return fetchCloudJson<{ hits?: ContractHit[] }>(
          `/v1/projects/${encodeURIComponent(cloud.project_id!)}/metadata/search?q=revenue&types=datalex_contract&limit=30`,
        );
      })
      .then((result) => setContracts(result.hits ?? []))
      .catch((error) => {
        console.warn('Cloud context contract load failed:', error);
        setContracts([]);
      })
      .finally(() => setContractsLoading(false));
  }, [activeTab, cloud?.project_id, cloud?.warehouse_context?.business_domain, open]);

  useEffect(() => {
    if (!open || activeTab !== 'lineage') return;
    setLineageLoading(true);
    const cloudLineage = cloud?.project_id
      ? fetchCloudJson<{ edges?: LineageEdge[] }>(
          `/v1/projects/${encodeURIComponent(cloud.project_id)}/lineage?confidence_min=0`,
        )
      : Promise.resolve({ edges: [] });
    void Promise.all([cloudLineage, api.fetchLineage()])
      .then(([cloudResult, sidecarResult]) => {
        setLineageEdges(cloudResult.edges ?? []);
        setSidecarLineage(sidecarResult);
      })
      .catch((error) => {
        console.warn('Cloud context lineage load failed:', error);
        setLineageEdges([]);
        setSidecarLineage({ nodes: [], edges: [] });
      })
      .finally(() => setLineageLoading(false));
  }, [activeTab, cloud?.project_id, open]);

  useEffect(() => {
    if (!open) return;
    if (state.schemaTables.length === 0 && !state.schemaLoading) {
      dispatch({ type: 'SET_SCHEMA_LOADING', loading: true });
      void api.getSchema()
        .then((tables) => dispatch({ type: 'SET_SCHEMA', tables }))
        .catch((error) => console.warn('Cloud context schema load failed:', error))
        .finally(() => dispatch({ type: 'SET_SCHEMA_LOADING', loading: false }));
    }
    if (!state.semanticLayer.available && !state.semanticLayer.loading) {
      dispatch({ type: 'SET_SEMANTIC_LOADING', loading: true });
      void api.getSemanticLayer()
        .then((layer) => dispatch({ type: 'SET_SEMANTIC_LAYER', layer }))
        .catch((error) => console.warn('Cloud context semantic load failed:', error))
        .finally(() => dispatch({ type: 'SET_SEMANTIC_LOADING', loading: false }));
    }
  }, [
    dispatch,
    open,
    state.schemaLoading,
    state.schemaTables.length,
    state.semanticLayer.available,
    state.semanticLayer.loading,
  ]);

  useEffect(() => {
    if (!open || activeTab !== 'blocks') return;
    setBlocksLoading(true);
    void api.getBlockLibrary()
      .then((result) => setBlocks(result.blocks as BlockEntry[]))
      .catch(() => setBlocks([]))
      .finally(() => setBlocksLoading(false));
  }, [activeTab, open]);

  if (!open) return null;

  return (
    <aside
      data-cloud-context-drawer="true"
      style={{
        width: 390,
        minWidth: 390,
        maxWidth: '38vw',
        height: '100%',
        borderLeft: `1px solid ${t.headerBorder}`,
        background: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: 44,
          flexShrink: 0,
          borderBottom: `1px solid ${t.headerBorder}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 12px',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary, flex: 1 }}>Project context</div>
        <button
          onClick={onClose}
          aria-label="Close context"
          style={{
            border: `1px solid ${t.btnBorder}`,
            borderRadius: 6,
            background: 'transparent',
            color: t.textMuted,
            cursor: 'pointer',
            fontSize: 14,
            height: 26,
            width: 28,
          }}
        >
          ×
        </button>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: 8,
          borderBottom: `1px solid ${t.headerBorder}`,
          overflowX: 'auto',
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            style={{
              border: `1px solid ${activeTab === tab.id ? '#f97316' : t.btnBorder}`,
              borderRadius: 999,
              background: activeTab === tab.id ? '#fff7ed' : '#ffffff',
              color: activeTab === tab.id ? '#c2410c' : t.textSecondary,
              cursor: 'pointer',
              fontFamily: t.font,
              fontSize: 11,
              fontWeight: 700,
              padding: '5px 9px',
              whiteSpace: 'nowrap',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {activeTab === 'notebooks' && <NotebooksContext notebooks={notebooks} loading={notebooksLoading} />}
        {activeTab === 'semantic' && <SemanticContext />}
        {activeTab === 'schema' && <SchemaPanel />}
        {activeTab === 'contracts' && <ContractsContext cloud={cloud} contracts={contracts} loading={contractsLoading} />}
        {activeTab === 'lineage' && <LineageContext cloudEdges={lineageEdges} sidecar={sidecarLineage} loading={lineageLoading} />}
        {activeTab === 'blocks' && (
          <BlocksContext blocks={blocks} loading={blocksLoading} />
        )}
      </div>
    </aside>
  );
}

function SemanticContext() {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const metrics = state.semanticLayer.metrics.slice(0, 30);
  const dimensions = [...state.semanticLayer.dimensions, ...state.semanticLayer.timeDimensions].slice(0, 30);
  const models = state.semanticLayer.semanticModels.slice(0, 20);

  return (
    <ScrollBody>
      <SummaryRow
        items={[
          ['Metrics', state.semanticLayer.metrics.length],
          ['Dimensions', state.semanticLayer.dimensions.length + state.semanticLayer.timeDimensions.length],
          ['Models', state.semanticLayer.semanticModels.length],
        ]}
      />
      <Section title="Metrics" empty="No semantic metrics found.">
        {metrics.map((metric) => <SemanticMetricRow key={metric.name} metric={metric} />)}
      </Section>
      <Section title="Dimensions" empty="No semantic dimensions found.">
        {dimensions.map((dimension) => <SemanticDimensionRow key={`${dimension.table}.${dimension.name}`} dimension={dimension} />)}
      </Section>
      <Section title="Models" empty="No semantic models found.">
        {models.map((model) => (
          <div key={model.name} style={{ ...rowStyle(t), display: 'block' }}>
            <div style={{ fontWeight: 700 }}>{model.label || model.name}</div>
            <div style={{ color: t.textMuted, fontSize: 11 }}>{model.table}</div>
          </div>
        ))}
      </Section>
    </ScrollBody>
  );
}

function NotebooksContext({ notebooks, loading }: { notebooks: CloudNotebook[]; loading: boolean }) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [query, setQuery] = useState('');
  const localNotebookFiles = state.files.filter((file) => file.type === 'notebook');
  const byPath = new Set(notebooks.map((n) => n.sidecar_path).filter(Boolean));
  const localOnly = localNotebookFiles.filter((file) => !byPath.has(file.path));
  const privateCount = notebooks.filter((n) => n.visibility === 'private').length;
  const sharedCount = notebooks.filter((n) => n.visibility === 'shared' || n.visibility === 'tenant').length;
  const notebookMatches = (notebook: CloudNotebook) => {
    const haystack = [
      notebook.name,
      notebook.description,
      notebook.visibility,
      notebook.status,
      notebook.source_kind,
      notebook.sidecar_path,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  };
  const localMatches = (file: { name: string; path: string }) => {
    const needle = query.trim().toLowerCase();
    return `${file.name} ${file.path}`.toLowerCase().includes(needle);
  };
  const privateNotebooks = notebooks.filter((notebook) => notebook.visibility === 'private' && notebookMatches(notebook));
  const sharedNotebooks = notebooks.filter((notebook) => notebook.visibility !== 'private' && notebookMatches(notebook));
  const localOnlyMatches = localOnly.filter(localMatches);

  const openNotebook = async (path: string, name: string) => {
    try {
      const { content } = await api.readNotebook(path);
      const parsed = parseNotebookFile(path, content);
      const file = {
        name,
        path,
        type: 'notebook' as const,
        folder: 'notebooks',
      };
      dispatch({ type: 'FILE_ADDED', file });
      dispatch({
        type: 'OPEN_FILE',
        file,
        cells: parsed.cells.length > 0 ? parsed.cells : [makeCell('sql')],
        title: parsed.title || name.replace(/\.dqlnb$/i, ''),
        metadata: parsed.metadata,
      });
    } catch (error) {
      console.warn('Open governed notebook failed:', error);
      openCloudObjectDetail({ objectType: 'notebook', objectKey: path, label: name });
    }
  };

  return (
    <ScrollBody>
      <SummaryRow items={[['Governed', notebooks.length], ['Private', privateCount], ['Shared', sharedCount]]} />
      <SearchInput value={query} onChange={setQuery} placeholder="Search notebooks..." />
      {loading && <div style={{ padding: 14, color: t.textMuted, fontSize: 12 }}>Loading notebooks...</div>}
      <Section title="My private drafts" empty={!loading ? 'No private notebooks visible to you.' : undefined}>
        {privateNotebooks.map((notebook) => <NotebookRow key={notebook.id} notebook={notebook} onOpen={openNotebook} />)}
      </Section>
      <Section title="Shared and published" empty={!loading ? 'No shared notebooks yet.' : undefined}>
        {sharedNotebooks.map((notebook) => <NotebookRow key={notebook.id} notebook={notebook} onOpen={openNotebook} />)}
      </Section>
      <Section title="Local sidecar files" empty="No unsynced local notebooks.">
        {localOnlyMatches.map((file) => (
          <button
            key={file.path}
            onClick={() => void openNotebook(file.path, file.name)}
            style={{ ...rowStyle(t), width: '100%', textAlign: 'left', cursor: 'pointer' }}
          >
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.name}</span>
            <Badge>local</Badge>
          </button>
        ))}
      </Section>
    </ScrollBody>
  );
}

function NotebookRow({ notebook, onOpen }: { notebook: CloudNotebook; onOpen: (path: string, name: string) => Promise<void> }) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const key = notebook.sidecar_path ?? notebook.id;
  return (
    <button
      onClick={() => notebook.sidecar_path ? void onOpen(notebook.sidecar_path, notebook.name) : openCloudObjectDetail({ objectType: 'notebook', objectKey: key, label: notebook.name })}
      style={{ ...rowStyle(t), alignItems: 'flex-start', width: '100%', textAlign: 'left', cursor: 'pointer' }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis' }}>{notebook.name}</div>
        <div style={{ color: t.textMuted, fontSize: 11, marginTop: 2 }}>
          {notebook.visibility ?? 'private'} · {notebook.status ?? 'draft'}
        </div>
        {notebook.description && <div style={{ color: t.textSecondary, fontSize: 11, marginTop: 5, lineHeight: 1.4 }}>{notebook.description}</div>}
      </div>
      <Badge>{notebook.source_kind === 'dql_sidecar' ? 'DQL' : 'Cloud'}</Badge>
    </button>
  );
}

function SemanticMetricRow({ metric }: { metric: SemanticMetric }) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  return (
    <button
      onClick={() => openCloudObjectDetail({ objectType: 'semantic_metric', objectKey: metric.name, label: metric.label || metric.name })}
      style={{ ...rowStyle(t), width: '100%', textAlign: 'left', cursor: 'pointer' }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{metric.label || metric.name}</div>
        <div style={{ color: t.textMuted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' }}>{metric.table}</div>
      </div>
      <Badge>{metric.domain || metric.type || 'metric'}</Badge>
    </button>
  );
}

function SemanticDimensionRow({ dimension }: { dimension: SemanticDimension }) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  return (
    <button
      onClick={() => openCloudObjectDetail({ objectType: 'semantic_dimension', objectKey: dimension.name, label: dimension.label || dimension.name })}
      style={{ ...rowStyle(t), width: '100%', textAlign: 'left', cursor: 'pointer' }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{dimension.label || dimension.name}</div>
        <div style={{ color: t.textMuted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' }}>{dimension.table}</div>
      </div>
      <Badge>{dimension.type}</Badge>
    </button>
  );
}

function ContractsContext({
  cloud,
  contracts,
  loading,
}: {
  cloud: ReturnType<typeof getCloudEmbedConfig>;
  contracts: ContractHit[];
  loading: boolean;
}) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const domain = cloud?.warehouse_context?.business_domain ?? 'Project domain';
  const fallbackSources = useMemo(() => state.schemaTables.slice(0, 8).map((table: SchemaTable) => table.name), [state.schemaTables]);
  return (
    <ScrollBody>
      <Section title="Active contract scope">
        <div style={{ ...rowStyle(t), display: 'block' }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>{domain}</div>
          <div style={{ color: t.textMuted, fontSize: 12, marginTop: 4 }}>
            Certification binds notebook cells to Cloud-managed DataLex contracts before blocks can be published.
          </div>
        </div>
      </Section>
      <Section title="DataLex contracts" empty={loading ? 'Loading contracts...' : 'No DataLex contracts found for this project/domain.'}>
        {contracts.map((contract) => {
          const payload = contract.payload ?? {};
          const sources = Array.isArray(payload.accepted_sources) ? payload.accepted_sources : [];
          const metrics = Array.isArray(payload.metrics) ? payload.metrics : [];
          const dimensions = Array.isArray(payload.dimensions) ? payload.dimensions : [];
          return (
            <button
              key={contract.object_id ?? contract.name}
              onClick={() => openCloudObjectDetail({
                objectType: 'datalex_contract',
                objectKey: contract.object_id ?? contract.name ?? contract.full_name ?? 'contract',
                label: contract.name ?? contract.full_name ?? contract.object_id,
              })}
              style={{ ...rowStyle(t), display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {contract.name ?? contract.full_name ?? contract.object_id}
                </div>
                <Badge>{String(payload.status ?? 'contract')}</Badge>
              </div>
              {contract.description && <div style={{ color: t.textSecondary, fontSize: 11, marginTop: 6, lineHeight: 1.4 }}>{contract.description}</div>}
              <div style={{ color: t.textMuted, fontSize: 11, marginTop: 8 }}>
                {payload.domain ?? domain} · Owner: {payload.owner ?? 'unassigned'}
              </div>
              <MiniList label="Accepted sources" values={sources} />
              <MiniList label="Metrics" values={metrics} />
              <MiniList label="Dimensions" values={dimensions} />
            </button>
          );
        })}
      </Section>
      <Section title="Schema fallback" empty="No schema sources loaded yet.">
        {contracts.length === 0 && fallbackSources.map((name) => (
          <div key={name} style={rowStyle(t)}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
            <Badge>schema</Badge>
          </div>
        ))}
      </Section>
      <Section title="Repo context">
        <div style={{ ...rowStyle(t), display: 'block' }}>
          <div style={{ color: t.textMuted, fontSize: 11 }}>dbt</div>
          <div style={{ overflowWrap: 'anywhere' }}>{cloud?.repo_context?.dbt_subfolder ?? 'configured in Cloud'}</div>
        </div>
        <div style={{ ...rowStyle(t), display: 'block' }}>
          <div style={{ color: t.textMuted, fontSize: 11 }}>DataLex</div>
          <div style={{ overflowWrap: 'anywhere' }}>{cloud?.repo_context?.datalex_subfolder ?? 'configured in Cloud'}</div>
        </div>
      </Section>
    </ScrollBody>
  );
}

function LineageContext({
  cloudEdges,
  sidecar,
  loading,
}: {
  cloudEdges: LineageEdge[];
  sidecar: { nodes: any[]; edges: any[] };
  loading: boolean;
}) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const sidecarEdges = sidecar.edges.slice(0, 20);
  const sidecarNodes = sidecar.nodes.slice(0, 20);
  return (
    <ScrollBody>
      <div style={{ padding: '12px 12px 0', color: t.textMuted, fontSize: 12, lineHeight: 1.5 }}>
        Lineage opens from a specific notebook, block, metric, contract, table, or column so the graph stays focused.
      </div>
      <SummaryRow
        items={[
          ['Column edges', cloudEdges.length],
          ['Graph nodes', sidecar.nodes.length],
          ['Graph edges', sidecar.edges.length],
        ]}
      />
      <Section title="Column lineage" empty={loading ? 'Loading lineage...' : 'No Cloud column lineage edges found.'}>
        {cloudEdges.slice(0, 40).map((edge) => (
          <button
            key={edge.id ?? `${edge.source_model}.${edge.source_column}->${edge.target_model}.${edge.target_column}`}
            onClick={() => openCloudLineage({ objectType: 'dbt_column', objectKey: `${edge.target_model}.${edge.target_column}`, label: `${edge.target_model}.${edge.target_column}` })}
            style={{ ...rowStyle(t), display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer' }}
          >
            <div style={{ fontWeight: 800, overflowWrap: 'anywhere' }}>
              {edge.source_model}.{edge.source_column}
            </div>
            <div style={{ color: t.textMuted, fontSize: 11, margin: '4px 0' }}>to</div>
            <div style={{ fontWeight: 800, overflowWrap: 'anywhere' }}>
              {edge.target_model}.{edge.target_column}
            </div>
            {edge.expression && <div style={{ color: t.textSecondary, fontSize: 11, marginTop: 6, overflowWrap: 'anywhere' }}>{edge.expression}</div>}
          </button>
        ))}
      </Section>
      <Section title="DQL graph edges" empty={loading ? 'Loading graph...' : 'No DQL graph edges found.'}>
        {sidecarEdges.map((edge, index) => (
          <div key={index} style={rowStyle(t)}>
            <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{String(edge.from ?? edge.source ?? edge.sourceId ?? 'source')}</span>
            <Badge>to</Badge>
            <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{String(edge.to ?? edge.target ?? edge.targetId ?? 'target')}</span>
          </div>
        ))}
      </Section>
      <Section title="DQL graph nodes" empty={loading ? 'Loading nodes...' : 'No DQL graph nodes found.'}>
        {sidecarNodes.map((node, index) => (
          <div key={node.id ?? index} style={rowStyle(t)}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{String(node.name ?? node.id ?? 'node')}</span>
            <Badge>{String(node.type ?? node.kind ?? 'node')}</Badge>
          </div>
        ))}
      </Section>
    </ScrollBody>
  );
}

function BlocksContext({ blocks, loading }: { blocks: BlockEntry[]; loading: boolean }) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const filteredBlocks = blocks.filter((block) => {
    const statusMatches = statusFilter === 'all' || block.status === statusFilter;
    const needle = query.trim().toLowerCase();
    const queryMatches = !needle || [
      block.name,
      block.domain,
      block.owner,
      block.status,
      block.path,
      block.description,
      block.llmContext,
      ...(block.tags ?? []),
    ].filter(Boolean).join(' ').toLowerCase().includes(needle);
    return statusMatches && queryMatches;
  });
  const statuses = ['all', ...Array.from(new Set(blocks.map((block) => block.status).filter(Boolean)))];
  return (
    <ScrollBody>
      <SummaryRow items={[['Blocks', blocks.length], ['Certified', blocks.filter((block) => block.status === 'certified').length]]} />
      <SearchInput value={query} onChange={setQuery} placeholder="Search blocks by name, owner, domain, tag..." />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '0 12px 12px' }}>
        {statuses.map((status) => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            style={{
              border: `1px solid ${statusFilter === status ? '#f97316' : t.btnBorder}`,
              background: statusFilter === status ? '#fff7ed' : '#ffffff',
              color: statusFilter === status ? '#c2410c' : t.textSecondary,
              borderRadius: 999,
              padding: '4px 9px',
              fontSize: 11,
              fontWeight: 800,
              cursor: 'pointer',
              textTransform: 'capitalize',
            }}
          >
            {status.replace(/_/g, ' ')}
          </button>
        ))}
      </div>
      {loading && <div style={{ padding: 14, color: t.textMuted, fontSize: 12 }}>Loading blocks…</div>}
      {!loading && blocks.length === 0 && <div style={{ padding: 14, color: t.textMuted, fontSize: 12 }}>No governed blocks found.</div>}
      {!loading && blocks.length > 0 && filteredBlocks.length === 0 && (
        <div style={{ padding: 14, color: t.textMuted, fontSize: 12 }}>No blocks match this search.</div>
      )}
      {!loading && filteredBlocks.map((block) => (
        <button
          key={block.path}
          onClick={() => postDqlCloudEvent('dql.block.open_detail', { name: block.name, path: block.path })}
          style={{ ...rowStyle(t), alignItems: 'flex-start', width: '100%', textAlign: 'left', cursor: 'pointer' }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis' }}>{block.name}</div>
            <div style={{ color: t.textMuted, fontSize: 11, marginTop: 2 }}>{block.domain || 'No domain'} · {block.owner || 'No owner'}</div>
            {block.description && <div style={{ color: t.textSecondary, fontSize: 11, marginTop: 5, lineHeight: 1.4 }}>{block.description}</div>}
          </div>
          <Badge>{block.status}</Badge>
        </button>
      ))}
    </ScrollBody>
  );
}

function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  return (
    <div style={{ padding: '0 12px 12px' }}>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%',
          height: 32,
          border: `1px solid ${t.inputBorder}`,
          borderRadius: 8,
          background: '#ffffff',
          color: t.textPrimary,
          fontFamily: t.font,
          fontSize: 12,
          padding: '0 10px',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
    </div>
  );
}

function MiniList({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ color: '#64748b', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {values.slice(0, 8).map((value) => <Badge key={value}>{value}</Badge>)}
        {values.length > 8 && <Badge>+{values.length - 8}</Badge>}
      </div>
    </div>
  );
}

function SummaryRow({ items }: { items: Array<[string, number]> }) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))`, gap: 8, padding: 12 }}>
      {items.map(([label, value]) => (
        <div key={label} style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, padding: '10px 8px', background: '#f8fafc' }}>
          <div style={{ color: t.textMuted, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>{label}</div>
          <div style={{ color: t.textPrimary, fontSize: 18, fontWeight: 800 }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

function Section({ title, empty, children }: { title: string; empty?: string; children?: React.ReactNode }) {
  const { state } = useNotebook();
  const t = themes[state.themeMode];
  const hasChildren = React.Children.count(children) > 0;
  return (
    <section style={{ borderTop: `1px solid ${t.headerBorder}`, padding: '12px' }}>
      <div style={{ color: t.textMuted, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', marginBottom: 8 }}>{title}</div>
      {hasChildren ? children : empty ? <div style={{ color: t.textMuted, fontSize: 12 }}>{empty}</div> : null}
    </section>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ border: '1px solid #fed7aa', background: '#fff7ed', color: '#c2410c', borderRadius: 999, padding: '2px 7px', fontSize: 10, fontWeight: 800, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

function ScrollBody({ children }: { children: React.ReactNode }) {
  return <div style={{ height: '100%', overflow: 'auto', fontSize: 12 }}>{children}</div>;
}

function rowStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 8,
    background: '#ffffff',
    color: t.textPrimary,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '9px 10px',
    marginBottom: 8,
    fontFamily: t.font,
    fontSize: 12,
  };
}
