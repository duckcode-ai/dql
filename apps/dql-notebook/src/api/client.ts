import type {
  NotebookFile,
  QueryResult,
  RunSnapshot,
  SchemaTable,
  SchemaColumn,
  SemanticLayerState,
  SemanticDimension,
  SemanticMetric,
  SemanticHierarchy,
  SemanticTreeNode,
  SemanticObjectDetail,
  BlockStudioCatalog,
  BlockStudioOpenPayload,
  BlockStudioPreview,
  BlockStudioValidation,
} from '../store/types';

const BASE = window.location.origin;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `HTTP ${res.status}`);
  }
  // 204 No Content
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
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

  async createBlock(name: string): Promise<{ path: string; content: string }> {
    return request<{ path: string; content: string }>('/api/blocks', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  },

  async getBlockLibrary(): Promise<{
    blocks: Array<{
      name: string; domain: string; status: string;
      owner: string | null; tags: string[]; path: string;
      lastModified: string; description: string;
    }>;
  }> {
    try {
      return await request('/api/blocks/library');
    } catch {
      return { blocks: [] };
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

  async openBlockStudio(path: string): Promise<BlockStudioOpenPayload> {
    return request<BlockStudioOpenPayload>(`/api/block-studio/open?path=${encodeURIComponent(path)}`);
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
    };
  }): Promise<BlockStudioOpenPayload> {
    return request<BlockStudioOpenPayload>('/api/block-studio/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async saveAsBlock(payload: {
    cellId: string;
    notebookPath?: string | null;
    name: string;
    domain?: string;
    content: string;
    description?: string;
    tags?: string[];
    metricRefs?: string[];
    template?: string;
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
    // Normalize: older server versions return columns as ColumnMeta[] ({name,type,driverType}).
    // Always coerce to string[] so React never tries to render objects as children.
    const columns: string[] = Array.isArray(raw?.columns)
      ? raw.columns.map((c: unknown) =>
          typeof c === 'string' ? c : typeof (c as any)?.name === 'string' ? (c as any).name : String(c)
        )
      : [];
    return {
      columns,
      rows: Array.isArray(raw?.rows) ? raw.rows : [],
      rowCount: raw?.rowCount ?? raw?.rows?.length ?? 0,
      executionTime: raw?.executionTime ?? raw?.executionTimeMs ?? 0,
    };
  },

  async getSchema(): Promise<SchemaTable[]> {
    try {
      return await request<SchemaTable[]>('/api/schema');
    } catch {
      return [];
    }
  },

  async getConnections(): Promise<{ default: string; connections: Record<string, unknown> }> {
    try {
      return await request<{ default: string; connections: Record<string, unknown> }>('/api/connections');
    } catch {
      return { default: 'unknown', connections: {} };
    }
  },

  async saveConnections(connections: Record<string, unknown>): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/connections', {
      method: 'PUT',
      body: JSON.stringify({ connections }),
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
        dimensions: [],
        hierarchies: [],
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
    type?: 'metric' | 'dimension' | 'hierarchy';
  }): Promise<{ metrics: SemanticMetric[]; dimensions: SemanticDimension[]; hierarchies: SemanticHierarchy[] }> {
    const search = new URLSearchParams();
    if (params.query) search.set('q', params.query);
    if (params.domain) search.set('domain', params.domain);
    if (params.tag) search.set('tag', params.tag);
    if (params.type) search.set('type', params.type);
    try {
      return await request<{ metrics: SemanticMetric[]; dimensions: SemanticDimension[]; hierarchies: SemanticHierarchy[] }>(
        `/api/semantic-layer/search?${search.toString()}`,
      );
    } catch {
      return { metrics: [], dimensions: [], hierarchies: [] };
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

  async fetchGitDiff(path?: string): Promise<{ inRepo: boolean; diff: string }> {
    try {
      const qs = path ? `?path=${encodeURIComponent(path)}` : '';
      return await request<any>(`/api/git/diff${qs}`);
    } catch {
      return { inRepo: false, diff: '' };
    }
  },
};
