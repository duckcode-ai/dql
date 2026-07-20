import { analyzeSqlReferences } from '@duckcodeailabs/dql-core';
import type {
  LocalContextPack,
  MetadataAgentIntent,
  MetadataAllowedSqlRelation,
  RuntimeSchemaTable,
} from './catalog.js';
import { sourceSqlShapeColumns } from './sql-shape.js';
import { shouldClarifyBeforeGeneration } from '../cascade/triage.js';

export type SqlContextValidationCode =
  | 'unknown_relation'
  | 'unknown_column'
  | 'missing_baseline'
  | 'ambiguous_filter'
  | 'misbound_filter'
  | 'unsafe_sql'
  | 'insufficient_context';

export interface SqlContextValidationOffending {
  relation?: string;
  column?: string;
}

export type SqlContextValidationResult =
  | {
      ok: true;
      warnings: string[];
      referencedRelations: string[];
      referencedColumns: Array<{ relation?: string; column: string }>;
    }
  | {
      ok: false;
      code: SqlContextValidationCode;
      error: string;
      warnings: string[];
      referencedRelations: string[];
      referencedColumns: Array<{ relation?: string; column: string }>;
      offending?: SqlContextValidationOffending;
    };

export interface SqlContextValidationOptions {
  /** Active warehouse driver/dialect (for example snowflake or databricks). */
  dialect?: string;
  question?: string;
  intent?: MetadataAgentIntent | string;
  filterValues?: string[];
  trustedFilterValues?: string[];
  memberBindings?: Array<{
    dimension: string;
    values: string[];
  }>;
  /**
   * Runtime schema shown to the model in the prompt. When supplied, validation
   * uses the union of the metadata context pack and this runtime context so the
   * guard does not reject relations it already asked the model to use.
   */
  runtimeSchema?: RuntimeSchemaTable[];
}

const SQL_ALIAS_STOPWORDS = new Set([
  'asc',
  'desc',
  'from',
  'group',
  'having',
  'limit',
  'order',
  'where',
]);

