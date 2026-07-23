/**
 * Deterministic result facts and narration guards for RFC 0005. Numeric claims
 * are copied only from validated graph outputs and every fact is bound to the
 * terminal receipt. No causal explanation is inferred from analytical rows.
 *
 * Acceptance: AGT-020.
 */

import { createHash } from 'node:crypto';
import type { AnalyticalQuestionFrameV2 } from '@duckcodeailabs/dql-core';
import type {
  AnalyticalExecutionGraphV1,
  AnalyticalExecutionReceiptV1,
} from './analytical-execution-graph.js';

export type AnalyticalResultFactKind =
  | 'scope'
  | 'metric_value'
  | 'delta'
  | 'percent_delta'
  | 'rank'
  | 'freshness'
  | 'caveat';

export interface AnalyticalResultFactV1 {
  factId: string;
  kind: AnalyticalResultFactKind;
  receiptId: string;
  graphFingerprint: string;
  resultFingerprint: string;
  outputIds: string[];
  rowIndex?: number;
  periodId?: string;
  value?: unknown;
  coordinates?: Record<string, unknown>;
  code?:
    | 'PARTIAL_CURRENT_PERIOD'
    | 'LATEST_COMPLETE_PERIOD'
    | 'MISSING_COMPARISON_VALUE'
    | 'ZERO_COMPARISON_DENOMINATOR';
  details?: Record<string, unknown>;
}

export interface AnalyticalResultFactSetV1 {
  version: 1;
  factSetId: string;
  planId: string;
  graphId: string;
  graphFingerprint: string;
  receiptId: string;
  resultFingerprint: string;
  facts: AnalyticalResultFactV1[];
}

export type BuildAnalyticalResultFactsResult =
  | { status: 'ready'; factSet: AnalyticalResultFactSetV1 }
  | {
      status: 'blocked';
      code: 'RECEIPT_MISMATCH' | 'RESULT_CONTRACT_MISMATCH';
      reason: string;
    };

export interface AnalyticalNarrativeClaimV1 {
  claimId: string;
  factIds: string[];
  text: string;
}

export interface AnalyticalNarrativeV1 {
  version: 1;
  factSetId: string;
  text: string;
  claims: AnalyticalNarrativeClaimV1[];
}

export type AnalyticalNarrativeValidationResult =
  | { status: 'valid'; citedFactIds: string[] }
  | {
      status: 'invalid';
      code: 'UNKNOWN_FACT' | 'UNSUPPORTED_NUMBER' | 'CAUSAL_CLAIM' | 'MATERIAL_CAVEAT_HIDDEN';
      reason: string;
      claimId?: string;
    };

