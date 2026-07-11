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

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';
import * as yaml from 'js-yaml';
import { loadDomainPackageRegistry } from '@duckcodeailabs/dql-core';

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
  /** Domain paths for cross-domain skills. `domain` remains backward compatible. */
  domains?: string[];
  kind?: 'domain_reference' | 'metric_policy' | 'glossary' | 'analysis_pattern' | 'sql_policy' | 'custom';
  status?: 'draft' | 'active' | 'deprecated';
  owner?: string;
  triggers?: string[];
  exclusions?: string[];
  description?: string;
  preferredMetrics: string[];
  preferredBlocks: string[];
  preferredDimensions?: string[];
  requiredFilters?: string[];
  clarifyWhen?: string[];
  examples?: string[];
  sourceRefs?: string[];
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
 * Walk the visible, Git-owned `skills/**` tree. The historical
 * `.dql/skills/**` tree remains read-compatible during migration, but a skill
 * with the same id in `skills/` wins so projects can move incrementally.
 * Misformed files are reported in `errors`; valid Skills still come back.
 */
export function loadSkills(projectRoot: string): SkillLoadResult {
  const domainRoots = loadDomainPackageRegistry(projectRoot).values().map((pkg) => join(pkg.root, 'skills'));
  const roots = [...domainRoots, skillsDir(projectRoot), legacySkillsDir(projectRoot)];
  const skills: Skill[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  const seen = new Set<string>();

  for (const root of roots) {
    for (const f of walkMd(root)) {
      try {
        const raw = readFileSync(f, 'utf-8');
        const skill = parseSkill(raw, f);
        if (skill && !seen.has(skill.id)) {
          seen.add(skill.id);
          skills.push(skill);
        }
      } catch (err) {
        errors.push({ path: f, message: (err as Error).message });
      }
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
  const meta = parseSkillFrontmatter(front);

  const id = pickString(meta.id) ?? basename(path).replace(/\.skill\.md$|\.md$/, '');
  const user = pickString(meta.user);
  const starter = meta.starter;
  return {
    id,
    scope: user ? 'personal' : 'project',
    user,
    domain: pickString(meta.domain),
    domains: pickStringArray(meta.domains ?? meta.domain),
    kind: parseSkillKind(pickString(meta.kind)),
    status: parseSkillStatus(pickString(meta.status)),
    owner: pickString(meta.owner),
    triggers: pickStringArray(meta.triggers),
    exclusions: pickStringArray(meta.exclusions),
    description: pickString(meta.description),
    preferredMetrics: pickStringArray(meta.preferred_metrics),
    preferredBlocks: pickStringArray(meta.preferred_blocks),
    preferredDimensions: pickStringArray(meta.preferred_dimensions),
    requiredFilters: pickStringArray(meta.required_filters),
    clarifyWhen: pickStringArray(meta.clarify_when),
    examples: pickStringArray(meta.examples),
    sourceRefs: pickStringArray(meta.source_refs),
    vocabulary: pickStringMap(meta.vocabulary),
    body,
    sourcePath: path,
    isStarter: starter === true || starter === 'true' || starter === 'yes' ? true : undefined,
  };
}

// ─── Serialization + CRUD (spec 16) ──────────────────────────────────────────

/** Visible Git-owned skills directory for new and upgraded OSS projects. */
export function skillsDir(projectRoot: string): string {
  return join(projectRoot, 'skills');
}

/** Historical local-state location, retained only as a read/migration source. */
export function legacySkillsDir(projectRoot: string): string {
  return join(projectRoot, '.dql', 'skills');
}

/** Resolve the `.skill.md` path a skill should be written to. */
export function skillPath(projectRoot: string, id: string, domains: string[] = []): string {
  const firstDomain = domains[0]?.trim();
  if (firstDomain && domains.length === 1) {
    const packageRoot = loadDomainPackageRegistry(projectRoot).get(firstDomain)?.root;
    if (packageRoot) return join(packageRoot, 'skills', `${sanitizeSkillId(id)}.skill.md`);
  }
  const folder = firstDomain
    ? firstDomain.split(/[/.]/).map(sanitizeSkillId).filter(Boolean)
    : [];
  const target = domains.length > 1 ? ['_cross-domain'] : folder;
  return join(skillsDir(projectRoot), ...target, `${sanitizeSkillId(id)}.skill.md`);
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
  if (skill.domain) lines.push(`domain: ${quoteIfNeeded(skill.domain)}`);
  if ((skill.domains?.length ?? 0) > 0) lines.push(`domains: [${(skill.domains ?? []).map(quoteIfNeeded).join(', ')}]`);
  if (skill.kind && skill.kind !== 'custom') lines.push(`kind: ${skill.kind}`);
  if (skill.status && skill.status !== 'active') lines.push(`status: ${skill.status}`);
  if (skill.owner) lines.push(`owner: ${quoteIfNeeded(skill.owner)}`);
  if (skill.description) lines.push(`description: ${quoteIfNeeded(skill.description)}`);
  if (skill.preferredMetrics.length > 0) {
    lines.push(`preferred_metrics: [${skill.preferredMetrics.map(quoteIfNeeded).join(', ')}]`);
  }
  if (skill.preferredBlocks.length > 0) {
    lines.push(`preferred_blocks: [${skill.preferredBlocks.map(quoteIfNeeded).join(', ')}]`);
  }
  if ((skill.preferredDimensions?.length ?? 0) > 0) lines.push(`preferred_dimensions: [${(skill.preferredDimensions ?? []).map(quoteIfNeeded).join(', ')}]`);
  if ((skill.triggers?.length ?? 0) > 0) lines.push(`triggers: [${(skill.triggers ?? []).map(quoteIfNeeded).join(', ')}]`);
  if ((skill.exclusions?.length ?? 0) > 0) lines.push(`exclusions: [${(skill.exclusions ?? []).map(quoteIfNeeded).join(', ')}]`);
  if ((skill.requiredFilters?.length ?? 0) > 0) lines.push(`required_filters: [${(skill.requiredFilters ?? []).map(quoteIfNeeded).join(', ')}]`);
  if ((skill.clarifyWhen?.length ?? 0) > 0) lines.push(`clarify_when: [${(skill.clarifyWhen ?? []).map(quoteIfNeeded).join(', ')}]`);
  if ((skill.examples?.length ?? 0) > 0) lines.push(`examples: [${(skill.examples ?? []).map(quoteIfNeeded).join(', ')}]`);
  if ((skill.sourceRefs?.length ?? 0) > 0) lines.push(`source_refs: [${(skill.sourceRefs ?? []).map(quoteIfNeeded).join(', ')}]`);
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
  domains?: string[];
  kind?: Skill['kind'];
  status?: Skill['status'];
  owner?: string;
  triggers?: string[];
  exclusions?: string[];
  description?: string;
  preferredMetrics?: string[];
  preferredBlocks?: string[];
  preferredDimensions?: string[];
  requiredFilters?: string[];
  clarifyWhen?: string[];
  examples?: string[];
  sourceRefs?: string[];
  vocabulary?: Record<string, string>;
  body?: string;
  isStarter?: boolean;
}

/** Normalize a partial input into a full Skill (with a resolved sourcePath). */
function toSkill(projectRoot: string, input: WriteSkillInput): Skill {
  // New skills are shared, Git-backed project guidance. Legacy personal skills
  // are retained only for migration and are never written by this path.
  const scope = 'project';
  return {
    id: input.id,
    scope,
    user: undefined,
    domain: input.domain || undefined,
    domains: input.domains?.length ? input.domains : (input.domain ? [input.domain] : []),
    kind: input.kind ?? 'custom',
    status: input.status ?? 'active',
    owner: input.owner,
    triggers: input.triggers ?? [],
    exclusions: input.exclusions ?? [],
    description: input.description,
    preferredMetrics: input.preferredMetrics ?? [],
    preferredBlocks: input.preferredBlocks ?? [],
    preferredDimensions: input.preferredDimensions ?? [],
    requiredFilters: input.requiredFilters ?? [],
    clarifyWhen: input.clarifyWhen ?? [],
    examples: input.examples ?? [],
    sourceRefs: input.sourceRefs ?? [],
    vocabulary: input.vocabulary ?? {},
    body: input.body ?? '',
    sourcePath: skillPath(projectRoot, input.id, input.domains?.length ? input.domains : (input.domain ? [input.domain] : [])),
    isStarter: input.isStarter,
  };
}

/** Write a skill to `skills/<id>.skill.md`, the shared source location. */
export function writeSkill(projectRoot: string, input: WriteSkillInput): Skill {
  const skill = toSkill(projectRoot, input);
  const dir = dirname(skill.sourcePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(skill.sourcePath, renderSkill(skill), 'utf-8');
  return parseSkill(readFileSync(skill.sourcePath, 'utf-8'), skill.sourcePath) ?? skill;
}

/** Alias for `writeSkill` — create-or-update by id. */
export function upsertSkill(projectRoot: string, input: WriteSkillInput): Skill {
  return writeSkill(projectRoot, input);
}

/** Delete a skill from its actual source path. Returns true when a file was removed. */
export function deleteSkill(projectRoot: string, id: string): boolean {
  const existing = loadSkills(projectRoot).skills.find((skill) => skill.id === id);
  const path = existing?.sourcePath ?? skillPath(projectRoot, id);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * Explicit one-way OSS layout upgrade. Moves legacy skills into the visible
 * source tree without overwriting a skill already migrated by a teammate.
 */
export function migrateLegacySkills(projectRoot: string): { moved: string[]; skipped: string[] } {
  const legacyRoot = legacySkillsDir(projectRoot);
  const visibleRoot = skillsDir(projectRoot);
  const moved: string[] = [];
  const skipped: string[] = [];
  for (const source of walkMd(legacyRoot)) {
    const destination = join(visibleRoot, relative(legacyRoot, source));
    if (existsSync(destination)) {
      skipped.push(relative(projectRoot, source));
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(source, destination);
    moved.push(relative(projectRoot, destination));
  }
  return { moved, skipped };
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function pickStringArray(v: unknown): string[] {
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : [];
}

function parseSkillKind(value: string | undefined): Skill['kind'] {
  return ['domain_reference', 'metric_policy', 'glossary', 'analysis_pattern', 'sql_policy', 'custom'].includes(value ?? '')
    ? value as Skill['kind']
    : 'custom';
}

function parseSkillStatus(value: string | undefined): Skill['status'] {
  return ['draft', 'active', 'deprecated'].includes(value ?? '') ? value as Skill['status'] : 'active';
}

function parseSkillFrontmatter(text: string): Record<string, unknown> {
  try {
    const parsed = yaml.load(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return parseMiniYaml(text);
  }
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
    const dimensions = (s.preferredDimensions?.length ?? 0) > 0 ? `\nPreferred dimensions: ${s.preferredDimensions?.join(', ')}` : '';
    const filters = (s.requiredFilters?.length ?? 0) > 0 ? `\nRequired filters: ${s.requiredFilters?.join(', ')}` : '';
    const clarify = (s.clarifyWhen?.length ?? 0) > 0 ? `\nClarify when: ${s.clarifyWhen?.join('; ')}` : '';
    const vocab = Object.keys(s.vocabulary).length > 0
      ? `\nVocabulary: ${Object.entries(s.vocabulary).map(([k, v]) => `"${k}" → ${v}`).join(', ')}`
      : '';
    return `### Skill: ${header}${metrics}${blocks}${dimensions}${filters}${clarify}${vocab}\n\n${s.body}`;
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
  void userId;
  // In-memory callers and older fixture data may not carry the persisted
  // `scope` field. Treat that legacy absence as a project skill; explicitly
  // personal skills remain excluded from OSS agent retrieval.
  return skills.filter((s) => (s.scope ?? 'project') === 'project' && (s.status ?? 'active') === 'active');
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

/** Metric ids a selected skill may prefer, including vocabulary aliases. */
export function buildSkillMetricHints(skills: Skill[], userId: string | null): string[] {
  const hints = new Set<string>();
  for (const skill of activeSkills(skills, userId)) {
    for (const metric of skill.preferredMetrics) if (metric.trim()) hints.add(metric.trim());
    for (const target of Object.values(skill.vocabulary)) {
      const match = target.trim().match(/^metric:(.+)$/i);
      if (match?.[1]?.trim()) hints.add(match[1].trim());
    }
  }
  return Array.from(hints);
}

/** Add governed metric aliases to retrieval text without changing the user request. */
export function expandQuestionWithSkillVocabulary(question: string, skills: Skill[], userId: string | null): string {
  const normalized = question.toLowerCase();
  const additions = new Set<string>();
  for (const skill of activeSkills(skills, userId)) {
    for (const [term, target] of Object.entries(skill.vocabulary)) {
      if (!term || !normalized.includes(term.toLowerCase())) continue;
      const metric = target.trim().match(/^metric:(.+)$/i)?.[1]?.trim();
      if (metric) additions.add(metric);
    }
  }
  return additions.size > 0 ? `${question} ${Array.from(additions).join(' ')}` : question;
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
  /** Domains inferred from the retrieved metadata context for this question. */
  domains?: string[];
}

const DEFAULT_PINNED_SKILL_IDS = ['sql-conventions'];

const SKILL_TOKEN_RE = /[\p{L}\p{N}_]+/gu;

function skillTokens(text: string): string[] {
  return (text.toLowerCase().match(SKILL_TOKEN_RE) ?? []).filter((t) => t.length > 1);
}

/** Searchable text for a skill: domain, id, preferences, vocabulary, and body. */
function skillSearchText(skill: Skill): string {
  return [
    skill.id,
    skill.domain ?? '',
    ...(skill.domains ?? []),
    skill.description ?? '',
    ...(skill.triggers ?? []),
    ...(skill.exclusions ?? []),
    ...skill.preferredMetrics,
    ...skill.preferredBlocks,
    ...(skill.preferredDimensions ?? []),
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
  // One pinned governance/conventions skill plus at most three topical skills is
  // enough context for an answer. The previous default of six let several large
  // domain prompts compete in enterprise repos and diluted the retrieved evidence.
  const budget = Math.max(1, options.budget ?? 4);
  const pinnedIds = new Set((options.pinnedIds ?? DEFAULT_PINNED_SKILL_IDS).map((id) => id.toLowerCase()));
  const queryTokens = new Set(skillTokens(question));
  const domains = new Set((options.domains ?? []).map((domain) => domain.trim().toLowerCase()).filter(Boolean));

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
    const domainMatch = [skill.domain, ...(skill.domains ?? [])].some((domain) => Boolean(domain && domains.has(domain.trim().toLowerCase())));
    // Domain is a strong routing signal, but still requires either an inferred
    // domain match or topical text. It never makes a skill a hard policy override.
    rest.push({ skill, score: hits + (domainMatch ? 4 : 0) });
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
