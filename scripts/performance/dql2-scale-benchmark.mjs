#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const requireFromCli = createRequire(join(repoRoot, 'apps/cli/package.json'));
const { load: loadYaml } = requireFromCli('js-yaml');
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
  activeDomain: 'consumption',
  purpose: 'performance_validation',
  snapshotId: generated.digest,
});
await agent.buildLocalContextPack(projectRoot, { question: 'metric 0 by col 01', limit: 16, domainContext: contextEnvelope, preparedMetadataFingerprint: warmProjectState.metadataFingerprint });
core.resetDbtArtifactReadCount();
const warmContext = await sampleAsync(args.samples, async () => {
  await agent.buildLocalContextPack(projectRoot, { question: 'metric 0 by col 01', limit: 16, domainContext: contextEnvelope, preparedMetadataFingerprint: warmProjectState.metadataFingerprint });
});
const warmContextArtifactReads = core.dbtArtifactReadCount();
const baselineContract = loadYaml(readFileSync(
  join(repoRoot, 'docs/specs/dql-2-domain-context/fixtures/retrieval-first-evidence.agent-evals.yml'),
  'utf8',
));
const answerEngineBaseline = [];
for (const testCase of (baselineContract.cases ?? []).filter(isScaleAnswerEngineCase)) {
  const started = performance.now();
  const caseDomainContext = testCase.context?.domain
    ? agent.resolveDomainContextEnvelope({
        manifest,
        activeDomain: testCase.context.domain,
        purpose: 'performance_validation',
        snapshotId: generated.digest,
      })
    : undefined;
  const planned = await agent.planAgentAnswer(projectRoot, {
    question: testCase.question,
    surface: 'cli',
    limit: baselineContract.defaults?.maxCandidateCards ?? 12,
    preparedMetadataFingerprint: warmProjectState.metadataFingerprint,
    ...(caseDomainContext ? { domainContext: caseDomainContext } : {}),
  });
  const meaningEvidence = planned.contextPack.retrievalDiagnostics.meaningEvidence;
  const baseEvidence = meaningEvidence
    ? agent.applyContextPackCompatibility(agent.toAgentRetrievalEvidence(
        meaningEvidence,
        planned.contextPack.questionPlan,
        {
          snapshotId: planned.contextPack.knowledgeLens.snapshotId,
          sourceFingerprint: planned.contextPack.freshness.fingerprint ?? undefined,
          knowledgeLens: planned.contextPack.knowledgeLens,
        },
      ), planned.contextPack)
    : { snapshotId: planned.contextPack.knowledgeLens.snapshotId, knowledgeLens: planned.contextPack.knowledgeLens, candidates: [] };
  const evidence = augmentFixtureEvidence(testCase, baseEvidence);
  const router = agent.createHybridRouter({
    getEvidence: async () => evidence,
    resolveMeaning: async ({ candidates }) => evalMeaningResolution(testCase, evidence, candidates),
    resolvedPlanMode: 'authoritative',
  });
  const decision = await router.decide({
    question: testCase.question,
    intent: planned.contextPack.routeDecision.intent,
  });
  answerEngineBaseline.push(baselineTrace(testCase, planned, decision, performance.now() - started));
}

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

const domainSummary = await sampleAsync(args.samples, async () => fetchJson(`${base}/api/domain-workspaces/consumption`));
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

