#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateScaleFixture, PERF_001_COUNTS, PERF_001_SEED } from './dql2-scale-fixture.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..', '..');
const args = parseArgs(process.argv.slice(2));

if (args.worker) {
  await runWorker(args.worker, resolve(args.project));
  process.exit(0);
}

const projectRoot = resolve(args.project ?? join(repoRoot, '.dql', 'perf', `PERF-001-${args.seed}`));
const evidencePath = resolve(args.evidence ?? join(repoRoot, '.dql', 'perf', 'evidence', `PERF-001-${args.seed}.json`));
const generated = generateScaleFixture(projectRoot, { seed: args.seed, counts: PERF_001_COUNTS });
const core = await import(join(repoRoot, 'packages/dql-core/dist/index.js'));
const agent = await import(join(repoRoot, 'packages/dql-agent/dist/index.js'));
const { startLocalServer } = await import(join(repoRoot, 'apps/cli/dist/local-runtime.js'));
const { QueryExecutor } = await import(join(repoRoot, 'packages/dql-connectors/dist/index.js'));

const coldCompile = [];
for (let index = 0; index < args.samples; index += 1) coldCompile.push(await runMeasuredWorker('compile', projectRoot));
const coldIndex = [];
for (let index = 0; index < Math.max(1, Math.min(args.samples, 3)); index += 1) coldIndex.push(await runMeasuredWorker('index', projectRoot));

const manifest = core.buildManifest({ projectRoot, dbtManifestPath: join(projectRoot, 'target', 'manifest.json') });
writeFileSync(join(projectRoot, 'dql-manifest.json'), JSON.stringify(manifest));
const warmProjectState = await agent.ensureAgentProjectReady(projectRoot, { manifest, forceKgIndex: false, forceMetadataCatalog: false });
const contextEnvelope = agent.resolveDomainContextEnvelope({
  manifest,
  activeDomain: 'domain_000',
  purpose: 'performance_validation',
  snapshotId: generated.digest,
});
await agent.buildLocalContextPack(projectRoot, { question: 'metric 0 by col 01', limit: 16, domainContext: contextEnvelope, preparedMetadataFingerprint: warmProjectState.metadataFingerprint });
core.resetDbtArtifactReadCount();
const warmContext = await sampleAsync(args.samples, async () => {
  await agent.buildLocalContextPack(projectRoot, { question: 'metric 0 by col 01', limit: 16, domainContext: contextEnvelope, preparedMetadataFingerprint: warmProjectState.metadataFingerprint });
});
const warmContextArtifactReads = core.dbtArtifactReadCount();

let server;
const port = await startLocalServer({
  rootDir: join(repoRoot, 'apps/dql-notebook/dist'),
  projectRoot,
  executor: new QueryExecutor(),
  preferredPort: 0,
  captureServer(value) { server = value; },
});
const base = `http://127.0.0.1:${port}`;
await fetchJson(`${base}/api/domain-workspaces`);

const domainSummary = await sampleAsync(args.samples, async () => fetchJson(`${base}/api/domain-workspaces/domain_000`));
const inventoryStart = performance.now();
const inventoryResponse = await fetch(`${base}/api/modeling/dbt-first/inventory?limit=50`);
const inventoryText = await inventoryResponse.text();
if (!inventoryResponse.ok) throw new Error(`inventory failed: ${inventoryResponse.status} ${inventoryText.slice(0, 500)}`);
const inventoryMs = performance.now() - inventoryStart;

await fetchJson(`${base}/api/modeling/dbt-first/nodes/${encodeURIComponent('model.scale.model_00000')}`);
core.resetDbtArtifactReadCount();
let detailCursor = 1;
const nodeDetail = await sampleAsync(args.samples, async () => {
  const id = `model.scale.model_${String(detailCursor++).padStart(5, '0')}`;
  return fetchJson(`${base}/api/modeling/dbt-first/nodes/${encodeURIComponent(id)}`);
});
const warmNodeArtifactReads = core.dbtArtifactReadCount();

