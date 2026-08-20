import { describe, expect, it } from 'vitest';
import type { AnalyticalResultFactSetV1 } from './analytical-result-facts.js';
import {
  composeVerifiedAnalyticalNarrative,
  narrationMaxTokensForFacts,
} from './analytical-result-facts.js';

/**
 * A provider that RESPECTS a token ceiling, so truncation is reproducible with
 * no model. This is the contract that would have caught the live defect: the
 * reply stopped mid-word, the JSON never closed, both attempts failed
 * UNPARSEABLE_CLAIMS, and the reader got a row dump under a disclaimer.
 */
function cappedProvider(maxTokens: number) {
  const calls: number[] = [];
  return {
    calls,
    complete: async ({ user }: { system: string; user: string }) => {
      const factIds = [...user.matchAll(/fact:[0-9a-f]+/g)].map((match) => match[0]);
      // Realistic prose: the live narration named every customer and value
      // ("Wesley Jenkins with 2004, Benjamin Bell with 1983, ..."), which is
      // what pushed the reply past the ceiling. Terse output would not
      // reproduce the defect.
      const reply = JSON.stringify({
        claims: [{
          claimId: 'c1',
          factIds,
          text: `The top customers by revenue are ${
            factIds.map((_, i) => `Customer ${i} with ${100 + i}`).join(', ')
          }.`,
        }],
      });
      calls.push(reply.length);
      // ~1.75 characters per token, NOT the usual ~4. Measured from the live
      // failure: a 350-token ceiling produced exactly 606 characters, because
      // a fact id is a long hex string and hex tokenizes close to one token per
      // two characters. Using the optimistic ratio here would make the reply
      // fit and the regression would not reproduce.
      return reply.slice(0, Math.floor(maxTokens * 1.75));
    },
  };
}

function factSetOf(rowCount: number): AnalyticalResultFactSetV1 {
  return {
    version: 1, factSetId: 'fs', planId: 'p', graphId: 'g',
    graphFingerprint: 'gf', receiptId: 'r', resultFingerprint: 'rf',
    facts: Array.from({ length: rowCount }, (_, i) => ({
      factId: `fact:${'0123456789abcdef'.repeat(2)}${i}`,
      kind: 'cell', receiptId: 'r', graphFingerprint: 'gf', resultFingerprint: 'rf',
      outputIds: ['revenue'], rowIndex: i, value: 100 + i,
      coordinates: { customer_name: `Customer ${i}` },
    })),
  } as AnalyticalResultFactSetV1;
}

const frame = {
  version: 2,
  question: 'top customers by revenue',
  requestedOutputs: [{ id: 'revenue', label: 'Revenue', kind: 'measure' }],
} as never;

describe('narration survives its own contract at every result size', () => {
  it('FAILS at the old flat ceiling for a ten-row result', async () => {
    // The regression under test. 350 tokens could not hold ten long hex fact
    // ids plus prose, so the JSON never closed.
    const provider = cappedProvider(350);
    const composed = await composeVerifiedAnalyticalNarrative({
      frame, factSet: factSetOf(11), question: 'top customers',
      complete: provider.complete,
    });
    expect(composed.source).toBe('deterministic');
    expect(composed.validationFailures).toContain('UNPARSEABLE_CLAIMS');
  });

  it('SURVIVES at the scaled ceiling for the same result', async () => {
    const provider = cappedProvider(narrationMaxTokensForFacts(11));
    const composed = await composeVerifiedAnalyticalNarrative({
      frame, factSet: factSetOf(11), question: 'top customers',
      complete: provider.complete,
    });
    expect(composed.source).toBe('llm');
    expect(composed.validationFailures).not.toContain('UNPARSEABLE_CLAIMS');
  });

  it('survives a one-row result, which the old ceiling also handled', async () => {
    const provider = cappedProvider(narrationMaxTokensForFacts(1));
    const composed = await composeVerifiedAnalyticalNarrative({
      frame, factSet: factSetOf(1), question: 'top customer',
      complete: provider.complete,
    });
    expect(composed.source).toBe('llm');
  });

  it('survives a high-fact result near the ceiling', async () => {
    const provider = cappedProvider(narrationMaxTokensForFacts(30));
    const composed = await composeVerifiedAnalyticalNarrative({
      frame, factSet: factSetOf(30), question: 'top customers',
      complete: provider.complete,
    });
    expect(composed.source).toBe('llm');
  });

  it('falls back deterministically rather than emitting truncated JSON', async () => {
    const provider = cappedProvider(120);
    const composed = await composeVerifiedAnalyticalNarrative({
      frame, factSet: factSetOf(11), question: 'top customers',
      complete: provider.complete,
    });
    // Correct behaviour under a genuinely too-small ceiling: never ship half a
    // sentence as if it were the answer.
    expect(composed.source).toBe('deterministic');
    expect(composed.narrative.text).not.toContain('{"claims"');
  });
});
