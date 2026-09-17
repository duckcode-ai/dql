import { describe, expect, it } from 'vitest';
import {
  DatasetDeclarationPatchError,
  prepareDatasetDeclarationPatch,
  type DatasetDeclarationPatch,
} from './source-authoring.node.js';

const source = `block "Daily customer Dataset" {
  domain = "commerce"
  type = "custom"
  status = "certified"
  grain = { entities = ["customer_day"], keys = ["customer_day_id", "order_date"], keyEvidence = "proof.customer-day", timeGrain = "day", timeBucketBy = "order_date", aggregate = true }
  fields {
    customer_day_id { role = "key", type = "string" }
    order_date { role = "time", type = "date", grains = ["day", "month"] }
    daily_revenue { role = "attribute", type = "number" }
    daily_margin { role = "attribute", type = "number" }
  }
  measures {
    revenue { agg = "sum", from = "daily_revenue", additive = "additive", allowedAggs = ["sum"] }
  }
  query = """SELECT customer_day_id, order_date, daily_revenue, daily_margin FROM daily_customer_orders"""
}`;

const patch: DatasetDeclarationPatch = {
  measures: [
    { name: 'revenue', aggregation: 'sum', from: 'daily_revenue', additive: 'additive', allowedAggs: ['sum'] },
    {
      name: 'gross_margin',
      aggregation: 'sum',
      expression: 'SUM(daily_revenue) - SUM(daily_margin)',
      additive: 'additive',
      allowedAggs: ['sum'],
      format: 'currency',
      currency: 'USD',
    },
  ],
};

function physicalFieldPatch() {
  return [
    { name: 'customer_day_id', role: 'key' as const, type: 'string' as const, status: 'approved' as const },
    { name: 'order_date', role: 'time' as const, type: 'date' as const, status: 'approved' as const, grains: ['day', 'month'], primary: true },
    { name: 'daily_revenue', role: 'attribute' as const, type: 'number' as const, status: 'approved' as const },
    { name: 'daily_margin', role: 'attribute' as const, type: 'number' as const, status: 'approved' as const },
  ];
}

describe('Dataset source authoring patch', () => {
  it('formats, recompiles, and forces a material Dataset declaration into review', () => {
    const result = prepareDatasetDeclarationPatch({
      source,
      filePath: 'domains/commerce/blocks/customer-daily.dql',
      blockName: 'Daily customer Dataset',
      patch,
    });

    expect(result.beforeFingerprint).toMatch(/^sha256:/);
    expect(result.afterFingerprint).toMatch(/^sha256:/);
    expect(result.afterFingerprint).not.toBe(result.beforeFingerprint);
    expect(result.lifecycle).toBe('review');
    expect(result.after).toContain('status = "review"');
    expect(result.after).toContain('gross_margin');
    expect(result.after).toContain('expression = "SUM(daily_revenue) - SUM(daily_margin)"');
    expect(result.diagnostics).toEqual([]);
  });

  it('rejects an invalid calculated measure before a proposal can be accepted', () => {
    expect(() => prepareDatasetDeclarationPatch({
      source,
      filePath: 'domains/commerce/blocks/customer-daily.dql',
      blockName: 'Daily customer Dataset',
      patch: {
        measures: [{
          name: 'unsafe_margin',
          aggregation: 'sum',
          expression: 'SUM(secret_amount)',
          additive: 'additive',
          allowedAggs: ['sum'],
        }],
      },
    })).toThrow(DatasetDeclarationPatchError);
    try {
      prepareDatasetDeclarationPatch({
        source,
        filePath: 'domains/commerce/blocks/customer-daily.dql',
        blockName: 'Daily customer Dataset',
        patch: {
          measures: [{
            name: 'unsafe_margin',
            aggregation: 'sum',
            expression: 'SUM(secret_amount)',
            additive: 'additive',
            allowedAggs: ['sum'],
          }],
        },
      });
    } catch (error) {
      expect(error).toMatchObject({ code: 'DATASET_CHANGE_INVALID' });
    }
  });

  it('refuses empty patches and a stale block target', () => {
    expect(() => prepareDatasetDeclarationPatch({
      source,
      filePath: 'domains/commerce/blocks/customer-daily.dql',
      blockName: 'Daily customer Dataset',
      patch: {},
    })).toThrow(/Choose a Dataset grain/i);
    expect(() => prepareDatasetDeclarationPatch({
      source,
      filePath: 'domains/commerce/blocks/customer-daily.dql',
      blockName: 'Renamed Dataset',
      patch,
    })).toThrow(/no longer resolves/i);
  });

  it('treats source physical fields as an immutable complete inventory', () => {
    const fields = physicalFieldPatch();
    const roleOverlay = prepareDatasetDeclarationPatch({
      source,
      filePath: 'domains/commerce/blocks/customer-daily.dql',
      blockName: 'Daily customer Dataset',
      patch: {
        fields: fields.map((field) => field.name === 'daily_margin' ? { ...field, role: 'dimension' as const } : field),
      },
    });
    expect(roleOverlay.after).toContain('daily_margin { role = "dimension", type = "number" }');

    const cases: Array<[string, DatasetDeclarationPatch, string]> = [
      ['retyped', { fields: fields.map((field) => field.name === 'daily_revenue' ? { ...field, type: 'string' } : field) }, 'DATASET_FIELD_TYPE_IMMUTABLE'],
      ['status-changed', { fields: fields.map((field) => field.name === 'daily_revenue' ? { ...field, status: 'suggested' } : field) }, 'DATASET_FIELD_STATUS_IMMUTABLE'],
      ['omitted', { fields: fields.slice(0, -1) }, 'DATASET_FIELD_INVENTORY_MISMATCH'],
      ['invented', { fields: [...fields.slice(0, -1), { name: 'invented_column', role: 'attribute', type: 'number', status: 'approved' }] }, 'DATASET_FIELD_INVENTORY_MISMATCH'],
    ];
    for (const [, invalidPatch, code] of cases) {
      try {
        prepareDatasetDeclarationPatch({
          source,
          filePath: 'domains/commerce/blocks/customer-daily.dql',
          blockName: 'Daily customer Dataset',
          patch: invalidPatch,
        });
        throw new Error('Expected immutable physical inventory refusal.');
      } catch (error) {
        expect(error).toMatchObject({ code });
      }
    }

    const withoutInventory = source.replace(/  fields \{[\s\S]*?\n  \}\n  measures/, '  measures');
    expect(() => prepareDatasetDeclarationPatch({
      source: withoutInventory,
      filePath: 'domains/commerce/blocks/customer-daily.dql',
      blockName: 'Daily customer Dataset',
      patch: { fields },
    })).toThrow(expect.objectContaining({ code: 'DATASET_FIELD_INVENTORY_REQUIRED' }));
  });
});
