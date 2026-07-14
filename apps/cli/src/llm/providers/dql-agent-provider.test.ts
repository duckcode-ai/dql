import { describe, expect, it } from 'vitest';
import { __test__, resolveEffectiveQuestion } from './dql-agent-provider.js';
import type { AgentRunRequest } from '../types.js';
import { dqlToolNamesForSurface, type AgentMessage, type AgentProvider } from '@duckcodeailabs/dql-agent';

function req(messages: Array<{ role: 'user' | 'assistant'; content: string }>): AgentRunRequest {
  return { provider: 'ollama', messages, projectRoot: '/tmp/x' } as AgentRunRequest;
}

describe('resolveEffectiveQuestion — clarify follow-up folding', () => {
  it('folds the original question with the clarification answer', () => {
    const out = resolveEffectiveQuestion(req([
      { role: 'user', content: 'Can you give me total revenue based on most products performed?' },
      { role: 'assistant', content: 'Needs clarification before a governed answer can be produced. For "…", which business object and measure should I use, and at what grain?' },
      { role: 'user', content: 'I need product details with name' },
    ]));
    expect(out).toContain('Can you give me total revenue based on most products performed?');
    expect(out).toContain('clarification: I need product details with name');
  });

  it('returns the current message unchanged when the prior assistant turn was NOT a clarification', () => {
    const out = resolveEffectiveQuestion(req([
      { role: 'user', content: 'what is total revenue?' },
      { role: 'assistant', content: 'Revenue is $2.8M this quarter.' },
      { role: 'user', content: 'now break it down by region' },
    ]));
    expect(out).toBe('now break it down by region');
  });

  it('returns the single user message when there is no prior turn', () => {
    expect(resolveEffectiveQuestion(req([{ role: 'user', content: 'top products by revenue' }]))).toBe('top products by revenue');
  });

  it('does not merge when the original equals the current answer', () => {
    const out = resolveEffectiveQuestion(req([
      { role: 'user', content: 'revenue by product' },
      { role: 'assistant', content: 'I need one more detail before querying: which metric should define the answer?' },
      { role: 'user', content: 'revenue by product' },
    ]));
    expect(out).toBe('revenue by product');
  });
});

describe('answer-loop tool surface', () => {
  it('uses the canonical registry surface instead of a provider-local allowlist', () => {
    const tools = __test__.buildAnswerLoopTools('/tmp/dql-agent-provider-tools');
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual([
      ...dqlToolNamesForSurface("answer_loop"),
      "search_project_files",
      "list_notebook_datasets",
      "describe_notebook_dataset",
      "sample_notebook_dataset",
      "propose_cross_source_join",
      "execute_local_analysis",
    ]);
    expect(names).toEqual(
      expect.arrayContaining([
        "expand_context",
        "search_metadata",
        "get_table_schema",
        "validate_sql",
        "search_project_files",
        "list_notebook_datasets",
        "describe_notebook_dataset",
        "sample_notebook_dataset",
        "propose_cross_source_join",
        "execute_local_analysis",
      ]),
    );
    expect(names).not.toEqual(
      expect.arrayContaining([
        "ask_dql",
        "query_via_metadata",
        "query_via_block",
      ]),
    );
  });
});

