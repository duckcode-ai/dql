import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type {
  AskTraceDataV1,
  AskTraceEnvelopeV1,
  AskTraceExportReceiptV1,
  AskTraceLinkV1,
  AskTraceSpanV1,
  CandidateDecisionV1,
} from './types.js';
import { canonicalJson, fingerprint, pseudo, sha256 } from './utils.js';

export type AskTraceExportProfileV1 = 'strict' | 'support';

export interface AskTraceExportOptionsV1 {
  profile: AskTraceExportProfileV1;
  outputDirectory: string;
  /** Support exports require an explicit human confirmation from the CLI/API. */
  confirmReviewedIdentifiers?: boolean;
  /** Never sourced from a stored run: support prose is opt-in reviewed input. */
  reviewedQuestion?: string;
  runReceipt?: unknown;
  provenance?: 'live' | 'recorded' | 'synthetic' | 'migrated' | 'unknown';
}

export type AskTracePortableBundleOptionsV1 = Omit<AskTraceExportOptionsV1, 'outputDirectory'>;

/** A redacted in-memory bundle for the local runtime download endpoint. */
export interface AskTracePortableBundleV1 {
  manifest: AskTraceBundleManifestV1;
  trace: AskTraceDataV1;
  runReceipt: Record<string, unknown>;
  redactionReceipt: Record<string, unknown>;
}

export interface AskTraceBundleValidationV1 {
  valid: boolean;
  errors: string[];
  manifest?: AskTraceBundleManifestV1;
}

export interface AskTraceBundleManifestV1 {
  version: 1;
  schema: 'dql.ask-trace-bundle.v1';
  profile: AskTraceExportProfileV1;
  createdAt: string;
  provenance: 'live' | 'recorded' | 'synthetic' | 'migrated' | 'unknown';
  bundleFingerprint: string;
  checksums: Record<'trace.json' | 'run-receipt.json' | 'redaction-receipt.json', string>;
  traceFingerprint?: string;
  traceId: string;
}

export interface AskTraceCompareResultV1 {
  compatibleIdentity: boolean;
  leftTraceId: string;
  rightTraceId: string;
  selectedTier: { left?: string; right?: string; matches: boolean };
  recordingStatus: { left: string; right: string; matches: boolean };
  sourceCoverageChanges: Array<{ source: string; left?: string; right?: string }>;
  candidateReasonChanges: Array<{ role: string; reason: string; left: number; right: number }>;
  attempts: { left: number; right: number };
  providerAttempts: { left: number; right: number };
  toolCalls: { left: number; right: number };
  sqlAttempts: { left: number; right: number };
  trustState: { left?: string; right?: string; matches: boolean };
  durationDeltaMs?: number;
  notes: string[];
}

