/**
 * `dql lineage` — Answer-layer lineage analysis.
 *
 * Shows how data flows from source tables through blocks, semantic metrics,
 * domains, and charts. Tracks trust chains and cross-domain impacts.
 *
 * Usage:
 *   dql lineage [path]                    Show full lineage graph summary
 *   dql lineage <name> [path]             Show upstream/downstream for a block, table, or metric
 *   dql lineage --search <term>           Search all nodes by name
 *   dql lineage --focus <name> [--depth N] Focused subgraph centered on a node
 *   dql lineage --dashboard <name>        Show what feeds a dashboard/notebook
 *   dql lineage --dbt                     Show the dbt model DAG portion
 *   dql lineage --table <name> [path]     Show lineage for a specific source table
 *   dql lineage --metric <name> [path]    Show lineage for a specific metric
 *   dql lineage --domain <name> [path]    Show lineage within a domain
 *   dql lineage --impact <name> [path]    Impact analysis: what breaks if this node changes?
 *   dql lineage --trust-chain <from> <to> Show trust chain between two blocks
 *   dql lineage --export [path]           Export lineage as JSON
 *   dql lineage --no-manifest             Force live scan (skip dql-manifest.json)
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
  queryLineage,
  searchNodes,
  LineageGraph,
  type LineageBlockInput,
  type LineageMetricInput,
  type LineageDimensionInput,
  type LineageNode,
} from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';

export async function runLineage(
  blockNameOrPath: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  // Collect all args and separate flags from positional args
  const allArgs = [...(blockNameOrPath ? [blockNameOrPath] : []), ...rest];
  const noManifest = allArgs.includes('--no-manifest');
  const positionalArgs = allArgs.filter((a) => !a.startsWith('-'));
  const flagArgs = allArgs.filter((a) => a.startsWith('-'));

  // Re-derive blockNameOrPath from the first non-flag positional arg
  const effectiveBlockArg = positionalArgs[0] ?? null;

  // Determine project root — check for dql.config.json
  const candidateRoot = resolve(
    positionalArgs.find((r) => existsSync(join(resolve(r), 'dql.config.json')))
    ?? '.',
  );

  const projectRoot = existsSync(join(candidateRoot, 'dql.config.json'))
    ? candidateRoot
    : resolve('.');

  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    console.error('No DQL project found (missing dql.config.json). Run from a project root or pass a project path.');
    process.exitCode = 1;
    return;
  }

  // Build the lineage graph — prefer manifest if available
  const graph = noManifest
    ? buildProjectLineage(projectRoot)
    : loadFromManifestOrScan(projectRoot);

  if (graph.nodeCount === 0) {
    console.log('\n  No lineage data found.');
    console.log('  Run `dql compile` to generate the project manifest, or add blocks in blocks/.\n');
    return;
  }

  // Route to the right subcommand based on flags
  if (flags.format === 'json' || allArgs.includes('--export')) {
    console.log(JSON.stringify(graph.toJSON(), null, 2));
    return;
  }

  // --search <term>
  const searchIdx = allArgs.indexOf('--search');
  if (searchIdx >= 0 && allArgs[searchIdx + 1]) {
    return printSearch(graph, allArgs[searchIdx + 1]);
  }

  // --focus <name> [--depth N]
  const focusIdx = allArgs.indexOf('--focus');
  if (focusIdx >= 0 && allArgs[focusIdx + 1]) {
    const depthIdx = allArgs.indexOf('--depth');
    const depth = depthIdx >= 0 && allArgs[depthIdx + 1] ? Number(allArgs[depthIdx + 1]) : undefined;
    return printFocused(graph, allArgs[focusIdx + 1], depth);
  }

  // --dashboard <name>
  const dashIdx = allArgs.indexOf('--dashboard');
  if (dashIdx >= 0 && allArgs[dashIdx + 1]) {
    const nodeId = resolveNodeId(graph, allArgs[dashIdx + 1]) ?? `dashboard:${allArgs[dashIdx + 1]}`;
    return printNodeLineage(graph, nodeId, flags);
  }

  // --dbt (show dbt model DAG)
  if (allArgs.includes('--dbt')) {
    return printDbtDAG(graph);
  }

  // --impact <name>
  const impactIdx = allArgs.indexOf('--impact');
  if (impactIdx >= 0 && allArgs[impactIdx + 1]) {
    const nodeId = resolveNodeId(graph, allArgs[impactIdx + 1]);
    if (!nodeId) {
      console.error(`"${allArgs[impactIdx + 1]}" not found in lineage graph.`);
      process.exitCode = 1;
      return;
    }
    return printImpactAnalysis(graph, nodeId, flags);
  }

  // --trust-chain <from> <to>
  const trustIdx = allArgs.indexOf('--trust-chain');
  if (trustIdx >= 0 && allArgs[trustIdx + 1] && allArgs[trustIdx + 2]) {
    return printTrustChain(graph, allArgs[trustIdx + 1], allArgs[trustIdx + 2], flags);
  }

  // --domain <name>
  if (flags.domain) {
    return printDomainLineage(graph, flags.domain, flags);
  }

  // --table <name>
  const tableIdx = allArgs.indexOf('--table');
  if (tableIdx >= 0 && allArgs[tableIdx + 1]) {
    return printNodeLineage(graph, `table:${allArgs[tableIdx + 1]}`, flags);
  }

  // --metric <name>
  const metricIdx = allArgs.indexOf('--metric');
  if (metricIdx >= 0 && allArgs[metricIdx + 1]) {
    return printNodeLineage(graph, `metric:${allArgs[metricIdx + 1]}`, flags);
  }

  // Specific node — smart lookup: try block, then table, then metric
  if (effectiveBlockArg && resolve(effectiveBlockArg) !== projectRoot) {
    const nodeId = resolveNodeId(graph, effectiveBlockArg);
    if (!nodeId) {
      console.error(`"${effectiveBlockArg}" not found in lineage graph.`);
      console.error('  Hint: use --table <name> or --metric <name> for explicit lookup.');
      process.exitCode = 1;
      return;
    }
    return printNodeLineage(graph, nodeId, flags);
  }

  // Default: show full summary
  return printSummary(graph, flags);
}

/** Load lineage from dql-manifest.json if available, otherwise scan live. */
function loadFromManifestOrScan(projectRoot: string): LineageGraph {
  const manifestPath = join(projectRoot, 'dql-manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (manifest.lineage?.nodes && manifest.lineage?.edges) {
        return LineageGraph.fromJSON({
          nodes: manifest.lineage.nodes,
          edges: manifest.lineage.edges,
        });
      }
    } catch {
      // Fall through to live scan
    }
  }
  return buildProjectLineage(projectRoot);
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

  const sourceTables = graph.getNodesByType('source_table');
  const dbtModels = graph.getNodesByType('dbt_model');
  const dbtSources = graph.getNodesByType('dbt_source');
  const blocks = graph.getNodesByType('block');
  const metrics = graph.getNodesByType('metric');
  const dimensions = graph.getNodesByType('dimension');
  const charts = graph.getNodesByType('chart');
  const dashboards = graph.getNodesByType('dashboard');

  console.log('\n  DQL Lineage Summary');
  console.log('  ' + '='.repeat(50));

  // Overview counts
  console.log(`\n  ${nodes.length} nodes, ${edges.length} edges, ${domains.length} domain(s)`);
  if (dbtModels.length > 0 || dbtSources.length > 0) {
    console.log(`  dbt: ${dbtSources.length} source(s), ${dbtModels.length} model(s)`);
  }
  if (dashboards.length > 0) {
    console.log(`  ${dashboards.length} dashboard(s)`);
  }

  // Source Tables
  if (sourceTables.length > 0) {
    console.log(`\n  Source Tables (${sourceTables.length}):`);
    for (const t of sourceTables.sort((a, b) => a.name.localeCompare(b.name))) {
      const downstream = graph.getOutgoingEdges(t.id);
      const targets = [...new Set(downstream.map((e) => graph.getNode(e.target)?.name).filter(Boolean))];
      const arrow = targets.length > 0 ? ` -> ${targets.join(', ')}` : '';
      console.log(`    ${t.name}${arrow}`);
    }
  }

  // Blocks
  if (blocks.length > 0) {
    console.log(`\n  Blocks (${blocks.length}):`);
    for (const b of blocks.sort((a, b) => a.name.localeCompare(b.name))) {
      const parts: string[] = [];
      if (b.domain) parts.push(`domain: ${b.domain}`);
      if (b.owner) parts.push(`owner: ${b.owner}`);
      if (b.status) parts.push(b.status);
      const meta = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      console.log(`    ${b.name}${meta}`);

      // Show what this block reads from (upstream) — deduplicate by node id
      const incoming = graph.getIncomingEdges(b.id);
      const upstreamNames = [...new Set(
        incoming
          .map((e) => graph.getNode(e.source))
          .filter((n): n is LineageNode => n !== undefined && n.type !== 'domain')
          .map((n) => n.name),
      )];
      if (upstreamNames.length > 0) {
        console.log(`      reads from: ${upstreamNames.join(', ')}`);
      }

      // Show what this block feeds into (downstream) — deduplicate by node id
      const outgoing = graph.getOutgoingEdges(b.id);
      const downstreamNames = [...new Set(
        outgoing
          .map((e) => graph.getNode(e.target))
          .filter((n): n is LineageNode => n !== undefined && n.type !== 'domain')
          .map((n) => n.name),
      )];
      if (downstreamNames.length > 0) {
        console.log(`      feeds into: ${downstreamNames.join(', ')}`);
      }
    }
  }

  // Metrics
  if (metrics.length > 0) {
    console.log(`\n  Metrics (${metrics.length}):`);
    for (const m of metrics.sort((a, b) => a.name.localeCompare(b.name))) {
      const incoming = graph.getIncomingEdges(m.id);
      const sources = incoming.map((e) => graph.getNode(e.source)?.name).filter(Boolean);
      const from = sources.length > 0 ? ` <- ${sources.join(', ')}` : '';
      const domain = m.domain ? ` (${m.domain})` : '';
      console.log(`    ${m.name}${domain}${from}`);
    }
  }

  // Dimensions
  if (dimensions.length > 0) {
    console.log(`\n  Dimensions (${dimensions.length}):`);
    for (const d of dimensions.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`    ${d.name}`);
    }
  }

  // Charts
  if (charts.length > 0) {
    console.log(`\n  Charts (${charts.length}):`);
    for (const c of charts.sort((a, b) => a.name.localeCompare(b.name))) {
      const incoming = graph.getIncomingEdges(c.id);
      const sources = incoming.map((e) => graph.getNode(e.source)?.name).filter(Boolean);
      const from = sources.length > 0 ? ` <- ${sources.join(', ')}` : '';
      console.log(`    ${c.name}${from}`);
    }
  }

  // Shared Table Correlation — blocks reading the same tables
  const tableReaders = new Map<string, string[]>();
  for (const t of sourceTables) {
    const downstream = graph.getOutgoingEdges(t.id)
      .map((e) => graph.getNode(e.target))
      .filter((n): n is LineageNode => n !== undefined && n.type === 'block');
    if (downstream.length >= 2) {
      tableReaders.set(t.name, downstream.map((n) => n.name));
    }
  }
  if (tableReaders.size > 0) {
    console.log(`\n  Shared Tables (${tableReaders.size}):`);
    for (const [table, readers] of [...tableReaders.entries()].sort()) {
      console.log(`    ${table} <- ${readers.join(', ')}`);
    }
  }

  // Data Flow DAG
  console.log('\n  Data Flow:');
  console.log('  ' + '-'.repeat(50));
  // Find root nodes (no incoming edges, excluding domain nodes)
  const roots = nodes.filter(
    (n) => n.type !== 'domain' && (graph.getIncomingEdges(n.id).length === 0),
  );
  const printed = new Set<string>();
  for (const root of roots.sort((a, b) => a.name.localeCompare(b.name))) {
    printDAGNode(graph, root, 0, printed);
  }
  // Print any remaining nodes not reachable from roots (cycles or disconnected)
  for (const node of nodes) {
    if (!printed.has(node.id) && node.type !== 'domain') {
      printDAGNode(graph, node, 0, printed);
    }
  }

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

