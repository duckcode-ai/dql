import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';

import * as kgModule from '../kg.js';
import { DQLContext } from '../../context.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

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

  it('returns enterprise block contract metadata for agent retrieval', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-mcp-kg-contract-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
    writeFileSync(join(projectRoot, 'blocks', 'top_scorers.dql'), `
block "Reusable Top Scorers" {
  domain = "nba"
  type = "custom"
  status = "certified"
  description = "Ranks NBA players by points using a reusable season filter."
  owner = "analytics"
  tags = ["nba", "scoring"]
  businessOutcome = "Review player scoring leadership."
  businessOwner = "Basketball Operations"
  decisionUse = "Season scoring comparison"
  pattern = "ranking"
  grain = "player_name"
  entities = ["Player"]
  outputs = ["player_name", "total_points"]
  dimensions = ["season"]
  allowedFilters = ["season"]
  sourceSystems = ["nba"]
  replacementFor = ["Static Top Scorers"]
  reviewCadence = "monthly"
  businessRules = ["Only include regular season games"]
  caveats = ["Excludes playoffs"]
  datalex_contract = "nba.Player.top_scorers@1"

  parameterPolicy {
    season = "dynamic"
  }

  filterBindings {
    season = "game_date_est"
  }

  query = """
select player_name, sum(pts) as total_points
from transformed.int_player_stats
where extract(year from game_date_est) = {{ season }}
group by player_name
  """

  tests {
    assert row_count > 0
  }
}
`, 'utf-8');

    const result = await kgModule.kgSearch(
      new DQLContext({ projectRoot }),
      { query: 'reusable top scorers', kinds: ['block'], limit: 5 },
    ) as {
      hits: Array<{
        pattern?: string;
        grain?: string;
        entities?: string[];
        outputs?: string[];
        dimensions?: string[];
        allowedFilters?: string[];
        parameterPolicy?: Array<{ name: string; policy: string }>;
        filterBindings?: Array<{ filter: string; binding: string }>;
        sourceSystems?: string[];
        replacementFor?: string[];
        datalexContract?: string;
        businessOwner?: string;
        businessRules?: string[];
        caveats?: string[];
      }>;
    };

    expect(result.hits[0]).toMatchObject({
      pattern: 'ranking',
      grain: 'player_name',
      entities: ['Player'],
      outputs: ['player_name', 'total_points'],
      dimensions: ['season'],
      allowedFilters: ['season'],
      parameterPolicy: [{ name: 'season', policy: 'dynamic' }],
      filterBindings: [{ filter: 'season', binding: 'game_date_est' }],
      sourceSystems: ['nba'],
      replacementFor: ['Static Top Scorers'],
      datalexContract: 'nba.Player.top_scorers@1',
      businessOwner: 'Basketball Operations',
      businessRules: ['Only include regular season games'],
      caveats: ['Excludes playoffs'],
    });
  });
});
