import { describe, expect, it } from 'vitest';
import {
  assertProviderPayloadAllowed,
  createProviderEgressReceipt,
  createProviderDispatchEgressReceipt,
  DEFAULT_ASK_ROW_EGRESS_POLICY,
  inspectProviderPayloadRowShape,
  markProviderMetadataArray,
  prepareProviderContextForDispatch,
  prepareProviderWireEnvelopeForDispatch,
  prepareServerOwnedProviderSchemaContext,
  RESEARCH_ROW_EGRESS_POLICY,
  redactProviderResultRows,
  boundProviderResultRows,
  resolveProviderResultRowEgressPolicy,
  markProviderMetadata,
} from './provider-egress.js';

describe('provider egress guard (SEC-004)', () => {
  it('API-017 bounds a local V2 result payload to 20 x 20 / 400 cells', () => {
    const rows = Array.from({ length: 24 }, (_, row) => Object.fromEntries(
      Array.from({ length: 24 }, (_, column) => [`c${column}`, `${row}:${column}`]),
    ));
    const bounded = boundProviderResultRows({ rows }, 20, 20, 400);
    expect(bounded.shape).toEqual({ resultRowCount: 20, columnCount: 20 });
    expect(bounded.exhausted).toBe(true);
    expect(() => assertProviderPayloadAllowed(bounded.value, {
      allowResultRows: true,
      maxResultRows: 20,
      maxResultColumns: 20,
      maxResultCells: 400,
      purpose: 'answer_generation',
    })).not.toThrow();
  });

  it('mints result-row authority only for explicit Research with one-run consent', () => {
    const projectSetting = { mode: 'bounded_sample' as const, maxNarrationRows: 13 };

    expect(DEFAULT_ASK_ROW_EGRESS_POLICY).toMatchObject({
      maxNarrationRows: 0,
      resultRowAuthority: 'none',
    });
    expect(resolveProviderResultRowEgressPolicy({
      projectSetting,
      requestedMode: 'ask',
      researchOptIn: true,
    })).toBe(DEFAULT_ASK_ROW_EGRESS_POLICY);
    expect(resolveProviderResultRowEgressPolicy({
      projectSetting,
      requestedMode: 'research',
      researchOptIn: false,
    })).toBe(DEFAULT_ASK_ROW_EGRESS_POLICY);
    expect(resolveProviderResultRowEgressPolicy({
      projectSetting,
      researchOptIn: true,
    })).toBe(DEFAULT_ASK_ROW_EGRESS_POLICY);
    expect(resolveProviderResultRowEgressPolicy({
      projectSetting,
      requestedMode: 'research',
      researchOptIn: true,
    })).toMatchObject({
      ...RESEARCH_ROW_EGRESS_POLICY,
      maxNarrationRows: 13,
      resultRowAuthority: 'research_run_opt_in',
    });
  });

  it('rejects recursively nested row canaries without relying on a rows field', () => {
    const payload = { observation: { arbitrary: [{ customer: 'ROW_CANARY_ADA', amount: 42 }] } };
    expect(() => assertProviderPayloadAllowed(payload, {
      allowResultRows: false,
      maxResultRows: 0,
      purpose: 'answer_generation',
    })).toThrow(/row-shaped result payload/i);
  });

  it('rejects descriptor-shaped, primitive, empty, single-row, and renamed row arrays', () => {
    for (const rows of [
      [{ name: 'ROW_CANARY_ADA', type: 'vip' }],
      ['ROW_CANARY_ADA'],
      [],
      [{ value: 'ROW_CANARY_ADA' }],
      [{ arbitrary_alias: 'ROW_CANARY_ADA' }],
      [{ relation: 'ROW_CANARY_ADA', columns: 'vip', keys: 'secret' }],
    ]) {
      expect(() => assertProviderPayloadAllowed({ observation: rows }, {
        allowResultRows: false,
        maxResultRows: 0,
        purpose: 'answer_generation',
      })).toThrow(/row-shaped|row|payload/i);
    }
  });

  it('fails closed at excessive depth and on cycles', () => {
    let deep: unknown = [{ customer: 'ROW_CANARY_ADA' }];
    for (let index = 0; index < 14; index += 1) deep = { nested: deep };
    expect(() => assertProviderPayloadAllowed(deep, {
      allowResultRows: false,
      maxResultRows: 0,
      purpose: 'answer_generation',
    })).toThrow(/completely inspect/i);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertProviderPayloadAllowed(cyclic, {
      allowResultRows: false,
      maxResultRows: 0,
      purpose: 'research_tool',
    })).toThrow(/completely inspect/i);
  });

  it('accepts only explicitly marked legitimate schema metadata arrays', () => {
    const payload = {
      tables: markProviderMetadataArray([{ relation: 'analytics.orders', columns: [{ name: 'order_id', type: 'integer' }] }]),
      matches: markProviderMetadataArray([{ path: 'models/orders.sql', line: 4, text: 'select order_id' }]),
    };
    expect(inspectProviderPayloadRowShape(payload)).toEqual({ resultRowCount: 0, columnCount: 0 });
    expect(() => assertProviderPayloadAllowed(payload, {
      allowResultRows: false,
      maxResultRows: 0,
      purpose: 'answer_generation',
    })).not.toThrow();
  });

  it('normalizes typed governed context only at dispatch and strips unclassified arrays', () => {
    const parsedJson = JSON.parse(JSON.stringify({
      resultColumns: ['customer', 'revenue'],
      resultDimensionValues: { customer: ['Ada'] },
      schema: [{ name: 'customer', type: 'varchar' }],
      dqlArtifact: { metrics: ['revenue', 'order_count'], dimensions: ['region'] },
      rowsSample: [['ROW_CANARY_ADA', 42]],
      renamedPayload: { arbitrarySample: [{ customer: 'ROW_CANARY_ADA' }] },
    }));
    const prepared = prepareProviderContextForDispatch(parsedJson);
    expect(prepared).toEqual({
      resultColumns: ['customer', 'revenue'],
      resultDimensionValues: { customer: ['Ada'] },
      schema: [],
      dqlArtifact: { metrics: ['revenue', 'order_count'], dimensions: ['region'] },
      rowsSample: [],
      renamedPayload: { arbitrarySample: [] },
    });
    expect(() => assertProviderPayloadAllowed(prepared, {
      allowResultRows: false,
      maxResultRows: 0,
      purpose: 'answer_generation',
    })).not.toThrow();
    expect(JSON.stringify(prepared)).not.toContain('ROW_CANARY_ADA');
  });

  it('trusts only strictly validated server-owned relation schema DTOs', () => {
    const schemaContext = prepareServerOwnedProviderSchemaContext([
      { relation: 'analytics.orders', columns: [{ name: 'order_id', type: 'integer' }] },
      { relation: 'analytics.bad', columns: [{ customer_name: 'ROW_CANARY_SCHEMA', amount: 42 }] },
    ]);
    expect(schemaContext).toEqual([
      { relation: 'analytics.orders', columns: [{ name: 'order_id', type: 'integer' }] },
    ]);
    expect(() => assertProviderPayloadAllowed({ schemaContext }, {
      allowResultRows: false,
      maxResultRows: 0,
      purpose: 'answer_generation',
    })).not.toThrow();
    const untrusted = prepareProviderContextForDispatch({
      workspaceContext: {
        schema: [{ name: 'customer_name', type: 'ROW_CANARY_SCHEMA' }],
        nested: { schemaContext: [{ customer_name: 'ROW_CANARY_NESTED', amount: 42 }] },
      },
    });
    expect(JSON.stringify(untrusted)).not.toContain('ROW_CANARY');
  });

  it('does not grant untrusted context provenance from provider-native leaf names', () => {
    const prepared = prepareProviderContextForDispatch({
      workspaceContext: {
        arbitrary: {
          content: [{ customer_name: 'ROW_CANARY_ADA', amount: 42 }],
          toolCalls: [{ customer_name: 'ROW_CANARY_GRACE' }],
          required: ['ROW_CANARY_REQUIRED'],
          enum: ['ROW_CANARY_ENUM'],
          metrics: ['ROW_CANARY_METRIC'],
        },
      },
    });
    expect(JSON.stringify(prepared)).not.toContain('ROW_CANARY');
    expect(() => assertProviderPayloadAllowed(prepared, {
      allowResultRows: false,
      maxResultRows: 0,
      purpose: 'answer_generation',
    })).not.toThrow();
  });

  it('preserves only validated provider wire array paths and shapes', () => {
    const prepared = prepareProviderWireEnvelopeForDispatch('openai', {
      model: 'gpt-test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          parameters: { type: 'object', required: ['metric'], properties: { metric: { type: 'string' } } },
        },
      }],
      workspaceContext: { arbitrary: { content: [{ customer_name: 'ROW_CANARY_ADA' }] } },
    });
    expect(prepared).toMatchObject({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ function: { parameters: { required: ['metric'] } } }],
    });
    expect(JSON.stringify(prepared)).not.toContain('ROW_CANARY_ADA');
    expect(() => assertProviderPayloadAllowed(prepared, {
      allowResultRows: false,
      maxResultRows: 0,
      purpose: 'answer_generation',
    })).not.toThrow();
  });

  it('recursively preserves validated JSON Schema arrays only below tools', () => {
    const nestedSchema = {
      type: 'object',
      required: ['mode'],
      properties: {
        mode: { oneOf: [{ enum: ['safe', 'strict'] }, { type: 'null' }] },
        filters: {
          anyOf: [
            { type: 'array', prefixItems: [{ type: 'string', examples: ['region'] }] },
            { allOf: [{ type: 'object' }, { required: ['field'] }] },
          ],
        },
      },
      $defs: { grain: { enum: ['day', 'month'] } },
    };
    const prepared = prepareProviderWireEnvelopeForDispatch('openai', {
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'query', parameters: nestedSchema } }],
      arbitrary: { required: ['ROW_CANARY_REQUIRED'], enum: ['ROW_CANARY_ENUM'] },
    });
    expect((prepared.tools as any[])[0].function.parameters).toEqual(nestedSchema);
    expect(prepared.arbitrary).toEqual({ required: [], enum: [] });
  });

  it('bounds and redacts explicitly opted-in research rows and records no content', () => {
    const input = Array.from({ length: 25 }, (_, index) => ({ customer_name: `Canary ${index}`, amount: index }));
    const rows = redactProviderResultRows(input, 20);
    expect(rows).toHaveLength(20);
    expect(rows[0]).toEqual({ customer_name: '[REDACTED]', amount: 0 });
    const receipt = createProviderEgressReceipt({
      purpose: 'research_narration',
      provider: 'openai',
      permittedCategories: ['question', 'result_rows'],
      optIn: true,
      payload: { sample: rows },
    });
    expect(receipt).toMatchObject({ resultRowCount: 20, columnCount: 2, optIn: true });
    expect(JSON.stringify(receipt)).not.toContain('Canary');
    expect(JSON.stringify(receipt)).not.toContain('[REDACTED]');

    const inaccurateProjection = createProviderEgressReceipt({
      purpose: 'research_tool',
      provider: 'openai',
      permittedCategories: ['result_rows'],
      optIn: true,
      payload: { observation: [{ disguised: 'ROW_CANARY_ADA' }] },
      resultRowCount: 0,
      columnCount: 0,
    });
    expect(inaccurateProjection).toMatchObject({ resultRowCount: 1, columnCount: 1 });
    expect(JSON.stringify(inaccurateProjection)).not.toContain('ROW_CANARY_ADA');

    const localAnalysisRows = redactProviderResultRows(
      Array.from({ length: 240 }, (_, index) => ({ account_email: `canary-${index}@example.test`, amount: index })),
      200,
    );
    expect(localAnalysisRows).toHaveLength(200);
    expect(localAnalysisRows.at(-1)).toEqual({ account_email: '[REDACTED]', amount: 199 });
  });

  it('fingerprints the exact dispatch envelope while retaining inspected serialized-row counts', () => {
    const envelope = prepareProviderWireEnvelopeForDispatch('openai', {
      model: 'provider-model',
      messages: [{ role: 'tool', content: '{"rows":[{"name":"[REDACTED]"}]}' }],
      tools: [],
    });
    const receipt = createProviderDispatchEgressReceipt({
      purpose: 'research_narration',
      provider: 'openai',
      permittedCategories: ['instructions', 'result_rows'],
      optIn: true,
      envelope,
      serializedResultShape: { resultRowCount: 1, columnCount: 1 },
    });
    expect(receipt).toMatchObject({ resultRowCount: 1, columnCount: 1, optIn: true });
    expect(receipt.payloadFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain('provider-model');
    expect(JSON.stringify(receipt)).not.toContain('[REDACTED]');
  });
});

