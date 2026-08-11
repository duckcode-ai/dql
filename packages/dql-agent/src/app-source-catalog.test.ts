import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureAgentProjectReady,
  MetadataCatalog,
  queryAppSourceCatalog,
  resolveAppSourceCatalogRecords,
} from './index.js';

describe('AppSourceCatalogService', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-source-catalog-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ name: 'app-source-test' }));
    mkdirSync(join(projectRoot, 'domains', 'sales', 'blocks'), { recursive: true });
    mkdirSync(join(projectRoot, 'domains', 'customer', 'blocks'), { recursive: true });
    writeFileSync(join(projectRoot, 'domains', 'sales', 'blocks', 'performance.dql'), `block "Performance" {
  domain = "sales"
  status = "certified"
  description = "Revenue trend by order date and region"
  dimensions = ["order_date", "region"]
  allowedFilters = ["order_date", "region"]
  query = """SELECT order_date, region, SUM(revenue) AS revenue FROM orders GROUP BY 1, 2"""
}`);
    writeFileSync(join(projectRoot, 'domains', 'customer', 'blocks', 'performance.dql'), `block "Performance" {
  domain = "customer"
  status = "draft"
  description = "New customer growth by week and segment"
  dimensions = ["week", "customer_segment"]
  allowedFilters = ["week", "customer_segment"]
  query = """SELECT week, customer_segment, COUNT(*) AS customers FROM customers GROUP BY 1, 2"""
}`);
  });

  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('PRD-007 API-014 keeps duplicate names and discovers drafts without making them governed', async () => {
    await ensureAgentProjectReady(projectRoot);
    const governed = queryAppSourceCatalog(projectRoot, { limit: 1, sourcePolicy: 'governed_only' });

    expect(governed.total).toBe(2);
    expect(governed.items).toHaveLength(1);
    expect(governed.nextCursor).toBeTruthy();
    expect(governed.facets.lifecycles).toMatchObject({ certified: 1, draft: 1 });

    const second = queryAppSourceCatalog(projectRoot, {
      limit: 1,
      cursor: governed.nextCursor,
      sourcePolicy: 'governed_only',
    });
    const all = [...governed.items, ...second.items];
    expect(new Set(all.map((source) => source.sourceId)).size).toBe(2);
    expect(new Set(all.map((source) => source.sourcePath)).size).toBe(2);
    const draft = all.find((source) => source.lifecycle === 'draft');
    expect(draft).toMatchObject({
      trust: 'review_required',
      eligibility: { discoverable: true, localPreview: false, projectPublish: false },
    });

    const reviewLane = queryAppSourceCatalog(projectRoot, {
      query: 'new customer growth',
      sourcePolicy: 'include_review_required',
    });
    expect(reviewLane.items[0]).toMatchObject({ lifecycle: 'draft', eligibility: { localPreview: true, projectPublish: false } });

    const resolved = resolveAppSourceCatalogRecords(projectRoot, all.map((source) => source.sourceId), 'include_review_required');
    expect(resolved.missingSourceIds).toEqual([]);
    expect(resolved.items).toHaveLength(2);

    expect(() => queryAppSourceCatalog(projectRoot, {
      limit: 1,
      cursor: governed.nextCursor,
      sourcePolicy: 'include_review_required',
    })).toThrow(/catalog changed/i);
  });

  it('PERF-003 pages and exact-searches a 4,000-source warm index within response budgets', () => {
    const catalog = new MetadataCatalog(join(projectRoot, '.dql', 'cache', 'app-scale.sqlite'));
    try {
      const objects = Array.from({ length: 4_000 }, (_, index) => ({
        objectKey: `app:block:sales:${String(index).padStart(4, '0')}`,
        objectType: 'dql_block_source',
        name: `Sales source ${index}`,
        fullName: `sales::block::Sales source ${index}`,
        domain: index % 2 ? 'sales' : 'customer',
        owner: 'analytics',
        status: index % 3 ? 'draft' : 'certified',
        description: index === 3_999 ? 'late-position executive renewal signal' : `bounded App source ${index}`,
        sourcePath: `blocks/scale/source-${index}.dql`,
        payload: { tags: ['scale'], allowedFilters: ['order_date'], dimensions: ['region'] },
      }));
      catalog.rebuild({
        projectRoot,
        manifest: { generatedAt: '2026-08-10T00:00:00.000Z' } as never,
        objects,
        edges: [], diagnostics: [], compileConflicts: [],
        fingerprint: 'scale-4000', generatedAt: '2026-08-10T00:00:00.000Z',
      });

      const started = performance.now();
      const page = catalog.queryObjectsPage({
        query: 'late-position executive renewal signal',
        objectTypes: ['dql_block_source'],
        limit: 50,
      });
      const elapsed = performance.now() - started;
      expect(page.total).toBe(1);
      expect(page.items[0]?.objectKey).toBe('app:block:sales:3999');
      expect(page.items).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(500_000);
      expect(elapsed).toBeLessThan(500);
      const exactStarted = performance.now();
      const exact = catalog.getObjectsByKeys(['app:block:sales:3999']);
      const exactElapsed = performance.now() - exactStarted;
      expect(exact[0]?.sourcePath).toBe('blocks/scale/source-3999.dql');
      expect(exactElapsed).toBeLessThan(100);
    } finally {
      catalog.close();
    }
  });
});
