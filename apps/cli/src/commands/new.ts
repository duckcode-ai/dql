import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';

type ScaffoldKind = 'block' | 'dashboard' | 'workbook' | 'semantic-block';

export async function runNew(subject: string | null, rest: string[], flags: CLIFlags): Promise<void> {
  const { kind, rawName } = resolveNewTarget(subject, rest);

  const projectRoot = findProjectRoot(process.cwd());
  const title = toTitle(rawName);
  const slug = toSlug(rawName);
  const outputDir = resolve(projectRoot, defaultDirForKind(kind, flags.outDir));
  const filePath = join(outputDir, `${slug}.dql`);

  if (existsSync(filePath)) {
    throw new Error(`${capitalize(kind)} already exists: ${filePath}`);
  }

  mkdirSync(outputDir, { recursive: true });

  const owner = flags.owner || process.env.USER || 'team';
  const domain = flags.domain || 'general';
  const chart = normalizeChart(flags.chart || 'bar');
  const usingStarterData = existsSync(join(projectRoot, 'data', 'revenue.csv'));
  const metricName = `${slug}_metric`;

  const content = buildTemplate({
    kind,
    title,
    domain,
    owner,
    chart,
    queryOnly: flags.queryOnly,
    usingStarterData,
    metricName,
  });

  writeFileSync(filePath, content, 'utf-8');

  const relatedFiles = kind === 'semantic-block'
    ? writeSemanticCompanionFiles(projectRoot, slug, domain, owner, metricName)
    : [];

  const relativePath = relativeToProject(projectRoot, filePath);
  const nextSteps = nextStepsFor(kind, relativePath, usingStarterData, flags.queryOnly);

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      created: true,
      type: kind,
      name: title,
      path: filePath,
      previewReady: usingStarterData && kind !== 'semantic-block',
      relatedFiles,
      nextSteps,
    }, null, 2));
    return;
  }

  console.log(`\n  ✓ Created DQL ${kind}: ${title}`);
  console.log(`    Path: ${filePath}`);
  if (relatedFiles.length > 0) {
    console.log('    Related files:');
    relatedFiles.forEach((relatedFile) => console.log(`      - ${relatedFile}`));
  }
  console.log('');
  console.log('  Next steps:');
  nextSteps.forEach((step, index) => console.log(`    ${index + 1}. ${step}`));
  console.log('');
}

function resolveNewTarget(subject: string | null, rest: string[]): { kind: ScaffoldKind; rawName: string } {
  if (!subject) {
    throw new Error('Usage: dql new <block|dashboard|workbook> <name>');
  }

  if (subject === 'block' || subject === 'dashboard' || subject === 'workbook' || subject === 'semantic-block') {
    const rawName = rest.join(' ').trim();
    if (!rawName) {
      throw new Error(`Missing ${subject} name. Usage: dql new ${subject} <name>`);
    }
    return { kind: subject, rawName };
  }

  return { kind: 'block', rawName: subject };
}

function buildTemplate(opts: {
  kind: ScaffoldKind;
  title: string;
  domain: string;
  owner: string;
  chart: string;
  queryOnly: boolean;
  usingStarterData: boolean;
  metricName: string;
}): string {
  switch (opts.kind) {
    case 'dashboard':
      return buildDashboardTemplate(opts);
    case 'workbook':
      return buildWorkbookTemplate(opts);
    case 'semantic-block':
      return buildSemanticBlockTemplate(opts);
    case 'block':
    default:
      return buildBlockTemplate(opts);
  }
}

function buildBlockTemplate(opts: {
  title: string;
  domain: string;
  owner: string;
  chart: string;
  queryOnly: boolean;
  usingStarterData: boolean;
}): string {
  const description = opts.usingStarterData
    ? `Starter block for ${opts.title.toLowerCase()} using local sample data`
    : `Starter block for ${opts.title.toLowerCase()}`;

  const query = opts.usingStarterData ? starterBlockQueryForChart(opts.chart) : placeholderBlockQueryForChart(opts.chart);
  const params = opts.usingStarterData && (opts.chart === 'bar' || opts.chart === 'kpi')
    ? `
    params {
        period = "current_quarter"
    }
`
    : '';
  const visualization = opts.queryOnly ? '' : blockVisualizationForChart(opts.chart);

  return `block "${opts.title}" {
    domain = "${opts.domain}"
    type = "custom"
    description = "${description}"
    owner = "${opts.owner}"
    tags = ["starter", "${opts.domain}"]${params}

    query = """
${indentBlock(query, 8)}
    """${visualization}

    tests {
        assert row_count > 0
    }
}
`;
}

