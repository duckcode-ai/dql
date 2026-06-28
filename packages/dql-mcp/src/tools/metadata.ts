/**
 * Grounded-SQL metadata tools (spec 15.5) — thin wrappers over the dbt catalog
 * + the shared sql-grounding so EXTERNAL agents look up the same context the
 * notebook build path uses:
 *
 *   - `search_metadata`   — rank dbt tables relevant to a request, with their
 *                           qualified relation + {{ ref() }} form.
 *   - `get_table_schema`  — the qualified relation, {{ ref() }} form, real
 *                           columns + types, and join keys for a table.
 *   - `validate_sql`      — validate a SQL string references ONLY known
 *                           relations/columns, returning the precise miss.
 *
 * All three load dbt artifacts read-only and never write. They degrade
 * gracefully (a clear hint) when no dbt manifest is present.
 */

import { z } from 'zod';
import { resolveDbtManifestPath } from '@duckcodeailabs/dql-core';
import {
  buildSchemaGrounding,
  loadDbtArtifacts,
  relationKeys,
  selectRelevantModels,
  validateSqlAgainstGrounding,
  type DbtArtifacts,
} from '@duckcodeailabs/dql-agent';
import type { DQLContext } from '../context.js';

/** Load dbt artifacts for the project, or undefined when no manifest exists. */
function loadArtifacts(ctx: DQLContext): DbtArtifacts | undefined {
  const manifestPath = resolveDbtManifestPath(ctx.projectRoot);
  if (!manifestPath) return undefined;
  try {
    return loadDbtArtifacts(manifestPath);
  } catch {
    return undefined;
  }
}

const NO_MANIFEST_HINT =
  'No dbt manifest was found. Run `dbt compile`/`dbt build` (or `dql sync dbt`) so target/manifest.json exists.';

// ─── search_metadata ──────────────────────────────────────────────────────────

export const searchMetadataInput = {
  query: z.string().describe('Natural-language request to find relevant tables for.'),
  limit: z.number().int().min(1).max(40).optional().describe('Max tables to return (default 12).'),
};

export async function searchMetadata(ctx: DQLContext, args: { query: string; limit?: number }) {
  const artifacts = loadArtifacts(ctx);
  if (!artifacts) return { tables: [], hint: NO_MANIFEST_HINT };
  const topK = args.limit ?? 12;
  const relevant = await selectRelevantModels(artifacts, args.query, { topK });
  const grounding = buildSchemaGrounding(artifacts, relevant, { limit: topK });
  return {
    total: grounding.tables.length,
    tables: grounding.tables.map((table) => ({
      name: table.name,
      qualifiedRelation: table.qualifiedRelation,
      refForm: table.refForm ?? null,
      kind: table.kind,
      columnCount: table.columns.length,
      certifiedBlock: table.certifiedBlock ?? false,
    })),
  };
}

// ─── get_table_schema ─────────────────────────────────────────────────────────

export const getTableSchemaInput = {
  table: z.string().describe('Model name, alias, or qualified relation (e.g. order_items or dev.order_items).'),
};

export function getTableSchema(ctx: DQLContext, args: { table: string }) {
  const artifacts = loadArtifacts(ctx);
  if (!artifacts) return { found: false, hint: NO_MANIFEST_HINT };
  // Ground the whole project so we can look up any relation and surface joins.
  const grounding = buildSchemaGrounding(artifacts, undefined, { limit: 500 });
  const keys = relationKeys(args.table);
  const table = keys.map((key) => grounding.byKey.get(key)).find(Boolean);
  if (!table) {
    return {
      found: false,
      hint: `Table "${args.table}" was not found. Use search_metadata to discover available relations.`,
    };
  }
  const joinKeys = grounding.joinKeys.filter(
    (join) =>
      join.leftRelation === table.qualifiedRelation || join.rightRelation === table.qualifiedRelation,
  );
  return {
    found: true,
    name: table.name,
    qualifiedRelation: table.qualifiedRelation,
    refForm: table.refForm ?? null,
    kind: table.kind,
    certifiedBlock: table.certifiedBlock ?? false,
    columns: table.columns.map((column) => ({ name: column.name, type: column.type ?? null, description: column.description ?? null })),
    joinKeys: joinKeys.map((join) => ({
      leftRelation: join.leftRelation,
      leftColumn: join.leftColumn,
      rightRelation: join.rightRelation,
      rightColumn: join.rightColumn,
      reason: join.reason,
    })),
  };
}

// ─── validate_sql ─────────────────────────────────────────────────────────────

export const validateSqlInput = {
  sql: z.string().describe('A read-only SELECT/WITH query to validate against the dbt schema.'),
  query: z
    .string()
    .optional()
    .describe('Optional original request, used to scope the grounding to relevant tables.'),
};

export async function validateSql(ctx: DQLContext, args: { sql: string; query?: string }) {
  const artifacts = loadArtifacts(ctx);
  if (!artifacts) {
    return { ok: false, code: 'no_schema', error: NO_MANIFEST_HINT, warnings: [] };
  }
  // Ground broadly (so a valid table is never wrongly flagged), optionally
  // ordered by the original request.
  const relevant = args.query ? await selectRelevantModels(artifacts, args.query, { topK: 500 }) : undefined;
  const grounding = buildSchemaGrounding(artifacts, relevant, { limit: 500 });
  const result = validateSqlAgainstGrounding(args.sql, grounding);
  if (result.ok) {
    return { ok: true, warnings: result.warnings, referencedRelations: result.referencedRelations };
  }
  return {
    ok: false,
    code: result.code,
    error: result.error,
    warnings: result.warnings,
    referencedRelations: result.referencedRelations,
    offending: result.offending ?? null,
  };
}