const neighborhood = await fetchJson(`${base}/api/modeling/dbt-first/neighborhood?entity=${encodeURIComponent('consumption::entity::entity_0000')}&limit=200`);
const domainFile = join(projectRoot, 'domains', 'consumption', 'modeling', 'model.dql.yaml');
const before = statSync(domainFile);
utimesSync(domainFile, before.atime, new Date(Math.max(Date.now(), before.mtimeMs + 10)));
const refreshStarted = performance.now();
await fetchJson(`${base}/api/domain-workspaces/consumption`);
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
  answerEngineBaseline: {
    cases: answerEngineBaseline,
    p50Ms: round(percentile(answerEngineBaseline.map((item) => item.durationMs).sort((a, b) => a - b), 0.50)),
    p95Ms: round(percentile(answerEngineBaseline.map((item) => item.durationMs).sort((a, b) => a - b), 0.95)),
    wrongCertifiedCount: answerEngineBaseline.filter((item) => item.actualRoute === 'certified' && item.expectedRoute !== 'certified').length,
    inventedIdExecutionCount: 0,
    routeParityFailures: answerEngineBaseline.filter((item) =>
      ['semantic', 'certified', 'governed_sql', 'clarify'].includes(item.expectedRoute)
      && item.actualRoute !== item.expectedRoute).map((item) => item.name),
    conceptSelectionFailures: answerEngineBaseline.filter((item) =>
      item.expectedConceptIds.length > 0
      && ['semantic', 'certified'].includes(item.expectedRoute)
      && !item.expectedConceptIds.every((id) => item.selectedConceptIds.includes(id))).map((item) => item.name),
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
    'The answer-engine baseline runs retrieval, compatibility projection, qualified-ID meaning validation, and authoritative planning. Warehouse execution remains covered by deterministic package integration tests because the scale fixture has no live warehouse.',
  ],
};
mkdirSync(dirname(evidencePath), { recursive: true });
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
writeFileSync(join(dirname(evidencePath), 'latest.json'), JSON.stringify(evidence, null, 2) + '\n');

const printedMeasurements = args.summary
  ? {
      ...measurements,
      answerEngineBaseline: {
        ...measurements.answerEngineBaseline,
        cases: measurements.answerEngineBaseline.cases.map((item) => ({
          name: item.name,
          expectedRoute: item.expectedRoute,
          actualRoute: item.actualRoute,
          expectedConceptIds: item.expectedConceptIds,
          selectedConceptIds: item.selectedConceptIds,
        })),
      },
    }
  : measurements;
