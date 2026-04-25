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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

export interface Skill {
  id: string;
  /** Optional user this skill is bound to. Empty = project-level skill. */
  user?: string;
  description?: string;
  preferredMetrics: string[];
  preferredBlocks: string[];
  vocabulary: Record<string, string>;
  /** Markdown body (everything after the closing `---`). */
  body: string;
  sourcePath: string;
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
  return {
    id,
    user: pickString(meta.user),
    description: pickString(meta.description),
    preferredMetrics: pickStringArray(meta.preferred_metrics),
    preferredBlocks: pickStringArray(meta.preferred_blocks),
    vocabulary: pickStringMap(meta.vocabulary),
    body,
    sourcePath: path,
  };
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
  const relevant = skills.filter((s) => !s.user || s.user === userId);
  if (relevant.length === 0) return '';
  const sections = relevant.map((s) => {
    const header = s.description ? `${s.id} — ${s.description}` : s.id;
    const metrics = s.preferredMetrics.length > 0 ? `\nPreferred metrics: ${s.preferredMetrics.join(', ')}` : '';
    const vocab = Object.keys(s.vocabulary).length > 0
      ? `\nVocabulary: ${Object.entries(s.vocabulary).map(([k, v]) => `"${k}" → ${v}`).join(', ')}`
      : '';
    return `### Skill: ${header}${metrics}${vocab}\n\n${s.body}`;
  });
  return `## Active Skills\n\n${sections.join('\n\n')}\n`;
}
