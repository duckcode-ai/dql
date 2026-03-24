/**
 * `dql lineage` — Answer-layer lineage analysis.
 *
 * Shows how data flows from source tables through blocks, semantic metrics,
 * domains, and charts. Tracks trust chains and cross-domain impacts.
 *
 * Usage:
 *   dql lineage [path]                    Show full lineage graph summary
 *   dql lineage <block> [path]            Show upstream/downstream for a block
 *   dql lineage --domain <name> [path]    Show lineage within a domain
 *   dql lineage --impact <block> [path]   Impact analysis: what breaks if this changes?
 *   dql lineage --trust-chain <from> <to> Show trust chain between two blocks
 *   dql lineage --export [path]           Export lineage as JSON
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import {
  Parser,
  loadSemanticLayerFromDir,
  buildLineageGraph,
  analyzeImpact,
  buildTrustChain,
  detectDomainFlows,
  getDomainTrustOverview,
  type LineageBlockInput,
  type LineageMetricInput,
  type LineageDimensionInput,
  type LineageGraph,
} from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';

export async function runLineage(
  blockNameOrPath: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  // Determine project root — check for dql.config.json
  const candidateRoot = resolve(
    rest.find((r) => !r.startsWith('-') && existsSync(join(resolve(r), 'dql.config.json')))
    ?? (blockNameOrPath && existsSync(join(resolve(blockNameOrPath), 'dql.config.json')) ? blockNameOrPath : '.'),
  );

  const projectRoot = existsSync(join(candidateRoot, 'dql.config.json'))
    ? candidateRoot
    : resolve('.');

  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    console.error('No DQL project found (missing dql.config.json). Run from a project root or pass a project path.');
    process.exitCode = 1;
    return;
  }

  // Build the lineage graph
  const graph = buildProjectLineage(projectRoot);

  if (graph.nodeCount === 0) {
    console.log('\n  No lineage data found.');
    console.log('  Add blocks in blocks/ and semantic definitions in semantic-layer/ to see lineage.\n');
    return;
  }

  // Route to the right subcommand based on flags
  if (flags.format === 'json' || rest.includes('--export')) {
    console.log(JSON.stringify(graph.toJSON(), null, 2));
    return;
  }

  // --impact <block>
  const impactIdx = rest.indexOf('--impact');
  if (impactIdx >= 0 && rest[impactIdx + 1]) {
    return printImpactAnalysis(graph, rest[impactIdx + 1], flags);
  }

  // --trust-chain <from> <to>
  const trustIdx = rest.indexOf('--trust-chain');
  if (trustIdx >= 0 && rest[trustIdx + 1] && rest[trustIdx + 2]) {
    return printTrustChain(graph, rest[trustIdx + 1], rest[trustIdx + 2], flags);
  }

  // --domain <name>
  if (flags.domain) {
    return printDomainLineage(graph, flags.domain, flags);
  }

  // Specific block — treat first arg as a block name if it's not the project root
  if (blockNameOrPath && resolve(blockNameOrPath) !== projectRoot) {
    return printBlockLineage(graph, blockNameOrPath, flags);
  }

  // Default: show full summary
  return printSummary(graph, flags);
}

/** Discover all blocks and semantic layer definitions and build the lineage graph. */
function buildProjectLineage(projectRoot: string): LineageGraph {
  const blocks: LineageBlockInput[] = [];
  const metrics: LineageMetricInput[] = [];
  const dimensions: LineageDimensionInput[] = [];

  // Scan .dql files
  const dirs = ['blocks', 'dashboards', 'workbooks'];
  for (const dir of dirs) {
    const dirPath = join(projectRoot, dir);
    if (!existsSync(dirPath)) continue;

    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile() || extname(entry.name) !== '.dql') continue;
      const filePath = join(dirPath, entry.name);

      try {
        const source = readFileSync(filePath, 'utf-8');
        const parser = new Parser(source, `${dir}/${entry.name}`);
        const ast = parser.parse();

        for (const stmt of ast.statements) {
          const block = stmt as any;
          if (block.kind !== 'BlockDecl') continue;

          blocks.push({
            name: block.name,
            sql: block.query?.rawSQL ?? '',
            domain: extractBlockProperty(block, 'domain'),
            owner: extractBlockProperty(block, 'owner'),
            status: extractBlockProperty(block, 'status') as any,
            blockType: block.blockType,
            metricRef: block.metricRef,
            chartType: extractVisualizationChart(block),
          });
        }
      } catch {
        // Skip unparseable files
      }
    }
  }

  // Load semantic layer
  const semanticDir = join(projectRoot, 'semantic-layer');
  if (existsSync(semanticDir)) {
    try {
      const layer = loadSemanticLayerFromDir(semanticDir);
      for (const metric of layer.listMetrics()) {
        metrics.push({
          name: metric.name,
          table: metric.table,
          domain: metric.domain,
          type: metric.type,
        });
      }
      for (const dim of layer.listDimensions()) {
        dimensions.push({
          name: dim.name,
          table: dim.table,
        });
      }
    } catch {
      // Non-fatal
    }
  }

  return buildLineageGraph(blocks, metrics, dimensions);
}