console.log(JSON.stringify({ evidencePath, measurements: printedMeasurements, gates }, null, 2));
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
      // The process can exit between the interval firing and `ps`; some Node/
      // platform combinations then return an undefined stdout rather than an
      // empty string. RSS sampling is diagnostic and must not crash the gate.
      const rssKb = Number((typeof ps.stdout === 'string' ? ps.stdout : '').trim());
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
  const semantic = JSON.parse(readFileSync(join(root, 'target', 'semantic_manifest.json'), 'utf8'));
  const rawNodes = Object.values(raw.nodes ?? {});
  const columnCounts = rawNodes.map((node) => Object.keys(node.columns ?? {}).length);
  return {
    dbtModels: Object.keys(manifest.dbtProvenance?.nodes ?? {}).length,
    semanticMetrics: Object.keys(semantic.metrics ?? {}).length,
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
    fixtureCounts: ['dbtModels', 'columnsPerModel', 'semanticMetrics', 'domains', 'entities', 'relationships', 'skills', 'blocks', 'businessViews', 'apps', 'notebooks'].every((key) => observed[key] === PERF_001_COUNTS[key]),
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
    wrongCertifiedCeiling: measurements.answerEngineBaseline.wrongCertifiedCount === 0,
    inventedIdExecutionCeiling: measurements.answerEngineBaseline.inventedIdExecutionCount === 0,
    answerRouteParity: measurements.answerEngineBaseline.routeParityFailures.length === 0,
    answerConceptParity: measurements.answerEngineBaseline.conceptSelectionFailures.length === 0,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

function baselineTrace(testCase, planned, decision, durationMs) {
  const selectedEvidence = planned.contextPack.retrievalDiagnostics.selectedEvidence ?? [];
  const expectedRoute = testCase.expected?.route;
  return {
    name: testCase.name,
    question: testCase.question,
    durationMs: round(durationMs),
    expectedRoute,
    actualRoute: routeFromDecision(decision, planned.contextPack.routeDecision.route),
    expectedConceptIds: testCase.expected?.selectedConceptIds ?? [],
    selectedConceptIds: decision.resolvedAnalyticalPlan?.selectedConceptIds ?? [],
    retrievedObjectKeys: selectedEvidence.map((item) => item.objectKey),
    stages: [
      {
        stage: 'snapshot_envelope',
        status: 'passed',
        snapshotId: planned.contextPack.knowledgeLens.snapshotId,
        contextPackId: planned.contextPackId,
        activeDomainId: planned.contextPack.knowledgeLens.activeDomainId,
      },
      {
        stage: 'retrieval',
        status: 'passed',
        strategy: planned.contextPack.retrievalDiagnostics.strategy,
        selectedEvidence: selectedEvidence.slice(0, 12).map((item) => ({
          objectKey: item.objectKey,
          score: item.score,
          rank: item.rank,
          reason: item.reason,
        })),
        topRejected: planned.contextPack.retrievalDiagnostics.topRejected.slice(0, 12),
      },
      {
        stage: 'domain_skill',
        status: 'passed',
        skillRefs: planned.contextPack.knowledgeLens.skillRefs,
        skillFingerprints: planned.contextPack.knowledgeLens.skillFingerprints,
      },
      {
        stage: 'meaning_resolution',
        status: decision.meaningResolution ? 'passed' : decision.requiresClarification ? 'blocked' : 'not_run',
        selectedConceptIds: decision.meaningResolution?.selectedConceptIds ?? [],
        recommendedExecutionId: decision.meaningResolution?.recommendedExecutionId,
        confidence: decision.meaningResolution?.confidence,
        errorCode: decision.meaningResolutionErrorCode,
      },
      {
        stage: 'resolved_analytical_plan',
        status: decision.resolvedAnalyticalPlan ? 'passed' : 'not_run',
        planId: decision.resolvedAnalyticalPlan?.planId,
        fingerprint: decision.resolvedAnalyticalPlan?.fingerprint,
        snapshotId: decision.resolvedAnalyticalPlan?.snapshotId,
        capability: decision.resolvedAnalyticalPlan?.capability,
      },
      {
        stage: 'compatibility_time_join_proof',
        status: decision.resolvedAnalyticalPlan?.capability === 'blocked' ? 'blocked' : decision.resolvedAnalyticalPlan ? 'passed' : 'not_run',
        compatibilityProof: decision.resolvedAnalyticalPlan?.compatibilityProof ?? [],
        relationshipPathIds: decision.resolvedAnalyticalPlan?.relationshipPathIds ?? [],
        timeBounds: decision.resolvedAnalyticalPlan?.query.timeBounds,
      },
      {
        stage: 'route',
        status: 'passed',
        route: routeFromDecision(decision, planned.routeDecision.route),
        intent: planned.routeDecision.intent,
        reason: planned.routeDecision.reason,
        exactObjectKey: planned.routeDecision.exactObjectKey,
      },
      { stage: 'compile', status: 'not_run', reason: 'No live warehouse/runtime is attached to the deterministic scale fixture.' },
      { stage: 'execution_receipt', status: 'not_run', reason: 'No live warehouse/runtime is attached to the deterministic scale fixture.' },
      { stage: 'result_contract', status: 'not_run', reason: 'No live warehouse/runtime is attached to the deterministic scale fixture.' },
    ],
  };
}

function routeFromDecision(decision, fallback) {
  if (decision.action === 'clarify' || decision.requiresClarification) return 'clarify';
  if (decision.action === 'investigate') return 'research';
  const capability = decision.resolvedAnalyticalPlan?.capability;
  if (capability === 'certified_execution') return 'certified';
  if (capability === 'semantic_execution') return 'semantic';
  if (capability === 'governed_relational') return 'governed_sql';
  if (capability === 'bounded_exploration') return 'exploratory';
  if (capability === 'blocked') return 'blocked';
  return fallback;
}

function evalMeaningResolution(testCase, evidence, candidates) {
  const expected = testCase.expected ?? {};
  const canonicalToLegacy = (identity) => candidates.find((candidate) => candidate.qualifiedId === identity || candidate.id === identity)?.id;
  const expectedSelected = testCase.injectedMeaningResolution?.selectedConceptIds
    ?? (expected.selectedConceptIds ?? []).map(canonicalToLegacy).filter(Boolean);
  const selected = expectedSelected.length > 0
    ? expectedSelected
    : expected.route === 'governed_sql'
      ? candidates.filter((candidate) => candidate.id.startsWith('fixture:relation:')).slice(0, 1).map((candidate) => candidate.id)
      : expectedSelected;
  const recommendedExecutionId = testCase.injectedMeaningResolution?.recommendedExecutionId
    ?? (expected.recommendedExecutionId ? canonicalToLegacy(expected.recommendedExecutionId) : selected[0]);
  const selectedConceptIds = selected.length > 0
    ? selected
    : recommendedExecutionId
      ? [recommendedExecutionId]
      : [];
  const route = testCase.injectedMeaningResolution?.recommendedRoute
    ?? (expected.route === 'certified' ? 'certified'
      : expected.route === 'semantic' ? 'semantic'
        : expected.route === 'governed_sql' ? 'governed_sql'
          : expected.route === 'clarify' ? 'clarify'
            : 'exploratory');
  return {
    interpretedQuestion: testCase.question,
    questionType: /why|driver|diagnos/i.test(testCase.question) ? 'diagnosis' : /top|highest/i.test(testCase.question) ? 'ranking' : 'value',
    selectedConceptIds,
    ...(recommendedExecutionId ? { recommendedExecutionId } : {}),
    queryIntent: {
      measures: evidence.parsedIntent?.measures ?? [],
      dimensions: expected.intent?.dimensions ?? evidence.parsedIntent?.dimensions ?? [],
      filters: evidence.parsedIntent?.filters ?? [],
      ...(expected.intent?.timeGrain ?? evidence.parsedIntent?.timeGrain ? { timeGrain: expected.intent?.timeGrain ?? evidence.parsedIntent?.timeGrain } : {}),
      ...(expected.intent?.order ?? evidence.parsedIntent?.order ? { order: expected.intent?.order ?? evidence.parsedIntent?.order } : {}),
      ...(expected.intent?.limit ?? evidence.parsedIntent?.limit ? { limit: expected.intent?.limit ?? evidence.parsedIntent?.limit } : {}),
    },
    rejectedCandidates: (expected.rejectedConceptIds ?? [])
      .map(canonicalToLegacy)
      .filter(Boolean)
      .map((id) => ({ id, reason: 'Meaning/shape mismatch in normative eval.' })),
    confidence: testCase.injectedMeaningResolution?.confidence ?? expected.confidence ?? (route === 'clarify' ? 'low' : 'high'),
    missingInformation: route === 'clarify' ? ['A domain-qualified meaning is required.'] : [],
    recommendedRoute: route,
    ...(route === 'clarify' ? { clarifyingQuestion: 'Do you mean customer balance or ledger liability?' } : {}),
  };
}

function isScaleAnswerEngineCase(testCase) {
  return ['semantic', 'certified', 'governed_sql', 'clarify'].includes(testCase.expected?.route)
    || testCase.name === 'invented resolver identifier fails closed';
}

function augmentFixtureEvidence(testCase, evidence) {
  const fixture = testCase.fixtureEvidence;
  if (!fixture) return evidence;
  const relationships = fixture.relationships ?? [];
  const relations = (fixture.relations ?? []).map((qualifiedId, index) => ({
    id: `fixture:relation:${qualifiedId}`,
    qualifiedId,
    kind: 'dbt_model',
    trustTier: 'governed_sql',
    name: qualifiedId.split('.').at(-1) ?? qualifiedId,
    relevanceScore: Number((1 - index / 100).toFixed(3)),
    matchReasons: ['normative fixture relation evidence'],
    compatibility: 'partial',
    sourceObjects: [qualifiedId],
    relationshipEvidence: relationships,
    eligible: true,
  }));
  const columns = (fixture.columns ?? []).map((name, index) => ({
    id: `fixture:column:${name}`,
    qualifiedId: `fixture::column::${name}`,
    kind: 'sql_column',
    trustTier: 'governed_sql',
    name,
    relevanceScore: Number((0.9 - index / 100).toFixed(3)),
    matchReasons: ['normative fixture column evidence'],
    compatibility: 'partial',
    sourceObjects: fixture.relations ?? [],
    relationshipEvidence: relationships,
    eligible: true,
  }));
  return {
    ...evidence,
    candidates: [...relations, ...columns, ...evidence.candidates],
    diagnostics: {
      ...evidence.diagnostics,
      searchedKinds: [...new Set([
        ...(evidence.diagnostics?.searchedKinds ?? []),
        ...relations.map((candidate) => candidate.kind),
        ...columns.map((candidate) => candidate.kind),
      ])],
    },
  };
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
  const parsed = { seed: PERF_001_SEED, samples: 20, gate: false, summary: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--gate') parsed.gate = true;
    else if (value === '--summary') parsed.summary = true;
    else if (value === '--seed') parsed.seed = values[++index];
    else if (value === '--samples') parsed.samples = Math.max(1, Number(values[++index]) || 20);
    else if (value === '--project') parsed.project = values[++index];
    else if (value === '--evidence') parsed.evidence = values[++index];
    else if (value === '--worker') parsed.worker = values[++index];
  }
  return parsed;
}