export function validateSqlAgainstLocalContext(
  sql: string,
  contextPack: LocalContextPack | undefined,
  options: SqlContextValidationOptions = {},
): SqlContextValidationResult {
  const analysis = analyzeSqlReferences(sql, options.dialect);
  const referencedRelations = analysis.tables;
  const referencedColumns = analysis.columns.map((column) => ({
    relation: column.relation,
    column: column.column,
  }));
  const outputAliases = extractSelectAliases(sql);
  const base = {
    warnings: [] as string[],
    referencedRelations,
    referencedColumns,
  };

  if (!analysis.parsed) {
    return {
      ok: false,
      code: 'insufficient_context',
      error: `SQL could not be parsed for context validation: ${analysis.error ?? 'unknown parse error'}`,
      ...base,
    };
  }

  const unsafeType = analysis.statementTypes.find((type) => type !== 'select');
  if (unsafeType) {
    return {
      ok: false,
      code: 'unsafe_sql',
      error: `Tier-2 metadata SQL only supports read-only SELECT or WITH queries; parser found ${unsafeType.toUpperCase()}.`,
      ...base,
    };
  }

  // A DATA answer must read at least one relation. A constant-only / tableless
  // SELECT (`SELECT NULL`, `SELECT 1`) references no relation and cannot answer a
  // data question — the model is dodging a hard ask with a grounded-looking
  // non-answer. Reject so the loop repairs or refuses honestly. (Runs before the
  // advisory early-returns below so it holds even with no context pack.)
  if (referencedRelations.length === 0) {
    return {
      ok: false,
      code: 'insufficient_context',
      error: 'The generated SQL does not read any relation (constant-only/tableless SELECT), so it cannot answer a data question. Query an inspected relation.',
      ...base,
    };
  }

  const allowed = buildAllowedRelationLookup(contextPack, options.runtimeSchema, options.dialect);

  if (!contextPack && allowed.size === 0) return { ok: true, ...base };
  if (contextPack?.routeDecision?.route === 'clarify' && shouldClarifyBeforeGeneration({
    intent: contextPack.routeDecision.intent,
    routeDecision: contextPack.routeDecision,
    schemaContextCount: options.runtimeSchema?.length ?? 0,
    allowedRelationCount: allowed.size,
    sourceBlockSqlCount: contextPack.allowedSqlContext.sourceBlockSql.length,
    metadataObjectCount: contextPack.objects.length,
  })) {
    const missing = contextPack.missingContext.map((item) => item.message).join(' ');
    return {
      ok: false,
      code: 'insufficient_context',
      error: `Metadata context is insufficient for SQL generation. ${missing || contextPack.routeDecision.reason}`,
      ...base,
    };
  }

  if (!contextPack?.allowedSqlContext && allowed.size === 0) {
    return {
      ok: true,
      ...base,
      warnings: ['No allowed SQL context was available in the context pack, so relation and column validation were advisory only.'],
    };
  }

  if (allowed.size === 0) {
    return {
      ok: true,
      ...base,
      warnings: ['No allowed SQL relations were available in the context pack, so relation and column validation were advisory only.'],
    };
  }

  const unknownRelations = referencedRelations.filter((relation) =>
    !relationLookupKeys(relation).some((key) => allowed.has(key)),
  );
  if (unknownRelations.length > 0) {
    return {
      ok: false,
      code: 'unknown_relation',
      error: `SQL references relation(s) outside the inspected metadata context: ${unknownRelations.join(', ')}. Use inspect_metadata_context and only query allowed relations.`,
      offending: { relation: unknownRelations[0] },
      ...base,
    };
  }

  const warnings: string[] = [];
  for (const relation of referencedRelations) {
    const allowedRelation = findAllowedRelation(allowed, relation);
    if (allowedRelation && allowedRelation.columns.length === 0) {
      warnings.push(`Column validation was advisory for ${relation} because the context pack did not include column metadata.`);
    } else if (allowedRelation && relationColumnCompleteness(allowedRelation) === 'partial') {
      warnings.push(`Column validation was advisory for ${relation} because the inspected column list is partial.`);
    }
  }

  const unknownColumn = findUnknownColumn(analysis.columns, allowed, outputAliases);
  if (unknownColumn) {
    return {
      ok: false,
      code: 'unknown_column',
      error: unknownColumn.relation
        ? `SQL references column "${unknownColumn.column}" outside the inspected columns for ${unknownColumn.relation}.`
        : `SQL references column "${unknownColumn.column}" outside the inspected metadata context.`,
      warnings,
      referencedRelations,
      referencedColumns,
      offending: {
        relation: unknownColumn.relation,
        column: unknownColumn.column,
      },
    };
  }

  // The parser flattens aliases across CTE scopes, so only enforce this when
  // every relation lives in one SELECT scope. DuckDB will still validate CTEs
  // at execution, while this avoids treating an inner and outer alias as peers.
  const ambiguousColumn = analysis.ctes.length === 0
    ? findAmbiguousUnqualifiedColumn(
        analysis.columns,
        analysis.aliasToRelation,
        allowed,
        outputAliases,
      )
    : undefined;
  if (ambiguousColumn) {
    return {
      ok: false,
      code: 'unknown_column',
      error: `SQL references unqualified column "${ambiguousColumn.column}", which exists on multiple joined relations: ${ambiguousColumn.owners.join(', ')}. Qualify it with the intended relation alias.`,
      warnings,
      referencedRelations,
      referencedColumns,
      offending: { column: ambiguousColumn.column },
    };
  }

  if (options.intent === 'diagnose_change' && !contextHasTimeLikeColumn(allowed)) {
    return {
      ok: false,
      code: 'missing_baseline',
      error: 'Change-diagnosis SQL needs a comparable time or baseline column in the inspected context.',
      warnings,
      referencedRelations,
      referencedColumns,
    };
  }

  const ambiguousEntityFilter = options.intent === 'entity_drilldown' && contextPack
    ? findAmbiguousEntityFilter(sql, analysis.aliasToRelation, contextPack, options)
    : undefined;
  if (ambiguousEntityFilter) {
    return {
      ok: false,
      code: 'ambiguous_filter',
      error: ambiguousEntityFilter,
      warnings,
      referencedRelations,
      referencedColumns,
    };
  }

  const misboundMemberFilter = findMisboundMemberFilter(sql, analysis.aliasToRelation, options.memberBindings ?? []);
  if (misboundMemberFilter) {
    return {
      ok: false,
      code: 'misbound_filter',
      error: misboundMemberFilter.message,
      warnings,
      referencedRelations,
      referencedColumns,
      offending: { relation: misboundMemberFilter.relation, column: misboundMemberFilter.column },
    };
  }

  return {
    ok: true,
    warnings,
    referencedRelations,
    referencedColumns,
  };
}