describe('lazy schema loading', () => {
  const pack = (overrides: Record<string, unknown> = {}) => ({
    routeDecision: { route: 'generated_sql' },
    questionPlan: { requestedShape: { filters: [] } },
    objects: [],
    allowedSqlContext: { relations: [{ relation: 'analytics.orders' }], sourceBlockSql: [] },
    ...overrides,
  } as never);

  it('does not touch the warehouse for certified or catalog-grounded questions', () => {
    expect(__test__.shouldLoadSchemaContext(pack({ routeDecision: { route: 'certified' } }), true)).toBe(false);
    expect(__test__.shouldLoadSchemaContext(pack(), false)).toBe(false);
  });

  it('defers semantic questions but loads schema for unresolved filters or empty context', () => {
    expect(__test__.shouldLoadSchemaContext(pack({ objects: [{ objectType: 'metric' }] }), true)).toBe(false);
    expect(__test__.shouldLoadSchemaContext(pack({
      questionPlan: { requestedShape: { filters: ['enterprise'] } },
    }), true)).toBe(true);
    expect(__test__.shouldLoadSchemaContext(pack({
      allowedSqlContext: { relations: [], sourceBlockSql: [] },
    }), false)).toBe(true);
  });

  it('uses live source search only when indexed retrieval is thin', () => {
    expect(__test__.shouldSearchProjectFiles(pack({ routeDecision: { route: 'certified' } }))).toBe(false);
    expect(__test__.shouldSearchProjectFiles(pack({
      objects: [{ objectType: 'metric' }, { objectType: 'semantic_model' }],
    }))).toBe(false);
    expect(__test__.shouldSearchProjectFiles(pack({
      objects: [],
      allowedSqlContext: { relations: [], sourceBlockSql: [] },
    }))).toBe(true);
  });

  it('renders bounded source matches as advisory context', () => {
    expect(__test__.renderProjectSourceSearch({
      matches: [{ path: 'semantic/metrics.yml', line: 4, text: 'name: net_revenue' }],
    })).toContain('semantic/metrics.yml:4');
  });
});

describe('governed answer formatting', () => {
  it('formats the terminal cascade lane for CLI and agent traces', () => {
    expect(__test__.formatCascadeOutcome({
      terminalLane: 'semantic',
      routeTier: 'semantic_metric',
      label: 'Lane 2 semantic DQL artifact was terminal',
      outcome: { lane: 'semantic', routeTier: 'semantic_metric' },
    })).toBe('Lane 2 semantic · Semantic metric');

    expect(__test__.formatCascadeOutcome({
      terminalLane: 'generated',
      routeTier: 'generated_sql',
      label: 'Lane 3 generated DQL artifact was terminal',
      outcome: { lane: 'generated', routeTier: 'generated_sql', hasSqlPreview: true, executionStatus: 'executed' },
    })).toBe('Lane 3 generated · Generated SQL');
  });
});

