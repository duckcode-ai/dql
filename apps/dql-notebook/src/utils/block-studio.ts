import type { CellChartConfig } from '../store/types';

export interface BlockFields {
  domain: string;
  owner: string;
  description: string;
  tags: string[];
  blockType: string;
  name: string;
}

interface ParsedBlockDocument extends BlockFields {
  metric: string;
  metrics: string[];
  dimensions: string[];
  timeDimension: string;
  granularity: string;
  query: string;
  visualization: string;
  tests: string;
}

interface SemanticSelection {
  kind: 'metric' | 'dimension';
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
    title: body.match(/\btitle\s*=\s*"([^"]+)"/i)?.[1],
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
  const parsed = parseBlockDocument(content);
  if (!parsed) return null;
  return {
    name: parsed.name,
    domain: parsed.domain,
    owner: parsed.owner,
    description: parsed.description,
    blockType: parsed.blockType,
    tags: parsed.tags,
  };
}

export function setBlockStringField(content: string, key: string, value: string): string {
  const parsed = parseBlockDocument(content);
  if (!parsed) {
    const escaped = value.replace(/"/g, '\\"');
    const re = new RegExp(`(\\b${key}\\s*=\\s*)"[^"]*"`, 'i');
    if (re.test(content)) {
      return content.replace(re, `$1"${escaped}"`);
    }
    return insertBlockField(content, `  ${key} = "${escaped}"`);
  }

  const next = { ...parsed };
  if (key === 'domain') next.domain = value;
  if (key === 'owner') next.owner = value;
  if (key === 'description') next.description = value;
  if (key === 'type') next.blockType = value;
  return normalizeBlockDocument(next);
}

export function setBlockName(content: string, value: string): string {
  const parsed = parseBlockDocument(content);
  if (!parsed) {
    const escaped = value.replace(/"/g, '\\"');
    return /^\s*block\s+"/i.test(content)
      ? content.replace(/^(\s*block\s+)"[^"]+"/i, `$1"${escaped}"`)
      : content;
  }
  return normalizeBlockDocument({ ...parsed, name: value });
}

export function setBlockTags(content: string, tags: string[]): string {
  const parsed = parseBlockDocument(content);
  if (!parsed) {
    const tagStr = tags.map((tag) => `"${tag.replace(/"/g, '\\"')}"`).join(', ');
    const re = /(\btags\s*=\s*)\[[^\]]*\]/i;
    if (re.test(content)) {
      return content.replace(re, `$1[${tagStr}]`);
    }
    return insertBlockField(content, `  tags = [${tagStr}]`);
  }
  return normalizeBlockDocument({ ...parsed, tags });
}

export function upsertVisualizationConfig(content: string, chartConfig: CellChartConfig): string {
  const parsed = parseBlockDocument(content);
  const visualization = buildVisualizationSection(chartConfig);
  if (!parsed) {
    if (/visualization\s*\{[\s\S]*?\n\s*\}/i.test(content)) {
      return content.replace(/visualization\s*\{[\s\S]*?\n\s*\}/i, visualization);
    }
    return insertBlockField(content, `  ${visualization.replace(/\n/g, '\n  ')}`, true);
  }
  return normalizeBlockDocument({ ...parsed, visualization });
}

export function buildSemanticRef(kind: 'metric' | 'dimension', name: string): string {
  return kind === 'metric' ? `@metric(${name})` : `@dim(${name})`;
}

export function upsertSemanticSelection(content: string, selection: SemanticSelection): string {
  const parsed = parseBlockDocument(content);
  if (!parsed || parsed.blockType !== 'semantic') return content;

  const next: ParsedBlockDocument = {
    ...parsed,
    metrics: [...parsed.metrics],
    dimensions: [...parsed.dimensions],
  };

  if (selection.kind === 'metric') {
    const allMetrics = new Set<string>();
    if (next.metric) allMetrics.add(next.metric);
    for (const metric of next.metrics) allMetrics.add(metric);
    allMetrics.add(selection.name);
    const orderedMetrics = Array.from(allMetrics);
    next.metric = orderedMetrics.length === 1 ? orderedMetrics[0] : '';
    next.metrics = orderedMetrics.length > 1 ? orderedMetrics : [];
  } else if (!next.dimensions.includes(selection.name)) {
    next.dimensions = [...next.dimensions, selection.name];
  }

  return normalizeBlockDocument(next);
}

export function appendSemanticRefToQuery(content: string, reference: string): string {
  const parsed = parseBlockDocument(content);
  if (!parsed || parsed.blockType !== 'custom') {
    return `${content.trimEnd()}\n${reference}\n`;
  }
  const query = parsed.query.trimEnd();
  const nextQuery = query ? `${query}\n${reference}` : reference;
  return normalizeBlockDocument({ ...parsed, query: nextQuery });
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

function parseBlockDocument(content: string): ParsedBlockDocument | null {
  if (!/^\s*block\s+"/i.test(content.trim())) return null;
  const str = (key: string) =>
    content.match(new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? '';
  const name = content.match(/^\s*block\s+"([^"]+)"/i)?.[1] ?? '';
  const tagsMatch = content.match(/\btags\s*=\s*\[([^\]]*)\]/i);
  const queryMatch = content.match(/query\s*=\s*"""([\s\S]*?)"""/i);
  return {
    name,
    domain: str('domain'),
    owner: str('owner'),
    description: str('description'),
    blockType: (str('type') || 'custom').toLowerCase() === 'semantic' ? 'semantic' : 'custom',
    tags: tagsMatch ? (tagsMatch[1].match(/"([^"]*)"/g) ?? []).map((value) => value.slice(1, -1)) : [],
    metric: str('metric'),
    metrics: parseArrayField(content, 'metrics'),
    dimensions: parseArrayField(content, 'dimensions'),
    timeDimension: str('time_dimension'),
    granularity: str('granularity'),
    query: queryMatch?.[1]?.trim() ?? '',
    visualization: extractNamedBlock(content, 'visualization'),
    tests: extractNamedBlock(content, 'tests'),
  };
}

function parseArrayField(content: string, key: string): string[] {
  const match = content.match(new RegExp(`\\b${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'i'));
  if (!match) return [];
  return (match[1].match(/"([^"]*)"/g) ?? []).map((value) => value.slice(1, -1)).filter(Boolean);
}

function extractNamedBlock(content: string, key: string): string {
  const startMatch = new RegExp(`\\b${key}\\s*\\{`, 'i').exec(content);
  if (!startMatch || startMatch.index == null) return '';
  let depth = 0;
  let start = -1;
  for (let i = startMatch.index; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        return content.slice(startMatch.index, i + 1).trim();
      }
    }
  }
  return '';
}

function normalizeBlockDocument(doc: ParsedBlockDocument): string {
  const lines = [
    `block "${escapeDqlString(doc.name || 'New Block')}" {`,
    `  domain = "${escapeDqlString(doc.domain || 'uncategorized')}"`,
    `  type = "${doc.blockType}"`,
    `  description = "${escapeDqlString(doc.description)}"`,
    `  owner = "${escapeDqlString(doc.owner)}"`,
    `  tags = [${doc.tags.map((tag) => `"${escapeDqlString(tag)}"`).join(', ')}]`,
  ];

  if (doc.blockType === 'semantic') {
    const semanticMetrics = doc.metrics.length > 0
      ? Array.from(new Set(doc.metrics))
      : doc.metric
        ? [doc.metric]
        : [];
    if (semanticMetrics.length === 1) {
      lines.push(`  metric = "${escapeDqlString(semanticMetrics[0])}"`);
    } else if (semanticMetrics.length > 1) {
      lines.push(`  metrics = [${semanticMetrics.map((metric) => `"${escapeDqlString(metric)}"`).join(', ')}]`);
    }
    if (doc.dimensions.length > 0) {
      lines.push(`  dimensions = [${Array.from(new Set(doc.dimensions)).map((dimension) => `"${escapeDqlString(dimension)}"`).join(', ')}]`);
    }
    if (doc.timeDimension) {
      lines.push(`  time_dimension = "${escapeDqlString(doc.timeDimension)}"`);
    }
    if (doc.granularity) {
      lines.push(`  granularity = "${escapeDqlString(doc.granularity)}"`);
    }
  }

  if (doc.blockType === 'custom') {
    lines.push('');
    lines.push('  query = """');
    lines.push(...indentBlock(doc.query.trim(), 4));
    lines.push('  """');
  }

  if (doc.visualization) {
    lines.push('');
    lines.push(...indentExistingBlock(doc.visualization, 2));
  }

  if (doc.tests) {
    lines.push('');
    lines.push(...indentExistingBlock(doc.tests, 2));
  }

  lines.push('}');
  return lines.join('\n') + '\n';
}

function buildVisualizationSection(chartConfig: CellChartConfig): string {
  const lines: string[] = [];
  lines.push('visualization {');
  lines.push(`  chart = "${chartConfig.chart ?? 'table'}"`);
  if (chartConfig.x) lines.push(`  x = ${chartConfig.x}`);
  if (chartConfig.y) lines.push(`  y = ${chartConfig.y}`);
  if (chartConfig.color) lines.push(`  color = ${chartConfig.color}`);
  if (chartConfig.title) lines.push(`  title = "${escapeDqlString(chartConfig.title)}"`);
  lines.push('}');
  return lines.join('\n');
}

function indentBlock(value: string, spaces: number): string[] {
  const indent = ' '.repeat(spaces);
  const lines = value ? value.split('\n') : [''];
  return lines.map((line) => `${indent}${line}`);
}

function indentExistingBlock(value: string, spaces: number): string[] {
  const indent = ' '.repeat(spaces);
  return value.split('\n').map((line) => `${indent}${line.trimEnd()}`);
}

function escapeDqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
