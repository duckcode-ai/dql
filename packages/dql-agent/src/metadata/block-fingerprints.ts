import { createHash } from 'node:crypto';

export interface BlockSqlFingerprints {
  version: 'sql-fingerprint-v1';
  exact: string;
  parameterized: string;
}

export interface BlockBusinessFingerprint {
  version: 'business-shape-v1';
  hash: string;
  tokens: string[];
}

export interface BuildBlockBusinessFingerprintInput {
  name?: string;
  domain?: string;
  pattern?: string;
  grain?: string;
  entities?: string[];
  terms?: string[];
  outputs?: string[];
  dimensions?: string[];
  filters?: string[];
  sources?: string[];
  sourceSystems?: string[];
}

export function buildBlockSqlFingerprints(sql: string): BlockSqlFingerprints {
  return {
    version: 'sql-fingerprint-v1',
    exact: fingerprintSql(sql, false),
    parameterized: fingerprintSql(sql, true),
  };
}

export function normalizeSqlForFingerprint(sql: string, parameterized: boolean): string {
  let cleaned = String(sql ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (parameterized) {
    cleaned = cleaned
      .replace(/\$\{\s*[a-z_][a-z0-9_]*\s*\}/gi, '?')
      .replace(/\bdate\s+'(?:''|[^'])*'/g, '?')
      .replace(/\btimestamp\s+'(?:''|[^'])*'/g, '?')
      .replace(/'(?:''|[^'])*'/g, '?')
      .replace(/\b[0-9]+(?:\.[0-9]+)?\b/g, '?')
      .replace(/\bin\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/g, 'in (?)');
  }
  return cleaned;
}

export function fingerprintSql(sql: string, parameterized: boolean): string {
  const normalized = normalizeSqlForFingerprint(sql, parameterized);
  return hashText(normalized);
}

export function buildBlockBusinessFingerprint(input: BuildBlockBusinessFingerprintInput): BlockBusinessFingerprint {
  const tokens = new Set<string>();
  addToken(tokens, 'domain', input.domain);
  addToken(tokens, 'pattern', input.pattern);
  addToken(tokens, 'grain', input.grain);
  for (const entity of input.entities ?? []) addToken(tokens, 'entity', entity);
  for (const term of input.terms ?? []) addToken(tokens, 'term', term);
  for (const output of input.outputs ?? []) addToken(tokens, 'output', output);
  for (const dimension of input.dimensions ?? []) addToken(tokens, 'dimension', dimension);
  for (const filter of input.filters ?? []) addToken(tokens, 'filter', filter);
  for (const source of input.sources ?? []) {
    for (const token of relationFingerprintTokens(source)) addToken(tokens, 'source', token);
  }
  for (const sourceSystem of input.sourceSystems ?? []) addToken(tokens, 'system', sourceSystem);
  const values = Array.from(tokens).sort();
  return {
    version: 'business-shape-v1',
    hash: hashText(values.join('\n')),
    tokens: values,
  };
}

export function normalizeBusinessFingerprintToken(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[`"[\]]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function relationFingerprintTokens(relation: string): string[] {
  const normalized = String(relation ?? '').replace(/[`"[\]]/g, '').toLowerCase();
  const parts = normalized.split('.').filter(Boolean);
  return Array.from(new Set([
    normalized,
    parts.slice(-2).join('.'),
    parts.at(-1) ?? '',
  ].map(normalizeBusinessFingerprintToken).filter((item) => item.length >= 3)));
}

function addToken(tokens: Set<string>, prefix: string, value: string | undefined): void {
  const normalized = normalizeBusinessFingerprintToken(value ?? '');
  if (normalized) tokens.add(`${prefix}:${normalized}`);
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
