import { readFileSync } from 'node:fs';
import { Parser } from '@dql/core';
import { CostEstimator } from '@dql/governance';
import type { CLIFlags } from '../args.js';

export async function runInfo(filePath: string, flags: CLIFlags): Promise<void> {
  const source = readFileSync(filePath, 'utf-8');
  const parser = new Parser(source, filePath);
  const ast = parser.parse();

  const blocks = ast.statements.filter((s: any) => s.kind === 'BlockDecl');

  if (blocks.length === 0) {
    console.log('\n  ⚠ No block declarations found in file.');
    console.log('');
    return;
  }

  const estimator = new CostEstimator();

  for (const block of blocks) {
    const b = block as any;

    if (flags.format === 'json') {
      const cost = b.query ? estimator.estimate(b.query) : null;
      console.log(JSON.stringify({
        name: b.name,
        domain: b.domain,
        type: b.type,
        description: b.description,
        owner: b.owner,
        tags: b.tags,
        query: b.query,
        params: b.params,
        tests: b.tests?.length ?? 0,
        costEstimate: cost,
      }, null, 2));
      continue;
    }

    console.log(`\n  Block: "${b.name ?? 'unnamed'}"`);
    console.log(`    Domain:      ${b.domain ?? '(none)'}`);
    console.log(`    Type:        ${b.type ?? '(none)'}`);
    console.log(`    Owner:       ${b.owner ?? '(none)'}`);
    console.log(`    Description: ${b.description ?? '(none)'}`);
    console.log(`    Tags:        ${b.tags?.length ? b.tags.join(', ') : '(none)'}`);
    console.log(`    Params:      ${b.params?.length ?? 0}`);
    console.log(`    Tests:       ${b.tests?.length ?? 0} assertion(s)`);

    if (b.query) {
      const cost = estimator.estimate(b.query);
      console.log(`\n    Cost Estimate: ${cost.score}/100`);
      if (cost.recommendation) {
        console.log(`    → ${cost.recommendation}`);
      }
      if (cost.factors.length > 0 && flags.verbose) {
        for (const f of cost.factors) {
          console.log(`      • ${f.name} (+${f.impact}): ${f.description}`);
        }
      }
    }
  }
  console.log('');
}