export function buildAnalyticalResultFacts(input: {
  frame: AnalyticalQuestionFrameV2;
  graph: AnalyticalExecutionGraphV1;
  receipt: AnalyticalExecutionReceiptV1;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}): BuildAnalyticalResultFactsResult {
  const { frame, graph, receipt } = input;
  if (
    receipt.graphId !== graph.graphId ||
    receipt.graphFingerprint !== graph.fingerprint ||
    receipt.planId !== graph.planId ||
    receipt.planFingerprint !== graph.planFingerprint
  ) {
    return {
      status: 'blocked',
      code: 'RECEIPT_MISMATCH',
      reason: 'The result receipt does not bind the supplied graph and plan.',
    };
  }
  const expected = frame.requestedOutputs.map((output) => output.id);
  if (
    input.columns.length !== expected.length ||
    expected.some((outputId, index) => input.columns[index] !== outputId) ||
    input.rows.length !== receipt.rowCount ||
    input.rows.some((row) => expected.some((outputId) => !Object.prototype.hasOwnProperty.call(row, outputId)))
  ) {
    return {
      status: 'blocked',
      code: 'RESULT_CONTRACT_MISMATCH',
      reason: 'The validated rows do not match the frame output order or receipt row count.',
    };
  }
  const dimensionOutputs = frame.requestedOutputs.filter((output) => output.kind === 'dimension');
  const facts: AnalyticalResultFactV1[] = [];
  facts.push(makeFact(receipt, {
    kind: 'scope',
    outputIds: dimensionOutputs.map((output) => output.id),
    details: {
      entityGrainIds: [...frame.entityGrainIds],
      dimensions: frame.dimensions.map((dimension) => ({ ...dimension })),
      memberBindings: frame.memberBindings.map((binding) => ({
        ...binding,
        canonicalValues: [...binding.canonicalValues],
      })),
    },
  }));
  input.rows.forEach((row, rowIndex) => {
    const coordinates = Object.fromEntries(dimensionOutputs.map((output) => [output.id, row[output.id]]));
    for (const output of frame.requestedOutputs) {
      if (output.kind === 'dimension') continue;
      facts.push(makeFact(receipt, {
        kind: output.kind,
        outputIds: [output.id],
        rowIndex,
        ...(output.periodId ? { periodId: output.periodId } : {}),
        value: row[output.id],
        ...(dimensionOutputs.length ? { coordinates } : {}),
      }));
    }
    if (frame.comparison) {
      for (const periodId of frame.comparison.comparisonPeriodIds) {
        const comparisonOutput = frame.requestedOutputs.find(
          (output) => output.kind === 'metric_value' && output.periodId === periodId,
        );
        if (comparisonOutput && row[comparisonOutput.id] == null) {
          facts.push(makeFact(receipt, {
            kind: 'caveat',
            code: 'MISSING_COMPARISON_VALUE',
            outputIds: [comparisonOutput.id],
            rowIndex,
            periodId,
            ...(dimensionOutputs.length ? { coordinates } : {}),
          }));
        }
        const percentOutput = frame.requestedOutputs.find((output) => output.kind === 'percent_delta');
        if (comparisonOutput && percentOutput && isExactZero(row[comparisonOutput.id]) && row[percentOutput.id] == null) {
          facts.push(makeFact(receipt, {
            kind: 'caveat',
            code: 'ZERO_COMPARISON_DENOMINATOR',
            outputIds: [comparisonOutput.id, percentOutput.id],
            rowIndex,
            periodId,
            ...(dimensionOutputs.length ? { coordinates } : {}),
          }));
        }
      }
    }
  });
  if (frame.timeContext) {
    for (const period of frame.timeContext.periods) {
      facts.push(makeFact(receipt, {
        kind: 'freshness',
        outputIds: frame.requestedOutputs
          .filter((output) => output.periodId === period.id)
          .map((output) => output.id),
        periodId: period.id,
        value: period.end,
        details: {
          startInclusive: period.start,
          endExclusive: period.end,
          timeDimensionId: frame.timeContext.timeDimensionId,
          timeRole: frame.timeContext.timeRole,
          calendarId: frame.timeContext.calendarId,
          timezone: frame.timeContext.timezone,
          grain: frame.timeContext.grain,
          completenessPolicy: frame.timeContext.completenessPolicy,
        },
      }));
    }
    if (frame.timeContext.completenessPolicy === 'partial_current') {
      facts.push(makeFact(receipt, {
        kind: 'caveat',
        code: 'PARTIAL_CURRENT_PERIOD',
        outputIds: frame.requestedOutputs.filter((output) => output.periodId === frame.comparison?.basePeriodId || output.periodId === frame.timeContext?.periods[0]?.id).map((output) => output.id),
        details: { completenessPolicy: frame.timeContext.completenessPolicy },
      }));
    }
    if (frame.timeContext.completenessPolicy === 'latest_complete') {
      facts.push(makeFact(receipt, {
        kind: 'caveat',
        code: 'LATEST_COMPLETE_PERIOD',
        outputIds: frame.requestedOutputs.filter((output) => output.periodId === frame.comparison?.basePeriodId || output.periodId === frame.timeContext?.periods[0]?.id).map((output) => output.id),
        details: { completenessPolicy: frame.timeContext.completenessPolicy },
      }));
    }
  }
  const payload = {
    version: 1 as const,
    planId: graph.planId,
    graphId: graph.graphId,
    graphFingerprint: graph.fingerprint,
    receiptId: receipt.receiptId,
    resultFingerprint: receipt.resultFingerprint,
    facts,
  };
  return {
    status: 'ready',
    factSet: deepFreeze({
      ...payload,
      factSetId: `analytical-facts:${hash(stableStringify(payload)).slice(0, 24)}`,
    }),
  };
}

