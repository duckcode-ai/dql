import { describe, it, expect, vi } from 'vitest';
import { boundedPreviewSql, buildPreviewQueryTool } from './preview-tool.js';

const ok = (columns: unknown[], rows: unknown[] = []) =>
  vi.fn(async () => ({ columns, rows, rowCount: rows.length }));

describe('boundedPreviewSql', () => {
  it('wraps rather than appending, so an existing LIMIT or ORDER BY survives', () => {
    // Appending `LIMIT` after an existing LIMIT/ORDER BY/comment yields either a
    // syntax error or a silently different query.
    const wrapped = boundedPreviewSql('SELECT a FROM t ORDER BY a LIMIT 100');
    expect(wrapped).toContain('SELECT * FROM (');
    expect(wrapped).toContain('ORDER BY a LIMIT 100');
    expect(wrapped.trimEnd().endsWith('LIMIT 5')).toBe(true);
  });

  it('strips a trailing semicolon that would break the subselect', () => {
    expect(boundedPreviewSql('SELECT 1;')).not.toContain(';');
  });

  it('clamps the limit so a preview cannot become a full extract', () => {
    expect(boundedPreviewSql('SELECT 1', 9999)).toContain('LIMIT 50');
    expect(boundedPreviewSql('SELECT 1', 0)).toContain('LIMIT 1');
  });
});

describe('preview_query', () => {
  it('returns COLUMN NAMES and never cell values', async () => {
    // The loop needs to know a column exists, not what is in it. Shipping rows
    // would route warehouse data to a provider outside the egress policy that
    // governs narration.
    const execute = ok([{ name: 'product_name' }, { name: 'revenue' }], [['Jaffle', 24]]);
    const result = await buildPreviewQueryTool(execute).run({ sql: 'SELECT product_name, revenue FROM order_items' }) as Record<string, unknown>;
    expect(result).toMatchObject({ executed: true, columns: ['product_name', 'revenue'], rowCount: 1 });
    expect(JSON.stringify(result)).not.toContain('Jaffle');
  });

  it('accepts bare-string columns as well as objects', async () => {
    const result = await buildPreviewQueryTool(ok(['a', 'b'])).run({ sql: 'SELECT a, b FROM t' }) as { columns: string[] };
    expect(result.columns).toEqual(['a', 'b']);
  });

  it('refuses anything that is not a read-only statement', async () => {
    const execute = ok(['a']);
    const tool = buildPreviewQueryTool(execute);
    for (const sql of ['DROP TABLE orders', 'INSERT INTO t VALUES (1)', 'SELECT 1; DROP TABLE t', 'UPDATE t SET a=1']) {
      const result = await tool.run({ sql }) as { error?: string };
      expect(result.error, sql).toMatch(/read-only/i);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an empty request with a message rather than running it', async () => {
    const execute = ok(['a']);
    expect(await buildPreviewQueryTool(execute).run({}) as { error?: string }).toMatchObject({ error: expect.stringMatching(/Pass the SQL/) });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns a warehouse failure as INFORMATION, not a thrown outage', async () => {
    // The message names the column or table the engine rejected — exactly what
    // the loop needs to correct itself. Swallowing it leaves the model guessing.
    const execute = vi.fn(async () => { throw new Error('Binder Error: column "revenu" not found'); });
    const result = await buildPreviewQueryTool(execute).run({ sql: 'SELECT revenu FROM order_items' }) as Record<string, unknown>;
    expect(result).toMatchObject({ executed: false });
    expect(String(result.error)).toContain('revenu');
  });

  it('bounds the SQL it actually sends to the warehouse', async () => {
    const execute = ok(['a']);
    await buildPreviewQueryTool(execute).run({ sql: 'SELECT a FROM huge_table' });
    expect(execute.mock.calls[0]![0]).toContain('LIMIT 5');
  });
});
