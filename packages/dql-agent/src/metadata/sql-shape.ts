export interface SimpleSelectShape {
  selectExpressions: string[];
  relation: string;
}

export interface SqlShapeColumn {
  name: string;
  description?: string;
}

export function extractSimpleSelectShape(sql: string): SimpleSelectShape | undefined {
  const cleaned = stripSqlComments(sql).replace(/;\s*$/, '').trim();
  const match = cleaned.match(/\bselect\b([\s\S]*?)\bfrom\s+((?:"[^"]+"|`[^`]+`|[\w.-]+)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|[\w-]+))*)/i);
  if (!match) return undefined;
  const selectExpressions = splitSqlSelectList(match[1] ?? '')
    .map((expression) => expression.trim())
    .filter((expression) => expression.length > 0 && expression !== '*');
  const relation = (match[2] ?? '').trim();
  if (selectExpressions.length === 0 || !relation) return undefined;
  return { selectExpressions, relation };
}

export function sourceSqlShapeColumns(sql: string): SqlShapeColumn[] {
  const shape = extractSimpleSelectShape(sql);
  if (!shape) return [];
  const seen = new Set<string>();
  const columns: SqlShapeColumn[] = [];
  for (const expression of shape.selectExpressions) {
    const name = selectExpressionOutputName(expression);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    columns.push({
      name,
      description: 'Projected by certified source SQL shape.',
    });
  }
  return columns;
}

export function selectExpressionOutputName(expression: string): string | undefined {
  const alias = expression.match(/\bas\s+(["`]?\w+["`]?)\s*$/i)?.[1]
    ?? expression.match(/\s+(["`]?\w+["`]?)\s*$/i)?.[1];
  if (alias && !/\)|\+|-|\*|\//.test(alias)) return cleanSqlIdentifier(alias);
  const simple = expression.match(/^(?:(["`]?\w+["`]?)\.)?(["`]?\w+["`]?)$/);
  return simple ? cleanSqlIdentifier(simple[2] ?? '') : undefined;
}

export function compactSqlSnippet(sql: string, maxLength: number): string {
  const compact = stripSqlComments(sql).replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSqlSelectList(selectList: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  for (let index = 0; index < selectList.length; index += 1) {
    const char = selectList[index]!;
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')' && depth > 0) depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function cleanSqlIdentifier(identifier: string): string {
  return identifier.replace(/^["`]|["`]$/g, '').trim();
}