/** Extract a property value from a block — checks direct AST fields first, then properties array. */
function extractBlockProperty(block: any, propName: string): string | undefined {
  // The parser puts well-known fields (domain, owner, type) directly on the AST node
  if (block[propName] !== undefined && block[propName] !== null) {
    return String(block[propName]);
  }
  // Fall back to properties array for custom/extended properties
  if (!block.properties) return undefined;
  for (const prop of block.properties) {
    if (prop.key === propName && prop.value?.kind === 'Literal') {
      return String(prop.value.value);
    }
  }
  return undefined;
}

/** Extract chart type from a block's visualization config. */
function extractVisualizationChart(block: any): string | undefined {
  if (!block.visualization) return undefined;
  for (const prop of block.visualization.properties ?? []) {
    if (prop.key === 'chart' && prop.value?.kind === 'Literal') {
      return String(prop.value.value);
    }
  }
  return undefined;
}

// ---- Output formatters ----

function printSummary(graph: LineageGraph, _flags: CLIFlags): void {
  const nodes = graph.getAllNodes();
  const edges = graph.getAllEdges();
  const domains = graph.getDomains();

  console.log('\n  DQL Lineage Summary');
  console.log('  ' + '='.repeat(40));

  // Node counts by type
  const typeCount: Record<string, number> = {};
  for (const node of nodes) {
    typeCount[node.type] = (typeCount[node.type] ?? 0) + 1;
  }
  console.log('\n  Nodes:');
  for (const [type, count] of Object.entries(typeCount).sort()) {
    console.log(`    ${type}: ${count}`);
  }

  console.log(`\n  Edges: ${edges.length}`);

  // Cross-domain flows
  const flows = detectDomainFlows(graph);
  if (flows.length > 0) {
    console.log('\n  Cross-Domain Flows:');
    for (const flow of flows) {
      console.log(`    ${flow.from} -> ${flow.to} (${flow.edges.length} edge(s))`);
    }
  }

  // Domain trust overview
  if (domains.length > 0) {
    console.log('\n  Domain Trust:');
    for (const domain of domains.sort()) {
      const overview = getDomainTrustOverview(graph, domain);
      if (overview.totalBlocks === 0) continue;
      const score = (overview.trustScore * 100).toFixed(0);
      console.log(`    ${domain}: ${overview.certified}/${overview.totalBlocks} certified (${score}% trust)`);
    }
  }

  console.log('');
}

function printBlockLineage(graph: LineageGraph, blockName: string, _flags: CLIFlags): void {
  const nodeId = `block:${blockName}`;
  const node = graph.getNode(nodeId);

  if (!node) {
    console.error(`Block "${blockName}" not found in lineage graph.`);
    process.exitCode = 1;
    return;
  }

  const ancestors = graph.ancestors(nodeId);
  const descendants = graph.descendants(nodeId);

  console.log(`\n  Lineage for: ${blockName}`);
  console.log('  ' + '='.repeat(40));

  if (node.domain) console.log(`  Domain: ${node.domain}`);
  if (node.status) console.log(`  Status: ${node.status}`);
  if (node.owner) console.log(`  Owner: ${node.owner}`);

  if (ancestors.length > 0) {
    console.log(`\n  Upstream (${ancestors.length}):`);
    for (const a of ancestors) {
      const badge = a.status === 'certified' ? ' [certified]' : '';
      console.log(`    ${a.type}:${a.name}${badge}${a.domain ? ` (${a.domain})` : ''}`);
    }
  }

  if (descendants.length > 0) {
    console.log(`\n  Downstream (${descendants.length}):`);
    for (const d of descendants) {
      const badge = d.status === 'certified' ? ' [certified]' : '';
      console.log(`    ${d.type}:${d.name}${badge}${d.domain ? ` (${d.domain})` : ''}`);
    }
  }

  console.log('');
}

