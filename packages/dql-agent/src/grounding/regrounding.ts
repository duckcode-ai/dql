import type {
  LocalContextPack,
  MetadataAllowedSqlRelation,
  MetadataCatalog,
  RuntimeSchemaColumn,
  RuntimeSchemaTable,
} from '../metadata/catalog.js';
import { metadataObjectToAllowedSqlRelation } from '../metadata/catalog.js';
import type {
  SqlContextValidationCode,
  SqlContextValidationOffending,
} from '../metadata/sql-context-validation.js';

const RELATION_OBJECT_TYPES = ['dbt_model', 'dbt_source', 'warehouse_table', 'runtime_table'];
const COLUMN_OBJECT_TYPES = ['dbt_column', 'runtime_column', 'warehouse_column'];

export interface GroundingExpansionRequest {
  question: string;
  sql: string;
  code: SqlContextValidationCode;
  offending?: SqlContextValidationOffending;
  contextPack?: LocalContextPack;
  schemaContext?: RuntimeSchemaTable[];
}

export interface GroundingExpansionResult {
  relations: MetadataAllowedSqlRelation[];
  schemaContext?: RuntimeSchemaTable[];
  notes: string[];
}

export type GroundingContextExpander = (
  request: GroundingExpansionRequest,
) => Promise<GroundingExpansionResult | undefined> | GroundingExpansionResult | undefined;

export interface MergedGroundingContext {
  contextPack?: LocalContextPack;
  schemaContext: RuntimeSchemaTable[];
  notes: string[];
}

export function applyGroundingExpansion(
  contextPack: LocalContextPack | undefined,
  schemaContext: RuntimeSchemaTable[] = [],
  expansion: GroundingExpansionResult | undefined,
): MergedGroundingContext {
  if (!expansion || (expansion.relations.length === 0 && (expansion.schemaContext?.length ?? 0) === 0)) {
    return { contextPack, schemaContext, notes: [] };
  }
  const relations = mergeAllowedRelations([
    ...(contextPack?.allowedSqlContext?.relations ?? []),
    ...expansion.relations,
  ]);
  const mergedPack = contextPack
    ? {
        ...contextPack,
        allowedSqlContext: {
          relations,
          sourceBlockSql: contextPack.allowedSqlContext?.sourceBlockSql ?? [],
        },
        warnings: uniqueStrings([
          ...(contextPack.warnings ?? []),
          ...expansion.notes.map((note) => `Re-grounded metadata context: ${note}`),
        ]),
      }
    : contextPack;
  return {
    contextPack: mergedPack,
    schemaContext: mergeRuntimeSchemaTables(schemaContext, expansion.schemaContext ?? relationsToRuntimeTables(expansion.relations)),
    notes: expansion.notes,
  };
}

export function expandGroundingFromCatalog(
  catalog: MetadataCatalog,
  request: GroundingExpansionRequest,
): GroundingExpansionResult | undefined {
  if (request.code !== 'unknown_relation' && request.code !== 'unknown_column') return undefined;
  const relationName = request.offending?.relation;
  const columnName = request.offending?.column;
  const relations: MetadataAllowedSqlRelation[] = [];
  const runtimeTables: RuntimeSchemaTable[] = [];
  const notes: string[] = [];

  for (const relation of findRuntimeRelations(catalog, relationName, columnName)) {
    relations.push(runtimeTableToAllowedRelation(relation, 'runtime schema snapshot'));
    runtimeTables.push(relation);
  }
  for (const relation of findCatalogRelations(catalog, relationName, columnName)) {
    relations.push(relation);
  }

  const mergedRelations = mergeAllowedRelations(relations).slice(0, 8);
  const mergedRuntimeTables = mergeRuntimeSchemaTables(runtimeTables, relationsToRuntimeTables(mergedRelations)).slice(0, 8);
  for (const relation of mergedRelations) {
    const selectedColumns = columnName
      ? relation.columns.filter((column) => namesEqual(column.name, columnName)).map((column) => column.name)
      : relation.columns.slice(0, 6).map((column) => column.name);
    notes.push(`${relation.relation}${selectedColumns.length > 0 ? ` columns: ${selectedColumns.join(', ')}` : ''}`);
  }

  if (mergedRelations.length === 0 && mergedRuntimeTables.length === 0) return undefined;
  return {
    relations: mergedRelations,
    schemaContext: mergedRuntimeTables,
    notes: uniqueStrings(notes).slice(0, 8),
  };
}

function findRuntimeRelations(
  catalog: MetadataCatalog,
  relationName: string | undefined,
  columnName: string | undefined,
): RuntimeSchemaTable[] {
  const snapshot = catalog.latestRuntimeSchemaSnapshot();
  if (!snapshot) return [];
  return snapshot.tables.filter((table) => {
    if (relationName && !relationMatches(table.relation, relationName, table.name)) return false;
    if (columnName && !table.columns.some((column) => namesEqual(column.name, columnName))) return false;
    return Boolean(relationName || columnName);
  });
}