function buildAllowedRelationLookup(
  contextPack: LocalContextPack | undefined,
  runtimeSchema: RuntimeSchemaTable[] = [],
  dialect?: string,
): Map<string, MetadataAllowedSqlRelation> {
  const allowed = new Map<string, MetadataAllowedSqlRelation>();
  const putAllowed = (entry: MetadataAllowedSqlRelation) => {
    for (const key of relationLookupKeys(entry.relation)) {
      allowed.set(key, mergeAllowedRelation(allowed.get(key), entry));
    }
    for (const key of relationLookupKeys(entry.name)) {
      allowed.set(key, mergeAllowedRelation(allowed.get(key), entry));
    }
  };
  for (const relation of contextPack?.allowedSqlContext?.relations ?? []) {
    putAllowed(relation);
  }
  for (const source of contextPack?.allowedSqlContext?.sourceBlockSql ?? []) {
    const analysis = analyzeSqlReferences(source.sql, dialect);
    for (const relation of analysis.tables) {
      putAllowed({
        relation,
        name: relation.split('.').at(-1) ?? relation,
        objectKey: source.objectKey,
        source: 'certified source block SQL',
        columnCompleteness: 'partial',
        columns: mergeAllowedColumns(
          sourceSqlShapeColumns(source.sql),
          sourceSqlReferencedColumns(analysis, relation),
        ),
      });
    }
  }
  for (const table of runtimeSchema) {
    putAllowed({
      relation: table.relation,
      name: table.name ?? table.relation.split('.').at(-1) ?? table.relation,
      source: table.source ?? 'runtime schema context',
      columnCompleteness: 'complete',
      columns: table.columns,
    });
  }
  return allowed;
}

function sourceSqlReferencedColumns(
  analysis: ReturnType<typeof analyzeSqlReferences>,
  relation: string,
): MetadataAllowedSqlRelation['columns'] {
  const relationCount = analysis.tables.length;
  const columns: MetadataAllowedSqlRelation['columns'] = [];
  const seen = new Set<string>();
  for (const column of analysis.columns) {
    const name = cleanIdentifier(column.column);
    if (!name || name === '*') continue;
    if (relationCount > 1 && column.relation && !relationLookupKeys(column.relation).some((key) => relationLookupKeys(relation).includes(key))) {
      continue;
    }
    if (relationCount > 1 && !column.relation) continue;
    const key = normalizeColumnName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    columns.push({
      name,
      description: 'Referenced by certified source SQL.',
    });
  }
  return columns;
}

function mergeAllowedRelation(
  existing: MetadataAllowedSqlRelation | undefined,
  incoming: MetadataAllowedSqlRelation,
): MetadataAllowedSqlRelation {
  if (!existing) return incoming;
  return {
    ...existing,
    objectKey: existing.objectKey ?? incoming.objectKey,
    source: existing.source === incoming.source ? existing.source : 'inspected metadata and certified source SQL',
    columnCompleteness: mergeRelationCompleteness(existing, incoming),
    columns: mergeAllowedColumns(existing.columns, incoming.columns),
  };
}

function mergeRelationCompleteness(
  existing: MetadataAllowedSqlRelation,
  incoming: MetadataAllowedSqlRelation,
): MetadataAllowedSqlRelation['columnCompleteness'] {
  if (relationColumnCompleteness(existing) === 'complete' || relationColumnCompleteness(incoming) === 'complete') {
    return 'complete';
  }
  return 'partial';
}

