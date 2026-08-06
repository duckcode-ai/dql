import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_AREA_ID, modelAreaLocalId } from './model-area-id.js';

describe('modelAreaLocalId', () => {
  // Regression: five call sites split on '::area::', which never matches the
  // real separator, so `.at(-1)` returned the whole qualified id. That value
  // then failed the authoring layer's safe-id regex and took the entire
  // proposal down with it.
  it('returns the local id from a qualified model area id', () => {
    expect(modelAreaLocalId('commerce::model_area::core')).toBe('core');
    expect(modelAreaLocalId('commerce.sub::model_area::customer_lifecycle')).toBe('customer_lifecycle');
  });

  it('passes an already-local id through unchanged', () => {
    expect(modelAreaLocalId('core')).toBe('core');
    expect(modelAreaLocalId(DEFAULT_MODEL_AREA_ID)).toBe('core');
  });

  it('never returns a value that would fail a safe-id check', () => {
    for (const input of [
      'commerce::model_area::core',
      'commerce::model_area::a::b',
      'commerce::other::thing',
      '  commerce::model_area::spaced  ',
    ]) {
      expect(modelAreaLocalId(input)).not.toContain(':');
    }
  });

  it('treats blank and missing input as no area', () => {
    expect(modelAreaLocalId(undefined)).toBeUndefined();
    expect(modelAreaLocalId(null)).toBeUndefined();
    expect(modelAreaLocalId('')).toBeUndefined();
    expect(modelAreaLocalId('   ')).toBeUndefined();
    expect(modelAreaLocalId('commerce::model_area::')).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    expect(modelAreaLocalId('  core  ')).toBe('core');
    expect(modelAreaLocalId(' commerce::model_area::core ')).toBe('core');
  });
});
