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
export type BlockStudioImportSplitStrategy = 'semicolon-go' | 'metadata-comment' | 'manual';

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
  patch?: Partial<Pick<BlockStudioImportCandidate, 'name' | 'domain' | 'description' | 'owner' | 'tags' | 'pattern' | 'grain' | 'entities' | 'outputs' | 'allowedFilters' | 'sourceSystems' | 'replacementFor' | 'sql' | 'dqlSource'>>;
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

export interface DqlGenerationEvidence {
  kind: 'dql_block' | 'dql_term' | 'business_view' | 'domain' | 'semantic_metric' | 'semantic_model' | 'dbt_model' | 'warehouse_table' | 'datalex_contract' | 'datalex_entity' | 'datalex_domain' | 'metadata' | 'lineage';
  name: string;
  description?: string;
  objectKey?: string;
  source?: string;
  reason?: string;
  confidence?: number;
}

export interface BlockDraftSaveState {
  status: 'pending' | 'saved' | 'error';
  path?: string;
  savedAt?: string;
  error?: string;
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
  pattern?: string;
  grain?: string;
  entities?: string[];
  outputs?: string[];
  allowedFilters?: string[];
  sourceSystems?: string[];
  replacementFor?: string[];
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
  generationMode?: 'ai' | 'deterministic';
  generationProvider?: string;
  llmContext?: string;
  evidence?: DqlGenerationEvidence[];
  draftSave?: BlockDraftSaveState;
}

export type DqlGenerationCandidate = BlockStudioImportCandidate & {
  generationMode: 'ai' | 'deterministic';
  generationProvider: string;
  llmContext: string;
  evidence: DqlGenerationEvidence[];
  draftSave: BlockDraftSaveState;
};

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