function mergeAllowedColumns(
  left: MetadataAllowedSqlRelation['columns'],
  right: MetadataAllowedSqlRelation['columns'],
): MetadataAllowedSqlRelation['columns'] {
  const byName = new Map<string, MetadataAllowedSqlRelation['columns'][number]>();
  for (const column of [...left, ...right]) {
    const key = column.name.toLowerCase();
    const existing = byName.get(key);
    byName.set(key, existing
      ? {
          ...existing,
          type: existing.type ?? column.type,
          description: existing.description ?? column.description,
          sampleValues: Array.from(new Set([...(existing.sampleValues ?? []), ...(column.sampleValues ?? [])])).slice(0, 8),
        }
      : column);
  }
  return Array.from(byName.values());
}

function findAllowedRelation(
  allowed: Map<string, MetadataAllowedSqlRelation>,
  relation: string,
): MetadataAllowedSqlRelation | undefined {
  let partialMatch: MetadataAllowedSqlRelation | undefined;
  for (const key of relationLookupKeys(relation)) {
    const match = allowed.get(key);
    if (!match) continue;
    if (relationColumnCompleteness(match) === 'complete') return match;
    partialMatch ??= match;
  }
  return partialMatch;
}

function findUnknownColumn(
  columns: Array<{ column: string; relation?: string; unqualified: boolean }>,
  allowed: Map<string, MetadataAllowedSqlRelation>,
  outputAliases: Set<string>,
): { column: string; relation?: string } | undefined {
  for (const column of columns) {
    if (column.column === '*') continue;
    if (column.unqualified && outputAliases.has(normalizeColumnName(column.column))) continue;
    if (column.relation) {
      const relation = findAllowedRelation(allowed, column.relation);
      if (!relation || relation.columns.length === 0) continue;
      if (relationColumnCompleteness(relation) === 'partial') continue;
      if (!relation.columns.some((allowedColumn) => namesEqual(allowedColumn.name, column.column))) {
        return { column: column.column, relation: relation.relation };
      }
      continue;
    }

    const relationsWithColumns = uniqueAllowedRelations(allowed)
      .filter((relation) => relation.columns.length > 0 && relationColumnCompleteness(relation) === 'complete');
    if (relationsWithColumns.length === 0) continue;
    if (!relationsWithColumns.some((relation) => relation.columns.some((allowedColumn) => namesEqual(allowedColumn.name, column.column)))) {
      return { column: column.column };
    }
  }
  return undefined;
}

function findAmbiguousUnqualifiedColumn(
  columns: Array<{ column: string; relation?: string; unqualified: boolean }>,
  aliasToRelation: Record<string, string>,
  allowed: Map<string, MetadataAllowedSqlRelation>,
  outputAliases: Set<string>,
): { column: string; owners: string[] } | undefined {
  for (const column of columns) {
    if (!column.unqualified || column.column === '*' || outputAliases.has(normalizeColumnName(column.column))) continue;
    const owners = Object.entries(aliasToRelation)
      .filter(([, relationName]) => {
        const relation = findAllowedRelation(allowed, relationName);
        return Boolean(
          relation
          && relation.columns.length > 0
          && relationColumnCompleteness(relation) === 'complete'
          && relation.columns.some((candidate) => namesEqual(candidate.name, column.column)),
        );
      })
      .map(([alias, relationName]) => `${alias} (${relationName})`)
      .filter((owner, index, values) => values.indexOf(owner) === index);
    if (owners.length > 1) return { column: column.column, owners };
  }
  return undefined;
}

function relationColumnCompleteness(relation: MetadataAllowedSqlRelation): 'complete' | 'partial' {
  if (relation.columnCompleteness) return relation.columnCompleteness;
  return relation.columns.length === 0 ? 'partial' : 'complete';
}

function extractSelectAliases(sql: string): Set<string> {
  const aliases = new Set<string>();
  for (const section of sql.matchAll(/\bSELECT\b([\s\S]*?)\bFROM\b/gi)) {
    for (const item of splitTopLevelSelectItems(section[1] ?? '')) {
      const alias = selectItemAlias(item);
      if (alias) {
        aliases.add(normalizeColumnName(alias));
      }
    }
  }
  return aliases;
}

