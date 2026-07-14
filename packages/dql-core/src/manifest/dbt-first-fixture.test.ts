import { describe, expect, it } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from './builder.js';

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/cli/test/fixtures/dbt-first-commerce',
);

describe('dbt-first commerce end-to-end fixture', () => {
  it('compiles dbt provenance, sparse relationship safety, business view, stakeholder app, and analytical lineage', () => {
    const manifest = buildManifest({ projectRoot: fixtureRoot, dbtManifestPath: join(fixtureRoot, 'target/manifest.json') });

    expect(manifest.manifestVersion).toBe(3);
    expect(manifest.dbtImport).toBeUndefined();
    expect(manifest.modeling?.relationships['growth::relationship::acquisition_to_customer'].automaticJoinAllowed).toBe(true);
    expect(manifest.modeling?.relationships['growth::relationship::touch_to_order_attribution']).toMatchObject({
      fanout: 'attribution_required',
      automaticJoinAllowed: false,
    });
    expect(manifest.businessViews['Growth Revenue by Acquisition'].blockRefs).toEqual(['Revenue by Acquisition Channel']);
    expect(manifest.apps?.['growth-revenue']).toMatchObject({
      filePath: 'apps/growth-revenue',
      ownerDomain: 'growth',
      usesDomains: ['growth', 'commerce'],
      purpose: 'growth_attribution',
      requiredExports: ['commerce.customer_identity@1', 'commerce.order_analytics@1'],
    });
    expect(manifest.notebooks['notebooks/revenue-acquisition-research.dqlnb']).toMatchObject({
      ownerDomain: 'growth',
      usesDomains: ['growth', 'commerce'],
      purpose: 'growth_attribution',
      requiredExports: ['commerce.customer_identity@1', 'commerce.order_analytics@1'],
    });
    expect(manifest.dashboards?.['growth-revenue/revenue-by-acquisition'].blockIds).toEqual(['Revenue by Acquisition Channel']);
    expect(manifest.lineage.nodes.some((node) => node.id === 'dql_entity:growth::entity::acquisition')).toBe(true);
    expect(manifest.lineage.edges.some((edge) => edge.type === 'governed_relationship')).toBe(true);

    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain('One row per completed order.');
    expect(serialized).not.toContain('SUM(order_total)');
    expect(serialized).not.toContain('dbt-owned order identifier');
  });
});
