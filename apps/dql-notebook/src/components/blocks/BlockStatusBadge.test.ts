import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as BlockStatusBadgeModule from './BlockStatusBadge';

let blockStatusColor: typeof BlockStatusBadgeModule.blockStatusColor;
let blockStatusLabel: typeof BlockStatusBadgeModule.blockStatusLabel;

describe('BlockStatusBadge helpers', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    const mod = await import('./BlockStatusBadge');
    blockStatusColor = mod.blockStatusColor;
    blockStatusLabel = mod.blockStatusLabel;
  });

  it('resolves lifecycle colors then generation colors', () => {
    expect(blockStatusColor('draft')).toBe('#8b949e');       // lifecycle
    expect(blockStatusColor('certified')).toBe('#3fb950');   // lifecycle
    expect(blockStatusColor('generating')).toBe('#4c8dff');  // generation
    expect(blockStatusColor('blocked')).toBe('#f85149');     // generation
    expect(blockStatusColor('mystery')).toBe('#8b949e');     // fallback
  });

  it('labels draft-first and humanizes unknowns', () => {
    expect(blockStatusLabel('draft')).toBe('Draft');
    expect(blockStatusLabel('needs_attention')).toBe('Needs review');
    expect(blockStatusLabel('certified')).toBe('Certified');
    expect(blockStatusLabel('run_preview')).toBe('Run preview');
  });
});
