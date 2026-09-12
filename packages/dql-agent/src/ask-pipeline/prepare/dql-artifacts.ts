import type { DqlArtifactReference } from '@duckcodeailabs/dql-core';
import { renderSemanticDqlArtifact, semanticDqlArtifactName } from '../../semantic-bridge/compose.js';
import type { SemanticCompileRequest } from './types.js';

/**
 * THE DQL AN ANSWER RAN. "How it was answered" shows the DQL first and the SQL
 * it compiled to second: a semantic answer is a semantic block over the
 * metrics, dimensions, filters, grain, order and limit the engine compiled.
 */
export function semanticAnswerArtifact(request: SemanticCompileRequest, reading: string, compiledSql: string): DqlArtifactReference {
  const filters = (request.filters ?? [])
    .filter((filter) => filter.dimension && filter.operator)
    .map((filter) => ({ dimension: filter.dimension!, operator: filter.operator!, values: (filter.values ?? []).map((value) => String(value)) }));
  const orderBy = (request.orderBy ?? []).filter((order) => order.name).map((order) => ({ name: order.name, direction: order.direction ?? 'asc' as const }));
  const input = {
    question: reading,
    metrics: request.metrics,
    dimensions: request.dimensions,
    filters,
    ...(request.timeDimension ? { timeDimension: request.timeDimension } : {}),
    ...(orderBy.length ? { orderBy } : {}),
    ...(request.limit ? { limit: request.limit } : {}),
  };
  const name = semanticDqlArtifactName(input);
  return {
    kind: 'semantic_block',
    name,
    source: renderSemanticDqlArtifact({ ...input, name }),
    metrics: request.metrics,
    dimensions: request.dimensions,
    ...(filters.length ? { filters } : {}),
    ...(request.timeDimension ? { timeDimension: request.timeDimension } : {}),
    ...(orderBy.length ? { orderBy } : {}),
    ...(request.limit ? { limit: request.limit } : {}),
    persistence: 'transient',
    trustState: 'governed',
    compiledSql,
  } as DqlArtifactReference;
}

/** An AI-written statement as a draft DQL block: review-required until a person certifies it. */
export function sqlAnswerArtifact(sql: string, reading: string): DqlArtifactReference {
  const name = (reading.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'ai_drafted_answer').replace(/^(\d)/, 'q_$1');
  const source = [
    `block "${name}" {`,
    '  type = "custom"',
    '  status = "draft"',
    `  description = "${reading.replace(/"/g, "'").slice(0, 200)}"`,
    '  query = """',
    ...sql.split('\n').map((line) => `    ${line}`),
    '  """',
    '}',
  ].join('\n');
  return { kind: 'sql_block', name, source, persistence: 'transient', trustState: 'review_required', compiledSql: sql };
}
