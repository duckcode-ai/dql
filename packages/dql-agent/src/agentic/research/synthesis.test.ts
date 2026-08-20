import { describe, expect, it } from 'vitest';
import { synthesizeResearchNarrative } from './synthesis.js';

const QUESTION = 'why did revenue change across product types';

describe('cross-branch research synthesis', () => {
  it('tells the story the live run discarded', () => {
    // Five hypotheses planned, five branches ran, and the reader got one fact
    // from one branch. The real answer was that one was answerable and four
    // were blocked by uncertified joins.
    const out = synthesizeResearchNarrative({
      question: QUESTION,
      branches: [
        { statement: 'Mix shifted between food and drink', produced: true, summary: 'Answered by certified block' },
        { statement: 'A few products dominate', produced: false, summary: "The join between order and product isn't certified yet" },
        { statement: 'Order volume grew broadly', produced: false, summary: "The join between order item and product isn't certified yet" },
      ],
    });
    expect(out).toContain('3 competing explanations');
    expect(out).toContain('Mix shifted between food and drink');
    expect(out).toContain('Could not be settled (2)');
    expect(out).toContain('the join it needs is not certified yet');
  });

  it('leads with the honest headline when nothing could be settled', () => {
    const out = synthesizeResearchNarrative({
      question: QUESTION,
      branches: [
        { statement: 'A', produced: false, summary: 'not bound to any modeled entity' },
        { statement: 'B', produced: false, summary: 'not bound to any modeled entity' },
      ],
    });
    expect(out).toContain('None of them could be settled');
    expect(out).toContain('it references data that is not modeled');
  });

  it('never claims a hypothesis is true, only that it was investigated', () => {
    const out = synthesizeResearchNarrative({
      question: QUESTION,
      branches: [{ statement: 'Churn drove it', produced: true, summary: 'ok' }],
    }) ?? '';
    expect(out).toContain('Investigated');
    expect(out.toLowerCase()).not.toContain('confirmed');
    expect(out.toLowerCase()).not.toContain('proves');
    expect(out.toLowerCase()).not.toContain('because churn');
  });

  it('NEVER records a branch as supporting its hypothesis', () => {
    // Rows are observation, not confirmation. Deciding whether what came back
    // matches what the hypothesis predicted needs the expectation, and nothing
    // at this layer can judge it — so the dossier may say "investigated" and
    // must never say "confirmed".
    const out = synthesizeResearchNarrative({
      question: QUESTION,
      branches: [
        { statement: 'Churn drove it', produced: true, summary: 'returned 40 rows' },
        { statement: 'Pricing drove it', produced: true, summary: 'returned 12 rows' },
      ],
    }) ?? '';
    expect(out).toContain('Investigated (2)');
    for (const word of ['supported', 'confirmed', 'proves', 'because churn', 'driven by']) {
      expect(out.toLowerCase()).not.toContain(word);
    }
  });

  it('returns nothing when there are no hypotheses to report', () => {
    expect(synthesizeResearchNarrative({ question: QUESTION, branches: [] })).toBeUndefined();
    expect(synthesizeResearchNarrative({ question: QUESTION, branches: [{ statement: '  ', produced: true }] }))
      .toBeUndefined();
  });
});
