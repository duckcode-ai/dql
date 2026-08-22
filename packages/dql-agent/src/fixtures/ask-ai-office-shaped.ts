/**
 * Sanitized, non-customer regression prompts derived from the Ask AI failure
 * reports. They intentionally contain only generic business concepts and no
 * office identifiers, SQL, data values, or provider configuration.
 *
 * Gold results stay out of runtime prompt context. The fixture is test-only
 * guidance for the deterministic requirement/ranking contracts.
 */
export const OFFICE_ASK_AI_GOLD_CASES = [
  {
    id: 'office-lost-opportunities-fy26-datadog',
    question: 'Lost opportunities count and lost amount by month for fiscal year FY26 with competitor Datadog',
    expected: { measures: ['lost opportunities count', 'lost amount'], dimension: 'competitor', grain: 'month', fiscalPeriod: 'FY26' },
  },
  {
    id: 'office-top-bcm-customers-by-revenue',
    question: 'Who are the top BCM customers who have highest revenue?',
    expected: { rankingMeasure: 'revenue', entity: 'customer', defaultTop: 10 },
  },
  {
    id: 'office-bcm-run-rate-top-accounts',
    question: 'What is the current BCM run rate across top accounts?',
    expected: { rankingMeasure: 'BCM', entity: 'account', defaultTop: 10 },
  },
] as const;

/**
 * Test-only, sanitized metadata fixture for the three reported journeys. This
 * deliberately mirrors the kinds of artifacts Ask consumes (semantic objects,
 * dbt relations, runtime columns, and a declared fiscal calendar) without
 * containing a customer repository, warehouse data, credentials, or gold SQL.
 *
 * Gold result values are intentionally absent: evaluation checks route,
 * selected roles, trust, and safety rather than leaking answers into runtime
 * guidance.
 */
export const OFFICE_ASK_AI_SANITIZED_FIXTURE = {
  version: 1,
  snapshotId: 'fixture:office-ask-ai:v1',
  fiscalCalendar: {
    id: 'semantic:calendar:fiscal',
    fiscalPeriodFieldId: 'semantic:dimension:opportunity.fiscal_period',
    dateRoleId: 'semantic:dimension:opportunity.close_date',
  },
  semantic: {
    metrics: [
      { id: 'semantic:metric:lost_opportunities_count', name: 'Lost Opportunities Count', roles: ['metric'] },
      { id: 'semantic:metric:lost_amount', name: 'Lost Amount', roles: ['metric'] },
      { id: 'semantic:metric:revenue', name: 'Revenue', roles: ['metric'] },
      { id: 'semantic:metric:bcm_run_rate', name: 'BCM Run Rate', roles: ['metric'] },
    ],
    dimensions: [
      { id: 'semantic:dimension:opportunity.competitor', name: 'Competitor', roles: ['categorical_dimension'] },
      { id: 'semantic:dimension:opportunity.close_date', name: 'Close Date', roles: ['time_dimension'] },
      { id: 'semantic:dimension:opportunity.fiscal_period', name: 'Fiscal Period', roles: ['time_dimension'] },
      { id: 'semantic:dimension:account.name', name: 'Account Name', roles: ['entity_label'] },
      { id: 'semantic:dimension:customer.name', name: 'Customer Name', roles: ['entity_label'] },
    ],
  },
  dbtManifest: {
    models: [
      {
        id: 'model:analytics.opportunities',
        relation: 'analytics.opportunities',
        columns: ['close_date', 'fiscal_period', 'competitor', 'lost_amount', 'is_lost'],
      },
      {
        id: 'model:analytics.account_revenue',
        relation: 'analytics.account_revenue',
        columns: ['account_name', 'customer_name', 'revenue', 'bcm_run_rate'],
      },
    ],
  },
  runtimeSchema: {
    relations: [
      { relation: 'analytics.opportunities', columns: ['close_date', 'fiscal_period', 'competitor', 'lost_amount', 'is_lost'] },
      { relation: 'analytics.account_revenue', columns: ['account_name', 'customer_name', 'revenue', 'bcm_run_rate'] },
    ],
  },
  relationships: [
    {
      id: 'relationship:opportunity_account',
      from: 'analytics.opportunities',
      to: 'analytics.account_revenue',
      cardinality: 'many_to_one',
      fanoutSafe: true,
    },
  ],
  evals: OFFICE_ASK_AI_GOLD_CASES.map((entry) => ({
    ...entry,
    goldSqlWithheld: true,
    goldResultWithheld: true,
  })),
} as const;