/** Defense-in-depth forbidden content canary. Strict export must pass this. */
const PROHIBITED = [
  /(?:authorization|cookie|x-api-key|api[_-]?key|password|secret|token)\s*[:=]/i,
  /-----BEGIN [A-Z ]+-----/,
  /\bselect\b[\s\S]{0,120}\bfrom\b/i,
  /https?:\/\//i,
  /(?:^|[\s"'])\/(?:Users|home|tmp|private|var)\//,
  /\b(?:sk|pk|rk)_[A-Za-z0-9_-]{12,}\b/,
];

export function createAskTracePortableBundleV1(trace: AskTraceDataV1, options: AskTracePortableBundleOptionsV1): AskTracePortableBundleV1 {
  if (options.profile === 'support' && !options.confirmReviewedIdentifiers) {
    throw Object.assign(new Error('Support export requires --confirm-reviewed-identifiers.'), { code: 'TRACE_EXPORT_REDACTION_FAILED' });
  }
  // Export-scoped pseudonyms and bundle content are deterministic for the same
  // stored receipt. A support engineer can therefore validate/compare bundles
  // without an export timestamp changing every identifier or checksum.
  const createdAt = trace.envelope.completedAt ?? trace.envelope.startedAt;
  const salt = fingerprint({ trace: trace.envelope.traceId, profile: options.profile, schema: 1 });
  const portableTrace = redactTrace(trace, options.profile, salt);
  const receipt = redactRunReceipt(options.runReceipt, trace, options.profile, salt);
  const redactionReceipt: Record<string, unknown> = {
    version: 1,
    profile: options.profile,
    identifiers: options.profile === 'strict' ? 'pseudonymized' : 'reviewed_only',
    reviewedQuestionIncluded: options.profile === 'support' && Boolean(options.reviewedQuestion?.trim()),
    generatedAt: createdAt,
  };
  if (options.profile === 'support' && options.reviewedQuestion?.trim()) {
    // A review-provided question goes in one explicitly named safe field; it
    // never flows from an AgentRun or trace store.
    redactionReceipt.reviewedQuestion = options.reviewedQuestion.trim().slice(0, 2_000);
  }
  // Support-only reviewed prose is explicit human input, but it remains
  // untrusted for secrets, SQL, paths, and other prohibited content.
  const canary = scanForProhibited([portableTrace, receipt, redactionReceipt]);
  if (!canary.passed) {
    throw Object.assign(new Error(`Trace export redaction failed: ${canary.findings.join(', ')}`), { code: 'TRACE_EXPORT_REDACTION_FAILED' });
  }
  redactionReceipt.prohibitedContentScan = canary;
  const traceJson = `${canonicalJson(portableTrace)}\n`;
  const receiptJson = `${canonicalJson(receipt)}\n`;
  const redactionJson = `${canonicalJson(redactionReceipt)}\n`;
  const checksums = {
    'trace.json': sha256(traceJson),
    'run-receipt.json': sha256(receiptJson),
    'redaction-receipt.json': sha256(redactionJson),
  };
  const manifest: AskTraceBundleManifestV1 = {
    version: 1,
    schema: 'dql.ask-trace-bundle.v1',
    profile: options.profile,
    createdAt,
    provenance: options.provenance ?? 'unknown',
    bundleFingerprint: fingerprint({ checksums, profile: options.profile, trace: portableTrace.envelope.traceFingerprint ?? portableTrace.envelope.traceId }),
    checksums,
    ...(portableTrace.envelope.traceFingerprint ? { traceFingerprint: portableTrace.envelope.traceFingerprint } : {}),
    traceId: portableTrace.envelope.traceId,
  };
  return { manifest, trace: portableTrace, runReceipt: receipt, redactionReceipt };
}

export function exportAskTraceBundleV1(trace: AskTraceDataV1, options: AskTraceExportOptionsV1): AskTraceExportReceiptV1 {
  const output = resolve(options.outputDirectory);
  if (existsSync(output) && readdirSync(output).length > 0) {
    throw Object.assign(new Error('Trace export directory must be empty; existing bundle files are never overwritten.'), { code: 'TRACE_EXPORT_REDACTION_FAILED' });
  }
  const bundle = createAskTracePortableBundleV1(trace, options);
  mkdirSync(output, { recursive: true });
  const traceJson = `${canonicalJson(bundle.trace)}\n`;
  const receiptJson = `${canonicalJson(bundle.runReceipt)}\n`;
  const redactionJson = `${canonicalJson(bundle.redactionReceipt)}\n`;
  const manifestJson = `${canonicalJson(bundle.manifest)}\n`;
  writeFileSync(join(output, 'trace.json'), traceJson, { encoding: 'utf8', flag: 'wx' });
  writeFileSync(join(output, 'run-receipt.json'), receiptJson, { encoding: 'utf8', flag: 'wx' });
  writeFileSync(join(output, 'redaction-receipt.json'), redactionJson, { encoding: 'utf8', flag: 'wx' });
  writeFileSync(join(output, 'manifest.json'), manifestJson, { encoding: 'utf8', flag: 'wx' });
  return {
    version: 1,
    profile: bundle.manifest.profile,
    bundleFingerprint: bundle.manifest.bundleFingerprint,
    exportedAt: bundle.manifest.createdAt,
    checksums: { 'manifest.json': sha256(manifestJson), ...bundle.manifest.checksums },
    canaryPassed: true,
    ...(bundle.trace.envelope.traceFingerprint ? { traceFingerprint: bundle.trace.envelope.traceFingerprint } : {}),
  };
}

export function validateAskTraceBundleV1(directory: string): AskTraceBundleValidationV1 {
  const root = resolve(directory);
  const errors: string[] = [];
  const names = ['manifest.json', 'trace.json', 'run-receipt.json', 'redaction-receipt.json'] as const;
  for (const name of names) if (!existsSync(join(root, name))) errors.push(`Missing ${name}.`);
  if (errors.length) return { valid: false, errors };
  const parsed = Object.fromEntries(names.map((name) => [name, parseJsonFile(join(root, name), errors)])) as Record<typeof names[number], unknown>;
  const manifest = parsed['manifest.json'] as AskTraceBundleManifestV1 | undefined;
  if (!manifest || manifest.version !== 1 || manifest.schema !== 'dql.ask-trace-bundle.v1') errors.push('Unsupported trace bundle manifest.');
  if (manifest) {
    for (const name of ['trace.json', 'run-receipt.json', 'redaction-receipt.json'] as const) {
      const actual = sha256(readFileSync(join(root, name), 'utf8'));
      if (actual !== manifest.checksums[name]) errors.push(`Checksum mismatch for ${name}.`);
    }
    const expectedBundle = fingerprint({ checksums: manifest.checksums, profile: manifest.profile, trace: manifest.traceFingerprint ?? manifest.traceId });
    if (manifest.bundleFingerprint !== expectedBundle) errors.push('Bundle fingerprint mismatch.');
  }
  const scan = scanForProhibited([parsed['trace.json'], parsed['run-receipt.json'], parsed['redaction-receipt.json']]);
  if (!scan.passed) errors.push(`Redaction canary failed: ${scan.findings.join(', ')}.`);
  const trace = parsed['trace.json'] as AskTraceDataV1 | undefined;
  if (trace) errors.push(...validateTraceReceiptV1(trace));
  errors.push(...validateRunReceiptTerminalGapV1(parsed['run-receipt.json'], trace));
  return { valid: errors.length === 0, errors, ...(manifest ? { manifest } : {}) };
}

/** Offline-only receipt replay. It validates; it never imports providers/tools/connectors. */
export function replayAskTraceReceiptV1(directory: string): { valid: boolean; errors: string[]; trace?: AskTraceDataV1 } {
  const validation = validateAskTraceBundleV1(directory);
  if (!validation.valid) return { valid: false, errors: validation.errors };
  const trace = parseJsonFile(join(resolve(directory), 'trace.json'), []) as AskTraceDataV1 | undefined;
  const errors = trace ? validateTraceReceiptV1(trace) : ['Trace payload is missing.'];
  return { valid: errors.length === 0, errors, ...(trace ? { trace } : {}) };
}

export function compareAskTracesV1(left: AskTraceDataV1, right: AskTraceDataV1): AskTraceCompareResultV1 {
  const reasonCounts = (trace: AskTraceDataV1): Map<string, number> => new Map(
    trace.candidateDecisions.reduce((all, candidate) => {
      const key = `${candidate.role}\u0000${candidate.reasonCode}`;
      all.set(key, (all.get(key) ?? 0) + 1);
      return all;
    }, new Map<string, number>()),
  );
  const leftReasons = reasonCounts(left);
  const rightReasons = reasonCounts(right);
  const candidateReasonChanges = [...new Set([...leftReasons.keys(), ...rightReasons.keys()])]
    .sort()
    .flatMap((key) => {
      const [role, reason] = key.split('\u0000');
      const l = leftReasons.get(key) ?? 0;
      const r = rightReasons.get(key) ?? 0;
      return l === r ? [] : [{ role, reason, left: l, right: r }];
    });
  const coverage = (trace: AskTraceDataV1) => new Map(
    trace.spans.flatMap((span) => span.payload.kind === 'cascade'
      ? span.payload.decision.sourceCoverage.map((entry) => [entry.source, entry.status] as const)
      : []),
  );
  const leftCoverage = coverage(left);
  const rightCoverage = coverage(right);
  const sourceCoverageChanges = [...new Set([...leftCoverage.keys(), ...rightCoverage.keys()])]
    .sort()
    .flatMap((source) => leftCoverage.get(source) === rightCoverage.get(source)
      ? []
      : [{ source, left: leftCoverage.get(source), right: rightCoverage.get(source) }]);
  const count = (trace: AskTraceDataV1, name: string) => trace.spans.filter((span) => span.name === name).length;
  const attempts = (trace: AskTraceDataV1) => trace.spans.flatMap((span) => span.payload.kind === 'cascade' ? span.payload.decision.attempts : []).length;
  const compatibleIdentity = left.envelope.traceId === right.envelope.traceId
    || Boolean(left.envelope.traceFingerprint && right.envelope.traceFingerprint && left.envelope.traceFingerprint === right.envelope.traceFingerprint);
  return {
    compatibleIdentity,
    leftTraceId: left.envelope.traceId,
    rightTraceId: right.envelope.traceId,
    selectedTier: {
      left: left.envelope.selectedTier,
      right: right.envelope.selectedTier,
      matches: left.envelope.selectedTier === right.envelope.selectedTier,
    },
    recordingStatus: {
      left: left.envelope.recordingStatus,
      right: right.envelope.recordingStatus,
      matches: left.envelope.recordingStatus === right.envelope.recordingStatus,
    },
    sourceCoverageChanges,
    candidateReasonChanges,
    attempts: { left: attempts(left), right: attempts(right) },
    providerAttempts: { left: count(left, 'provider.attempt'), right: count(right, 'provider.attempt') },
    toolCalls: { left: count(left, 'tool.call'), right: count(right, 'tool.call') },
    sqlAttempts: { left: count(left, 'sql.execute'), right: count(right, 'sql.execute') },
    trustState: { left: left.envelope.trustState, right: right.envelope.trustState, matches: left.envelope.trustState === right.envelope.trustState },
    ...(typeof left.envelope.durationMs === 'number' && typeof right.envelope.durationMs === 'number'
      ? { durationDeltaMs: right.envelope.durationMs - left.envelope.durationMs }
      : {}),
    notes: compatibleIdentity
      ? []
      : ['Trace identities use export-scoped pseudonyms or differ; stage and role comparison remains available.'],
  };
}

/** Portable, local JSON mapper — intentionally no OTLP network exporter. */
export function toOtlpOpenInferenceJsonV1(trace: AskTraceDataV1): Record<string, unknown> {
  const spanKind = (span: AskTraceSpanV1): 'AGENT' | 'RETRIEVER' | 'LLM' | 'TOOL' | 'CHAIN' => {
    if (span.name === 'ask.run' || span.name === 'research.run') return 'AGENT';
    if (span.stage === 'retrieval') return 'RETRIEVER';
    if (span.stage === 'provider') return 'LLM';
    if (span.stage === 'tool' || span.name === 'sql.execute') return 'TOOL';
    return 'CHAIN';
  };
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'dql-ask-local' } }] },
      scopeSpans: [{
        scope: { name: 'dql.ask-observability', version: '1' },
        spans: trace.spans.map((span) => ({
          traceId: trace.envelope.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          startTimeUnixNano: String(Date.parse(span.startedAt) * 1_000_000),
          ...(span.completedAt ? { endTimeUnixNano: String(Date.parse(span.completedAt) * 1_000_000) } : {}),
          status: { code: span.outcome === 'ok' ? 1 : 2, message: span.reasonCode },
          attributes: [
            { key: 'openinference.span.kind', value: { stringValue: spanKind(span) } },
            { key: 'dql.ask.stage', value: { stringValue: span.stage } },
            { key: 'dql.ask.outcome', value: { stringValue: span.outcome } },
            { key: 'dql.ask.reason_code', value: { stringValue: span.reasonCode } },
          ],
        })),
      }],
    }],
  };
}

