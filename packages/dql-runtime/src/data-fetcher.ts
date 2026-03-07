export class DataFetcher {
  private apiEndpoint: string;

  constructor(apiEndpoint: string = '/api/query') {
    this.apiEndpoint = apiEndpoint;
  }

  async fetch(
    _chartId: string,
    sql: string,
    sqlParams: Array<{ name: string; position: number; literalValue?: unknown }>,
    variables?: Record<string, unknown>,
    connectionId?: string,
  ): Promise<{ columns: Array<{ name: string; type: string }>; rows: Record<string, unknown>[] }> {
    const response = await globalThis.fetch(this.apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, sqlParams, variables, connectionId }),
    });

    if (!response.ok) {
      throw new Error(`Query failed: ${response.statusText}`);
    }

    return response.json();
  }
}
