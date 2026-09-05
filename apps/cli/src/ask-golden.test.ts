import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { startLocalServer, type AskAgentRuntimeMode } from './local-runtime.js';
import { createSeededSqliteExecutor, type GoldenSeed, type SeededSqliteExecutor } from './testkit/seeded-sqlite-executor.js';

/**
 * THE GOLDEN HARNESS — does the product return the RIGHT ROWS?
 *
 * The Ask battery proves a turn ends honestly. This proves a turn is correct:
 * every question carries hand-reviewed reference SQL, the reference runs
 * against the same seeded engine the server queries, and the answer's rows
 * must equal it. Tier and trust are asserted too, because a right number
 * with a wrong badge is still a wrong answer.
 *
 * Three lanes, one file:
 *   - questions: single turns over the jaffle-golden fixture (the real
 *     jaffle-shop-duckdb metadata, a 12-customer data subset).
 *   - conversation: the five verbatim turns of the Sept 3 2026 session,
 *     through real HTTP ingress, thread persistence, retrieval, compile and
 *     execute — nothing pre-resolved, nothing injected.
 *   - reference SQL: the seed and the references agree (no server).
 *
 * Provider: replayed cassettes by default (hermetic CI). `DQL_ASK_GOLDEN_LIVE=1`
 * uses the provider configured in `DQL_ASK_GOLDEN_PROVIDER_PROJECT`'s
 * `.dql/provider-settings.json`; add `DQL_ASK_GOLDEN_RECORD=1` to (re)record.
 * `DQL_ASK_GOLDEN_MODE` selects the server's Ask runtime mode.
 * `DQL_ASK_GOLDEN_REPEAT=n` replays each case n times and requires the same
 * outcome, tier and rows every time (the stability lane).
 *
 * Baseline honesty: `baseline-known-failing.json` is consulted ONLY for the
 * legacy `authoritative_v2` mode, to document where the old runtime stands. It
 * never exempts the pipeline: under `pipeline_v3` every case must pass.
 */

type Outcome = 'rows' | 'clarify_or_rows' | 'gap' | 'conversation';
type Tier = 'certified' | 'governed' | 'any' | 'none';
interface Reference { sql: string; columns: Record<string, string[]> }
interface GoldenCase extends Reference {
  id: string; question: string; outcome?: Outcome; tier: Tier;
  identity?: string[]; keys?: string[]; ordered?: boolean; requiredColumns?: string[];
  alternatives?: Reference[]; note?: string;
  keeps?: string[]; forbids?: { route?: string; block?: string; rowCountAbove?: number; booleanBreakdown?: boolean };
}

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = resolve(here, '../test/ask-golden');
const fixtureDir = resolve(here, '../test/fixtures/jaffle-golden');
const questions = (JSON.parse(readFileSync(join(goldenDir, 'questions.json'), 'utf8')) as { questions: GoldenCase[] }).questions;
const conversation = (JSON.parse(readFileSync(join(goldenDir, 'conversation.json'), 'utf8')) as { turns: GoldenCase[] }).turns;
const seed = JSON.parse(readFileSync(join(fixtureDir, 'seeds', 'seed.json'), 'utf8')) as GoldenSeed;

const LIVE = process.env.DQL_ASK_GOLDEN_LIVE === '1';
const RECORD = process.env.DQL_ASK_GOLDEN_RECORD === '1';
const REPEAT = Math.max(1, Number(process.env.DQL_ASK_GOLDEN_REPEAT ?? '1') || 1);
/** `DQL_ASK_GOLDEN_KEEP=1` leaves the temporary project (and its run/trace stores) on disk for inspection. */
const KEEP = process.env.DQL_ASK_GOLDEN_KEEP === '1';
const MODE = process.env.DQL_ASK_GOLDEN_MODE as AskAgentRuntimeMode | undefined;
const PROVIDER_PROJECT = process.env.DQL_ASK_GOLDEN_PROVIDER_PROJECT ?? '/Users/Kranthi_1/jaffle-shop-duckdb';
/** Comma-separated question ids to run alone (debugging a failure); empty runs everything. */
const ONLY = new Set((process.env.DQL_ASK_GOLDEN_ONLY ?? '').split(',').map((id) => id.trim()).filter(Boolean));
const selected = <T extends { id: string }>(items: T[]): T[] => (ONLY.size ? items.filter((item) => ONLY.has(item.id)) : items);
const CASSETTES = join(fixtureDir, 'test-cassettes', 'golden');
const INFRASTRUCTURE = /\b(provider|dispatch(es)?|budget|orchestration|snapshot|closure|kernel|tool path|retry)\b/i;
const knownFailing: Record<string, string> = existsSync(join(goldenDir, 'baseline-known-failing.json'))
  ? JSON.parse(readFileSync(join(goldenDir, 'baseline-known-failing.json'), 'utf8')) as Record<string, string>
  : {};