export function renderDeterministicAnalyticalNarrative(input: {
  frame: AnalyticalQuestionFrameV2;
  factSet: AnalyticalResultFactSetV1;
  maxRows?: number;
}): AnalyticalNarrativeV1 {
  const claims: AnalyticalNarrativeClaimV1[] = [];
  const outputById = new Map(input.frame.requestedOutputs.map((output) => [output.id, output]));
  const rowFacts = new Map<number, AnalyticalResultFactV1[]>();
  for (const fact of input.factSet.facts) {
    if (fact.rowIndex === undefined || fact.kind === 'caveat') continue;
    const current = rowFacts.get(fact.rowIndex) ?? [];
    current.push(fact);
    rowFacts.set(fact.rowIndex, current);
  }
  const maxRows = Math.min(Math.max(1, input.maxRows ?? 5), 20);
  for (const [rowIndex, facts] of [...rowFacts.entries()].sort(([left], [right]) => left - right).slice(0, maxRows)) {
    const coordinates = facts.find((fact) => fact.coordinates)?.coordinates ?? {};
    const coordinateText = Object.values(coordinates).map(displayValue).join(' · ');
    const values = facts
      .filter((fact) => fact.kind !== 'freshness')
      .map((fact) => {
        const outputId = fact.outputIds[0] ?? fact.kind;
        const label = humanizeOutput(outputId, outputById.get(outputId)?.kind);
        const suffix = fact.kind === 'percent_delta' && fact.value != null && fact.value !== 'not_applicable' ? '%' : '';
        return `${label}: ${displayValue(fact.value)}${suffix}`;
      });
    const text = `${coordinateText ? `${coordinateText} — ` : ''}${values.join('; ')}.`;
    claims.push({
      claimId: `claim:row:${rowIndex}`,
      factIds: facts.map((fact) => fact.factId),
      text,
    });
  }
  for (const freshness of input.factSet.facts.filter((fact) => fact.kind === 'freshness')) {
    const start = displayValue(freshness.details?.startInclusive);
    const end = displayValue(freshness.details?.endExclusive);
    const policy = String(freshness.details?.completenessPolicy ?? 'declared completeness');
    claims.push({
      claimId: `claim:freshness:${freshness.factId}`,
      factIds: [freshness.factId],
      text: `${humanizeOutput(freshness.periodId ?? 'period')} covers ${start} through ${end} under the ${policy.replace(/_/g, ' ')} policy.`,
    });
  }
  for (const caveat of input.factSet.facts.filter((fact) => fact.kind === 'caveat')) {
    claims.push({
      claimId: `claim:caveat:${caveat.factId}`,
      factIds: [caveat.factId],
      text: caveatText(caveat),
    });
  }
  const text = claims.map((claim) => claim.text).join(' ');
  return deepFreeze({ version: 1, factSetId: input.factSet.factSetId, text, claims });
}

