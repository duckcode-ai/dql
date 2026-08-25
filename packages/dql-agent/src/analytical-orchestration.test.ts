import { describe, expect, it } from 'vitest';
import {
  splitAnalyticalTasks,
  assertCanonicalResult,
  buildAnalyticalTaskGraph,
  buildAnalyticalCascadeDecision,
  buildAnalyticalRequirementSeedV1,
  buildAnalyticalRequirementSet,
  categoricalDimensionRequirementTerms,
  buildAnalyticalTurnPlan,
  buildCoverageGap,
  buildResearchEvidenceLedger,
  buildResearchEvidenceLedgerV2,
  buildResearchHypothesisPlanV2,
  canonicalResultBindingValue,
  canonicalResultRowFingerprint,
  capResearchBranches,
  classifyProviderFailure,
  evidenceCandidateRoles,
  fuseContextCandidates,
  normalizeCanonicalQueryResult,
  resolveTopRankedRegionDependency,
  selectRoleBalancedMeaningCandidates,
  retrieveContextLanes,
  summarizeTaskOutcomes,
  validateSelectedResultBinding,
} from './analytical-orchestration.js';
import { OFFICE_ASK_AI_GOLD_CASES, OFFICE_ASK_AI_SANITIZED_FIXTURE } from './fixtures/ask-ai-office-shaped.js';

