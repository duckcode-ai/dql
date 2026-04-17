import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManifestCache } from './manifest-cache.js';

describe('ManifestCache', () => {
  let tmpDir: string;
  let dbPath: string;
  let cache: ManifestCache;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dql-cache-'));
    dbPath = join(tmpDir, 'cache', 'manifest.sqlite');
    cache = new ManifestCache({ path: dbPath });
  });

  afterEach(() => {
    cache.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(name: string, content: string): string {
    const p = join(tmpDir, name);
    writeFileSync(p, content, 'utf-8');
    return p;
  }

  it('creates the SQLite file on first use', () => {
    // Constructor already ran — if file is missing, lookup would throw.
    const lookup = cache.lookup('nope', []);
    expect(lookup.hit).toBe(false);
  });

  it('miss on empty cache returns no changed files when none tracked', () => {
    const result = cache.lookup('abc', []);
    expect(result).toEqual({ hit: false, changedFiles: [] });
  });

  it('roundtrips a manifest payload under its fingerprint', () => {
    const a = writeFile('a.dql', 'block a {}');
    const b = writeFile('b.dql', 'block b {}');
    const files = [{ path: a }, { path: b }];
    const fp = cache.fingerprint(files);

    const manifest = { project: 'demo', blocks: { a: {}, b: {} } };
    cache.put(fp, manifest, files);

    const result = cache.lookup(fp, files);
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.value).toEqual(manifest);
      expect(result.fingerprint).toBe(fp);
      expect(result.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('produces a different fingerprint when a file changes', () => {
    const a = writeFile('a.dql', 'v1');
    const fp1 = cache.fingerprint([{ path: a }]);

    writeFileSync(a, 'v2', 'utf-8');
    const fp2 = cache.fingerprint([{ path: a }]);

    expect(fp1).not.toBe(fp2);
  });

  it('fingerprint is stable regardless of input file order', () => {
    const a = writeFile('a.dql', 'aaa');
    const b = writeFile('b.dql', 'bbb');
    const fp1 = cache.fingerprint([{ path: a }, { path: b }]);
    const fp2 = cache.fingerprint([{ path: b }, { path: a }]);
    expect(fp1).toBe(fp2);
  });

  it('diffFiles reports which specific files changed since last put', () => {
    const a = writeFile('a.dql', 'v1');
    const b = writeFile('b.dql', 'v1');
    const files = [{ path: a }, { path: b }];
    cache.put(cache.fingerprint(files), { any: true }, files);

    writeFileSync(b, 'v2-changed', 'utf-8');
    const changed = cache.diffFiles(files);
    expect(changed).toEqual([b]);
  });

  it('missing files hash to a sentinel so their absence is cacheable', () => {
    const ghost = join(tmpDir, 'does-not-exist.dql');
    const fp1 = cache.fingerprint([{ path: ghost }]);
    const fp2 = cache.fingerprint([{ path: ghost }]);
    expect(fp1).toBe(fp2);
  });

  it('clear() removes all entries and file hashes', () => {
    const a = writeFile('a.dql', 'x');
    const files = [{ path: a }];
    const fp = cache.fingerprint(files);
    cache.put(fp, { ok: 1 }, files);

    cache.clear();
    const result = cache.lookup(fp, files);
    expect(result.hit).toBe(false);
    expect(cache.diffFiles(files)).toEqual([a]); // a is now "new" again
  });

  it('accepts a caller-supplied content hash and does not read the file', () => {
    const ghost = join(tmpDir, 'never-created.dql');
    const fp = cache.fingerprint([{ path: ghost, contentHash: 'deadbeef' }]);
    // Same precomputed hash → same fingerprint, even though the file doesn't exist
    const fp2 = cache.fingerprint([{ path: ghost, contentHash: 'deadbeef' }]);
    expect(fp).toBe(fp2);
  });
});
