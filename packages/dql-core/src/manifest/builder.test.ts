import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, collectInputFiles, resolveDataLexManifestPath } from './builder.js';

describe('collectInputFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dql-inputs-'));
    writeFileSync(join(tmpDir, 'dql.config.json'), '{"project":"demo"}');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns config + blocks + notebooks + semantic YAML + dbt manifest, sorted', () => {
    mkdirSync(join(tmpDir, 'blocks'), { recursive: true });
    mkdirSync(join(tmpDir, 'notebooks'), { recursive: true });
    mkdirSync(join(tmpDir, 'semantic-layer', 'metrics'), { recursive: true });
    mkdirSync(join(tmpDir, 'target'), { recursive: true });

    writeFileSync(join(tmpDir, 'blocks', 'a.dql'), 'block a {}');
    writeFileSync(join(tmpDir, 'notebooks', 'x.dqlnb'), '{"version":1,"cells":[]}');
    writeFileSync(join(tmpDir, 'semantic-layer', 'metrics', 'revenue.yaml'), 'name: revenue');
    writeFileSync(join(tmpDir, 'target', 'manifest.json'), '{}');

    const files = collectInputFiles({
      projectRoot: tmpDir,
      dbtManifestPath: join(tmpDir, 'target', 'manifest.json'),
    });

    // All expected files appear
    expect(files).toContain(join(tmpDir, 'dql.config.json'));
    expect(files).toContain(join(tmpDir, 'blocks', 'a.dql'));
    expect(files).toContain(join(tmpDir, 'notebooks', 'x.dqlnb'));
    expect(files).toContain(join(tmpDir, 'semantic-layer', 'metrics', 'revenue.yaml'));
    expect(files).toContain(join(tmpDir, 'target', 'manifest.json'));

    // Sorted
    expect(files).toEqual([...files].sort());
  });

  it('tracks configured DataLex manifest files', () => {
    const manifestPath = join(tmpDir, 'datalex-manifest.json');
    writeFileSync(manifestPath, JSON.stringify({
      manifestSpecVersion: '1.0.0',
      datalexVersion: '1.10.0',
      generatedAt: '2026-06-01T00:00:00Z',
      project: { name: 'demo' },
      domains: [],
    }));
    writeFileSync(join(tmpDir, 'dql.config.json'), JSON.stringify({
      project: 'demo',
      datalex: { manifestPath: 'datalex-manifest.json' },
    }));

    expect(resolveDataLexManifestPath(tmpDir)).toBe(manifestPath);
    expect(collectInputFiles({ projectRoot: tmpDir })).toContain(manifestPath);
  });

  it('omits missing paths without erroring', () => {
    const files = collectInputFiles({ projectRoot: tmpDir });
    // Only the config was created; no blocks/notebooks dirs
    expect(files).toEqual([join(tmpDir, 'dql.config.json')]);
  });
});

describe('buildManifest DataLex contract validation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dql-datalex-'));
    mkdirSync(join(tmpDir, 'blocks'), { recursive: true });
    writeFileSync(join(tmpDir, 'dql.config.json'), JSON.stringify({
      project: 'demo',
      datalex: { manifestPath: 'datalex-manifest.json' },
    }));
    writeFileSync(join(tmpDir, 'datalex-manifest.json'), JSON.stringify({
      manifestSpecVersion: '1.0.0',
      datalexVersion: '1.10.0',
      generatedAt: '2026-06-01T00:00:00Z',
      project: { name: 'demo' },
      domains: [{
        name: 'commerce',
        entities: [{
          name: 'Customer',
          contracts: [{
            id: 'commerce.Customer.monthly_active_customers',
            name: 'monthly_active_customers',
            version: 1,
          }],
        }],
      }],
    }));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes certified blocks with known DataLex contracts', () => {
    writeFileSync(join(tmpDir, 'blocks', 'mac.dql'), `
      block "Monthly Active Customers" {
        domain = "commerce"
        type = "custom"
        status = "certified"
        datalex_contract = "commerce.Customer.monthly_active_customers@1"
        query = """SELECT 1"""
      }
    `);

    const manifest = buildManifest({ projectRoot: tmpDir });
    expect((manifest.diagnostics ?? []).filter((d) => d.message.includes('datalex_contract'))).toEqual([]);
  });

  it('emits an error for certified blocks with missing DataLex contracts', () => {
    writeFileSync(join(tmpDir, 'blocks', 'bad.dql'), `
      block "Bad Contract" {
        domain = "commerce"
        type = "custom"
        status = "certified"
        datalex_contract = "commerce.Customer.does_not_exist@1"
        query = """SELECT 1"""
      }
    `);

    const manifest = buildManifest({ projectRoot: tmpDir });
    expect((manifest.diagnostics ?? []).some((d) =>
      d.severity === 'error' && d.message.includes('not found'),
    )).toBe(true);
  });
});

