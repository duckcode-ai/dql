import { describe, expect, it } from 'vitest';
import { stampTrustLabel, trustLabelIdForAnswer } from './stamp.js';

describe('trust stamp', () => {
  it('maps certified answers and freshness qualifiers through the canonical vocabulary', () => {
    expect(trustLabelIdForAnswer({ kind: 'certified', certification: 'certified' })).toBe('certified');
    expect(stampTrustLabel({
      kind: 'certified',
      certification: 'certified',
      block: { dataState: 'failed' },
    }).display).toBe('Certified · upstream failed');
    expect(stampTrustLabel({
      kind: 'certified',
      certification: 'certified',
      block: { dataState: 'fresh' },
    }).display).toBe('Certified');
  });

  it('maps review-required generated answers to AI-Generated', () => {
    expect(stampTrustLabel({
      kind: 'uncertified',
      certification: 'ai_generated',
      reviewStatus: 'draft_ready',
    })).toMatchObject({
      id: 'ai_generated',
      display: 'AI-Generated',
    });
  });

  it('maps certified business-context answers to Reviewed', () => {
    expect(stampTrustLabel({
      kind: 'certified',
      sourceTier: 'business_context',
      reviewStatus: 'certified',
    })).toMatchObject({
      id: 'reviewed',
      display: 'Reviewed',
    });
  });

  it('maps a certified-metric semantic answer to Reviewed, not Certified', () => {
    expect(stampTrustLabel({
      kind: 'uncertified',
      sourceTier: 'semantic_layer',
      certification: 'ai_generated',
      reviewStatus: 'draft_ready',
      semanticMetricCertification: 'certified',
    })).toMatchObject({ id: 'reviewed', display: 'Reviewed' });
    // A draft/uncertified metric stays AI-Generated.
    expect(trustLabelIdForAnswer({
      kind: 'uncertified',
      sourceTier: 'semantic_layer',
      certification: 'ai_generated',
      reviewStatus: 'draft_ready',
      semanticMetricCertification: 'ai_generated',
    })).toBe('ai_generated');
  });

  it('maps refusals and unknown states to Insufficient-Context', () => {
    expect(stampTrustLabel({ kind: 'no_answer' })).toMatchObject({
      id: 'insufficient_context',
      display: 'Insufficient-Context',
    });
    expect(stampTrustLabel({ kind: 'uncertified' })).toMatchObject({
      id: 'insufficient_context',
      display: 'Insufficient-Context',
    });
  });
});
