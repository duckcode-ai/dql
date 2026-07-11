export interface MixedSourceSqlPlan {
  datasetId?: string;
  datasetName?: string;
  localDataset: string;
  localAlias: string;
  localKey: string;
  warehouseKey: string;
  warehouseExpression: string;
  warehouseSql: string;
  warehouseRelations?: string[];
}

export interface MixedSourceDatasetCandidate {
  id: string;
  name: string;
  alias: string;
  columns: Array<{ name: string; flags?: string[] }>;
}

export interface MixedSourceSchemaTable {
  relation: string;
  columns: Array<{ name: string }>;
  source?: string;
}

/**
 * Resolve an explicitly named notebook dataset without turning general customer
 * language into a file guess. The singular/plural allowance is intentionally
 * limited to names ending in csv/dataset so `customer_csv` can safely match the
 * registered `customers_csv` alias.
 */
export function findMentionedNotebookDataset<T extends Pick<MixedSourceDatasetCandidate, 'id' | 'name' | 'alias'>>(
  question: string,
  datasets: T[],
): T | undefined {
  const questionTokens = new Set(identifierTokens(question));
  const exact = datasets.filter((dataset) => [dataset.alias, dataset.name].some((value) => {
    const tokens = identifierTokens(value);
    return tokens.length > 0 && tokens.every((token) => questionTokens.has(token));
  }));
  if (exact.length === 1) return exact[0];

  const normalizedQuestion = normalizeDatasetMention(question);
  const fuzzy = datasets.filter((dataset) => [dataset.alias, dataset.name].some((value) => {
    const normalized = normalizeDatasetMention(value);
    return normalized.length >= 6 && normalizedQuestion.includes(normalized);
  }));
  return fuzzy.length === 1 ? fuzzy[0] : undefined;
}

/** Build the two-engine notebook handoff once the SQL fallback has authored the
 * warehouse extraction. The SQL remains warehouse-only; the returned keys are
 * used by the UI to stage and create the local join cell after user confirmation.
 */
export function planMixedSourceNotebookSql(
  sql: string,
  dataset: MixedSourceDatasetCandidate,
  schemaTables: MixedSourceSchemaTable[],
): MixedSourceSqlPlan | null {
  const direct = planMixedSourceSql(sql, [dataset.alias]);
  if (direct) return {
    ...direct,
    datasetId: dataset.id,
    datasetName: dataset.name,
    warehouseRelations: extractWarehouseRelations(direct.warehouseSql),
  };
  if (relationPattern(dataset.alias).test(sql)) return null;

  const referenced = schemaTables
    .map((table) => ({ table, match: relationPattern(table.relation).exec(sql) }))
    .filter((item): item is { table: MixedSourceSchemaTable; match: RegExpExecArray } => Boolean(item.match))
    .sort((a, b) => (a.match.index ?? 0) - (b.match.index ?? 0));
  for (const { table } of referenced) {
    const pair = bestJoinKeyPair(table, dataset);
    if (!pair) continue;
    const qualifier = relationAlias(sql, table.relation);
    const expression = qualifier ? `${qualifier}.${pair.warehouseKey}` : pair.warehouseKey;
    return {
      datasetId: dataset.id,
      datasetName: dataset.name,
      localDataset: dataset.alias,
      localAlias: dataset.alias,
      localKey: pair.localKey,
      warehouseKey: pair.warehouseKey,
      warehouseExpression: expression,
      warehouseSql: ensureSelectedJoinKey(sql, expression, pair.warehouseKey),
      warehouseRelations: extractWarehouseRelations(sql),
    };
  }
  return null;
}

/**
 * Deterministic last-mile fallback for an explicitly named warehouse entity.
 * It is used only after certified and semantic coverage have missed. Selecting
 * the whole validated row keeps requested business detail columns without
 * inventing column names, and the staging endpoint applies the hard row limit.
 */
