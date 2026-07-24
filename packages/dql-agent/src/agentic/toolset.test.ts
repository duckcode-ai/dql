import { describe, expect, it } from 'vitest';
import { SemanticLayer } from '@duckcodeailabs/dql-core';
import type { KGStore } from '../kg/sqlite-fts.js';
import { buildSemanticStageTools } from './toolset.js';

describe('search_semantic_layer composition contract', () => {
  it('returns business-metric provenance and only dimensions compatible with the matched metric', async () => {
    const layer = new SemanticLayer({
      metrics: [{
        name: 'total_revenue',
        label: 'Total revenue',
        description: 'Recognized order revenue.',
        domain: 'finance',
        sql: 'amount',
        type: 'sum',
        table: 'orders',
        cube: 'orders',
        semanticModelIds: ['orders'],
      }],
      dimensions: [
        {
          name: 'channel',
          label: 'Channel',
          description: 'Order channel.',
          sql: 'channel',
          type: 'string',
          table: 'orders',
          cube: 'orders',
        },
        {
          name: 'region',
          label: 'Region',
          description: 'Campaign region.',
          sql: 'region',
          type: 'string',
          table: 'campaigns',
          cube: 'campaigns',
        },
      ],
    });
    const search = buildSemanticStageTools({
      semanticLayer: layer,
      kg: {} as KGStore,
    }).find((tool) => tool.name === 'search_semantic_layer');

    const result = await search?.run({ query: 'revenue by channel and region' }) as {
      metrics: Array<{ name: string; semanticModelIds?: string[]; compatibleDimensions?: string[] }>;
      dimensions: Array<{ name: string; semanticModelId?: string }>;
    };

    expect(result.metrics).toEqual([
      expect.objectContaining({
        name: 'total_revenue',
        semanticModelIds: ['orders'],
        compatibleDimensions: ['orders.channel'],
      }),
    ]);
    expect(result.dimensions).toEqual([
      expect.objectContaining({ name: 'orders.channel', semanticModelId: 'orders' }),
    ]);
  });
});
