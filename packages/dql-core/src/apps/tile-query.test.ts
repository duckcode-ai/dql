import { describe, expect, it } from 'vitest';
import {
  datasetField,
  datasetMeasureField,
  datasetPhysicalField,
  normalizeDatasetDescriptor,
  type DatasetDescriptor,
} from '../datasets/descriptor.js';
import {
  applyDatasetHierarchyDrill,
  datasetHierarchyFields,
  datasetQueryRequiresAggregateComponentEvidence,
  datasetTileVisualizationCompatibility,
  normalizeTileQuery,
  validateTileQuery,
} from './tile-query.js';

function ordersDataset(overrides: Partial<DatasetDescriptor> = {}): DatasetDescriptor {
  return {
    version: 1,
    id: 'commerce::block::order_lines',
    kind: 'block',
    sourceRevision: 'source-v1',
    snapshotId: 'runtime-v1',
    contractRef: { kind: 'block_source', id: 'commerce::block::order_lines', fingerprint: 'contract-v1' },
    binding: {
      sourceQualifiedId: 'commerce::block::order_lines',
      sourceRevision: 'source-v1',
      contractFingerprint: 'contract-v1',
      state: 'valid',
      activeSnapshotId: 'runtime-v1',
      activeTargetFingerprint: 'warehouse-a',
    },
    label: 'Order lines',
    domain: 'commerce',
    lifecycle: 'certified',
    trust: 'certified',
    grain: { entityIds: ['order_line'], keyFields: ['order_line_id'], keyEvidence: 'proof.order-lines', timeGrain: 'day' },
    fields: [
      { kind: 'physical', name: 'order_line_id', qualifiedId: 'commerce::block::order_lines::field::order_line_id', type: 'string', role: 'key', status: 'approved' },
      { kind: 'physical', name: 'order_date', qualifiedId: 'commerce::block::order_lines::field::order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month', 'year'], primary: true } },
      { kind: 'physical', name: 'region', qualifiedId: 'commerce::block::order_lines::field::region', type: 'string', role: 'dimension', status: 'approved' },
      { kind: 'physical', name: 'net_amount', qualifiedId: 'commerce::block::order_lines::field::net_amount', type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'physical', name: 'cost_amount', qualifiedId: 'commerce::block::order_lines::field::cost_amount', type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'measure', name: 'net_amount', qualifiedId: 'commerce::block::order_lines::measure::net_amount', aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
      { kind: 'measure', name: 'order_count', qualifiedId: 'commerce::block::order_lines::measure::order_count', aggregation: 'count_distinct', from: 'order_line_id', dependsOn: ['order_line_id'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['count_distinct'], status: 'approved' },
      { kind: 'measure', name: 'gross_margin_rate', qualifiedId: 'commerce::block::order_lines::measure::gross_margin_rate', aggregation: 'ratio', numerator: 'net_amount', denominator: 'cost_amount', dependsOn: ['net_amount', 'cost_amount'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['ratio'], status: 'approved' },
      { kind: 'measure', name: 'suggested_revenue', qualifiedId: 'commerce::block::order_lines::measure::suggested_revenue', aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'suggested' },
    ],
    operations: ['filter', 'group', 'trend', 'rank', 'having', 'detail'],
    execution: { route: 'certified' },
    ...overrides,
  };
}

function dailyAggregateDataset(overrides: Partial<DatasetDescriptor> = {}): DatasetDescriptor {
  const source = ordersDataset();
  return {
    ...source,
    id: 'commerce::block::customer_daily',
    contractRef: { kind: 'block_source', id: 'commerce::block::customer_daily', fingerprint: 'contract-daily-v1' },
    binding: {
      ...source.binding,
      sourceQualifiedId: 'commerce::block::customer_daily',
      contractFingerprint: 'contract-daily-v1',
    },
    label: 'Customer daily',
    grain: {
      entityIds: ['customer_day'],
      keyFields: ['customer_day_id', 'order_date'],
      keyEvidence: 'proof.customer-day',
      timeGrain: 'day',
      timeBucketBy: 'order_date',
      aggregate: true,
    },
    fields: [
      { kind: 'physical', name: 'customer_day_id', qualifiedId: 'commerce::block::customer_daily::field::customer_day_id', type: 'string', role: 'key', status: 'approved' },
      { kind: 'physical', name: 'order_date', qualifiedId: 'commerce::block::customer_daily::field::order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month'], primary: true } },
      { kind: 'physical', name: 'region', qualifiedId: 'commerce::block::customer_daily::field::region', type: 'string', role: 'dimension', status: 'approved' },
      { kind: 'physical', name: 'daily_revenue', qualifiedId: 'commerce::block::customer_daily::field::daily_revenue', type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'physical', name: 'daily_margin', qualifiedId: 'commerce::block::customer_daily::field::daily_margin', type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'physical', name: 'daily_customers', qualifiedId: 'commerce::block::customer_daily::field::daily_customers', type: 'number', role: 'attribute', status: 'approved' },
      { kind: 'measure', name: 'revenue', qualifiedId: 'commerce::block::customer_daily::measure::revenue', aggregation: 'sum', from: 'daily_revenue', dependsOn: ['daily_revenue'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
      { kind: 'measure', name: 'margin_rate', qualifiedId: 'commerce::block::customer_daily::measure::margin_rate', aggregation: 'ratio', numerator: 'daily_margin', denominator: 'daily_revenue', dependsOn: ['daily_margin', 'daily_revenue'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['ratio'], status: 'approved' },
      { kind: 'measure', name: 'customer_count', qualifiedId: 'commerce::block::customer_daily::measure::customer_count', aggregation: 'count_distinct', from: 'daily_customers', dependsOn: ['daily_customers'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['count_distinct'], status: 'approved' },
      { kind: 'measure', name: 'orders_by_day', qualifiedId: 'commerce::block::customer_daily::measure::orders_by_day', aggregation: 'count_distinct', from: 'customer_day_id', timeBucketBy: 'order_date', dependsOn: ['customer_day_id'], additivity: { entities: 'non_additive', time: 'additive' }, allowedAggs: ['count_distinct'], status: 'approved' },
    ],
    operations: ['filter', 'group', 'trend', 'rank', 'having'],
    ...overrides,
  };
}

describe('field-based tile query contract', () => {
  it('keeps scalar Dataset visualizations lossless regardless of returned row count', () => {
    const scalar = { dimensions: [], measures: [{ measure: 'net_amount' }] };
    const twoMeasures = { dimensions: [], measures: [{ measure: 'net_amount' }, { measure: 'order_count' }] };
    const grouped = { dimensions: [{ field: 'region' }], measures: [{ measure: 'net_amount' }] };
    const details = { dimensions: [], measures: [], detail: true, detailColumns: ['order_line_id'], limit: 50 };

    // The contract intentionally has no result-row input: empty and one-row
    // responses must not make a multi-field or grouped KPI appear safe.
    expect(datasetTileVisualizationCompatibility(scalar, 'single_value')).toEqual({ compatible: true });
    expect(datasetTileVisualizationCompatibility(twoMeasures, 'kpi')).toMatchObject({
      compatible: false,
      code: 'SCALAR_MEASURE_COUNT',
      recoveryVisualization: 'table',
    });
    expect(datasetTileVisualizationCompatibility(grouped, 'single_value')).toMatchObject({
      compatible: false,
      code: 'SCALAR_GROUPING_UNSUPPORTED',
      recoveryVisualization: 'table',
    });
    expect(datasetTileVisualizationCompatibility(details, 'table')).toEqual({ compatible: true });
    expect(datasetTileVisualizationCompatibility(details, 'single_value')).toMatchObject({
      compatible: false,
      code: 'SCALAR_DETAIL_UNSUPPORTED',
      recoveryVisualization: 'table',
    });
  });

  it('keeps physical and measure namespaces distinct even when their names overlap', () => {
    const descriptor = ordersDataset();

    expect(normalizeDatasetDescriptor(descriptor)).toEqual(descriptor);
    expect(datasetPhysicalField(descriptor, 'net_amount')?.kind).toBe('physical');
    expect(datasetMeasureField(descriptor, 'net_amount')?.kind).toBe('measure');
    expect(datasetField(descriptor, 'net_amount')).toBeUndefined();
  });

  it('rejects malformed persisted dataset metadata instead of silently dropping it', () => {
    const malformed = {
      ...ordersDataset(),
      binding: { ...ordersDataset().binding, state: 'invented' },
    };

    expect(normalizeDatasetDescriptor(malformed)).toBeUndefined();
  });

  it('covers an approved field query with typed filters and selected order aliases', () => {
    const query = normalizeTileQuery({
      dimensions: [{ field: 'order_date', timeGrain: 'month', alias: 'month' }, { field: 'region' }],
      measures: [{ measure: 'net_amount', alias: 'revenue' }],
      filters: [{ field: 'region', op: 'in', values: ['US', 'CA'] }],
      orderBy: [{ alias: 'revenue', direction: 'desc' }],
      limit: 10,
    });

    expect(query).toBeDefined();
    expect(validateTileQuery(ordersDataset(), query!)).toEqual({ outcome: 'covered', diagnostics: [], adaptations: [] });
  });

  it('requires rank only for an explicit entity Top-N, not ordinary ordering or safety limits', () => {
    const withoutRank = ordersDataset({ operations: ['filter', 'group', 'trend', 'having', 'detail'] });

    const chronologicalTrend = validateTileQuery(withoutRank, {
      dimensions: [{ field: 'order_date', timeGrain: 'month', alias: 'month' }],
      measures: [{ measure: 'net_amount', alias: 'revenue' }],
      orderBy: [{ alias: 'month', direction: 'asc' }],
      limit: 120,
    });
    const groupedDimensionSort = validateTileQuery(withoutRank, {
      dimensions: [{ field: 'region' }],
      measures: [{ measure: 'net_amount', alias: 'revenue' }],
      orderBy: [{ alias: 'region', direction: 'asc' }],
      limit: 50,
    });
    const scalarSafetyLimit = validateTileQuery(withoutRank, {
      dimensions: [],
      measures: [{ measure: 'net_amount' }],
      limit: 1,
    });
    const topN = validateTileQuery(withoutRank, {
      dimensions: [{ field: 'region' }],
      measures: [{ measure: 'net_amount', alias: 'revenue' }],
      orderBy: [{ alias: 'revenue', direction: 'desc' }],
      limit: 10,
    });

    expect(chronologicalTrend.outcome).toBe('covered');
    expect(groupedDimensionSort.outcome).toBe('covered');
    expect(scalarSafetyLimit.outcome).toBe('covered');
    expect(topN.outcome).toBe('rejected');
    expect(topN.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNSUPPORTED_OPERATION', message: expect.stringContaining('rank') }),
    ]));
  });

  it('rejects unsupported persisted intent and ambiguous output aliases instead of silently changing the query', () => {
    expect(normalizeTileQuery({
      dimensions: [],
      measures: [{ measure: 'net_amount' }],
      comparison: { period: 'previous' },
    })).toBeUndefined();
    expect(normalizeTileQuery({
      dimensions: [{ field: 'region', relative: 'top_10' }],
      measures: [{ measure: 'net_amount' }],
    })).toBeUndefined();
    expect(normalizeTileQuery({
      dimensions: [],
      measures: [{ measure: 'net_amount' }],
      filters: [{ field: 'region', op: 'eq', values: ['US'], unknown: true }],
    })).toBeUndefined();
    expect(normalizeTileQuery({
      dimensions: [],
      measures: [{ measure: 'net_amount' }],
      limit: { param: 'row_limit', fallback: 20 },
    })).toBeUndefined();

    const ambiguous = validateTileQuery(ordersDataset(), {
      dimensions: [{ field: 'region', alias: 'value' }],
      measures: [{ measure: 'net_amount', alias: 'value' }],
    });
    expect(ambiguous.outcome).toBe('rejected');
    expect(ambiguous.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INVALID_QUERY', field: 'value' }),
    ]));
  });

  it('requires review for a suggested measure and rejects unknown fields', () => {
    const suggested = validateTileQuery(ordersDataset(), {
      dimensions: [],
      measures: [{ measure: 'suggested_revenue' }],
    });
    const unknown = validateTileQuery(ordersDataset(), {
      dimensions: [{ field: 'unbound_column' }],
      measures: [{ measure: 'net_amount' }],
    });

    expect(suggested.outcome).toBe('needs_review');
    expect(suggested.diagnostics[0]?.code).toBe('SUGGESTED_MEASURE');
    expect(unknown.outcome).toBe('rejected');
    expect(unknown.diagnostics.some((diagnostic) => diagnostic.code === 'UNKNOWN_FIELD')).toBe(true);
  });

  it('rejects aggregate row counts even without a requested time rollup', () => {
    const aggregate = ordersDataset({
      grain: { entityIds: ['daily_order_lines'], keyFields: ['order_line_id', 'order_date'], keyEvidence: 'proof.daily', timeGrain: 'day', timeBucketBy: 'order_date', aggregate: true },
      fields: [
        ...ordersDataset().fields.filter((field) => field.kind !== 'measure'),
        { kind: 'measure', name: 'row_count', qualifiedId: 'commerce::block::order_lines::measure::row_count', aggregation: 'count', from: 'order_line_id', dependsOn: ['order_line_id'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['count'], status: 'approved' },
      ],
    });

    const result = validateTileQuery(aggregate, { dimensions: [], measures: [{ measure: 'row_count' }] });

    expect(result.outcome).toBe('rejected');
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'NON_ADDITIVE_TIME_ROLLUP')).toBe(true);
  });

  it('keeps a structurally complete ratio authorable while runtime component evidence remains required', () => {
    const aggregate = ordersDataset({
      grain: { entityIds: ['daily_order_lines'], keyFields: ['order_line_id', 'order_date'], keyEvidence: 'proof.daily', timeGrain: 'day', timeBucketBy: 'order_date', aggregate: true },
    });

    const result = validateTileQuery(aggregate, {
      dimensions: [{ field: 'order_date', timeGrain: 'month' }],
      measures: [{ measure: 'gross_margin_rate' }],
    });

    // Rolling a daily aggregate up to months is permitted but is an
    // adaptation of the declared grain (C8 `adapted`), never a plain read.
    expect(result.outcome).toBe('adapted');
    expect(result.diagnostics).toEqual([]);
    expect(result.adaptations.map((adaptation) => adaptation.kind)).toEqual(['aggregate_time_rollup', 'aggregate_entity_rollup']);
    expect(datasetQueryRequiresAggregateComponentEvidence(aggregate, {
      dimensions: [{ field: 'order_date', timeGrain: 'month' }],
      measures: [{ measure: 'gross_margin_rate' }],
    })).toBe(true);
  });

  it('allows structurally complete sum and ratio components to reach the server proof gate', () => {
    const aggregate = dailyAggregateDataset();

    const revenueByMonth = validateTileQuery(aggregate, {
      dimensions: [{ field: 'order_date', timeGrain: 'month' }],
      measures: [{ measure: 'revenue' }],
    });
    const rateByMonth = validateTileQuery(aggregate, {
      dimensions: [{ field: 'order_date', timeGrain: 'month' }],
      measures: [{ measure: 'margin_rate' }],
    });
    const distinctByMonth = validateTileQuery(aggregate, {
      dimensions: [{ field: 'order_date', timeGrain: 'month' }],
      measures: [{ measure: 'customer_count' }],
    });

    expect(revenueByMonth.outcome).toBe('adapted');
    expect(revenueByMonth.adaptations.map((adaptation) => adaptation.kind)).toContain('aggregate_time_rollup');
    expect(rateByMonth.outcome).toBe('adapted');
    expect(rateByMonth.adaptations.map((adaptation) => adaptation.kind)).toContain('aggregate_time_rollup');
    expect(distinctByMonth.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'NON_ADDITIVE_AGGREGATE_ROLLUP', field: 'customer_count' }),
    ]));
    // A declaration makes revenue structurally eligible, but no browser-side
    // additivity label can substitute for the current target-bound component
    // proof required by the App execution route.
    expect(datasetQueryRequiresAggregateComponentEvidence(aggregate, {
      dimensions: [{ field: 'order_date', timeGrain: 'month' }],
      measures: [{ measure: 'revenue' }],
    })).toBe(true);
  });

  it('retains a non-additive aggregate measure only at every declared native key and rejects missing time-bucket evidence', () => {
    const aggregate = dailyAggregateDataset();
    const nativeGrain = validateTileQuery(aggregate, {
      dimensions: [
        { field: 'customer_day_id' },
        { field: 'order_date', timeGrain: 'day' },
      ],
      measures: [{ measure: 'margin_rate' }],
    });
    const missingBucket = validateTileQuery(dailyAggregateDataset({
      grain: { ...aggregate.grain, timeBucketBy: undefined },
    }), {
      dimensions: [{ field: 'order_date', timeGrain: 'month' }],
      measures: [{ measure: 'revenue' }],
    });
    const timeAdditiveDistinctWithoutBucket = validateTileQuery(dailyAggregateDataset({
      fields: dailyAggregateDataset().fields.map((field) => field.kind === 'measure' && field.name === 'orders_by_day'
        ? { ...field, timeBucketBy: undefined }
        : field),
    }), {
      dimensions: [{ field: 'customer_day_id' }, { field: 'order_date', timeGrain: 'day' }],
      measures: [{ measure: 'orders_by_day' }],
    });

    expect(nativeGrain).toEqual({ outcome: 'covered', diagnostics: [], adaptations: [] });
    expect(datasetQueryRequiresAggregateComponentEvidence(aggregate, {
      dimensions: [
        { field: 'customer_day_id' },
        { field: 'order_date', timeGrain: 'day' },
      ],
      measures: [{ measure: 'margin_rate' }],
    })).toBe(false);
    expect(missingBucket.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AGGREGATE_GRAIN_EVIDENCE_REQUIRED' }),
    ]));
    expect(timeAdditiveDistinctWithoutBucket.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AGGREGATE_GRAIN_EVIDENCE_REQUIRED', field: 'orders_by_day' }),
    ]));
  });

  it('rejects filter values with the wrong type or cardinality before compilation', () => {
    const result = validateTileQuery(ordersDataset(), {
      dimensions: [],
      measures: [{ measure: 'net_amount' }],
      filters: [
        { field: 'region', op: 'eq', values: ['US', 'CA'] },
        { field: 'net_amount', op: 'gte', values: ['not-a-number'] },
      ],
    });

    expect(result.outcome).toBe('rejected');
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === 'INVALID_FILTER_FIELD')).toHaveLength(2);
  });

  it('allows only bounded approved physical fields in a detail tile', () => {
    const detail = normalizeTileQuery({
      dimensions: [],
      measures: [],
      detail: true,
      detailColumns: ['order_line_id', 'region'],
      limit: 100,
    });

    expect(detail).toMatchObject({ detail: true, detailColumns: ['order_line_id', 'region'], limit: 100 });
    expect(validateTileQuery(ordersDataset(), detail!)).toEqual({ outcome: 'covered', diagnostics: [], adaptations: [] });
    expect(validateTileQuery(ordersDataset(), {
      dimensions: [],
      measures: [],
      detail: true,
      detailColumns: ['order_line_id', 'unknown_column'],
      limit: 100,
    }).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INVALID_DETAIL_FIELD', field: 'unknown_column' }),
    ]));
    expect(validateTileQuery(ordersDataset(), {
      dimensions: [],
      measures: [],
      detail: true,
      detailColumns: ['order_line_id'],
    }).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DETAIL_LIMIT_REQUIRED' }),
    ]));
    expect(normalizeTileQuery({
      dimensions: [],
      measures: [],
      detail: true,
      detailColumns: ['order_line_id', 'bad-column'],
      limit: 20,
    })).toBeUndefined();
  });

  it('round-trips explicit comparison intent and rejects scalar presentation or unsupported comparison authority', () => {
    const comparison = {
      version: 1 as const,
      timeField: 'order_date',
      timeRole: 'event_time',
      calendarId: 'gregorian',
      timezone: 'America/Chicago',
      grain: 'month',
      completenessPolicy: 'closed_period' as const,
      periods: [
        { id: 'feb_2026', kind: 'absolute' as const, start: '2026-02-01T06:00:00.000Z', end: '2026-03-01T06:00:00.000Z' },
        { id: 'jan_2026', kind: 'absolute' as const, start: '2026-01-01T06:00:00.000Z', end: '2026-02-01T06:00:00.000Z' },
      ],
      basePeriodId: 'feb_2026',
      comparisonPeriodIds: ['jan_2026'],
      alignment: 'calendar_period' as const,
      outputs: ['value', 'absolute_delta', 'percent_delta'] as const,
      zeroDenominatorPolicy: 'null' as const,
    };
    const query = normalizeTileQuery({
      dimensions: [],
      measures: [{ measure: 'net_amount' }],
      comparison,
    });
    const compareDataset = ordersDataset({ operations: [...ordersDataset().operations, 'compare'] });

    expect(query?.comparison).toEqual(comparison);
    expect(validateTileQuery(compareDataset, query!)).toEqual({ outcome: 'covered', diagnostics: [], adaptations: [] });
    expect(datasetTileVisualizationCompatibility(query!, 'kpi')).toMatchObject({
      compatible: false,
      code: 'SCALAR_COMPARISON_UNSUPPORTED',
      recoveryVisualization: 'table',
    });
    expect(validateTileQuery(ordersDataset(), query!).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }),
    ]));
    expect(normalizeTileQuery({
      dimensions: [],
      measures: [{ measure: 'net_amount' }],
      comparison: { ...comparison, unexpected: true },
    })).toBeUndefined();
  });

  it('drills only through an explicit approved hierarchy and returns an immutable next query', () => {
    const base = ordersDataset();
    const hierarchyDataset = ordersDataset({
      fields: [
        {
          kind: 'physical',
          name: 'customer_id',
          qualifiedId: 'commerce::block::order_lines::field::customer_id',
          type: 'string',
          role: 'dimension',
          status: 'approved',
          hierarchy: { id: 'commerce_customer_orders', level: 0 },
        },
        {
          kind: 'physical',
          name: 'order_id',
          qualifiedId: 'commerce::block::order_lines::field::order_id',
          type: 'string',
          role: 'dimension',
          status: 'approved',
          hierarchy: { id: 'commerce_customer_orders', level: 1 },
        },
        ...base.fields,
      ],
    });
    const sourceQuery = {
      dimensions: [{ field: 'customer_id', alias: 'customer' }],
      measures: [{ measure: 'net_amount', alias: 'revenue' }],
      orderBy: [{ alias: 'customer', direction: 'asc' as const }],
    };
    const drilled = applyDatasetHierarchyDrill({
      descriptor: hierarchyDataset,
      query: sourceQuery,
      hierarchyId: 'commerce_customer_orders',
      fromField: 'customer_id',
      values: ['C-001'],
    });

    expect(datasetHierarchyFields(hierarchyDataset, 'commerce_customer_orders').map((field) => field.name)).toEqual(['customer_id', 'order_id']);
    expect(drilled).toMatchObject({
      status: 'ready',
      fromField: 'customer_id',
      toField: 'order_id',
      query: {
        dimensions: [{ field: 'order_id' }],
        filters: [{ field: 'customer_id', op: 'eq', values: ['C-001'] }],
        orderBy: [{ alias: 'order_id', direction: 'asc' }],
      },
    });
    expect(sourceQuery.dimensions).toEqual([{ field: 'customer_id', alias: 'customer' }]);
    expect(applyDatasetHierarchyDrill({
      descriptor: hierarchyDataset,
      query: sourceQuery,
      hierarchyId: 'commerce_customer_orders',
      fromField: 'order_id',
      values: ['O-100'],
    })).toMatchObject({ status: 'blocked', code: 'HIERARCHY_LEVEL_UNSUPPORTED' });
  });
});