describe('conversation context follow-up routing', () => {
  it('resolves "these categories" to prior result values and dimensions', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'who are the top 5 customers for these categories?' }],
      conversationContext: {
        sourceCertifiedBlock: 'food_vs_drink_revenue',
        sourceQuestion: 'Revenue by food vs drink',
        sourceAnswerSummary: 'Food and Drink revenue split.',
        resultColumns: ['category', 'revenue'],
        resultDimensionValues: { category: ['Food', 'Drink'] },
        priorMeasures: ['revenue'],
      },
    } as AgentRunRequest, 'who are the top 5 customers for these categories?');

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      sourceBlockName: 'food_vs_drink_revenue',
      filters: ['Food', 'Drink'],
      dimensions: ['category'],
      priorResultColumns: ['category', 'revenue'],
      priorResultValues: { category: ['Food', 'Drink'] },
      priorMeasures: ['revenue'],
    });
  });

  it('resolves bare "those" when prior values have one clear dimension', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'who are the top 5 customers for those?' }],
      conversationContext: {
        sourceCertifiedBlock: 'food_vs_drink_revenue',
        sourceQuestion: 'Revenue by food vs drink',
        sourceAnswerSummary: 'Food and Drink revenue split.',
        resultColumns: ['category', 'revenue'],
        resultDimensionValues: { category: ['Food', 'Drink'] },
        priorMeasures: ['revenue'],
      },
    } as AgentRunRequest, 'who are the top 5 customers for those?');

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      filters: ['Food', 'Drink'],
      dimensions: ['category'],
      priorResultValues: { category: ['Food', 'Drink'] },
    });
  });

  it('resolves singular "this product" to the top prior product value', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'who are the customers for this product?' }],
      conversationContext: {
        sourceQuestion: 'Top products by revenue',
        sourceAnswerSummary: 'Revenue is concentrated in top drink products.',
        resultColumns: ['product_name', 'category', 'revenue', 'units'],
        resultDimensionValues: {
          product_name: ['for richer or pourover', 'vanilla ice'],
          category: ['Drink'],
        },
        priorMeasures: ['revenue'],
      },
    } as AgentRunRequest, 'who are the customers for this product?');

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      filters: ['for richer or pourover'],
      dimensions: ['product'],
      priorResultColumns: ['product_name', 'category', 'revenue', 'units'],
      priorResultValues: {
        product_name: ['for richer or pourover', 'vanilla ice'],
        category: ['Drink'],
      },
      priorMeasures: ['revenue'],
    });
  });

  it('resolves misspelled category follow-up over prior customers', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'what are the product catagories for these customers' }],
      conversationContext: {
        sourceQuestion: 'Top products by revenue with customers',
        sourceAnswerSummary: 'Product/customer revenue view.',
        resultColumns: ['product_name', 'category', 'customer_name', 'revenue', 'units'],
        resultDimensionValues: {
          product_name: ['for richer or pourover', 'vanilla ice'],
          category: ['Drink'],
          customer_name: ['Mr. Matthew Meyer', 'Aaron Gardner'],
        },
        priorMeasures: ['revenue'],
      },
    } as AgentRunRequest, 'what are the product catagories for these customers');

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      filters: ['Mr. Matthew Meyer', 'Aaron Gardner'],
      priorResultColumns: ['product_name', 'category', 'customer_name', 'revenue', 'units'],
      priorResultValues: {
        product_name: ['for richer or pourover', 'vanilla ice'],
        category: ['Drink'],
        customer_name: ['Mr. Matthew Meyer', 'Aaron Gardner'],
      },
      priorMeasures: ['revenue'],
    });
    expect(followUp?.dimensions).toEqual(expect.arrayContaining(['customer']));
  });

  it('resolves follow-ups from structured conversation turns without legacy flat fields', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'what are the product categories for these customers' }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_customers',
        turns: [
          {
            id: 'turn_products',
            question: 'Top products by revenue',
            answerSummary: 'Top product is for richer or pourover.',
            result: {
              columns: ['product_name', 'category', 'revenue'],
              dimensionValues: {
                product_name: ['for richer or pourover'],
                category: ['Drink'],
              },
              measureColumns: ['revenue'],
            },
            sourceSql: 'SELECT product_name, category, revenue FROM analytics.product_revenue ORDER BY revenue DESC',
          },
          {
            id: 'turn_customers',
            question: 'who are the customers for this product?',
            answerSummary: 'Customers for for richer or pourover.',
            result: {
              columns: ['customer_name', 'product_name', 'revenue'],
              dimensionValues: {
                customer_name: ['Mr. Matthew Meyer', 'Aaron Gardner'],
                product_name: ['for richer or pourover'],
              },
              measureColumns: ['revenue'],
            },
          },
        ],
      },
    } as AgentRunRequest, 'what are the product categories for these customers');

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      sourceTurnId: 'turn_customers',
      sourceQuestion: 'who are the customers for this product?',
      filters: ['Mr. Matthew Meyer', 'Aaron Gardner'],
      dimensions: expect.arrayContaining(['customer']),
      priorResultColumns: ['customer_name', 'product_name', 'revenue'],
      priorResultValues: {
        customer_name: ['Mr. Matthew Meyer', 'Aaron Gardner'],
        product_name: ['for richer or pourover'],
      },
      priorMeasures: ['revenue'],
    });
  });

  it('carries a named prior result ref with schema, row count, and source SQL', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'can you include product details with previous results and give final' }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_products',
        turns: [
          {
            id: 'turn_products',
            question: 'give me product and supply info',
            answerSummary: 'Product to supply breakdown.',
            result: {
              columns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
              rowCount: 65,
              dimensionValues: {
                product_id: ['BEV-001', 'JAF-001'],
                supply_id: ['SUP-005', 'SUP-009'],
              },
              measureColumns: ['supply_cost'],
            },
            sourceSql: 'SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies ORDER BY supply_cost DESC LIMIT 10',
            dqlArtifact: {
              kind: 'sql_block',
              name: 'product_supply_breakdown',
              source: 'block "product_supply_breakdown" {\n  type = "custom"\n  query = """SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies ORDER BY supply_cost DESC LIMIT 10"""\n}',
              orderBy: [{ name: 'supply_cost', direction: 'desc' }],
              limit: 10,
            },
          },
        ],
      },
    } as AgentRunRequest, 'can you include product details with previous results and give final');

    expect(followUp).toMatchObject({
      kind: 'generic',
      priorResultRef: {
        id: 'turn_products',
        question: 'give me product and supply info',
        columns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
        rowCount: 65,
        sourceSql: 'SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies ORDER BY supply_cost DESC LIMIT 10',
      },
      priorDqlArtifact: {
        kind: 'sql_block',
        name: 'product_supply_breakdown',
        source: expect.stringContaining('block "product_supply_breakdown"'),
        orderBy: [{ name: 'supply_cost', direction: 'desc' }],
        limit: 10,
      },
    });

    const rewritten = __test__.rewriteFollowUpQuestion('can you include product details with previous results and give final', followUp);
    expect(rewritten).toBe('can you include product details with previous results and give final');
    expect(rewritten).not.toContain('Prior result ref');
    expect(rewritten).not.toContain('source_sql');
    expect(rewritten).not.toContain('Prior DQL artifact');
  });

  it('can bind a follow-up to a semantically recalled older result instead of an unrelated active turn', () => {
    const question = 'can you include product details with previous results and give final';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_signups',
        turns: [
          {
            id: 'turn_signups',
            question: 'how many signups last quarter',
            answerSummary: 'There were 412 signups.',
            result: {
              columns: ['quarter', 'signups'],
              dimensionValues: { quarter: ['Q2'] },
              measureColumns: ['signups'],
              rowCount: 1,
            },
          },
        ],
        serverSnapshot: {
          threadId: 'thread_products',
          recentTurns: [
            {
              id: 'turn_signups',
              question: 'how many signups last quarter',
              answerSummary: 'There were 412 signups.',
              resultColumns: ['quarter', 'signups'],
              resultRowCount: 1,
              resultDimensionValues: { quarter: ['Q2'] },
            },
          ],
          recalledTurns: [
            {
              id: 'turn_supply',
              question: 'give me product and supply info',
              answerSummary: 'Product to supply breakdown.',
              resultColumns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
              resultRowCount: 65,
              resultDimensionValues: {
                product_id: ['BEV-001', 'JAF-001'],
                supply_id: ['SUP-005', 'SUP-009'],
              },
              sourceSql: 'SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies',
              dqlArtifact: {
                kind: 'sql_block',
                name: 'product_supply_breakdown',
                source: 'block "product_supply_breakdown" {\n  type = "custom"\n}',
              },
            },
          ],
        },
      },
    } as AgentRunRequest, question);

    expect(followUp).toMatchObject({
      kind: 'generic',
      sourceTurnId: 'turn_supply',
      sourceQuestion: 'give me product and supply info',
      priorResultColumns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
      priorResultValues: {
        product_id: ['BEV-001', 'JAF-001'],
        supply_id: ['SUP-005', 'SUP-009'],
      },
      priorResultRef: {
        id: 'turn_supply',
        rowCount: 65,
        sourceSql: 'SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies',
      },
      priorDqlArtifact: {
        kind: 'sql_block',
        name: 'product_supply_breakdown',
      },
    });
  });

  it('resolves above-order references to prior customer rows', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'what the are the products and sub catogories for the above orders' }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_customers',
        turns: [
          {
            id: 'turn_customers',
            question: 'top customers by lifetime spend',
            answerSummary: 'Top customers are Matthew Meyer and Aaron Gardner.',
            result: {
              columns: ['customer_name', 'orders', 'lifetime_spend'],
              dimensionValues: {
                customer_name: ['Mr. Matthew Meyer', 'Aaron Gardner'],
              },
              measureColumns: ['lifetime_spend', 'orders'],
            },
          },
        ],
      },
    } as AgentRunRequest, 'what the are the products and sub catogories for the above orders');

    expect(followUp).toMatchObject({
      kind: 'drilldown',
      sourceTurnId: 'turn_customers',
      filters: ['Mr. Matthew Meyer', 'Aaron Gardner'],
      dimensions: expect.arrayContaining(['customer']),
      priorResultColumns: ['customer_name', 'orders', 'lifetime_spend'],
      priorResultValues: {
        customer_name: ['Mr. Matthew Meyer', 'Aaron Gardner'],
      },
      priorMeasures: ['lifetime_spend', 'orders'],
    });
  });

  it('treats combine-previous-results requests as generic follow-ups', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: "let's combine these results with two previous outputs and give final" }],
      conversationContext: {
        conversationStateVersion: 1,
        activeTurnId: 'turn_products',
        turns: [
          {
            id: 'turn_products',
            question: 'top products by revenue',
            answerSummary: 'Top products by revenue.',
            result: {
              columns: ['product_name', 'category', 'revenue'],
              dimensionValues: {
                product_name: ['for richer or pourover'],
                category: ['Drink'],
              },
              measureColumns: ['revenue'],
            },
          },
        ],
      },
    } as AgentRunRequest, "let's combine these results with two previous outputs and give final");

    expect(followUp).toMatchObject({
      kind: 'generic',
      sourceTurnId: 'turn_products',
      priorResultColumns: ['product_name', 'category', 'revenue'],
      priorResultValues: {
        product_name: ['for richer or pourover'],
        category: ['Drink'],
      },
      priorMeasures: ['revenue'],
    });
  });

  it('converts regex drilldown carry to contextual when the conversation snapshot says topic shift', () => {
    const guarded = __test__.applyTopicShiftGuard({
      kind: 'drilldown',
      sourceQuestion: 'Top products by revenue',
      filters: ['BEV-001'],
      dimensions: ['product'],
      priorResultValues: { product_id: ['BEV-001'] },
      priorMeasures: ['revenue'],
    }, { threadId: 't1', recentTurns: [], topicRelation: 'shift' } as any);

    expect(guarded).toMatchObject({
      kind: 'contextual',
      sourceQuestion: 'Top products by revenue',
    });
    expect(guarded?.filters).toBeUndefined();
    expect(guarded?.dimensions).toBeUndefined();
    expect(guarded?.priorResultValues).toBeUndefined();
    expect(guarded?.priorMeasures).toBeUndefined();
  });

  it('does not invent filters when deictic words have no prior result values', () => {
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: 'who are the top 5 customers for these categories?' }],
      conversationContext: {
        sourceCertifiedBlock: 'food_vs_drink_revenue',
        resultColumns: ['category', 'revenue'],
      },
    } as AgentRunRequest, 'who are the top 5 customers for these categories?');

    expect(followUp?.kind).toBe('drilldown');
    expect(followUp?.filters).toBeUndefined();
    expect(followUp?.dimensions).toBeUndefined();
    expect(followUp?.priorMeasures).toEqual(['revenue']);
  });
});

