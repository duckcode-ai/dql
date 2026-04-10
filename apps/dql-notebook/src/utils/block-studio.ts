import type { CellChartConfig } from '../store/types';

export interface BlockFields {
  domain: string;
  owner: string;
  description: string;
  tags: string[];
  blockType: string;
  name: string;
}

export function parseDqlChartConfig(content: string): CellChartConfig | undefined {
  const vizMatch = content.match(/visualization\s*\{([^}]+)\}/is);
  if (!vizMatch) return undefined;
  const body = vizMatch[1];
  const get = (key: string) =>
    body.match(new RegExp(`\\b${key}\\s*=\\s*["']?([\\w-]+)["']?`, 'i'))?.[1];
  const chart = get('chart');
  if (!chart) return undefined;
  return {
    chart,
    x: get('x'),
    y: get('y'),
    color: get('color'),
    title: get('title'),
  };
}

export function extractSqlFromText(dqlContent: string): string | null {
  const trimmed = dqlContent.trim();
  if (!trimmed) return null;

  const tripleQuoteMatch = trimmed.match(/query\s*=\s*"""([\s\S]*?)"""/i);
  if (tripleQuoteMatch) return tripleQuoteMatch[1].trim() || null;

  const bareTripleMatch = trimmed.match(/"""([\s\S]*?)"""/);
  if (bareTripleMatch) return bareTripleMatch[1].trim() || null;

  if (/^\s*(dashboard|workbook)\s+"/i.test(trimmed)) return null;

  const sqlKeywordMatch = trimmed.match(
    /\b(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|SHOW|DESCRIBE|EXPLAIN)\b([\s\S]*)/i,
  );
  if (sqlKeywordMatch) {
    let raw = sqlKeywordMatch[0];
    const dqlSectionStart = raw.search(/\b(visualization|tests|block)\s*\{/i);
    if (dqlSectionStart > 0) raw = raw.slice(0, dqlSectionStart);
    raw = trimAtNamedArgBoundary(raw);
    return raw.trim() || null;
  }

  return null;
}

function trimAtNamedArgBoundary(sql: string): string {
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth--;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i++;
      while (i < sql.length && sql[i] !== ch) {
        if (sql[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === ',' && depth === 0) {
      let j = i + 1;
      while (j < sql.length && /\s/.test(sql[j])) j++;
      if (j < sql.length && /[a-zA-Z_]/.test(sql[j])) {
        while (j < sql.length && /[a-zA-Z0-9_]/.test(sql[j])) j++;
        let k = j;
        while (k < sql.length && /\s/.test(sql[k])) k++;
        if (k < sql.length && sql[k] === '=' && sql[k + 1] !== '=') {
          return sql.slice(0, i);
        }
      }
    }
  }
  return sql;
}

export function parseBlockFields(content: string): BlockFields | null {
  if (!/^\s*block\s+"/i.test(content.trim())) return null;
  const str = (key: string) =>
    content.match(new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? '';
  const name = content.match(/^\s*block\s+"([^"]+)"/i)?.[1] ?? '';
  const tagsMatch = content.match(/\btags\s*=\s*\[([^\]]*)\]/i);
  const tags = tagsMatch
    ? (tagsMatch[1].match(/"([^"]*)"/g) ?? []).map((s: string) => s.slice(1, -1))
    : [];
  return {
    name,
    domain: str('domain'),
    owner: str('owner'),
    description: str('description'),
    blockType: str('type') || 'custom',
    tags,
  };
}

export function setBlockStringField(content: string, key: string, value: string): string {
  const escaped = value.replace(/"/g, '\\"');
  const re = new RegExp(`(\\b${key}\\s*=\\s*)"[^"]*"`, 'i');
  if (re.test(content)) {
    return content.replace(re, `$1"${escaped}"`);
  }
  return insertBlockField(content, `  ${key} = "${escaped}"`);
}

export function setBlockName(content: string, value: string): string {
  const escaped = value.replace(/"/g, '\\"');
  return /^\s*block\s+"/i.test(content)
    ? content.replace(/^(\s*block\s+)"[^"]+"/i, `$1"${escaped}"`)
    : content;
}

export function setBlockTags(content: string, tags: string[]): string {
  const tagStr = tags.map((tag) => `"${tag.replace(/"/g, '\\"')}"`).join(', ');
  const re = /(\btags\s*=\s*)\[[^\]]*\]/i;
  if (re.test(content)) {
    return content.replace(re, `$1[${tagStr}]`);
  }
  return insertBlockField(content, `  tags = [${tagStr}]`);
}

export function upsertVisualizationConfig(content: string, chartConfig: CellChartConfig): string {
  const lines: string[] = [];
  lines.push('visualization {');
  lines.push(`    chart = "${chartConfig.chart ?? 'table'}"`);
  if (chartConfig.x) lines.push(`    x = ${chartConfig.x}`);
  if (chartConfig.y) lines.push(`    y = ${chartConfig.y}`);
  if (chartConfig.color) lines.push(`    color = ${chartConfig.color}`);
  if (chartConfig.title) lines.push(`    title = "${chartConfig.title.replace(/"/g, '\\"')}"`);
  lines.push('  }');
  const block = lines.join('\n');
  if (/visualization\s*\{[\s\S]*?\n\s*\}/i.test(content)) {
    return content.replace(/visualization\s*\{[\s\S]*?\n\s*\}/i, block);
  }
  return insertBlockField(content, `  ${block.replace(/\n/g, '\n  ')}`, true);
}

export function buildSemanticRef(kind: 'metric' | 'dimension', name: string): string {
  return kind === 'metric' ? `@metric(${name})` : `@dim(${name})`;
}

export function extractSemanticReferences(content: string): {
  metrics: string[];
  dimensions: string[];
  segments: string[];
} {
  const metrics = new Set<string>();
  const dimensions = new Set<string>();
  const segments = new Set<string>();
  const semanticRegex = /@(metric|dim)\(([^)]+)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = semanticRegex.exec(content))) {
    const name = match[2].trim();
    if (!name) continue;
    if (match[1].toLowerCase() === 'metric') metrics.add(name);
    else dimensions.add(name);
  }
  const segmentRegex = /\/\*\s*segment:([^*]+)\*\//gi;
  while ((match = segmentRegex.exec(content))) {
    const name = match[1].trim();
    if (name) segments.add(name);
  }
  return {
    metrics: Array.from(metrics),
    dimensions: Array.from(dimensions),
    segments: Array.from(segments),
  };
}

function insertBlockField(content: string, field: string, beforeClosingBrace: boolean = false): string {
  const trimmed = content.trimEnd();
  if (!/^\s*block\s+"/i.test(trimmed)) {
    return `${trimmed}\n${field}\n`;
  }
  const insertion = beforeClosingBrace
    ? `\n\n${field}\n`
    : `\n${field}`;
  return trimmed.replace(/\n\}\s*$/, `${insertion}\n}`);
}