function redactTrace(trace: AskTraceDataV1, profile: AskTraceExportProfileV1, salt: string): AskTraceDataV1 {
  const mapId = (value: string, kind = 'id') => profile === 'strict' ? pseudo(value, salt, kind) : value;
  const redactEnvelope = (envelope: AskTraceEnvelopeV1): AskTraceEnvelopeV1 => ({
    ...envelope,
    traceId: mapId(envelope.traceId, 'trace'),
    rootSpanId: mapId(envelope.rootSpanId, 'span'),
    runId: mapId(envelope.runId, 'run'),
    ...(envelope.threadId ? { threadId: mapId(envelope.threadId, 'thread') } : {}),
    ...(envelope.snapshotId ? { snapshotId: mapId(envelope.snapshotId, 'snapshot') } : {}),
    ...(envelope.parentTraceId ? { parentTraceId: mapId(envelope.parentTraceId, 'trace') } : {}),
    ...(envelope.parentRunId ? { parentRunId: mapId(envelope.parentRunId, 'run') } : {}),
    ...(envelope.firstIssueSpanId ? { firstIssueSpanId: mapId(envelope.firstIssueSpanId, 'span') } : {}),
  });
  const mappedTraceId = mapId(trace.envelope.traceId, 'trace');
  const spans = trace.spans.map((span) => redactSpan(span, profile, salt, mappedTraceId));
  const candidates = trace.candidateDecisions.map((candidate) => redactCandidate(candidate, profile, salt, mappedTraceId));
  const links = trace.links.map((link) => redactLink(link, profile, salt, mappedTraceId));
  return { envelope: redactEnvelope(trace.envelope), spans, candidateDecisions: candidates, links };
}

function redactSpan(span: AskTraceSpanV1, profile: AskTraceExportProfileV1, salt: string, traceId: string): AskTraceSpanV1 {
  const map = (value: string, kind = 'id') => profile === 'strict' ? pseudo(value, salt, kind) : value;
  const payload = redactPayload(span.payload, profile, salt);
  return {
    ...span,
    traceId,
    spanId: map(span.spanId, 'span'),
    ...(span.parentSpanId ? { parentSpanId: map(span.parentSpanId, 'span') } : {}),
    payload,
  };
}

function redactCandidate(candidate: CandidateDecisionV1, profile: AskTraceExportProfileV1, salt: string, traceId: string): CandidateDecisionV1 {
  if (profile === 'support') return { ...candidate, traceId };
  return {
    ...candidate,
    traceId,
    candidateId: pseudo(candidate.candidateId, salt, 'candidate'),
  };
}

function redactLink(link: AskTraceLinkV1, profile: AskTraceExportProfileV1, salt: string, _traceId: string): AskTraceLinkV1 {
  const map = (value: string, kind: string) => profile === 'strict' ? pseudo(value, salt, kind) : value;
  return {
    ...link,
    // A fetched trace can be either end of a relationship.  Map each original
    // endpoint independently so strict bundles retain the actual edge direction
    // instead of rewriting every source into the selected trace.
    sourceTraceId: map(link.sourceTraceId, 'trace'),
    sourceRunId: map(link.sourceRunId, 'run'),
    ...(link.targetTraceId ? { targetTraceId: map(link.targetTraceId, 'trace') } : {}),
    ...(link.targetRunId ? { targetRunId: map(link.targetRunId, 'run') } : {}),
  };
}

function redactPayload(payload: AskTraceSpanV1['payload'], profile: AskTraceExportProfileV1, salt: string): AskTraceSpanV1['payload'] {
  const map = (value: string, kind = 'id') => profile === 'strict' ? pseudo(value, salt, kind) : value;
  switch (payload.kind) {
    case 'snapshot': return { ...payload, ...(payload.snapshotId ? { snapshotId: map(payload.snapshotId, 'snapshot') } : {}) };
    case 'meaning': return { ...payload, selectedCandidateIds: payload.selectedCandidateIds.map((id) => map(id, 'candidate')), rejectedCandidateIds: payload.rejectedCandidateIds.map((id) => map(id, 'candidate')) };
    case 'cascade': return {
      ...payload,
      decision: {
        ...payload.decision,
        ...(payload.decision.terminalGap ? {
          terminalGap: {
            code: payload.decision.terminalGap.code,
            requirement: payload.decision.terminalGap.requirement,
            witnessCandidateIds: payload.decision.terminalGap.witnessCandidateIds.map((id) => map(id, 'candidate')),
          },
        } : {}),
        sourceCoverage: payload.decision.sourceCoverage.map((coverage) => ({ ...coverage, candidateIds: coverage.candidateIds.map((id) => map(id, 'candidate')) })),
        attempts: payload.decision.attempts.map((attempt) => ({ ...attempt, candidateIds: attempt.candidateIds.map((id) => map(id, 'candidate')) })),
      },
    };
    case 'tool': return { ...payload, call: { ...payload.call, toolCallId: map(payload.call.toolCallId, 'tool') } };
    case 'research': return { ...payload, ...(payload.branchId ? { branchId: map(payload.branchId, 'branch') } : {}) };
    default: return payload;
  }
}