export interface DqlGenerationSession extends Omit<BlockStudioImportSession, 'candidates'> {
  mode: 'ai-import';
  generation: {
    provider: string;
    aiEnabled: boolean;
    contextObjectCount: number;
    createdDrafts: number;
    warnings: string[];
  };
  candidates: DqlGenerationCandidate[];
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
  patch: Partial<Pick<BlockStudioImportCandidate, 'name' | 'domain' | 'description' | 'owner' | 'tags' | 'pattern' | 'grain' | 'entities' | 'outputs' | 'allowedFilters' | 'sourceSystems' | 'replacementFor' | 'sql' | 'reviewStatus' | 'llmContext' | 'evidence' | 'draftSave' | 'generationMode' | 'generationProvider' | 'savedPath' | 'conversionNotes'>>,
): BlockStudioImportCandidate {
  const candidate = readBlockStudioImportCandidate(projectRoot, importId, candidateId);
  const next: BlockStudioImportCandidate = { ...candidate };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.domain !== undefined) next.domain = sanitizeDomain(patch.domain);
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.owner !== undefined) next.owner = patch.owner;
  if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags);
  if (patch.pattern !== undefined) next.pattern = normalizePattern(patch.pattern);
  if (patch.grain !== undefined) next.grain = patch.grain;
  if (patch.entities !== undefined) next.entities = normalizeStringList(patch.entities);
  if (patch.outputs !== undefined) next.outputs = normalizeStringList(patch.outputs);
  if (patch.allowedFilters !== undefined) next.allowedFilters = normalizeStringList(patch.allowedFilters);
  if (patch.sourceSystems !== undefined) next.sourceSystems = normalizeStringList(patch.sourceSystems);
  if (patch.replacementFor !== undefined) next.replacementFor = normalizeStringList(patch.replacementFor);
  if (patch.sql !== undefined) next.sql = patch.sql;
  if (patch.reviewStatus !== undefined) next.reviewStatus = patch.reviewStatus;
  if (patch.llmContext !== undefined) next.llmContext = patch.llmContext;
  if (patch.evidence !== undefined) next.evidence = patch.evidence;
  if (patch.draftSave !== undefined) next.draftSave = patch.draftSave;
  if (patch.generationMode !== undefined) next.generationMode = patch.generationMode;
  if (patch.generationProvider !== undefined) next.generationProvider = patch.generationProvider;
  if (patch.savedPath !== undefined) next.savedPath = patch.savedPath;
  if (patch.conversionNotes !== undefined) next.conversionNotes = patch.conversionNotes;
  if (patch.name || patch.domain || patch.description || patch.owner || patch.tags || patch.pattern || patch.grain || patch.entities || patch.outputs || patch.allowedFilters || patch.sourceSystems || patch.replacementFor || patch.sql || patch.llmContext) {
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

export function candidateToDqlSource(candidate: Pick<BlockStudioImportCandidate, 'name' | 'domain' | 'description' | 'owner' | 'tags' | 'pattern' | 'grain' | 'entities' | 'outputs' | 'allowedFilters' | 'sourceSystems' | 'replacementFor' | 'sql' | 'llmContext'>): string {
  const tags = normalizeTags(candidate.tags).map((tag) => dqlString(tag)).join(', ');
  const sql = candidate.sql.trim().replace(/"""/g, '\\"\\"\\"');
  const llmContext = candidate.llmContext?.trim();
  const pattern = normalizePattern(candidate.pattern || inferSqlPattern(candidate.sql));
  const grain = candidate.grain?.trim() || inferSqlGrain(candidate.sql);
  const outputs = normalizeStringList(candidate.outputs?.length ? candidate.outputs : inferSqlOutputs(candidate.sql)).slice(0, 24);
  const sourceSystems = normalizeStringList(candidate.sourceSystems?.length ? candidate.sourceSystems : inferSqlSourceSystems(candidate.sql)).slice(0, 12);
  const entities = normalizeStringList(candidate.entities?.length ? candidate.entities : inferSqlEntities(grain, sourceSystems)).slice(0, 12);
  const allowedFilters = normalizeStringList(candidate.allowedFilters?.length ? candidate.allowedFilters : inferSqlFilters(candidate.sql)).slice(0, 16);
  return `block ${dqlString(candidate.name)} {
    status = "draft"
    domain = ${dqlString(sanitizeDomain(candidate.domain))}
    type = "custom"
    description = ${dqlString(candidate.description)}
    tags = [${tags}]
    owner = ${dqlString(candidate.owner)}
${pattern ? `    pattern = ${dqlString(pattern)}\n` : ''}${grain ? `    grain = ${dqlString(grain)}\n` : ''}${entities.length > 0 ? `    entities = [${entities.map(dqlString).join(', ')}]\n` : ''}${outputs.length > 0 ? `    outputs = [${outputs.map(dqlString).join(', ')}]\n` : ''}${allowedFilters.length > 0 ? `    allowedFilters = [${allowedFilters.map(dqlString).join(', ')}]\n` : ''}${sourceSystems.length > 0 ? `    sourceSystems = [${sourceSystems.map(dqlString).join(', ')}]\n` : ''}${candidate.replacementFor?.length ? `    replacementFor = [${candidate.replacementFor.map(dqlString).join(', ')}]\n` : ''}
${llmContext ? `    llmContext = ${dqlString(llmContext)}\n` : ''}

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

function inferSqlGrain(sql: string): string {
  const groupFields = extractGroupByFields(sql);
  return groupFields[0] ?? '';
}

function inferSqlPattern(sql: string): string {
  const lower = stripSqlComments(sql).toLowerCase();
  const groupFields = extractGroupByFields(sql);
  if (/@metric\s*\(/i.test(sql)) return 'metric_wrapper';
  if (/\bjoin\b/i.test(sql)) {
    const systems = new Set(inferSqlSourceSystems(sql));
    if (systems.size > 1) return 'bridge';
  }
  if (/\border\s+by\b[\s\S]*\blimit\s+\d+/i.test(sql)) return 'ranking';
  if (groupFields.some((field) => /\b(date|day|week|month|quarter|year|period|time)\b/i.test(field))) return 'trend';
  if (groupFields.length === 1 && /_id$|_key$/i.test(groupFields[0])) return 'entity_rollup';
  if (!/\b(sum|count|avg|min|max|median|percentile|rank)\s*\(/i.test(lower) && /\b(dim|profile|customer|account|player|product|user|entity)\b/i.test(lower)) {
    return 'entity_profile';
  }
  return 'custom';
}

function inferSqlOutputs(sql: string): string[] {
  const selectMatch = sql.match(/\bselect\b([\s\S]+?)\bfrom\b/i);
  if (!selectMatch) return [];
  return splitSqlList(selectMatch[1])
    .map((expr) => {
      const alias = expr.match(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)\b/i)?.[1]
        ?? expr.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/)?.[1]
        ?? '';
      return alias.replace(/[`"[\]]/g, '');
    })
    .filter(Boolean)
    .filter((name) => !/^(from|where|group|order|limit)$/i.test(name));
}

function inferSqlFilters(sql: string): string[] {
  const filters = new Set<string>();
  const where = sql.match(/\bwhere\b([\s\S]+?)(?:\bgroup\s+by\b|\border\s+by\b|\blimit\b|$)/i)?.[1] ?? '';
  const addFilter = (value: string | undefined) => {
    const name = value?.split('.').pop()?.replace(/[`"[\]]/g, '');
    if (name && !/^(and|or|not|null|year|month|day)$/i.test(name)) filters.add(name);
  };
  const extractRegex = /\bextract\s*\([^)]*\bfrom\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*(?:=|<>|!=|>|<|>=|<=|\bin\b|\blike\b)/gi;
  const isNullRegex = /\b([A-Za-z_][A-Za-z0-9_.]*)\s+is\s+(?:not\s+)?null\b/gi;
  const regex = /\b([A-Za-z_][A-Za-z0-9_.]*)\s*(?:=|<>|!=|>|<|>=|<=|\bin\b|\blike\b)/gi;
  let match: RegExpExecArray | null;
  while ((match = extractRegex.exec(where))) addFilter(match[1]);
  while ((match = isNullRegex.exec(where))) addFilter(match[1]);
  while ((match = regex.exec(where))) {
    addFilter(match[1]);
  }
  return [...filters];
}

function inferSqlSourceSystems(sql: string): string[] {
  return extractSourceTables(sql)
    .map((table) => table.split('.').filter(Boolean).slice(-2, -1)[0] ?? table.split('.').filter(Boolean)[0])
    .filter(Boolean)
    .map((value) => businessToken(value))
    .filter(Boolean);
}

function inferSqlEntities(grain: string, sourceSystems: string[]): string[] {
  const entity = grain && /_id$|_key$/i.test(grain) ? businessEntityFromIdentifier(grain) : '';
  return Array.from(new Set([entity, ...sourceSystems.map(businessEntityFromIdentifier)].filter(Boolean)));
}

function extractGroupByFields(sql: string): string[] {
  const match = sql.match(/\bgroup\s+by\b([\s\S]+?)(?:\border\s+by\b|\blimit\b|\bqualify\b|\bhaving\b|$)/i);
  if (!match) return [];
  return splitSqlList(match[1])
    .map((item) => item.replace(/[`"[\]]/g, '').trim())
    .filter((item) => item && !/^\d+$/.test(item))
    .map((item) => item.split('.').pop() ?? item)
    .slice(0, 4);
}

function splitSqlList(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let single = false;
  let double = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (!double && char === "'" && value[i - 1] !== '\\') single = !single;
    else if (!single && char === '"' && value[i - 1] !== '\\') double = !double;
    else if (!single && !double && char === '(') depth += 1;
    else if (!single && !double && char === ')' && depth > 0) depth -= 1;
    else if (!single && !double && depth === 0 && char === ',') {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function collectSqlStatements(sources: SqlSource[]): SqlStatementCandidate[] {
  const statements: SqlStatementCandidate[] = [];
  for (const source of sources) {
    const split = splitSqlStatements(source.content);
    const executableStatements = split.statements.filter(hasExecutableSql);
    const sharedWarnings = executableStatements.length === 1 ? analyzeSqlWarnings(executableStatements[0], executableStatements.length) : [];
    executableStatements.forEach((sql, index) => {
      statements.push({
        sourcePath: source.path,
        sql,
        statementIndex: index + 1,
        totalStatements: executableStatements.length,
        splitStrategy: split.strategy,
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
  const sourceTables = extractSourceTables(statement.sql);
  const inferred = metadata.name ? null : inferStatementBusinessMetadata(statement.sql, sourcePath, sourceTables);
  const baseName = metadata.name || inferred?.name || basename(statement.sourcePath, extname(statement.sourcePath));
  const name = statement.totalStatements > 1 && !metadata.name
    ? `${baseName} ${statement.statementIndex}`
    : baseName;
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
    description: metadata.description || inferred?.description || `Imported from ${sourcePath}`,
    owner: options.defaults.owner,
    tags: normalizeTags([...options.defaults.tags, ...metadata.tags, ...(inferred?.tags ?? [])]),
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
      'Multiple scripts in one file are split by semicolon, GO batch separator, or repeated name/title header comments.',
      'The SQL statement is wrapped into query = """ ... """ without LLM rewriting.',
      'Visualization defaults to table until a reviewer chooses a chart type.',
      'The default test is assert row_count > 0.',
      'Optional AI assist is review-gated and only receives this candidate context.',
    ],
    aiAssistance: [],
    reviewStatus: 'draft',
  };
  candidate.dqlSource = candidateToDqlSource(candidate);
  return candidate;
}

function splitSqlStatements(source: string): { statements: string[]; strategy: BlockStudioImportSplitStrategy } {
  const semicolonStatements = splitSqlBySemicolonAndGo(source);
  if (semicolonStatements.length > 1) {
    return { statements: semicolonStatements, strategy: 'semicolon-go' };
  }
  const metadataStatements = splitSqlByMetadataHeaders(source);
  if (metadataStatements.length > 1) {
    return { statements: metadataStatements, strategy: 'metadata-comment' };
  }
  return { statements: semicolonStatements, strategy: 'semicolon-go' };
}

function splitSqlBySemicolonAndGo(source: string): string[] {
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

function splitSqlByMetadataHeaders(source: string): string[] {
  const chunks: string[] = [];
  const lines = source.split(/\r?\n/);
  let current: string[] = [];
  const flush = () => {
    const chunk = current.join('\n').trim();
    if (chunk) chunks.push(chunk);
    current = [];
  };

  for (const line of lines) {
    const isHeader = /^\s*(?:--|\/\*)\s*(?:name|block|title|query)\s*:/i.test(line);
    if (isHeader && current.some((item) => stripSqlComments(item).trim().length > 0)) {
      flush();
    }
    current.push(line);
  }
  flush();
  return chunks.filter((chunk) => /\b(select|with)\b/i.test(stripSqlComments(chunk)));
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
  const name = leading.match(/(?:--|\/\*)\s*(?:name|block|title|query)\s*:\s*([^*\n]+)/i)?.[1]?.trim() ?? '';
  const description = leading.match(/(?:--|\/\*)\s*(?:description|desc)\s*:\s*([^*\n]+)/i)?.[1]?.trim() ?? '';
  const domain = leading.match(/(?:--|\/\*)\s*domain\s*:\s*([^*\n]+)/i)?.[1]?.trim() ?? '';
  const tagText = leading.match(/(?:--|\/\*)\s*tags?\s*:\s*([^*\n]+)/i)?.[1]?.trim() ?? '';
  const tags = normalizeTags(tagText ? tagText.split(',') : []);
  if (description) return { name, description, domain, tags };
  const firstComment = leading.match(/^\s*--\s*(?!name\s*:|block\s*:)(.+)$/im)?.[1]?.trim() ?? '';
  return { name, description: firstComment, domain, tags };
}

function inferStatementBusinessMetadata(sql: string, sourcePath: string, sourceTables: string[]): { name: string; description: string; tags: string[] } {
  const expressions = extractSelectExpressions(sql);
  const aggregateAliases = expressions.filter(isAggregateExpression).map(extractExpressionAlias).filter(Boolean);
  const dimensionAliases = expressions.filter((expression) => !isAggregateExpression(expression)).map(extractExpressionAlias).filter(Boolean);
  const orderByAliases = extractOrderByAliases(sql);
  const metric = aggregateAliases[0] || orderByAliases.find((alias) => /total|sum|count|avg|score|point|revenue|amount|sales|games?/i.test(alias)) || aggregateAliases[0] || '';
  const dimension = dimensionAliases.find((alias) => !/^row_?number$/i.test(alias)) || '';
  const years = extractYearFilters(sql);
  const tableLabel = sourceTables[0] || sourcePath;
  const tableEntity = businessEntityFromIdentifier(tableLabel.split('.').pop() || tableLabel);
  const metricLabel = metric ? titleizeName(metric) : '';
  const pluralDimension = dimension ? pluralizeBusinessEntity(businessEntityFromIdentifier(dimension)) : pluralizeBusinessEntity(tableEntity);
  const yearLabel = years.length === 1 ? years[0] : years.length > 1 ? years.join(' ') : '';
  const yearClause = years.length === 1 ? ` for ${years[0]}` : years.length > 1 ? ` for ${years.join(' and ')}` : '';

  let name = '';
  if (metricLabel && dimension) {
    name = `Top ${pluralDimension} By ${metricLabel}${yearLabel ? ` ${yearLabel}` : ''}`;
  } else if (metricLabel) {
    name = `${metricLabel}${yearLabel ? ` ${yearLabel}` : ''}`;
  } else if (dimension) {
    name = `${pluralDimension} Detail${yearLabel ? ` ${yearLabel}` : ''}`;
  }

  const selectedMeasures = aggregateAliases.map(titleizeName).filter((label) => label && label !== metricLabel);
  let description = '';
  if (metricLabel && dimension) {
    description = `Ranks ${pluralDimension.toLowerCase()} by ${metricLabel.toLowerCase()}${yearClause} using ${sourceTables.join(', ') || sourcePath}.`;
  } else if (metricLabel) {
    description = `Calculates ${metricLabel.toLowerCase()}${yearClause} using ${sourceTables.join(', ') || sourcePath}.`;
  } else if (dimension) {
    description = `Lists ${pluralDimension.toLowerCase()}${yearClause} from ${sourceTables.join(', ') || sourcePath}.`;
  }
  if (description && selectedMeasures.length > 0) {
    description = `${description.replace(/\.$/, '')}, including ${selectedMeasures.map((item) => item.toLowerCase()).join(', ')}.`;
  }

  const tags = [
    ...sourceTables.flatMap((table) => table.split('.').slice(-2).map(businessToken)),
    metric,
    dimension,
    ...years,
  ].flatMap((item) => item.split(/[_\s.-]+/)).map(businessToken).filter(Boolean);

  return {
    name: name || '',
    description,
    tags,
  };
}

function extractSelectExpressions(sql: string): string[] {
  const cleaned = stripSqlComments(sql);
  const match = cleaned.match(/\bselect\b([\s\S]+?)\bfrom\b/i);
  if (!match) return [];
  return splitTopLevelCommas(match[1])
    .map((expression) => expression.trim())
    .filter((expression) => expression && expression !== '*');
}

function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let single = false;
  let double = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (!double && char === "'" && value[i - 1] !== '\\') single = !single;
    else if (!single && char === '"' && value[i - 1] !== '\\') double = !double;
    else if (!single && !double && char === '(') depth += 1;
    else if (!single && !double && char === ')' && depth > 0) depth -= 1;
    else if (!single && !double && depth === 0 && char === ',') {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function isAggregateExpression(expression: string): boolean {
  return /\b(sum|count|avg|min|max|median|percentile_cont|percentile_disc)\s*\(/i.test(expression);
}

function extractExpressionAlias(expression: string): string {
  const asMatch = expression.match(/\bas\s+[`"[]?([A-Za-z_][A-Za-z0-9_$]*)[`"\]]?\s*$/i);
  if (asMatch) return asMatch[1];
  const trailing = expression.match(/\s+[`"[]?([A-Za-z_][A-Za-z0-9_$]*)[`"\]]?\s*$/);
  if (trailing && !/[).]$/.test(trailing[1])) return trailing[1];
  const simple = expression.match(/(?:^|\.)[`"[]?([A-Za-z_][A-Za-z0-9_$]*)[`"\]]?\s*$/);
  return simple?.[1] ?? '';
}

function extractOrderByAliases(sql: string): string[] {
  const cleaned = stripSqlComments(sql);
  const match = cleaned.match(/\border\s+by\b([\s\S]+?)(?:\blimit\b|\bfetch\b|\boffset\b|$)/i);
  if (!match) return [];
  return splitTopLevelCommas(match[1])
    .map((item) => item.replace(/\b(asc|desc|nulls\s+first|nulls\s+last)\b/gi, '').trim())
    .map(extractExpressionAlias)
    .filter(Boolean);
}

function extractYearFilters(sql: string): string[] {
  const years = new Set<string>();
  const cleaned = stripSqlComments(sql);
  let match: RegExpExecArray | null;
  const extractYear = /extract\s*\(\s*year\s+from\s+[^)]+\)\s*(?:=\s*([12][0-9]{3})|in\s*\(([^)]*)\))/gi;
  while ((match = extractYear.exec(cleaned))) {
    const raw = match[1] || match[2] || '';
    for (const year of raw.match(/[12][0-9]{3}/g) ?? []) years.add(year);
  }
  const namedYear = /\b(?:year|season)\b\s*(?:=|in\s*\()\s*([^)\s]+(?:\s*,\s*[^)\s]+)*)/gi;
  while ((match = namedYear.exec(cleaned))) {
    for (const year of match[1].match(/[12][0-9]{3}/g) ?? []) years.add(year);
  }
  return Array.from(years).sort();
}

function businessEntityFromIdentifier(identifier: string): string {
  const clean = identifier
    .replace(/^(dim|fact|fct|stg|src|int)_/i, '')
    .replace(/_(id|key|name|code)$/i, '')
    .replace(/s$/i, '');
  return titleizeName(clean) || 'Records';
}

function pluralizeBusinessEntity(entity: string): string {
  if (/s$/i.test(entity)) return entity;
  if (/y$/i.test(entity)) return `${entity.slice(0, -1)}ies`;
  return `${entity}s`;
}

function businessToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^(dim|fact|fct|stg|src|int)_/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractSourceTables(sql: string): string[] {
  const tables = new Set<string>();
  const cleaned = stripSqlComments(sql).replace(/extract\s*\(\s*\w+\s+from\s+[^)]+\)/gi, 'EXTRACT_VALUE');
  const cteNames = extractCteNames(cleaned);
  const regex = /\b(?:from|join|update|into)\s+([`"[]?[A-Za-z0-9_./:-]+(?:\.[A-Za-z0-9_./:-]+)*[`"\]]?)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleaned))) {
    const raw = match[1].replace(/^[`"[]|[`"\]]$/g, '');
    if (!raw || raw.startsWith('(')) continue;
    if (/^(select|values|unnest|lateral)$/i.test(raw)) continue;
    if (cteNames.has(raw.toLowerCase())) continue;
    tables.add(raw);
  }
  return Array.from(tables);
}

function extractCteNames(sql: string): Set<string> {
  const names = new Set<string>();
  const withIndex = sql.search(/\bwith\b/i);
  if (withIndex < 0) return names;
  const prefix = sql.slice(withIndex);
  const regex = /(?:\bwith\b|,)\s+([A-Za-z_][A-Za-z0-9_$]*)\s+as\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(prefix))) names.add(match[1].toLowerCase());
  return names;
}

function hasExecutableSql(sql: string): boolean {
  return stripSqlComments(sql).trim().length > 0;
}

function extractSqlParameters(sql: string): string[] {
  const params = new Set<string>();
  const cleaned = stripSqlStrings(stripSqlComments(sql));
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

function stripSqlStrings(sql: string): string {
  return sql
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:\\"|[^"])*"/g, '""');
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

function normalizePattern(value: string | undefined): string {
  const normalized = (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const allowed = new Set([
    'metric_wrapper',
    'entity_profile',
    'entity_rollup',
    'ranking',
    'trend',
    'bridge',
    'drilldown',
    'replacement',
    'custom',
  ]);
  return allowed.has(normalized) ? normalized : '';
}

function normalizeStringList(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
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
