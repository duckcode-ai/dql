import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Certifier } from '@duckcodeailabs/dql-governance';
import type { BlockRecord, BlockStatus } from '@duckcodeailabs/dql-project';
import type { DQLContext } from '../context.js';

export const suggestBlockInput = {
  name: z.string().describe('Proposed block name (kebab_case).'),
  domain: z.string().describe('Business domain (finance, product, …).'),
  owner: z.string().describe('Block owner identity (email or team handle).'),
  description: z.string().describe('One-line description of what the block answers.'),
  sql: z.string().describe('The block body SQL.'),
  tags: z.array(z.string()).optional(),
  chartType: z.string().optional().describe('Optional visualization type.'),
};

/**
 * Write a proposed block to `blocks/_drafts/<name>.dql` and return the
 * governance-gate result. Never auto-certifies — the human still has to
 * review and move the file.
 */
export function suggestBlock(
  ctx: DQLContext,
  args: {
    name: string;
    domain: string;
    owner: string;
    description: string;
    sql: string;
    tags?: string[];
    chartType?: string;
  },
) {
  const safeName = args.name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  if (!safeName) return { error: 'Invalid block name.' };

  const now = new Date();
  const record: BlockRecord = {
    id: safeName,
    name: safeName,
    domain: args.domain,
    type: args.chartType ? 'chart' : 'block',
    version: '0.1.0',
    status: 'draft' as BlockStatus,
    gitRepo: '',
    gitPath: `blocks/_drafts/${safeName}.dql`,
    gitCommitSha: '',
    description: args.description,
    owner: args.owner,
    tags: args.tags ?? [],
    dependencies: [],
    usedInCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  const certification = new Certifier().evaluate(record);

  const draftsDir = join(ctx.projectRoot, 'blocks', '_drafts');
  mkdirSync(draftsDir, { recursive: true });
  const filePath = join(draftsDir, `${safeName}.dql`);
  writeFileSync(filePath, renderBlock(args, safeName));
  ctx.refresh();

  return {
    name: safeName,
    path: `blocks/_drafts/${safeName}.dql`,
    certified: certification.certified,
    errors: certification.errors,
    warnings: certification.warnings,
    nextStep: certification.certified
      ? 'Draft saved and passes governance. Move to the appropriate domain folder and commit.'
      : 'Draft saved but does NOT pass governance. Address errors before promotion.',
  };
}

function renderBlock(
  args: {
    name: string;
    domain: string;
    owner: string;
    description: string;
    sql: string;
    tags?: string[];
    chartType?: string;
  },
  safeName: string,
): string {
  const tagsLine = args.tags?.length ? `\n  tags = [${args.tags.map((t) => `"${t}"`).join(', ')}]` : '';
  const chartLine = args.chartType
    ? `\n\n  visualization {\n    chart = "${args.chartType}"\n  }`
    : '';
  const descEscaped = args.description.replace(/"/g, '\\"');
  return `// dql-format: 1
block "${safeName}" {
  domain = "${args.domain}"
  owner = "${args.owner}"
  description = "${descEscaped}"${tagsLine}

  query {
    sql = """
${args.sql.trimEnd()}
    """
  }${chartLine}
}
`;
}
