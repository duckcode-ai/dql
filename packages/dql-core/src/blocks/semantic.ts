import { formatDQL } from '../formatter/index.js';

export interface SemanticBlockParameterInput {
  name: string;
  type?: string;
  default?: unknown;
  policy?: string;
  binding?: string;
}

export interface SemanticBlockVisualizationInput {
  chart: string;
  x?: string;
  y?: string;
}

/**
 * Canonical authoring contract for semantic DQL blocks.
 *
 * Manual Block Studio, Notebook semantic cells, Ask/Notebook/Block AI, and MCP
 * all use this renderer so a governed selection has one DQL representation.
 * SQL is deliberately absent: semantic SQL belongs to the selected compiler
 * and is stored as execution evidence, never as a second source of truth.
 *
 * Acceptance: CONTRACT-002, AGT-017, AGT-021, API-006, UI-009, UI-016.
 */
export interface SemanticBlockSourceInput {
  name: string;
  status?: string;
  domain?: string;
  description?: string;
  owner?: string;
  tags?: string[];
  metrics: string[];
  dimensions?: string[];
  timeDimension?: { name: string; granularity: string };
  requestedFilters?: string[];
  orderBy?: Array<string | { name: string; direction: 'asc' | 'desc' }>;
  limit?: number;
  parameters?: SemanticBlockParameterInput[];
  visualization?: SemanticBlockVisualizationInput;
}

export function renderSemanticBlockSource(input: SemanticBlockSourceInput): string {
  const metrics = uniqueStrings(input.metrics);
  const dimensions = uniqueStrings(input.dimensions ?? []);
  const filters = uniqueStrings(input.requestedFilters ?? []);
  const orderBy = uniqueStrings((input.orderBy ?? []).map((item) =>
    typeof item === 'string' ? item : `${item.name} ${item.direction}`));
  const parameters = uniqueParameters(input.parameters ?? []);
  const lines = [
    `block ${dqlString(input.name)} {`,
    `  type = "semantic"`,
    `  status = ${dqlString(input.status?.trim() || 'draft')}`,
  ];
  const domain = meaningfulDomain(input.domain);
  if (domain) lines.push(`  domain = ${dqlString(domain)}`);
  if (input.description?.trim()) lines.push(`  description = ${dqlString(input.description.trim())}`);
  const tags = uniqueStrings(input.tags ?? []);
  if (tags.length > 0) lines.push(`  tags = [${tags.map(dqlString).join(', ')}]`);
  if (input.owner?.trim()) lines.push(`  owner = ${dqlString(input.owner.trim())}`);
  lines.push(`  metrics = [${metrics.map(dqlString).join(', ')}]`);
  lines.push(`  dimensions = [${dimensions.map(dqlString).join(', ')}]`);
  if (input.timeDimension?.name.trim()) {
    lines.push(`  time_dimension = ${dqlString(input.timeDimension.name.trim())}`);
    if (input.timeDimension.granularity.trim()) {
      lines.push(`  granularity = ${dqlString(input.timeDimension.granularity.trim())}`);
    }
  }
  if (filters.length > 0) lines.push(`  requested_filters = [${filters.map(dqlString).join(', ')}]`);
  if (orderBy.length > 0) lines.push(`  order_by = [${orderBy.map(dqlString).join(', ')}]`);
  if (validLimit(input.limit)) lines.push(`  limit = ${Math.floor(input.limit!)}`);
  if (parameters.length > 0) {
    lines.push('  params {');
    for (const parameter of parameters) {
      const type = parameter.type?.trim() ? `: ${parameter.type.trim()}` : '';
      const defaultValue = parameter.default !== undefined
        ? ` = ${dqlLiteral(parameter.default)}`
        : '';
      lines.push(`    ${parameter.name}${type}${defaultValue}`);
    }
    lines.push('  }');
    const policies = parameters.filter((parameter) => parameter.policy?.trim());
    if (policies.length > 0) {
      lines.push('  parameterPolicy {');
      for (const parameter of policies) {
        lines.push(`    ${parameter.name} = ${dqlString(parameter.policy!.trim())}`);
      }
      lines.push('  }');
    }
    const bindings = parameters.filter((parameter) => parameter.binding?.trim());
    if (bindings.length > 0) {
      lines.push('  filterBindings {');
      for (const parameter of bindings) {
        lines.push(`    ${parameter.name} = ${dqlString(parameter.binding!.trim())}`);
      }
      lines.push('  }');
    }
  }
  if (input.visualization?.chart.trim()) {
    lines.push('  visualization {');
    lines.push(`    chart = ${dqlString(input.visualization.chart.trim())}`);
    if (input.visualization.x?.trim()) lines.push(`    x = ${dqlBinding(input.visualization.x.trim())}`);
    if (input.visualization.y?.trim()) lines.push(`    y = ${dqlBinding(input.visualization.y.trim())}`);
    lines.push('  }');
  }
  lines.push('}');
  return formatDQL(`${lines.join('\n')}\n`);
}

function meaningfulDomain(value: string | undefined): string | undefined {
  const domain = value?.trim();
  if (!domain || domain === 'uncategorized' || domain === '_uncategorized') return undefined;
  return domain;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueParameters(values: SemanticBlockParameterInput[]): SemanticBlockParameterInput[] {
  const byName = new Map<string, SemanticBlockParameterInput>();
  for (const value of values) {
    const name = value.name.trim();
    if (!name || byName.has(name)) continue;
    byName.set(name, { ...value, name });
  }
  return [...byName.values()];
}

function validLimit(value: number | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function dqlLiteral(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(dqlLiteral).join(', ')}]`;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return dqlString(String(value ?? ''));
}

function dqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function dqlBinding(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : dqlString(value);
}