function redactRunReceipt(value: unknown, trace: AskTraceDataV1, profile: AskTraceExportProfileV1, salt: string): Record<string, unknown> {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const source = record.diagnosticReceiptV3 && typeof record.diagnosticReceiptV3 === 'object'
    ? record.diagnosticReceiptV3 as Record<string, unknown>
    : {};
  const map = (value: unknown, kind = 'id') => typeof value === 'string'
    ? profile === 'strict' ? pseudo(value, salt, kind) : value
    : undefined;
  const terminalGap = portableTerminalRelationshipGapV1(
    source.terminalGap
      ?? (source.cascade && typeof source.cascade === 'object'
        ? (source.cascade as Record<string, unknown>).terminalGap
        : undefined),
    profile,
    salt,
  );
  const runtimeReceiptV5 = portableRuntimeReceiptV5(record.diagnosticReceiptV5, profile, salt);
  const runtimeReceiptV6 = portableRuntimeReceiptV6(record.diagnosticReceiptV6, profile, salt);
  const runtimeReceiptV8 = portableRuntimeReceiptV8(record.diagnosticReceiptV8, profile, salt);
  return {
    version: 1,
    traceReference: {
      traceId: profile === 'strict' ? pseudo(trace.envelope.traceId, salt, 'trace') : trace.envelope.traceId,
      recordingStatus: trace.envelope.recordingStatus,
      traceFingerprint: trace.envelope.traceFingerprint,
    },
    route: typeof record.route === 'string' ? record.route : undefined,
    status: typeof record.status === 'string' ? record.status : trace.envelope.status,
    trustState: typeof record.trustState === 'string' ? record.trustState : trace.envelope.trustState,
    selectedTier: trace.envelope.selectedTier,
    planFrozen: source.planFrozen === true,
    finalStopReason: typeof source.finalStopReason === 'string' ? source.finalStopReason : undefined,
    ...(terminalGap ? { terminalGap } : {}),
    ...(runtimeReceiptV5 ? { runtimeReceiptV5 } : {}),
    ...(runtimeReceiptV6 ? { runtimeReceiptV6 } : {}),
    ...(runtimeReceiptV8 ? { runtimeReceiptV8 } : {}),
    telemetry: sanitizeTelemetry(record.telemetry),
    fingerprints: {
      plan: map(findFingerprint(record, 'planFingerprint'), 'plan'),
      sql: map(findFingerprint(record, 'sqlFingerprint'), 'sql'),
      result: map(findFingerprint(record, 'resultFingerprint'), 'result'),
    },
  };
}

/**
 * V8 is the bounded Ask-tool-runtime story. Strict exports retain its
 * allowlisted enums, counts, timings, and pseudonymous identifiers only. In
 * particular, this deliberately does not make generated DQL/SQL exportable:
 * the local trace contract never retains query text, result rows, prompts,
 * provider responses, credentials, or chain-of-thought.
 */
function portableRuntimeReceiptV8(value: unknown, profile: AskTraceExportProfileV1, salt: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  if (receipt.version !== 8) return undefined;
  const record = (candidate: unknown): Record<string, unknown> | undefined =>
    candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as Record<string, unknown> : undefined;
  const count = (candidate: unknown, maximum = 10_000): number | undefined => typeof candidate === 'number' && Number.isFinite(candidate)
    ? Math.max(0, Math.min(maximum, Math.floor(candidate)))
    : undefined;
  const identifier = (candidate: unknown, kind: string): string | undefined => typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 256
    ? (profile === 'strict' ? pseudo(candidate, salt, kind) : candidate)
    : undefined;
  const safeCode = (candidate: unknown): string => typeof candidate === 'string' && /^[A-Z][A-Z0-9_:-]{1,95}$/.test(candidate)
    ? candidate
    : 'UNRECOGNIZED_REASON';
  const modes = new Set(['authoritative_v2']);
  const turns = new Set(['analytics', 'definition', 'business_context', 'prior_result', 'general', 'clarification_response', 'research']);
  const sources = new Set(['certified', 'semantic', 'governed_relational', 'dbt_manifest', 'runtime_schema', 'vector', 'conversation', 'business']);
  const sourceStates = new Set(['available', 'empty', 'stale', 'unavailable', 'errored', 'skipped']);
  const tools = new Set(['inspect_ask_context', 'inspect_conversation_result', 'inspect_business_context', 'inspect_certified_candidates', 'run_certified', 'inspect_semantic_candidates', 'compile_and_run_semantic', 'describe_metric', 'inspect_relational_context', 'describe_relation', 'compile_and_run_dql', 'validate_and_run_sql', 'search_values', 'request_clarification', 'finish_answer', 'propose_plan']);
  const outcomes = new Set(['eligible', 'executed', 'ineligible', 'unavailable', 'ambiguous', 'needs_input', 'denied', 'error']);
  const tiers = new Set(['certified', 'semantic', 'governed_relational', 'exploratory_sql']);
  const origins = new Set(['retrieval', 'agent_control', 'tool', 'validation', 'freeze', 'execution', 'provider', 'narration']);
  const terminalKinds = new Set(['finish_answer', 'clarification', 'gap', 'provider_failure', 'execution_failure', 'denied', 'budget_exhausted']);
  const semanticEngines = new Set(['native', 'metricflow-cli', 'dbt-cloud']);
  const providerPhases = new Set(['preflight', 'classification', 'meaning_resolution', 'planning', 'generation', 'repair', 'narration', 'agent_control', 'tool_followup', 'unknown']);
  const providerCauses = new Set(['authentication', 'model_not_found', 'rate_limited', 'gateway', 'network', 'provider_timeout', 'run_deadline', 'admission_denied', 'dispatch_budget', 'cancelled', 'unknown']);
  const narrations = new Set(['fact_bound', 'deterministic_fallback', 'not_retained', 'not_applicable']);
  if (typeof receipt.mode !== 'string' || !modes.has(receipt.mode)
    || typeof receipt.turnClass !== 'string' || !turns.has(receipt.turnClass)) return undefined;

  const contextCoverage = Array.isArray(receipt.contextCoverage)
    ? receipt.contextCoverage.flatMap((entry) => {
        const item = record(entry);
        if (!item || typeof item.source !== 'string' || !sources.has(item.source)
          || typeof item.status !== 'string' || !sourceStates.has(item.status)) return [];
        return [{
          source: item.source,
          status: item.status,
          ...(count(item.admittedCandidateCount) !== undefined ? { admittedCandidateCount: count(item.admittedCandidateCount)! } : {}),
          ...(count(item.excludedCandidateCount) !== undefined ? { excludedCandidateCount: count(item.excludedCandidateCount)! } : {}),
          reasonCodes: Array.isArray(item.reasonCodes) ? item.reasonCodes.slice(0, 8).map(safeCode) : [],
        }];
      })
    : [];
  const observations = Array.isArray(receipt.observations)
    ? receipt.observations.slice(0, 24).flatMap((entry) => {
        const item = record(entry);
        if (!item || typeof item.tool !== 'string' || !tools.has(item.tool)
          || typeof item.outcome !== 'string' || !outcomes.has(item.outcome)) return [];
        const provider = record(item.provider);
        const safeProvider = provider && typeof provider.phase === 'string' && providerPhases.has(provider.phase)
          && typeof provider.cause === 'string' && providerCauses.has(provider.cause)
          && typeof provider.retryable === 'boolean'
          ? { phase: provider.phase, cause: provider.cause, retryable: provider.retryable, safeAction: safeCode(provider.safeAction) }
          : undefined;
        return [{
          tool: item.tool,
          outcome: item.outcome,
          ...(typeof item.tier === 'string' && tiers.has(item.tier) ? { tier: item.tier } : {}),
          reasonCode: safeCode(item.reasonCode),
          candidateIds: Array.isArray(item.candidateIds)
            ? item.candidateIds.slice(0, 48).flatMap((id) => identifier(id, 'candidate') ? [identifier(id, 'candidate')!] : [])
            : [],
          ...(identifier(item.planId, 'plan') ? { planId: identifier(item.planId, 'plan') } : {}),
          ...(typeof item.frozen === 'boolean' ? { frozen: item.frozen } : {}),
          ...(typeof item.retryable === 'boolean' ? { retryable: item.retryable } : {}),
          ...(typeof item.safeAction === 'string' ? { safeAction: safeCode(item.safeAction) } : {}),
          ...(count(item.durationMs, 86_400_000) !== undefined ? { durationMs: count(item.durationMs, 86_400_000)! } : {}),
          ...(identifier(item.inputFingerprint, 'input') ? { inputFingerprint: identifier(item.inputFingerprint, 'input') } : {}),
          ...(identifier(item.outputFingerprint, 'output') ? { outputFingerprint: identifier(item.outputFingerprint, 'output') } : {}),
          ...(typeof item.origin === 'string' && origins.has(item.origin) ? { origin: item.origin } : {}),
          ...(safeProvider ? { provider: safeProvider } : {}),
        }];
      })
    : [];
  const tierAttempts = Array.isArray(receipt.tierAttempts)
    ? receipt.tierAttempts.slice(0, 8).flatMap((entry) => {
        const item = record(entry);
        if (!item || typeof item.tier !== 'string' || !tiers.has(item.tier)
          || typeof item.outcome !== 'string' || !outcomes.has(item.outcome)
          || typeof item.frozen !== 'boolean') return [];
        return [{
          tier: item.tier,
          outcome: item.outcome,
          reasonCode: safeCode(item.reasonCode),
          frozen: item.frozen,
          candidateIds: Array.isArray(item.candidateIds)
            ? item.candidateIds.slice(0, 48).flatMap((id) => identifier(id, 'candidate') ? [identifier(id, 'candidate')!] : [])
            : [],
          ...(count(item.durationMs, 86_400_000) !== undefined ? { durationMs: count(item.durationMs, 86_400_000)! } : {}),
        }];
      })
    : [];
  const terminal = record(receipt.terminalOutcome);
  const safeTerminal = terminal && typeof terminal.kind === 'string' && terminalKinds.has(terminal.kind)
    && typeof terminal.origin === 'string' && origins.has(terminal.origin)
    ? {
        kind: terminal.kind,
        origin: terminal.origin,
        reasonCode: safeCode(terminal.reasonCode),
        ...(typeof terminal.safeAction === 'string' ? { safeAction: safeCode(terminal.safeAction) } : {}),
      }
    : undefined;
  const outcome = record(receipt.outcome);
  const safeOutcome = outcome && typeof outcome.connectionAttempted === 'boolean'
    && typeof outcome.narration === 'string' && narrations.has(outcome.narration)
    ? {
        connectionAttempted: outcome.connectionAttempted,
        executionAttempts: count(outcome.executionAttempts) ?? 0,
        factCount: count(outcome.factCount) ?? 0,
        narration: outcome.narration,
      }
    : { connectionAttempted: false, executionAttempts: 0, factCount: 0, narration: 'not_retained' };
  const semanticRuntime = record(receipt.semanticRuntime);
  const safeSemanticRuntime = semanticRuntime
    && semanticRuntime.version === 1
    && typeof semanticRuntime.preference === 'string'
    && (semanticRuntime.preference === 'auto' || semanticEngines.has(semanticRuntime.preference))
    && typeof semanticRuntime.readiness === 'string'
    && (semanticRuntime.readiness === 'ready' || semanticRuntime.readiness === 'unavailable')
    && (semanticRuntime.selectedEngine === undefined
      || (typeof semanticRuntime.selectedEngine === 'string' && semanticEngines.has(semanticRuntime.selectedEngine)))
    ? {
        version: 1,
        preference: semanticRuntime.preference,
        ...(typeof semanticRuntime.selectedEngine === 'string' ? { selectedEngine: semanticRuntime.selectedEngine } : {}),
        readiness: semanticRuntime.readiness,
      }
    : undefined;
  return {
    version: 8,
    mode: receipt.mode,
    turnClass: receipt.turnClass,
    ...(identifier(receipt.snapshotId, 'snapshot') ? { snapshotId: identifier(receipt.snapshotId, 'snapshot') } : {}),
    retainedCandidateCount: count(receipt.retainedCandidateCount) ?? 0,
    initialCandidateCount: count(receipt.initialCandidateCount) ?? 0,
    expansionCount: count(receipt.expansionCount) ?? 0,
    objective: typeof receipt.objective === 'string' && turns.has(receipt.objective) ? receipt.objective : receipt.turnClass,
    contextCoverage,
    excludedCandidateCount: count(receipt.excludedCandidateCount) ?? 0,
    exclusionReasonCodes: Array.isArray(receipt.exclusionReasonCodes) ? receipt.exclusionReasonCodes.slice(0, 8).map(safeCode) : [],
    observations,
    tierAttempts,
    ...(typeof receipt.controllerTier === 'string' && tiers.has(receipt.controllerTier)
      ? { controllerTier: receipt.controllerTier }
      : {}),
    ...(safeSemanticRuntime ? { semanticRuntime: safeSemanticRuntime } : {}),
    planFrozen: receipt.planFrozen === true,
    ...(safeTerminal ? { terminalOutcome: safeTerminal } : {}),
    outcome: safeOutcome,
    toolDurationMs: count(receipt.toolDurationMs, 86_400_000) ?? 0,
    finalStopReason: safeCode(receipt.finalStopReason),
  };
}

