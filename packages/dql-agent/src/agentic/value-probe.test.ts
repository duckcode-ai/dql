import { describe, it, expect, vi } from 'vitest';
import {
  MAX_VALUE_PROBE_COLUMN_QUERIES,
  buildSearchValuesTool,
  buildValueProbeSql,
  isProbeSafeColumn,
} from './value-probe.js';

describe('isProbeSafeColumn — two gates, deny first', () => {
  it('allows identifier-shaped textual columns', () => {
    expect(isProbeSafeColumn({ name: 'customer_name', type: 'varchar' })).toBe(true);
    expect(isProbeSafeColumn({ name: 'productSku', type: 'text' })).toBe(true);
    expect(isProbeSafeColumn({ name: 'region', type: undefined })).toBe(true);
  });

  it('denies secrets and free text whatever the name shape suggests', () => {
    // Unconditional: no configuration can turn these on. An allow-list alone
    // eventually admits something it should not, because it grows by exception.
    for (const name of ['password_hash', 'api_token', 'customer_notes', 'user_password', 'account_secret', 'product_description']) {
      expect(isProbeSafeColumn({ name, type: 'varchar' }), name).toBe(false);
    }
  });

  it('denies email even though it is an identifier', () => {
    expect(isProbeSafeColumn({ name: 'user_email', type: 'varchar' })).toBe(false);
  });

  it('hard-denies government and social-insurance identifiers while retaining business names', () => {
    for (const name of [
      'social_security_number', 'social_insurance_number', 'ssn', 'sin',
      'medicare_id', 'medicaid_id', 'taxpayer_id', 'taxpayer_identification_number', 'tin', 'itin',
    ]) {
      expect(isProbeSafeColumn({ name, type: 'varchar' }), name).toBe(false);
    }
    expect(isProbeSafeColumn({ name: 'customer_name', type: 'varchar' })).toBe(true);
    expect(isProbeSafeColumn({ name: 'product_name', type: 'varchar' })).toBe(true);
  });

  it('hard-denies normalized tax, government, and birth-date aliases before identifier allow-listing', () => {
    // These are adversarial because all contain otherwise approved identifier
    // words such as `customer`, `id`, or `number`. The hard deny must survive
    // connector naming conventions, not only human-readable phrase spelling.
    for (const name of [
      'tax_number', 'taxNo', 'taxIdentifier',
      'government_id', 'governmentNumber', 'govt_identifier',
      'customer_birth_dt', 'birth_date', 'date_of_birth', 'customerDOB',
      // Compact connector aliases must remain denied even when an approved
      // entity token precedes them.
      'customer_taxnumber', 'customer_birthdt', 'customer_birth_on',
      'taxno', 'birthon', 'customerTaxNumber', 'customerBirthOn',
    ]) {
      expect(isProbeSafeColumn({ name, type: 'varchar' }), name).toBe(false);
    }
    // Keep the business keys that runtime member grounding needs.
    expect(isProbeSafeColumn({ name: 'customer_id', type: 'varchar' })).toBe(true);
    expect(isProbeSafeColumn({ name: 'product_number', type: 'varchar' })).toBe(true);
    expect(isProbeSafeColumn({ name: 'category_id', type: 'varchar' })).toBe(true);
  });

  it('denies a column whose name suggests nothing identifying', () => {
    expect(isProbeSafeColumn({ name: 'created_at', type: 'varchar' })).toBe(false);
    expect(isProbeSafeColumn({ name: 'x1', type: 'varchar' })).toBe(false);
  });

  it('denies a known non-textual type, allows an unknown one', () => {
    // A literal cannot live in a float. An absent type is common in drivers and
    // the name gates have already passed.
    expect(isProbeSafeColumn({ name: 'customer_id', type: 'bigint' })).toBe(false);
    expect(isProbeSafeColumn({ name: 'customer_id' })).toBe(true);
  });
});

