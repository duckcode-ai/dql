/**
 * Business term writer.
 *
 * Terms teach Ask a project's own words: a synonym such as "sales" maps to the
 * governed metric a term names (`metricRefs`), and business rules and caveats
 * travel with it. Terms were only ever authored by hand in `.dql` files; this
 * module emits a `term` declaration in the exact syntax `parseTermDecl` reads,
 * so the Modeling page's Terms & concepts tab can create and edit them.
 *
 * Convention: `domains/<domain folder>/terms/<slug>.dql`, or `terms/<slug>.dql`
 * for a project-wide term. An existing file is rewritten in place only when it
 * declares exactly this one term — a file holding several terms is left for
 * a person to edit, never partially rewritten.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export interface TermInput {
  name: string;
  domain?: string;
  /** metric | dimension | entity | concept, or free text. */
  termType?: string;
  status?: string;
  description?: string;
  owner?: string;
  businessOwner?: string;
  tags?: string[];
  synonyms?: string[];
  identifiers?: string[];
  /** Governed metrics this word means. */
  metricRefs?: string[];
  businessOutcome?: string;
  decisionUse?: string;
  reviewCadence?: string;
  businessRules?: string[];
  caveats?: string[];
}

export interface WrittenTerm {
  /** Project-relative path of the written file. */
  path: string;
  absPath: string;
}

function escapeString(value: string): string {
  // The DQL lexer reads one-line strings: fold line breaks rather than emit an unterminated literal.
  return value.replace(/\r?\n+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const cleanList = (values?: string[]) => [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
const cleanText = (value?: string) => (value?.trim() ? value.trim() : undefined);

/** Normalize a term name into a file slug. */
export function termFileSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'term';
}

/** Render one `term` declaration that `parseTermDecl` reads back losslessly for the authored fields. */
export function renderTermDeclaration(term: TermInput): string {
  const name = term.name.trim();
  if (!name) throw new Error('A term needs a name.');
  const lines = [`term "${escapeString(name)}" {`];
  const text = (key: string, value?: string) => {
    const clean = cleanText(value);
    if (clean) lines.push(`  ${key} = "${escapeString(clean)}"`);
  };
  const list = (key: string, values?: string[]) => {
    const clean = cleanList(values);
    if (clean.length) lines.push(`  ${key} = [${clean.map((value) => `"${escapeString(value)}"`).join(', ')}]`);
  };
  text('domain', term.domain);
  text('type', term.termType);
  text('status', term.status);
  text('description', term.description);
  text('owner', term.owner);
  text('businessOwner', term.businessOwner);
  list('tags', term.tags);
  list('synonyms', term.synonyms);
  list('identifiers', term.identifiers);
  list('metricRefs', term.metricRefs);
  text('businessOutcome', term.businessOutcome);
  text('decisionUse', term.decisionUse);
  text('reviewCadence', term.reviewCadence);
  list('businessRules', term.businessRules);
  list('caveats', term.caveats);
  lines.push('}');
  return `// dql-format: 1\n\n${lines.join('\n')}\n`;
}

/** How many `term` declarations a source file holds. */
export function countTermDeclarations(source: string): number {
  return source.match(/(^|\n)\s*term\s+"/g)?.length ?? 0;
}

function insideProject(projectRoot: string, path: string): string {
  const root = resolve(projectRoot);
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}/`) && !absolute.startsWith(`${root}\\`)) {
    throw new Error(`Term path ${path} is outside the project.`);
  }
  if (!absolute.endsWith('.dql')) throw new Error(`Term path ${path} is not a .dql file.`);
  return absolute;
}

/**
 * Create or update a term.
 *
 * - `existingPath` (the manifest's `filePath`) updates that file in place, and
 *   refuses when the file declares more than one term.
 * - Otherwise the file is `<directory>/<slug>.dql`, and an existing file there
 *   is never overwritten: two terms must not silently share one file.
 */
export function writeTermDeclaration(
  projectRoot: string,
  term: TermInput,
  options: { directory: string; existingPath?: string },
): WrittenTerm {
  const source = renderTermDeclaration(term);
  let absPath: string;
  if (options.existingPath) {
    absPath = insideProject(projectRoot, options.existingPath);
    if (existsSync(absPath)) {
      const count = countTermDeclarations(readFileSync(absPath, 'utf-8'));
      if (count > 1) throw new Error(`${options.existingPath} declares ${count} terms. Edit that file directly so the other terms are kept.`);
    }
  } else {
    absPath = insideProject(projectRoot, join(options.directory, `${termFileSlug(term.name)}.dql`));
    if (existsSync(absPath)) throw new Error(`A term file already exists at ${relative(projectRoot, absPath)}. Edit that term instead.`);
  }
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, source, 'utf-8');
  return { path: relative(projectRoot, absPath).replace(/\\/g, '/'), absPath };
}

/** Delete a term's file when it declares only that term. */
export function deleteTermDeclaration(projectRoot: string, filePath: string): boolean {
  const absPath = insideProject(projectRoot, filePath);
  if (!existsSync(absPath)) return false;
  const count = countTermDeclarations(readFileSync(absPath, 'utf-8'));
  if (count > 1) throw new Error(`${filePath} declares ${count} terms. Remove the term from that file directly.`);
  rmSync(absPath, { force: true });
  return true;
}