function buildSemanticBlockTemplate(opts: {
  title: string;
  domain: string;
  owner: string;
  metricName: string;
}): string {
  return `block "${opts.title}" {
    domain = "${opts.domain}"
    type = "semantic"
    description = "Starter semantic block for ${opts.title.toLowerCase()}"
    owner = "${opts.owner}"
    tags = ["starter", "semantic", "${opts.domain}"]
    metric = "${opts.metricName}"
}
`;
}

function buildDashboardTemplate(opts: {
  title: string;
  chart: string;
  usingStarterData: boolean;
}): string {
  const starterSource = `read_csv_auto('./data/revenue.csv')`;
  const source = opts.usingStarterData ? starterSource : 'your_table';
  const primaryChart = dashboardChartFor(opts.chart, source, opts.usingStarterData);
  const tableChart = `  chart.table(
    SELECT recognized_at, segment_tier, amount, fiscal_period
    FROM ${source}
    ORDER BY recognized_at DESC,
    title = "Recent Rows"
  )`;

  return `dashboard "${opts.title}" {
${primaryChart}

${tableChart}
}
`;
}

function buildWorkbookTemplate(opts: {
  title: string;
  usingStarterData: boolean;
}): string {
  const source = opts.usingStarterData ? `read_csv_auto('./data/revenue.csv')` : 'your_table';
  return `workbook "${opts.title}" {
  page "Summary" {
    chart.kpi(
      SELECT SUM(amount) AS total_revenue FROM ${source},
      metrics = ["total_revenue"],
      title = "Total Revenue"
    )
  }

  page "Trend" {
    chart.line(
      SELECT recognized_at AS revenue_date, SUM(amount) AS total_revenue
      FROM ${source}
      GROUP BY recognized_at
      ORDER BY recognized_at,
      x = revenue_date,
      y = total_revenue,
      title = "Revenue Trend"
    )
  }
}
`;
}

function starterBlockQueryForChart(chart: string): string {
  switch (chart) {
    case 'kpi':
      return `SELECT SUM(amount) AS total_revenue
FROM read_csv_auto('./data/revenue.csv')
WHERE fiscal_period = \${period}`;
    case 'line':
      return `SELECT recognized_at AS revenue_date, SUM(amount) AS total_revenue
FROM read_csv_auto('./data/revenue.csv')
GROUP BY recognized_at
ORDER BY recognized_at`;
    case 'table':
      return `SELECT recognized_at, segment_tier, amount, fiscal_period
FROM read_csv_auto('./data/revenue.csv')
ORDER BY recognized_at DESC`;
    case 'bar':
    default:
      return `SELECT segment_tier AS segment, SUM(amount) AS revenue
FROM read_csv_auto('./data/revenue.csv')
WHERE fiscal_period = \${period}
GROUP BY segment_tier
ORDER BY revenue DESC`;
  }
}

function placeholderBlockQueryForChart(chart: string): string {
  switch (chart) {
    case 'kpi':
      return `SELECT SUM(measure) AS total_revenue
FROM your_table`;
    case 'line':
      return `SELECT dimension_date AS revenue_date, SUM(measure) AS total_revenue
FROM your_table
GROUP BY dimension_date
ORDER BY dimension_date`;
    case 'table':
      return `SELECT *
FROM your_table
LIMIT 50`;
    case 'bar':
    default:
      return `SELECT dimension AS segment, SUM(measure) AS revenue
FROM your_table
GROUP BY dimension
ORDER BY revenue DESC`;
  }
}

function blockVisualizationForChart(chart: string): string {
  switch (chart) {
    case 'kpi':
      return `

    visualization {
        chart = "kpi"
        y = total_revenue
    }`;
    case 'line':
      return `

    visualization {
        chart = "line"
        x = revenue_date
        y = total_revenue
    }`;
    case 'table':
      return `

    visualization {
        chart = "table"
    }`;
    case 'bar':
    default:
      return `

    visualization {
        chart = "bar"
        x = segment
        y = revenue
    }`;
  }
}