describe('conversational analytical orchestration contracts', () => {
  it('uses a sanitized semantic/dbt/runtime fixture with withheld office gold results', () => {
    expect(OFFICE_ASK_AI_SANITIZED_FIXTURE.semantic.metrics.map((metric) => metric.name)).toEqual(expect.arrayContaining([
      'Lost Opportunities Count', 'Lost Amount', 'Revenue', 'BCM Run Rate',
    ]));
    expect(OFFICE_ASK_AI_SANITIZED_FIXTURE.runtimeSchema.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'analytics.opportunities', columns: expect.arrayContaining(['close_date', 'competitor']) }),
      expect.objectContaining({ relation: 'analytics.account_revenue', columns: expect.arrayContaining(['account_name', 'revenue']) }),
    ]));
    expect(OFFICE_ASK_AI_SANITIZED_FIXTURE.evals.every((entry) => entry.goldSqlWithheld && entry.goldResultWithheld)).toBe(true);
  });

  it('AGT-009/AGT-029 normalizes fiscal monthly requirements without inventing month/year columns', () => {
    const officeCase = OFFICE_ASK_AI_GOLD_CASES[0];
    const requirements = buildAnalyticalRequirementSet({
      question: officeCase.question,
      parsedIntent: {
        measures: ['lost opportunities count', 'lost amount'],
        dimensions: ['month', 'year', 'competitor'],
        filters: [{ field: 'competitor', value: 'Datadog' }],
      },
    });
    expect(requirements.dimensions).toEqual(['competitor']);
    expect(requirements.time).toMatchObject({ grain: 'month', fiscalPeriod: 'FY26', requiresDeclaredFiscalCalendar: true });
    expect(requirements.measures).toEqual(expect.arrayContaining(['lost opportunities count', 'lost amount']));
  });

  it('AGT-034 keeps revenue-by-region as one revenue metric and one geography role', () => {
    const requirements = buildAnalyticalRequirementSet({
      question: 'Show revenue by sales based on the region',
      parsedIntent: {
        measures: ['revenue'],
        dimensions: ['sales based on the region'],
        filters: [],
      },
    });
    expect(requirements.measures).toEqual(['revenue']);
    expect(requirements.dimensions).toEqual(['region']);
    expect(requirements.dimensions).not.toContain('sales based on the region');
  });

  it('AGT-034 preserves the customer, revenue, product-category, and default-top-ten tuple', () => {
    const requirements = buildAnalyticalRequirementSet({
      question: 'who are the top customers who have revenue by product category?',
      parsedIntent: { measures: ['revenue'], dimensions: ['product category'], filters: [] },
    });
    expect(requirements).toMatchObject({
      measures: ['revenue'],
      dimensions: ['product category'],
      entityTerms: ['customer'],
      entityDisplayTerms: ['customer name'],
      ranking: { metricTerms: ['revenue'], direction: 'top', limit: 10, defaultedLimit: true },
    });
  });

  it('AGT-034 keeps the customer entity out of the categorical seed lane while retaining its display key', () => {
    const requirements = buildAnalyticalRequirementSet({
      question: 'who are the top customers who have revenue by product category?',
      parsedIntent: {
        measures: ['revenue'],
        dimensions: ['customer', 'product category'],
        filters: [],
      },
    });
    const seed = buildAnalyticalRequirementSeedV1({
      question: 'who are the top customers who have revenue by product category?',
      // This is the live failure shape: retrieval may retain the bare entity
      // noun along with the explicitly requested product category. The host
      // must not let that noun turn every customer-* attribute into a
      // competing categorical dimension.
      parsedIntent: {
        measures: ['revenue'],
        dimensions: ['customer', 'product category'],
        filters: [],
      },
      requirements,
    });

    expect(seed.requirements).toMatchObject({
      entityTerms: ['customer'],
      entityDisplayTerms: ['customer name'],
      dimensions: expect.arrayContaining(['customer', 'product category']),
    });
    expect(seed.queryIntent.dimensions).toEqual(expect.arrayContaining([
      'customer name',
      'product category',
    ]));
    expect(seed.queryIntent.dimensions).not.toContain('customer');
  });

  it('AGT-034 reserves product category independently of the customer entity role', () => {
    const requirements = buildAnalyticalRequirementSet({
      question: 'who are the top customers who have revenue by product category?',
      parsedIntent: { measures: ['revenue'], dimensions: ['product category', 'customer'], filters: [] },
    });
    expect(categoricalDimensionRequirementTerms(requirements)).toEqual(['product category']);
    const cards = selectRoleBalancedMeaningCandidates({
      requirements,
      maxCandidates: 4,
      candidates: [
        { id: 'semantic:metric:order_item.revenue', kind: 'semantic_metric', semanticObjectType: 'metric', name: 'Revenue', relevanceScore: 1, compatibility: 'compatible' },
        // The actual failure shape: this entity card is also technically a
        // semantic member, but it must not consume the categorical lane.
        { id: 'semantic:entity:customers.customer', kind: 'semantic_member', semanticObjectType: 'entity', name: 'customers.customer', relevanceScore: 0.99, compatibility: 'compatible' },
        { id: 'semantic:dimension:customers.customer_name', kind: 'semantic_member', semanticObjectType: 'dimension', name: 'customer_name', aliases: ['customer name'], relevanceScore: 0.8, compatibility: 'compatible' },
        { id: 'semantic:dimension:products.product_type', kind: 'semantic_member', semanticObjectType: 'dimension', name: 'product_type', aliases: ['product type'], relevanceScore: 0.1, compatibility: 'compatible' },
      ],
    });
    expect(cards.map((card) => card.id)).toEqual(expect.arrayContaining([
      'semantic:metric:order_item.revenue',
      'semantic:dimension:products.product_type',
    ]));
  });

  it('AGT-034 keeps individual expensive order items as a five-row price ranking with required outputs', () => {
    const requirements = buildAnalyticalRequirementSet({
      question: 'Show the five most expensive individual order items with order ID, product ID, and product price.',
    });
    expect(requirements).toMatchObject({
      measures: ['product price'],
      outputTerms: ['order id', 'product id', 'product price'],
      grain: 'individual',
      ranking: { metricTerms: ['product price'], direction: 'top', limit: 5, defaultedLimit: false },
    });
    // `product` occurs only as part of explicit output fields here. It is not
    // a grouping request unless the reader says `by product`.
    expect(requirements.dimensions).toEqual([]);
  });

  it('AGT-034 keeps a new free-text multi-metric request immutable when retrieval carries stale rollover intent', () => {
    const seed = buildAnalyticalRequirementSeedV1({
      question: 'show revenue and refunds by month',
      // This mirrors a retrieval/context-pack parser result from an unrelated
      // prior turn. The seed must treat it as search evidence only, never as
      // authority for a new free-text request.
      parsedIntent: {
        measures: ['rollover balance'],
        dimensions: ['customer type'],
        filters: [{ field: 'account_status', value: 'rollover balance' }],
        timeRange: 'last 30 days',
        timeGrain: 'month',
        order: 'desc',
        limit: 10,
      },
    });

    expect(seed.sourceQuestion).toBe('show revenue and refunds by month');
    expect(seed.requirements.measures).toEqual(expect.arrayContaining(['revenue', 'refunds']));
    expect(seed.requirements.measures).not.toContain('rollover balance');
    expect(seed.requirements.dimensions).not.toContain('customer type');
    expect(seed.requirements.memberTerms).not.toContain('rollover balance');
    expect(seed.queryIntent).toMatchObject({
      measures: expect.arrayContaining(['revenue', 'refunds']),
      dimensions: [],
      filters: [],
      timeGrain: 'month',
    });
    expect(seed.queryIntent).not.toHaveProperty('timeRange');
    expect(seed.queryIntent).not.toHaveProperty('order');
    expect(seed.queryIntent).not.toHaveProperty('limit');
  });

  it('CTX-005/AGT-010 role-balances explicit revenue and account display evidence over owner/sentiment decoys', () => {
    const officeCase = OFFICE_ASK_AI_GOLD_CASES[1];
    const requirements = buildAnalyticalRequirementSet({
      question: officeCase.question,
      parsedIntent: { measures: ['BCM', 'revenue'], dimensions: ['customer'], filters: [] },
    });
    expect(requirements).toMatchObject({
      measures: ['revenue'],
      ranking: {
        metricTerms: ['revenue'],
        direction: 'top',
        limit: 10,
        defaultedLimit: true,
      },
    });
    const cards = selectRoleBalancedMeaningCandidates({
      requirements,
      maxCandidates: 4,
      candidates: [
        { id: 'semantic:dimension:account.owner_email', kind: 'semantic_member', semanticObjectType: 'dimension', name: 'Account Owner Email', relevanceScore: 0.99, compatibility: 'compatible' },
        { id: 'semantic:dimension:account.sentiment', kind: 'semantic_member', semanticObjectType: 'dimension', name: 'Account Sentiment Rating', relevanceScore: 0.98, compatibility: 'compatible' },
        { id: 'semantic:dimension:account.name', kind: 'semantic_member', semanticObjectType: 'dimension', name: 'Account Name', relevanceScore: 0.8, compatibility: 'compatible' },
        {
          id: 'semantic:metric:revenue', kind: 'semantic_metric', semanticObjectType: 'metric', name: 'Revenue', relevanceScore: 0.78, compatibility: 'compatible',
          dimensions: ['semantic:dimension:customer.name'], timeGrains: ['month'], relationshipEvidence: ['dql:relationship:account_to_customer'],
        },
        {
          id: 'semantic:metric:bcm', kind: 'semantic_metric', semanticObjectType: 'metric', name: 'BCM', relevanceScore: 0.77, compatibility: 'compatible',
          dimensions: ['semantic:dimension:customer.name'], timeGrains: ['month'], relationshipEvidence: ['dql:relationship:account_to_customer'],
        },
      ],
    });
    expect(cards.map((card) => card.id)).toEqual(expect.arrayContaining([
      'semantic:dimension:account.name',
      'semantic:metric:revenue',
    ]));
    expect(cards.map((card) => card.id)).not.toContain('semantic:metric:bcm');
    expect(evidenceCandidateRoles(cards.find((card) => card.id === 'semantic:dimension:account.name')!)).toContain('entity_label');
    // A metric capability may expose dimensions, time grains, and relationship
    // paths for execution.  Those are not roles the metric itself can fill.
    expect(evidenceCandidateRoles({
      id: 'semantic:metric:revenue', kind: 'semantic_metric', semanticObjectType: 'metric', name: 'Revenue',
      dimensions: ['semantic:dimension:customer.name'], timeGrains: ['month'], relationshipEvidence: ['dql:relationship:account_to_customer'],
    })).toEqual(['metric']);
    expect(evidenceCandidateRoles({
      id: 'semantic:metric:declared-composite', kind: 'semantic_metric', semanticObjectType: 'metric', name: 'Declared composite',
      compatibilityFacts: ['candidate-role: entity_label'],
    })).toEqual(['metric', 'entity_label']);
  });

  it('AGT-010 keeps the context planner top-10 bound visibly defaulted when the user gave no count', () => {
    const requirements = buildAnalyticalRequirementSet({
      question: 'Who are the top BCM customers who have highest revenue?',
      // The local context planner injects this bounded execution default into
      // parsed intent. It must not erase the receipt's default assumption.
      parsedIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [], limit: 10 },
    });
    expect(requirements.ranking).toMatchObject({
      metricTerms: ['revenue'],
      limit: 10,
      defaultedLimit: true,
    });
  });

  it('AGT-010 defaults an unspecified top-account request to ten without substituting owner or sentiment', () => {
    const officeCase = OFFICE_ASK_AI_GOLD_CASES[2];
    const requirements = buildAnalyticalRequirementSet({ question: officeCase.question });
    expect(requirements).toMatchObject({
      entityTerms: ['account'],
      entityDisplayTerms: ['account name'],
      ranking: { metricTerms: expect.arrayContaining(['bcm']), limit: 10, defaultedLimit: true },
    });
    const cards = selectRoleBalancedMeaningCandidates({
      requirements,
      maxCandidates: 3,
      candidates: [
        { id: 'semantic:dimension:account.owner_email', kind: 'semantic_member', semanticObjectType: 'dimension', name: 'Account Owner Email', relevanceScore: 0.99, compatibility: 'compatible' },
        { id: 'semantic:dimension:account.sentiment', kind: 'semantic_member', semanticObjectType: 'dimension', name: 'Account Sentiment Rating', relevanceScore: 0.98, compatibility: 'compatible' },
        { id: 'semantic:dimension:account.name', kind: 'semantic_member', semanticObjectType: 'dimension', name: 'Account Name', relevanceScore: 0.72, compatibility: 'compatible' },
        { id: 'semantic:metric:bcm_run_rate', kind: 'semantic_metric', semanticObjectType: 'metric', name: 'BCM Run Rate', relevanceScore: 0.71, compatibility: 'compatible' },
      ],
    });
    expect(cards.map((card) => card.id)).toEqual(expect.arrayContaining([
      'semantic:dimension:account.name',
      'semantic:metric:bcm_run_rate',
    ]));
  });

  it('AGT-010 reserves a low-ranked account display key instead of treating an entity, owner, or sentiment as the label', () => {
    const requirements = buildAnalyticalRequirementSet({
      question: 'What is the current BCM run rate across top accounts?',
      parsedIntent: { measures: ['BCM run rate'], dimensions: ['account'], filters: [] },
    });
    const cards = selectRoleBalancedMeaningCandidates({
      requirements,
      maxCandidates: 4,
      candidates: [
        { id: 'semantic:metric:account.bcm_run_rate', kind: 'semantic_metric', semanticObjectType: 'metric', name: 'BCM Run Rate', relevanceScore: 0.99, compatibility: 'compatible' },
        { id: 'dql:entity:revenue::entity::account', kind: 'dql_modeling', name: 'account', relevanceScore: 0.98, compatibility: 'compatible' },
        { id: 'semantic:entity:account', kind: 'semantic_member', semanticObjectType: 'entity', name: 'Account', relevanceScore: 0.97, compatibility: 'compatible' },
        { id: 'dbt:column:dim_accounts.account_owner_email', kind: 'sql_column', name: 'Account Owner Email', relevanceScore: 0.96, compatibility: 'compatible' },
        { id: 'dbt:column:dim_accounts.account_sentiment_rating', kind: 'sql_column', name: 'Account Sentiment Rating', relevanceScore: 0.95, compatibility: 'compatible' },
        // This simulates the real fixture: the authoritative display key is
        // below general fused relevance but must be role-reserved.
        { id: 'dbt:column:dim_accounts.account_name', kind: 'sql_column', name: 'account_name', relevanceScore: 0.19, compatibility: 'compatible' },
      ],
    });

    expect(cards.map((card) => card.id)).toEqual(expect.arrayContaining([
      'semantic:metric:account.bcm_run_rate',
      'dbt:column:dim_accounts.account_name',
    ]));
    expect(evidenceCandidateRoles(cards.find((card) => card.id === 'dql:entity:revenue::entity::account')!)).not.toContain('entity_label');
    expect(evidenceCandidateRoles(cards.find((card) => card.id === 'semantic:entity:account')!)).not.toContain('entity_label');
    expect(evidenceCandidateRoles(cards.find((card) => card.id === 'dbt:column:dim_accounts.account_name')!)).toContain('entity_label');
    expect(cards.map((card) => card.id)).not.toEqual(expect.arrayContaining([
      'dbt:column:dim_accounts.account_owner_email',
      'dbt:column:dim_accounts.account_sentiment_rating',
    ]));
  });

  it('API-007/API-008 records compact cascade and phase-specific provider diagnostics', () => {
    const diagnostic = classifyProviderFailure({ message: 'HTTP 429 rate limit', phase: 'generation' });
    expect(diagnostic).toMatchObject({ cause: 'rate_limited', retryable: true, safeAction: 'wait_and_retry' });
    const cascade = buildAnalyticalCascadeDecision({
      requirements: buildAnalyticalRequirementSet({ question: 'top customers by revenue' }),
      sourceCoverage: [{ version: 1, source: 'semantic', status: 'available', candidateIds: ['semantic:metric:revenue'] }],
      attempts: [{ version: 1, tier: 'semantic', outcome: 'ineligible', candidateIds: ['semantic:metric:revenue'], reason: 'missing customer display role', planFrozen: false }],
      planFrozen: false,
      stopReason: 'coverage_gap',
    });
    expect(cascade).toMatchObject({ version: 1, sourceCoverage: [{ source: 'semantic' }], attempts: [{ tier: 'semantic' }] });
  });

  it('AGT-029 stops the authoritative receipt at the first frozen semantic tier', () => {
    const cascade = buildAnalyticalCascadeDecision({
      requirements: buildAnalyticalRequirementSet({ question: 'What is the current BCM run rate across top accounts?' }),
      sourceCoverage: [
        { version: 1, source: 'certified', status: 'available', candidateIds: [] },
        { version: 1, source: 'semantic', status: 'available', candidateIds: ['semantic:account_revenue:bcm_run_rate'] },
        { version: 1, source: 'governed_relational', status: 'available', candidateIds: ['dql:relationship:account_revenue_to_account'] },
        { version: 1, source: 'exploratory', status: 'available', candidateIds: ['dbt:model:fct_account_revenue'] },
      ],
      attempts: [
        { version: 1, tier: 'certified', outcome: 'unavailable', candidateIds: [], reason: 'No certified tuple.', planFrozen: false },
        { version: 1, tier: 'semantic', outcome: 'executable', candidateIds: ['semantic:account_revenue:bcm_run_rate'], reason: 'Semantic tuple froze.', planFrozen: true },
        // These are stale pre-built fallback artifacts. A no-target semantic
        // execution failure is terminal at semantic; it must not leave them
        // in a persisted cascade or portable receipt.
        { version: 1, tier: 'governed_relational', outcome: 'ineligible', candidateIds: ['dql:relationship:account_revenue_to_account'], reason: 'Must not persist after freeze.', planFrozen: false },
        { version: 1, tier: 'exploratory_sql', outcome: 'executable', candidateIds: ['dbt:model:fct_account_revenue'], reason: 'Must not persist after freeze.', planFrozen: false },
      ],
      selectedTier: 'semantic',
      planFrozen: true,
      stopReason: 'selected',
    });

    expect(cascade.attempts.map((attempt) => [attempt.tier, attempt.planFrozen])).toEqual([
      ['certified', false],
      ['semantic', true],
    ]);
  });

  it.each([
    ['AUTHENTICATION_FAILED', 'authentication'],
    ['MODEL_NOT_FOUND', 'model_not_found'],
    ['RATE_LIMITED', 'rate_limited'],
    ['GATEWAY_503', 'gateway'],
    ['NETWORK_FAILURE', 'network'],
    ['PROVIDER_TIMEOUT', 'provider_timeout'],
    ['RUN_DEADLINE', 'run_deadline'],
    ['ADMISSION_DENIED', 'admission_denied'],
    ['DISPATCH_BUDGET', 'dispatch_budget'],
    ['CANCELLED', 'cancelled'],
  ])('API-007 classifies the %s provider cause without persisting provider content', (code, cause) => {
    expect(classifyProviderFailure({ code, message: 'redacted provider failure' }).cause).toBe(cause);
  });

  it('AGT-016/033 only promotes a research verdict after a receipt-bound deterministic validator', () => {
    const fingerprint = 'a'.repeat(64);
    const promoted = buildResearchEvidenceLedgerV2({
      rootQuestion: 'Why did revenue change?',
      entries: [{
        id: 'branch:trend', branchId: 'trend', question: 'Trend', status: 'observed',
        resultFingerprint: fingerprint, receipts: [fingerprint], facts: ['fact:trend'],
        verdict: 'supported',
        validator: {
          version: 1, kind: 'trend', evaluated: true,
          outcome: 'supports_observation', receiptFingerprints: [fingerprint],
        },
        counterEvidenceFactIds: ['fact:trend', 'invented:counter-evidence'],
      }],
    });
    expect(promoted.entries[0]).toMatchObject({ verdict: 'supported', counterEvidenceFactIds: ['fact:trend'] });

    const rowsOnly = buildResearchEvidenceLedgerV2({
      rootQuestion: 'Why did revenue change?',
      entries: [{
        id: 'branch:rows', branchId: 'rows', question: 'Rows', status: 'observed',
        resultFingerprint: fingerprint, receipts: [fingerprint], facts: ['fact:rows'], verdict: 'supported',
      }],
    });
    expect(rowsOnly.entries[0]?.verdict).toBe('inconclusive');
    expect(rowsOnly.limitedScope).toBe(true);

    const plannedButFailed = buildResearchEvidenceLedgerV2({
      rootQuestion: 'Why did revenue change?',
      groundableBranchCount: 3,
      entries: [{
        id: 'branch:failed', branchId: 'failed', question: 'Trend', status: 'failed',
        facts: [], receipts: [], error: 'warehouse timeout',
      }],
    });
    expect(plannedButFailed).toMatchObject({ groundableBranchCount: 3, limitedScope: false });
  });

  it('AGT-020 bounds typed research hypotheses without inventing missing branches', () => {
    const plan = buildResearchHypothesisPlanV2({
      hypotheses: [
        { statement: 'Revenue shifted by segment.', expectation: 'Compare segment totals.', targetId: 'semantic:metric:revenue' },
        { statement: 'Revenue shifted by segment.', expectation: 'Compare segment totals.', targetId: 'semantic:metric:revenue' },
        { statement: 'Revenue changed over time.', expectation: 'Compare monthly values.', targetId: 'semantic:dimension:order_month' },
      ],
    });
    expect(plan.hypotheses).toHaveLength(2);
    expect(plan.limitedScope).toBe(true);
    expect(plan.hypotheses.map((hypothesis) => hypothesis.validatorKind)).toEqual(expect.arrayContaining(['contributor', 'trend']));
  });

  it('normalizes connector array rows and object rows into one result contract', () => {
    const result = normalizeCanonicalQueryResult({
      columns: [{ name: 'customer' }, { name: 'revenue' }],
      rows: [['Alice', 120], { customer: 'Bob', revenue: 90 }],
      rowCount: 2,
    });
    expect(result.columns).toEqual(['customer', 'revenue']);
    expect(result.rows).toEqual([
      { customer: 'Alice', revenue: 120 },
      { customer: 'Bob', revenue: 90 },
    ]);
    expect(result.resultFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(() => assertCanonicalResult(result)).not.toThrow();
  });

  it('accepts only an exact typed selected-result binding (AGT-031)', () => {
    const result = normalizeCanonicalQueryResult({
      columns: ['customer_name', 'revenue'],
      rows: [{ customer_name: 'Jessica Richard', revenue: 294 }],
      resultFingerprint: 'a'.repeat(64),
    });
    const row = result.rows[0]!;
    const binding = {
      version: 1 as const,
      sourceRunId: 'run-1',
      sourceArtifactId: 'artifact-1',
      canonicalColumn: 'customer_name',
      value: canonicalResultBindingValue(row.customer_name)!,
      rowFingerprint: canonicalResultRowFingerprint(result, row),
      resultFingerprint: result.resultFingerprint,
    };

    expect(validateSelectedResultBinding(binding, result)).toMatchObject({ ok: true });
    expect(validateSelectedResultBinding({ ...binding, value: 'Forged Customer' }, result)).toMatchObject({
      ok: false,
      code: 'RESULT_BINDING_ROW_MISMATCH',
    });
    expect(validateSelectedResultBinding({ ...binding, resultFingerprint: 'b'.repeat(64) }, result)).toMatchObject({
      ok: false,
      code: 'RESULT_BINDING_RESULT_MISMATCH',
    });
  });

  it('preserves an execution receipt and never invents proof for an unexecuted branch', () => {
    const receipt = {
      sourceFingerprint: 'b'.repeat(64),
      compiledSqlFingerprint: 'c'.repeat(64),
      parameterFingerprint: 'd'.repeat(64),
      resultFingerprint: 'a'.repeat(64),
    };
    const result = normalizeCanonicalQueryResult({
      columns: ['region'],
      rows: [{ region: 'West' }],
      resultFingerprint: receipt.resultFingerprint,
      executionReceipt: receipt,
      trustState: 'review_required',
      answerTier: 'generated_sql',
    });
    expect(result).toMatchObject({
      resultFingerprint: receipt.resultFingerprint,
      executionReceipt: receipt,
      trustState: 'review_required',
      answerTier: 'generated_sql',
    });
    const ledger = buildResearchEvidenceLedger({
      rootQuestion: 'Explain revenue drivers',
      entries: [
        {
          id: 'branch-1', branchId: 'revenue', question: 'Revenue by region',
          status: 'observed', resultFingerprint: receipt.resultFingerprint,
          executionReceipt: receipt,
          facts: ['fact-1'], receipts: [receipt.resultFingerprint], rowCount: 1,
        },
        {
          id: 'branch-2', branchId: 'customers', question: 'Customers by region',
          status: 'observed', facts: ['fact-2'], receipts: [],
        },
        {
          id: 'branch-3', branchId: 'products', question: 'Products by region',
          status: 'failed', resultFingerprint: receipt.resultFingerprint,
          executionReceipt: receipt,
          facts: [], receipts: [receipt.resultFingerprint], error: 'cancelled by shared Research deadline',
        },
        {
          id: 'branch-4', branchId: 'malformed', question: 'Malformed child proof',
          status: 'observed',
          executionReceipt: { resultFingerprint: 'not-a-sha256-receipt', childRunId: 'child-4' } as any,
          facts: ['fact-4'], receipts: ['child-4'],
        },
      ],
    });
    expect(ledger.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'branch-1', status: 'observed', receipts: [receipt.resultFingerprint] }),
      expect.objectContaining({
        id: 'branch-2', status: 'failed', receipts: [],
        error: expect.stringContaining('no valid execution receipt'),
      }),
      expect.objectContaining({
        id: 'branch-3', status: 'failed', receipts: [],
        error: expect.stringContaining('cancelled'),
      }),
      expect.objectContaining({
        id: 'branch-4', status: 'failed', receipts: [],
        error: expect.stringContaining('no valid execution receipt'),
      }),
    ]));
    const failedCancelled = ledger.entries.find((entry) => entry.id === 'branch-3');
    expect(failedCancelled).not.toHaveProperty('executionReceipt');
    expect(failedCancelled).not.toHaveProperty('resultFingerprint');
    expect(ledger.entries.find((entry) => entry.id === 'branch-2')?.receipts).toEqual([]);
    const ledgerV2 = buildResearchEvidenceLedgerV2({
      rootQuestion: 'Explain revenue drivers',
      entries: [
        {
          id: 'branch-1', branchId: 'revenue', question: 'Revenue by region',
          status: 'observed', resultFingerprint: receipt.resultFingerprint,
          executionReceipt: receipt, facts: ['fact-1'], receipts: [receipt.resultFingerprint],
          verdict: 'supported', counterEvidenceFactIds: ['fact-1'],
          validator: {
            version: 1, kind: 'comparison', evaluated: true,
            outcome: 'supports_observation', receiptFingerprints: [receipt.resultFingerprint],
          },
        },
        { id: 'branch-2', branchId: 'customers', question: 'Customers', status: 'skipped', facts: [], receipts: [] },
      ],
    });
    expect(ledgerV2).toMatchObject({ limitedScope: true, groundableBranchCount: 1 });
    expect(ledgerV2.entries[0]).toMatchObject({ verdict: 'supported', counterEvidenceFactIds: ['fact-1'] });
  });

  it('fuses lanes by reciprocal rank while retaining evidence from different lanes', () => {
    const fused = fuseContextCandidates({
      lexical: [
        { id: 'semantic:metric:revenue', lane: 'lexical', relevance: 0.8 },
        { id: 'dbt:model:orders', lane: 'lexical', relevance: 0.6 },
      ],
      vector: [
        { id: 'semantic:metric:revenue', lane: 'vector', relevance: 0.7 },
        { id: 'kg:relationship:orders-customers', lane: 'vector', relevance: 0.9 },
      ],
      graph: [{ id: 'kg:relationship:orders-customers', lane: 'graph', relevance: 0.9 }],
    });
    expect(fused.candidates.map((candidate) => candidate.id)).toContain('semantic:metric:revenue');
    expect(fused.candidates.map((candidate) => candidate.id)).toContain('kg:relationship:orders-customers');
    expect(fused.diagnostics.lanes.lexical.returned).toBe(2);
  });

  it('records lane errors without discarding successful retrieval', async () => {
    const result = await retrieveContextLanes({
      exact: async () => [{ id: 'block:revenue', lane: 'exact', relevance: 1, trust: 'certified' }],
      vector: async () => { throw new Error('embedding unavailable'); },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.diagnostics.lanes.vector.error).toBe('embedding unavailable');
  });

  it('bounds parallel lane work while retaining independent lane failures', async () => {
    let active = 0;
    let peak = 0;
    const lanes = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
      `lane-${index + 1}`,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        if (index === 4) throw new Error('lane 5 unavailable');
        return [{ id: `candidate-${index + 1}`, lane: 'lexical' as const, relevance: 1 }];
      },
    ]));
    const result = await retrieveContextLanes(lanes, 20, 2);
    expect(capResearchBranches(Array.from({ length: 8 }, (_, index) => index), 6)).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
    expect(result.candidates.map((candidate) => candidate.id)).toContain('candidate-1');
    expect(result.diagnostics.lanes['lane-5']).toMatchObject({ status: 'error', error: 'lane 5 unavailable' });
  });

  it('keeps typed gaps recoverable until a plan is frozen', () => {
    const gap = buildCoverageGap({
      code: 'MISSING_RELATIONSHIP',
      phase: 'retrieval',
      message: 'No proven customer to region relationship was found.',
      searchedSources: ['semantic', 'dbt_manifest', 'relationship_graph'],
      attemptedRoutes: ['certified', 'semantic', 'governed_relational', 'generated'],
      missing: ['customer.region'],
      recoverable: true,
      planFrozen: false,
      nextActions: ['search dbt relationships', 'ask which region field to use'],
    });
    expect(gap.version).toBe(1);
    expect(gap.planFrozen).toBe(false);
    const ledger = buildResearchEvidenceLedger({
      rootQuestion: 'Why did revenue change?',
      entries: [{
        id: 'entry-1',
        branchId: 'baseline',
        question: 'What is current revenue?',
        status: 'observed',
        resultFingerprint: 'abcd',
        rowCount: 1,
        facts: ['fact-1'],
        receipts: ['receipt-1'],
      }],
    });
    expect(ledger.factIds).toEqual(['fact-1']);
    expect(ledger.stoppingReason).toBe('completed');
  });

  it('builds a candidate-bound compound task graph with partial-success vocabulary', () => {
    const graph = buildAnalyticalTaskGraph({
      question: 'What region has top revenue? And which products are most common?',
      candidateIds: ['semantic:metric:revenue', 'semantic:dimension:region'],
      metrics: ['revenue'],
      dimensions: ['region', 'product'],
    });
    expect(graph.kind).toBe('compound');
    expect(graph.tasks).toHaveLength(2);
    expect(graph.tasks.every((task) => task.candidateIds.every((id) => id.startsWith('semantic:')))).toBe(true);
    const outcomes = summarizeTaskOutcomes(graph.tasks.map((task, index) => ({
      ...task,
      status: index === 0 ? 'completed' : 'gap',
    })));
    expect(outcomes).toMatchObject({ status: 'partial', completed: ['task-1'], gaps: ['task-2'] });
  });

  it('binds only the demonstrated top-region customer dependency (AGT-030)', () => {
    const graph = buildAnalyticalTaskGraph({
      question: 'What region has the highest revenue? Who are the top customers in that region?',
    });
    expect(graph.tasks).toHaveLength(2);
    expect(graph.tasks[1]).toMatchObject({
      dependencies: ['task-1'],
      dependency: { kind: 'top_ranked_region', sourceTaskId: 'task-1', targetDimension: 'region' },
    });
    expect(buildAnalyticalTaskGraph({
      question: 'What region has the highest revenue? Who are the top customers by lifetime spend?',
    }).tasks[1]?.dependencies).toEqual([]);
  });

  it('derives a typed region binding only from an unambiguous canonical parent result (E2E-010)', () => {
    const parentPlan = {
      kind: 'ranking' as const,
      output: { metrics: [], dimensions: [], filters: [], order: 'desc' as const },
    };
    const receipt = (resultFingerprint: string) => ({
      sourceFingerprint: 'a'.repeat(64),
      compiledSqlFingerprint: 'b'.repeat(64),
      parameterFingerprint: 'e'.repeat(64),
      resultFingerprint,
    });
    const parent = normalizeCanonicalQueryResult({
      columns: ['region', 'revenue'],
      rows: [{ region: 'Philadelphia', revenue: 450_969.65 }, { region: 'Brooklyn', revenue: 220_455.72 }],
      resultFingerprint: 'c'.repeat(64),
      executionReceipt: receipt('c'.repeat(64)),
    });
    expect(resolveTopRankedRegionDependency('task-1', parent, parentPlan)).toMatchObject({
      ok: true,
      binding: {
        sourceTaskId: 'task-1',
        sourceResultFingerprint: 'c'.repeat(64),
        canonicalColumn: 'region',
        value: 'Philadelphia',
        rowFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const tied = normalizeCanonicalQueryResult({
      columns: ['region', 'revenue'],
      rows: [{ region: 'Philadelphia', revenue: 100 }, { region: 'Brooklyn', revenue: 100 }],
      resultFingerprint: 'd'.repeat(64),
      executionReceipt: receipt('d'.repeat(64)),
    });
    expect(resolveTopRankedRegionDependency('task-1', tied, parentPlan)).toMatchObject({
      ok: false,
      code: 'RESULT_CONTRACT_MISMATCH',
      message: expect.stringContaining('did not prove a single leading region'),
    });
  });

  it('does not treat a receipt-backed singleton numeric region result as a top-ranked proof (E2E-010)', () => {
    const parentPlan = {
      kind: 'ranking' as const,
      output: { metrics: [], dimensions: [], filters: [], order: 'desc' as const },
    };
    const parent = normalizeCanonicalQueryResult({
      columns: ['region', 'revenue'],
      rows: [{ region: 'Philadelphia', revenue: 450_969.65 }],
      resultFingerprint: 'c'.repeat(64),
      executionReceipt: {
        sourceFingerprint: 'a'.repeat(64),
        compiledSqlFingerprint: 'b'.repeat(64),
        parameterFingerprint: 'e'.repeat(64),
        resultFingerprint: 'c'.repeat(64),
      },
    });

    expect(resolveTopRankedRegionDependency('task-1', parent, parentPlan)).toMatchObject({
      ok: false,
      code: 'RESULT_CONTRACT_MISMATCH',
      message: expect.stringContaining('did not prove a single leading region'),
    });
  });

  it.each([
    ['has no execution receipt', undefined, 'did not retain a complete normalized execution receipt'],
    ['has a different execution receipt fingerprint', {
      sourceFingerprint: 'a'.repeat(64),
      compiledSqlFingerprint: 'b'.repeat(64),
      parameterFingerprint: 'e'.repeat(64),
      resultFingerprint: 'f'.repeat(64),
    }, 'execution receipt does not match the canonical result'],
  ])('does not bind a dependent child when the parent %s (E2E-010)', (_label, executionReceipt, message) => {
    const parent = normalizeCanonicalQueryResult({
      columns: ['region', 'revenue'],
      rows: [{ region: 'Philadelphia', revenue: 450_969.65 }],
      resultFingerprint: 'c'.repeat(64),
      ...(executionReceipt ? { executionReceipt } : {}),
    });
    expect(resolveTopRankedRegionDependency('task-1', parent)).toMatchObject({
      ok: false,
      code: 'RESULT_CONTRACT_MISMATCH',
      message: expect.stringContaining(message),
    });
  });

  it('round-trips a compound plan and partial outcomes for reload-safe rendering', () => {
    const plan = buildAnalyticalTurnPlan({
      question: 'What region has top revenue, and which products drive it?',
      candidateIds: ['semantic:metric:revenue', 'semantic:dimension:region'],
      frozen: true,
      snapshotId: 'snapshot-1',
    });
    const persisted = JSON.parse(JSON.stringify({
      analyticalTurnPlan: plan,
      analyticalTaskOutcomes: [
        { version: 1, taskId: plan.taskIds[0], status: 'completed', resultFingerprint: 'a'.repeat(64) },
        {
          version: 1,
          taskId: plan.taskIds[1],
          status: 'gap',
          gap: buildCoverageGap({
            code: 'MISSING_RELATIONSHIP',
            phase: 'planning',
            message: 'No proven product driver relationship was found.',
            searchedSources: ['semantic', 'dbt_manifest'],
            attemptedRoutes: ['certified', 'semantic', 'governed_relational', 'generated'],
            missing: ['product.revenue'],
            recoverable: true,
            planFrozen: true,
            nextActions: ['Review the product relationship and retry this clause.'],
          }),
        },
      ],
    }));
    expect(persisted.analyticalTurnPlan.taskIds).toEqual(plan.taskIds);
    expect(persisted.analyticalTaskOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: plan.taskIds[0], status: 'completed' }),
      expect.objectContaining({ taskId: plan.taskIds[1], status: 'gap', gap: expect.objectContaining({ planFrozen: true }) }),
    ]));
  });

  it('makes the one-call interpretation budget explicit and reserves zero for bound turns', () => {
    expect(buildAnalyticalTurnPlan({ question: 'top customers by revenue' }).meaningCallBudget).toBe(1);
    expect(buildAnalyticalTurnPlan({
      question: 'what region is this customer in?',
      zeroCallReason: 'explicit_binding',
    })).toMatchObject({ meaningCallBudget: 0, meaningCallReason: 'explicit_binding' });
  });

  it('keeps an explicit Research story as one root task before clause splitting (AGT-033)', () => {
    const question = 'Research why revenue changed, then tell a story about the customer and product drivers?';
    const graph = buildAnalyticalTaskGraph({ question, mode: 'research' });

    expect(graph).toMatchObject({ kind: 'research', partial: false });
    expect(graph.tasks).toHaveLength(1);
    expect(graph.tasks[0]).toMatchObject({
      kind: 'research_branch',
      question,
      dependencies: [],
    });
    expect(buildAnalyticalTurnPlan({ question, mode: 'research' })).toMatchObject({
      kind: 'research',
      taskIds: ['task-1'],
    });
  });
});

describe('splitAnalyticalTasks separators', () => {
  it('does not carry the separator into the child clause', () => {
    // The reader pasted two questions joined by `" then "`. The clause split is
    // correct; the punctuation must not travel with it and become the task title.
    const parts = splitAnalyticalTasks(
      'Who are the top 10 customers by revenue?" then "What customer type is Wesley Jenkins?',
    );
    expect(parts).toEqual([
      'Who are the top 10 customers by revenue',
      'What customer type is Wesley Jenkins',
    ]);
  });

  it('keeps an ordinary single question untouched', () => {
    expect(splitAnalyticalTasks('What customer type is Wesley Jenkins?'))
      .toEqual(['What customer type is Wesley Jenkins']);
  });
});
