import { describe, expect, it, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetadataCatalog } from './catalog.js';
import type { MetadataObject, MetadataEdge } from './catalog.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
function tmpDb(name: string): string { const d = mkdtempSync(join(tmpdir(), 'inc-')); dirs.push(d); return join(d, name); }

function obj(key: string, source: string, payload: Record<string, unknown>): MetadataObject {
  return { objectKey: key, objectType: 'dbt_model', name: key, domain: 'sales', status: 'dbt_catalog', sourcePath: source, payload } as MetadataObject;
}
function snapshot(objects: MetadataObject[], edges: MetadataEdge[], fingerprint: string) {
  return {
    projectRoot: '/p',
    manifest: { generatedAt: '2026-07-01T00:00:00Z' } as never,
    objects, edges, diagnostics: [], compileConflicts: [], fingerprint,
    generatedAt: '2026-07-01T00:00:00Z',
  };
}

// Semantic content of the catalog, EXCLUDING timestamps (which legitimately differ
// between an incremental update and a from-scratch rebuild of untouched rows).
function objectSignature(catalog: MetadataCatalog): string {
  const rows = catalog.listObjects({ limit: 1000 })
    .map((o) => ({ k: o.objectKey, t: o.objectType, n: o.name, d: o.domain, s: o.status, p: o.payload }))
    .sort((a, b) => a.k.localeCompare(b.k));
  return JSON.stringify(rows);
}
function edgeSignature(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  const rows = (db.prepare('SELECT edge_type, from_key, to_key FROM metadata_edges ORDER BY edge_type, from_key, to_key').all());
  db.close();
  return JSON.stringify(rows);
}

describe('incremental reindex equals a full rebuild (W3.4)', () => {
  it('produces identical objects + edges after add/change/remove of sources', () => {
    const a = snapshot(
      [obj('o1', 's1.yaml', { v: 1 }), obj('o2', 's2.yaml', { v: 1 }), obj('o3', 's3.yaml', { v: 1 })],
      [{ edgeType: 'depends_on', fromKey: 'o1', toKey: 'o2' } as MetadataEdge],
      'fpA',
    );
    // B: s1 CHANGED (payload differs), s2 UNCHANGED, s4 ADDED, s3 REMOVED.
    const b = snapshot(
      [obj('o1', 's1.yaml', { v: 2 }), obj('o2', 's2.yaml', { v: 1 }), obj('o4', 's4.yaml', { v: 1 })],
      [{ edgeType: 'depends_on', fromKey: 'o1', toKey: 'o2' } as MetadataEdge, { edgeType: 'depends_on', fromKey: 'o1', toKey: 'o4' } as MetadataEdge],
      'fpB',
    );

    const incPath = tmpDb('inc.sqlite');
    const incremental = new MetadataCatalog(incPath);
    incremental.rebuild(a);
    const result = incremental.rebuildIncremental(b);
    expect(result.mode).toBe('incremental');
    expect(result.changedSources).toBe(2); // s1 changed + s4 new

    const fullPath = tmpDb('full.sqlite');
    const full = new MetadataCatalog(fullPath);
    full.rebuild(b);

    expect(objectSignature(incremental)).toBe(objectSignature(full));
    expect(edgeSignature(incPath)).toBe(edgeSignature(fullPath));
    incremental.close();
    full.close();
  });

  it('falls back to a full rebuild on first build (no prior fingerprints)', () => {
    const catalog = new MetadataCatalog(tmpDb('fresh.sqlite'));
    const result = catalog.rebuildIncremental(snapshot([obj('o1', 's1.yaml', { v: 1 })], [], 'fp'));
    expect(result.mode).toBe('full');
    expect(catalog.listObjects({ limit: 10 }).map((o) => o.objectKey)).toEqual(['o1']);
    catalog.close();
  });
});

describe('duplicate diagnostics do not crash rebuilds (1.8.2 field bug)', () => {
  // A key that collides three+ times emits byte-identical duplicate-object-key
  // warnings; the content-hash PRIMARY KEY then failed both rebuild paths with
  // SQLITE_CONSTRAINT_PRIMARYKEY. Identical rows are lossless to drop.
  const duplicated = {
    kind: 'metadata',
    severity: 'warning' as const,
    objectKey: 'dbt_model:dbt_core_models.total_ccu',
    message: 'duplicate metadata object key "dbt_model:dbt_core_models.total_ccu" from models/a.yml and models/a.yml',
  };
  const withDuplicates = (fingerprint: string) => ({
    ...snapshot([obj('o1', 's1.yaml', { v: 1 })], [], fingerprint),
    diagnostics: [duplicated, { ...duplicated }, { kind: 'metadata', severity: 'error' as const, message: 'other' }],
  });

  it('full rebuild tolerates identical diagnostic rows', () => {
    const catalog = new MetadataCatalog(tmpDb('dup-full.sqlite'));
    expect(() => catalog.rebuild(withDuplicates('fp-dup-1') as never)).not.toThrow();
  });

  it('incremental rebuild tolerates identical diagnostic rows and stores one copy', () => {
    const dbPath = tmpDb('dup-inc.sqlite');
    const catalog = new MetadataCatalog(dbPath);
    catalog.rebuild(snapshot([obj('o1', 's1.yaml', { v: 1 })], [], 'fp-base') as never);
    expect(() => catalog.rebuildIncremental(withDuplicates('fp-dup-2') as never)).not.toThrow();
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT COUNT(*) AS n FROM metadata_diagnostics').get() as { n: number };
    db.close();
    expect(rows.n).toBe(2);
  });
});
