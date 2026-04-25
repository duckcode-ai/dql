import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkills, parseSkill, buildSkillsPrompt } from './loader.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-'));
  mkdirSync(join(root, '.dql', 'skills'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parseSkill', () => {
  it('parses frontmatter scalars, lists, and one-level objects', () => {
    const raw = `---
id: cxo-monthly-review
user: alice@acme.com
description: Alice's monthly board review
preferred_metrics: [arr, nrr, gross_margin]
vocabulary:
  ARR: metric:arr
  "logo churn": metric:logo_churn
---
Body content.`;
    const skill = parseSkill(raw, '/skills/cxo.skill.md');
    expect(skill).not.toBeNull();
    expect(skill?.id).toBe('cxo-monthly-review');
    expect(skill?.user).toBe('alice@acme.com');
    expect(skill?.preferredMetrics).toEqual(['arr', 'nrr', 'gross_margin']);
    expect(skill?.vocabulary).toEqual({
      ARR: 'metric:arr',
      'logo churn': 'metric:logo_churn',
    });
    expect(skill?.body).toBe('Body content.');
  });

  it('returns null for files without frontmatter', () => {
    expect(parseSkill('Just a plain markdown.', '/foo.md')).toBeNull();
  });
});

describe('loadSkills', () => {
  it('discovers .skill.md files under .dql/skills/', () => {
    writeFileSync(
      join(root, '.dql', 'skills', 'a.skill.md'),
      `---\nid: a\n---\nBody`,
      'utf-8',
    );
    mkdirSync(join(root, '.dql', 'skills', 'team'), { recursive: true });
    writeFileSync(
      join(root, '.dql', 'skills', 'team', 'b.skill.md'),
      `---\nid: b\nuser: bob@acme.com\n---\nTeam body`,
      'utf-8',
    );
    const { skills } = loadSkills(root);
    expect(skills.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });
});

describe('buildSkillsPrompt', () => {
  const skills = [
    { id: 'shared', preferredMetrics: ['arr'], preferredBlocks: [], vocabulary: {}, body: 'Shared body', sourcePath: '' },
    { id: 'alice', user: 'alice@acme.com', preferredMetrics: [], preferredBlocks: [], vocabulary: { ARR: 'metric:arr' }, body: 'Alice body', sourcePath: '' },
  ];
  it('filters to skills matching the active user (or unscoped)', () => {
    const prompt = buildSkillsPrompt(skills, 'alice@acme.com');
    expect(prompt).toContain('Skill: shared');
    expect(prompt).toContain('Skill: alice');
  });
  it('hides user-scoped skills for other users', () => {
    const prompt = buildSkillsPrompt(skills, 'bob@acme.com');
    expect(prompt).toContain('Skill: shared');
    expect(prompt).not.toContain('Skill: alice');
  });
  it('returns empty when no relevant skills', () => {
    expect(buildSkillsPrompt([], null)).toBe('');
  });
});