const neighborhood = await fetchJson(`${base}/api/modeling/dbt-first/neighborhood?entity=${encodeURIComponent('domain_000::entity::entity_0000')}&limit=200`);
const domainFile = join(projectRoot, 'domains', 'domain_000', 'modeling', 'model.dql.yaml');
const before = statSync(domainFile);
utimesSync(domainFile, before.atime, new Date(Math.max(Date.now(), before.mtimeMs + 10)));
const refreshStarted = performance.now();
await fetchJson(`${base}/api/domain-workspaces/domain_000`);
const oneDomainRefreshMs = performance.now() - refreshStarted;
await new Promise((resolvePromise) => server.close(resolvePromise));

const countEvidence = {
  ...(coldCompile[0]?.result?.counts ?? {}),
  skills: agent.loadSkills(projectRoot).skills.length,
};
const measurements = {
  coldCompile: summarizeWorkerSamples(coldCompile),
  coldIndexSnapshot: summarizeWorkerSamples(coldIndex),
  warmContextBuild: { ...summarize(warmContext), artifactReads: warmContextArtifactReads },
  warmDomainWorkspaceSummary: summarize(domainSummary),
  inventoryFirstPage: { durationMs: round(inventoryMs), responseBytes: Buffer.byteLength(inventoryText), limit: 50 },
  nodeDetail: { ...summarize(nodeDetail), artifactReads: warmNodeArtifactReads, samplePattern: 'distinct nodes after one warm parse' },
  oneDomainRefresh: { durationMs: round(oneDomainRefreshMs), implementation: 'atomic full-snapshot fallback; domain-sharded invalidation remains a separate optimization' },
  defaultCanvasGraph: {
    nodes: Object.keys(neighborhood.entities ?? {}).length,
    relationships: Object.keys(neighborhood.relationships ?? {}).length,
    requestedLimit: 200,
  },
};
const gates = evaluateGates(measurements, countEvidence);
const evidence = {
  acceptanceId: 'PERF-001',
  generatedAt: new Date().toISOString(),
  commit: gitCommit(),
  seed: args.seed,
  fixture: { ...generated, expectedCounts: PERF_001_COUNTS, observedCounts: countEvidence },
  hardware: hardwareEvidence(),
  samples: args.samples,
  measurements,
  gates,
  limitations: [
    'Peak RSS is sampled from isolated child processes at 10ms intervals and includes the Node runtime.',
    'dbt artifact reads are logical production counters around the authoring artifact cache; warm context and distinct node-detail samples must remain zero.',
    'One-domain refresh currently validates correctness through the atomic full-snapshot fallback; the evidence labels this until dependency-sharded compilation lands.',
    'No external vector or warehouse service is used; the cold index gate covers the OSS SQLite KG and metadata catalog only.',
  ],
};
mkdirSync(dirname(evidencePath), { recursive: true });
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
writeFileSync(join(dirname(evidencePath), 'latest.json'), JSON.stringify(evidence, null, 2) + '\n');

console.log(JSON.stringify({ evidencePath, measurements, gates }, null, 2));
if (args.gate && !gates.passed) process.exitCode = 1;

async function runWorker(operation, root) {
  const coreModule = await import(join(repoRoot, 'packages/dql-core/dist/index.js'));
  const started = performance.now();
  if (operation === 'compile') {
    const compiled = coreModule.buildManifest({ projectRoot: root, dbtManifestPath: join(root, 'target', 'manifest.json') });
    const durationMs = performance.now() - started;
    workerResult({ durationMs, counts: manifestCounts(compiled, root), rssBytes: process.memoryUsage().rss });
    return;
  }
  if (operation === 'index') {
    rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
    const agentModule = await import(join(repoRoot, 'packages/dql-agent/dist/index.js'));
    const compiled = coreModule.buildManifest({ projectRoot: root, dbtManifestPath: join(root, 'target', 'manifest.json') });
    const indexed = await agentModule.reindexProject(root, { manifest: compiled, forceKgIndex: true, forceMetadataCatalog: true });
    const durationMs = performance.now() - started;
    workerResult({ durationMs, counts: manifestCounts(compiled, root), indexed, rssBytes: process.memoryUsage().rss });
    return;
  }
  throw new Error(`unknown worker operation: ${operation}`);
}

function workerResult(value) {
  process.stdout.write(`PERF001_RESULT=${JSON.stringify(value)}\n`);
}

