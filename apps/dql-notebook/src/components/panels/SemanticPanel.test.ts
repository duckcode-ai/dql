import { describe, expect, it } from 'vitest';
import { buildNotebookSemanticBlock } from './semantic-notebook-source';

describe('buildNotebookSemanticBlock', () => {
  it('preserves governed metric and dimension bindings in an executable DQL cell', () => {
    expect(buildNotebookSemanticBlock(
      ['customer_lifetime_spend', 'order_count'],
      ['customer_name'],
    )).toBe([
      'block "customer_lifetime_spend_by_order_count_by_customer_name" {',
      '  type = "semantic"',
      '  metrics = ["customer_lifetime_spend", "order_count"]',
      '  dimensions = ["customer_name"]',
      '}',
    ].join('\n'));
  });

  it('deduplicates selections and emits a stable block name', () => {
    const source = buildNotebookSemanticBlock(['revenue', 'revenue'], ['month', 'month']);
    expect(source).toContain('block "revenue_by_month"');
    expect(source).toContain('metrics = ["revenue"]');
    expect(source).toContain('dimensions = ["month"]');
  });

  it('ID-001/UI-009 persists the technical metric and model-scoped dimension identities', () => {
    const source = buildNotebookSemanticBlock(
      ['eu_gb_months_bcm_qty'],
      ['bcm_hdr.effective_customer_account_name', 'bcm_ccu_pc.report_as_of_dt'],
    );
    expect(source).toContain('metrics = ["eu_gb_months_bcm_qty"]');
    expect(source).toContain(
      'dimensions = ["bcm_hdr.effective_customer_account_name", "bcm_ccu_pc.report_as_of_dt"]',
    );
    expect(source).not.toContain('Effective Customer Account Name');
  });

  it('AGT-014/UI-012 persists the selected entity path without replacing the model-scoped identity', () => {
    const source = buildNotebookSemanticBlock(
      ['percent_dod_acm'],
      ['sm_consumption_daily_metrics_detail.report_as_of_dt@via(bcm_ccu_pc)'],
    );
    expect(source).toContain(
      'dimensions = ["sm_consumption_daily_metrics_detail.report_as_of_dt@via(bcm_ccu_pc)"]',
    );
    expect(source).not.toContain('dimensions = ["bcm_ccu_pc__bcm_dtl__report_as_of_dt"]');
  });
});
