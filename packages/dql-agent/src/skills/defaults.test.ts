import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SemanticLayer } from '@duckcodeailabs/dql-core';
import { seedDefaultSkills } from './defaults.js';
import { loadSkills, skillPath } from './loader.js';

/** A stub semantic layer that only needs `listMetrics` for the glossary. */
function stubSemanticLayer(metrics: Array<{ name: string; label?: string; description?: string }>): SemanticLayer {
  return {
    listMetrics: () => metrics.map((m) => ({ ...m, label: m.label ?? m.name, description: m.description ?? '' })),
  } as unknown as SemanticLayer;
}

describe('seedDefaultSkills (spec 16)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skills-defaults-'));
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the three editable starters', () => {
    const result = seedDefaultSkills(root, { semanticLayer: stubSemanticLayer([]) });
    expect(result.created.map((s) => s.id).sort()).toEqual(['domain-rules', 'metrics-glossary', 'sql-conventions']);
    const { skills } = loadSkills(root);
    expect(skills.every((s) => s.isStarter)).toBe(true);
    // SQL conventions encodes the house grounding rules.
    const conventions = skills.find((s) => s.id === 'sql-conventions');
    expect(conventions?.body).toMatch(/\{\{ ref/);
    expect(conventions?.body).toMatch(/qualified relation/i);
  });

  it('metrics glossary reflects the semantic-layer metrics', () => {
    seedDefaultSkills(root, {
      semanticLayer: stubSemanticLayer([
        { name: 'arr', label: 'ARR', description: 'Annual recurring revenue' },
        { name: 'nrr' },
      ]),
    });
    const { skills } = loadSkills(root);
    const glossary = skills.find((s) => s.id === 'metrics-glossary')!;
    expect(glossary.preferredMetrics.sort()).toEqual(['arr', 'nrr']);
    expect(glossary.vocabulary).toMatchObject({ ARR: 'metric:arr' });
    expect(glossary.body).toContain('arr');
  });

  it('is idempotent and never clobbers user edits', () => {
    seedDefaultSkills(root, { semanticLayer: stubSemanticLayer([]) });
    // Simulate a user editing the SQL conventions starter.
    const conventionsPath = skillPath(root, 'sql-conventions');
    writeFileSync(conventionsPath, '---\nid: sql-conventions\nscope: project\n---\nMY EDITS\n', 'utf-8');

    const second = seedDefaultSkills(root, { semanticLayer: stubSemanticLayer([]) });
    expect(second.created).toEqual([]);
    expect(second.skipped.sort()).toEqual(['domain-rules', 'metrics-glossary', 'sql-conventions']);
    // The edit survived.
    expect(readFileSync(conventionsPath, 'utf-8')).toContain('MY EDITS');
  });
});