/**
 * V6 adds the short reader-facing decision path to V5.  Keep the portable
 * shape deliberately narrower than the persisted receipt: a support bundle
 * needs counts, enum outcomes, and pseudonymous identity fingerprints, never
 * raw requirements, member values, candidate lifecycle prose, or answer text.
 */
function portableRuntimeReceiptV6(value: unknown, profile: AskTraceExportProfileV1, salt: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  if (receipt.version !== 6 || typeof receipt.runId !== 'string') return undefined;
  const record = (candidate: unknown): Record<string, unknown> | undefined =>
    candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as Record<string, unknown> : undefined;
  // The V5 projection is an explicit allowlist for all inherited fields. Do
  // not copy V6 state/workspace wholesale merely because it extends V5.
  const base = portableRuntimeReceiptV5({ ...receipt, version: 5 }, profile, salt);
  if (!base) return undefined;
  const planning = record(receipt.planning);
  const allowedModes = new Set(['exact_fast_path', 'initial_planner', 'targeted_revision', 'deterministic_binding']);
  const allowedVerification = new Set(['valid', 'needs_targeted_context', 'ambiguous', 'denied', 'invalid']);
  const allowedStages = new Set(['retrieval', 'role_coverage', 'planner', 'verification', 'targeted_recovery', 'cascade', 'freeze', 'connection', 'execution', 'facts']);
  const allowedStatuses = new Set(['completed', 'skipped', 'blocked', 'unavailable']);
  const allowedRoles = new Set(['metric', 'entity_key', 'entity_label', 'categorical_dimension', 'time_dimension', 'member', 'relationship', 'context']);
  const allowedTiers = new Set(['certified', 'semantic', 'governed_relational', 'exploratory_sql', 'clarify_or_gap']);
  const allowedTierOutcomes = new Set(['executable', 'ineligible', 'unavailable', 'ambiguous', 'denied']);
  const allowedBoundaries = new Set(['plan.compile', 'semantic.compile', 'sql.authorize', 'sql.execute', 'provider', 'cascade', 'run']);
  const allowedOrigins = new Set(['internal_invariant', 'governance_gate', 'semantic_compiler', 'plan_compiler', 'provider', 'warehouse', 'unknown']);
  const allowedImpacts = new Set(['execution_not_attempted', 'execution_failed', 'answer_not_produced', 'run_cancelled']);
  const allowedActions = new Set(['export_redacted_trace', 'configure_connection', 'change_authorized_connection', 'inspect_failure', 'retry_same_plan', 'refresh_snapshot', 'edit_dql', 'open_sql_notebook', 'request_access', 'reapply_semantic_runtime', 'review_analytical_failure', 'inspect_research_failures', 'none']);
  const finiteCount = (candidate: unknown): number | undefined => typeof candidate === 'number' && Number.isFinite(candidate)
    ? Math.max(0, Math.min(10_000, Math.floor(candidate)))
    : undefined;
  const pseudonym = (candidate: unknown, kind: string) => typeof candidate === 'string'
    ? (profile === 'strict' ? pseudo(candidate, salt, kind) : candidate)
    : undefined;
  const verificationRecord = planning ? record(planning.verification) : undefined;
  const safePlanning = planning
    && planning.version === 1
    && typeof planning.mode === 'string'
    && allowedModes.has(planning.mode)
    && verificationRecord
    && verificationRecord.version === 1
    && typeof verificationRecord.status === 'string'
    && allowedVerification.has(verificationRecord.status)
    ? {
        version: 1,
        mode: planning.mode,
        ...(finiteCount(planning.plannerCalls) !== undefined ? { plannerCalls: finiteCount(planning.plannerCalls)! } : {}),
        ...(finiteCount(planning.revisionCalls) !== undefined ? { revisionCalls: finiteCount(planning.revisionCalls)! } : {}),
        verification: {
          version: 1,
          status: verificationRecord.status,
          missingRoleCount: Array.isArray(verificationRecord.missingRoles)
            ? verificationRecord.missingRoles.filter((role): role is string => typeof role === 'string').slice(0, 8).length
            : 0,
          candidateIds: Array.isArray(verificationRecord.candidateIds)
            ? verificationRecord.candidateIds
                .filter((id): id is string => typeof id === 'string')
                .slice(0, 32)
                .map((id) => pseudonym(id, 'candidate'))
            : [],
          reasonCode: typeof verificationRecord.reasonCode === 'string'
            && /^[a-z0-9_:-]{1,96}$/.test(verificationRecord.reasonCode)
            ? verificationRecord.reasonCode
            : 'unrecognized_reason',
        },
      }
    : undefined;
  const story = Array.isArray(receipt.story)
    ? receipt.story.flatMap((step) => {
        const item = record(step);
        if (!item || typeof item.stage !== 'string' || !allowedStages.has(item.stage)
          || typeof item.status !== 'string' || !allowedStatuses.has(item.status)) return [];
        return [{
          stage: item.stage,
          status: item.status,
          reasonCode: typeof item.reasonCode === 'string' && /^[a-z0-9_:-]{1,96}$/.test(item.reasonCode)
            ? item.reasonCode
            : 'unrecognized_reason',
        }];
      })
    : [];
  const roleCoverage = Array.isArray(receipt.roleCoverage)
    ? receipt.roleCoverage.flatMap((entry) => {
        const item = record(entry);
        if (!item || typeof item.role !== 'string' || !allowedRoles.has(item.role)) return [];
        const candidateCount = finiteCount(item.candidateCount);
        return candidateCount === undefined ? [] : [{
          role: item.role,
          candidateCount,
          ...(item.state === 'alternatives' || item.state === 'proven' ? { state: item.state } : {}),
        }];
      })
    : [];
  const cascade = record(receipt.cascade);
  const safeCascade = cascade && typeof cascade.planFrozen === 'boolean'
    ? {
        attempts: Array.isArray(cascade.attempts)
          ? cascade.attempts.flatMap((entry) => {
              const item = record(entry);
              if (!item || typeof item.tier !== 'string' || !allowedTiers.has(item.tier)
                || typeof item.outcome !== 'string' || !allowedTierOutcomes.has(item.outcome)
                || typeof item.planFrozen !== 'boolean') return [];
              return [{ tier: item.tier, outcome: item.outcome, planFrozen: item.planFrozen }];
            })
          : [],
        ...(typeof cascade.selectedTier === 'string' && allowedTiers.has(cascade.selectedTier) ? { selectedTier: cascade.selectedTier } : {}),
        ...(typeof cascade.stopReason === 'string' && /^[a-z0-9_:-]{1,96}$/.test(cascade.stopReason) ? { stopReason: cascade.stopReason } : {}),
        planFrozen: cascade.planFrozen,
      }
    : undefined;
  const origin = record(receipt.origin);
  const safeOrigin = origin
    && typeof origin.boundary === 'string' && allowedBoundaries.has(origin.boundary)
    && typeof origin.origin === 'string' && allowedOrigins.has(origin.origin)
    && typeof origin.impact === 'string' && allowedImpacts.has(origin.impact)
    ? { boundary: origin.boundary, origin: origin.origin, impact: origin.impact }
    : undefined;
  const connection = record(receipt.connection);
  const execution = record(receipt.execution);
  const facts = record(receipt.facts);
  const safeConnection = connection && typeof connection.attempted === 'boolean'
    ? { attempted: connection.attempted }
    : undefined;
  const executionAttempts = execution ? finiteCount(execution.attempts) : undefined;
  const safeFacts = facts ? {
    ...(finiteCount(facts.factCount) !== undefined ? { factCount: finiteCount(facts.factCount)! } : {}),
    ...(typeof facts.resultFingerprint === 'string' ? { resultFingerprint: pseudonym(facts.resultFingerprint, 'result') } : {}),
  } : undefined;
  const safeTelemetry = sanitizeTelemetry(receipt.telemetry);
  return {
    ...base,
    version: 6,
    ...(safePlanning ? { planning: safePlanning } : {}),
    roleCoverage,
    ...(safeCascade ? { cascade: safeCascade } : {}),
    ...(safeOrigin ? { origin: safeOrigin } : {}),
    ...(safeConnection ? { connection: safeConnection } : {}),
    ...(executionAttempts !== undefined ? { execution: { attempts: executionAttempts } } : {}),
    ...(safeTelemetry ? { telemetry: safeTelemetry } : {}),
    ...(safeFacts ? { facts: safeFacts } : {}),
    ...(typeof receipt.safeNextAction === 'string' && allowedActions.has(receipt.safeNextAction) ? { safeNextAction: receipt.safeNextAction } : {}),
    story,
  };
}


