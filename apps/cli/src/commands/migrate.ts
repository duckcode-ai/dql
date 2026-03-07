import type { CLIFlags } from '../args.js';

export type MigrationSource = 'looker' | 'tableau' | 'dbt' | 'metabase' | 'raw-sql';

export interface MigrationResult {
  source: MigrationSource;
  blocksGenerated: number;
  metricsGenerated: number;
  dimensionsGenerated: number;
  needsReview: number;
}

/**
 * Generate a DQL block skeleton from a source tool definition.
 */
function generateBlockDQL(opts: {
  name: string;
  domain: string;
  type: string;
  description: string;
  sql: string;
  owner: string;
  tags: string[];
}): string {
  const tagStr = opts.tags.map((t) => `"${t}"`).join(', ');
  return `block "${opts.name}" {
    domain = "${opts.domain}"
    type = "${opts.type}"
    description = "${opts.description}"
    tags = [${tagStr}]
    owner = "${opts.owner}"

    query = """
        ${opts.sql.split('\n').join('\n        ')}
    """

    visualization {
        chart = "bar"
        x = dimension
        y = measure
    }

    tests {
        assert row_count > 0
    }
}
`;
}

export async function runMigrate(file: string, flags: CLIFlags): Promise<void> {
  // file is used as the source type for migration
  const source = file as MigrationSource;
  const validSources: MigrationSource[] = ['looker', 'tableau', 'dbt', 'metabase', 'raw-sql'];

  if (!validSources.includes(source)) {
    console.error(`\n  ✗ Unknown migration source: "${source}"`);
    console.error(`    Valid sources: ${validSources.join(', ')}`);
    console.error('');
    process.exit(1);
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      source,
      status: 'scaffold',
      message: `Migration from ${source} is scaffold-only in the OSS CLI. Use the generated block as a starting point.`,
      exampleBlock: generateBlockDQL({
        name: `migrated-from-${source}`,
        domain: 'migrated',
        type: 'chart.bar',
        description: `Auto-migrated from ${source}`,
        sql: 'SELECT dimension, SUM(measure) AS measure\nFROM source_table\nGROUP BY dimension',
        owner: 'migration-bot',
        tags: ['migrated', source],
      }),
    }, null, 2));
    return;
  }

  console.log(`\n  DQL Migration: ${source}`);
  console.log('  ─────────────────────────────');

  switch (source) {
    case 'looker':
      console.log('  Source: LookML explores + measures + dimensions');
      console.log('  Method: Parse LookML → generate DQL blocks + semantic layer YAML');
      console.log('  Coverage: ~80% automated');
      break;
    case 'tableau':
      console.log('  Source: Workbook calculations + dashboard structure');
      console.log('  Method: Extract via REST API → generate DQL blocks per sheet');
      console.log('  Coverage: Semi-automated');
      break;
    case 'dbt': {
      const dbtDir = flags.input || '.';
      console.log(`  Source: dbt project at "${dbtDir}"`);
      console.log('  Method: Inspect models and metrics, then scaffold DQL blocks and semantic layer files manually.');
      console.log('  Coverage: Planning-only in OSS V1');
      break;
    }
    case 'metabase':
      console.log('  Source: Saved questions + dashboard cards');
      console.log('  Method: Export via API → generate DQL blocks per question');
      console.log('  Coverage: ~85% automated');
      break;
    case 'raw-sql':
      console.log('  Source: Ad-hoc SQL scripts');
      console.log('  Method: AI wraps in DQL block structure + adds metadata');
      console.log('  Coverage: AI-assisted');
      break;
  }

  console.log('\n  Example generated block:');
  console.log('  ───');
  const example = generateBlockDQL({
    name: `migrated-from-${source}`,
    domain: 'migrated',
    type: 'chart.bar',
    description: `Auto-migrated from ${source}`,
    sql: 'SELECT dimension, SUM(measure) AS measure\nFROM source_table\nGROUP BY dimension',
    owner: 'migration-bot',
    tags: ['migrated', source],
  });
  console.log(example.split('\n').map((l) => `    ${l}`).join('\n'));

  console.log('  Next steps:');
  console.log(`    1. Provide source files: dql migrate ${source} --input <path>`);
  console.log('    2. Review generated blocks in blocks/migrated/');
  console.log('    3. Run: dql test blocks/migrated/example.dql');
  console.log('    4. Commit and push for certification');
  console.log('');
}
