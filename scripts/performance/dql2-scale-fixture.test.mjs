import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fixtureDigest, generateScaleFixture } from './dql2-scale-fixture.mjs';

const SMALL = { dbtModels: 12, columnsPerModel: 3, domains: 2, entities: 4, relationships: 6, skills: 4, blocks: 4, businessViews: 4, apps: 2, notebooks: 2 };

test('PERF-001 generator is deterministic and matches requested object counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'dql-scale-generator-'));
  const first = join(root, 'first');
  const second = join(root, 'second');
  try {
    const a = generateScaleFixture(first, { seed: 'unit-seed', counts: SMALL });
    const b = generateScaleFixture(second, { seed: 'unit-seed', counts: SMALL });
    assert.equal(a.digest, b.digest);
    assert.equal(fixtureDigest(first), fixtureDigest(second));
    const manifest = JSON.parse(readFileSync(join(first, 'target', 'manifest.json'), 'utf8'));
    assert.equal(Object.keys(manifest.nodes).length, SMALL.dbtModels);
    assert.equal(Object.keys(manifest.nodes[Object.keys(manifest.nodes)[0]].columns).length, SMALL.columnsPerModel);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PERF-001 generator rejects impossible entity counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'dql-scale-generator-invalid-'));
  try {
    assert.throws(() => generateScaleFixture(root, { counts: { ...SMALL, entities: 13 } }), /entities cannot exceed dbtModels/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