async function runMeasuredWorker(operation, root) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scriptPath, '--worker', operation, '--project', root], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let peakRssBytes = 0;
    const poll = setInterval(() => {
      const ps = spawnSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' });
      const rssKb = Number(ps.stdout.trim());
      if (Number.isFinite(rssKb)) peakRssBytes = Math.max(peakRssBytes, rssKb * 1024);
    }, 10);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearInterval(poll); reject(error); });
    child.on('close', (code) => {
      clearInterval(poll);
      if (code !== 0) return reject(new Error(`${operation} worker failed (${code}): ${stderr || stdout}`));
      const marker = stdout.split(/\r?\n/).findLast((line) => line.startsWith('PERF001_RESULT='));
      if (!marker) return reject(new Error(`${operation} worker returned no result: ${stderr || stdout}`));
      const result = JSON.parse(marker.slice('PERF001_RESULT='.length));
      resolvePromise({ result, peakRssBytes: Math.max(peakRssBytes, result.rssBytes ?? 0) });
    });
  });
}

async function sampleAsync(count, operation) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    await operation(index);
    samples.push(performance.now() - started);
  }
  return samples;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} failed: ${response.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.map(round), p50Ms: round(percentile(sorted, 0.50)), p95Ms: round(percentile(sorted, 0.95)) };
}

function summarizeWorkerSamples(samples) {
  const timings = summarize(samples.map((sample) => sample.result.durationMs));
  return { ...timings, peakRssBytes: Math.max(...samples.map((sample) => sample.peakRssBytes)) };
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function manifestCounts(manifest, root) {
  const raw = JSON.parse(readFileSync(join(root, 'target', 'manifest.json'), 'utf8'));
  const rawNodes = Object.values(raw.nodes ?? {});
  const columnCounts = rawNodes.map((node) => Object.keys(node.columns ?? {}).length);
  return {
    dbtModels: Object.keys(manifest.dbtProvenance?.nodes ?? {}).length,
    domains: Object.keys(manifest.modeling?.packages ?? {}).length,
    entities: Object.keys(manifest.modeling?.entities ?? {}).length,
    relationships: Object.keys(manifest.modeling?.relationships ?? {}).length,
    blocks: Object.keys(manifest.blocks ?? {}).length,
    businessViews: Object.keys(manifest.businessViews ?? {}).length,
    apps: Object.keys(manifest.apps ?? {}).length,
    notebooks: Object.keys(manifest.notebooks ?? {}).length,
    columnsPerModel: columnCounts.length > 0 && new Set(columnCounts).size === 1 ? columnCounts[0] : null,
  };
}

function evaluateGates(measurements, observed) {
  const checks = {
    fixtureCounts: ['dbtModels', 'columnsPerModel', 'domains', 'entities', 'relationships', 'skills', 'blocks', 'businessViews', 'apps', 'notebooks'].every((key) => observed[key] === PERF_001_COUNTS[key]),
    coldCompileTime: measurements.coldCompile.p95Ms < 5_000,
    coldCompileRss: measurements.coldCompile.peakRssBytes < 1024 ** 3,
    coldIndexTime: measurements.coldIndexSnapshot.p95Ms < 30_000,
    coldIndexRss: measurements.coldIndexSnapshot.peakRssBytes < 1.5 * 1024 ** 3,
    warmContextTime: measurements.warmContextBuild.p95Ms < 500,
    warmContextArtifactReads: measurements.warmContextBuild.artifactReads === 0,
    domainSummaryTime: measurements.warmDomainWorkspaceSummary.p95Ms < 250,
    inventoryBytes: measurements.inventoryFirstPage.responseBytes < 500 * 1024,
    nodeDetailTime: measurements.nodeDetail.p95Ms < 100,
    nodeDetailArtifactReads: measurements.nodeDetail.artifactReads === 0,
    oneDomainRefreshTime: measurements.oneDomainRefresh.durationMs < 2_000,
    canvasBound: measurements.defaultCanvasGraph.nodes <= 200,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

function gitCommit() {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim() || 'unknown';
}

function hardwareEvidence() {
  return {
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
  };
}

function parseArgs(values) {
  const parsed = { seed: PERF_001_SEED, samples: 20, gate: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--gate') parsed.gate = true;
    else if (value === '--seed') parsed.seed = values[++index];
    else if (value === '--samples') parsed.samples = Math.max(1, Number(values[++index]) || 20);
    else if (value === '--project') parsed.project = values[++index];
    else if (value === '--evidence') parsed.evidence = values[++index];
    else if (value === '--worker') parsed.worker = values[++index];
  }
  return parsed;
}
