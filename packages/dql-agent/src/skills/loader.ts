/**
 * Skills loader — discover and parse `.dql/skills/*.skill.md` files.
 *
 * Each skill is a markdown file with YAML frontmatter:
 *
 *     ---
 *     id: cxo-monthly-review
 *     user: alice@acme.com
 *     description: Alice's monthly board review
 *     preferred_metrics: [arr, nrr]
 *     vocabulary: { "ARR": "metric:arr" }
 *     ---
 *     Free-form prompt body...
 *
 * No external YAML dep — we ship a tiny parser that handles only flat
 * key/value, list-of-strings, and one-level objects (good enough for skills).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

export interface Skill {
  id: string;
  /**
   * Skill scope. PROJECT skills (`user` empty) are shared with everyone;
   * PERSONAL skills (`user` set) are bound to a single user. Derived from
   * `user` on parse; persisted faithfully on write.
   */
  scope: 'project' | 'personal';
  /** Optional user this skill is bound to. Empty = project-level skill. */
  user?: string;
  /** Optional domain this skill belongs to (spec 17, part B). */
  domain?: string;
  description?: string;
  preferredMetrics: string[];
  preferredBlocks: string[];
  vocabulary: Record<string, string>;
  /** Markdown body (everything after the closing `---`). */
  body: string;
  sourcePath: string;
  /** True for the editable starter skills seeded by `seedDefaultSkills`. */
  isStarter?: boolean;
}

export interface SkillLoadResult {
  skills: Skill[];
  errors: Array<{ path: string; message: string }>;
}

/**
 * Walk `<projectRoot>/.dql/skills/**` and return every parsed Skill.
 * Misformed files are reported in `errors`; valid Skills still come back.
 */
export function loadSkills(projectRoot: string): SkillLoadResult {
  const skillsDir = join(projectRoot, '.dql', 'skills');
  if (!existsSync(skillsDir)) return { skills: [], errors: [] };
  const skills: Skill[] = [];
  const errors: Array<{ path: string; message: string }> = [];

  const files = walkMd(skillsDir);
  for (const f of files) {
    try {
      const raw = readFileSync(f, 'utf-8');
      const skill = parseSkill(raw, f);
      if (skill) skills.push(skill);
    } catch (err) {
      errors.push({ path: f, message: (err as Error).message });
    }
  }
  return { skills, errors };
}

function walkMd(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      out.push(...walkMd(p));
    } else if (entry.isFile() && (entry.name.endsWith('.skill.md') || entry.name.endsWith('.md'))) {
      if (statSync(p).size <= 1024 * 256) out.push(p);
    }
  }
  return out;
}

/** Public for tests. */
export function parseSkill(raw: string, path: string): Skill | null {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return null;
  const front = m[1];
  const body = m[2].trim();
  const meta = parseMiniYaml(front);

  const id = pickString(meta.id) ?? basename(path).replace(/\.skill\.md$|\.md$/, '');
  const user = pickString(meta.user);
  const starter = pickString(meta.starter);
  return {
    id,
    scope: user ? 'personal' : 'project',
    user,
    domain: pickString(meta.domain),
    description: pickString(meta.description),
    preferredMetrics: pickStringArray(meta.preferred_metrics),
    preferredBlocks: pickStringArray(meta.preferred_blocks),
    vocabulary: pickStringMap(meta.vocabulary),
    body,
    sourcePath: path,
    isStarter: starter === 'true' || starter === 'yes' ? true : undefined,
  };
}

// ─── Serialization + CRUD (spec 16) ──────────────────────────────────────────

/** Skills directory for a project. */
export function skillsDir(projectRoot: string): string {
  return join(projectRoot, '.dql', 'skills');
}

/** Resolve the `.skill.md` path a skill should be written to. */
export function skillPath(projectRoot: string, id: string): string {
  return join(skillsDir(projectRoot), `${sanitizeSkillId(id)}.skill.md`);
}

function sanitizeSkillId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'skill';
}