export function buildMixedSourceWarehouseFallbackSql(
  question: string,
  dataset: MixedSourceDatasetCandidate,
  schemaTables: MixedSourceSchemaTable[],
): string | undefined {
  const usableTables = deduplicateSchemaRelations(schemaTables).filter((table) =>
    normalizeDatasetMention(table.relation) !== normalizeDatasetMention(dataset.alias),
  );
  const scoredMentions = usableTables
    .map((table) => ({ table, score: tableMentionScore(question, table.relation) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const qualifiedMentions = scoredMentions.filter((item) => item.score >= 1_000);
  const mentioned = qualifiedMentions.length > 0 ? qualifiedMentions : scoredMentions;
  const rankedRoots = (mentioned.length > 0 ? mentioned : usableTables.map((table) => ({ table, score: 0 }))).flatMap(({ table, score }) => {
    const pair = bestJoinKeyPair(table, dataset);
    if (!pair) return [];
    return [{ table, score: score + 500 - table.relation.length }];
  }).sort((a, b) => b.score - a.score);
  const root = rankedRoots[0]?.table;
  if (!root) return undefined;

  const requestedTables = mentioned
    .map((item) => item.table)
    .filter((table) => table.relation !== root.relation);
  const joined: Array<{ table: MixedSourceSchemaTable; alias: string }> = [{ table: root, alias: 'warehouse' }];
  const joins: Array<{ table: MixedSourceSchemaTable; alias: string; leftAlias: string; leftKey: string; rightKey: string }> = [];
  let remaining = [...requestedTables];
  while (remaining.length > 0) {
    let next: typeof joins[number] | undefined;
    let nextIndex = -1;
    for (let index = 0; index < remaining.length && !next; index += 1) {
      const candidate = remaining[index];
      for (const left of joined) {
        const pair = bestWarehouseJoinKeyPair(left.table, candidate);
        if (!pair) continue;
        nextIndex = index;
        next = {
          table: candidate,
          alias: `warehouse_${joined.length}`,
          leftAlias: left.alias,
          leftKey: pair.leftKey,
          rightKey: pair.rightKey,
        };
        break;
      }
    }
    if (!next) break;
    joins.push(next);
    joined.push({ table: next.table, alias: next.alias });
    remaining.splice(nextIndex, 1);
  }

  const selectedNames = new Set(root.columns.map((column) => column.name.toLowerCase()));
  const extraSelections = joins.flatMap((join) => join.table.columns
    .filter((column) => column.name !== join.rightKey)
    .map((column) => {
      const duplicate = selectedNames.has(column.name.toLowerCase());
      selectedNames.add(column.name.toLowerCase());
      const output = duplicate ? `${relationBaseName(join.table.relation)}_${column.name}` : column.name;
      return `  ${join.alias}.${quoteIdentifier(column.name)} AS ${quoteIdentifier(output)}`;
    }));
  const selections = ['  warehouse.*', ...extraSelections];
  return [
    'SELECT',
    selections.join(',\n'),
    `FROM ${root.relation} AS warehouse`,
    ...joins.map((join) =>
      `LEFT JOIN ${join.table.relation} AS ${join.alias}\n  ON ${join.leftAlias}.${quoteIdentifier(join.leftKey)} = ${join.alias}.${quoteIdentifier(join.rightKey)}`,
    ),
  ].join('\n');
}

/**
 * Extract the common OSS notebook pattern where a warehouse query directly
 * joins one registered local dataset. The result is deliberately conservative:
 * ambiguous joins return null so the user is asked instead of receiving unsafe SQL.
 */
export function planMixedSourceSql(sql: string, datasetAliases: string[]): MixedSourceSqlPlan | null {
  for (const localDataset of datasetAliases) {
    const relation = escapeRegExp(localDataset);
    const joinPattern = new RegExp(
      `\\s+(?:(?:inner|left|right|full|cross)\\s+)?join\\s+(?:["\\x60])?${relation}(?:["\\x60])?`
        + `(?:\\s+(?:as\\s+)?((?!on\\b)[a-zA-Z_][a-zA-Z0-9_$]*))?\\s+on\\s+`
        + `([\\s\\S]*?)(?=\\s+(?:(?:inner|left|right|full|cross)\\s+)?join\\b|\\s+where\\b|\\s+group\\s+by\\b|\\s+order\\s+by\\b|\\s+limit\\b|$)`,
      'i',
    );
    const join = joinPattern.exec(sql);
    if (!join) continue;
    const localAlias = join[1] || localDataset;
    const equality = findLocalEquality(join[2], localAlias, localDataset);
    if (!equality) return null;
    const warehouseSqlWithoutJoin = `${sql.slice(0, join.index)} ${sql.slice(join.index + join[0].length)}`
      .replace(/\s+/g, ' ')
      .trim();
    if (relationPattern(localDataset).test(warehouseSqlWithoutJoin)) return null;
    const warehouseKey = lastIdentifier(equality.warehouseExpression);
    if (!warehouseKey) return null;
    const warehouseSql = ensureSelectedJoinKey(
      warehouseSqlWithoutJoin,
      equality.warehouseExpression,
      warehouseKey,
    );
    return {
      localDataset,
      localAlias,
      localKey: equality.localKey,
      warehouseKey,
      warehouseExpression: equality.warehouseExpression,
      warehouseSql,
    };
  }
  return null;
}

function findLocalEquality(
  predicate: string,
  localAlias: string,
  localDataset: string,
): { localKey: string; warehouseExpression: string } | null {
  const localQualifiers = new Set([localAlias, localDataset].map(normalizeIdentifier));
  for (const condition of predicate.split(/\s+and\s+/i)) {
    const match = condition.trim().match(/^([a-zA-Z_][\w$]*\s*\.\s*["\x60]?[a-zA-Z_][\w$]*["\x60]?)\s*=\s*([a-zA-Z_][\w$]*\s*\.\s*["\x60]?[a-zA-Z_][\w$]*["\x60]?)$/i);
    if (!match) continue;
    const left = qualifiedIdentifier(match[1]);
    const right = qualifiedIdentifier(match[2]);
    if (left && localQualifiers.has(left.qualifier)) {
      return { localKey: left.column, warehouseExpression: match[2].replace(/\s+/g, '') };
    }
    if (right && localQualifiers.has(right.qualifier)) {
      return { localKey: right.column, warehouseExpression: match[1].replace(/\s+/g, '') };
    }
  }
  return null;
}

function ensureSelectedJoinKey(sql: string, expression: string, outputName: string): string {
  const select = sql.match(/^\s*select\s+([\s\S]*?)\s+from\s+/i);
  if (!select || select[1].includes('*') || normalizeSql(select[1]).includes(normalizeSql(expression))) return sql;
  const replacement = `SELECT ${select[1].trim()}, ${expression} AS "${outputName.replace(/"/g, '""')}" FROM `;
  return `${replacement}${sql.slice(select.index! + select[0].length)}`;
}

function qualifiedIdentifier(value: string): { qualifier: string; column: string } | null {
  const match = value.replace(/\s+/g, '').match(/^([^.]*)\.(.*)$/);
  if (!match) return null;
  return { qualifier: normalizeIdentifier(match[1]), column: normalizeIdentifier(match[2]) };
}

function lastIdentifier(value: string): string {
  return normalizeIdentifier(value.split('.').pop() ?? '');
}

function normalizeIdentifier(value: string): string {
  return value.replace(/^["\x60]|["\x60]$/g, '').toLowerCase();
}

function bestJoinKeyPair(
  table: MixedSourceSchemaTable,
  dataset: MixedSourceDatasetCandidate,
): { warehouseKey: string; localKey: string } | undefined {
  const entityTokens = identifierTokens(dataset.alias)
    .filter((token) => token !== 'csv' && token !== 'dataset' && token !== 'data')
    .map(singularToken);
  const pairs = table.columns.flatMap((warehouse) => dataset.columns.map((local) => {
    const warehouseName = normalizeIdentifier(warehouse.name);
    const localName = normalizeIdentifier(local.name);
    let score = 0;
    if (warehouseName === localName) score = 100;
    else if (localName === 'id' && warehouseName.endsWith('_id')) {
      const owner = singularToken(warehouseName.slice(0, -3));
      score = entityTokens.includes(owner) ? 96 : 55;
    } else if (warehouseName === 'id' && localName.endsWith('_id')) score = 80;
    else if (canonicalKey(warehouseName) === canonicalKey(localName)) score = 90;
    if (local.flags?.includes('identifier')) score += 4;
    return { warehouseKey: warehouse.name, localKey: local.name, score };
  }));
  const best = pairs.sort((a, b) => b.score - a.score)[0];
  return best && best.score >= 70 ? best : undefined;
}

function bestWarehouseJoinKeyPair(
  left: MixedSourceSchemaTable,
  right: MixedSourceSchemaTable,
): { leftKey: string; rightKey: string } | undefined {
  const rightByName = new Map(right.columns.map((column) => [column.name.toLowerCase(), column.name]));
  const candidates = left.columns.flatMap((column) => {
    const key = column.name.toLowerCase();
    const rightKey = rightByName.get(key);
    if (!rightKey || !/(^id$|_id$|^key$|_key$)/i.test(key)) return [];
    return [{ leftKey: column.name, rightKey, score: key === 'id' ? 80 : 100 }];
  });
  return candidates.sort((a, b) => b.score - a.score)[0];
}

function tableMentionScore(question: string, relation: string): number {
  const questionText = identifierTokens(question).map(singularToken).join(' ');
  const tokens = identifierTokens(relation).map(singularToken);
  if (tokens.length === 0) return 0;
  const suffix = tokens.slice(-2).join(' ');
  if (suffix && questionText.includes(suffix)) return 1_000 + suffix.length;
  const tableName = tokens[tokens.length - 1];
  return tableName.length > 2 && new RegExp(`(?:^| )${escapeRegExp(tableName)}(?: |$)`).test(questionText)
    ? 400 + tableName.length
    : 0;
}

function deduplicateSchemaRelations(tables: MixedSourceSchemaTable[]): MixedSourceSchemaTable[] {
  const bySuffix = new Map<string, MixedSourceSchemaTable>();
  for (const table of tables) {
    const tokens = identifierTokens(table.relation);
    const key = tokens.slice(-2).join('.');
    const current = bySuffix.get(key);
    if (!current || table.relation.length < current.relation.length) bySuffix.set(key, table);
  }
  return [...bySuffix.values()];
}

function relationBaseName(relation: string): string {
  return normalizeIdentifier(relation.split('.').pop() ?? 'source');
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function extractWarehouseRelations(sql: string): string[] {
  const relations: string[] = [];
  const pattern = /\b(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_$]*(?:\.[a-zA-Z_][a-zA-Z0-9_$]*){0,2})/gi;
  for (const match of sql.matchAll(pattern)) {
    if (!relations.includes(match[1])) relations.push(match[1]);
  }
  return relations;
}

function relationAlias(sql: string, relation: string): string | undefined {
  const escaped = escapeRegExp(relation);
  const match = sql.match(new RegExp(`\\b(?:from|join)\\s+(?:["\\x60])?${escaped}(?:["\\x60])?(?:\\s+(?:as\\s+)?([a-zA-Z_][a-zA-Z0-9_$]*))?`, 'i'));
  const alias = match?.[1];
  return alias && !/^(where|join|left|right|inner|full|cross|group|order|limit)$/i.test(alias)
    ? alias
    : undefined;
}

function identifierTokens(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function singularToken(value: string): string {
  return value.endsWith('ies') ? `${value.slice(0, -3)}y` : value.endsWith('s') ? value.slice(0, -1) : value;
}

function normalizeDatasetMention(value: string): string {
  return identifierTokens(value).map(singularToken).join('');
}

function canonicalKey(value: string): string {
  return value.replace(/[^a-z0-9]/g, '').replace(/identifier$/, 'id');
}

function normalizeSql(value: string): string {
  return value.replace(/["\x60\s]/g, '').toLowerCase();
}

function relationPattern(alias: string): RegExp {
  return new RegExp(`(?:^|[^a-zA-Z0-9_])(?:["\\x60])?${escapeRegExp(alias)}(?:["\\x60])?(?=$|[^a-zA-Z0-9_])`, 'i');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
