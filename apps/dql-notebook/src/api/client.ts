import type { NotebookFile, QueryResult, SchemaTable, SchemaColumn, SemanticLayerState } from '../store/types';

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

  async saveNotebook(path: string, content: string): Promise<void> {
    return request<void>('/api/notebook-content', {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    });
  },

  async executeQuery(sql: string): Promise<QueryResult> {
    const raw = await request<any>('/api/query', {
      method: 'POST',
      body: JSON.stringify({ sql }),
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
      return { available: false, provider: null, metrics: [], dimensions: [], hierarchies: [] };
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

  async describeTable(filePath: string): Promise<SchemaColumn[]> {
    // Build SQL using read_csv_auto for CSV files, or a generic DESCRIBE query
    const safePath = filePath.replace(/'/g, "''");
    const sql = `DESCRIBE SELECT * FROM read_csv_auto('${safePath}') LIMIT 0`;
    try {
      const result = await request<QueryResult>('/api/query', {
        method: 'POST',
        body: JSON.stringify({ sql }),
      });
      // DuckDB DESCRIBE returns rows with column_name and column_type fields
      return result.rows.map((row) => ({
        name: String(row['column_name'] ?? row['Field'] ?? ''),
        type: String(row['column_type'] ?? row['Type'] ?? ''),
      }));
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
};
