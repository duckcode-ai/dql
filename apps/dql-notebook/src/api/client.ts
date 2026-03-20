import type { NotebookFile, QueryResult, SchemaTable, SchemaColumn } from '../store/types';

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
      `/api/notebooks/read?path=${encodeURIComponent(path)}`
    );
  },

  async createNotebook(
    name: string,
    template: string
  ): Promise<{ path: string; content: string }> {
    return request<{ path: string; content: string }>('/api/notebooks/create', {
      method: 'POST',
      body: JSON.stringify({ name, template }),
    });
  },

  async saveNotebook(path: string, content: string): Promise<void> {
    return request<void>('/api/notebooks/save', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    });
  },

  async executeQuery(sql: string): Promise<QueryResult> {
    return request<QueryResult>('/api/query', {
      method: 'POST',
      body: JSON.stringify({ sql }),
    });
  },

  async getSchema(): Promise<SchemaTable[]> {
    try {
      return await request<SchemaTable[]>('/api/schema');
    } catch {
      return [];
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
};