describe('buildValueProbeSql', () => {
  it('matches exactly, then by prefix on the longer tokens', () => {
    const sql = buildValueProbeSql('dim_customers', 'customer_name', ['Wesley Jenkins'])!;
    expect(sql).toContain(`= 'wesley jenkins'`);
    expect(sql).toContain(`LIKE 'wesley%'`);
    expect(sql).toContain('LIMIT 25');
  });

  it('uses a prefix, never a leading wildcard', () => {
    // A leading %term% cannot use an index; on a large dimension table that is
    // the difference between a probe and an outage.
    const sql = buildValueProbeSql('t', 'customer_name', ['acme'])!;
    expect(sql).not.toContain("LIKE '%");
  });

  it('escapes quotes and LIKE wildcards in the literal', () => {
    const sql = buildValueProbeSql('t', 'customer_name', ["O'Brien"])!;
    expect(sql).toContain("'o''brien'");
    const wild = buildValueProbeSql('t', 'customer_name', ['100% pure'])!;
    expect(wild).toContain('\\%');
  });

  it('refuses an identifier that is not a plain name', () => {
    // Identifiers come from the SCHEMA, never the user; anything exotic means a
    // caller is passing something it should not.
    expect(buildValueProbeSql('t; DROP TABLE x', 'c', ['a'])).toBeUndefined();
    expect(buildValueProbeSql('t', 'c"; DROP TABLE x --', ['a'])).toBeUndefined();
  });

  it('returns nothing when no usable term was given', () => {
    expect(buildValueProbeSql('t', 'customer_name', ['   '])).toBeUndefined();
  });
});

