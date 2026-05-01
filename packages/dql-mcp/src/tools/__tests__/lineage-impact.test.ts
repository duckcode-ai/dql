import { describe, it, expect } from 'vitest';

import * as lineageImpactModule from '../lineage-impact.js';

describe('lineage-impact tool', () => {
  it('exports a callable surface', () => {
    const exported = Object.values(lineageImpactModule).filter((v) => typeof v === 'function');
    expect(exported.length).toBeGreaterThan(0);
  });
});