describe('buildManifest dbt import filters', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dql-filters-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Build a dbt manifest with models a→b→c plus unrelated d. */
  function writeDbtFixture(): string {
    const target = join(tmpDir, 'target');
    mkdirSync(target, { recursive: true });
    const manifest = {
      nodes: {
        'model.demo.a': {
          resource_type: 'model',
          name: 'a',
          alias: 'a',
          schema: 'public',
          database: 'db',
          depends_on: { nodes: ['model.demo.b'] },
          tags: ['core'],
          original_file_path: 'models/marts/a.sql',
          config: { materialized: 'table' },
        },
        'model.demo.b': {
          resource_type: 'model',
          name: 'b',
          alias: 'b',
          schema: 'public',
          database: 'db',
          depends_on: { nodes: ['model.demo.c'] },
          tags: ['staging'],
          original_file_path: 'models/staging/b.sql',
        },
        'model.demo.c': {
          resource_type: 'model',
          name: 'c',
          alias: 'c',
          schema: 'raw',
          database: 'db',
          depends_on: { nodes: [] },
          tags: [],
          original_file_path: 'models/staging/c.sql',
        },
        'model.demo.d': {
          resource_type: 'model',
          name: 'd',
          alias: 'd',
          schema: 'public',
          database: 'db',
          depends_on: { nodes: [] },
          tags: ['unrelated'],
          original_file_path: 'models/misc/d.sql',
        },
      },
      sources: {},
      metadata: { project_name: 'demo' },
    };
    const path = join(target, 'manifest.json');
    writeFileSync(path, JSON.stringify(manifest), 'utf-8');
    return path;
  }

  function writeProject(): void {
    writeFileSync(join(tmpDir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
  }

  it('anchors drive an upstream BFS when DQL references none of the models', () => {
    writeProject();
    const dbtManifestPath = writeDbtFixture();

    const manifest = buildManifest({
      projectRoot: tmpDir,
      dbtManifestPath,
      dbtImportFilters: { anchors: ['a'] },
    });

    const names = (manifest.dbtImport?.dbtDag?.models ?? []).map((m) => m.name).sort();
    // Anchor a + its upstream b, c. d is unrelated and excluded.
    expect(names).toEqual(['a', 'b', 'c']);
  });

  it('tag: anchors expand to all models carrying that tag', () => {
    writeProject();
    const dbtManifestPath = writeDbtFixture();

    const manifest = buildManifest({
      projectRoot: tmpDir,
      dbtManifestPath,
      dbtImportFilters: { anchors: ['tag:core'] },
    });

    const names = (manifest.dbtImport?.dbtDag?.models ?? []).map((m) => m.name).sort();
    // "core"-tagged a anchors the BFS; b and c come along upstream.
    expect(names).toEqual(['a', 'b', 'c']);
  });

  it('exclude removes matching non-anchor nodes from the selection', () => {
    writeProject();
    const dbtManifestPath = writeDbtFixture();

    const manifest = buildManifest({
      projectRoot: tmpDir,
      dbtManifestPath,
      dbtImportFilters: {
        anchors: ['a'],
        exclude: ['path:models/staging/'],
      },
    });

    const names = (manifest.dbtImport?.dbtDag?.models ?? []).map((m) => m.name).sort();
    // Anchor a preserved; b and c in staging/ are removed.
    expect(names).toEqual(['a']);
  });

  it('include narrows to matching nodes, keeping anchors', () => {
    writeProject();
    const dbtManifestPath = writeDbtFixture();

    const manifest = buildManifest({
      projectRoot: tmpDir,
      dbtManifestPath,
      dbtImportFilters: {
        anchors: ['a'],
        include: ['tag:core'],
      },
    });

    const names = (manifest.dbtImport?.dbtDag?.models ?? []).map((m) => m.name).sort();
    // Only 'a' carries tag:core. BFS brought in b,c but include filter drops them.
    expect(names).toEqual(['a']);
  });

  it('reads dbtImport filters from dql.config.json when options omit them', () => {
    writeFileSync(
      join(tmpDir, 'dql.config.json'),
      JSON.stringify({
        project: 'demo',
        dbtImport: { anchors: ['a'], exclude: ['path:models/staging/'] },
      }),
    );
    const dbtManifestPath = writeDbtFixture();

    const manifest = buildManifest({ projectRoot: tmpDir, dbtManifestPath });
    const names = (manifest.dbtImport?.dbtDag?.models ?? []).map((m) => m.name).sort();
    expect(names).toEqual(['a']);
  });
});
