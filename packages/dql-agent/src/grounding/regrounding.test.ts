import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetadataCatalog } from '../metadata/catalog.js';
import type { LocalContextPack } from '../metadata/catalog.js';
import { applyGroundingExpansion, expandGroundingFromCatalog } from './regrounding.js';

describe('expandGroundingFromCatalog', () => {
  let dir: string;
  let catalog: MetadataCatalog;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dql-regrounding-'));
    catalog = new MetadataCatalog(join(dir, 'metadata.sqlite'));
    catalog.recordRuntimeSchemaSnapshot({
      source: 'test runtime schema',
      tables: [
        {
          relation: 'dev.order_items',
          schema: 'dev',
          name: 'order_items',
          columns: [
            { name: 'product_id', type: 'VARCHAR' },
            { name: 'product_price', type: 'DECIMAL' },
          ],
        },
        {
          relation: 'dev.supplies',
          schema: 'dev',
          name: 'supplies',
          columns: [
            { name: 'product_id', type: 'VARCHAR' },
            { name: 'supply_name', type: 'VARCHAR' },
            { name: 'supply_cost', type: 'DECIMAL' },
          ],
        },
      ],
    });
  });

  afterEach(() => {
    catalog.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a runtime relation for an unknown relation token', () => {
    const expansion = expandGroundingFromCatalog(catalog, {
      question: 'include product supply details',
      sql: 'SELECT * FROM dev.supplies',
      code: 'unknown_relation',
      offending: { relation: 'dev.supplies' },
    });

    expect(expansion?.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: 'dev.supplies',
          columns: expect.arrayContaining([
            expect.objectContaining({ name: 'supply_name' }),
          ]),
        }),
      ]),
    );
    expect(expansion?.notes).toEqual(expect.arrayContaining([expect.stringContaining('dev.supplies')]));
  });

  it('returns the matching runtime relation for an unknown column token', () => {
    const expansion = expandGroundingFromCatalog(catalog, {
      question: 'include product value',
      sql: 'SELECT product_price FROM dev.order_items',
      code: 'unknown_column',
      offending: { relation: 'dev.order_items', column: 'product_price' },
    });

    expect(expansion?.relations[0]).toMatchObject({
      relation: 'dev.order_items',
      columns: expect.arrayContaining([
        expect.objectContaining({ name: 'product_price' }),
      ]),
    });
  });

  it('keeps merged completeness advisory when neither side is explicitly complete', () => {
    // Both the existing relation and the expansion have unknown completeness with
    // partial column lists. The merge must NOT stamp the result 'complete', or a
    // guessed column list would re-enable strict validation and produce a false
    // unknown_column after an otherwise-successful re-grounding.
    const pack = {
      allowedSqlContext: {
        relations: [
          { relation: 'dev.order_items', name: 'order_items', source: 'inspected', columns: [{ name: 'product_id' }] },
        ],
        sourceBlockSql: [],
      },
    } as unknown as LocalContextPack;

    const merged = applyGroundingExpansion(pack, [], {
      relations: [
        { relation: 'dev.order_items', name: 'order_items', source: 'expanded metadata context', columns: [{ name: 'product_price' }] },
      ],
      notes: ['dev.order_items expanded'],
    });

    const relation = merged.contextPack?.allowedSqlContext.relations.find((r) => r.relation === 'dev.order_items');
    expect(relation?.columnCompleteness).not.toBe('complete');
  });
});
