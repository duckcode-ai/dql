/**
 * The analyst loop — explore, then compose, with provenance enforced.
 *
 * This is the handler the strangler seam has been holding a slot for. It runs
 * the governed tools, harvests every identifier a tool actually returned, and
 * refuses to execute SQL naming anything it did not observe. A violation comes
 * back as a CORRECTION with the nearest observed name and one bounded retry —
 * not a refusal, which is what the legacy pipeline turned it into.
 *
 * It is deliberately small. The legacy loop earned its 10k lines by owning
 * retrieval, certified matching, semantic compilation, narration, and trust
 * labelling; re-implementing any of that here would fork behaviour that already
 * works. This owns exactly one thing the old path cannot do: notice that a
 * proposed identifier was never observed, and say which real one was meant.
 */
import type { AgentAnswer, AnswerLoopInput } from '../answer-loop.js';
import type { AgentToolDefinition } from '../providers/types.js';
import type { AnalystTurnPlan } from './turn-plan.js';
import { runAgenticToolLoop } from './tool-loop.js';
import { IdentifierLedger } from './identifier-ledger.js';
import { ANALYST_TOOL_POLICY, adjudicateProposedSql, withLedgerHarvest } from './ledger-tools.js';

/** One observable step, so the wait is legible instead of a spinner. */
export interface AnalystStep {
  kind: 'plan' | 'tool' | 'observe' | 'verify' | 'answer';
  label: string;
  detail?: string;
}

export interface AnalystLoopDeps {
  /** Extract relations/columns from candidate SQL. Injected so the loop does not fork a parser. */
  extractReferences: (sql: string) => { relations: string[]; columns: string[] };
  /** Turn raw model output into SQL. Injected for the same reason. */
  parseSql: (raw: string) => string | undefined;
  /** Tools the model may call. Already surface-filtered by the host. */
  tools: AgentToolDefinition[];
  /**
   * Run the deterministic safety verifiers over candidate SQL and return a
   * correction, or `undefined` when it passes.
   *
   * The verifiers keep their logic — aggregation safety, grain, relationship
   * proof — but a failure becomes an OBSERVATION the loop can act on instead of
   * a terminal refusal. That inversion is the point: the legacy path turned
   * "this would double-count" into "nothing was executed", which is true and
   * useless. Telling the model that joining those tables fans out is something
   * it can fix.
   */
  verifySql?: (sql: string) => string | undefined;
  maxIterations: number;
  /**
   * Optional structured planning call. Absent, the loop runs exactly as before
   * and the trace falls back to a fixed label.
   */
  planTurn?: (question: string, toolNames: string[]) => Promise<AnalystTurnPlan | undefined>;
  onStep?: (step: AnalystStep) => void;
}

export interface AnalystOutcome {
  sql?: string;
  /** Identifiers the run proved, for the audit trail. */
  admitted: string[];
  /** Corrections fed back to the model, in order. */
  corrections: string[];
  /** Why the loop stopped. */
  stop: 'composed' | 'no_sql' | 'unverified';
}

/**
 * Run explore-then-compose and return verified SQL.
 *
 * Returns `stop: 'unverified'` rather than throwing when the repair budget is
 * spent: the caller decides whether an unverified draft is still worth showing
 * as review-required, and that is a governance choice, not this loop's.
 */
export async function runAnalystLoop(
  input: AnswerLoopInput,
  deps: AnalystLoopDeps,
): Promise<AnalystOutcome> {
  const ledger = new IdentifierLedger();
  const corrections: string[] = [];

  // Seed from the context pack. These are retrieved, not observed, so they enter
  // at the weakest tier — enough to let correct SQL through without pretending a
  // catalog row proves a column exists in the warehouse.
  for (const object of input.contextPack?.allowedSqlContext?.relations ?? []) {
    ledger.admit('catalog', [object.relation, object.name], 'context_pack');
    ledger.admit('catalog', (object.columns ?? []).map((column) => column.name), 'context_pack');
  }

  const tools = withLedgerHarvest(deps.tools, ledger, (event) => {
    deps.onStep?.({
      kind: 'observe',
      label: `${event.tool} returned ${event.admitted} identifier${event.admitted === 1 ? '' : 's'}`,
    });
  });

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: ANALYST_TOOL_POLICY },
    { role: 'user', content: input.question },
  ];

  // One structured planning call before acting. It is optional by design:
  // `planAnalystTurn` swallows its own failures, so a slow or unparseable plan
  // costs a bounded wait and nothing else. What it buys is a trace that names
  // what the agent is about to verify instead of a fixed string.
  const turnPlan = deps.planTurn
    ? await deps.planTurn(input.question, tools.map((tool) => tool.name))
    : undefined;
  if (turnPlan) {
    deps.onStep?.({ kind: 'plan', label: turnPlan.restatement });
    for (const item of turnPlan.mustEstablish) {
      deps.onStep?.({ kind: 'plan', label: `Must establish: ${item}` });
    }
    // Carry the plan into the loop so it steers the run rather than only
    // describing it — otherwise the trace would promise work the model never
    // agreed to do.
    messages.push({
      role: 'assistant' as const,
      content: `Before answering I must establish, using tools:\n${
        turnPlan.mustEstablish.map((item) => `- ${item}`).join('\n')
      }${turnPlan.openingTool ? `\nStarting with ${turnPlan.openingTool}.` : ''}`,
    });
  } else {
    deps.onStep?.({ kind: 'plan', label: 'Establishing what exists before writing SQL' });
  }

  let raw = await runAgenticToolLoop(input.provider, messages, tools, {
    ...(input.signal ? { signal: input.signal } : {}),
    maxToolCalls: deps.maxIterations,
  });
  let sql = deps.parseSql(raw);
  if (!sql) return { admitted: ledger.entries().map((e) => e.identifier), corrections, stop: 'no_sql' };

  // One bounded repair. A second would mostly re-spend the budget: if the first
  // correction — which names the exact identifier that was observed — does not
  // land, the problem is not a typo.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    deps.onStep?.({ kind: 'verify', label: 'Checking every identifier was actually observed' });
    const verdict = adjudicateProposedSql(ledger, deps.extractReferences(sql));
    // Identifiers first: a safety verdict over SQL naming a column that does not
    // exist is noise, and would send the model chasing the wrong correction.
    const safety = verdict.ok ? deps.verifySql?.(sql) : undefined;
    if (verdict.ok && !safety) {
      deps.onStep?.({ kind: 'answer', label: 'Verified — every name came from a tool result' });
      return { sql, admitted: ledger.entries().map((e) => e.identifier), corrections, stop: 'composed' };
    }
    const correction = verdict.ok ? safety! : verdict.correction;
    corrections.push(correction);
    if (attempt === 1) break;
    deps.onStep?.({
      kind: 'tool',
      label: verdict.ok ? 'Correcting an unsafe aggregation' : 'Correcting an unobserved identifier',
      detail: verdict.ok ? safety : verdict.unadmitted.join(', '),
    });
    raw = await runAgenticToolLoop(
      input.provider,
      [...messages, { role: 'assistant' as const, content: raw }, { role: 'user' as const, content: correction }],
      tools,
      {
        ...(input.signal ? { signal: input.signal } : {}),
        maxToolCalls: deps.maxIterations,
      },
    );
    const repaired = deps.parseSql(raw);
    if (!repaired) break;
    sql = repaired;
  }

  return { sql, admitted: ledger.entries().map((e) => e.identifier), corrections, stop: 'unverified' };
}