/** Recursively print DAG tree from a node. */
function printDAGNode(graph: LineageGraph, node: LineageNode, depth: number, printed: Set<string>): void {
  if (printed.has(node.id)) return;
  printed.add(node.id);

  const indent = '    ' + '  '.repeat(depth);
  const prefix = depth === 0 ? '' : '└── ';
  const typeLabel = node.type === 'source_table' ? 'table'
    : node.type === 'dbt_model' ? 'dbt_model'
    : node.type === 'dbt_source' ? 'dbt_source'
    : node.type;
  const badge = node.status === 'certified' ? ' ✓' : '';
  const domain = node.domain ? ` [${node.domain}]` : '';
  console.log(`${indent}${prefix}${typeLabel}:${node.name}${domain}${badge}`);

  // Get non-domain downstream
  const outgoing = graph.getOutgoingEdges(node.id);
  const children = outgoing
    .map((e) => graph.getNode(e.target))
    .filter((n): n is LineageNode => n !== undefined && n.type !== 'domain' && !printed.has(n.id));

  for (const child of children) {
    printDAGNode(graph, child, depth + 1, printed);
  }
}

/**
 * Resolve a user-provided name to a node ID by trying multiple type prefixes.
 * Priority: block > source_table > metric > dimension > chart > exact match.
 */
