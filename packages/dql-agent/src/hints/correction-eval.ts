/**
 * Corrections become regression eval cases (W4.3).
 *
 * When an analyst corrects an answer, we already capture a scoped hint. This also
 * distills the correction into an agent-eval case so the wrong answer can never
 * silently return: the case asserts a future answer to the same question references
 * the same relations the human's corrected SQL used. Cases accumulate in the
 * project's `agent-evals/corrections.agent-evals.yml`, which `dql agent eval` reads.
 * This is the Anthropic pattern — a stakeholder correction turns into a durable test.
 */
import { analyzeSqlReferences } from '@duckcodeailabs/dql-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

export interface CorrectionEvalCase {
  name: string;
  question: string;
  expected: { sqlContains?: string[] };
}

export const CORRECTIONS_EVAL_RELATIVE_PATH = 'agent-evals/corrections.agent-evals.yml';

/**
 * Build a regression eval case from a correction: the answer to this question
 * should reference the same relations the corrected SQL used. Falls back to a
 * question-only case (no assertion) when the SQL has no parseable relations.
 */
export function buildCorrectionEvalCase(input: { question: string; correctedSql: string; name?: string }): CorrectionEvalCase {
  const analysis = analyzeSqlReferences(input.correctedSql);
  const relations = [...new Set(analysis.tables.map((table) => table.split('.').at(-1) ?? table))]
    .filter(Boolean)
    .slice(0, 5);
  return {
    name: input.name ?? `correction: ${input.question.slice(0, 60)}`,
    question: input.question,
    expected: relations.length > 0 ? { sqlContains: relations } : {},
  };
}

/**
 * Append a correction eval case to the project's corrections file (creating it if
 * absent), deduped by question (latest correction wins). Best-effort; returns the path.
 */
export function appendCorrectionEvalCase(projectRoot: string, evalCase: CorrectionEvalCase): string {
  const path = join(projectRoot, CORRECTIONS_EVAL_RELATIVE_PATH);
  const cases: CorrectionEvalCase[] = [];
  if (existsSync(path)) {
    try {
      const parsed = yaml.load(readFileSync(path, 'utf8')) as { cases?: CorrectionEvalCase[] } | undefined;
      if (parsed && Array.isArray(parsed.cases)) cases.push(...parsed.cases);
    } catch {
      // Corrupt file → start fresh rather than lose the new case.
    }
  }
  const normalized = evalCase.question.trim().toLowerCase();
  const deduped = cases.filter((existing) => existing.question.trim().toLowerCase() !== normalized);
  deduped.push(evalCase);
  mkdirSync(dirname(path), { recursive: true });
  const header = '# Auto-generated regression eval cases from human corrections (W4.3).\n'
    + '# Each case asserts a future answer references the relations the correction used.\n'
    + '# Run: dql agent eval agent-evals/corrections.agent-evals.yml --execute\n';
  writeFileSync(path, header + yaml.dump({ cases: deduped }, { lineWidth: 120 }));
  return path;
}

/** Build + append a correction eval case in one call. */
export function emitCorrectionEvalCase(projectRoot: string, input: { question: string; correctedSql: string; name?: string }): string {
  return appendCorrectionEvalCase(projectRoot, buildCorrectionEvalCase(input));
}