/** Does a frontmatter value need quoting (any whitespace, colons, specials)? */
function needsQuote(value: string): boolean {
  return /[\s:#"'\[\]{}]|^[&*!|>%@`-]/.test(value) || value === '';
}

function quoteIfNeeded(value: string): string {
  if (!needsQuote(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Render a Skill back to the EXACT `.skill.md` format `parseSkill` consumes, so
 * `parseSkill(renderSkill(s))` round-trips. Only emits keys that have content.
 */
export function renderSkill(skill: Skill): string {
  const lines: string[] = ['---', `id: ${quoteIfNeeded(skill.id)}`];
  // PERSONAL skills carry a `user:`; PROJECT skills omit it.
  if (skill.scope === 'personal' && skill.user) {
    lines.push(`user: ${quoteIfNeeded(skill.user)}`);
  }
  if (skill.domain) lines.push(`domain: ${quoteIfNeeded(skill.domain)}`);
  if (skill.description) lines.push(`description: ${quoteIfNeeded(skill.description)}`);
  if (skill.preferredMetrics.length > 0) {
    lines.push(`preferred_metrics: [${skill.preferredMetrics.map(quoteIfNeeded).join(', ')}]`);
  }
  if (skill.preferredBlocks.length > 0) {
    lines.push(`preferred_blocks: [${skill.preferredBlocks.map(quoteIfNeeded).join(', ')}]`);
  }
  const vocabEntries = Object.entries(skill.vocabulary);
  if (vocabEntries.length > 0) {
    lines.push('vocabulary:');
    for (const [key, value] of vocabEntries) {
      lines.push(`  ${quoteIfNeeded(key)}: ${quoteIfNeeded(value)}`);
    }
  }
  if (skill.isStarter) lines.push('starter: true');
  lines.push('---');
  const body = skill.body.trim();
  return `${lines.join('\n')}\n${body ? `${body}\n` : ''}`;
}

export interface WriteSkillInput {
  id: string;
  scope: 'project' | 'personal';
  user?: string;
  domain?: string;
  description?: string;
  preferredMetrics?: string[];
  preferredBlocks?: string[];
  vocabulary?: Record<string, string>;
  body?: string;
  isStarter?: boolean;
}

/** Normalize a partial input into a full Skill (with a resolved sourcePath). */
function toSkill(projectRoot: string, input: WriteSkillInput): Skill {
  const scope = input.scope === 'personal' ? 'personal' : 'project';
  return {
    id: input.id,
    scope,
    user: scope === 'personal' ? (input.user || undefined) : undefined,
    domain: input.domain || undefined,
    description: input.description,
    preferredMetrics: input.preferredMetrics ?? [],
    preferredBlocks: input.preferredBlocks ?? [],
    vocabulary: input.vocabulary ?? {},
    body: input.body ?? '',
    sourcePath: skillPath(projectRoot, input.id),
    isStarter: input.isStarter,
  };
}

/**
 * Write a skill to `.dql/skills/<id>.skill.md` (overwriting if present). Returns
 * the persisted Skill as re-read from disk so callers see the canonical form.
 */
export function writeSkill(projectRoot: string, input: WriteSkillInput): Skill {
  const skill = toSkill(projectRoot, input);
  const dir = skillsDir(projectRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(skill.sourcePath, renderSkill(skill), 'utf-8');
  return parseSkill(readFileSync(skill.sourcePath, 'utf-8'), skill.sourcePath) ?? skill;
}

/** Alias for `writeSkill` — create-or-update by id. */
export function upsertSkill(projectRoot: string, input: WriteSkillInput): Skill {
  return writeSkill(projectRoot, input);
}

/** Delete `.dql/skills/<id>.skill.md`. Returns true when a file was removed. */
export function deleteSkill(projectRoot: string, id: string): boolean {
  const path = skillPath(projectRoot, id);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function pickStringArray(v: unknown): string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : [];
}

function pickStringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

/**
 * Tiny YAML parser tailored to skill frontmatter.
 *
 * Supports:
 *   key: scalar
 *   key: [item1, item2]
 *   key:
 *     subkey: value
 *
 * Not a real YAML implementation. If a skill needs richer YAML, point users
 * at js-yaml manually and we'll widen the surface.
 */
function parseMiniYaml(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  const out: Record<string, unknown> = {};
  let inObject: { key: string; obj: Record<string, string> } | null = null;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    if (inObject) {
      // Match either a quoted key ("key with spaces": value) or a bare key.
      const subMatch = line.match(/^\s+("([^"]+)"|'([^']+)'|([a-zA-Z0-9_.-]+))\s*:\s*(.+)$/);
      if (subMatch && line.startsWith(' ')) {
        const k = subMatch[2] ?? subMatch[3] ?? subMatch[4];
        const v = stripQuotes(subMatch[5].trim());
        if (k) inObject.obj[k] = v;
        continue;
      }
      out[inObject.key] = inObject.obj;
      inObject = null;
    }

    const top = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (!top) continue;
    const key = top[1];
    const value = top[2].trim();
    if (!value) {
      inObject = { key, obj: {} };
      continue;
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean);
      continue;
    }
    out[key] = stripQuotes(value);
  }
  if (inObject) out[inObject.key] = inObject.obj;
  return out;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Compose Skills into a single system-prompt fragment for the agent.
 * Filtered by user when a persona is active.
 */
export function buildSkillsPrompt(skills: Skill[], userId: string | null): string {
  const relevant = activeSkills(skills, userId);
  if (relevant.length === 0) return '';
  const sections = relevant.map((s) => {
    const header = s.description ? `${s.id} — ${s.description}` : s.id;
    const metrics = s.preferredMetrics.length > 0 ? `\nPreferred metrics: ${s.preferredMetrics.join(', ')}` : '';
    const blocks = s.preferredBlocks.length > 0 ? `\nPreferred blocks: ${s.preferredBlocks.join(', ')}` : '';
    const vocab = Object.keys(s.vocabulary).length > 0
      ? `\nVocabulary: ${Object.entries(s.vocabulary).map(([k, v]) => `"${k}" → ${v}`).join(', ')}`
      : '';
    return `### Skill: ${header}${metrics}${blocks}${vocab}\n\n${s.body}`;
  });
  return [
    '## Active Skills',
    '',
    'Skills are advisory business preferences. Use them for vocabulary, preferred metrics, and stakeholder context, but never let them override DQL certification status, runtime schema, SQL safety, permissions, or the user\'s requested grain.',
    '',
    sections.join('\n\n'),
    '',
  ].join('\n');
}

export function activeSkills(skills: Skill[], userId: string | null): Skill[] {
  return skills.filter((s) => !s.user || s.user === userId);
}

export function buildSkillBlockHints(skills: Skill[], userId: string | null): string[] {
  const hints = new Set<string>();
  for (const skill of activeSkills(skills, userId)) {
    for (const block of skill.preferredBlocks) {
      const normalized = normalizeBlockHint(block);
      if (normalized) hints.add(normalized);
    }
    for (const target of Object.values(skill.vocabulary)) {
      if (!/^block:/i.test(target.trim())) continue;
      const normalized = normalizeBlockHint(target);
      if (normalized) hints.add(normalized);
    }
  }
  return Array.from(hints);
}

function normalizeBlockHint(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^block:(.+)$/i);
  return (match ? match[1] : trimmed).trim() || undefined;
}

// ─── Skill selection (spec 16) ────────────────────────────────────────────────

export interface SelectRelevantSkillsOptions {
  /** Active user — gates personal skills (only this user's are eligible). */
  userId?: string | null;
  /** Max skills to return after pinned ones. Default 6. */
  budget?: number;
  /**
   * Skill ids that are ALWAYS kept regardless of match (e.g. SQL conventions).
   * Defaults to the seeded `sql-conventions` starter. Pinned skills are only
   * kept when they are in-scope for the active user.
   */
  pinnedIds?: string[];
}

const DEFAULT_PINNED_SKILL_IDS = ['sql-conventions'];

const SKILL_TOKEN_RE = /[\p{L}\p{N}_]+/gu;

function skillTokens(text: string): string[] {
  return (text.toLowerCase().match(SKILL_TOKEN_RE) ?? []).filter((t) => t.length > 1);
}

/** Searchable text for a skill: id, description, vocabulary keys/values, body. */
function skillSearchText(skill: Skill): string {
  return [
    skill.id,
    skill.description ?? '',
    ...skill.preferredMetrics,
    ...skill.preferredBlocks,
    ...Object.keys(skill.vocabulary),
    ...Object.values(skill.vocabulary),
    skill.body,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Rank in-scope skills by topic/vocabulary match to `question` and return the
 * SELECTED subset the answer-loop / build engine should inject — not all skills.
 * Pinned project skills (SQL conventions by default) are always kept. The rest
 * are ordered by lexical overlap (vocabulary + description + body) and capped to
 * the budget. Deterministic and offline.
 */
export function selectRelevantSkills(
  skills: Skill[],
  question: string,
  options: SelectRelevantSkillsOptions = {},
): Skill[] {
  const inScope = activeSkills(skills, options.userId ?? null);
  if (inScope.length === 0) return [];
  const budget = Math.max(1, options.budget ?? 6);
  const pinnedIds = new Set((options.pinnedIds ?? DEFAULT_PINNED_SKILL_IDS).map((id) => id.toLowerCase()));
  const queryTokens = new Set(skillTokens(question));

  const pinned: Skill[] = [];
  const rest: Array<{ skill: Skill; score: number }> = [];
  for (const skill of inScope) {
    if (pinnedIds.has(skill.id.toLowerCase())) {
      pinned.push(skill);
      continue;
    }
    const textTokens = skillTokens(skillSearchText(skill));
    let hits = 0;
    for (const token of textTokens) {
      if (queryTokens.has(token)) hits += 1;
    }
    rest.push({ skill, score: hits });
  }

  // Keep only skills with at least one topical hit; ordered by score desc, then
  // stable by original order. Pinned skills are prepended and never dropped.
  const ranked = rest
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((entry) => entry.skill);

  const remainingBudget = Math.max(0, budget - pinned.length);
  return [...pinned, ...ranked.slice(0, remainingBudget)];
}
