import type {
  LocalContextPack,
  MetadataAgentIntent,
  RuntimeSchemaTable,
} from '../metadata/catalog.js';
import {
  validateSqlAgainstLocalContext,
  type SqlContextValidationResult,
} from '../metadata/sql-context-validation.js';
import {
  buildGroundingFromRuntimeRelations,
  resolveRelationsInSql,
  validateSqlAgainstGrounding,
  type GroundingValidationResult,
  type RelationResolution,
  type SchemaGrounding,
} from '../metadata/sql-grounding.js';
import {
  applyGroundingExpansion,
  type GroundingExpansionResult,
} from './regrounding.js';

export interface ContextLedgerInput {
  contextPack?: LocalContextPack;
  schemaContext?: RuntimeSchemaTable[];
  dialect?: string;
}

export interface ContextLedgerSqlValidationOptions {
  question?: string;
  intent?: MetadataAgentIntent | string;
  filterValues?: string[];
  trustedFilterValues?: string[];
  memberBindings?: Array<{ dimension: string; values: string[] }>;
}

export interface ContextLedgerExpansionResult {
  ledger: ContextLedger;
  notes: string[];
}

export class ContextLedger {
  readonly contextPack?: LocalContextPack;
  readonly schemaContext: RuntimeSchemaTable[];
  readonly grounding?: SchemaGrounding;
  readonly dialect?: string;

  constructor(input: ContextLedgerInput = {}) {
    this.contextPack = input.contextPack;
    this.schemaContext = input.schemaContext ?? [];
    this.dialect = input.dialect;
    this.grounding = buildRuntimeGrounding(this.schemaContext);
  }

  qualifySql(sql: string): RelationResolution {
    if (!this.grounding) return { sql, rewrites: [] };
    return resolveRelationsInSql(sql, this.grounding, { prefer: 'qualified' });
  }

  validateSql(
    sql: string,
    options: ContextLedgerSqlValidationOptions = {},
  ): SqlContextValidationResult {
    return validateSqlAgainstLocalContext(sql, this.contextPack, {
      ...options,
      dialect: this.dialect,
      runtimeSchema: this.schemaContext,
    });
  }

  validateRuntimeGrounding(sql: string): GroundingValidationResult | undefined {
    return this.grounding ? validateSqlAgainstGrounding(sql, this.grounding, this.dialect) : undefined;
  }

  withExpansion(expansion: GroundingExpansionResult | undefined): ContextLedgerExpansionResult {
    const merged = applyGroundingExpansion(this.contextPack, this.schemaContext, expansion);
    return {
      ledger: new ContextLedger({
        contextPack: merged.contextPack,
        schemaContext: merged.schemaContext,
        dialect: this.dialect,
      }),
      notes: merged.notes,
    };
  }
}

export function createContextLedger(input: ContextLedgerInput = {}): ContextLedger {
  return new ContextLedger(input);
}

function buildRuntimeGrounding(schemaContext: RuntimeSchemaTable[]): SchemaGrounding | undefined {
  if (schemaContext.length === 0) return undefined;
  return buildGroundingFromRuntimeRelations(
    schemaContext.map((table) => ({
      relation: table.relation,
      name: table.name,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type,
        description: column.description,
      })),
    })),
  );
}
