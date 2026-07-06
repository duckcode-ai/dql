import {
  applyGroundingExpansion,
  ensureMetadataCatalogFresh,
  expandGroundingFromCatalog,
  mcpTier2RegroundRepairBudget,
  openMetadataCatalog,
  type GroundingExpansionResult,
  type LocalContextPack,
} from '@duckcodeailabs/dql-agent';
import type { DQLContext } from '../context.js';
import { zodInputShapeForTool } from '../tool-schema.js';

export const expandContextInput = zodInputShapeForTool('expand_context');

export async function expandContext(
  ctx: DQLContext,
  args: {
    contextPackId: string;
    relations: string[];
    question?: string;
  },
) {
  await ensureMetadataCatalogFresh(ctx.projectRoot);
  const catalog = openMetadataCatalog(ctx.projectRoot);
  try {
    const existing = catalog.getContextPack(args.contextPackId);
    if (!existing) {
      return {
        ok: false,
        error: `No context pack found for id "${args.contextPackId}". Re-run ask_dql or inspect_metadata_context.`,
      };
    }

    const question = args.question?.trim() || existing.question;
    const expansions: GroundingExpansionResult[] = [];
    const missed: string[] = [];
    for (const relation of uniqueStrings(args.relations.map((value) => value.trim()).filter(Boolean))) {
      const expansion = expandGroundingFromCatalog(catalog, {
        question,
        sql: relation,
        code: 'unknown_relation',
        offending: { relation },
        contextPack: existing,
      });
      if (expansion && expansion.relations.length > 0) expansions.push(expansion);
      else missed.push(relation);
    }

    const combined = combineExpansions(expansions);
    const merged = applyGroundingExpansion(existing, [], combined);
    if (!combined || !merged.contextPack) {
      return {
        ok: false,
        contextPackId: existing.id,
        missed,
        error: missed.length > 0
          ? `No requested relation(s) were found in the metadata catalog or runtime schema: ${missed.join(', ')}.`
          : 'No additional context was found for the requested relation(s).',
      };
    }

    const payload = contextPackWithoutId({
      ...merged.contextPack,
      question,
      retrievalDiagnostics: {
        ...merged.contextPack.retrievalDiagnostics,
        strategy: 'expanded_context',
        selectedRelations: summarizeSelectedRelations(merged.contextPack),
      },
    });
    const expandedId = catalog.insertContextPack(payload);
    const expandedPack: LocalContextPack = { ...payload, id: expandedId };
    const addedRelations = combined.relations.map((relation) => ({
      relation: relation.relation,
      name: relation.name,
      source: relation.source,
      columnCompleteness: relation.columnCompleteness,
      columns: relation.columns.slice(0, 32).map((column) => ({
        name: column.name,
        type: column.type,
      })),
    }));

    return {
      ok: true,
      previousContextPackId: existing.id,
      contextPackId: expandedId,
      regroundAttemptsUsed: 1,
      repairBudget: mcpTier2RegroundRepairBudget(1),
      addedRelations,
      missed,
      notes: combined.notes,
      allowedSqlContext: {
        relationCount: expandedPack.allowedSqlContext.relations.length,
        relations: expandedPack.allowedSqlContext.relations.slice(0, 24).map((relation) => ({
          relation: relation.relation,
          name: relation.name,
          source: relation.source,
          columnCompleteness: relation.columnCompleteness,
          columns: relation.columns.slice(0, 32).map((column) => column.name),
        })),
      },
      nextTool: 'query_via_metadata',
    };
  } finally {
    catalog.close();
  }
}

function combineExpansions(expansions: GroundingExpansionResult[]): GroundingExpansionResult | undefined {
  if (expansions.length === 0) return undefined;
  return {
    relations: expansions.flatMap((expansion) => expansion.relations),
    schemaContext: expansions.flatMap((expansion) => expansion.schemaContext ?? []),
    notes: uniqueStrings(expansions.flatMap((expansion) => expansion.notes)).slice(0, 16),
  };
}

function contextPackWithoutId(pack: LocalContextPack): Omit<LocalContextPack, 'id'> {
  const { id: _id, ...payload } = pack;
  return payload;
}

function summarizeSelectedRelations(pack: LocalContextPack): NonNullable<LocalContextPack['retrievalDiagnostics']['selectedRelations']> {
  return pack.allowedSqlContext.relations.slice(0, 24).map((relation, index) => ({
    relation: relation.relation,
    name: relation.name,
    source: relation.source,
    score: index === 0 ? 1 : Math.max(0.1, 1 - index / 24),
    reason: 'relation retained in expanded context pack',
    columns: relation.columns.slice(0, 24).map((column) => column.name),
    rank: index + 1,
  }));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}
