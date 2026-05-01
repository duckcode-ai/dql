import { describe, it, expect } from 'vitest';

import * as semanticModule from '../semantic.js';

describe('semantic tool', () => {
  it('exports a callable surface', () => {
    const exported = Object.values(semanticModule).filter((v) => typeof v === 'function');
    expect(exported.length).toBeGreaterThan(0);
  });
});
