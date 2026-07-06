import { describe, expect, it } from 'vitest';
import { shouldClarifyBeforeGeneration } from './triage.js';

describe('shouldClarifyBeforeGeneration', () => {
  it('continues past generic catalog clarify when usable context exists', () => {
    expect(shouldClarifyBeforeGeneration({
      intent: 'clarify',
      routeDecision: {
        route: 'clarify',
        missingContext: [{
          kind: 'metadata',
          severity: 'blocking',
          message: 'No certified block, semantic metric, dbt model, or runtime schema matched strongly enough to answer safely.',
        }],
      },
      allowedRelationCount: 1,
    })).toBe(false);
  });

  it('stops for explicit blocking business context gaps', () => {
    expect(shouldClarifyBeforeGeneration({
      intent: 'diagnose_change',
      routeDecision: {
        route: 'clarify',
        missingContext: [{
          kind: 'baseline',
          severity: 'blocking',
          message: 'A baseline time period is required before explaining what changed.',
        }],
      },
      allowedRelationCount: 1,
    })).toBe(true);
  });
});