// ── build identity ──────────────────────────────────────────────────────────
function buildIdentity(): Record<string, string> {
  const root = resolve(here, '../../..');
  const git = (command: string) => { try { return execSync(command, { cwd: root, encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };
  const sha = git('git rev-parse HEAD');
  const dirty = git('git status --porcelain -- apps/cli/src packages/dql-agent/src packages/dql-core/src');
  const diff = git('git diff -- apps/cli/src packages/dql-agent/src packages/dql-core/src');
  const content = createHash('sha256').update(sha).update(dirty).update(diff).digest('hex').slice(0, 16);
  return { commit: sha, dirty: dirty ? 'true' : 'false', contentFingerprint: content, mode: MODE ?? 'default', provider: LIVE ? `live:${PROVIDER_PROJECT}` : 'cassette-replay', fixture: 'jaffle-golden' };
}

// ── row comparison ──────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
const norm = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');

function findColumn(actualColumns: string[], candidates: string[]): string | undefined {
  const wanted = candidates.map(norm);
  const exact = actualColumns.find((column) => wanted.includes(norm(column)));
  if (exact) return exact;
  // `order_id__customer` carries `customer`; `customer__customer_name` carries `customer_name`.
  return actualColumns.find((column) => wanted.some((candidate) => norm(column).endsWith(candidate) && candidate.length >= 4));
}

function sameValue(expected: unknown, actual: unknown): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined || actual === '';
  if (typeof expected === 'number') {
    const value = typeof actual === 'number' ? actual : Number(actual);
    if (!Number.isFinite(value)) return false;
    return Math.abs(value - expected) <= Math.max(0.011, Math.abs(expected) * 1e-6);
  }
  if (typeof expected === 'boolean') return actual === expected || actual === (expected ? 1 : 0) || String(actual).toLowerCase() === String(expected);
  const left = String(expected).trim().toLowerCase();
  const right = String(actual ?? '').trim().toLowerCase();
  if (left === right) return true;
  // Dates: compare the calendar day when both sides carry one.
  const day = /^\d{4}-\d{2}-\d{2}/;
  if (day.test(left) && day.test(right)) return left.slice(0, 10) === right.slice(0, 10);
  return false;
}

interface RowMatch { ok: boolean; reason?: string; mapped?: Record<string, string> }

function matchReference(reference: Reference, spec: GoldenCase, actualColumns: string[], actualRows: Row[]): RowMatch {
  const mapped: Record<string, string> = {};
  const identity = new Set(spec.identity ?? []);
  for (const [name, aliases] of Object.entries(reference.columns)) {
    const found = findColumn(actualColumns, [name, ...aliases]);
    if (found) mapped[name] = found;
    else if (!identity.has(name)) return { ok: false, reason: `column ${name} (aliases ${aliases.join(', ')}) not in result columns ${actualColumns.join(', ')}` };
  }
  if (identity.size > 0 && ![...identity].some((name) => mapped[name])) {
    return { ok: false, reason: `no identity column among ${[...identity].join(', ')} in ${actualColumns.join(', ')}` };
  }
  for (const required of spec.requiredColumns ?? []) {
    if (!mapped[required]) return { ok: false, reason: `required column ${required} missing from ${actualColumns.join(', ')}` };
  }
  const expectedRows = executor!.query(reference.sql);
  if (expectedRows.length !== actualRows.length) {
    return { ok: false, reason: `expected ${expectedRows.length} rows, got ${actualRows.length}`, mapped };
  }
  const compareRow = (expected: Row, actual: Row) => Object.entries(mapped).every(([name, column]) => sameValue(expected[name], actual[column]));
  if (spec.ordered) {
    for (let index = 0; index < expectedRows.length; index += 1) {
      if (!compareRow(expectedRows[index]!, actualRows[index]!)) {
        return { ok: false, reason: `row ${index} differs: expected ${JSON.stringify(expectedRows[index])}, got ${JSON.stringify(actualRows[index])}`, mapped };
      }
    }
    return { ok: true, mapped };
  }
  const remaining = [...actualRows];
  for (const expected of expectedRows) {
    const at = remaining.findIndex((actual) => compareRow(expected, actual));
    if (at < 0) return { ok: false, reason: `no row matches ${JSON.stringify(expected)}`, mapped };
    remaining.splice(at, 1);
  }
  return { ok: true, mapped };
}

function matchAny(spec: GoldenCase, actualColumns: string[], actualRows: Row[]): RowMatch {
  const references: Reference[] = [{ sql: spec.sql, columns: spec.columns }, ...(spec.alternatives ?? [])];
  let last: RowMatch = { ok: false, reason: 'no reference' };
  for (const reference of references) {
    last = matchReference(reference, spec, actualColumns, actualRows);
    if (last.ok) return last;
  }
  return last;
}

// ── the server ──────────────────────────────────────────────────────────────
let executor: SeededSqliteExecutor | undefined;
interface Harness { base: string; root: string; server?: Server }
let harness: Harness | undefined;
const report: Record<string, unknown>[] = [];

async function startGolden(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'dql-ask-golden-'));
  cpSync(fixtureDir, root, { recursive: true });
  rmSync(join(root, '.dql'), { recursive: true, force: true });
  rmSync(join(root, 'test-cassettes'), { recursive: true, force: true });
  if (LIVE) {
    mkdirSync(join(root, '.dql'), { recursive: true });
    for (const file of ['provider-settings.json', 'oauth-credentials.json']) {
      const source = join(PROVIDER_PROJECT, '.dql', file);
      if (existsSync(source)) cpSync(source, join(root, '.dql', file));
    }
  }
  if (!process.env.DQL_EVAL_CASSETTE_DIR) {
    mkdirSync(CASSETTES, { recursive: true });
    process.env.DQL_EVAL_CASSETTE_DIR = CASSETTES;
    process.env.DQL_EVAL_CASSETTE_MODE = LIVE ? (RECORD ? 'record' : 'live') : 'replay';
  }
  executor = createSeededSqliteExecutor(seed);
  let server: Server | undefined;
  const port = await startLocalServer({
    rootDir: root,
    projectRoot: root,
    executor,
    connection: { driver: 'sqlite', filepath: ':memory:' },
    ...(MODE ? { askAgentRuntimeMode: MODE } : {}),
    preferredPort: 0,
    captureServer: (created) => { server = created; },
  });
  return { base: `http://127.0.0.1:${port}`, root, get server() { return server; } };
}