function printDomainLineage(graph: LineageGraph, domain: string, _flags: CLIFlags): void {
  const nodes = graph.getNodesByDomain(domain);
  const overview = getDomainTrustOverview(graph, domain);
  const flows = detectDomainFlows(graph);

  console.log(`\n  Domain Lineage: ${domain}`);
  console.log('  ' + '='.repeat(40));

  console.log(`\n  Blocks: ${overview.totalBlocks}`);
  console.log(`  Certified: ${overview.certified}`);
  console.log(`  Trust Score: ${(overview.trustScore * 100).toFixed(0)}%`);

  console.log(`\n  Nodes in domain (${nodes.length}):`);
  for (const node of nodes) {
    const badge = node.status === 'certified' ? ' [certified]' : '';
    console.log(`    ${node.type}:${node.name}${badge}`);
  }

  const inFlows = flows.filter((f) => f.to === domain);
  const outFlows = flows.filter((f) => f.from === domain);

  if (inFlows.length > 0) {
    console.log('\n  Data flows IN from:');
    for (const f of inFlows) {
      console.log(`    ${f.from} (${f.edges.length} edge(s))`);
    }
  }

  if (outFlows.length > 0) {
    console.log('\n  Data flows OUT to:');
    for (const f of outFlows) {
      console.log(`    ${f.to} (${f.edges.length} edge(s))`);
    }
  }

  console.log('');
}

function printImpactAnalysis(graph: LineageGraph, blockName: string, _flags: CLIFlags): void {
  const nodeId = `block:${blockName}`;
  if (!graph.getNode(nodeId)) {
    console.error(`Block "${blockName}" not found.`);
    process.exitCode = 1;
    return;
  }

  const impact = analyzeImpact(graph, nodeId);

  console.log(`\n  Impact Analysis: ${blockName}`);
  console.log('  ' + '='.repeat(40));
  console.log(`\n  Total downstream affected: ${impact.totalAffected}`);

  if (impact.domainImpacts.length > 0) {
    console.log('\n  By domain:');
    for (const di of impact.domainImpacts) {
      console.log(`    ${di.domain}: ${di.affectedNodes.length} node(s), ${di.certifiedBlocksAffected} certified`);
      for (const n of di.affectedNodes) {
        const badge = n.status === 'certified' ? ' [certified]' : '';
        console.log(`      - ${n.name}${badge}`);
      }
    }
  }

  if (impact.domainCrossings.length > 0) {
    console.log('\n  Domain boundaries crossed:');
    for (const dc of impact.domainCrossings) {
      console.log(`    ${dc.from} -> ${dc.to} (${dc.edgeCount} edge(s))`);
    }
  }

  console.log('');
}

function printTrustChain(graph: LineageGraph, fromBlock: string, toBlock: string, _flags: CLIFlags): void {
  const fromId = `block:${fromBlock}`;
  const toId = `block:${toBlock}`;

  if (!graph.getNode(fromId)) {
    console.error(`Block "${fromBlock}" not found.`);
    process.exitCode = 1;
    return;
  }
  if (!graph.getNode(toId)) {
    console.error(`Block "${toBlock}" not found.`);
    process.exitCode = 1;
    return;
  }

  const chain = buildTrustChain(graph, fromId, toId);

  if (!chain) {
    console.log(`\n  No path found from "${fromBlock}" to "${toBlock}".`);
    return;
  }

  console.log(`\n  Trust Chain: ${fromBlock} -> ${toBlock}`);
  console.log('  ' + '='.repeat(40));
  console.log(`\n  Trust Score: ${(chain.trustScore * 100).toFixed(0)}% (${chain.certifiedCount}/${chain.nodes.length} certified)`);

  console.log('\n  Chain:');
  for (let i = 0; i < chain.nodes.length; i++) {
    const n = chain.nodes[i];
    const icon = n.isTrustCheckpoint ? '[CERTIFIED]' : '[         ]';
    const domain = n.domain ? ` (${n.domain})` : '';
    const owner = n.owner ? ` — ${n.owner}` : '';
    const prefix = i === 0 ? '  ' : '    -> ';
    console.log(`  ${prefix}${icon} ${n.name}${domain}${owner}`);
  }

  if (chain.domainCrossings.length > 0) {
    console.log('\n  Domain boundaries:');
    for (const dc of chain.domainCrossings) {
      console.log(`    ${dc.from} -> ${dc.to}`);
    }
  }

  console.log('');
}