/**
 * Keep portable V5 parity with the full local trace without exporting raw Ask
 * state.  The V5 receipt is already content-free; strict export additionally
 * pseudonymizes fact/result/question identities while retaining its summary
 * fingerprint so a support bundle can be matched to the on-device trace.
 */
function portableRuntimeReceiptV5(value: unknown, profile: AskTraceExportProfileV1, salt: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  if (receipt.version !== 5 || typeof receipt.runId !== 'string') return undefined;
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const summary = record(receipt.summary);
  const state = record(receipt.state);
  const businessAnswer = record(receipt.businessAnswer);
  const provider = record(receipt.provider);
  const pseudonym = (value: unknown, kind: string) => typeof value === 'string'
    ? (profile === 'strict' ? pseudo(value, salt, kind) : value)
    : undefined;
  const safeSummary = summary ? {
    version: summary.version,
    summaryFingerprint: summary.summaryFingerprint,
    runtimeMode: summary.runtimeMode,
    selectedCompiler: summary.selectedCompiler,
    programTaskCount: summary.programTaskCount,
    admittedCandidateCount: summary.admittedCandidateCount,
    toolCallCount: summary.toolCallCount,
    executionAttempts: summary.executionAttempts,
  } : undefined;
  const safeState = state ? {
    version: state.version,
    mode: state.mode,
    phase: state.phase,
    questionFingerprint: pseudonym(state.questionFingerprint, 'question'),
    kind: state.kind,
    requirementCounts: state.requirementCounts,
    mission: state.mission,
    workspace: portableRuntimeWorkspaceV5(state.workspace, profile, salt),
    program: (() => {
      const program = record(state.program);
      return program ? {
        id: pseudonym(program.id, 'program'),
        taskCount: program.taskCount,
        candidateCount: program.candidateCount,
        requiredRoles: program.requiredRoles,
        outputAssertionCount: program.outputAssertionCount,
      } : undefined;
    })(),
    resolvedPlan: (() => {
      const plan = record(state.resolvedPlan);
      return plan ? {
        version: plan.version,
        programId: pseudonym(plan.programId, 'program'),
        compiler: plan.compiler,
        selectedTier: plan.selectedTier,
        planFrozen: plan.planFrozen,
        reviewRequired: plan.reviewRequired,
        planFingerprint: pseudonym(plan.planFingerprint, 'plan'),
      } : undefined;
    })(),
    counters: state.counters,
  } : undefined;
  const safeBusinessAnswer = businessAnswer ? {
    version: businessAnswer.version,
    mode: businessAnswer.mode,
    trustState: businessAnswer.trustState,
    factIds: Array.isArray(businessAnswer.factIds)
      ? businessAnswer.factIds.filter((id): id is string => typeof id === 'string').map((id) => pseudonym(id, 'fact'))
      : [],
    resultFingerprint: pseudonym(businessAnswer.resultFingerprint, 'result'),
    limitationCount: businessAnswer.limitationCount,
  } : undefined;
  const safeProvider = provider ? {
    version: provider.version,
    cause: provider.cause,
    phase: provider.phase,
    retryable: provider.retryable,
    safeAction: provider.safeAction,
    httpStatusClass: provider.httpStatusClass,
    providerFingerprint: pseudonym(provider.providerFingerprint, 'provider'),
    modelFingerprint: pseudonym(provider.modelFingerprint, 'model'),
    baseOriginFingerprint: pseudonym(provider.baseOriginFingerprint, 'origin'),
  } : undefined;
  return {
    version: 5,
    runId: pseudonym(receipt.runId, 'run'),
    ...(safeState ? { state: safeState } : {}),
    ...(safeSummary ? { summary: safeSummary } : {}),
    ...(safeBusinessAnswer ? { businessAnswer: safeBusinessAnswer } : {}),
    ...(safeProvider ? { provider: safeProvider } : {}),
    finalStopReason: receipt.finalStopReason,
  };
}