/**
 * Wrap the loop as a lane handler, falling back to the legacy answer loop.
 *
 * The legacy loop still produces the ANSWER — trust labels, citations,
 * narration, execution. This only decides whether the SQL that reaches it was
 * built from observed identifiers. Handing verified SQL to a path that already
 * knows how to govern it is a much smaller change than replacing that path.
 */
export function createAnalystLaneHandler(deps: {
  legacy: (input: AnswerLoopInput) => Promise<AgentAnswer>;
  buildDeps: (input: AnswerLoopInput) => AnalystLoopDeps | undefined;
}) {
  return async (input: AnswerLoopInput): Promise<AgentAnswer> => {
    const loopDeps = deps.buildDeps(input);
    // No tools, no provider, or a host that cannot parse SQL: there is nothing
    // this loop can add, so do not pay for it.
    if (!loopDeps || loopDeps.tools.length === 0) return deps.legacy(input);

    const outcome = await runAnalystLoop(input, loopDeps);
    if (process.env.DQL_ORCHESTRATOR_TRACE) {
      console.warn(`[dql] analyst loop outcome: stop=${outcome.stop} sql=${outcome.sql ? 'yes' : 'no'} admitted=${outcome.admitted.length} corrections=${outcome.corrections.length}`);
    }
    const answer = await deps.legacy(
      outcome.stop === 'composed' && outcome.sql
        ? { ...input, extraContext: [input.extraContext, analystContext(outcome)].filter(Boolean).join('\n\n') }
        : input,
    );
    // ALWAYS record the verdict, not only when a correction was needed. A
    // verification that passed is precisely what an audit wants to see, and a
    // loop that is invisible when it works cannot be told apart from one that
    // never ran — the same silent-degradation trap the fallback marker avoids.
    return withAnalystEvidence(answer, outcome);
  };
}

/** Hand the verified SQL to the legacy loop as context, never as an instruction. */
function analystContext(outcome: AnalystOutcome): string {
  return [
    'A bounded analyst loop verified the following SQL: every table and column in it',
    'was returned by a compile, preview, or schema tool during this turn.',
    '',
    '```sql',
    outcome.sql ?? '',
    '```',
  ].join('\n');
}

function withAnalystEvidence(answer: AgentAnswer, outcome: AnalystOutcome): AgentAnswer {
  // The host initialises `evidence` AFTER the answer call, so at this point it is
  // usually undefined. Bailing out then silently dropped the verdict on every
  // real run — the loop worked and left no trace, which is indistinguishable
  // from it never having run. Create the envelope instead of skipping.
  const evidence: NonNullable<AgentAnswer['evidence']> = answer.evidence ?? {
    route: [], lineage: [], businessContext: [], selectedAssets: [],
    sourceTables: [], semanticObjects: [], citations: answer.citations ?? [],
  };
  return {
    ...answer,
    evidence: {
      ...evidence,
      route: [
        ...(evidence.route ?? []),
        {
          tool: 'identifier_ledger',
          // 'checked' not 'ok': the ledger VERIFIED the identifiers, it did not
          // select the route or execute anything.
          status: outcome.stop === 'composed' ? ('checked' as const) : ('failed' as const),
          label: outcome.stop === 'composed'
            ? `Verified ${outcome.admitted.length} identifier(s) against tool observations`
            : outcome.stop === 'no_sql'
              ? 'The analyst loop proposed no SQL; the governed cascade answered instead'
              : 'Could not verify every identifier against a tool observation',
          ...(outcome.corrections.length > 0 ? { detail: outcome.corrections.join(' ') } : {}),
        },
      ],
    },
  };
}
