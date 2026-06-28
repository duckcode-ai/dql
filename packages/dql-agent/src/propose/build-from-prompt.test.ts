import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, parse } from '@duckcodeailabs/dql-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFromPrompt, type BuildBlockResult, type BuildCellResult } from './build-from-prompt.js';

/** Minimal dbt manifest so the engine has schema to ground offline fallbacks on. */
function writeDbtManifest(targetDir: string): string {
  mkdirSync(targetDir, { recursive: true });
  const manifest = {
    metadata: { project_name: 'jaffle_shop' },
    nodes: {
      'model.jaffle_shop.fct_orders': {
        resource_type: 'model',
        name: 'fct_orders',
        schema: 'marts',
        database: 'analytics',
        description: 'Order-grain fact.',
        original_file_path: 'models/marts/fct_orders.sql',
        config: { materialized: 'table' },
        tags: [],
        depends_on: { nodes: [] },
        columns: { order_id: { name: 'order_id' }, amount: { name: 'amount' } },
        meta: {},
      },
    },
    sources: {},
    exposures: {},
  };
  writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  return join(targetDir, 'manifest.json');
}

describe('buildFromPrompt (spec 14, part B) — offline / deterministic', () => {
  let projectRoot: string;
  let manifestPath: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-build-prompt-'));
    writeFileSync(
      join(projectRoot, 'dql.config.json'),
      JSON.stringify({ project: 'p', identity: { owner: 'owner@example.com' } }),
      'utf-8',
    );
    manifestPath = writeDbtManifest(join(projectRoot, 'target'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("target:'cell' returns SQL and writes nothing", async () => {
    const result = (await buildFromPrompt({
      projectRoot,
      prompt: 'show me total orders',
      target: 'cell',
      offline: true,
      dbtManifestPath: manifestPath,
    })) as BuildCellResult;

    expect(result.target).toBe('cell');
    expect(result.sql.trim().length).toBeGreaterThan(0);
    // Offline path grounds the starter query on the available schema.
    expect(result.sql).toContain('fct_orders');
    // Nothing written: no drafts directory created.
    expect(readdirSync(projectRoot)).not.toContain('blocks');
  });

  it("target:'cell' echoes the current cell SQL when provided (refine, not rewrite)", async () => {
    const result = (await buildFromPrompt({
      projectRoot,
      prompt: 'add a filter',
      target: 'cell',
      offline: true,
      context: { cellSql: 'SELECT order_id FROM fct_orders' },
      dbtManifestPath: manifestPath,
    })) as BuildCellResult;
    expect(result.sql).toContain('SELECT order_id FROM fct_orders');
  });

  it("target:'block' writes a complete, parseable DRAFT with owner + semantic name", async () => {
    const result = (await buildFromPrompt({
      projectRoot,
      prompt: 'Can you build the total orders by geography at the daily level?',
      target: 'block',
      offline: true,
      dbtManifestPath: manifestPath,
    })) as BuildBlockResult;

    expect(result.target).toBe('block');

    // Semantic name — NOT the raw prompt tokenized.
    expect(result.name).toBe('orders_by_geography_daily');
    expect(result.name).not.toContain('can_you_build');
    expect(result.name).toMatch(/^[a-z][a-z0-9_]*$/);

    // The draft file exists, parses, and is born status="draft" with an owner.
    const source = readFileSync(join(projectRoot, result.path), 'utf-8');
    expect(result.path).toContain('_drafts/');
    expect(source).toContain('status = "draft"');
    expect(source).not.toContain('status = "certified"');
    expect(source).toContain('owner = "owner@example.com"');
    expect(() => parse(source)).not.toThrow();

    // The whole project still parses with no parse diagnostics.
    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(manifest.diagnostics?.filter((d) => d.kind === 'parse')).toEqual([]);

    // Certifier verdict shape is returned, and "Missing owner" is NOT blocking.
    expect(result.certifierVerdict).toMatchObject({
      blocking: expect.any(Array),
      warnings: expect.any(Array),
      ready: expect.any(Boolean),
    });
    expect(result.certifierVerdict.blocking).not.toContain('Missing owner');

    // Preview fields are present for the frontend.
    expect(result.sqlPreview.trim().length).toBeGreaterThan(0);
    expect(typeof result.description).toBe('string');
    expect(Array.isArray(result.outputs)).toBe(true);
    expect(Array.isArray(result.examples)).toBe(true);
  });

  it("target:'block' resolves owner from explicit body.owner when given", async () => {
    const result = (await buildFromPrompt({
      projectRoot,
      prompt: 'build revenue by month',
      target: 'block',
      offline: true,
      owner: 'override@example.com',
      dbtManifestPath: manifestPath,
    })) as BuildBlockResult;
    const source = readFileSync(join(projectRoot, result.path), 'utf-8');
    expect(source).toContain('owner = "override@example.com"');
  });

  it('rejects an empty prompt', async () => {
    await expect(
      buildFromPrompt({ projectRoot, prompt: '   ', target: 'cell', offline: true }),
    ).rejects.toThrow(/non-empty prompt/);
  });
});
