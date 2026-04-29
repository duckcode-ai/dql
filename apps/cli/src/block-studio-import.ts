import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';

export type BlockStudioImportSourceKind =
  | 'raw-sql-file'
  | 'raw-sql-folder'
  | 'tableau-workbook'
  | 'powerbi-project';

export type BlockStudioImportReviewStatus = 'draft' | 'review' | 'saved' | 'rejected';
export type BlockStudioImportInputMode = 'path' | 'paste' | 'upload';
export type BlockStudioImportSplitStrategy = 'semicolon-go' | 'manual';

export interface BlockStudioImportSource {
  path: string;
  content: string;
}

export interface BlockStudioImportLineage {
  sourceTables: string[];
  parameters: string[];
  warnings: string[];
  statementIndex: number;
  totalStatements: number;
}

export interface BlockStudioAiAssistance {
  action: string;
  summary: string;
  createdAt: string;
  status: 'suggested' | 'accepted' | 'rejected';
  provider?: string;
  patch?: Partial<Pick<BlockStudioImportCandidate, 'name' | 'domain' | 'description' | 'owner' | 'tags' | 'sql' | 'dqlSource'>>;
}

export interface BlockStudioCertificationChecklist {
  metadata: boolean;
  validation: boolean;
  run: boolean;
  tests: boolean;
  chart: boolean;
  lineage: boolean;
  aiReviewed: boolean;
  blockers: string[];
  checkedAt?: string;
}

export interface BlockStudioImportCandidate {
  id: string;
  sourceKind: BlockStudioImportSourceKind;
  sourcePath: string;
  name: string;
  domain: string;
  description: string;
  owner: string;
  tags: string[];
  sql: string;
  dqlSource: string;
  validation: unknown | null;
  preview: unknown | null;
  lineage: BlockStudioImportLineage;
  confidence: number;
  splitStrategy: BlockStudioImportSplitStrategy;
  warnings: string[];
  conversionNotes: string[];
  aiAssistance: BlockStudioAiAssistance[];
  certificationChecklist?: BlockStudioCertificationChecklist;
  reviewStatus: BlockStudioImportReviewStatus;
  savedPath?: string;
}

export interface BlockStudioImportManifest {
  id: string;
  sourceKind: BlockStudioImportSourceKind;
  inputPath: string;
  createdAt: string;
  updatedAt: string;
  inputMode: BlockStudioImportInputMode;
  sourceFiles: string[];
  defaults: {
    domain: string;
    owner: string;
    tags: string[];
  };
  candidateIds: string[];
}

export interface BlockStudioImportSession extends BlockStudioImportManifest {
  candidates: BlockStudioImportCandidate[];
}

export interface BlockStudioImportSessionSummary {
  id: string;
  sourceKind: BlockStudioImportSourceKind;
  inputMode: BlockStudioImportInputMode;
  inputPath: string;
  sourceFiles: string[];
  createdAt: string;
  updatedAt: string;
  defaults: BlockStudioImportManifest['defaults'];
  candidateCount: number;
  savedCount: number;
  rejectedCount: number;
  warningCount: number;
}

export interface CreateBlockStudioImportOptions {
  sourceKind?: BlockStudioImportSourceKind | 'raw-sql';
  inputPath?: string;
  inputMode?: BlockStudioImportInputMode;
  sources?: BlockStudioImportSource[];
  domain?: string;
  owner?: string;
  tags?: string[];
}

interface SqlStatementCandidate {
  sourcePath: string;
  sql: string;
  statementIndex: number;
  totalStatements: number;
  splitStrategy: BlockStudioImportSplitStrategy;
  warnings: string[];
}

interface SqlSource {
  path: string;
  content: string;
}

const SQL_EXTENSIONS = new Set(['.sql']);
const ACTIVE_IMPORT_KINDS = new Set<BlockStudioImportSourceKind>(['raw-sql-file', 'raw-sql-folder']);