describe('always-on contextual carry (no regex match)', () => {
  const priorContext = {
    sourceCertifiedBlock: 'food_vs_drink_revenue',
    sourceQuestion: 'Revenue by food vs drink',
    sourceAnswerSummary: 'Food and Drink revenue split.',
    resultColumns: ['category', 'revenue'],
    resultDimensionValues: { category: ['Food', 'Drink'] },
    priorMeasures: ['revenue'],
  };

  it('carries prior-turn context as advisory "contextual" for a topic-shift question', () => {
    const question = 'how many new signups did we get last quarter?';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: priorContext,
    } as AgentRunRequest, question);

    expect(followUp?.kind).toBe('contextual');
    expect(followUp?.sourceBlockName).toBe('food_vs_drink_revenue');
    expect(followUp?.priorResultColumns).toEqual(['category', 'revenue']);
    expect(followUp?.priorResultValues).toEqual({ category: ['Food', 'Drink'] });
    // Advisory carry must never FORCE prior filters/dimensions onto a new topic.
    expect(followUp?.filters).toBeUndefined();
    expect(followUp?.dimensions).toBeUndefined();
  });

  it('carries context for a definition-style question that fails both regexes', () => {
    const question = 'what is our monthly recurring revenue?';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: priorContext,
    } as AgentRunRequest, question);

    expect(followUp?.kind).toBe('contextual');
    expect(followUp?.filters).toBeUndefined();
  });

  it('still returns undefined when there is no useful prior context (turn one stays cold)', () => {
    const question = 'how many new signups did we get last quarter?';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: { activeSurface: 'notebook' },
    } as AgentRunRequest, question);

    expect(followUp).toBeUndefined();
  });

  it('messages-only fallback carries the prior certified block as contextual', () => {
    const question = 'how many new signups did we get last quarter?';
    const followUp = __test__.inferFollowUpContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [
        { role: 'user', content: 'revenue by category' },
        { role: 'assistant', content: 'Answered from certified block food_vs_drink_revenue. Food 240877, Drink 396567.' },
        { role: 'user', content: question },
      ],
    } as AgentRunRequest, question);

    expect(followUp?.kind).toBe('contextual');
    expect(followUp?.sourceBlockName).toBe('food_vs_drink_revenue');
    expect(followUp?.filters).toBeUndefined();
    expect(followUp?.dimensions).toBeUndefined();
  });

  it('keeps classifying real drilldown follow-ups as drilldown (regexes still classify)', () => {
    const question = 'who are the top 5 customers for these categories?';
    const followUp = __test__.followUpFromConversationContext({
      provider: 'ollama',
      projectRoot: '/tmp/x',
      messages: [{ role: 'user', content: question }],
      conversationContext: priorContext,
    } as AgentRunRequest, question);

    expect(followUp?.kind).toBe('drilldown');
  });
});

