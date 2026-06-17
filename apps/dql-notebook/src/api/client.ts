import type { DiffReport } from '@duckcodeailabs/dql-core/format';
import type {
  Cell,
  NotebookFile,
  QueryResult,
  RunSnapshot,
  SchemaTable,
  SchemaColumn,
  SemanticLayerState,
  SemanticDimension,
  SemanticEntity,
  SemanticMeasure,
  SemanticMetric,
  SemanticModel,
  SemanticSavedQuery,
  SemanticHierarchy,
  SemanticTreeNode,
  SemanticObjectDetail,
  BlockStudioCatalog,
  BlockStudioOpenPayload,
  BlockStudioPreview,
  BlockStudioValidation,
  BlockStudioImportSession,
  BlockStudioImportSessionSummary,
  BlockStudioImportCandidate,
  BlockStudioDbtStatus,
  AppSummary,
  ActivePersona,
} from '../store/types';

// ── Apps API types ───────────────────────────────────────────────────────

export interface AppDocumentSummary {
  app: {
    id: string;
    name: string;
    description?: string;
    domain: string;
    subdomain?: string;
    groups?: string[];
    visibility?: 'shared' | 'private' | 'template';
    audience?: string;
    lifecycle?: 'draft' | 'review' | 'certified' | 'deprecated';
    owners: string[];
    tags?: string[];
    notebooks?: Array<{
      path: string;
      title?: string;
      role: 'source' | 'analysis' | 'supporting';
      visibility: 'shared' | 'private' | 'template';
    }>;
    members: Array<{
      userId: string;
      displayName?: string;
      roles: string[];
      attributes?: Record<string, string | number | boolean>;
    }>;
    roles: Array<{ id: string; displayName?: string; description?: string }>;
    policies: Array<{
      id: string;
      domain: string;
      minClassification: 'public' | 'internal' | 'confidential' | 'restricted';
      allowedRoles: string[];
      allowedUsers?: string[];
      accessLevel: 'read' | 'write' | 'execute' | 'admin';
      enabled?: boolean;
    }>;
    rlsBindings?: Array<{ role: string; variable: string; from: string }>;
    schedules?: Array<{
      id: string;
      cron: string;
      dashboard: string;
      deliver: Array<
        | { kind: 'slack'; channel: string }
        | { kind: 'email'; to: string[] }
        | { kind: 'webhook'; url: string }
      >;
      enabled?: boolean;
    }>;
    homepage?: { type: 'dashboard'; id: string } | { type: 'notebook'; path: string };
  };
  dashboards: Array<{ id: string; title: string; description?: string; itemCount: number }>;
  notebooks?: Array<{ path: string; title?: string; role: 'source' | 'analysis' | 'supporting'; visibility: 'shared' | 'private' | 'template' }>;
  drafts?: Array<{ path: string; name: string; reviewStatus?: string }>;
  aiPins?: LocalAiPin[];
  investigations?: LocalAppInvestigation[];
}

export interface DashboardDocumentResponse {
  app: AppDocumentSummary['app'];
  dashboard: {
    version: 1;
    id: string;
    metadata: {
      title: string;
      description?: string;
      domain?: string;
      subdomain?: string;
      groups?: string[];
      audience?: string;
      visibility?: 'shared' | 'private' | 'template';
      lifecycle?: 'draft' | 'review' | 'certified' | 'deprecated';
      tags?: string[];
      businessOutcome?: string;
      businessOwner?: string;
      decisionUse?: string;
      reviewCadence?: string;
      businessRules?: string[];
      caveats?: string[];
    };
    params?: Array<{ id: string; type: string; default?: unknown; description?: string }>;
    filters?: Array<{ id: string; type: string; default?: unknown; options?: string[]; bindsTo?: string }>;
    layout: {
      kind: 'grid';
      cols: number;
      rowHeight: number;
      items: Array<{
        i: string;
        x: number; y: number; w: number; h: number;
        block?: { blockId?: string; ref?: string; version?: string };
        text?: { markdown: string };
        aiPin?: { id: string };
        viz: { type: string; options?: Record<string, unknown> };
        title?: string;
      }>;
    };
  };
}

export interface DashboardRunResponse {
  appId: string;
  dashboardId: string;
  persona: unknown;
  tiles: Array<{
    tileId: string;
    status: 'ok' | 'unauthorized' | 'error' | 'unresolved';
    tileType?: 'block' | 'text' | 'aiPin';
    blockId?: string;
    blockPath?: string;
    certificationStatus?: string | null;
    title?: string;
    viz?: { type: string; options?: Record<string, unknown> };
    chartConfig?: Record<string, unknown>;
    result?: QueryResult;
    text?: { markdown: string };
    aiPin?: LocalAiPin;
    citation?: { kind: string; name: string; path?: string };
    error?: string;
  }>;
}

export interface AppBlockRecommendation {
  id: string;
  name: string;
  domain: string;
  status: string;
  owner: string | null;
  tags: string[];
  path: string;
  lastModified: string;
  description: string;
  llmContext?: string | null;
  chartType?: string;
  score: number;
  reasons: string[];
}

export interface CreateAppRequest {
  name: string;
  domain: string;
  dashboardTitle?: string;
  subdomain?: string;
  groups?: string[];
  purpose?: string;
  audience?: string;
  visibility?: 'shared' | 'private' | 'template';
  lifecycle?: 'draft' | 'review' | 'certified' | 'deprecated';
  tags: string[];
  owners: string[];
  selectedBlockIds: string[];
}

export interface CreateAppResponse {
  ok: true;
  app: AppSummary;
  paths: string[];
  dashboardId: string;
}

export interface GenerateAppRequest {
  prompt: string;
  domain?: string;
  owner?: string;
  force?: boolean;
  selectedBlockIds?: string[];
}

export interface GeneratedAppPlan {
  version: 1;
  appId: string;
  name: string;
  prompt: string;
  skills: Array<{ id: string; title: string; description: string }>;
  domain: string;
  audience: string;
  businessGoal: string;
  owner: string;
  lifecycle: 'draft' | 'review';
  tags: string[];
  pages: Array<{
    id: string;
    title: string;
    description?: string;
    filters: Array<{ id: string; label: string; type: string; default?: unknown; bindsTo?: string }>;
    tiles: Array<{
      id: string;
      title: string;
      kind: 'certified_block' | 'draft_placeholder' | 'narrative';
      description?: string;
      blockId?: string;
      sourceNodeId?: string;
      viz: string;
      certification: 'certified' | 'uncertified';
      reviewStatus: 'certified' | 'draft_ready' | 'review_required';
      display?: {
        role?: string;
        recommendedDisplayType?: string;
        layoutPriority?: number;
        expectedGrain?: string;
        trustState?: string;
        followUpActions?: string[];
        rationale?: string;
      };
      rationale?: string;
      caveats?: string[];
      reviewTasks?: string[];
    }>;
  }>;
  caveats: string[];
  reviewTasks: string[];
}