export function createBlockStudioImportSession(
  projectRoot: string,
  options: CreateBlockStudioImportOptions,
): BlockStudioImportSession {
  const inputMode = options.inputMode ?? (options.sources?.length ? 'upload' : 'path');
  const sourceBundle = collectSqlSources(projectRoot, options);
  const sourceKind = sourceBundle.sourceKind;
  if (!ACTIVE_IMPORT_KINDS.has(sourceKind)) {
    throw new Error(`${sourceKind} import is planned but not implemented in this build.`);
  }

  const now = new Date().toISOString();
  const defaults = {
    domain: sanitizeDomain(options.domain || 'imported'),
    owner: options.owner?.trim() ?? '',
    tags: normalizeTags(['imported', 'raw-sql', ...(options.tags ?? [])]),
  };
  const statements = collectSqlStatements(sourceBundle.sources);
  const importId = buildImportId(sourceKind, sourceBundle.inputPath, now);
  const candidates = statements.map((statement) => buildSqlCandidate({
    importId,
    sourceKind,
    projectRoot,
    statement,
    defaults,
  }));
  const manifest: BlockStudioImportManifest = {
    id: importId,
    sourceKind,
    inputPath: sourceBundle.inputPath,
    inputMode,
    sourceFiles: sourceBundle.sources.map((source) => source.path),
    createdAt: now,
    updatedAt: now,
    defaults,
    candidateIds: candidates.map((candidate) => candidate.id),
  };
  const session = { ...manifest, candidates };
  writeBlockStudioImportSession(projectRoot, session);
  return session;
}