describe('certified fit confirmation bridge', () => {
  it('asks the provider for strict fit JSON with requested shape and block context', async () => {
    const calls: AgentMessage[][] = [];
    const provider: AgentProvider = {
      name: 'openai',
      async available() {
        return true;
      },
      async generate(messages) {
        calls.push(messages);
        return '{"allow":true,"confidence":"high","reason":"block covers product usage"}';
      },
    };
    const confirm = __test__.createCertifiedFitConfirmation(provider);

    const result = await confirm({
      question: 'Show usage by product',
      questionPlan: {
        requestedShape: {
          dimensions: ['product'],
          measures: ['usage'],
          requiredOutputs: ['product', 'usage'],
          filters: [],
          followUpReferences: [],
          ambiguities: [],
        },
      } as any,
      block: {
        objectKey: 'dql:block:Legacy Product Usage',
        objectType: 'dql_block',
        name: 'Legacy Product Usage',
        status: 'certified',
        description: 'Legacy certified usage metric by product.',
        payload: {
          grain: 'product',
          dimensions: ['product'],
          llmContext: 'Use for usage by product.',
        },
      },
      fit: {
        kind: 'exact',
        confidence: 'medium',
        reasons: ['block contract was safely inferred from available metadata'],
        missingOutputs: [],
        missingDimensions: [],
        unsupportedFilters: [],
        topNAction: 'none',
        inferredContract: true,
      },
    });

    expect(result).toEqual({
      allow: true,
      confidence: 'high',
      reason: 'block covers product usage',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]?.content).toContain('strict governed analytics routing judge');
    expect(calls[0]?.[1]?.content).toContain('"requestedShape"');
    expect(calls[0]?.[1]?.content).toContain('"Legacy Product Usage"');
  });

  it('rejects malformed fit confirmation output', () => {
    expect(__test__.parseCertifiedFitConfirmation('not json')).toMatchObject({
      allow: false,
      confidence: 'low',
    });
  });
});
