import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  candidateToDqlSource,
  clearBlockStudioImportSessions,
  createBlockStudioImportSession,
  deleteBlockStudioImportSession,
  listBlockStudioImportSessions,
  loadBlockStudioImportSession,
  updateBlockStudioImportCandidate,
} from './block-studio-import.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dql-import-'));
  tempDirs.push(dir);
  return dir;
}

describe('Block Studio SQL import', () => {
  it('previews a single SQL file as a local block candidate', () => {
    const root = tempProject();
    writeFileSync(join(root, 'revenue.sql'), `-- name: revenue by region
-- description: Revenue by region from legacy BI
-- domain: finance
-- tags: dashboard, migration
select region, sum(revenue) as total_revenue
from marts.orders
group by region;
`);

    const session = createBlockStudioImportSession(root, {
      inputPath: 'revenue.sql',
      domain: 'finance',
      owner: 'analytics',
    });

    expect(session.candidates).toHaveLength(1);
    const candidate = session.candidates[0];
    expect(candidate.sourceKind).toBe('raw-sql-file');
    expect(candidate.name).toBe('Revenue By Region');
    expect(candidate.domain).toBe('finance');
    expect(candidate.owner).toBe('analytics');
    expect(candidate.description).toBe('Revenue by region from legacy BI');
    expect(candidate.tags).toEqual(['imported', 'raw-sql', 'dashboard', 'migration']);
    expect(candidate.lineage.sourceTables).toEqual(['marts.orders']);
    expect(candidate.dqlSource).toContain('block "Revenue By Region"');
    expect(candidate.dqlSource).toContain('status = "draft"');
    expect(candidate.dqlSource).toContain('query = """');
    expect(candidate.reviewStatus).toBe('draft');
    expect(candidate.conversionNotes?.[0]).toMatch(/Deterministic SQL extraction/);
    expect(readFileSync(join(root, '.dql', 'imports', session.id, 'manifest.json'), 'utf-8')).toContain(candidate.id);
  });

  it('splits multi-statement SQL without breaking semicolons inside strings', () => {
    const root = tempProject();
    writeFileSync(join(root, 'legacy.sql'), `
select 'a;b' as label, count(*) as n from raw.events;
select region, count(*) as n from raw.accounts group by region;
`);

    const session = createBlockStudioImportSession(root, {
      inputPath: 'legacy.sql',
      domain: 'ops',
    });

    expect(session.candidates).toHaveLength(2);
    expect(session.candidates[0].sql).toContain("'a;b'");
    expect(session.candidates[0].lineage.sourceTables).toEqual(['raw.events']);
    expect(session.candidates[1].lineage.sourceTables).toEqual(['raw.accounts']);
    expect(session.candidates[0].lineage.totalStatements).toBe(2);
  });

  it('splits SQL Server style GO batches', () => {
    const root = tempProject();
    writeFileSync(join(root, 'legacy-go.sql'), `
select count(*) as n from raw.events
GO
select region, count(*) as n from raw.accounts group by region
go
`);

    const session = createBlockStudioImportSession(root, {
      inputPath: 'legacy-go.sql',
      domain: 'ops',
    });

    expect(session.candidates).toHaveLength(2);
    expect(session.candidates[0].lineage.sourceTables).toEqual(['raw.events']);
    expect(session.candidates[1].lineage.sourceTables).toEqual(['raw.accounts']);
    expect(session.candidates[0].splitStrategy).toBe('semicolon-go');
  });

  it('infers useful metadata for pasted analytical SQL without comments', () => {
    const root = tempProject();
    const session = createBlockStudioImportSession(root, {
      inputMode: 'paste',
      sources: [{
        path: 'pasted.sql',
        content: `
select
  player_name,
  sum(coalesce(pts, 0)) as total_points,
  count(distinct details_game_id) as games_played
from TRANSFORMED.int_player_stats
where extract(year from game_date_est) = 2017
  and player_name is not null
group by player_name
order by total_points desc
limit 3;
`,
      }],
    });

    const candidate = session.candidates[0];
    expect(candidate.name).toBe('Top Players By Total Points 2017');
    expect(candidate.description).toBe('Ranks players by total points for 2017 using TRANSFORMED.int_player_stats, including games played.');
    expect(candidate.tags).toEqual(expect.arrayContaining(['transformed', 'player', 'stats', 'total', 'points', '2017']));
    expect(candidate.dqlSource).toContain('block "Top Players By Total Points 2017"');
  });

  it('splits named query sections without semicolons', () => {
    const root = tempProject();
    writeFileSync(join(root, 'named-sections.sql'), `
-- name: active customers
select * from raw.customers
-- title: account revenue
with account_revenue as (
  select account_id, sum(amount) as revenue from raw.orders group by account_id
)
select * from account_revenue
`);

    const session = createBlockStudioImportSession(root, {
      inputPath: 'named-sections.sql',
      domain: 'customer',
    });

    expect(session.candidates).toHaveLength(2);
    expect(session.candidates[0].name).toBe('Active Customers');
    expect(session.candidates[1].name).toBe('Account Revenue');
    expect(session.candidates[0].splitStrategy).toBe('metadata-comment');
    expect(session.candidates[0].lineage.totalStatements).toBe(2);
    expect(session.candidates[0].lineage.sourceTables).toEqual(['raw.customers']);
  });

  it('warns when one candidate likely contains several undelimited scripts', () => {
    const root = tempProject();
    writeFileSync(join(root, 'missing-delimiters.sql'), 'select * from raw.events select * from raw.accounts');

    const session = createBlockStudioImportSession(root, {
      inputPath: 'missing-delimiters.sql',
      domain: 'ops',
    });

    expect(session.candidates).toHaveLength(1);
    expect(session.candidates[0].warnings.join(' ')).toMatch(/multiple SELECT\/WITH clauses/i);
  });

  it('drops comment-only fragments after a trailing semicolon', () => {
    const root = tempProject();
    writeFileSync(join(root, 'availability.sql'), `
with games_details_summary as (
  select count(*) as total_records from NBA_GAMES.RAW.GAMES_DETAILS
),
final_summary as (
  select total_records from games_details_summary
)
select * from final_summary
order by total_records;
-- Order by dataset name for clarity
`);

    const session = createBlockStudioImportSession(root, {
      inputPath: 'availability.sql',
      domain: 'quality',
    });

    expect(session.candidates).toHaveLength(1);
    expect(session.candidates[0].lineage.sourceTables).toEqual(['NBA_GAMES.RAW.GAMES_DETAILS']);
    expect(session.candidates[0].lineage.totalStatements).toBe(1);
  });

  it('imports every SQL file in a folder and reloads the persisted session', () => {
    const root = tempProject();
    mkdirSync(join(root, 'queries'));
    writeFileSync(join(root, 'queries', 'a.sql'), 'select * from source_a;');
    writeFileSync(join(root, 'queries', 'b.sql'), 'select * from source_b;');

    const session = createBlockStudioImportSession(root, {
      inputPath: 'queries',
      domain: 'shared reporting',
    });
    const reloaded = loadBlockStudioImportSession(root, session.id);

    expect(reloaded.sourceKind).toBe('raw-sql-folder');
    expect(reloaded.candidates.map((candidate) => candidate.lineage.sourceTables[0]).sort()).toEqual(['source_a', 'source_b']);
    expect(reloaded.defaults.domain).toBe('shared-reporting');
  });

  it('creates sessions from pasted or uploaded SQL sources and lists summaries', () => {
    const root = tempProject();
    const session = createBlockStudioImportSession(root, {
      inputMode: 'paste',
      sources: [{ path: 'manual.sql', content: 'select * from raw.events; select * from raw.accounts;' }],
      domain: 'ops',
    });
    const summaries = listBlockStudioImportSessions(root);

    expect(session.inputMode).toBe('paste');
    expect(session.sourceFiles).toEqual(['manual.sql']);
    expect(session.candidates).toHaveLength(2);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].candidateCount).toBe(2);
  });

  it('deletes one import session or clears all import history', () => {
    const root = tempProject();
    const first = createBlockStudioImportSession(root, {
      inputMode: 'paste',
      sources: [{ path: 'first.sql', content: 'select * from first_table;' }],
    });
    createBlockStudioImportSession(root, {
      inputMode: 'paste',
      sources: [{ path: 'second.sql', content: 'select * from second_table;' }],
    });

    expect(listBlockStudioImportSessions(root)).toHaveLength(2);
    deleteBlockStudioImportSession(root, first.id);
    expect(listBlockStudioImportSessions(root)).toHaveLength(1);
    expect(clearBlockStudioImportSessions(root)).toBe(1);
    expect(listBlockStudioImportSessions(root)).toHaveLength(0);
  });

  it('detects parameters and refreshes generated DQL when a candidate is updated', () => {
    const root = tempProject();
    writeFileSync(join(root, 'parameterized.sql'), "select ':not_a_param' as label, * from orders where region = :region and dt >= {{ start_date }};");
    const session = createBlockStudioImportSession(root, { inputPath: 'parameterized.sql' });

    expect(session.candidates[0].lineage.parameters.sort()).toEqual(['region', 'start_date']);
    const updated = updateBlockStudioImportCandidate(root, session.id, session.candidates[0].id, {
      name: 'Orders Filtered',
      domain: 'sales',
      sql: 'select * from orders where region = :region;',
    });

    expect(updated.name).toBe('Orders Filtered');
    expect(updated.domain).toBe('sales');
    expect(updated.dqlSource).toContain('block "Orders Filtered"');
    expect(updated.lineage.parameters).toEqual(['region']);
  });

  it('generates a valid DQL block shape from a candidate', () => {
    const source = candidateToDqlSource({
      name: 'Legacy Query',
      domain: 'finance',
      description: 'Imported legacy SQL',
      owner: 'owner',
      tags: ['imported', 'raw-sql'],
      sql: 'select * from finance.orders',
    });

    expect(source).toContain('domain = "finance"');
    expect(source).toContain('tags = ["imported", "raw-sql"]');
    expect(source).toContain('visualization {');
    expect(source).toContain('chart = "table"');
  });
});
