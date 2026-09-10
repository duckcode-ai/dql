import { describe, expect, it } from 'vitest';
import { buildTermTemplate, termFilePath, termSlug } from './term-authoring.js';

describe('a term is authored from one template, whoever writes it', () => {
  it('writes the governed fields, quoting every value', () => {
    const text = buildTermTemplate({ title: 'Net ARR', domain: 'finance', owner: 'finance@co.test', description: 'Annual recurring revenue net of churn.', type: 'metric', synonyms: ['ARR "net"'], businessRules: ['Use fct_arr.net_arr'], metricRefs: ['net_arr'] });
    expect(text).toContain('term "Net ARR" {');
    expect(text).toContain('domain = "finance"');
    expect(text).toContain('type = "metric"');
    expect(text).toContain('status = "draft"');
    expect(text).toContain('identifiers = ["net_arr_id"]');
    expect(text).toContain('synonyms = ["ARR \\"net\\""]');
    expect(text).toContain('metricRefs = ["net_arr"]');
    expect(text).toContain('businessRules = ["Use fct_arr.net_arr"]');
    expect(text.trim().endsWith('}')).toBe(true);
  });
  it('names the file by a slug of the title inside the domain', () => {
    expect(termSlug('Net ARR (rolling)')).toBe('net_arr_rolling');
    expect(termFilePath('finance', 'Net ARR')).toBe('domains/finance/terms/net_arr.dql');
  });
});