async function ask(question: string, threadId?: string) {
  const response = await fetch(`${harness!.base}/api/agent-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, requestedMode: 'ask', ...(threadId ? { threadId } : {}) }),
  });
  const payload = await response.json() as { run: any; error?: unknown };
  return { status: response.status, run: payload.run, raw: payload };
}

async function createThread(): Promise<string> {
  const response = await fetch(`${harness!.base}/api/agent/threads`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ surface: 'notebook', title: 'golden' }),
  });
  const payload = await response.json() as { thread: { id: string } };
  return payload.thread.id;
}

const answerArtifact = (run: any) => (run?.artifacts ?? []).find((artifact: any) => artifact?.kind === 'answer' && artifact?.payload?.result);
const resultOf = (run: any): { columns: string[]; rows: Row[] } | undefined => {
  const result = answerArtifact(run)?.payload?.result;
  if (!result || !Array.isArray(result.rows)) return undefined;
  const columns = Array.isArray(result.columns)
    ? result.columns.map((column: any) => typeof column === 'string' ? column : String(column?.name ?? ''))
    : Object.keys(result.rows[0] ?? {});
  return { columns, rows: result.rows as Row[] };
};
const executedSql = (run: any): string => (run?.artifacts ?? [])
  .map((artifact: any) => artifact?.payload?.sql ?? artifact?.payload?.result?.sql ?? artifact?.payload?.dqlArtifact?.source ?? '').join('\n');
const userText = (run: any): string => [run?.answer, run?.summary, run?.businessAnswer?.headline, run?.businessAnswer?.narrative]
  .filter((value) => typeof value === 'string').join('\n');
const trustOk = (tier: Tier, trust: string | undefined) => tier === 'none' ? true
  : tier === 'certified' ? trust === 'certified'
    : ['certified', 'governed'].includes(trust ?? '');

interface Verdict { pass: boolean; reasons: string[]; observed: Record<string, unknown> }

/** The pipeline's own receipt, when the run carries one: what it read, what it prepared, what refused. */
function pipelineObserved(run: any): Record<string, unknown> {
  const payload = (run?.artifacts ?? []).map((artifact: any) => artifact?.payload).find((p: any) => p?.askPipeline);
  const receipt = payload?.askPipeline;
  if (!receipt) return {};
  const intent = receipt.intent;
  return {
    pipeline: {
      reading: intent?.reading,
      measures: intent?.measures?.map((m: any) => `${m.ref}${m.scope?.length ? ` where ${m.scope.map((p: any) => `${p.ref} ${p.op} ${p.values.join('/')}`).join(' and ')}` : ''}`),
      groupBy: intent?.groupBy?.map((g: any) => `${g.ref}:${g.role}${g.grain ? `/${g.grain}` : ''}`),
      display: intent?.display, filters: intent?.filters?.map((p: any) => `${p.ref} ${p.op} ${p.values.join('/')}`),
      ordering: intent?.ordering, limit: intent?.limit, unresolved: intent?.unresolved,
      candidates: receipt.candidates?.map((c: any) => `${c.tier}/${c.trust}: ${c.proof?.[0]}`),
      refusals: receipt.refusals?.map((r: any) => `${r.tier}/${r.code}: ${String(r.message).slice(0, 220)}`),
      dispatches: receipt.dispatches, executed: receipt.executed, timings: receipt.timings, reuse: receipt.reuse, failure: receipt.failure, tiers: receipt.tiers,
    },
  };
}

function judge(spec: GoldenCase, run: any, run0?: any): Verdict {
  const reasons: string[] = [];
  const result = resultOf(run);
  const outcome: Outcome = spec.outcome ?? 'rows';
  const observed: Record<string, unknown> = {
    route: run?.route, status: run?.status, trust: run?.trustState, stop: run?.stopReason, answerKind: run?.answerKind,
    columns: result?.columns, rowCount: result?.rows.length, text: userText(run).slice(0, 240),
    sql: executedSql(run).replace(/\s+/g, ' ').slice(0, 400),
    providerRoundTrips: run?.telemetry?.providerRoundTrips, block: run?.diagnosticReceiptV8?.observations?.find?.((o: any) => o.tool === 'run_certified')?.candidateIds?.[0],
    steps: (run?.steps ?? []).map((step: any) => `${step.route}:${step.status}:${step.attempt ?? ''}`),
    repairAttempts: run?.repairAttempts, escalationAttempts: run?.escalationAttempts,
    failedEvaluations: (run?.evaluations ?? []).filter((e: any) => e && e.passed === false).map((e: any) => `${e.id}:${String(e.message).slice(0, 160)}`),
    ...pipelineObserved(run),
  };
  if (INFRASTRUCTURE.test(userText(run))) reasons.push('user text describes the machinery');
  const isClarify = run?.status === 'needs_clarification' || run?.route === 'clarify';
  const isGap = run?.status === 'blocked' || (run?.route === 'generated_answer' && !result);
  if (outcome === 'conversation') {
    if (run?.route !== 'conversation') reasons.push(`expected a conversational reply, got route ${run?.route}`);
    return { pass: reasons.length === 0, reasons, observed };
  }
  if (outcome === 'gap') {
    if (!isGap && !isClarify) reasons.push(`expected an honest gap, got ${run?.route}/${run?.status} with ${result?.rows.length ?? 0} rows`);
    return { pass: reasons.length === 0, reasons, observed };
  }
  if (outcome === 'clarify_or_rows' && isClarify) return { pass: reasons.length === 0, reasons, observed };
  if (!result) { reasons.push(`no result rows: ${run?.route}/${run?.status}/${run?.stopReason} — ${userText(run).slice(0, 200)}`); return { pass: false, reasons, observed }; }
  const match = matchAny(spec, result.columns, result.rows);
  if (!match.ok) reasons.push(`rows differ from reference: ${match.reason}`);
  if (!trustOk(spec.tier, run?.trustState)) reasons.push(`trust ${run?.trustState} does not satisfy ${spec.tier}`);
  if (spec.forbids?.route && run?.route === spec.forbids.route) reasons.push(`forbidden route ${spec.forbids.route}`);
  if (spec.forbids?.block && String(observed.block ?? '').includes(spec.forbids.block)) reasons.push(`forbidden block ${spec.forbids.block}`);
  if (spec.forbids?.rowCountAbove !== undefined && result.rows.length > spec.forbids.rowCountAbove) reasons.push(`row count ${result.rows.length} above ${spec.forbids.rowCountAbove}`);
  if (spec.forbids?.booleanBreakdown && result.columns.some((column) => /is_drink_item|is_food_item/i.test(column))) reasons.push('answered as a true/false breakdown');
  void run0;
  return { pass: reasons.length === 0, reasons, observed };
}

function record(lane: string, spec: GoldenCase, verdict: Verdict, extra: Record<string, unknown> = {}) {
  report.push({ lane, id: spec.id, question: spec.question, pass: verdict.pass, reasons: verdict.reasons, ...verdict.observed, ...extra });
}

function assertVerdict(spec: GoldenCase, verdict: Verdict) {
  const legacy = (MODE ?? 'authoritative_v2') === 'authoritative_v2';
  const documented = legacy ? knownFailing[spec.id] : undefined;
  const detail = JSON.stringify({ id: spec.id, question: spec.question, reasons: verdict.reasons, observed: verdict.observed }, null, 2);
  if (!verdict.pass && documented) {
    // Documented baseline failure of the legacy runtime. Recorded, not asserted.
    return;
  }
  if (verdict.pass && documented) {
    throw new Error(`${spec.id} is listed in baseline-known-failing.json but passed — remove the entry.\n${detail}`);
  }
  expect(verdict.pass, detail).toBe(true);
}

// ── lanes ───────────────────────────────────────────────────────────────────
describe('golden reference SQL agrees with the seed', () => {
  const local = createSeededSqliteExecutor(seed);
  it.each(questions.filter((q) => q.sql).map((q) => [q.id, q] as const))('%s reference runs and returns rows', (_id, spec) => {
    const rows = local.query(spec.sql);
    expect(rows.length, spec.sql).toBeGreaterThan(0);
    for (const alternative of spec.alternatives ?? []) expect(local.query(alternative.sql).length).toBeGreaterThan(0);
  });
  it('the seed holds Ryan Byrd and the twelve golden customers', () => {
    expect(local.query(`SELECT customer_name FROM dev.customers WHERE lower(customer_name) = 'ryan byrd'`)).toHaveLength(1);
    expect(local.query('SELECT customer_id FROM dev.customers')).toHaveLength(12);
  });
});

describe('golden harness', () => {
  beforeAll(async () => { harness = await startGolden(); }, 180_000);
  afterAll(async () => {
    await new Promise<void>((done) => harness?.server ? harness.server.close(() => done()) : done());
    if (harness && !KEEP) rmSync(harness.root, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    if (harness && KEEP) console.log(`[ask-golden] kept project root ${harness.root}`);
    const out = join(tmpdir(), 'dql-ask-golden');
    mkdirSync(out, { recursive: true });
    const file = join(out, `${new Date().toISOString().replace(/[:.]/g, '-')}-${MODE ?? 'default'}.json`);
    const passed = report.filter((entry) => entry.pass).length;
    writeFileSync(file, JSON.stringify({ build: buildIdentity(), passed, total: report.length, cases: report }, null, 2));
    // eslint-disable-next-line no-console
    console.log(`\n[ask-golden] ${passed}/${report.length} passed · report ${file}`);
  });

  describe.skipIf(selected(questions).length === 0)('questions', () => {
    it.each(selected(questions).map((q) => [q.id, q] as const))('%s returns the reference rows with the right trust', async (_id, spec) => {
      const verdicts: Verdict[] = [];
      for (let attempt = 0; attempt < REPEAT; attempt += 1) {
        const { status, run, raw } = await ask(spec.question);
        expect(status, JSON.stringify(raw).slice(0, 400)).toBe(201);
        verdicts.push(judge(spec, run));
      }
      const verdict = verdicts[0]!;
      record('questions', spec, verdict, {
        repeats: REPEAT,
        stable: verdicts.every((v) => v.pass === verdict.pass && v.observed.trust === verdict.observed.trust),
        ...(REPEAT > 1 ? { repeatObserved: verdicts.map((v) => ({ pass: v.pass, reasons: v.reasons, route: v.observed.route, status: v.observed.status, trust: v.observed.trust, rowCount: v.observed.rowCount, text: String(v.observed.text ?? '').slice(0, 300), pipeline: v.observed.pipeline })) } : {}),
      });
      if (REPEAT > 1) {
        expect(verdicts.map((v) => `${v.pass}:${v.observed.trust}:${v.observed.rowCount}`), 'unstable across repeats').toEqual(Array(REPEAT).fill(`${verdict.pass}:${verdict.observed.trust}:${verdict.observed.rowCount}`));
      }
      assertVerdict(spec, verdict);
    }, 240_000);
  });

  // Research on the pipeline: the root plans hypotheses, every analytical
  // branch is an ordinary bounded Ask through the interpreter and the host's
  // tiers, and the dossier reads their sql/result artifacts. At least one
  // branch must execute with rows; the root may end completed or reviewable.
  describe.skipIf(!LIVE || (ONLY.size > 0 && !ONLY.has('research-beverage-drivers')))('research', () => {
    it('research-beverage-drivers executes hypothesis branches through the pipeline', async () => {
      const response = await fetch(`${harness!.base}/api/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'why is beverage revenue so high? investigate the drivers by product and by customer type', requestedMode: 'research' }),
      });
      const payload = await response.json() as { run: any; error?: unknown };
      expect(response.status, JSON.stringify(payload).slice(0, 400)).toBe(201);
      const run = payload.run;
      const receipts: Array<{ state: string; verdict: string; stopReason: string; evidenceKind?: string; failure?: string }> = (run.artifacts ?? [])
        .map((artifact: any) => artifact?.payload?.researchBranchReceipts)
        .find((value: unknown) => Array.isArray(value)) ?? [];
      const detail = JSON.stringify({ status: run.status, trust: run.trustState, stop: run.stopReason, summary: run.summary, receipts }, null, 0).slice(0, 1500);
      record('research', { id: 'research-beverage-drivers', question: 'why is beverage revenue so high? investigate the drivers by product and by customer type' } as GoldenCase, {
        pass: ['completed', 'needs_review'].includes(run.status) && receipts.some((receipt) => receipt.state === 'completed' && receipt.evidenceKind === 'analytical_result'),
        reasons: [], observed: { route: run.route, status: run.status, trust: run.trustState, stop: run.stopReason, text: run.answer ?? run.summary, receipts } as any,
      } as Verdict);
      expect(['completed', 'needs_review'], detail).toContain(run.status);
      expect(receipts.length, detail).toBeGreaterThan(0);
      expect(receipts.some((receipt) => receipt.state === 'completed' && receipt.evidenceKind === 'analytical_result'), detail).toBe(true);
    }, 300_000);
  });

  describe.skipIf(selected(conversation).length === 0)('the five-turn conversation', () => {
    let threadId: string;
    let previous: any;
    beforeAll(async () => { threadId = await createThread(); });
    it.each(selected(conversation).map((turn) => [turn.id, turn] as const))('%s', async (_id, spec) => {
      const { status, run, raw } = await ask(spec.question, threadId);
      expect(status, JSON.stringify(raw).slice(0, 400)).toBe(201);
      const verdict = judge(spec, run, previous);
      previous = run;
      record('conversation', spec, verdict, { threadId, keeps: spec.keeps });
      assertVerdict(spec, verdict);
    }, 240_000);
  });
});