export interface GenerateAppResponse {
  ok: true;
  plan: GeneratedAppPlan;
  validation: {
    ok: boolean;
    issues: Array<{ level: 'error' | 'warning'; path: string; message: string }>;
    certifiedTiles: number;
    draftTiles: number;
  };
  generated: { paths: string[] };
  app: AppSummary | null;
  dashboardId: string | null;
}

export interface AppEditorCatalogResponse {
  appId: string;
  defaultDomain: string;
  domains: string[];
  blocks: AppBlockRecommendation[];
}

export interface LocalAiPin {
  id: string;
  appId: string;
  dashboardId: string;
  tileId?: string;
  title: string;
  answer: string;
  question?: string;
  sql?: string;
  sourceTier?: string;
  certification: 'certified' | 'ai_generated';
  reviewStatus: 'needs_review' | 'draft_created' | 'certified' | 'rejected';
  refreshCadence: 'none' | 'daily';
  chartConfig?: Record<string, unknown>;
  result?: QueryResult;
  citations?: unknown[];
  analysisPlan?: unknown;
  evidence?: unknown;
  followUps?: string[];
  createdAt: string;
  updatedAt: string;
  lastRefreshedAt?: string;
  lastRefreshError?: string;
  promotedBlockPath?: string;
}

export interface LocalAppInvestigation {
  id: string;
  appId: string;
  dashboardId?: string;
  sourceTileId?: string;
  sourceBlockId?: string;
  title: string;
  question: string;
  intent: 'diagnose_change' | 'driver_breakdown' | 'segment_compare' | 'entity_drilldown' | 'anomaly_investigation' | 'trust_gap_review';
  context?: unknown;
  status: 'draft' | 'running' | 'ready' | 'error';
  summary?: string;
  recommendation?: string;
  metrics?: unknown;
  driverCards?: unknown[];
  resultPreviews?: unknown[];
  evidence?: unknown;
  generatedSql?: string;
  reviewStatus: 'needs_review' | 'draft_created' | 'certified' | 'rejected';
  error?: string;
  pinnedAiPinId?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export interface AppNotebookCandidate {
  path: string;
  title: string;
  attached: boolean;
  role?: 'source' | 'analysis' | 'supporting';
  visibility?: 'shared' | 'private' | 'template';
  lastModified?: string;
}

export interface AppNotebookPreviewCell {
  id: string;
  type: string;
  name?: string;
  content: string;
  upstream?: string;
  chartConfig?: Record<string, unknown>;
  tableConfig?: Record<string, unknown>;
  singleValueConfig?: Record<string, unknown>;
  pivotConfig?: Record<string, unknown>;
  status?: string;
  result?: QueryResult;
  error?: string;
  executionCount?: number;
  executedAt?: string;
}

export interface AppNotebookPreview {
  path: string;
  title: string;
  metadata?: Record<string, unknown>;
  cells: AppNotebookPreviewCell[];
  snapshotFound?: boolean;
  capturedAt?: string;
}

export interface AppConversationMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  events?: unknown[];
  createdAt?: string;
}

export interface AppConversation {
  id: string;
  appId: string;
  dashboardId?: string;
  notebookPath?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage?: string;
  messages?: AppConversationMessage[];
}

export interface SettingsEnvVar {
  key: string;
  label: string;
  present: boolean;
  optional: boolean;
  description: string;
}

export interface SettingsEnvGroup {
  id: string;
  title: string;
  description: string;
  vars: SettingsEnvVar[];
}

export type ProviderSettingsId = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'custom-openai';

export interface ProviderSettings {
  id: ProviderSettingsId;
  label: string;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyPreview?: string;
  baseUrl?: string;
  model?: string;
  source: 'local' | 'env' | 'none';
  envVars: string[];
}

export interface AgentMemory {
  id: string;
  scope: 'thread' | 'notebook' | 'project' | 'user' | 'artifact';
  scopeId?: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  confidence: number;
  importance: number;
  validFrom?: string;
  validTo?: string;
  supersedes?: string;
  lastUsed?: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
}

const BASE = window.location.origin;

function formatRequestError(res: Response, text: string): string {
  const fallback = text.trim() || res.statusText || `HTTP ${res.status}`;
  if (!text.trim()) return fallback;
  try {
    const payload = JSON.parse(text);
    if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error;
    if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message;
  } catch {
    // Keep the original response text when the server did not return JSON.
  }
  return fallback;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(formatRequestError(res, text));
  }
  // 204 No Content
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function normalizeQueryResultPayload(raw: any): QueryResult {
  const columns: string[] = Array.isArray(raw?.columns)
    ? raw.columns.map((c: unknown) =>
        typeof c === 'string' ? c : typeof (c as any)?.name === 'string' ? (c as any).name : String(c)
      )
    : [];
  const semanticRefs = raw?.semanticRefs && typeof raw.semanticRefs === 'object'
    ? {
        metrics: Array.isArray(raw.semanticRefs.metrics) ? raw.semanticRefs.metrics.map(String) : [],
        dimensions: Array.isArray(raw.semanticRefs.dimensions) ? raw.semanticRefs.dimensions.map(String) : [],
      }
    : undefined;
  return {
    columns,
    rows: Array.isArray(raw?.rows) ? raw.rows : [],
    rowCount: raw?.rowCount ?? raw?.rows?.length ?? 0,
    executionTime: raw?.executionTime ?? raw?.executionTimeMs ?? 0,
    ...(semanticRefs ? { semanticRefs } : {}),
  };
}

export interface NotebookCellExecutionResponse {
  cellType: string;
  title?: string;
  blockName?: string;
  blockPath?: string;
  chartConfig?: Record<string, unknown>;
  tests?: Array<{ field: string; operator: string; expected: unknown }>;
  result: QueryResult | null;
}