function portableRuntimeWorkspaceV5(value: unknown, profile: AskTraceExportProfileV1, salt: string): Record<string, unknown> | undefined {
  const workspace = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (!workspace) return undefined;
  const pseudoIdentifier = (value: unknown, kind: string) => typeof value === 'string'
    ? (profile === 'strict' ? pseudo(value, salt, kind) : value)
    : undefined;
  const sourceValues = new Set([
    'certified', 'semantic', 'governed_relational', 'exploratory', 'dbt_manifest', 'runtime_schema', 'vector', 'conversation', 'business_context',
  ]);
  const statuses = new Set(['available', 'empty', 'stale', 'unavailable', 'errored', 'skipped']);
  const toolKinds = new Set(['retrieve_snapshot', 'candidate_extension', 'compiler_broker', 'provider_meaning', 'execute', 'repair']);
  const toolStatuses = new Set(['completed', 'skipped', 'failed']);
  const reasonCodes = new Set([
    'snapshot_acquired', 'broker_retrieval_required', 'snapshot_retrieval_failed', 'shadow_preserves_legacy_decision',
    'meaning_resolution_completed', 'canonical_or_structured_binding', 'meaning_resolution_failed', 'meaning_resolution_unavailable',
    'execution_completed', 'execution_failed', 'repair_completed', 'repair_exhausted', 'no_compiler_selected',
  ]);
  const finiteCount = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(10_000, Math.floor(value)))
    : undefined;
  const sourceCoverage = Array.isArray(workspace.sourceCoverage)
    ? workspace.sourceCoverage.flatMap((coverage) => {
        if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) return [];
        const record = coverage as Record<string, unknown>;
        if (typeof record.source !== 'string' || !sourceValues.has(record.source)
          || typeof record.status !== 'string' || !statuses.has(record.status)) return [];
        const candidateCount = finiteCount(record.candidateCount);
        return [{ source: record.source, status: record.status, ...(candidateCount !== undefined ? { candidateCount } : {}) }];
      })
    : [];
  const tools = Array.isArray(workspace.tools)
    ? workspace.tools.flatMap((tool) => {
        if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return [];
        const record = tool as Record<string, unknown>;
        if (typeof record.id !== 'string' || typeof record.kind !== 'string' || !toolKinds.has(record.kind)
          || typeof record.status !== 'string' || !toolStatuses.has(record.status)) return [];
        return [{
          id: pseudoIdentifier(record.id, 'tool'),
          kind: record.kind,
          status: record.status,
          reasonCode: typeof record.reasonCode === 'string' && reasonCodes.has(record.reasonCode)
            ? record.reasonCode
            : 'unrecognized_reason',
        }];
      })
    : [];
  const admittedCandidateCount = finiteCount(workspace.admittedCandidateCount);
  const excludedCandidateCount = finiteCount(workspace.excludedCandidateCount);
  return {
    ...(typeof workspace.snapshotId === 'string' ? { snapshotId: pseudoIdentifier(workspace.snapshotId, 'snapshot') } : {}),
    ...(typeof workspace.sourceFingerprint === 'string' ? { sourceFingerprint: pseudoIdentifier(workspace.sourceFingerprint, 'source') } : {}),
    ...(admittedCandidateCount !== undefined ? { admittedCandidateCount } : {}),
    ...(excludedCandidateCount !== undefined ? { excludedCandidateCount } : {}),
    sourceCoverage,
    tools,
  };
}

/**
 * Receipt export is intentionally stricter than its source type: only the
 * one enumerated relationship proof requirement is portable.  This prevents a
 * future V3 field or a malformed persisted record from putting router prose,
 * question terms, or inferred SQL relationships into a support bundle.
 */
function portableTerminalRelationshipGapV1(
  value: unknown,
  profile: AskTraceExportProfileV1,
  salt: string,
): { code: 'MISSING_RELATIONSHIP'; requirement: 'certified_relationship_or_allocation_proof'; witnessCandidateIds: string[] } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.code !== 'MISSING_RELATIONSHIP' || record.requirement !== 'certified_relationship_or_allocation_proof') return undefined;
  const witnessCandidateIds = Array.isArray(record.witnessCandidateIds)
    ? [...new Set(record.witnessCandidateIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
      .sort()
      .slice(0, 32)
      .map((id) => profile === 'strict' ? pseudo(id, salt, 'candidate') : id)
    : [];
  return {
    code: 'MISSING_RELATIONSHIP',
    requirement: 'certified_relationship_or_allocation_proof',
    witnessCandidateIds,
  };
}

function sanitizeTelemetry(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const key of ['providerRoundTrips', 'toolCalls', 'sqlExecutions', 'repairs', 'egressReceipts'] as const) {
    if (typeof record[key] === 'number' && Number.isFinite(record[key])) result[key] = record[key];
  }
  return Object.keys(result).length ? result : undefined;
}

