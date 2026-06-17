import { analyzeSqlReferences } from '@duckcodeailabs/dql-core';
import type { LocalContextPack, MetadataAgentIntent, MetadataAllowedSqlRelation } from './catalog.js';
import { sourceSqlShapeColumns } from './sql-shape.js';

export type SqlContextValidationCode =
  | 'unknown_relation'
  | 'unknown_column'
  | 'missing_baseline'
  | 'ambiguous_filter'
  | 'unsafe_sql'
  | 'insufficient_context';

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
    };

export interface SqlContextValidationOptions {
  question?: string;
  intent?: MetadataAgentIntent | string;
  filterValues?: string[];
}

export function validateSqlAgainstLocalContext(
  sql: string,
  contextPack: LocalContextPack | undefined,
  options: SqlContextValidationOptions = {},
): SqlContextValidationResult {
  const analysis = analyzeSqlReferences(sql);
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

  if (!contextPack) return { ok: true, ...base };
  if (contextPack.routeDecision?.route === 'clarify') {
    const missing = contextPack.missingContext.map((item) => item.message).join(' ');
    return {
      ok: false,
      code: 'insufficient_context',
      error: `Metadata context is insufficient for SQL generation. ${missing || contextPack.routeDecision.reason}`,
      ...base,
    };
  }

  if (!contextPack.allowedSqlContext) {
    return {
      ok: true,
      ...base,
      warnings: ['No allowed SQL context was available in the context pack, so relation and column validation were advisory only.'],
    };
  }

  const allowed = buildAllowedRelationLookup(contextPack);
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
      ...base,
    };
  }

  const warnings: string[] = [];
  for (const relation of referencedRelations) {
    const allowedRelation = findAllowedRelation(allowed, relation);
    if (allowedRelation && allowedRelation.columns.length === 0) {
      warnings.push(`Column validation was advisory for ${relation} because the context pack did not include column metadata.`);
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
    };
  }

  if (options.intent === 'diagnose_change' && !contextHasTimeLikeColumn(contextPack)) {
    return {
      ok: false,
      code: 'missing_baseline',
      error: 'Change-diagnosis SQL needs a comparable time or baseline column in the inspected context.',
      warnings,
      referencedRelations,
      referencedColumns,
    };
  }

  const ambiguousEntityFilter = options.intent === 'entity_drilldown'
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

  return {
    ok: true,
    warnings,
    referencedRelations,
    referencedColumns,
  };
}

function buildAllowedRelationLookup(contextPack: LocalContextPack): Map<string, MetadataAllowedSqlRelation> {
  const allowed = new Map<string, MetadataAllowedSqlRelation>();
  const putAllowed = (entry: MetadataAllowedSqlRelation) => {
    for (const key of relationLookupKeys(entry.relation)) {
      allowed.set(key, mergeAllowedRelation(allowed.get(key), entry));
    }
    for (const key of relationLookupKeys(entry.name)) {
      allowed.set(key, mergeAllowedRelation(allowed.get(key), entry));
    }
  };
  for (const relation of contextPack.allowedSqlContext.relations) {
    putAllowed(relation);
  }
  for (const source of contextPack.allowedSqlContext.sourceBlockSql) {
    const analysis = analyzeSqlReferences(source.sql);
    for (const relation of analysis.tables) {
      putAllowed({
        relation,
        name: relation.split('.').at(-1) ?? relation,
        objectKey: source.objectKey,
        source: 'certified source block SQL',
        columns: sourceSqlShapeColumns(source.sql),
      });
    }
  }
  return allowed;
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
    columns: mergeAllowedColumns(existing.columns, incoming.columns),
  };
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
  for (const key of relationLookupKeys(relation)) {
    const match = allowed.get(key);
    if (match) return match;
  }
  return undefined;
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
      if (!relation.columns.some((allowedColumn) => namesEqual(allowedColumn.name, column.column))) {
        return { column: column.column, relation: relation.relation };
      }
      continue;
    }

    const relationsWithColumns = Array.from(new Set(Array.from(allowed.values())))
      .filter((relation) => relation.columns.length > 0);
    if (relationsWithColumns.length === 0) continue;
    if (!relationsWithColumns.some((relation) => relation.columns.some((allowedColumn) => namesEqual(allowedColumn.name, column.column)))) {
      return { column: column.column };
    }
  }
  return undefined;
}

function extractSelectAliases(sql: string): Set<string> {
  const aliases = new Set<string>();
  for (const section of sql.matchAll(/\bSELECT\b([\s\S]*?)\bFROM\b/gi)) {
    for (const alias of (section[1] ?? '').matchAll(/\bAS\s+(["`]?\w+["`]?)/gi)) {
      const name = cleanIdentifier(alias[1] ?? '');
      if (name) aliases.add(normalizeColumnName(name));
    }
  }
  return aliases;
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

function contextHasTimeLikeColumn(contextPack: LocalContextPack): boolean {
  return contextPack.allowedSqlContext.relations.some((relation) =>
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
  const sampleMatches = sampleValueColumnMatches(contextPack);
  if (sampleMatches.size === 0) return undefined;
  const predicates = extractEntityValuePredicates(sql, aliasToRelation);

  for (const value of explicitValues) {
    const valueKey = normalizeSampleValue(value);
    const matchedColumns = sampleMatches.get(valueKey) ?? [];
    if (matchedColumns.length === 0) {
      return `Entity drilldown SQL needs an inspected value match for "${value}" before it can apply that filter.`;
    }

    const valuePredicates = predicates.filter((predicate) => normalizeSampleValue(predicate.value) === valueKey);
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

  return predicates.filter((predicate) => predicate.column.length > 0 && predicate.value.length > 0);
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