export const api = {
  async getSettingsEnvStatus(): Promise<{ groups: SettingsEnvGroup[] }> {
    try {
      return await request<{ groups: SettingsEnvGroup[] }>('/api/settings/env-status');
    } catch {
      return { groups: [] };
    }
  },

  async getProviderSettings(): Promise<{ providers: ProviderSettings[] }> {
    try {
      return await request<{ providers: ProviderSettings[] }>('/api/settings/providers');
    } catch {
      return { providers: [] };
    }
  },

  async saveProviderSettings(input: {
    id: ProviderSettingsId;
    enabled?: boolean;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  }): Promise<{ ok: boolean; providers: ProviderSettings[] }> {
    return request('/api/settings/providers', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async testProviderSettings(id: ProviderSettingsId): Promise<{ ok: boolean; message: string }> {
    return request('/api/settings/providers/test', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
  },

  async listAgentMemory(scope?: AgentMemory['scope']): Promise<{ memories: AgentMemory[] }> {
    const suffix = scope ? `?scope=${encodeURIComponent(scope)}` : '';
    try {
      return await request<{ memories: AgentMemory[] }>(`/api/agent/memory${suffix}`);
    } catch {
      return { memories: [] };
    }
  },

  async saveAgentMemory(input: Partial<AgentMemory> & Pick<AgentMemory, 'scope' | 'title' | 'content'>): Promise<{ ok: boolean; memory: AgentMemory }> {
    return request('/api/agent/memory', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async deleteAgentMemory(id: string): Promise<{ ok: boolean }> {
    return request(`/api/agent/memory?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async ensureAgentMemoryFiles(): Promise<{ ok: boolean; files: string[] }> {
    return request('/api/agent/memory/default-files', { method: 'POST' });
  },

  async listNotebooks(): Promise<NotebookFile[]> {
    try {
      return await request<NotebookFile[]>('/api/notebooks');
    } catch {
      // Return empty list gracefully when server is not running
      return [];
    }
  },

  async readNotebook(path: string): Promise<{ content: string }> {
    return request<{ content: string }>(
      `/api/notebook-content?path=${encodeURIComponent(path)}`
    );
  },

  async createNotebook(
    name: string,
    template: string
  ): Promise<{ path: string; content: string }> {
    return request<{ path: string; content: string }>('/api/notebooks', {
      method: 'POST',
      body: JSON.stringify({ name, template }),
    });
  },

  async createBlock(
    name: string,
    options?: {
      blockType?: 'custom' | 'semantic';
      domain?: string;
      description?: string;
      owner?: string;
      tags?: string[];
    },
  ): Promise<{ path: string; content: string }> {
    return request<{ path: string; content: string }>('/api/blocks', {
      method: 'POST',
      body: JSON.stringify({ name, ...options }),
    });
  },

  async getBlockLibrary(): Promise<{
    blocks: Array<{
      name: string; domain: string; status: string;
      owner: string | null; tags: string[]; path: string;
      lastModified: string; description: string;
      llmContext?: string | null;
    }>;
  }> {
    try {
      return await request('/api/blocks/library');
    } catch {
      return { blocks: [] };
    }
  },

  async getApps(): Promise<{
    apps: Array<{
      path: string;
      manifest: {
        name: string;
        domain: string;
        owner?: string;
        description?: string;
        cadence?: string;
        consumers?: string[];
        entryPoints?: string[];
      };
      notebooks: string[];
      dashboards: string[];
      hasDigest: boolean;
    }>;
  }> {
    try {
      return await request('/api/apps');
    } catch {
      return { apps: [] };
    }
  },

  async updateBlockStatus(path: string, newStatus: string): Promise<{ ok: boolean; status?: string; error?: string }> {
    return request('/api/blocks/status', {
      method: 'POST',
      body: JSON.stringify({ path, newStatus }),
    });
  },

  async getBlockHistory(path: string): Promise<{
    entries: Array<{ hash: string; date: string; author: string; message: string }>;
  }> {
    try {
      return await request(`/api/blocks/history?path=${encodeURIComponent(path)}`);
    } catch {
      return { entries: [] };
    }
  },

  async runBlockTests(source: string, path: string | null): Promise<{
    assertions: Array<{ field: string; operator: string; expected: string; passed: boolean; actual?: string }>;
    passed: number;
    failed: number;
    duration: number;
  }> {
    return request('/api/blocks/run-tests', {
      method: 'POST',
      body: JSON.stringify({ source, path }),
    });
  },

  async getBlockStudioCatalog(): Promise<BlockStudioCatalog> {
    return request<BlockStudioCatalog>('/api/block-studio/catalog');
  },

  async getBlockStudioDbtStatus(): Promise<BlockStudioDbtStatus> {
    return request<BlockStudioDbtStatus>('/api/block-studio/dbt-status');
  },

  async openBlockStudio(path: string): Promise<BlockStudioOpenPayload> {
    return request<BlockStudioOpenPayload>(`/api/block-studio/open?path=${encodeURIComponent(path)}`);
  },

  async getBlockBody(path: string): Promise<{ path: string; body: string; commitSha: string | null }> {
    return request<{ path: string; body: string; commitSha: string | null }>(
      `/api/blocks/body?path=${encodeURIComponent(path)}`,
    );
  },

  async validateBlockStudio(source: string, path?: string | null): Promise<BlockStudioValidation> {
    return request<BlockStudioValidation>('/api/block-studio/validate', {
      method: 'POST',
      body: JSON.stringify({ source, path }),
    });
  },

  async runBlockStudio(source: string, path?: string | null): Promise<BlockStudioPreview> {
    return request<BlockStudioPreview>('/api/block-studio/run', {
      method: 'POST',
      body: JSON.stringify({ source, path }),
    });
  },

  async saveBlockStudio(payload: {
    path?: string | null;
    source: string;
    metadata: {
      name: string;
      domain: string;
      description: string;
      owner: string;
      tags: string[];
      sourceKind?: string;
      sourcePath?: string;
      importId?: string;
      candidateId?: string;
      lineage?: string[];
    };
  }): Promise<BlockStudioOpenPayload> {
    return request<BlockStudioOpenPayload>('/api/block-studio/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async previewBlockStudioImport(payload: {
    path: string;
    sourceKind?: 'raw-sql' | BlockStudioImportCandidate['sourceKind'];
    inputMode?: 'path' | 'paste' | 'upload';
    sources?: Array<{ path: string; content: string }>;
    domain?: string;
    owner?: string;
    tags?: string[];
  }): Promise<BlockStudioImportSession> {
    return request<BlockStudioImportSession>('/api/block-studio/import/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async listBlockStudioImports(): Promise<{ sessions: BlockStudioImportSessionSummary[] }> {
    return request<{ sessions: BlockStudioImportSessionSummary[] }>('/api/block-studio/imports');
  },

  async createBlockStudioImport(payload: {
    path?: string;
    sourceKind?: 'raw-sql' | BlockStudioImportCandidate['sourceKind'];
    inputMode?: 'path' | 'paste' | 'upload';
    sources?: Array<{ path: string; content: string }>;
    domain?: string;
    owner?: string;
    tags?: string[];
  }): Promise<BlockStudioImportSession> {
    return request<BlockStudioImportSession>('/api/block-studio/imports', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async getBlockStudioImport(importId: string): Promise<BlockStudioImportSession> {
    return request<BlockStudioImportSession>(`/api/block-studio/imports/${encodeURIComponent(importId)}`);
  },

  async deleteBlockStudioImport(importId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/block-studio/imports/${encodeURIComponent(importId)}`,
      { method: 'DELETE' },
    );
  },

  async clearBlockStudioImports(): Promise<{ ok: boolean; removed: number }> {
    return request<{ ok: boolean; removed: number }>('/api/block-studio/imports', { method: 'DELETE' });
  },

  async updateBlockStudioImportCandidate(
    importId: string,
    candidateId: string,
    patch: Partial<Pick<BlockStudioImportCandidate, 'name' | 'domain' | 'description' | 'owner' | 'tags' | 'sql' | 'reviewStatus'>>,
  ): Promise<BlockStudioImportCandidate> {
    return request<BlockStudioImportCandidate>(
      `/api/block-studio/imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
  },

  async runBlockStudioImportCandidate(importId: string, candidateId: string): Promise<BlockStudioImportCandidate> {
    return request<BlockStudioImportCandidate>(
      `/api/block-studio/imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}/run`,
      { method: 'POST' },
    );
  },

  async saveBlockStudioImportCandidate(importId: string, candidateId: string): Promise<{ candidate: BlockStudioImportCandidate; block: BlockStudioOpenPayload }> {
    return request<{ candidate: BlockStudioImportCandidate; block: BlockStudioOpenPayload }>(
      `/api/block-studio/imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}/save`,
      { method: 'POST' },
    );
  },

  async saveAllBlockStudioImportCandidates(importId: string): Promise<{
    ok: boolean;
    session: BlockStudioImportSession;
    saved: Array<{ candidateId: string; path: string }>;
    errors: Array<{ candidateId: string; error: string }>;
  }> {
    return request(
      `/api/block-studio/imports/${encodeURIComponent(importId)}/save-all`,
      { method: 'POST' },
    );
  },

  async assistBlockStudioImportCandidate(importId: string, candidateId: string, action: string): Promise<BlockStudioImportCandidate> {
    return request<BlockStudioImportCandidate>(
      `/api/block-studio/imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}/ai-assist`,
      { method: 'POST', body: JSON.stringify({ action }) },
    );
  },

  async certifyBlockStudio(payload: { source: string; path?: string | null }): Promise<{
    ok: boolean;
    status?: string;
    certification: {
      certified: boolean;
      errors: Array<{ rule: string; message: string }>;
      warnings: Array<{ rule: string; message: string }>;
    };
    checklist: {
      metadata: boolean;
      validation: boolean;
      run: boolean;
      tests: boolean;
      chart: boolean;
      lineage: boolean;
      aiReviewed: boolean;
      blockers: string[];
      checkedAt?: string;
    };
    blockers?: string[];
  }> {
    const res = await fetch(`${BASE}/api/block-studio/certify`, {
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({ ok: false, error: res.statusText }));
    if (!res.ok && res.status !== 422) {
      throw new Error(JSON.stringify(body));
    }
    return body;
  },

  async saveAsBlock(payload: {
    cellId: string;
    notebookPath?: string | null;
    name: string;
    domain?: string;
    owner?: string;
    content: string;
    description?: string;
    tags?: string[];
    metricRefs?: string[];
    template?: string;
    llmContext?: string;
    examples?: Array<{ question: string; sql?: string }>;
    invariants?: string[];
  }): Promise<{ path: string; content: string }> {
    return request<{ path: string; content: string }>('/api/blocks/save-from-cell', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async getBlockTemplates(): Promise<Array<{ id: string; name: string; description: string; content: string }>> {
    try {
      const response = await request<{ templates: Array<{ id: string; name: string; description: string; content: string }> }>(
        '/api/blocks/templates',
      );
      return response.templates;
    } catch {
      return [];
    }
  },

  async listBlocks(domain?: string): Promise<NotebookFile[]> {
    try {
      const files = await request<NotebookFile[]>('/api/notebooks');
      return files.filter((file) => file.type === 'block' && (!domain || file.path.startsWith(`blocks/${domain}/`)));
    } catch {
      return [];
    }
  },

  async saveNotebook(path: string, content: string): Promise<void> {
    return request<void>('/api/notebook-content', {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    });
  },

  async executeQuery(sql: string, signal?: AbortSignal): Promise<QueryResult> {
    const raw = await request<any>('/api/query', {
      method: 'POST',
      body: JSON.stringify({ sql }),
      signal,
    });
    return normalizeQueryResultPayload(raw);
  },

  async executeNotebookCell(cell: Cell, signal?: AbortSignal): Promise<NotebookCellExecutionResponse> {
    const raw = await request<any>('/api/notebook/execute', {
      method: 'POST',
      body: JSON.stringify({
        cell: {
          id: cell.id,
          type: cell.type,
          source: cell.content,
          title: cell.name,
          config: cell.chartConfig,
        },
      }),
      signal,
    });
    return {
      cellType: String(raw?.cellType ?? cell.type),
      title: typeof raw?.title === 'string' ? raw.title : undefined,
      blockName: typeof raw?.blockName === 'string' ? raw.blockName : undefined,
      blockPath: typeof raw?.blockPath === 'string' ? raw.blockPath : undefined,
      chartConfig: raw?.chartConfig && typeof raw.chartConfig === 'object' ? raw.chartConfig : undefined,
      tests: Array.isArray(raw?.tests) ? raw.tests : undefined,
      result: raw?.result ? normalizeQueryResultPayload(raw.result) : null,
    };
  },

  async getSchema(): Promise<SchemaTable[]> {
    try {
      const res = await fetch(`${BASE}/api/schema`);
      if (res.ok) {
        return (await res.json()) as SchemaTable[];
      }
      // Server returns 500 with { error, fallback } when introspection fails.
      const body = (await res.json().catch(() => null)) as
        | { error?: string; fallback?: SchemaTable[] }
        | null;
      if (body?.error) {
        console.warn(`[dql] schema introspection failed: ${body.error}`);
      }
      return body?.fallback ?? [];
    } catch (err) {
      console.warn('[dql] getSchema request failed', err);
      return [];
    }
  },

  async getConnections(): Promise<{
    default: string;
    connections: Record<string, unknown>;
    dbtProfiles?: Array<{
      id: string;
      profileName: string;
      targetName: string;
      adapter: string;
      path: string;
      connection: Record<string, unknown>;
      missingFields: string[];
      warnings: string[];
    }>;
  }> {
    try {
      return await request<{
        default: string;
        connections: Record<string, unknown>;
        dbtProfiles?: Array<{
          id: string;
          profileName: string;
          targetName: string;
          adapter: string;
          path: string;
          connection: Record<string, unknown>;
          missingFields: string[];
          warnings: string[];
        }>;
      }>('/api/connections');
    } catch {
      return { default: 'unknown', connections: {} };
    }
  },

  async saveConnections(
    connections: Record<string, unknown>,
    defaultConnectionName?: string,
  ): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/connections', {
      method: 'PUT',
      body: JSON.stringify({ connections, defaultConnectionName }),
    });
  },

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      return await request<{ ok: boolean; message: string }>('/api/test-connection', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    } catch (e: any) {
      return { ok: false, message: e.message ?? 'Connection failed' };
    }
  },

  async getSemanticLayer(): Promise<Omit<SemanticLayerState, 'loading'>> {
    try {
      return await request<Omit<SemanticLayerState, 'loading'>>('/api/semantic-layer');
    } catch {
      return {
        available: false,
        provider: null,
        metrics: [],
        measures: [],
        dimensions: [],
        timeDimensions: [],
        entities: [],
        hierarchies: [],
        semanticModels: [],
        savedQueries: [],
        domains: [],
        tags: [],
        favorites: [],
        recentlyUsed: [],
        lastSyncTime: null,
      };
    }
  },

  async getSemanticTree(): Promise<SemanticTreeNode> {
    const result = await request<{ tree: SemanticTreeNode }>('/api/semantic-layer/tree');
    return result.tree;
  },

  async getSemanticObject(id: string): Promise<SemanticObjectDetail> {
    return request<SemanticObjectDetail>(`/api/semantic-layer/object/${encodeURIComponent(id)}`);
  },

  async importSemanticLayer(payload: {
    provider: 'dbt' | 'cubejs' | 'snowflake';
    projectPath?: string;
    repoUrl?: string;
    branch?: string;
    subPath?: string;
    connection?: string;
  }): Promise<any> {
    return request<any>('/api/semantic-layer/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async syncSemanticLayer(): Promise<any> {
    return request<any>('/api/semantic-layer/sync', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  async previewSemanticImport(payload: {
    provider: 'dbt' | 'cubejs' | 'snowflake';
    projectPath?: string;
    repoUrl?: string;
    branch?: string;
    subPath?: string;
    connection?: string;
  }): Promise<{
    provider: string;
    counts: Record<string, number>;
    domains: string[];
    warnings: string[];
    objects: Array<{ kind: string; name: string; label: string; domain: string }>;
  }> {
    return request('/api/semantic-layer/import-preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async previewSyncDiff(): Promise<{
    added: Array<{ kind: string; name: string; label: string; domain: string }>;
    removed: Array<{ kind: string; name: string; label: string; domain: string }>;
    changed: Array<{ kind: string; name: string; label: string; domain: string }>;
    unchanged: number;
  }> {
    return request('/api/semantic-layer/sync-preview', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  async searchSemanticLayer(params: {
    query?: string;
    domain?: string;
    tag?: string;
    type?: 'metric' | 'measure' | 'dimension' | 'time_dimension' | 'entity' | 'hierarchy' | 'semantic_model' | 'saved_query';
  }): Promise<{
    metrics: SemanticMetric[];
    measures: SemanticMeasure[];
    dimensions: SemanticDimension[];
    timeDimensions: SemanticDimension[];
    entities: SemanticEntity[];
    hierarchies: SemanticHierarchy[];
    semanticModels: SemanticModel[];
    savedQueries: SemanticSavedQuery[];
  }> {
    const search = new URLSearchParams();
    if (params.query) search.set('q', params.query);
    if (params.domain) search.set('domain', params.domain);
    if (params.tag) search.set('tag', params.tag);
    if (params.type) search.set('type', params.type);
    try {
      return await request<{
        metrics: SemanticMetric[];
        measures: SemanticMeasure[];
        dimensions: SemanticDimension[];
        timeDimensions: SemanticDimension[];
        entities: SemanticEntity[];
        hierarchies: SemanticHierarchy[];
        semanticModels: SemanticModel[];
        savedQueries: SemanticSavedQuery[];
      }>(
        `/api/semantic-layer/search?${search.toString()}`,
      );
    } catch {
      return { metrics: [], measures: [], dimensions: [], timeDimensions: [], entities: [], hierarchies: [], semanticModels: [], savedQueries: [] };
    }
  },

  async getFavorites(): Promise<string[]> {
    try {
      const result = await request<{ favorites: string[] }>('/api/user-prefs/favorites');
      return result.favorites;
    } catch {
      return [];
    }
  },

  async toggleFavorite(name: string): Promise<string[]> {
    const result = await request<{ favorites: string[] }>('/api/user-prefs/favorites', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    return result.favorites;
  },

  async getRecentlyUsed(): Promise<string[]> {
    try {
      const result = await request<{ recentlyUsed: string[] }>('/api/user-prefs/recent');
      return result.recentlyUsed;
    } catch {
      return [];
    }
  },

  async trackUsage(name: string): Promise<string[]> {
    try {
      const result = await request<{ recentlyUsed: string[] }>('/api/user-prefs/recent', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      return result.recentlyUsed;
    } catch {
      return [];
    }
  },

  async getCompatibleDimensions(metrics: string[]): Promise<SemanticDimension[]> {
    const search = new URLSearchParams();
    if (metrics.length > 0) search.set('metrics', metrics.join(','));
    try {
      const result = await request<{ dimensions: SemanticDimension[] }>(
        `/api/semantic-layer/compatible-dims?${search.toString()}`,
      );
      return result.dimensions;
    } catch {
      return [];
    }
  },

  async composeQuery(
    metrics: string[],
    dimensions: string[],
    timeDimension?: { name: string; granularity: string },
  ): Promise<{ sql: string } | { error: string }> {
    try {
      return await request<{ sql: string }>('/api/semantic-query', {
        method: 'POST',
        body: JSON.stringify({ metrics, dimensions, timeDimension }),
      });
    } catch (e: any) {
      return { error: e.message ?? 'Failed to compose query' };
    }
  },

  async previewSemanticBuilder(payload: {
    metrics: string[];
    dimensions: string[];
    filters?: Array<{ dimension: string; operator: string; values: string[] }>;
    timeDimension?: { name: string; granularity: string };
    orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>;
    limit?: number;
  }): Promise<{ sql: string; joins: string[]; tables: string[]; result: QueryResult } | { error: string }> {
    try {
      return await request<{ sql: string; joins: string[]; tables: string[]; result: QueryResult }>('/api/semantic-builder/preview', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch (e: any) {
      return { error: e.message ?? 'Failed to preview semantic block' };
    }
  },

  async saveSemanticBuilder(payload: {
    name: string;
    domain?: string;
    description?: string;
    owner?: string;
    tags?: string[];
    metrics: string[];
    dimensions: string[];
    filters?: Array<{ dimension: string; operator: string; values: string[] }>;
    timeDimension?: { name: string; granularity: string };
    chart?: string;
    blockType?: 'semantic' | 'custom';
  }): Promise<{ path: string; content: string; companionPath: string }> {
    return request<{ path: string; content: string; companionPath: string }>('/api/semantic-builder/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async createMetric(metric: {
    name: string;
    label: string;
    description: string;
    domain: string;
    sql: string;
    type: string;
    table: string;
    tags?: string[];
  }): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
      return await request<{ ok: boolean; path: string }>('/api/semantic-layer/metric', {
        method: 'POST',
        body: JSON.stringify(metric),
      });
    } catch (e: any) {
      return { ok: false, error: e.message ?? 'Failed to create metric' };
    }
  },

  async describeTable(tablePath: string): Promise<SchemaColumn[]> {
    // Extract schema from qualified path (e.g. "public.orders" → schema=public, table=orders)
    const parts = tablePath.split('.');
    const table = parts.length > 1 ? parts[parts.length - 1] : tablePath;
    const schema = parts.length > 1 ? parts.slice(0, -1).join('.') : '';
    const params = new URLSearchParams({ table });
    if (schema) params.set('schema', schema);
    try {
      return await request<SchemaColumn[]>(`/api/describe-table?${params.toString()}`);
    } catch {
      return [];
    }
  },

  async fetchLineage(): Promise<{ nodes: any[]; edges: any[] }> {
    try {
      return await request<{ nodes: any[]; edges: any[] }>('/api/lineage');
    } catch {
      return { nodes: [], edges: [] };
    }
  },

  async searchLineage(query: string): Promise<{ matches: Array<{ node: any; score: number }> }> {
    try {
      return await request<{ matches: Array<{ node: any; score: number }> }>(
        `/api/lineage/search?q=${encodeURIComponent(query)}`,
      );
    } catch {
      return { matches: [] };
    }
  },

  async queryLineage(params: {
    focus?: string;
    search?: string;
    types?: string[];
    domain?: string;
    upstreamDepth?: number;
    downstreamDepth?: number;
  }): Promise<{ graph: { nodes: any[]; edges: any[] }; focalNode?: any; matches?: Array<{ node: any; score: number }> }> {
    const searchParams = new URLSearchParams();
    if (params.focus) searchParams.set('focus', params.focus);
    if (params.search) searchParams.set('search', params.search);
    if (params.types?.length) searchParams.set('types', params.types.join(','));
    if (params.domain) searchParams.set('domain', params.domain);
    if (params.upstreamDepth !== undefined) searchParams.set('upstreamDepth', String(params.upstreamDepth));
    if (params.downstreamDepth !== undefined) searchParams.set('downstreamDepth', String(params.downstreamDepth));
    try {
      return await request<{ graph: { nodes: any[]; edges: any[] }; focalNode?: any; matches?: Array<{ node: any; score: number }> }>(
        `/api/lineage/query?${searchParams.toString()}`,
      );
    } catch {
      return { graph: { nodes: [], edges: [] }, matches: [] };
    }
  },

  async fetchLineageNode(nodeId: string): Promise<{ node: any; incoming: any[]; outgoing: any[] } | null> {
    try {
      return await request<{ node: any; incoming: any[]; outgoing: any[] }>(
        `/api/lineage/node/${encodeURIComponent(nodeId)}`,
      );
    } catch {
      return null;
    }
  },

  async fetchBlockLineage(blockName: string): Promise<{ node: any; ancestors: any[]; descendants: any[] } | null> {
    try {
      return await request<{ node: any; ancestors: any[]; descendants: any[] }>(
        `/api/lineage/block/${encodeURIComponent(blockName)}`,
      );
    } catch {
      return null;
    }
  },

  async fetchImpactAnalysis(blockName: string): Promise<any> {
    try {
      return await request<any>(`/api/lineage/impact/${encodeURIComponent(blockName)}`);
    } catch {
      return null;
    }
  },

  async fetchLineagePaths(
    nodeId: string,
    options?: { maxDepth?: number; maxPaths?: number },
  ): Promise<{
    focalNode: any;
    upstreamPaths: Array<{ nodes: any[]; edges: any[]; layers: string[] }>;
    downstreamPaths: Array<{ nodes: any[]; edges: any[]; layers: string[] }>;
    layerSummary: Record<string, number>;
  } | null> {
    try {
      const params = new URLSearchParams();
      if (options?.maxDepth) params.set('maxDepth', String(options.maxDepth));
      if (options?.maxPaths) params.set('maxPaths', String(options.maxPaths));
      const qs = params.toString();
      const url = `/api/lineage/paths/${encodeURIComponent(nodeId)}${qs ? `?${qs}` : ''}`;
      return await request<any>(url);
    } catch {
      return null;
    }
  },

  async fetchGitStatus(): Promise<{
    inRepo: boolean;
    branch: string | null;
    ahead: number;
    behind: number;
    changes: Array<{ path: string; status: string }>;
  }> {
    try {
      return await request<any>('/api/git/status');
    } catch {
      return { inRepo: false, branch: null, ahead: 0, behind: 0, changes: [] };
    }
  },

  async fetchGitLog(limit = 20): Promise<{
    inRepo: boolean;
    commits: Array<{ hash: string; author: string; date: string; subject: string }>;
  }> {
    try {
      return await request<any>(`/api/git/log?limit=${limit}`);
    } catch {
      return { inRepo: false, commits: [] };
    }
  },

  async fetchRunSnapshot(path: string): Promise<{ found: boolean; snapshot: RunSnapshot | null }> {
    try {
      return await request<any>(`/api/run-snapshot?path=${encodeURIComponent(path)}`);
    } catch {
      return { found: false, snapshot: null };
    }
  },

  async saveRunSnapshot(path: string, snapshot: RunSnapshot): Promise<void> {
    await request<void>('/api/run-snapshot', {
      method: 'PUT',
      body: JSON.stringify({ path, snapshot }),
    });
  },

  async fetchGitDiff(path?: string, staged?: boolean): Promise<{
    inRepo: boolean;
    diff: string;
    before: string | null;
    after: string | null;
    diffReport: DiffReport | null;
  }> {
    try {
      const params = new URLSearchParams();
      if (path) params.set('path', path);
      if (staged) params.set('staged', 'true');
      const qs = params.toString();
      return await request<any>(`/api/git/diff${qs ? `?${qs}` : ''}`);
    } catch {
      return { inRepo: false, diff: '', before: null, after: null, diffReport: null };
    }
  },

  async fetchGitBranches(): Promise<{ inRepo: boolean; current: string | null; branches: string[] }> {
    try {
      return await request<any>('/api/git/branches');
    } catch {
      return { inRepo: false, current: null, branches: [] };
    }
  },

  async fetchGitRemote(): Promise<{ inRepo: boolean; url: string | null; name: string | null }> {
    try {
      return await request<any>('/api/git/remote');
    } catch {
      return { inRepo: false, url: null, name: null };
    }
  },

  async gitStage(paths: string[]): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request<any>('/api/git/stage', { method: 'POST', body: JSON.stringify({ paths }) });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitUnstage(paths: string[]): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request<any>('/api/git/unstage', { method: 'POST', body: JSON.stringify({ paths }) });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitDiscard(paths: string[]): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request<any>('/api/git/discard', { method: 'POST', body: JSON.stringify({ paths }) });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitCommit(message: string, stageAll = false): Promise<{ ok: boolean; error?: string; hash?: string }> {
    try {
      return await request<any>('/api/git/commit', {
        method: 'POST',
        body: JSON.stringify({ message, stageAll }),
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitPush(): Promise<{ ok: boolean; error?: string; output?: string }> {
    try {
      return await request<any>('/api/git/push', { method: 'POST', body: '{}' });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitPull(): Promise<{ ok: boolean; error?: string; output?: string }> {
    try {
      return await request<any>('/api/git/pull', { method: 'POST', body: '{}' });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitCreateBranch(name: string, checkout = true): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request<any>('/api/git/branch', {
        method: 'POST',
        body: JSON.stringify({ name, checkout }),
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitCheckout(name: string): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request<any>('/api/git/checkout', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  // ── Apps & Dashboards ───────────────────────────────────────────────────

  async listApps(): Promise<AppSummary[]> {
    try {
      const { apps } = await request<{ apps: AppSummary[] }>('/api/apps');
      return apps;
    } catch {
      return [];
    }
  },

  async recommendAppBlocks(input: {
    domain?: string;
    tags?: string[];
    purpose?: string;
    audience?: string;
    certifiedOnly?: boolean;
  }): Promise<AppBlockRecommendation[]> {
    try {
      const { blocks } = await request<{ blocks: AppBlockRecommendation[] }>('/api/apps/recommend-blocks', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      return blocks;
    } catch {
      return [];
    }
  },

  async createApp(input: CreateAppRequest): Promise<CreateAppResponse> {
    return request<CreateAppResponse>('/api/apps', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async generateApp(input: GenerateAppRequest): Promise<GenerateAppResponse | { ok: false; error: string }> {
    try {
      return await request<GenerateAppResponse>('/api/apps/generate', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async getApp(id: string): Promise<AppDocumentSummary | null> {
    try {
      return await request<AppDocumentSummary>(`/api/apps/${encodeURIComponent(id)}`);
    } catch {
      return null;
    }
  },

  async attachAppNotebook(appId: string, input: {
    path: string;
    title?: string;
    role?: 'source' | 'analysis' | 'supporting';
    visibility?: 'shared' | 'private' | 'template';
  }): Promise<AppDocumentSummary | { ok: false; error: string }> {
    try {
      return await request<AppDocumentSummary>(
        `/api/apps/${encodeURIComponent(appId)}/notebooks`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async listAppNotebookCandidates(appId: string): Promise<AppNotebookCandidate[]> {
    try {
      const { notebooks } = await request<{ notebooks: AppNotebookCandidate[] }>(
        `/api/apps/${encodeURIComponent(appId)}/notebook-candidates`,
      );
      return notebooks;
    } catch {
      return [];
    }
  },

  async createAppNotebook(appId: string, input: {
    name: string;
    title?: string;
    role?: 'source' | 'analysis' | 'supporting';
    visibility?: 'shared' | 'private' | 'template';
    template?: string;
  }): Promise<{ ok: true; path: string; app: AppDocumentSummary; preview?: AppNotebookPreview } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/notebooks/create`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async previewAppNotebook(appId: string, path: string): Promise<AppNotebookPreview | null> {
    try {
      return await request<AppNotebookPreview>(
        `/api/apps/${encodeURIComponent(appId)}/notebooks/preview?path=${encodeURIComponent(path)}`,
      );
    } catch {
      return null;
    }
  },

  async runAppNotebook(appId: string, path: string): Promise<{ ok: true; preview: AppNotebookPreview } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/notebooks/run`,
        { method: 'POST', body: JSON.stringify({ path }) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async listAppConversations(appId: string): Promise<AppConversation[]> {
    try {
      const { conversations } = await request<{ conversations: AppConversation[] }>(
        `/api/apps/${encodeURIComponent(appId)}/conversations`,
      );
      return conversations;
    } catch {
      return [];
    }
  },

  async createAppConversation(appId: string, input: {
    title?: string;
    dashboardId?: string;
    notebookPath?: string;
    messages?: AppConversationMessage[];
  }): Promise<{ ok: true; conversation: AppConversation } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/conversations`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async getAppConversation(appId: string, conversationId: string): Promise<AppConversation | null> {
    try {
      const { conversation } = await request<{ conversation: AppConversation }>(
        `/api/apps/${encodeURIComponent(appId)}/conversations/${encodeURIComponent(conversationId)}`,
      );
      return conversation;
    } catch {
      return null;
    }
  },

  async updateAppConversation(appId: string, conversationId: string, input: {
    title?: string;
    dashboardId?: string;
    notebookPath?: string;
    messages?: AppConversationMessage[];
  }): Promise<{ ok: true; conversation: AppConversation } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/conversations/${encodeURIComponent(conversationId)}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async deleteAppConversation(appId: string, conversationId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/conversations/${encodeURIComponent(conversationId)}`,
        { method: 'DELETE' },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async listAppInvestigations(appId: string, dashboardId?: string): Promise<LocalAppInvestigation[]> {
    try {
      const search = new URLSearchParams();
      if (dashboardId) search.set('dashboardId', dashboardId);
      const qs = search.toString();
      const { investigations } = await request<{ investigations: LocalAppInvestigation[] }>(
        `/api/apps/${encodeURIComponent(appId)}/investigations${qs ? `?${qs}` : ''}`,
      );
      return investigations;
    } catch {
      return [];
    }
  },

  async createAppInvestigation(appId: string, input: {
    dashboardId?: string;
    sourceTileId?: string;
    sourceBlockId?: string;
    title?: string;
    question: string;
    intent?: LocalAppInvestigation['intent'];
    context?: unknown;
    generatedSql?: string;
    run?: boolean;
  }): Promise<{ ok: true; investigation: LocalAppInvestigation } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/investigations`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async getAppInvestigation(appId: string, investigationId: string): Promise<LocalAppInvestigation | null> {
    try {
      const { investigation } = await request<{ investigation: LocalAppInvestigation }>(
        `/api/apps/${encodeURIComponent(appId)}/investigations/${encodeURIComponent(investigationId)}`,
      );
      return investigation;
    } catch {
      return null;
    }
  },

  async runAppInvestigation(appId: string, investigationId: string, input?: {
    question?: string;
    intent?: LocalAppInvestigation['intent'];
    context?: unknown;
    generatedSql?: string;
  }): Promise<{ ok: true; investigation: LocalAppInvestigation } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/investigations/${encodeURIComponent(investigationId)}/run`,
        { method: 'POST', body: JSON.stringify(input ?? {}) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async pinAppInvestigation(appId: string, investigationId: string, input?: {
    dashboardId?: string;
    title?: string;
    refreshCadence?: 'none' | 'daily';
  }): Promise<{ ok: true; investigation: LocalAppInvestigation; pin: LocalAiPin; dashboard?: DashboardDocumentResponse['dashboard']; tile?: DashboardDocumentResponse['dashboard']['layout']['items'][number] } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/investigations/${encodeURIComponent(investigationId)}/pin`,
        { method: 'POST', body: JSON.stringify(input ?? {}) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async getDashboard(appId: string, dashboardId: string): Promise<DashboardDocumentResponse | null> {
    try {
      return await request<DashboardDocumentResponse>(
        `/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}`,
      );
    } catch {
      return null;
    }
  },

  async getAppEditorCatalog(appId: string, params?: { domain?: string; certifiedOnly?: boolean }): Promise<AppEditorCatalogResponse | null> {
    try {
      const search = new URLSearchParams();
      if (params?.domain) search.set('domain', params.domain);
      if (params?.certifiedOnly === false) search.set('certifiedOnly', 'false');
      const qs = search.toString();
      return await request<AppEditorCatalogResponse>(
        `/api/apps/${encodeURIComponent(appId)}/editor/catalog${qs ? `?${qs}` : ''}`,
      );
    } catch {
      return null;
    }
  },

  async createAppDashboard(appId: string, input: { id?: string; title: string; description?: string }): Promise<{ ok: true; dashboard: DashboardDocumentResponse['dashboard']; path: string } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/dashboards`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async patchDashboardLayout(
    appId: string,
    dashboardId: string,
    layout: DashboardDocumentResponse['dashboard']['layout'],
  ): Promise<{ ok: true; dashboard: DashboardDocumentResponse['dashboard']; path: string } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}/layout`,
        { method: 'PATCH', body: JSON.stringify({ layout }) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

 async createAiPin(appId: string, input: {
    dashboardId: string;
    title: string;
    answer: string;
    question?: string;
    sql?: string;
    sourceTier?: string;
    certification?: 'certified' | 'ai_generated';
    refreshCadence?: 'none' | 'daily';
    chartConfig?: Record<string, unknown>;
    result?: QueryResult;
    citations?: unknown[];
    analysisPlan?: unknown;
    evidence?: unknown;
    followUps?: string[];
  }): Promise<{ ok: true; pin: LocalAiPin; dashboard?: DashboardDocumentResponse['dashboard']; tile?: DashboardDocumentResponse['dashboard']['layout']['items'][number] } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/ai-pins`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async listAiPins(appId: string, dashboardId?: string): Promise<LocalAiPin[]> {
    try {
      const search = new URLSearchParams();
      if (dashboardId) search.set('dashboardId', dashboardId);
      const qs = search.toString();
      const { pins } = await request<{ pins: LocalAiPin[] }>(
        `/api/apps/${encodeURIComponent(appId)}/ai-pins${qs ? `?${qs}` : ''}`,
      );
      return pins;
    } catch {
      return [];
    }
  },

  async refreshAiPin(appId: string, pinId: string): Promise<{ ok: boolean; pin?: LocalAiPin; error?: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/ai-pins/${encodeURIComponent(pinId)}/refresh`,
        { method: 'POST' },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async promoteAiPin(appId: string, pinId: string): Promise<{ ok: boolean; pin?: LocalAiPin; blockPath?: string; error?: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/ai-pins/${encodeURIComponent(pinId)}/promote`,
        { method: 'POST' },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async fetchScopedLineage(params: { domain?: string; appId?: string; dashboardId?: string; blockId?: string }): Promise<any | null> {
    try {
      const search = new URLSearchParams();
      if (params.domain) search.set('domain', params.domain);
      if (params.appId) search.set('appId', params.appId);
      if (params.dashboardId) search.set('dashboardId', params.dashboardId);
      if (params.blockId) search.set('blockId', params.blockId);
      return await request<any>(`/api/lineage/scope?${search.toString()}`);
    } catch {
      return null;
    }
  },

  async runDashboard(appId: string, dashboardId: string, variables?: Record<string, unknown>): Promise<DashboardRunResponse | null> {
    try {
      return await request<DashboardRunResponse>(
        `/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}/run`,
        { method: 'POST', body: JSON.stringify({ variables: variables ?? {} }) },
      );
    } catch {
      return null;
    }
  },

  async saveDashboard(
    appId: string,
    dashboardId: string,
    body: DashboardDocumentResponse['dashboard'],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const result = await request<{ ok: true; path: string }>(
        `/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}`,
        { method: 'PUT', body: JSON.stringify(body) },
      );
      return { ok: !!result.ok };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  // ── Persona ─────────────────────────────────────────────────────────────

  async getPersona(): Promise<ActivePersona | null> {
    try {
      const { persona } = await request<{ persona: ActivePersona | null }>('/api/persona');
      return persona;
    } catch {
      return null;
    }
  },

  async setPersona(userId: string, appId?: string): Promise<ActivePersona | null> {
    try {
      const { persona } = await request<{ persona: ActivePersona | null }>('/api/persona', {
        method: 'POST',
        body: JSON.stringify({ userId, appId }),
      });
      return persona;
    } catch {
      return null;
    }
  },

  async clearPersona(): Promise<void> {
    try {
      await request('/api/persona', { method: 'DELETE' });
    } catch {
      // best-effort; UI restores owner default on next refresh
    }
  },
};
