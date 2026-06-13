import { describe, it, expect } from 'vitest';

import * as kgModule from '../kg.js';

describe('kg tool', () => {
  it('exports a callable surface', () => {
    const exported = Object.values(kgModule).filter((v) => typeof v === 'function');
    expect(exported.length).toBeGreaterThan(0);
  });

  it('accepts business context node kind filters', () => {
    expect(() => kgModule.kgSearchInput.kinds.parse([
      'term',
      'business_view',
      'measure',
      'semantic_model',
      'saved_query',
      'notebook',
    ])).not.toThrow();
  });
});
