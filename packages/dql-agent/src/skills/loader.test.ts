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
  migrateLegacySkills,
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
  it('keeps legacy .dql/skills files readable during the OSS layout migration', () => {
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

  it('prefers visible skills and moves legacy files without overwriting them', () => {
    writeFileSync(join(root, '.dql', 'skills', 'revenue.skill.md'), '---\nid: revenue\n---\nLegacy', 'utf-8');
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(join(root, 'skills', 'revenue.skill.md'), '---\nid: revenue\n---\nVisible', 'utf-8');
    writeFileSync(join(root, '.dql', 'skills', 'customers.skill.md'), '---\nid: customers\n---\nLegacy customers', 'utf-8');

    expect(loadSkills(root).skills.find((skill) => skill.id === 'revenue')?.body).toBe('Visible');
    const migration = migrateLegacySkills(root);
    expect(migration.moved).toEqual(['skills/customers.skill.md']);
    expect(migration.skipped).toEqual(['.dql/skills/revenue.skill.md']);
    expect(existsSync(join(root, 'skills', 'customers.skill.md'))).toBe(true);
  });
});

describe('buildSkillsPrompt', () => {
  const skills: Skill[] = [
    { id: 'shared', scope: 'project', preferredMetrics: ['arr'], preferredBlocks: ['revenue_total'], vocabulary: {}, body: 'Shared body', sourcePath: '' },
    { id: 'alice', scope: 'personal', user: 'alice@acme.com', preferredMetrics: [], preferredBlocks: [], vocabulary: { ARR: 'metric:arr' }, body: 'Alice body', sourcePath: '' },
  ];
  it('excludes legacy personal guidance even for its former user', () => {
    const prompt = buildSkillsPrompt(skills, 'alice@acme.com');
    expect(prompt).toContain('Skill: shared');
    expect(prompt).not.toContain('Skill: alice');
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

  it('writes every new skill as shared project guidance', () => {
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
    expect(skill.scope).toBe('project');
    expect(skill.user).toBeUndefined();
    expect(skill.preferredMetrics).toEqual(['arr', 'nrr']);
    expect(skill.vocabulary).toEqual({ ARR: 'metric:arr', 'logo churn': 'metric:logo_churn' });
    expect(skill.body).toBe('Body content.');

    // The persisted file parses back to the same Skill.
    const reparsed = parseSkill(renderSkill(skill), skill.sourcePath);
    expect(reparsed).toMatchObject({
      id: 'cxo-review',
      scope: 'project',
      preferredMetrics: ['arr', 'nrr'],
      preferredBlocks: ['revenue_total'],
      vocabulary: { ARR: 'metric:arr', 'logo churn': 'metric:logo_churn' },
      body: 'Body content.',
    });
  });

  it('round-trips an optional domain (spec 17, part B)', () => {
    const skill = writeSkill(root, {
      id: 'sales-review',
      scope: 'project',
      domain: 'Sales',
      body: 'Sales monthly review.',
    });
    expect(skill.domain).toBe('Sales');
    expect(renderSkill(skill)).toContain('domain: Sales');
    const reparsed = parseSkill(renderSkill(skill), skill.sourcePath);
    expect(reparsed?.domain).toBe('Sales');
    // A skill without a domain stays undefined and omits the frontmatter key.
    const noDomain = writeSkill(root, { id: 'plain', scope: 'project', body: 'No domain.' });
    expect(noDomain.domain).toBeUndefined();
    expect(renderSkill(noDomain)).not.toContain('domain:');
  });

  it('stores structured leaf-domain modules in a Git-friendly nested path', () => {
    const skill = writeSkill(root, {
      id: 'recognized-revenue-policy', scope: 'project', domain: 'Revenue', domains: ['Finance/Revenue'],
      kind: 'metric_policy', status: 'draft', owner: 'finance-analytics', triggers: ['recognized revenue'],
      exclusions: ['bookings'], preferredMetrics: ['recognized_revenue'], preferredDimensions: ['region'],
      requiredFilters: ['date_range'], clarifyWhen: ['When currency is not specified'], examples: ['Recognized revenue by region'],
      sourceRefs: ['metric:recognized_revenue'], body: 'Exclude bookings and use recognized revenue.',
    });
    expect(skill.sourcePath.replace(/\\/g, '/')).toContain('skills/finance/revenue/recognized-revenue-policy.skill.md');
    expect(skill).toMatchObject({ kind: 'metric_policy', status: 'draft', preferredDimensions: ['region'], requiredFilters: ['date_range'] });
    expect(renderSkill(skill)).toContain('clarify_when:');
  });

  it('omits personal user fields from newly written skills', () => {
    const project = writeSkill(root, { id: 'house-rules', scope: 'project', body: 'Shared.' });
    expect(project.scope).toBe('project');
    expect(project.user).toBeUndefined();
    expect(renderSkill(project)).not.toContain('user:');

    const requestedPersonal = writeSkill(root, { id: 'mine', scope: 'personal', user: 'bob@acme.com', body: 'Mine.' });
    expect(requestedPersonal.scope).toBe('project');
    expect(renderSkill(requestedPersonal)).not.toContain('user:');
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

  it('keeps legacy personal skills out of shared agent selection', () => {
    const personal: Skill = {
      id: 'alice-arr', scope: 'personal', user: 'alice@acme.com', description: 'arr',
      preferredMetrics: [], preferredBlocks: [], vocabulary: {}, body: 'arr revenue', sourcePath: '',
    };
    const forAlice = selectRelevantSkills([personal], 'arr revenue', { userId: 'alice@acme.com' });
    expect(forAlice.map((s) => s.id)).not.toContain('alice-arr');
  });

  it('uses inferred domains to select the matching domain skill', () => {
    const finance: Skill = {
      id: 'finance-review', scope: 'project', domain: 'Finance', description: 'Monthly review',
      preferredMetrics: [], preferredBlocks: [], vocabulary: {}, body: 'Executive scorecard.', sourcePath: '',
    };
    const sales: Skill = {
      id: 'sales-review', scope: 'project', domain: 'Sales', description: 'Monthly review',
      preferredMetrics: [], preferredBlocks: [], vocabulary: {}, body: 'Executive scorecard.', sourcePath: '',
    };
    const selected = selectRelevantSkills([sales, finance], 'monthly executive scorecard', { domains: ['Finance'] });
    expect(selected[0]?.id).toBe('finance-review');
  });

  it('does not inject a draft skill until the user activates it', () => {
    const draft: Skill = {
      id: 'draft-revenue', scope: 'project', status: 'draft', domain: 'Revenue',
      preferredMetrics: ['recognized_revenue'], preferredBlocks: [], vocabulary: {}, body: 'Use recognized revenue.', sourcePath: '',
    };
    expect(selectRelevantSkills([draft], 'revenue', { domains: ['Revenue'] })).toEqual([]);
  });
});