function findFingerprint(record: Record<string, unknown>, key: string): unknown {
  if (typeof record[key] === 'string') return record[key];
  const nested = record.diagnosticReceiptV3;
  if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>)[key] === 'string') return (nested as Record<string, unknown>)[key];
  return undefined;
}

function scanForProhibited(values: unknown[]): { passed: boolean; findings: string[] } {
  const source = values.map((value) => canonicalJson(value)).join('\n');
  const findings = PROHIBITED.flatMap((pattern) => pattern.test(source) ? [pattern.source] : []);
  return { passed: findings.length === 0, findings };
}

function validateTraceReceiptV1(trace: AskTraceDataV1): string[] {
  const errors: string[] = [];
  // Strict portable bundles use deterministic export-scoped pseudonyms. Live
  // receipts retain W3C identifiers. Both shapes are structurally valid.
  if (!(/^[0-9a-f]{32}$/.test(trace.envelope.traceId) || /^trace_[0-9a-f]{16}$/.test(trace.envelope.traceId))) errors.push('Invalid trace ID.');
  if (!(/^[0-9a-f]{16}$/.test(trace.envelope.rootSpanId) || /^span_[0-9a-f]{16}$/.test(trace.envelope.rootSpanId))) errors.push('Invalid root span ID.');
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  for (const span of trace.spans) {
    if (span.traceId !== trace.envelope.traceId) errors.push(`Span ${span.spanId} has a mismatched trace ID.`);
    if (ids.has(span.spanId)) errors.push(`Duplicate span ${span.spanId}.`);
    ids.add(span.spanId);
    if (ordinals.has(span.ordinal)) errors.push(`Duplicate span ordinal ${span.ordinal}.`);
    ordinals.add(span.ordinal);
    if (span.parentSpanId && !ids.has(span.parentSpanId) && !trace.spans.some((candidate) => candidate.spanId === span.parentSpanId)) errors.push(`Unknown parent span ${span.parentSpanId}.`);
  }
  if (!ids.has(trace.envelope.rootSpanId)) errors.push('Root span is missing from trace detail.');
  if (trace.envelope.firstIssueSpanId && !ids.has(trace.envelope.firstIssueSpanId)) {
    errors.push(`Unknown first issue span ${trace.envelope.firstIssueSpanId}.`);
  }
  for (const candidate of trace.candidateDecisions) {
    if (candidate.traceId !== trace.envelope.traceId) errors.push(`Candidate ${candidate.sequence} has a mismatched trace ID.`);
  }
  for (const link of trace.links) {
    const sourceIsCurrent = link.sourceTraceId === trace.envelope.traceId;
    const targetIsCurrent = link.targetTraceId === trace.envelope.traceId;
    if (!sourceIsCurrent && !targetIsCurrent) {
      errors.push(`Trace link ${link.kind} does not reference the exported trace.`);
      continue;
    }
    if (sourceIsCurrent && link.sourceRunId !== trace.envelope.runId) {
      errors.push(`Trace link ${link.kind} has a broken source run reference.`);
    }
    if (targetIsCurrent && link.targetRunId !== trace.envelope.runId) {
      errors.push(`Trace link ${link.kind} has a broken target run reference.`);
    }
  }
  const cascade = trace.spans.flatMap((span) => span.payload.kind === 'cascade' ? [{ span, decision: span.payload.decision }] : []);
  for (const { span, decision } of cascade) {
    const expected = ['certified', 'semantic', 'governed_relational', 'exploratory_sql', 'clarify_or_gap'];
    let last = -1;
    let frozen = false;
    for (const attempt of decision.attempts) {
      const position = expected.indexOf(attempt.tier);
      if (position < last) errors.push('Cascade attempts are not authoritative order.');
      last = position;
      if (frozen) errors.push('Cascade continued after plan freeze.');
      frozen ||= attempt.planFrozen;
    }
    // Exploratory selection is allowed to appear before the physical plan has
    // frozen. The initial router receipt is authoritative evidence of that
    // pre-freeze selection; a later plan.freeze span proves the only valid
    // transition. Do not rewrite the original receipt merely to make a
    // portable bundle validate, and do not accept an unrelated later freeze.
    if (
      span.name === 'cascade.evaluate'
      && decision.selectedTier === 'exploratory_sql'
      && decision.planFrozen === false
      && !hasLaterMatchingExploratoryFreeze(trace, span)
    ) {
      errors.push('Exploratory selection is not frozen.');
    }
    if (decision.terminalGap) {
      if (decision.terminalGap.code !== 'MISSING_RELATIONSHIP'
        || decision.terminalGap.requirement !== 'certified_relationship_or_allocation_proof') {
        errors.push('Unsupported terminal relationship gap receipt.');
      }
      if (!Array.isArray(decision.terminalGap.witnessCandidateIds)
        || decision.terminalGap.witnessCandidateIds.some((id) => typeof id !== 'string' || id.length === 0)) {
        errors.push('Invalid terminal relationship gap witnesses.');
      }
    }
  }
  return errors;
}

function hasLaterMatchingExploratoryFreeze(trace: AskTraceDataV1, selection: AskTraceSpanV1): boolean {
  if (selection.payload.kind !== 'cascade') return false;
  const selectedAttempt = selection.payload.decision.attempts.find((attempt) => attempt.tier === 'exploratory_sql');
  if (!selectedAttempt) return false;
  return trace.spans.some((span) => {
    if (
      span.ordinal <= selection.ordinal
      || span.name !== 'plan.freeze'
      || span.outcome !== 'ok'
      || span.reasonCode !== 'plan_frozen'
      || span.payload.kind !== 'cascade'
    ) return false;
    const frozen = span.payload.decision;
    const frozenAttempt = frozen.attempts.find((attempt) => attempt.tier === 'exploratory_sql');
    return frozen.selectedTier === 'exploratory_sql'
      && frozen.planFrozen === true
      && frozenAttempt?.planFrozen === true
      && sameCandidateIds(selectedAttempt.candidateIds, frozenAttempt.candidateIds);
  });
}

function sameCandidateIds(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function validateRunReceiptTerminalGapV1(receipt: unknown, trace: AskTraceDataV1 | undefined): string[] {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return [];
  const record = receipt as Record<string, unknown>;
  const gap = record.terminalGap;
  if (gap === undefined) return [];
  const portable = portableTerminalRelationshipGapV1(gap, 'support', 'validation');
  if (!portable) return ['Invalid run receipt terminal relationship gap.'];
  if (!trace) return ['Run receipt terminal relationship gap has no trace.'];
  const traceGap = trace.spans
    .flatMap((span) => span.payload.kind === 'cascade' ? [span.payload.decision.terminalGap] : [])
    .find((candidate) => candidate?.code === portable.code && candidate.requirement === portable.requirement);
  if (!traceGap) return ['Run receipt terminal relationship gap is not present in the trace.'];
  const expected = [...new Set(traceGap.witnessCandidateIds)].sort();
  const actual = [...new Set(portable.witnessCandidateIds)].sort();
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    return ['Run receipt terminal relationship gap witnesses do not match the trace.'];
  }
  return [];
}

function parseJsonFile(path: string, errors: string[]): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; } catch { errors.push(`Invalid JSON in ${basename(path)}.`); return undefined; }
}