describe('search_values', () => {
  const relations = [{
    relation: 'dim_customers',
    columns: [{ name: 'customer_name', type: 'varchar' }, { name: 'lifetime_spend', type: 'double' }],
  }];

  it('finds a value and reports its exact stored spelling', async () => {
    // The loop needs the stored spelling to build a filter that matches.
    const execute = vi.fn(async () => ({ rows: [['Wesley Jenkins']] }));
    const tool = buildSearchValuesTool({ execute, relations, enabled: true });
    const result = await tool.run({ terms: ['wesley jenkins'] }) as Record<string, unknown>;
    expect(result).toMatchObject({ searched: true });
    expect(result.matches).toEqual([{ relation: 'dim_customers', column: 'customer_name', values: ['Wesley Jenkins'] }]);
  });

  it('never probes a column that failed the gates', async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    await buildSearchValuesTool({ execute, relations, enabled: true }).run({ terms: ['x'] });
    for (const call of execute.mock.calls) expect(String(call[0])).not.toContain('lifetime_spend');
  });

  it('says WHY when lookup is disabled instead of returning empty', async () => {
    // A silent empty result here is what produced the false-absence defect: the
    // loop concluded a value did not exist when it had never been allowed to look.
    const execute = vi.fn(async () => ({ rows: [] }));
    const result = await buildSearchValuesTool({ execute, relations, enabled: false }).run({ terms: ['x'] }) as Record<string, unknown>;
    expect(result.searched).toBe(false);
    expect(String(result.reason)).toMatch(/runtimeValueGrounding/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('distinguishes "looked and found nothing" from "did not look"', async () => {
    const result = await buildSearchValuesTool({ execute: async () => ({ rows: [] }), relations, enabled: true })
      .run({ terms: ['nobody'] }) as Record<string, unknown>;
    expect(result.searched).toBe(true);
    expect(result.matches).toEqual([]);
    expect(String(result.note)).toMatch(/found no match/i);
    expect(result.coverage).toMatchObject({ status: 'complete' });
    expect(result.absence).toBe('not_found');
  });

  it('survives an unreadable relation rather than failing the whole probe', async () => {
    // A permission error on one table is normal in a governed warehouse.
    const execute = vi.fn(async () => { throw new Error('permission denied'); });
    const result = await buildSearchValuesTool({ execute, relations, enabled: true }).run({ terms: ['x'] }) as Record<string, unknown>;
    expect(result.searched).toBe(true);
    expect(result.matches).toEqual([]);
    expect(result.coverage).toMatchObject({ status: 'partial', failedRelations: ['dim_customers'] });
    expect(result.absence).toBeUndefined();
  });

  it('does not claim absence when coverage is partial or requests an unknown relation', async () => {
    const noSearchable = [{ relation: 'private_notes', columns: [{ name: 'customer_notes', type: 'varchar' }] }];
    const partial = await buildSearchValuesTool({ execute: async () => ({ rows: [] }), relations: noSearchable, enabled: true })
      .run({ terms: ['nobody'] }) as Record<string, unknown>;
    expect(partial.coverage).toMatchObject({ status: 'partial', relationsWithNoSearchableColumn: ['private_notes'] });
    expect(partial.absence).toBeUndefined();

    const unknown = await buildSearchValuesTool({ execute: async () => ({ rows: [] }), relations, enabled: true })
      .run({ terms: ['nobody'], relations: ['not_a_relation'] }) as Record<string, unknown>;
    expect(unknown.coverage).toMatchObject({ status: 'unknown_relation', unknownRelations: ['not_a_relation'] });
    expect(unknown.absence).toBeUndefined();
  });

  it('never turns an unbuildable schema identifier into a zero-query absence claim', async () => {
    // These names can arrive from a connector's metadata. They pass the
    // business-identifier policy, but they cannot be encoded in the deliberately
    // strict ANSI identifier builder, so coverage must remain incomplete.
    const execute = vi.fn(async () => ({ rows: [] }));
    const result = await buildSearchValuesTool({
      execute,
      relations: [{
        relation: 'customer-data',
        columns: [{ name: 'customer-name', type: 'varchar' }],
      }],
      enabled: true,
    }).run({ terms: ['nobody'] }) as Record<string, unknown>;

    expect(execute).not.toHaveBeenCalled();
    expect(result.searched).toBe(false);
    expect(result.coverage).toMatchObject({
      status: 'partial',
      queriesAttempted: 0,
      relationsSearched: [],
      relationsWithUnbuildableIdentifier: ['customer-data'],
    });
    expect(result.absence).toBeUndefined();
  });

  it('caps all column probes at twelve and never turns a budget stop into absence', async () => {
    const wide = [{
      relation: 'wide_dimension',
      columns: Array.from({ length: MAX_VALUE_PROBE_COLUMN_QUERIES + 1 }, (_, index) => ({
        name: `customer_name_${index}`,
        type: 'varchar',
      })),
    }];
    const execute = vi.fn(async () => ({ rows: [] }));
    const result = await buildSearchValuesTool({
      execute,
      relations: wide,
      enabled: true,
      maxColumnQueries: 100,
    }).run({ terms: ['nobody'] }) as Record<string, unknown>;
    expect(execute).toHaveBeenCalledTimes(MAX_VALUE_PROBE_COLUMN_QUERIES);
    expect(result.coverage).toMatchObject({
      status: 'budget_exhausted',
      queryLimit: MAX_VALUE_PROBE_COLUMN_QUERIES,
      queriesAttempted: MAX_VALUE_PROBE_COLUMN_QUERIES,
    });
    expect(result.absence).toBeUndefined();
  });

  it('bounds how many relations one question can touch', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      relation: `t_${i}`, columns: [{ name: 'customer_name', type: 'varchar' }],
    }));
    const result = await buildSearchValuesTool({ execute: async () => ({ rows: [] }), relations: many, enabled: true, maxRelations: 3 })
      .run({ terms: ['x'] }) as { relationsSearched: string[] };
    expect(result.relationsSearched).toHaveLength(3);
  });

  it('refuses an empty request with a message', async () => {
    const result = await buildSearchValuesTool({ execute: async () => ({ rows: [] }), relations, enabled: true })
      .run({ terms: [] }) as { error?: string };
    expect(result.error).toMatch(/literal/i);
  });
});