function resolveNodeId(graph: LineageGraph, name: string): string | null {
  // If the name already contains a colon, try it as-is
  if (name.includes(':') && graph.getNode(name)) return name;

  // Try common type prefixes in priority order
  const prefixes = ['block', 'table', 'dbt_model', 'dbt_source', 'metric', 'dimension', 'chart', 'dashboard', 'domain'];
  for (const prefix of prefixes) {
    const id = `${prefix}:${name}`;
    if (graph.getNode(id)) return id;
  }

  // Fuzzy match: search all nodes for a name match
  for (const node of graph.getAllNodes()) {
    if (node.name === name) return node.id;
  }

  return null;
}

function printNodeLineage(graph: LineageGraph, nodeId: string, _flags: CLIFlags): void {
  const node = graph.getNode(nodeId);

  if (!node) {
    console.error(`Node "${nodeId}" not found in lineage graph.`);
    process.exitCode = 1;
    return;
  }

  const typeLabel = node.type === 'source_table' ? 'Table'
    : node.type === 'dbt_model' ? 'dbt Model'
    : node.type === 'dbt_source' ? 'dbt Source'
    : node.type.charAt(0).toUpperCase() + node.type.slice(1);
  const ancestors = graph.ancestors(nodeId);
  const descendants = graph.descendants(nodeId);

  console.log(`\n  ${typeLabel} Lineage: ${node.name}`);
  console.log('  ' + '='.repeat(50));

  // Metadata
  const meta: string[] = [];
  if (!['source_table', 'dbt_model', 'dbt_source'].includes(node.type)) meta.push(`Type: ${node.type}`);
  if (node.domain) meta.push(`Domain: ${node.domain}`);
  if (node.status) meta.push(`Status: ${node.status}`);
  if (node.owner) meta.push(`Owner: ${node.owner}`);
  if (meta.length > 0) {
    for (const m of meta) console.log(`  ${m}`);
  }

  // Direct connections (immediate neighbors)
  const inEdges = graph.getIncomingEdges(nodeId);
  const outEdges = graph.getOutgoingEdges(nodeId);

  const directUpstream = [...new Set(
    inEdges
      .map((e) => graph.getNode(e.source))
      .filter((n): n is LineageNode => n !== undefined && n.type !== 'domain'),
  )];

  const directDownstream = [...new Set(
    outEdges
      .map((e) => graph.getNode(e.target))
      .filter((n): n is LineageNode => n !== undefined && n.type !== 'domain'),
  )];

  if (directUpstream.length > 0) {
    console.log(`\n  Direct Upstream (${directUpstream.length}):`);
    for (const n of directUpstream) {
      const badge = n.status === 'certified' ? ' [certified]' : '';
      const typePfx = n.type === 'source_table' ? 'table' : n.type;
      console.log(`    ${typePfx}:${n.name}${badge}${n.domain ? ` (${n.domain})` : ''}`);
    }
  }

  if (directDownstream.length > 0) {
    console.log(`\n  Direct Downstream (${directDownstream.length}):`);
    for (const n of directDownstream) {
      const badge = n.status === 'certified' ? ' [certified]' : '';
      const typePfx = n.type === 'source_table' ? 'table' : n.type;
      console.log(`    ${typePfx}:${n.name}${badge}${n.domain ? ` (${n.domain})` : ''}`);
    }
  }

  // Full transitive upstream/downstream (if different from direct)
  const transitiveUp = ancestors.filter((n) => n.type !== 'domain');
  const transitiveDown = descendants.filter((n) => n.type !== 'domain');

  if (transitiveUp.length > directUpstream.length) {
    console.log(`\n  All Upstream (${transitiveUp.length}):`);
    for (const a of transitiveUp) {
      const badge = a.status === 'certified' ? ' [certified]' : '';
      const typePfx = a.type === 'source_table' ? 'table' : a.type;
      const direct = directUpstream.some((d) => d.id === a.id) ? ' *' : '';
      console.log(`    ${typePfx}:${a.name}${badge}${a.domain ? ` (${a.domain})` : ''}${direct}`);
    }
  }

  if (transitiveDown.length > directDownstream.length) {
    console.log(`\n  All Downstream (${transitiveDown.length}):`);
    for (const d of transitiveDown) {
      const badge = d.status === 'certified' ? ' [certified]' : '';
      const typePfx = d.type === 'source_table' ? 'table' : d.type;
      const direct = directDownstream.some((dd) => dd.id === d.id) ? ' *' : '';
      console.log(`    ${typePfx}:${d.name}${badge}${d.domain ? ` (${d.domain})` : ''}${direct}`);
    }
  }

  // Data flow tree from this node
  if (transitiveDown.length > 0) {
    console.log('\n  Data Flow:');
    console.log('  ' + '-'.repeat(50));
    const printed = new Set<string>();
    printDAGNode(graph, node, 0, printed);
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

function printImpactAnalysis(graph: LineageGraph, nodeId: string, _flags: CLIFlags): void {
  const node = graph.getNode(nodeId);
  if (!node) {
    console.error(`"${nodeId}" not found.`);
    process.exitCode = 1;
    return;
  }

  const impact = analyzeImpact(graph, nodeId);

  console.log(`\n  Impact Analysis: ${node.name}`);
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

function printSearch(graph: LineageGraph, term: string): void {
  const matches = searchNodes(graph, term, 30);

  if (matches.length === 0) {
    console.log(`\n  No nodes found matching "${term}".\n`);
    return;
  }

  console.log(`\n  Search Results for "${term}" (${matches.length} match${matches.length === 1 ? '' : 'es'}):`);
  console.log('  ' + '='.repeat(50));

  for (const { node, score } of matches) {
    const typeLabel = nodeTypeLabel(node.type);
    const domain = node.domain ? ` [${node.domain}]` : '';
    const status = node.status ? ` (${node.status})` : '';
    console.log(`    ${typeLabel}  ${node.name}${domain}${status}`);
  }

  console.log('\n  Use `dql lineage --focus <name>` to see focused lineage for a specific node.\n');
}

function printFocused(graph: LineageGraph, name: string, depth?: number): void {
  const result = queryLineage(graph, {
    focus: name,
    upstreamDepth: depth,
    downstreamDepth: depth,
  });

  if (!result.focalNode) {
    console.error(`"${name}" not found in lineage graph.`);
    process.exitCode = 1;
    return;
  }

  const focal = result.focalNode;
  const subNodes = result.graph.nodes;
  const subEdges = result.graph.edges;

  const typeLabel = nodeTypeLabel(focal.type);
  console.log(`\n  Focused Lineage: ${focal.name} (${typeLabel})`);
  console.log('  ' + '='.repeat(50));
  if (depth !== undefined) console.log(`  Depth: ${depth} hop(s)`);
  console.log(`  Subgraph: ${subNodes.length} nodes, ${subEdges.length} edges`);

  // Separate upstream vs downstream relative to focal
  const focusGraph = LineageGraph.fromJSON(result.graph);
  const upstream = focusGraph.ancestors(focal.id).filter((n) => n.type !== 'domain');
  const downstream = focusGraph.descendants(focal.id).filter((n) => n.type !== 'domain');

  if (upstream.length > 0) {
    console.log(`\n  Upstream (${upstream.length}):`);
    for (const n of upstream) {
      const label = nodeTypeLabel(n.type);
      const badge = n.status === 'certified' ? ' [certified]' : '';
      console.log(`    ${label}  ${n.name}${badge}${n.domain ? ` [${n.domain}]` : ''}`);
    }
  }

  console.log(`\n  >>> ${typeLabel}  ${focal.name} ${focal.status ? `(${focal.status})` : ''} <<<`);

  if (downstream.length > 0) {
    console.log(`\n  Downstream (${downstream.length}):`);
    for (const n of downstream) {
      const label = nodeTypeLabel(n.type);
      const badge = n.status === 'certified' ? ' [certified]' : '';
      console.log(`    ${label}  ${n.name}${badge}${n.domain ? ` [${n.domain}]` : ''}`);
    }
  }

  // Show data flow tree
  console.log('\n  Data Flow:');
  console.log('  ' + '-'.repeat(50));
  const printed = new Set<string>();
  const roots = subNodes.filter(
    (n) => n.type !== 'domain' && focusGraph.getIncomingEdges(n.id).length === 0,
  );
  for (const root of roots.sort((a, b) => a.name.localeCompare(b.name))) {
    const rootNode = focusGraph.getNode(root.id);
    if (rootNode) printDAGNode(focusGraph, rootNode, 0, printed);
  }

  console.log('');
}

function printDbtDAG(graph: LineageGraph): void {
  const dbtModels = graph.getNodesByType('dbt_model');
  const dbtSources = graph.getNodesByType('dbt_source');

  if (dbtModels.length === 0 && dbtSources.length === 0) {
    console.log('\n  No dbt models found in lineage.');
    console.log('  Run `dql compile --dbt-manifest target/manifest.json` to import dbt lineage.\n');
    return;
  }

  console.log('\n  dbt Model DAG');
  console.log('  ' + '='.repeat(50));
  console.log(`\n  ${dbtSources.length} source(s), ${dbtModels.length} model(s)`);

  if (dbtSources.length > 0) {
    console.log(`\n  Sources:`);
    for (const src of dbtSources.sort((a, b) => a.name.localeCompare(b.name))) {
      const downstream = graph.getOutgoingEdges(src.id)
        .map((e) => graph.getNode(e.target))
        .filter((n): n is LineageNode => n !== undefined)
        .map((n) => n.name);
      const arrow = downstream.length > 0 ? ` -> ${downstream.join(', ')}` : '';
      console.log(`    SRC  ${src.name}${arrow}`);
    }
  }

  if (dbtModels.length > 0) {
    console.log(`\n  Models:`);
    for (const model of dbtModels.sort((a, b) => a.name.localeCompare(b.name))) {
      const upstream = graph.getIncomingEdges(model.id)
        .filter((e) => e.type === 'depends_on')
        .map((e) => graph.getNode(e.source))
        .filter((n): n is LineageNode => n !== undefined)
        .map((n) => n.name);
      const downstream = graph.getOutgoingEdges(model.id)
        .map((e) => graph.getNode(e.target))
        .filter((n): n is LineageNode => n !== undefined)
        .map((n) => `${nodeTypeLabel(n.type)} ${n.name}`);

      const from = upstream.length > 0 ? `  <- ${upstream.join(', ')}` : '';
      console.log(`    DBT  ${model.name}${from}`);
      if (downstream.length > 0) {
        console.log(`           -> ${downstream.join(', ')}`);
      }
      // Show columns if available
      if (model.columns && model.columns.length > 0) {
        const colNames = model.columns.slice(0, 8).map((c) => c.name);
        const more = model.columns.length > 8 ? ` +${model.columns.length - 8} more` : '';
        console.log(`           columns: ${colNames.join(', ')}${more}`);
      }
    }
  }

  // Show data flow tree
  console.log('\n  dbt Data Flow:');
  console.log('  ' + '-'.repeat(50));
  const printed = new Set<string>();
  for (const src of dbtSources.sort((a, b) => a.name.localeCompare(b.name))) {
    printDAGNode(graph, src, 0, printed);
  }
  // Print models not reachable from sources
  for (const model of dbtModels) {
    if (!printed.has(model.id)) {
      printDAGNode(graph, model, 0, printed);
    }
  }

  console.log('');
}

/** Short type label for display */
function nodeTypeLabel(type: string): string {
  switch (type) {
    case 'source_table': return 'TBL ';
    case 'dbt_model': return 'DBT ';
    case 'dbt_source': return 'SRC ';
    case 'block': return 'BLK ';
    case 'metric': return 'MET ';
    case 'dimension': return 'DIM ';
    case 'chart': return 'CHT ';
    case 'dashboard': return 'DASH';
    case 'domain': return 'DOM ';
    default: return type.toUpperCase().padEnd(4);
  }
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
