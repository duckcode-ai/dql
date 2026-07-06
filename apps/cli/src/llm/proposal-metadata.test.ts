import { describe, expect, it } from 'vitest';
import { blockProposalDqlMetadata } from './proposal-metadata.js';

describe('blockProposalDqlMetadata', () => {
  it('preserves semantic DQL proposal metadata for review handoff', () => {
    expect(blockProposalDqlMetadata({
      blockType: 'semantic',
      dqlSource: 'block "Revenue" {\n  type = "semantic"\n}',
      metrics: ['total_revenue'],
      dimensions: ['channel'],
      filters: [{ dimension: 'channel', operator: 'equals', values: ['Online'] }],
      timeDimension: { name: 'order_date', granularity: 'month' },
    })).toEqual({
      blockType: 'semantic',
      dqlSource: 'block "Revenue" {\n  type = "semantic"\n}',
      metrics: ['total_revenue'],
      dimensions: ['channel'],
      filters: [{ dimension: 'channel', operator: 'equals', values: ['Online'] }],
      timeDimension: { name: 'order_date', granularity: 'month' },
    });
  });

  it('preserves custom SQL-block DQL source for review handoff', () => {
    expect(blockProposalDqlMetadata({
      blockType: 'custom',
      dqlSource: 'block "Revenue" {\n  type = "custom"\n  query = """SELECT 1"""\n}',
      metrics: [''],
      dimensions: [''],
    })).toEqual({
      blockType: 'custom',
      dqlSource: 'block "Revenue" {\n  type = "custom"\n  query = """SELECT 1"""\n}',
      metrics: [],
      dimensions: [],
    });
  });

  it('drops empty or invalid DQL proposal metadata', () => {
    expect(blockProposalDqlMetadata({
      blockType: 'unknown' as unknown as 'semantic',
      dqlSource: '   ',
      metrics: ['total_revenue', ''],
      dimensions: ['channel', ''],
    })).toEqual({
      metrics: ['total_revenue'],
      dimensions: ['channel'],
    });
  });
});