describe('marked tool outputs are vocabulary, not rows', () => {
  // The regression: under a native tool loop every V2 tool result — even
  // `{ finished: true, evidenceIds: [] }` — was reported to the model as a
  // blocked row payload, so it never saw the finish and re-called it until
  // the budget died. The guard keeps its strict reading (a list of strings
  // can be a column of member values); the producer marks what is vocabulary.
  const policy = { allowResultRows: false, maxResultRows: 0, purpose: 'answer_generation' as const };
  const mark = <T,>(value: T): T => {
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) markProviderMetadataArray(value); else markProviderMetadata(value as object);
      for (const nested of Object.values(value as Record<string, unknown>)) mark(nested);
    }
    return value;
  };

  it('lets a marked Ask tool output through', () => {
    expect(() => assertProviderPayloadAllowed(mark({ finished: true, hasResult: true, evidenceIds: [] }), policy)).not.toThrow();
    expect(() => assertProviderPayloadAllowed(mark({ executed: true, rowCount: 10, columns: ['a', 'b'] }), policy)).not.toThrow();
    expect(() => assertProviderPayloadAllowed(mark({ ok: false, safeNextTools: ['compile_and_run_dql'], cards: [{ id: 'a' }] }), policy)).not.toThrow();
  });

  it('still blocks the same shapes when nobody vouched for them', () => {
    expect(() => assertProviderPayloadAllowed({ finished: true, evidenceIds: [] }, policy)).toThrow(/row-shaped/);
    expect(() => assertProviderPayloadAllowed({ rows: [{ customer: 'Ada', revenue: 1 }] }, policy)).toThrow(/row-shaped/);
  });
});