function splitTopLevelSelectItems(section: string): string[] {
  const items: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | "'" | '`' | undefined;
  for (let index = 0; index < section.length; index += 1) {
    const char = section[index]!;
    const next = section[index + 1];
    if (quote) {
      current += char;
      if (char === quote) {
        if (quote === "'" && next === "'") {
          current += next;
          index += 1;
          continue;
        }
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === ',' && depth === 0) {
      if (current.trim()) items.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function selectItemAlias(item: string): string | undefined {
  const asMatch = /\bAS\s+((?:"[^"]+")|(?:`[^`]+`)|(?:[A-Za-z_][\w$]*))\s*$/i.exec(item);
  if (asMatch?.[1]) return cleanIdentifier(asMatch[1]);

  const implicit = /(?:\bEND|\)|\])\s+((?:"[^"]+")|(?:`[^`]+`)|(?:[A-Za-z_][\w$]*))\s*$/i.exec(item);
  if (!implicit?.[1]) return undefined;
  const alias = cleanIdentifier(implicit[1]);
  if (!alias || SQL_ALIAS_STOPWORDS.has(alias.toLowerCase())) return undefined;
  return alias;
}

function uniqueAllowedRelations(allowed: Map<string, MetadataAllowedSqlRelation>): MetadataAllowedSqlRelation[] {
  return Array.from(new Set(Array.from(allowed.values())));
}

function relationLookupKeys(relation: string): string[] {
  const normalized = normalizeRelation(relation).toLowerCase();
  const parts = normalized.split('.').filter(Boolean);
  const keys = new Set<string>();
  if (normalized) keys.add(normalized);
  if (parts.length >= 2) keys.add(parts.slice(-2).join('.'));
  if (parts.length >= 1) keys.add(parts[parts.length - 1]!);
  return Array.from(keys);
}

function normalizeRelation(value: string): string {
  return value
    .replace(/["`]/g, '')
    .replace(/\s*\.\s*/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesEqual(a: string, b: string): boolean {
  return a.replace(/["`]/g, '').toLowerCase() === b.replace(/["`]/g, '').toLowerCase();
}

function normalizeColumnName(value: string): string {
  return value.replace(/["`]/g, '').toLowerCase();
}

function contextHasTimeLikeColumn(allowed: Map<string, MetadataAllowedSqlRelation>): boolean {
  return uniqueAllowedRelations(allowed).some((relation) =>
    relation.columns.some((column) => isTimeLikeColumn(column.name)),
  );
}

function isTimeLikeColumn(name: string): boolean {
  return /\b(date|time|day|week|month|quarter|year|season|period|created_at|updated_at)\b/i.test(name);
}

interface SampleValueColumnMatch {
  relation: string;
  column: string;
}

interface EntityValuePredicate {
  relation?: string;
  column: string;
  value: string;
  /** True for LIKE/ILIKE-derived predicates (wildcards stripped) — matched by containment, not equality. */
  fuzzy?: boolean;
}

function findAmbiguousEntityFilter(
  sql: string,
  aliasToRelation: Record<string, string>,
  contextPack: LocalContextPack,
  options: SqlContextValidationOptions,
): string | undefined {
  const question = options.question ?? '';
  const explicitValues = uniqueStrings([
    ...(options.filterValues ?? []),
    ...Array.from(question.matchAll(/"([^"]+)"|'([^']+)'/g))
      .map((match) => match[1] ?? match[2])
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ...Array.from(question.matchAll(/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g)).map((match) => match[0]),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && !isTemporalEntityFilter(value)));

  if (explicitValues.length === 0) return undefined;
  const trustedValues = new Set((options.trustedFilterValues ?? []).map(normalizeSampleValue).filter(Boolean));
  const sampleMatches = sampleValueColumnMatches(contextPack);
  if (sampleMatches.size === 0) return undefined;
  const predicates = extractEntityValuePredicates(sql, aliasToRelation);

  for (const value of explicitValues) {
    const valueKey = normalizeSampleValue(value);
    const matchedColumns = sampleMatches.get(valueKey) ?? [];
    const valuePredicates = predicates.filter((predicate) => normalizeSampleValue(predicate.value) === valueKey);
    if (matchedColumns.length === 0) {
      if (trustedValues.has(valueKey) && valuePredicates.length > 0) continue;
      return `Entity drilldown SQL needs an inspected value match for "${value}" before it can apply that filter.`;
    }

    if (valuePredicates.length === 0) {
      return `Entity drilldown SQL does not apply the requested inspected entity filter "${value}".`;
    }

    if (!valuePredicates.some((predicate) => predicateMatchesSampleColumn(predicate, matchedColumns))) {
      const expected = matchedColumns
        .map((match) => `${match.relation}.${match.column}`)
        .sort()
        .join(', ');
      const actual = valuePredicates
        .map((predicate) => `${predicate.relation ? `${predicate.relation}.` : ''}${predicate.column}`)
        .sort()
        .join(', ');
      return `Entity drilldown SQL filters "${value}" on ${actual}, but inspected metadata matched that value on ${expected}.`;
    }
  }

  return undefined;
}

function sampleValueColumnMatches(contextPack: LocalContextPack): Map<string, SampleValueColumnMatch[]> {
  const matches = new Map<string, SampleValueColumnMatch[]>();
  for (const relation of contextPack.allowedSqlContext.relations) {
    for (const column of relation.columns) {
      for (const sampleValue of column.sampleValues ?? []) {
        const key = normalizeSampleValue(sampleValue);
        if (!key) continue;
        const existing = matches.get(key) ?? [];
        existing.push({ relation: relation.relation, column: column.name });
        matches.set(key, existing);
      }
    }
  }
  return matches;
}

function extractEntityValuePredicates(sql: string, aliasToRelation: Record<string, string>): EntityValuePredicate[] {
  const predicates: EntityValuePredicate[] = [];
  // Models commonly normalize text comparisons with LOWER/UPPER. Capture the
  // wrapped column as the predicate owner so member-binding validation applies
  // identically to normalized and direct equality filters.
  const normalizedEqualityPattern = /(?:LOWER|UPPER)\s*\(\s*(?:(["]?[\w]+["]?)\s*\.\s*)?(["]?[\w]+["]?)\s*\)\s*=\s*(?:LOWER|UPPER)\s*\(\s*('(?:''|[^'])*'|"(?:\\"|[^"])*")\s*\)/gi;
  for (const match of sql.matchAll(normalizedEqualityPattern)) {
    predicates.push({
      relation: resolvePredicateRelation(match[1], aliasToRelation),
      column: cleanIdentifier(match[2] ?? ''),
      value: unquoteSqlLiteral(match[3] ?? ''),
    });
  }

  const equalityPattern = /(?:(["`]?[\w]+["`]?)\s*\.\s*)?(["`]?[\w]+["`]?)\s*=\s*('(?:''|[^'])*'|"(?:\\"|[^"])*")/gi;
  for (const match of sql.matchAll(equalityPattern)) {
    predicates.push({
      relation: resolvePredicateRelation(match[1], aliasToRelation),
      column: cleanIdentifier(match[2] ?? ''),
      value: unquoteSqlLiteral(match[3] ?? ''),
    });
  }

  const inPattern = /(?:(["`]?[\w]+["`]?)\s*\.\s*)?(["`]?[\w]+["`]?)\s+IN\s*\(([^)]*)\)/gi;
  for (const match of sql.matchAll(inPattern)) {
    const relation = resolvePredicateRelation(match[1], aliasToRelation);
    const column = cleanIdentifier(match[2] ?? '');
    for (const value of stringLiteralsInList(match[3] ?? '')) {
      predicates.push({ relation, column, value });
    }
  }

  // Models frequently express a typed member as a pattern filter
  // (customer_name ILIKE '%Capital One%'). That still APPLIES the binding —
  // capture it (wildcards stripped) so binding validation doesn't refuse a
  // semantically correct query. NOT LIKE is deliberately excluded.
  const likePattern = /(?:(?:LOWER|UPPER)\s*\(\s*)?(?:(["`]?[\w]+["`]?)\s*\.\s*)?(["`]?[\w]+["`]?)\s*\)?\s+(?<!NOT\s)I?LIKE\s+(?:(?:LOWER|UPPER)\s*\(\s*)?('(?:''|[^'])*')\s*\)?/gi;
  for (const match of sql.matchAll(likePattern)) {
    const value = unquoteSqlLiteral(match[3] ?? '').replace(/[%_]+/g, ' ').trim();
    predicates.push({
      relation: resolvePredicateRelation(match[1], aliasToRelation),
      column: cleanIdentifier(match[2] ?? ''),
      value,
      fuzzy: true,
    });
  }

  return predicates.filter((predicate) => predicate.column.length > 0 && predicate.value.length > 0);
}

function findMisboundMemberFilter(
  sql: string,
  aliasToRelation: Record<string, string>,
  bindings: Array<{ dimension: string; values: string[] }>,
): { message: string; relation?: string; column?: string } | undefined {
  if (bindings.length === 0) return undefined;
  const predicates = extractEntityValuePredicates(sql, aliasToRelation);
  // Equality predicates must match the typed member exactly (normalized);
  // LIKE-derived predicates count when the stripped pattern and the typed
  // member contain each other in either direction ('%Capital One%' or a
  // narrower '%Capital%' both honor the binding "Capital One").
  const predicateAppliesValue = (predicate: EntityValuePredicate, valueKey: string): boolean => {
    const predicateKey = normalizeSampleValue(predicate.value);
    if (!predicateKey || !valueKey) return false;
    if (predicateKey === valueKey) return true;
    return Boolean(predicate.fuzzy) && (predicateKey.includes(valueKey) || valueKey.includes(predicateKey));
  };
  for (const binding of bindings) {
    for (const value of binding.values) {
      const valueKey = normalizeSampleValue(value);
      const matchingValuePredicates = predicates.filter((predicate) => predicateAppliesValue(predicate, valueKey));
      if (matchingValuePredicates.length === 0) {
        return {
          message: `SQL does not apply required member binding ${binding.dimension} = "${value}". Preserve the typed binding in the generated filter.`,
        };
      }
      const correctlyBound = matchingValuePredicates.find((predicate) => columnMatchesBindingDimension(predicate.column, binding.dimension));
      if (!correctlyBound) {
        const actual = matchingValuePredicates
          .map((predicate) => `${predicate.relation ? `${predicate.relation}.` : ''}${predicate.column}`)
          .sort()
          .join(', ');
        const first = matchingValuePredicates[0];
        return {
          message: `SQL applies required member "${value}" to ${actual}, but the resolved binding dimension is ${binding.dimension}. Filter a ${binding.dimension} column instead.`,
          relation: first?.relation,
          column: first?.column,
        };
      }
    }
  }
  return undefined;
}

function columnMatchesBindingDimension(column: string, dimension: string): boolean {
  const columnTokens = normalizedConceptTokens(column);
  const dimensionTokens = normalizedConceptTokens(dimension);
  if (dimensionTokens.length === 0) return false;
  return dimensionTokens.every((token) => columnTokens.includes(token));
}

function normalizedConceptTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && token !== 'name' && token !== 'value' && token !== 'label');
}

function predicateMatchesSampleColumn(predicate: EntityValuePredicate, matches: SampleValueColumnMatch[]): boolean {
  return matches.some((match) => {
    if (!namesEqual(predicate.column, match.column)) return false;
    if (!predicate.relation) return true;
    return relationLookupKeys(predicate.relation).some((key) => relationLookupKeys(match.relation).includes(key));
  });
}

function resolvePredicateRelation(qualifier: string | undefined, aliasToRelation: Record<string, string>): string | undefined {
  if (!qualifier) return undefined;
  const cleaned = cleanIdentifier(qualifier);
  if (!cleaned) return undefined;
  const direct = aliasToRelation[cleaned] ?? aliasToRelation[cleaned.toLowerCase()];
  if (direct) return direct;
  return cleaned;
}

function stringLiteralsInList(raw: string): string[] {
  return Array.from(raw.matchAll(/'(?:''|[^'])*'|"(?:\\"|[^"])*"/g)).map((match) => unquoteSqlLiteral(match[0]));
}

function unquoteSqlLiteral(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).replace(/''/g, "'").replace(/\\"/g, '"');
  }
  return trimmed;
}

function cleanIdentifier(value: string): string {
  return value.replace(/^["`]|["`]$/g, '').trim();
}

function normalizeSampleValue(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isTemporalEntityFilter(value: string): boolean {
  return /\b(last|this|next|previous|prior|current)\s+(day|week|month|quarter|year)\b/i.test(value)
    || /\b(today|yesterday|tomorrow|ytd|mtd|qtd|wtd)\b/i.test(value)
    || /^\d{4}-\d{2}-\d{2}/.test(value);
}
