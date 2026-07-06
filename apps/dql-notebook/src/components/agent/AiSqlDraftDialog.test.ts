import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentAnswerEnvelope } from './AgentAnswerCard';
import type { BlockProposal } from '../../llm/types';
import type * as AiSqlDraftDialogModule from './AiSqlDraftDialog';

let buildBlockDraftMeta: typeof AiSqlDraftDialogModule.buildBlockDraftMeta;
let extractSqlDraft: typeof AiSqlDraftDialogModule.extractSqlDraft;
let resolveSqlDraftDialogCopy: typeof AiSqlDraftDialogModule.resolveSqlDraftDialogCopy;

const backendDqlSource = `block "backend_artifact" {
  domain = "revenue"
  type = "custom"
  status = "draft"
  outputs = ["region", "revenue"]

  query = """
    SELECT region, SUM(amount) AS revenue
    FROM orders
    GROUP BY region
  """
}`;

function answerWithDqlArtifact(partial: Partial<AgentAnswerEnvelope> = {}): AgentAnswerEnvelope {
  return {
    kind: 'uncertified',
    text: 'Revenue by region needs review.',
    dqlArtifact: {
      kind: 'sql_block',
      name: 'backend_artifact',
      source: backendDqlSource,
    },
    ...partial,
  };
}

describe('AiSqlDraftDialog DQL artifact helpers', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    const module = await import('./AiSqlDraftDialog');
    buildBlockDraftMeta = module.buildBlockDraftMeta;
    extractSqlDraft = module.extractSqlDraft;
    resolveSqlDraftDialogCopy = module.resolveSqlDraftDialogCopy;
  });

  it('uses the governed answer DQL artifact as the block draft source', () => {
    const meta = buildBlockDraftMeta(
      'Revenue by region',
      answerWithDqlArtifact({ proposedSql: 'SELECT 1 AS fallback_sql' }),
      null,
      'SELECT 1 AS fallback_sql',
      '',
    );

    expect(meta.title).toBe('backend_artifact');
    expect(meta.blockSource).toBe(backendDqlSource);
    expect(meta.blockSource).toContain('outputs = ["region", "revenue"]');
    expect(meta.blockSource).not.toContain('SELECT 1 AS fallback_sql');
  });

  it('keeps an explicit proposal DQL source ahead of the answer artifact', () => {
    const proposalSource = 'block "proposal_artifact" {\n  type = "custom"\n  query = """SELECT 2 AS value"""\n}';
    const proposal: BlockProposal = {
      name: 'proposal_artifact',
      domain: 'revenue',
      owner: 'analyst@example.com',
      description: 'Proposal source wins.',
      sql: 'SELECT 2 AS value',
      dqlSource: proposalSource,
    };

    const meta = buildBlockDraftMeta(
      'Revenue by region',
      answerWithDqlArtifact(),
      proposal,
      'SELECT 1 AS fallback_sql',
      '',
    );

    expect(meta.blockSource).toBe(proposalSource);
  });

  it('can extract preview SQL from the governed DQL artifact when SQL aliases are absent', () => {
    const sql = extractSqlDraft(answerWithDqlArtifact({ proposedSql: undefined, sql: undefined }), null, '');

    expect(sql).toContain('SELECT region, SUM(amount) AS revenue');
    expect(sql).toContain('GROUP BY region');
  });

  it('labels governed DQL artifact output as the review target', () => {
    expect(resolveSqlDraftDialogCopy({
      mode: 'notebook',
      hasReturnedDqlArtifact: true,
    })).toMatchObject({
      ariaLabel: 'Review DQL artifact',
      heading: 'Review DQL artifact',
      draftTitle: 'Compiled SQL preview',
      insertLabel: 'Insert SQL preview',
    });
  });

  it('labels explicit notebook SQL generation as a preview flow', () => {
    expect(resolveSqlDraftDialogCopy({ mode: 'notebook' })).toMatchObject({
      ariaLabel: 'Build SQL preview',
      heading: 'Build SQL preview',
      draftTitle: 'SQL preview',
      generateLabel: 'Generate SQL preview',
      insertLabel: 'Insert SQL preview',
    });
  });
});