export function loadBlockStudioImportSession(projectRoot: string, importId: string): BlockStudioImportSession {
  const root = importRoot(projectRoot, importId);
  const manifestPath = join(root, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`Import session not found: ${importId}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as BlockStudioImportManifest;
  const candidates = manifest.candidateIds.map((candidateId) => readBlockStudioImportCandidate(projectRoot, importId, candidateId));
  return { ...manifest, candidates };
}

export function listBlockStudioImportSessions(projectRoot: string): BlockStudioImportSessionSummary[] {
  const root = join(projectRoot, '.dql', 'imports');
  if (!existsSync(root)) return [];
  const summaries: BlockStudioImportSessionSummary[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const session = loadBlockStudioImportSession(projectRoot, entry.name);
      summaries.push({
        id: session.id,
        sourceKind: session.sourceKind,
        inputMode: session.inputMode ?? 'path',
        inputPath: session.inputPath,
        sourceFiles: session.sourceFiles ?? [],
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        defaults: session.defaults,
        candidateCount: session.candidates.length,
        savedCount: session.candidates.filter((candidate) => candidate.reviewStatus === 'saved').length,
        rejectedCount: session.candidates.filter((candidate) => candidate.reviewStatus === 'rejected').length,
        warningCount: session.candidates.reduce((sum, candidate) => sum + (candidate.warnings?.length ?? candidate.lineage.warnings.length), 0),
      });
    } catch {
      // Ignore partial sessions so one bad cache entry does not break Imports.
    }
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deleteBlockStudioImportSession(projectRoot: string, importId: string): void {
  rmSync(importRoot(projectRoot, importId), { recursive: true, force: true });
}

export function clearBlockStudioImportSessions(projectRoot: string): number {
  const root = join(projectRoot, '.dql', 'imports');
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!/^imp_[A-Za-z0-9_-]+$/.test(entry.name)) continue;
    rmSync(join(root, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export function writeBlockStudioImportSession(projectRoot: string, session: BlockStudioImportSession): void {
  const root = importRoot(projectRoot, session.id);
  const candidatesDir = join(root, 'candidates');
  mkdirSync(candidatesDir, { recursive: true });
  const manifest: BlockStudioImportManifest = {
    id: session.id,
    sourceKind: session.sourceKind,
    inputPath: session.inputPath,
    inputMode: session.inputMode ?? 'path',
    sourceFiles: session.sourceFiles ?? [],
    createdAt: session.createdAt,
    updatedAt: new Date().toISOString(),
    defaults: session.defaults,
    candidateIds: session.candidates.map((candidate) => candidate.id),
  };
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  for (const candidate of session.candidates) {
    writeBlockStudioImportCandidate(projectRoot, session.id, candidate);
  }
}

export function writeBlockStudioImportCandidate(
  projectRoot: string,
  importId: string,
  candidate: BlockStudioImportCandidate,
): void {
  const candidatesDir = join(importRoot(projectRoot, importId), 'candidates');
  mkdirSync(candidatesDir, { recursive: true });
  writeFileSync(join(candidatesDir, `${candidate.id}.json`), JSON.stringify(candidate, null, 2) + '\n', 'utf-8');
}

export function readBlockStudioImportCandidate(
  projectRoot: string,
  importId: string,
  candidateId: string,
): BlockStudioImportCandidate {
  const candidatePath = join(importRoot(projectRoot, importId), 'candidates', `${candidateId}.json`);
  if (!existsSync(candidatePath)) throw new Error(`Import candidate not found: ${candidateId}`);
  return JSON.parse(readFileSync(candidatePath, 'utf-8')) as BlockStudioImportCandidate;
}

export function updateBlockStudioImportCandidate(
  projectRoot: string,
  importId: string,
  candidateId: string,
  patch: Partial<Pick<BlockStudioImportCandidate, 'name' | 'domain' | 'description' | 'owner' | 'tags' | 'sql' | 'reviewStatus'>>,
): BlockStudioImportCandidate {
  const candidate = readBlockStudioImportCandidate(projectRoot, importId, candidateId);
  const next: BlockStudioImportCandidate = { ...candidate };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.domain !== undefined) next.domain = sanitizeDomain(patch.domain);
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.owner !== undefined) next.owner = patch.owner;
  if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags);
  if (patch.sql !== undefined) next.sql = patch.sql;
  if (patch.reviewStatus !== undefined) next.reviewStatus = patch.reviewStatus;
  if (patch.name || patch.domain || patch.description || patch.owner || patch.tags || patch.sql) {
    next.dqlSource = candidateToDqlSource(next);
    next.lineage = {
      ...next.lineage,
      sourceTables: extractSourceTables(next.sql),
      parameters: extractSqlParameters(next.sql),
      warnings: analyzeSqlWarnings(next.sql, next.lineage.totalStatements),
    };
    next.warnings = next.lineage.warnings;
    next.confidence = scoreSqlCandidate(next.sql, next.lineage);
  }
  writeBlockStudioImportCandidate(projectRoot, importId, next);
  return next;
}

export function candidateToDqlSource(candidate: Pick<BlockStudioImportCandidate, 'name' | 'domain' | 'description' | 'owner' | 'tags' | 'sql'>): string {
  const tags = normalizeTags(candidate.tags).map((tag) => dqlString(tag)).join(', ');
  const sql = candidate.sql.trim().replace(/"""/g, '\\"\\"\\"');
  return `block ${dqlString(candidate.name)} {
    status = "draft"
    domain = ${dqlString(sanitizeDomain(candidate.domain))}
    type = "custom"
    description = ${dqlString(candidate.description)}
    tags = [${tags}]
    owner = ${dqlString(candidate.owner)}

    query = """
${sql}
    """

    visualization {
        chart = "table"
    }

    tests {
        assert row_count > 0
    }
}
`;
}

function collectSqlStatements(sources: SqlSource[]): SqlStatementCandidate[] {
  const statements: SqlStatementCandidate[] = [];
  for (const source of sources) {
    const split = splitSqlStatements(source.content);
    const sharedWarnings = split.length === 1 ? analyzeSqlWarnings(split[0], split.length) : [];
    split.forEach((sql, index) => {
      statements.push({
        sourcePath: source.path,
        sql,
        statementIndex: index + 1,
        totalStatements: split.length,
        splitStrategy: 'semicolon-go',
        warnings: index === 0 ? sharedWarnings : [],
      });
    });
  }
  if (statements.length === 0) throw new Error('No SQL statements found to import.');
  return statements;
}

function buildSqlCandidate(options: {
  importId: string;
  sourceKind: BlockStudioImportSourceKind;
  projectRoot: string;
  statement: SqlStatementCandidate;
  defaults: { domain: string; owner: string; tags: string[] };
}): BlockStudioImportCandidate {
  const statement = options.statement;
  const sourcePath = displayPath(options.projectRoot, statement.sourcePath);
  const metadata = extractStatementMetadata(statement.sql);
  const baseName = metadata.name || basename(statement.sourcePath, extname(statement.sourcePath));
  const name = statement.totalStatements > 1
    ? `${baseName} ${statement.statementIndex}`
    : baseName;
  const sourceTables = extractSourceTables(statement.sql);
  const parameters = extractSqlParameters(statement.sql);
  const warnings = [
    ...(parameters.length > 0 ? [`Contains parameters: ${parameters.join(', ')}`] : []),
    ...(statement.sql.includes('"""') ? ['SQL contains triple quotes that were escaped in the DQL draft.'] : []),
    ...statement.warnings,
  ];
  const lineage: BlockStudioImportLineage = {
    sourceTables,
    parameters,
    warnings,
    statementIndex: statement.statementIndex,
    totalStatements: statement.totalStatements,
  };
  const candidate: BlockStudioImportCandidate = {
    id: buildCandidateId(sourcePath, statement.statementIndex, statement.sql),
    sourceKind: options.sourceKind,
    sourcePath,
    name: titleizeName(name),
    domain: metadata.domain ? sanitizeDomain(metadata.domain) : options.defaults.domain,
    description: metadata.description || `Imported from ${sourcePath}`,
    owner: options.defaults.owner,
    tags: normalizeTags([...options.defaults.tags, ...metadata.tags]),
    sql: statement.sql.trim(),
    dqlSource: '',
    validation: null,
    preview: null,
    lineage,
    confidence: scoreSqlCandidate(statement.sql, lineage),
    splitStrategy: statement.splitStrategy,
    warnings,
    conversionNotes: [
      'Deterministic SQL extraction created this DQL draft locally.',
      'Name, description, domain, and tags come from leading SQL comments when present; otherwise DQL uses the source path and import defaults.',
      'The SQL statement is wrapped into query = """ ... """ without LLM rewriting.',
      'Visualization defaults to table until a reviewer chooses a chart type.',
      'The default test is assert row_count > 0.',
      'Optional AI assist is review-gated and only receives this candidate context.',
    ],
    aiAssistance: [],
    reviewStatus: 'review',
  };
  candidate.dqlSource = candidateToDqlSource(candidate);
  return candidate;
}

function splitSqlStatements(source: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let single = false;
  let double = false;
  let backtick = false;
  let lineComment = false;
  let blockComment = false;
  let dollarQuote: string | null = null;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (dollarQuote) {
      if (source.startsWith(dollarQuote, i)) {
        i += dollarQuote.length - 1;
        dollarQuote = null;
      }
      continue;
    }

    if (!single && !double && !backtick) {
      if (char === '-' && next === '-') {
        lineComment = true;
        i += 1;
        continue;
      }
      if (char === '/' && next === '*') {
        blockComment = true;
        i += 1;
        continue;
      }
      if (char === '$') {
        const tag = source.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
        if (tag) {
          dollarQuote = tag;
          i += tag.length - 1;
          continue;
        }
      }
    }

    if (!double && !backtick && char === "'" && source[i - 1] !== '\\') single = !single;
    else if (!single && !backtick && char === '"' && source[i - 1] !== '\\') double = !double;
    else if (!single && !double && char === '`') backtick = !backtick;

    if (!single && !double && !backtick) {
      const goMatch = matchGoBatchSeparator(source, i);
      if (goMatch) {
        const statement = source.slice(start, i).trim();
        if (statement) statements.push(statement);
        start = goMatch.end;
        i = goMatch.end - 1;
        continue;
      }
    }

    if (!single && !double && !backtick && char === ';') {
      const statement = source.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }

  const trailing = source.slice(start).trim();
  if (trailing) statements.push(trailing);
  return statements;
}

function matchGoBatchSeparator(source: string, index: number): { end: number } | null {
  const char = source[index];
  if (char !== 'g' && char !== 'G') return null;
  const lineStart = Math.max(source.lastIndexOf('\n', index - 1) + 1, 0);
  if (source.slice(lineStart, index).trim()) return null;
  const rest = source.slice(index);
  const match = rest.match(/^go(?:\s+\d+)?\s*(?:--[^\r\n]*)?(?:\r?\n|$)/i);
  if (!match) return null;
  return { end: index + match[0].length };
}

function analyzeSqlWarnings(sql: string, totalStatements: number): string[] {
  const warnings: string[] = [];
  if (totalStatements === 1) {
    const cleaned = stripSqlComments(sql);
    const starts = cleaned.match(/\b(?:select|with)\b/gi) ?? [];
    if (starts.length > 1) {
      warnings.push('Only one candidate was created, but multiple SELECT/WITH clauses were detected. Add semicolons, GO batch separators, or split manually if this file contains multiple scripts.');
    }
  }
  return warnings;
}

function extractStatementMetadata(sql: string): { name: string; description: string; domain: string; tags: string[] } {
  const leading = sql.split(/\r?\n/).slice(0, 12).join('\n');
  const name = leading.match(/(?:--|\/\*)\s*(?:name|block)\s*:\s*([^*\n]+)/i)?.[1]?.trim() ?? '';
  const description = leading.match(/(?:--|\/\*)\s*(?:description|desc)\s*:\s*([^*\n]+)/i)?.[1]?.trim() ?? '';
  const domain = leading.match(/(?:--|\/\*)\s*domain\s*:\s*([^*\n]+)/i)?.[1]?.trim() ?? '';
  const tagText = leading.match(/(?:--|\/\*)\s*tags?\s*:\s*([^*\n]+)/i)?.[1]?.trim() ?? '';
  const tags = normalizeTags(tagText ? tagText.split(',') : []);
  if (description) return { name, description, domain, tags };
  const firstComment = leading.match(/^\s*--\s*(?!name\s*:|block\s*:)(.+)$/im)?.[1]?.trim() ?? '';
  return { name, description: firstComment, domain, tags };
}

function extractSourceTables(sql: string): string[] {
  const tables = new Set<string>();
  const cleaned = stripSqlComments(sql);
  const regex = /\b(?:from|join|update|into)\s+([`"[]?[A-Za-z0-9_./:-]+(?:\.[A-Za-z0-9_./:-]+)*[`"\]]?)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleaned))) {
    const raw = match[1].replace(/^[`"[]|[`"\]]$/g, '');
    if (!raw || raw.startsWith('(')) continue;
    if (/^(select|values|unnest|lateral)$/i.test(raw)) continue;
    tables.add(raw);
  }
  return Array.from(tables);
}

function extractSqlParameters(sql: string): string[] {
  const params = new Set<string>();
  const cleaned = stripSqlComments(sql);
  let match: RegExpExecArray | null;
  const handlebars = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;
  while ((match = handlebars.exec(cleaned))) params.add(match[1]);
  const colon = /(^|[^:]):([A-Za-z_][A-Za-z0-9_]*)\b/g;
  while ((match = colon.exec(cleaned))) params.add(match[2]);
  const dollar = /(^|[^$])\$([A-Za-z_][A-Za-z0-9_]*)\b/g;
  while ((match = dollar.exec(cleaned))) params.add(match[2]);
  return Array.from(params);
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ');
}

function scoreSqlCandidate(sql: string, lineage: BlockStudioImportLineage): number {
  let score = /\bselect\b/i.test(sql) ? 0.76 : 0.62;
  if (lineage.sourceTables.length > 0) score += 0.1;
  if (/\bgroup\s+by\b/i.test(sql)) score += 0.04;
  if (lineage.parameters.length > 0) score -= 0.12;
  if (lineage.totalStatements > 1) score -= 0.03;
  return Math.max(0.35, Math.min(0.92, Number(score.toFixed(2))));
}

function walkSqlFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.dql') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && SQL_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(full);
    }
  }
  return files.sort();
}

function collectSqlSources(projectRoot: string, options: CreateBlockStudioImportOptions): {
  sourceKind: BlockStudioImportSourceKind;
  inputPath: string;
  sources: SqlSource[];
} {
  if (options.sources?.length) {
    const sources = options.sources
      .map((source, index) => ({
        path: sanitizeSourcePath(source.path || `pasted-${index + 1}.sql`),
        content: source.content ?? '',
      }))
      .filter((source) => source.content.trim().length > 0);
    if (sources.length === 0) throw new Error('No SQL content was provided.');
    return {
      sourceKind: sources.length > 1 ? 'raw-sql-folder' : 'raw-sql-file',
      inputPath: options.inputMode === 'paste' ? 'pasted SQL' : `${sources.length} uploaded SQL file(s)`,
      sources,
    };
  }

  const inputPath = resolveInputPath(projectRoot, options.inputPath ?? '');
  const sourceKind = resolveSourceKind(inputPath, options.sourceKind);
  const stats = statSync(inputPath);
  const files = stats.isDirectory() ? walkSqlFiles(inputPath) : [inputPath];
  if (files.length === 0) throw new Error('No .sql files found to import.');
  return {
    sourceKind,
    inputPath: displayPath(projectRoot, inputPath),
    sources: files.map((file) => ({
      path: displayPath(projectRoot, file),
      content: readFileSync(file, 'utf-8'),
    })),
  };
}

function sanitizeSourcePath(path: string): string {
  const clean = path.replaceAll('\\', '/').replace(/^\/+/, '').trim();
  return clean.endsWith('.sql') ? clean : `${clean || 'pasted'}.sql`;
}

function resolveInputPath(projectRoot: string, inputPath: string): string {
  if (!inputPath.trim()) throw new Error('Import path is required.');
  const resolved = resolve(projectRoot, inputPath);
  if (!existsSync(resolved)) throw new Error(`Import path not found: ${inputPath}`);
  return resolved;
}

function resolveSourceKind(inputPath: string, requested?: CreateBlockStudioImportOptions['sourceKind']): BlockStudioImportSourceKind {
  if (requested && requested !== 'raw-sql') return requested;
  const stats = statSync(inputPath);
  if (stats.isDirectory()) return 'raw-sql-folder';
  if (extname(inputPath).toLowerCase() === '.sql') return 'raw-sql-file';
  throw new Error('Only .sql files and folders are supported in this import build.');
}

function importRoot(projectRoot: string, importId: string): string {
  if (!/^imp_[A-Za-z0-9_-]+$/.test(importId)) {
    throw new Error(`Invalid import session id: ${importId}`);
  }
  return join(projectRoot, '.dql', 'imports', importId);
}

function buildImportId(sourceKind: string, inputPath: string, createdAt: string): string {
  const hash = createHash('sha1').update(`${sourceKind}:${inputPath}:${createdAt}:${randomUUID()}`).digest('hex').slice(0, 10);
  return `imp_${hash}`;
}

function buildCandidateId(sourcePath: string, statementIndex: number, sql: string): string {
  const hash = createHash('sha1').update(`${sourcePath}:${statementIndex}:${sql}`).digest('hex').slice(0, 12);
  return `cand_${hash}`;
}

function displayPath(projectRoot: string, absPath: string): string {
  const rel = relative(projectRoot, absPath).replaceAll('\\', '/');
  return rel && !rel.startsWith('..') ? rel : absPath.replaceAll('\\', '/');
}

function sanitizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^\/+|\/+$/g, '') || 'imported';
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)));
}

function titleizeName(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || 'Imported Query';
}

function dqlString(value: string): string {
  return JSON.stringify(value ?? '');
}