function dashboardChartFor(chart: string, source: string, usingStarterData: boolean): string {
  switch (chart) {
    case 'kpi':
      return `  chart.kpi(
    SELECT SUM(amount) AS total_revenue FROM ${source},
    metrics = ["total_revenue"],
    title = "Total Revenue"
  )`;
    case 'line':
      return `  chart.line(
    SELECT recognized_at AS revenue_date, SUM(amount) AS total_revenue
    FROM ${source}
    GROUP BY recognized_at
    ORDER BY recognized_at,
    x = revenue_date,
    y = total_revenue,
    title = "Revenue Trend"
  )`;
    case 'table':
      return `  chart.table(
    SELECT recognized_at, segment_tier, amount, fiscal_period
    FROM ${source}
    ORDER BY recognized_at DESC,
    title = "Revenue Table"
  )`;
    case 'bar':
    default:
      return `  chart.bar(
    SELECT segment_tier AS segment, SUM(amount) AS revenue
    FROM ${source}${usingStarterData ? '\n    WHERE fiscal_period = "current_quarter"' : ''}
    GROUP BY segment_tier
    ORDER BY revenue DESC,
    x = segment,
    y = revenue,
    title = "Revenue by Segment"
  )`;
  }
}

function nextStepsFor(kind: ScaffoldKind, relativePath: string, usingStarterData: boolean, queryOnly: boolean): string[] {
  if (kind === 'semantic-block') {
    return [
      `dql parse ${relativePath}`,
      `dql info ${relativePath}`,
    ];
  }

  if (!usingStarterData) {
    return [
      `Edit ${relativePath} to replace the placeholder SQL`,
      `dql parse ${relativePath}`,
    ];
  }

  const steps = [`dql parse ${relativePath}`];
  if (kind === 'block') {
    steps.push(queryOnly ? `dql info ${relativePath}` : `dql preview ${relativePath}`);
  } else {
    steps.push(`dql preview ${relativePath}`);
  }
  return steps;
}

function defaultDirForKind(kind: ScaffoldKind, outDir: string): string {
  if (outDir) return outDir;
  switch (kind) {
    case 'dashboard':
      return 'dashboards';
    case 'semantic-block':
      return 'blocks';
    case 'workbook':
      return 'workbooks';
    case 'block':
    default:
      return 'blocks';
  }
}

function normalizeChart(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized || 'bar';
}

function indentBlock(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function toSlug(value: string): string {
  return value
    .replace(/\.dql$/i, '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'new_asset';
}

function toTitle(value: string): string {
  const cleaned = value.replace(/\.dql$/i, '').trim();
  if (!cleaned) return 'New Asset';
  if (/[A-Z]/.test(cleaned) || cleaned.includes(' ')) {
    return cleaned.replace(/[_-]+/g, ' ');
  }
  return cleaned
    .split(/[_-]+/g)
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(' ');
}

function relativeToProject(projectRoot: string, filePath: string): string {
  const normalizedRoot = `${resolve(projectRoot)}/`;
  const normalizedPath = resolve(filePath);
  return normalizedPath.startsWith(normalizedRoot)
    ? normalizedPath.slice(normalizedRoot.length)
    : basename(filePath);
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() || ''}${value.slice(1)}`;
}

function writeSemanticCompanionFiles(
  projectRoot: string,
  slug: string,
  domain: string,
  owner: string,
  metricName: string,
): string[] {
  const metricDir = join(projectRoot, 'semantic-layer', 'metrics');
  const blockDir = join(projectRoot, 'semantic-layer', 'blocks');
  mkdirSync(metricDir, { recursive: true });
  mkdirSync(blockDir, { recursive: true });

  const metricPath = join(metricDir, `${metricName}.yaml`);
  const blockPath = join(blockDir, `${slug}.yaml`);

  if (!existsSync(metricPath)) {
    writeFileSync(metricPath, `name: ${metricName}
label: ${toLabel(metricName)}
description: Starter semantic metric for ${toLabel(slug)}
domain: ${domain}
sql: SUM(measure)
type: sum
table: your_table
tags:
  - ${domain}
  - semantic
owner: ${owner}
`, 'utf-8');
  }

  if (!existsSync(blockPath)) {
    writeFileSync(blockPath, `name: ${slug}
block: ${slug}
domain: ${domain}
description: Companion business metadata for ${toLabel(slug)}
owner: ${owner}
tags:
  - ${domain}
  - semantic
semanticMappings:
  measure: ${metricName}
reviewStatus: review
`, 'utf-8');
  }

  return [relativeToProject(projectRoot, metricPath), relativeToProject(projectRoot, blockPath)];
}

function toLabel(value: string): string {
  return value
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() || ''}${part.slice(1)}`)
    .join(' ');
}
