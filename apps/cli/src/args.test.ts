import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';

describe('parseArgs', () => {
  it('parses open and no-open flags plus port and out-dir', () => {
    const parsed = parseArgs(['preview', 'blocks/demo.dql', '--open', '--port', '4488', '--out-dir', 'out']);
    expect(parsed.command).toBe('preview');
    expect(parsed.file).toBe('blocks/demo.dql');
    expect(parsed.flags.open).toBe(true);
    expect(parsed.flags.port).toBe(4488);
    expect(parsed.flags.outDir).toBe('out');
  });

  it('collects extra positionals and new-block flags', () => {
    const parsed = parseArgs(['new', 'block', 'Revenue', 'by', 'Segment', '--chart', 'line', '--domain', 'finance', '--owner', 'demo', '--query-only']);
    expect(parsed.command).toBe('new');
    expect(parsed.file).toBe('block');
    expect(parsed.rest).toEqual(['Revenue', 'by', 'Segment']);
    expect(parsed.flags.chart).toBe('line');
    expect(parsed.flags.domain).toBe('finance');
    expect(parsed.flags.owner).toBe('demo');
    expect(parsed.flags.queryOnly).toBe(true);
  });

  it('lets no-open override browser launching', () => {
    const parsed = parseArgs(['serve', 'dist/demo', '--open', '--no-open']);
    expect(parsed.flags.open).toBe(false);
  });

  it('parses notebook init template selection', () => {
    const parsed = parseArgs(['init', 'demo', '--template', 'ecommerce']);
    expect(parsed.command).toBe('init');
    expect(parsed.file).toBe('demo');
    expect(parsed.flags.template).toBe('ecommerce');
  });
});
