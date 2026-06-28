import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadSkills,
  parseSkill,
  renderSkill,
  buildSkillsPrompt,
  buildSkillBlockHints,
  writeSkill,
  deleteSkill,
  selectRelevantSkills,
  skillPath,
  type Skill,
} from './loader.js';

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
preferred_blocks: [revenue_total]
vocabulary:
  ARR: metric:arr
  "logo churn": metric:logo_churn
  "bookings": block:bookings_by_month
---
Body content.`;
    const skill = parseSkill(raw, '/skills/cxo.skill.md');
    expect(skill).not.toBeNull();
    expect(skill?.id).toBe('cxo-monthly-review');
    expect(skill?.user).toBe('alice@acme.com');
    expect(skill?.preferredMetrics).toEqual(['arr', 'nrr', 'gross_margin']);
    expect(skill?.preferredBlocks).toEqual(['revenue_total']);
    expect(skill?.vocabulary).toEqual({
      ARR: 'metric:arr',
      'logo churn': 'metric:logo_churn',
      bookings: 'block:bookings_by_month',
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
  const skills: Skill[] = [
    { id: 'shared', scope: 'project', preferredMetrics: ['arr'], preferredBlocks: ['revenue_total'], vocabulary: {}, body: 'Shared body', sourcePath: '' },
    { id: 'alice', scope: 'personal', user: 'alice@acme.com', preferredMetrics: [], preferredBlocks: [], vocabulary: { ARR: 'metric:arr' }, body: 'Alice body', sourcePath: '' },
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
  it('marks skills as advisory and includes preferred blocks', () => {
    const prompt = buildSkillsPrompt(skills, null);
    expect(prompt).toContain('Skills are advisory business preferences');
    expect(prompt).toContain('Preferred blocks: revenue_total');
  });
});

describe('buildSkillBlockHints', () => {
  it('collects preferred block and vocabulary block refs from active skills', () => {
    const hints = buildSkillBlockHints([
      {
        id: 'shared',
        scope: 'project',
        preferredMetrics: [],
        preferredBlocks: ['revenue_total'],
        vocabulary: { bookings: 'block:bookings_by_month', arr: 'metric:arr' },
        body: '',
        sourcePath: '',
      },
      {
        id: 'alice',
        scope: 'personal',
        user: 'alice@acme.com',
        preferredMetrics: [],
        preferredBlocks: ['private_revenue'],
        vocabulary: {},
        body: '',
        sourcePath: '',
      },
    ], null);
    expect(hints).toEqual(['revenue_total', 'bookings_by_month']);
  });
});

describe('writeSkill / round-trip (spec 16)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skills-crud-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips through parseSkill (renderSkill ↔ parseSkill)', () => {
    const skill = writeSkill(root, {
      id: 'cxo-review',
      scope: 'personal',
      user: 'alice@acme.com',
      description: "Alice's review",
      preferredMetrics: ['arr', 'nrr'],
      preferredBlocks: ['revenue_total'],
      vocabulary: { ARR: 'metric:arr', 'logo churn': 'metric:logo_churn' },
      body: 'Body content.',
    });
    expect(skill.scope).toBe('personal');
    expect(skill.user).toBe('alice@acme.com');
    expect(skill.preferredMetrics).toEqual(['arr', 'nrr']);
    expect(skill.vocabulary).toEqual({ ARR: 'metric:arr', 'logo churn': 'metric:logo_churn' });
    expect(skill.body).toBe('Body content.');

    // The persisted file parses back to the same Skill.
    const reparsed = parseSkill(renderSkill(skill), skill.sourcePath);
    expect(reparsed).toMatchObject({
      id: 'cxo-review',
      scope: 'personal',
      user: 'alice@acme.com',
      preferredMetrics: ['arr', 'nrr'],
      preferredBlocks: ['revenue_total'],
      vocabulary: { ARR: 'metric:arr', 'logo churn': 'metric:logo_churn' },
      body: 'Body content.',
    });
  });

  it('project skills omit user; personal skills bind to a user', () => {
    const project = writeSkill(root, { id: 'house-rules', scope: 'project', body: 'Shared.' });
    expect(project.scope).toBe('project');
    expect(project.user).toBeUndefined();
    expect(renderSkill(project)).not.toContain('user:');

    const personal = writeSkill(root, { id: 'mine', scope: 'personal', user: 'bob@acme.com', body: 'Mine.' });
    expect(renderSkill(personal)).toContain('user: bob@acme.com');
  });

  it('deleteSkill removes the file', () => {
    writeSkill(root, { id: 'temp', scope: 'project', body: 'x' });
    expect(existsSync(skillPath(root, 'temp'))).toBe(true);
    expect(deleteSkill(root, 'temp')).toBe(true);
    expect(existsSync(skillPath(root, 'temp'))).toBe(false);
    expect(deleteSkill(root, 'temp')).toBe(false);
  });
});

describe('selectRelevantSkills (spec 16)', () => {
  const sqlConventions: Skill = {
    id: 'sql-conventions', scope: 'project', preferredMetrics: [], preferredBlocks: [],
    vocabulary: {}, body: 'Prefer ref and qualified relations.', sourcePath: '',
  };
  const revenue: Skill = {
    id: 'revenue-glossary', scope: 'project', description: 'Revenue and ARR terms',
    preferredMetrics: ['arr'], preferredBlocks: [], vocabulary: { ARR: 'metric:arr' },
    body: 'Revenue, ARR, bookings, churn.', sourcePath: '',
  };
  const ops: Skill = {
    id: 'ops-glossary', scope: 'project', description: 'Operations terms',
    preferredMetrics: [], preferredBlocks: [], vocabulary: {}, body: 'Shipping, fulfillment, warehouse.', sourcePath: '',
  };

  it('ranks a matching skill first and keeps pinned conventions', () => {
    const selected = selectRelevantSkills([ops, revenue, sqlConventions], 'what is our ARR and revenue?');
    const ids = selected.map((s) => s.id);
    // Pinned SQL conventions always present; the revenue glossary is selected; ops (no match) dropped.
    expect(ids).toContain('sql-conventions');
    expect(ids).toContain('revenue-glossary');
    expect(ids).not.toContain('ops-glossary');
  });

  it('respects personal scope — other users do not see a personal skill', () => {
    const personal: Skill = {
      id: 'alice-arr', scope: 'personal', user: 'alice@acme.com', description: 'arr',
      preferredMetrics: [], preferredBlocks: [], vocabulary: {}, body: 'arr revenue', sourcePath: '',
    };
    const forAlice = selectRelevantSkills([personal], 'arr revenue', { userId: 'alice@acme.com' });
    expect(forAlice.map((s) => s.id)).toContain('alice-arr');
    const forBob = selectRelevantSkills([personal], 'arr revenue', { userId: 'bob@acme.com' });
    expect(forBob.map((s) => s.id)).not.toContain('alice-arr');
  });
});