export function validateAnalyticalNarrativeClaims(input: {
  factSet: AnalyticalResultFactSetV1;
  claims: AnalyticalNarrativeClaimV1[];
}): AnalyticalNarrativeValidationResult {
  const facts = new Map(input.factSet.facts.map((fact) => [fact.factId, fact]));
  const cited = new Set<string>();
  for (const claim of input.claims) {
    if (/\b(?:because|caused?|causing|drove|driven by|led to|resulted in|responsible for)\b/i.test(claim.text)) {
      return { status: 'invalid', code: 'CAUSAL_CLAIM', reason: 'Analytical result narration cannot infer causality.', claimId: claim.claimId };
    }
    const claimFacts = claim.factIds.flatMap((factId) => {
      const fact = facts.get(factId);
      return fact ? [fact] : [];
    });
    if (claimFacts.length !== claim.factIds.length || claimFacts.length === 0) {
      return { status: 'invalid', code: 'UNKNOWN_FACT', reason: 'Every narrative claim must cite existing result facts.', claimId: claim.claimId };
    }
    claim.factIds.forEach((factId) => cited.add(factId));
    const allowedNumbers = new Set(
      claimFacts.flatMap((fact) => numericTokens(stableStringify({
        value: fact.value,
        coordinates: fact.coordinates,
        details: fact.details,
        rowIndex: fact.rowIndex,
        periodId: fact.periodId,
      }))),
    );
    const unsupported = numericTokens(claim.text).filter((token) => !allowedNumbers.has(token));
    if (unsupported.length > 0) {
      return {
        status: 'invalid',
        code: 'UNSUPPORTED_NUMBER',
        reason: `Claim ${claim.claimId} contains unsupported numeric text: ${unsupported.join(', ')}.`,
        claimId: claim.claimId,
      };
    }
  }
  const hiddenCaveat = input.factSet.facts.find((fact) => fact.kind === 'caveat' && !cited.has(fact.factId));
  if (hiddenCaveat) {
    return {
      status: 'invalid',
      code: 'MATERIAL_CAVEAT_HIDDEN',
      reason: `Material caveat ${hiddenCaveat.code ?? hiddenCaveat.factId} is not cited by the narrative.`,
    };
  }
  return { status: 'valid', citedFactIds: [...cited].sort() };
}

function makeFact(
  receipt: AnalyticalExecutionReceiptV1,
  input: Omit<AnalyticalResultFactV1, 'factId' | 'receiptId' | 'graphFingerprint' | 'resultFingerprint'>,
): AnalyticalResultFactV1 {
  const payload = {
    ...input,
    receiptId: receipt.receiptId,
    graphFingerprint: receipt.graphFingerprint,
    resultFingerprint: receipt.resultFingerprint,
  };
  return { ...payload, factId: `fact:${hash(stableStringify(payload)).slice(0, 24)}` };
}

function caveatText(fact: AnalyticalResultFactV1): string {
  if (fact.code === 'PARTIAL_CURRENT_PERIOD') return 'The current period is partial; values may increase before it closes.';
  if (fact.code === 'LATEST_COMPLETE_PERIOD') return 'The current value uses the latest complete governed period, not a partial in-progress period.';
  if (fact.code === 'MISSING_COMPARISON_VALUE') return `A comparison value is unavailable${coordinateSuffix(fact)}.`;
  if (fact.code === 'ZERO_COMPARISON_DENOMINATOR') return `Percentage change is not available; the comparison value is zero${coordinateSuffix(fact)}.`;
  return 'The result includes a material analytical caveat.';
}

function coordinateSuffix(fact: AnalyticalResultFactV1): string {
  const coordinates = Object.values(fact.coordinates ?? {}).map(displayValue).filter(Boolean);
  return coordinates.length ? ` for ${coordinates.join(' · ')}` : '';
}

function humanizeOutput(value: string, kind?: string): string {
  if (kind === 'percent_delta') return 'change';
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return 'not available';
  if (typeof value === 'string') return value === 'not_applicable' ? 'not applicable' : value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function isExactZero(value: unknown): boolean {
  return (typeof value === 'number' && value === 0) || (typeof value === 'bigint' && value === 0n) || (typeof value === 'string' && /^[+-]?0+(?:\.0+)?$/.test(value.trim()));
}

function numericTokens(value: string): string[] {
  return value.match(/-?\d+(?:,\d{3})*(?:\.\d+)?%?/g)?.map((token) => token.replace(/,/g, '').replace(/%$/, '')) ?? [];
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
