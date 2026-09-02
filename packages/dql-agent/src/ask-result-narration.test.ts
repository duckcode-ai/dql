import { describe, expect, it } from 'vitest';
import {
  renderAskNarrationBrief,
  verifiableNumbersFromFacts,
  verifyAskNarration,
  type AskNarrationFactSetV1,
} from './ask-result-narration.js';

/** The shape the host actually projects from an executed governed result. */
const factSet: AskNarrationFactSetV1 = {
  factSetId: 'result-facts:test',
  facts: [
    { factId: 'f1', kind: 'result_scope', details: { rowCount: 10, returnedRowCount: 10, columns: ['account_name', 'total_arr'] } },
    {
      factId: 'f2',
      kind: 'result_aggregate',
      details: {
        measureColumn: 'total_arr',
        labelColumn: 'account_name',
        total: 2465098.6,
        maximum: 274155.2,
        minimum: 191683.8,
        rowsAggregated: 10,
        leaderLabel: 'Tyrell Analytics',
        leaderShare: 0.1112,
      },
    },
    { factId: 'f3', kind: 'result_row', rowIndex: 0, values: { account_name: 'Tyrell Analytics', total_arr: 274155.2 } },
    { factId: 'f4', kind: 'result_row', rowIndex: 1, values: { account_name: 'Stark Manufacturing', total_arr: 260483.8 } },
  ],
};

describe('verifying an ordinary Ask narration against the host facts', () => {
  it('accepts a narration whose every number the host computed', () => {
    const verification = verifyAskNarration({
      text: 'Across the top 10 customer accounts, net ARR totals $2,465,098.60.'
        + ' Tyrell Analytics leads with $274,155.20, 11.1% of that total, ahead of Stark Manufacturing at $260,483.80.',
      factSet,
    });
    expect(verification).toMatchObject({ ok: true, failures: [] });
  });

  it('accepts a share stated as a percentage though the host stores a fraction', () => {
    // leaderShare is 0.1112 and every human answer says 11.1%. Rejecting the
    // percentage form threw away otherwise perfect narration over a unit
    // convention, so the equivalence is explicit — and only for share-named
    // fields, never for an arbitrary hundredfold restatement of revenue.
    expect(verifiableNumbersFromFacts(factSet).has('11.10')).toBe(true);
    expect(verifiableNumbersFromFacts(factSet).has('246509860.00')).toBe(false);
  });

  it('rejects a number no fact supports, however plausible', () => {
    const verification = verifyAskNarration({
      text: 'Net ARR totals $2,465,098.60 across the top 10, up 14% on the prior quarter.',
      factSet,
    });
    expect(verification.ok).toBe(false);
    expect(verification.failures).toContain('UNVERIFIED_NUMBER');
    expect(verification.unverified).toContain('14.00');
  });

  it('rejects an explanation of why, which a result cannot support', () => {
    const verification = verifyAskNarration({
      text: 'Net ARR totals $2,465,098.60 because Tyrell Analytics renewed early.',
      factSet,
    });
    expect(verification.failures).toContain('CAUSAL_CLAIM');
  });

  it('rejects a claim of absence, which a bounded top-N never proves', () => {
    const verification = verifyAskNarration({
      text: 'Net ARR totals $2,465,098.60 and no other accounts contributed.',
      factSet,
    });
    expect(verification.failures).toContain('ABSENCE_CLAIM');
  });

  it('rejects an empty narration rather than shipping silence', () => {
    expect(verifyAskNarration({ text: '   ', factSet })).toMatchObject({ ok: false, failures: ['EMPTY_NARRATION'] });
  });
});

describe('the brief a narrator is given', () => {
  it('carries the facts and states a share as a percentage so nothing must be derived', () => {
    const brief = renderAskNarrationBrief({ question: 'top 10 customer accounts by net arr', factSet });
    expect(brief).toContain('top 10 customer accounts by net arr');
    expect(brief).toContain('total=2465098.6');
    expect(brief).toContain('leaderShare=11.1%');
    expect(brief).toContain('Tyrell Analytics');
  });

  it('never carries anything but the facts it was given', () => {
    const brief = renderAskNarrationBrief({ question: 'q', factSet });
    // The row facts ARE the host's own bounded projection; what must never
    // appear is a result payload the caller did not put in the fact set.
    expect(brief).not.toContain('executionReceipt');
    expect(brief).not.toContain('sql');
  });
});
