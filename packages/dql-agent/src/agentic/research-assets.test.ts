import { describe, expect, it } from 'vitest';
import { researchAssetsFromPack } from './research-assets.js';

const object = (objectType: string, name: string) => ({ objectKey: `${objectType}:${name}`, objectType, name });

describe('research reads the pack (CTX-010)', () => {
  it('names the ranked objects first, then the rest of the eligible set, once each, under a bound', () => {
    const pack = {
      objects: [object('semantic_metric', 'revenue'), object('dql_block', 'monthly_revenue'), object('semantic_dimension', 'region')] as never[],
      eligible: {
        objects: [object('semantic_metric', 'net_arr'), object('semantic_metric', 'revenue'), object('semantic_metric', 'orders'), object('semantic_dimension', 'region'), object('semantic_dimension', 'segment'), object('dbt_model', 'fct_orders')],
        counts: {}, domains: [], fingerprint: 'sha256:x',
      },
    };
    expect(researchAssetsFromPack(pack, { metrics: 2 })).toEqual({ metrics: ['revenue', 'net_arr'], blocks: ['monthly_revenue'], dimensions: ['region', 'segment'] });
  });
  it('without an eligible set the ranked objects alone are the assets', () => {
    expect(researchAssetsFromPack({ objects: [object('semantic_metric', 'revenue')] as never[] })).toEqual({ metrics: ['revenue'], blocks: [], dimensions: [] });
  });
});
