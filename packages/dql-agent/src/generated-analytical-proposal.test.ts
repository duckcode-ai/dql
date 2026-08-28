import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { answer } from './answer-loop.js';
import { KGStore } from './kg/sqlite-fts.js';
import { buildResolvedAnalyticalPlan } from './resolved-analytical-plan.js';
import {
  validateFrozenRequiredOutputProjection,
  validateGeneratedAnalyticalProposal,
} from './generated-analytical-proposal.js';
import type { AgentEvidenceCandidate, MeaningResolution } from './meaning-resolution.js';
import type { AgentProvider } from './providers/types.js';

const SQL_SIGNATURE_ATTACKS = [
  ['alias-spoofed customer count', `SELECT c.customer_name, COUNT(DISTINCT o.customer_id) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 10`, 'AGGREGATE_EXPRESSION_TUPLE_DRIFT'],
  ['wrong join key', `SELECT c.customer_name, SUM(o.revenue) AS revenue FROM orders o JOIN customers c ON o.order_id = c.customer_id GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 10`, 'JOIN_PREDICATE_TUPLE_DRIFT'],
  ['same-named measure from the wrong relation', `SELECT c.customer_name, SUM(c.revenue) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 10`, 'AGGREGATE_EXPRESSION_TUPLE_DRIFT'],
  ['missing group by', `SELECT c.customer_name, SUM(o.revenue) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id ORDER BY revenue DESC LIMIT 10`, 'GROUPING_TUPLE_DRIFT'],
  ['extra hidden aggregate', `SELECT c.customer_name, SUM(o.revenue) + COUNT(*) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 10`, 'AGGREGATE_EXPRESSION_TUPLE_DRIFT'],
  ['limit overrun', `SELECT c.customer_name, SUM(o.revenue) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 500`, 'LIMIT_TUPLE_DRIFT'],
  ['union bridge', `SELECT c.customer_name, SUM(o.revenue) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.customer_name UNION SELECT customer_name, SUM(revenue) AS revenue FROM archived_orders GROUP BY customer_name`, 'SET_OPERATION_TUPLE_DRIFT'],
  ['early rounding', `SELECT c.customer_name, ROUND(SUM(o.revenue), 0) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 10`, 'AGGREGATE_EXPRESSION_TUPLE_DRIFT'],
  ['filter drift', `SELECT c.customer_name, SUM(o.revenue) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id WHERE c.status = 'active' GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 10`, 'FILTER_TUPLE_DRIFT'],
  ['malformed pasted bridge', `SELECT c.customer_name, COUNT(DISTINCT o.order_id) AS customers FROM order_items oi JOIN orders o ON oi.order_id = o.order_id JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.customer_name ORDER BY customers DESC LIMIT 10`, 'OUTPUT_TUPLE_DRIFT'],
] as const;