function findCatalogRelations(
  catalog: MetadataCatalog,
  relationName: string | undefined,
  columnName: string | undefined,
): MetadataAllowedSqlRelation[] {
  const relations: MetadataAllowedSqlRelation[] = [];
  catalog.scanObjects({ objectTypes: RELATION_OBJECT_TYPES, batchSize: 500 }, (objects) => {
    for (const object of objects) {
      const relation = metadataObjectToAllowedSqlRelation(object);
      if (!relation) continue;
      if (relationName && !relationMatches(relation.relation, relationName, relation.name)) continue;
      if (columnName && relation.columns.length > 0 && !relation.columns.some((column) => namesEqual(column.name, columnName))) continue;
      if (relationName || columnName) relations.push(relation);
    }
  });

  catalog.scanObjects({ objectTypes: COLUMN_OBJECT_TYPES, batchSize: 500 }, (objects) => {
    for (const object of objects) {
      if (columnName && !namesEqual(object.name, columnName)) continue;
      const relation = metadataObjectToAllowedSqlRelation(object);
      if (!relation) continue;
      if (relationName && !relationMatches(relation.relation, relationName, relation.name)) continue;
      relations.push(relation);
    }
  });
  return relations;
}

function runtimeTableToAllowedRelation(
  table: RuntimeSchemaTable,
  source: string,
): MetadataAllowedSqlRelation {
  return {
    relation: table.relation,
    name: table.name ?? table.relation.split('.').at(-1) ?? table.relation,
    source,
    columnCompleteness: 'complete',
    columns: table.columns,
  };
}

function relationsToRuntimeTables(relations: MetadataAllowedSqlRelation[]): RuntimeSchemaTable[] {
  return relations.map((relation) => ({
    relation: relation.relation,
    name: relation.name,
    source: relation.source,
    columnCompleteness: relation.columnCompleteness,
    columns: relation.columns,
  }));
}

function mergeAllowedRelations(relations: MetadataAllowedSqlRelation[]): MetadataAllowedSqlRelation[] {
  const byRelation = new Map<string, MetadataAllowedSqlRelation>();
  for (const relation of relations) {
    const key = relationKey(relation.relation);
    if (!key) continue;
    const existing = byRelation.get(key);
    byRelation.set(key, existing
      ? {
          ...existing,
          objectKey: existing.objectKey ?? relation.objectKey,
          source: existing.source === relation.source ? existing.source : 'expanded metadata context',
          columnCompleteness: mergeRelationCompleteness(existing.columnCompleteness, relation.columnCompleteness),
          columns: mergeColumns(existing.columns, relation.columns),
        }
      : {
          ...relation,
          columns: mergeColumns([], relation.columns),
        });
  }
  return Array.from(byRelation.values());
}

function mergeRelationCompleteness(
  left: MetadataAllowedSqlRelation['columnCompleteness'],
  right: MetadataAllowedSqlRelation['columnCompleteness'],
): MetadataAllowedSqlRelation['columnCompleteness'] {
  if ((left ?? 'complete') === 'complete' || (right ?? 'complete') === 'complete') return 'complete';
  return 'partial';
}

function mergeRuntimeSchemaTables(
  left: RuntimeSchemaTable[],
  right: RuntimeSchemaTable[],
): RuntimeSchemaTable[] {
  const byRelation = new Map<string, RuntimeSchemaTable>();
  for (const table of [...left, ...right]) {
    const key = relationKey(table.relation);
    if (!key) continue;
    const existing = byRelation.get(key);
    byRelation.set(key, existing
      ? {
          ...existing,
          description: existing.description ?? table.description,
          source: existing.source === table.source ? existing.source : 'expanded metadata context',
          columns: mergeColumns(existing.columns, table.columns),
        }
      : {
          ...table,
          columns: mergeColumns([], table.columns),
        });
  }
  return Array.from(byRelation.values());
}

function mergeColumns<T extends RuntimeSchemaColumn>(left: T[], right: T[]): T[] {
  const byName = new Map<string, T>();
  for (const column of [...left, ...right]) {
    const key = normalizeName(column.name);
    if (!key) continue;
    const existing = byName.get(key);
    byName.set(key, existing
      ? {
          ...existing,
          type: existing.type ?? column.type,
          description: existing.description ?? column.description,
          sampleValues: uniqueStrings([...(existing.sampleValues ?? []), ...(column.sampleValues ?? [])]).slice(0, 8),
        }
      : column);
  }
  return Array.from(byName.values());
}

function relationMatches(candidate: string, wanted: string, candidateName?: string): boolean {
  const wantedKeys = relationKeys(wanted);
  return Array.from(relationKeys(candidate)).some((key) => wantedKeys.has(key))
    || (candidateName ? Array.from(relationKeys(candidateName)).some((key) => wantedKeys.has(key)) : false);
}

function relationKeys(relation: string): Set<string> {
  const normalized = relationKey(relation);
  const parts = normalized.split('.').filter(Boolean);
  const keys = new Set<string>();
  if (normalized) keys.add(normalized);
  if (parts.length >= 2) keys.add(parts.slice(-2).join('.'));
  if (parts.length >= 1) keys.add(parts[parts.length - 1]!);
  return keys;
}

function relationKey(relation: string): string {
  return relation.replace(/["`]/g, '').replace(/\s*\.\s*/g, '.').trim().toLowerCase();
}

function namesEqual(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}

function normalizeName(value: string): string {
  return value.replace(/["`]/g, '').trim().toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
