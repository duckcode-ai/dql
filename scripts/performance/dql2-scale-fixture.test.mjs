import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  fixtureDigest,
  generateScaleFixture,
  PERF_001_TARGET_SEMANTIC_METRICS,
} from './dql2-scale-fixture.mjs';

const SMALL = { dbtModels: 12, columnsPerModel: 3, semanticMetrics: 12, domains: 2, entities: 4, relationships: 6, skills: 4, blocks: 4, businessViews: 4, apps: 2, notebooks: 2 };

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
    const semanticManifest = JSON.parse(readFileSync(join(first, 'target', 'semantic_manifest.json'), 'utf8'));
    assert.equal(Object.keys(semanticManifest.metrics).length, SMALL.semanticMetrics);
    assert.equal(Object.keys(semanticManifest.semantic_models).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PERF-001 generator places confusable target metrics at their normative positions', () => {
  const root = mkdtempSync(join(tmpdir(), 'dql-scale-generator-targets-'));
  const counts = { ...SMALL, dbtModels: 110, entities: 4, semanticMetrics: 7_000 };
  try {
    generateScaleFixture(root, { counts });
    const semanticManifest = JSON.parse(readFileSync(join(root, 'target', 'semantic_manifest.json'), 'utf8'));
    assert.equal(Object.keys(semanticManifest.metrics).length, counts.semanticMetrics);
    for (const [position, expected] of Object.entries(PERF_001_TARGET_SEMANTIC_METRICS)) {
      const metric = semanticManifest.metrics[`metric.scale.${expected.name}`];
      assert.ok(metric, `missing target metric at ${position}`);
      assert.equal(metric.label, expected.label);
      assert.equal(metric.description, expected.description);
      assert.equal(metric.meta.domain, expected.domain);
      assert.equal(metric.meta.concept_id, expected.conceptId);
      assert.equal(metric.meta.fixture_position, Number(position));
    }
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
