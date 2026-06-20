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
    const parsed = parseArgs(['new', 'block', 'Revenue', 'by', 'Segment', '--chart', 'line', '--domain', 'finance', '--owner', 'demo', '--pattern', 'ranking', '--query-only']);
    expect(parsed.command).toBe('new');
    expect(parsed.file).toBe('block');
    expect(parsed.rest).toEqual(['Revenue', 'by', 'Segment']);
    expect(parsed.flags.chart).toBe('line');
    expect(parsed.flags.domain).toBe('finance');
    expect(parsed.flags.owner).toBe('demo');
    expect(parsed.flags.template).toBe('ranking');
    expect(parsed.flags.queryOnly).toBe(true);
  });

  it('parses domain layout migration flags', () => {
    const parsed = parseArgs(['migrate', 'layout', '--to', 'domain-first', '--dry-run']);
    expect(parsed.command).toBe('migrate');
    expect(parsed.file).toBe('layout');
    expect(parsed.flags.to).toBe('domain-first');
    expect(parsed.flags.dryRun).toBe(true);
  });

  it('parses enterprise certification flag', () => {
    const parsed = parseArgs(['certify', 'blocks/customer.dql', '--enterprise']);
    expect(parsed.command).toBe('certify');
    expect(parsed.file).toBe('blocks/customer.dql');
    expect(parsed.flags.enterprise).toBe(true);
  });

  it('lets no-open override browser launching', () => {
    const parsed = parseArgs(['serve', 'dist/demo', '--open', '--no-open']);
    expect(parsed.flags.open).toBe(false);
  });

  it('parses init with connection flag', () => {
    const parsed = parseArgs(['init', 'demo', '--connection', 'duckdb']);
    expect(parsed.command).toBe('init');
    expect(parsed.file).toBe('demo');
    expect(parsed.flags.connection).toBe('duckdb');
  });

  it('parses sql import command arguments', () => {
    const parsed = parseArgs(['import', 'sql', './queries', '--domain', 'finance', '--owner', 'analytics']);
    expect(parsed.command).toBe('import');
    expect(parsed.file).toBe('sql');
    expect(parsed.rest).toEqual(['./queries']);
    expect(parsed.flags.domain).toBe('finance');
    expect(parsed.flags.owner).toBe('analytics');
  });

  it('parses app generation AI layout flag', () => {
    const parsed = parseArgs(['app', 'generate', 'Build a clean NBA app', '--ai-layout']);
    expect(parsed.command).toBe('app');
    expect(parsed.file).toBe('generate');
    expect(parsed.rest).toEqual(['Build a clean NBA app']);
    expect(parsed.flags.aiLayout).toBe(true);
  });

  it('parses agent provider, runtime, and feedback flags without adding them to the prompt', () => {
    const parsed = parseArgs([
      'agent',
      'ask',
      'Who scored the least points?',
      '--provider',
      'ollama',
      '--runtime-url',
      'http://127.0.0.1:3474',
      '--user',
      'analyst@local',
    ]);

    expect(parsed.command).toBe('agent');
    expect(parsed.file).toBe('ask');
    expect(parsed.rest).toEqual(['Who scored the least points?']);
    expect(parsed.flags.provider).toBe('ollama');
    expect(parsed.flags.runtimeUrl).toBe('http://127.0.0.1:3474');
    expect(parsed.flags.user).toBe('analyst@local');
  });
});
