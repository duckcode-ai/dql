import { describe, expect, it } from 'vitest';
import { buildProvenanceFooter, type AgentAnswer } from './answer-loop.js';
import type { ResolvedTrustLabel } from '@duckcodeailabs/dql-core';

function trust(display: string): ResolvedTrustLabel {
  return { id: 'certified', base: display, severity: 'info', color: 'green', display } as ResolvedTrustLabel;
}

function answer(partial: Partial<AgentAnswer>): AgentAnswer {
  return { kind: 'answer', citations: [], considered: [], text: 'x', ...partial } as AgentAnswer;
}

describe('buildProvenanceFooter (W2.3)', () => {
  it('composes source tier, trust, owner, and freshness', () => {
    const footer = buildProvenanceFooter(
      answer({
        sourceTier: 'certified_artifact',
        block: { owner: 'analytics@example.com', dataState: 'fresh' } as AgentAnswer['block'],
      }),
      trust('Certified'),
    );
    expect(footer).toBe('Source: Certified block · Trust: Certified · Owner: analytics@example.com · Data: current');
  });

  it('surfaces a stale-data caveat for a stale certified block', () => {
    const footer = buildProvenanceFooter(
      answer({ sourceTier: 'certified_artifact', block: { dataState: 'stale' } as AgentAnswer['block'] }),
      trust('Certified'),
    );
    expect(footer).toContain('Data: stale — verify currency');
  });

  it('labels the governed semantic tier', () => {
    const footer = buildProvenanceFooter(answer({ sourceTier: 'semantic_layer' }), trust('Reviewed'));
    expect(footer).toBe('Source: Governed semantic metric · Trust: Reviewed');
  });

  it('returns undefined for a no-answer outcome', () => {
    expect(buildProvenanceFooter(answer({ kind: 'no_answer', sourceTier: 'no_answer' }), trust('n/a'))).toBeUndefined();
  });
});