describe('generated analytical proposal tuple gate (AGT-013/014/018)', () => {
  it.each(SQL_SIGNATURE_ATTACKS)('blocks %s before SQL', (_label, sql, expectedCode) => {
    const { plan, proposal, contextPack } = fixture();
    const validation = validateGeneratedAnalyticalProposal({
      plan,
      proposal: { ...proposal, sql },
      expectedTargetFingerprint: 'target:jaffle',
      contextPack,
    });
    expect(validation).toMatchObject({
      ok: false,
      message: 'Generated query changed the resolved analytical plan and was not executed',
      driftCodes: expect.arrayContaining([expectedCode]),
    });
  });

  it('accepts an exact parser-owned generated proposal', () => {
    const { plan, proposal, contextPack } = fixture();
    expect(validateGeneratedAnalyticalProposal({
      plan,
      proposal,
      expectedTargetFingerprint: 'target:jaffle',
      contextPack,
    })).toEqual({ ok: true });
  });

  it('AGT-034 denies SQL that omits a host-frozen explicit order/product output', () => {
    const { plan } = fixture();
    const withRequiredOutputs = structuredClone(plan);
    withRequiredOutputs.sourceRelationIds = ['order_items'];
    withRequiredOutputs.outputContract.requiredOutputs = [
      {
        requested: 'order id',
        qualifiedId: 'dbt:column:order_items.order_id',
        outputName: 'order_id',
        status: 'resolved',
        candidateIds: ['dbt:column:order_items.order_id'],
      },
      {
        requested: 'product id',
        qualifiedId: 'dbt:column:order_items.product_id',
        outputName: 'product_id',
        status: 'resolved',
        candidateIds: ['dbt:column:order_items.product_id'],
      },
      {
        requested: 'product price',
        qualifiedId: 'dbt:column:order_items.product_price',
        outputName: 'product_price',
        status: 'resolved',
        candidateIds: ['dbt:column:order_items.product_price'],
      },
    ];

    expect(validateFrozenRequiredOutputProjection({
      plan: withRequiredOutputs,
      sql: `SELECT product_id, product_price
        FROM order_items
        ORDER BY product_price DESC
        LIMIT 5`,
    })).toEqual({
      ok: false,
      expectedOutputs: ['order_id', 'product_id', 'product_price'],
      missingOutputs: ['order_id'],
      bindingMismatches: [],
    });
  });

  it('AGT-034 requires each frozen output alias to prove its exact qualified source column', () => {
    const { plan } = fixture();
    const withRequiredOutputs = structuredClone(plan);
    withRequiredOutputs.sourceRelationIds = ['order_items'];
    withRequiredOutputs.outputContract.requiredOutputs = [
      {
        requested: 'order id',
        qualifiedId: 'dbt:column:order_items.order_id',
        outputName: 'order_id',
        status: 'resolved',
        candidateIds: ['dbt:column:order_items.order_id'],
      },
      {
        requested: 'product id',
        qualifiedId: 'dbt:column:order_items.product_id',
        outputName: 'product_id',
        status: 'resolved',
        candidateIds: ['dbt:column:order_items.product_id'],
      },
      {
        requested: 'product price',
        qualifiedId: 'dbt:column:order_items.product_price',
        outputName: 'product_price',
        status: 'resolved',
        candidateIds: ['dbt:column:order_items.product_price'],
      },
    ];

    expect(validateFrozenRequiredOutputProjection({
      plan: withRequiredOutputs,
      sql: `SELECT product_id AS order_id, product_id, product_price
        FROM order_items
        ORDER BY product_price DESC
        LIMIT 5`,
    })).toEqual({
      ok: false,
      expectedOutputs: ['order_id', 'product_id', 'product_price'],
      missingOutputs: [],
      bindingMismatches: ['order_id'],
    });

    expect(validateFrozenRequiredOutputProjection({
      plan: withRequiredOutputs,
      sql: `SELECT "order_items"."order_id" AS "order_id",
          "order_items"."product_id" AS "product_id",
          "order_items"."product_price" AS "product_price"
        FROM "order_items"
        ORDER BY "product_price" DESC
        LIMIT 5`,
    })).toEqual({
      ok: true,
      expectedOutputs: ['order_id', 'product_id', 'product_price'],
      bindingProofs: [
        {
          version: 1,
          outputName: 'order_id',
          qualifiedId: 'dbt:column:order_items.order_id',
          relation: 'order_items',
          column: 'order_id',
        },
        {
          version: 1,
          outputName: 'product_id',
          qualifiedId: 'dbt:column:order_items.product_id',
          relation: 'order_items',
          column: 'product_id',
        },
        {
          version: 1,
          outputName: 'product_price',
          qualifiedId: 'dbt:column:order_items.product_price',
          relation: 'order_items',
          column: 'product_price',
        },
      ],
    });
  });

  it('AGT-034 accepts the compact frozen physical-column IDs emitted by local metadata without accepting an alias spoof', () => {
    const { plan } = fixture();
    const withCompactPhysicalOutputs = structuredClone(plan);
    withCompactPhysicalOutputs.sourceRelationIds = ['jaffle_shop.dev.order_items'];
    withCompactPhysicalOutputs.outputContract.requiredOutputs = [
      {
        requested: 'order id',
        qualifiedId: 'order_items.order_id',
        outputName: 'order_id',
        status: 'resolved',
        candidateIds: ['order_items.order_id'],
      },
      {
        requested: 'product id',
        qualifiedId: 'order_items.product_id',
        outputName: 'product_id',
        status: 'resolved',
        candidateIds: ['order_items.product_id'],
      },
      {
        requested: 'product price',
        qualifiedId: 'order_items.product_price',
        outputName: 'product_price',
        status: 'resolved',
        candidateIds: ['order_items.product_price'],
      },
    ];

    expect(validateFrozenRequiredOutputProjection({
      plan: withCompactPhysicalOutputs,
      sql: `SELECT order_items.order_id AS order_id,
          order_items.product_id AS product_id,
          order_items.product_price AS product_price
        FROM order_items
        ORDER BY product_price DESC
        LIMIT 5`,
    })).toMatchObject({
      ok: true,
      bindingProofs: [
        expect.objectContaining({ relation: 'order_items', column: 'order_id' }),
        expect.objectContaining({ relation: 'order_items', column: 'product_id' }),
        expect.objectContaining({ relation: 'order_items', column: 'product_price' }),
      ],
    });

    // The runtime qualifies the provider's bare FROM leaf to this exact
    // target-bound frozen relation before minting the execution capability.
    // The proof remains source-specific, so another schema's `order_items`
    // cannot borrow the same column aliases.
    expect(validateFrozenRequiredOutputProjection({
      plan: withCompactPhysicalOutputs,
      sql: `SELECT order_items.order_id AS order_id,
          order_items.product_id AS product_id,
          order_items.product_price AS product_price
        FROM jaffle_shop.dev.order_items
        ORDER BY product_price DESC
        LIMIT 5`,
    })).toMatchObject({ ok: true });

    // Packaged local Ask runs retain both the compact dbt/runtime identity and
    // the target-bound identifier in the frozen closure. The provider is
    // allowed to use a parser-resolved SQL alias for that one exact source;
    // it is not a second same-leaf relation and must not make the three
    // explicit output bindings look ambiguous.
    const withTargetBoundCompactDuplicate = structuredClone(withCompactPhysicalOutputs);
    withTargetBoundCompactDuplicate.sourceRelationIds = [
      '"jaffle_shop"."dev"."order_items"',
      'order_items',
    ];
    expect(validateFrozenRequiredOutputProjection({
      plan: withTargetBoundCompactDuplicate,
      sql: `SELECT oi.order_id AS order_id,
          oi.product_id AS product_id,
          oi.product_price AS product_price
        FROM "jaffle_shop"."dev"."order_items" AS oi
        ORDER BY product_price DESC
        LIMIT 5`,
    })).toMatchObject({
      ok: true,
      bindingProofs: [
        expect.objectContaining({ relation: 'order_items', column: 'order_id' }),
        expect.objectContaining({ relation: 'order_items', column: 'product_id' }),
        expect.objectContaining({ relation: 'order_items', column: 'product_price' }),
      ],
    });

    // The local dbt manifest and active runtime target can retain
    // `catalog.main.table` and `catalog.dev.table` for the exact same frozen
    // dbt model.  The compact output IDs remain source-bound only because the
    // qualified selected model proves that narrow alias pair; either mapping
    // alone would be ambiguous without that immutable identity.
    const withFrozenLocalDbtRuntimeAliases = structuredClone(withCompactPhysicalOutputs);
    withFrozenLocalDbtRuntimeAliases.sourceRelationIds = [
      'jaffle_shop.main.order_items',
      'jaffle_shop.dev.order_items',
    ];
    withFrozenLocalDbtRuntimeAliases.selectedConceptIds = [
      'dbt::model.jaffle_shop.order_items',
    ];
    expect(validateFrozenRequiredOutputProjection({
      plan: withFrozenLocalDbtRuntimeAliases,
      sql: `SELECT oi.order_id AS order_id,
          oi.product_id AS product_id,
          oi.product_price AS product_price
        FROM jaffle_shop.dev.order_items AS oi
        ORDER BY oi.product_price DESC
        LIMIT 5`,
    })).toMatchObject({ ok: true });

    const withoutFrozenLocalDbtModel = structuredClone(withFrozenLocalDbtRuntimeAliases);
    withoutFrozenLocalDbtModel.selectedConceptIds = ['dbt:model:order_items'];
    expect(validateFrozenRequiredOutputProjection({
      plan: withoutFrozenLocalDbtModel,
      sql: `SELECT oi.order_id AS order_id,
          oi.product_id AS product_id,
          oi.product_price AS product_price
        FROM jaffle_shop.dev.order_items AS oi
        ORDER BY oi.product_price DESC
        LIMIT 5`,
    })).toMatchObject({
      ok: false,
      bindingMismatches: ['order_id', 'product_id', 'product_price'],
    });

    // Duplicate output aliases are parser-invalid and must never be treated
    // as a proof for one frozen output binding.
    expect(validateFrozenRequiredOutputProjection({
      plan: withTargetBoundCompactDuplicate,
      sql: `SELECT oi.order_id AS order_id,
          oi.order_id AS order_id,
          oi.product_id AS product_id,
          oi.product_price AS product_price
        FROM "jaffle_shop"."dev"."order_items" AS oi
        ORDER BY product_price DESC
        LIMIT 5`,
    })).toMatchObject({ ok: false });

    expect(validateFrozenRequiredOutputProjection({
      plan: withCompactPhysicalOutputs,
      sql: `SELECT order_items.order_id AS order_id,
          order_items.product_id AS product_id,
          order_items.product_price AS product_price
        FROM another_catalog.dev.order_items
        ORDER BY product_price DESC
        LIMIT 5`,
    })).toMatchObject({
      ok: false,
      missingOutputs: [],
      bindingMismatches: ['order_id', 'product_id', 'product_price'],
    });

    // A compact `order_items.column` proof cannot choose between two frozen
    // catalog/schema relations with the same leaf. The provider must not be
    // able to borrow catalog_a merely because it appears in the closure; the
    // host needs an exact frozen source relation in that case.
    const withAmbiguousCompactPhysicalOutputs = structuredClone(withCompactPhysicalOutputs);
    withAmbiguousCompactPhysicalOutputs.sourceRelationIds = [
      'catalog_a.dev.order_items',
      'catalog_b.dev.order_items',
    ];
    expect(validateFrozenRequiredOutputProjection({
      plan: withAmbiguousCompactPhysicalOutputs,
      sql: `SELECT order_items.order_id AS order_id,
          order_items.product_id AS product_id,
          order_items.product_price AS product_price
        FROM catalog_a.dev.order_items
        ORDER BY product_price DESC
        LIMIT 5`,
    })).toMatchObject({
      ok: false,
      missingOutputs: [],
      bindingMismatches: ['order_id', 'product_id', 'product_price'],
    });

    // Persisting the exact source relation restores a proof without relaxing
    // the ambiguous compact form above.
    const withExactQualifiedPhysicalOutputs = structuredClone(withAmbiguousCompactPhysicalOutputs);
    withExactQualifiedPhysicalOutputs.outputContract.requiredOutputs =
      withExactQualifiedPhysicalOutputs.outputContract.requiredOutputs.map((binding) => ({
        ...binding,
        qualifiedId: `catalog_a.dev.order_items.${binding.outputName}`,
        candidateIds: [`catalog_a.dev.order_items.${binding.outputName}`],
      }));
    expect(validateFrozenRequiredOutputProjection({
      plan: withExactQualifiedPhysicalOutputs,
      sql: `SELECT order_items.order_id AS order_id,
          order_items.product_id AS product_id,
          order_items.product_price AS product_price
        FROM catalog_a.dev.order_items
        ORDER BY product_price DESC
        LIMIT 5`,
    })).toMatchObject({ ok: true });

    expect(validateFrozenRequiredOutputProjection({
      plan: withExactQualifiedPhysicalOutputs,
      sql: `SELECT order_items.order_id AS order_id,
          order_items.product_id AS product_id,
          order_items.product_price AS product_price
        FROM catalog_b.dev.order_items
        ORDER BY product_price DESC
        LIMIT 5`,
    })).toMatchObject({
      ok: false,
      missingOutputs: [],
      bindingMismatches: ['order_id', 'product_id', 'product_price'],
    });

    // An exact persisted source also cannot borrow a sole, but different,
    // selected relation with the same leaf.
    const withExactSourceOutsideClosure = structuredClone(withExactQualifiedPhysicalOutputs);
    withExactSourceOutsideClosure.sourceRelationIds = ['catalog_b.dev.order_items'];
    expect(validateFrozenRequiredOutputProjection({
      plan: withExactSourceOutsideClosure,
      sql: `SELECT order_items.order_id AS order_id,
          order_items.product_id AS product_id,
          order_items.product_price AS product_price
        FROM catalog_a.dev.order_items
        ORDER BY product_price DESC
        LIMIT 5`,
    })).toMatchObject({
      ok: false,
      missingOutputs: [],
      bindingMismatches: ['order_id', 'product_id', 'product_price'],
    });

    expect(validateFrozenRequiredOutputProjection({
      plan: withCompactPhysicalOutputs,
      sql: `SELECT order_items.product_id AS order_id,
          order_items.product_id AS product_id,
          order_items.product_price AS product_price
        FROM order_items
        ORDER BY product_price DESC
        LIMIT 5`,
    })).toMatchObject({
      ok: false,
      missingOutputs: [],
      bindingMismatches: ['order_id'],
    });
  });

  it('rejects the malformed pasted bridge query for extra customers, wrong order, missing revenue, and relation drift', () => {
    const { plan, proposal, contextPack } = fixture();
    const malformed = validateGeneratedAnalyticalProposal({
      plan,
      expectedTargetFingerprint: 'target:jaffle',
      contextPack,
      proposal: {
        ...proposal,
        sql: `SELECT c.customer_name, COUNT(DISTINCT o.order_id) AS customers
          FROM order_items oi
          JOIN orders o ON oi.order_id = o.order_id
          JOIN customers c ON o.customer_id = c.customer_id
          GROUP BY c.customer_name
          ORDER BY customers DESC
          LIMIT 10`,
      },
    });
    expect(malformed).toMatchObject({
      ok: false,
      message: 'Generated query changed the resolved analytical plan and was not executed',
      driftCodes: expect.arrayContaining([
        'OUTPUT_TUPLE_DRIFT',
        'ORDER_TUPLE_DRIFT',
        'RELATION_TUPLE_DRIFT',
        'JOIN_PREDICATE_TUPLE_DRIFT',
      ]),
    });
  });

  it.each(SQL_SIGNATURE_ATTACKS)('blocks %s at the production boundary with zero SQL and artifact presentation', async (_label, sql, expectedCode) => {
    const dir = mkdtempSync(join(tmpdir(), 'dql-generated-tuple-'));
    const kg = new KGStore(join(dir, 'kg.sqlite'));
    try {
      kg.rebuild([], []);
      const { plan, contextPack } = fixture();
      const generatedPlan = structuredClone(plan);
      generatedPlan.capability = 'bounded_exploration';
      generatedPlan.recommendedRoute = 'exploratory';
      const executeGeneratedSql = vi.fn();
      const captureGeneratedDraft = vi.fn();
      const provider: AgentProvider = {
        name: 'openai',
        available: async () => true,
        generate: async () => JSON.stringify({
          summary: 'Generated analytical proposal.',
          sql,
          outputs: ['customer_name', 'revenue'],
        }),
      };
      const result = await answer({
        question: 'who are the top customers by revenue',
        provider,
        kg,
        resolvedAnalyticalPlan: generatedPlan,
        generatedProposalTargetFingerprint: 'target:jaffle',
        contextPack,
        schemaContext: [
          { relation: 'order_items', name: 'order_items', columns: [{ name: 'order_id', type: 'string' }] },
          { relation: 'orders', name: 'orders', columns: [{ name: 'order_id', type: 'string' }, { name: 'customer_id', type: 'string' }] },
          { relation: 'customers', name: 'customers', columns: [{ name: 'customer_id', type: 'string' }, { name: 'customer_name', type: 'string' }] },
        ],
        executeGeneratedSql,
        captureGeneratedDraft,
      });

      expect(result.text).toBe('Generated query changed the resolved analytical plan and was not executed');
      expect(result.refusalDetails).toMatchObject({ code: 'GENERATED_ANALYTICAL_TUPLE_DRIFT', message: expect.stringContaining(expectedCode) });
      expect(executeGeneratedSql).not.toHaveBeenCalled();
      expect(captureGeneratedDraft).not.toHaveBeenCalled();
      expect(result.result).toBeUndefined();
      expect(result.dqlArtifact).toBeUndefined();
      expect(result.draftBlock).toBeUndefined();
    } finally {
      kg.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('executes one safe exact generated proposal through the same production boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dql-generated-safe-'));
    const kg = new KGStore(join(dir, 'kg.sqlite'));
    try {
      kg.rebuild([], []);
      const { plan, proposal, contextPack } = fixture();
      const generatedPlan = structuredClone(plan);
      generatedPlan.capability = 'bounded_exploration';
      generatedPlan.recommendedRoute = 'exploratory';
      const executeGeneratedSql = vi.fn(async (sql: string) => ({
        columns: ['customer_name', 'revenue'],
        rows: [{ customer_name: 'Alice', revenue: 120 }],
        rowCount: 1,
        sql,
      }));
      const provider: AgentProvider = {
        name: 'openai',
        available: async () => true,
        generate: async () => JSON.stringify({
          summary: 'Top customers by revenue.',
          sql: proposal.sql,
          outputs: ['customer_name', 'revenue'],
        }),
      };
      const result = await answer({
        question: 'who are the top customers by revenue',
        provider,
        kg,
        contextPack,
        resolvedAnalyticalPlan: generatedPlan,
        generatedProposalTargetFingerprint: 'target:jaffle',
        schemaContext: [
          { relation: 'orders', name: 'orders', columns: [{ name: 'revenue', type: 'number' }, { name: 'customer_id', type: 'string' }] },
          { relation: 'customers', name: 'customers', columns: [{ name: 'customer_id', type: 'string' }, { name: 'customer_name', type: 'string' }] },
        ],
        executeGeneratedSql,
      });

      expect(executeGeneratedSql).toHaveBeenCalledTimes(1);
      expect(executeGeneratedSql).toHaveBeenCalledWith(proposal.sql, expect.anything());
      expect(result.result).toMatchObject({ rowCount: 1, columns: ['customer_name', 'revenue'] });
    } finally {
      kg.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AGT-034 executes the packaged order-item proposal once when compact and target-bound output sources describe the same frozen relation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dql-generated-order-item-output-proof-'));
    const kg = new KGStore(join(dir, 'kg.sqlite'));
    try {
      kg.rebuild([], []);
      const { plan: basePlan, contextPack: baseContextPack } = fixture();
      const question = 'Show the five most expensive individual order items with order ID, product ID, and product price.';
      const plan = structuredClone(basePlan) as any;
      // This is the authority shape persisted by the packaged local runtime:
      // target-bound execution identity plus the compact metadata identity.
      // The required outputs remain compact qualified dbt/runtime columns.
      plan.schemaVersion = 1;
      delete plan.analyticalFrame;
      plan.planId = 'rap:packaged-order-items';
      plan.fingerprint = 'f'.repeat(64);
      plan.executionId = 'run:packaged-order-items:initial';
      plan.capability = 'bounded_exploration';
      plan.recommendedRoute = 'exploratory';
      plan.selectedConceptIds = ['dbt:model:order_items'];
      plan.sourceRelationIds = ['"jaffle_shop"."dev"."order_items"', 'order_items'];
      plan.relationshipPathIds = [];
      plan.query = {
        measures: [{
          requested: 'product price',
          qualifiedId: 'order_items.product_price',
          status: 'resolved',
          candidateIds: ['order_items.product_price'],
        }],
        dimensions: [],
        filters: [],
        order: 'desc',
        limit: 5,
      };
      plan.outputContract = {
        measures: ['product_price'],
        dimensions: [],
        requiredOutputs: [
          { requested: 'order id', qualifiedId: 'order_items.order_id', outputName: 'order_id', status: 'resolved', candidateIds: ['order_items.order_id'] },
          { requested: 'product id', qualifiedId: 'order_items.product_id', outputName: 'product_id', status: 'resolved', candidateIds: ['order_items.product_id'] },
          { requested: 'product price', qualifiedId: 'order_items.product_price', outputName: 'product_price', status: 'resolved', candidateIds: ['order_items.product_price'] },
        ],
      };
      const contextPack = structuredClone(baseContextPack) as any;
      contextPack.question = question;
      contextPack.questionPlan = {
        ...contextPack.questionPlan,
        question,
        normalizedQuestion: question.toLowerCase(),
        metricTerms: ['product price'],
        dimensionTerms: [],
        requestedShape: {
          dimensions: [],
          measures: ['product price'],
          requiredOutputs: ['order id', 'product id', 'product price'],
          filters: [],
          followUpReferences: [],
        },
      };
      contextPack.objects = [{
        objectKey: 'dbt:model:order_items',
        objectType: 'model',
        name: 'order_items',
        fullName: 'order_items',
        payload: { relation: 'order_items', sourceObjects: ['order_items'] },
      }];
      contextPack.allowedSqlContext = {
        relations: [{
          objectKey: 'dbt:model:order_items',
          relation: 'order_items',
          name: 'order_items',
          source: 'dbt manifest',
          columns: [
            { name: 'order_id', type: 'number' },
            { name: 'product_id', type: 'number' },
            { name: 'product_price', type: 'number' },
          ],
        }],
        sourceBlockSql: [],
      };
      const sql = [
        'SELECT oi.order_id AS order_id, oi.product_id AS product_id, oi.product_price AS product_price',
        'FROM order_items AS oi',
        'ORDER BY oi.product_price DESC',
        'LIMIT 5',
      ].join('\n');
      const provider: AgentProvider = {
        name: 'openai',
        available: async () => true,
        generate: vi.fn(async () => JSON.stringify({
          summary: 'The five most expensive individual order items.',
          sql,
          outputs: ['order_id', 'product_id', 'product_price'],
        })),
      };
      const capability = {
        version: 1 as const,
        runId: 'run:packaged-order-items',
        executionId: plan.executionId,
        snapshotId: plan.snapshotId,
        planId: plan.planId,
        targetFingerprint: 'target:jaffle-order-items',
        bindingsFingerprint: 'bindings:jaffle-order-items',
        candidateSqlFingerprint: 'sql:jaffle-order-items',
        provenIdentifiers: ['order_items', 'order_items.order_id', 'order_items.product_id', 'order_items.product_price'],
        evidence: {
          order_items: 'schema_tool' as const,
          'order_items.order_id': 'schema_tool' as const,
          'order_items.product_id': 'schema_tool' as const,
          'order_items.product_price': 'schema_tool' as const,
        },
        exploratoryAuthorizationAttempt: { version: 1 as const, index: 0 as const },
      };
      const freeze = {
        version: 1 as const,
        selectedTier: 'exploratory_sql' as const,
        planId: plan.planId,
        planFingerprint: plan.fingerprint,
        snapshotId: plan.snapshotId,
        targetFingerprint: capability.targetFingerprint,
        sqlFingerprint: 'a'.repeat(32),
        candidateIds: ['dbt:model:order_items'],
        authorization: 'capability_minted' as const,
        requiredOutputBindings: [
          { version: 1 as const, outputName: 'order_id', qualifiedId: 'order_items.order_id', relation: 'order_items', column: 'order_id' },
          { version: 1 as const, outputName: 'product_id', qualifiedId: 'order_items.product_id', relation: 'order_items', column: 'product_id' },
          { version: 1 as const, outputName: 'product_price', qualifiedId: 'order_items.product_price', relation: 'order_items', column: 'product_price' },
        ],
        authorizationAttempt: { version: 1 as const, index: 0 as const },
      };
      const prepareExploratorySqlExecution = vi.fn(async (proposalSql: string) => {
        expect(proposalSql).toBe(sql);
        return { capability, freeze };
      });
      const executeAgenticGeneratedSql = vi.fn(async () => ({
        columns: ['order_id', 'product_id', 'product_price'],
        rows: [
          { order_id: 1, product_id: 2, product_price: 13.5 },
          { order_id: 2, product_id: 3, product_price: 12 },
          { order_id: 3, product_id: 4, product_price: 12 },
          { order_id: 4, product_id: 5, product_price: 12 },
          { order_id: 5, product_id: 6, product_price: 12 },
        ],
        rowCount: 5,
        sql,
      }));
      const result = await answer({
        question,
        provider,
        kg,
        contextPack,
        selectedCascadeTier: 'exploratory_sql',
        exploratoryCandidateIds: ['dbt:model:order_items'],
        resolvedAnalyticalPlan: plan,
        prepareExploratorySqlExecution,
        executeAgenticGeneratedSql,
      });

      expect(provider.generate).toHaveBeenCalledTimes(1);
      expect(prepareExploratorySqlExecution).toHaveBeenCalledTimes(1);
      expect(executeAgenticGeneratedSql).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        kind: 'uncertified',
        certification: 'ai_generated',
        reviewStatus: 'draft_ready',
        result: {
          columns: ['order_id', 'product_id', 'product_price'],
          rowCount: 5,
        },
      });
    } finally {
      kg.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fixture() {
  const metricId = 'semantic:metric:order.revenue';
  const dimensionId = 'semantic:dimension:customer_name';
  const capability = {
    metricId,
    semanticModelId: 'orders',
    measureIds: ['semantic:measure:order.revenue'],
    primaryEntityId: 'order',
    defaultResultGrainId: 'order',
    resultGrainIds: ['order', 'customer'],
    aggregation: 'sum',
    additivity: { entities: 'additive' as const, time: 'additive' as const },
    dimensions: [{
      dimensionId,
      entityId: 'customer',
      supportedRoles: ['group_by' as const, 'rank_entity' as const],
      relationshipPathIds: ['relationship:orders_to_customers'],
    }],
    timeDimensions: [],
    operations: ['group' as const, 'rank' as const],
    supportedOutputKinds: ['dimension' as const, 'metric_value' as const],
    // This fixture exercises the frozen exploratory authorization boundary.
    // Keep the frozen route itself exploratory so its safe relationship path
    // is authoritative; a semantic route intentionally cannot borrow a DQL
    // relationship ID as MetricFlow compiler proof.
    executionCapabilities: [{ route: 'exploratory' as const, adapterId: 'native' }],
    sourceFingerprint: 'capability:order-revenue',
  };
  const candidate: AgentEvidenceCandidate = {
    id: metricId,
    qualifiedId: metricId,
    kind: 'semantic_metric',
    trustTier: 'semantic',
    name: 'Revenue',
    aliases: ['revenue'],
    sourceObjects: ['dbt:model:orders', 'dbt:model:customers'],
    relevanceScore: 1,
    matchReasons: ['exact metric'],
    compatibility: 'compatible',
    analyticalCapability: capability,
  };
  const resolution: MeaningResolution = {
    interpretedQuestion: 'Who are the top customers by revenue?',
    questionType: 'ranking',
    selectedConceptIds: [metricId],
    recommendedExecutionId: metricId,
    queryIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
    rejectedCandidates: [],
    confidence: 'high',
    missingInformation: [],
    recommendedRoute: 'exploratory',
    analyticalFrame: {
      version: 2,
      interpretedQuestion: 'Who are the top customers by revenue?',
      questionType: 'ranking',
      metricConceptIds: [metricId],
      entityGrainIds: ['customer'],
      dimensions: [{ dimensionId, role: 'group_by' }, { dimensionId, role: 'rank_entity' }],
      memberBindings: [],
      ranking: {
        entityDimensionId: dimensionId,
        byMetricId: metricId,
        direction: 'desc',
        limit: 10,
        tiePolicy: 'stable_secondary_key',
      },
      requestedOutputs: [
        { id: 'customer_name', kind: 'dimension' },
        { id: 'revenue', kind: 'metric_value', metricId },
      ],
      ambiguity: [],
    },
  };
  const plan = buildResolvedAnalyticalPlan({
    question: resolution.interpretedQuestion,
    resolution,
    evidence: { snapshotId: 'snapshot:jaffle', candidates: [candidate] },
    candidates: [candidate],
    mode: 'authoritative',
  });
  return {
    plan,
    proposal: {
      version: 1 as const,
      planId: plan.planId,
      planFingerprint: plan.fingerprint,
      snapshotId: plan.snapshotId,
      executionId: plan.executionId!,
      capabilityFingerprint: plan.selectedCapabilityFingerprint!,
      targetFingerprint: 'target:jaffle',
      sql: `SELECT c.customer_name AS customer_name, SUM(o.revenue) AS revenue
        FROM orders o JOIN customers c ON o.customer_id = c.customer_id
        GROUP BY c.customer_name ORDER BY revenue DESC LIMIT 10`,
    },
    contextPack: {
      id: 'context:jaffle-generated',
      question: resolution.interpretedQuestion,
      focusObjectKey: null,
      mode: 'question',
      trustLabel: 'mixed',
      questionPlan: {
        question: resolution.interpretedQuestion,
        normalizedQuestion: resolution.interpretedQuestion.toLowerCase(),
        mode: 'general_analysis',
        routeIntent: 'ad_hoc_ranking',
        entities: [],
        metricTerms: ['revenue'],
        dimensionTerms: ['customer_name'],
        filterTerms: [],
        timeTerms: [],
        outputShape: 'table',
        needsGeneratedSql: true,
        shouldConsiderCertifiedExact: false,
        needsResearchWorkspace: false,
        searchQueries: [resolution.interpretedQuestion],
        searchTerms: ['revenue', 'customer_name'],
        requestedShape: { dimensions: ['customer_name'], measures: ['revenue'], requiredOutputs: ['customer_name', 'revenue'], filters: [], followUpReferences: [] },
        confidence: 1,
        reasons: ['frozen authoritative plan'],
      },
      objects: [{
        objectKey: 'relationship:orders_to_customers',
        objectType: 'relationship',
        name: 'orders_to_customers',
        payload: {
          fromRelation: 'orders',
          toRelation: 'customers',
          keys: [{ from: 'customer_id', to: 'customer_id' }],
          cardinality: 'many_to_one',
          fanout: 'safe',
        },
      }],
      skills: [],
      edges: [],
      queryRuns: [],
      citations: [],
      evidenceSummaries: [],
      warnings: [],
      routeDecision: {
        route: 'generated_sql',
        intent: 'ad_hoc_ranking',
        reason: 'Use the frozen bounded proposal authority.',
        trustLabel: 'mixed',
        reviewStatus: 'draft_ready',
        selectedEvidence: [],
        missingContext: [],
        followUps: [],
      },
      evidenceRoles: [],
      allowedSqlContext: {
        relations: [
          { relation: 'orders', name: 'orders', source: 'semantic layer', columns: [{ name: 'revenue', type: 'number' }, { name: 'customer_id', type: 'string' }] },
          { relation: 'customers', name: 'customers', source: 'semantic layer', columns: [{ name: 'customer_id', type: 'string' }, { name: 'customer_name', type: 'string' }] },
        ],
        sourceBlockSql: [],
      },
      missingContext: [],
      conflicts: [],
      appliedHints: [],
      hintConflicts: [],
      retrievalDiagnostics: {
        strategy: 'sqlite_fts',
        selectedObjects: 1,
        selectedEvidence: [],
        selectedRelations: [],
        selectedJoinPaths: [{
          leftRelation: 'orders',
          leftColumn: 'customer_id',
          rightRelation: 'customers',
          rightColumn: 'customer_id',
          reason: 'frozen relationship:orders_to_customers',
          confidence: 1,
          source: 'dql_relationship',
        }],
        topRejected: [],
        certifiedCandidateFits: [],
        candidateConflicts: [],
      },
      freshness: { catalogPath: '/tmp/metadata.sqlite', builtAt: null, fingerprint: 'snapshot:jaffle' },
    } as any,
  };
}
