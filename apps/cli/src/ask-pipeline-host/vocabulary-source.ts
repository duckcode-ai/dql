import type { DQLManifest, SemanticLayer } from '@duckcodeailabs/dql-core';
import { buildVocabularyIndex, extractBlockContract, type VocabularyEntry, type VocabularyIndex, type VocabularySource } from '@duckcodeailabs/dql-agent';

/**
 * The whole authorized vocabulary of a project, from the objects the host
 * already holds: the semantic layer (metrics, measures, dimensions,
 * entities, models and their join graph), the DQL manifest (certified
 * blocks with their SQL, business terms) and the dbt sources it recorded
 * (physical relations and documented columns). Physical bindings let the
 * relational tier express what the semantic engines cannot.
 */

export interface VocabularySourceInput {
  semanticLayer?: SemanticLayer;
  manifest?: DQLManifest;
  /** Runtime relations the host has introspected, when the manifest has no dbt sources. */
  relations?: Array<{ schema?: string; name: string; description?: string; columns: Array<{ name: string; dataType?: string; description?: string }> }>;
}

/** `"jaffle_shop"."dev"."customers"` and `jaffle_shop.dev.customers` become `dev.customers`. */
export function normalizeRelationName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parts = value.replace(/"/g, '').replace(/`/g, '').split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.slice(-2).join('.');
}

const AGGREGATES = new Set(['sum', 'avg', 'count', 'count_distinct', 'min', 'max', 'median']);
const isIdentifier = (value: string | undefined): value is string => Boolean(value && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value));

const SQL_WORDS = new Set(['case', 'when', 'then', 'else', 'end', 'and', 'or', 'not', 'null', 'true', 'false', 'is', 'in', 'like', 'ilike', 'distinct', 'as', 'between', 'exists', 'cast', 'interval', 'date', 'timestamp', 'integer', 'bigint', 'varchar', 'double', 'decimal', 'numeric', 'boolean', 'day', 'week', 'month', 'quarter', 'year']);

/**
 * Qualify every bare column reference inside an expression with its relation
 * so a joined query is unambiguous (`product_price` exists on order lines AND
 * products). Known columns are qualified first; any other bare identifier that
 * is not a keyword, a function call, a number or part of a string literal is
 * treated as a column of the same relation.
 */
export function qualifyExpression(expr: string, relation: string, columns: Iterable<string>): string {
  const quoted = relation.split('.').map((part) => `"${part}"`).join('.');
  const literals: string[] = [];
  let out = expr.replace(/'(?:[^']|'')*'/g, (literal) => { literals.push(literal); return `__lit${literals.length - 1}__`; });
  const known = new Set([...columns].map((column) => column.toLowerCase()));
  out = out.replace(/(?<![\w."])([A-Za-z_][A-Za-z0-9_]*)(?![\w"]|\s*\()/g, (match, identifier: string) => {
    const lower = identifier.toLowerCase();
    if (/^__lit\d+__$/.test(identifier) || SQL_WORDS.has(lower)) return match;
    if (known.has(lower) || !/^\d/.test(identifier)) return `${quoted}."${identifier}"`;
    return match;
  });
  return out.replace(/__lit(\d+)__/g, (_m, index: string) => literals[Number(index)]!);
}

/** `{{ Dimension('order_id__is_drink_order') }} = true` becomes `{ column: 'is_drink_order', condition: '= true' }`. */
export function parseMetricFilter(filter: unknown): Array<{ column: string; condition: string; entityPath: string[] }> {
  const templates: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === 'string') templates.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(collect);
  };
  collect(filter);
  return templates.flatMap((template) => {
    const match = template.trim().match(/^\{\{\s*Dimension\(\s*'([^']+)'\s*\)\s*\}\}\s*(=|!=|<>|>=|<=|>|<|in|not in)\s*(.+?)\s*$/i);
    if (!match) return [];
    const parts = match[1]!.split('__');
    return [{ column: parts[parts.length - 1]!, entityPath: parts.slice(0, -1), condition: `${match[2]} ${match[3]}` }];
  });
}

export function buildVocabularySource(input: VocabularySourceInput): VocabularySource {
  const source: VocabularySource = { metrics: [], measures: [], dimensions: [], entities: [], models: [], blocks: [], relations: [], terms: [] };
  const relationColumns = new Map<string, Set<string>>();
  const relationSeen = new Set<string>();

  const addRelation = (relation: { schema?: string; name: string; description?: string; columns: Array<{ name: string; dataType?: string; description?: string }> }) => {
    const key = relation.schema ? `${relation.schema}.${relation.name}` : relation.name;
    if (relationSeen.has(key)) return;
    relationSeen.add(key);
    relationColumns.set(key, new Set(relation.columns.map((column) => column.name)));
    source.relations!.push(relation);
  };

  // Physical relations: dbt sources recorded in the manifest, then anything the host introspected.
  for (const item of Object.values(input.manifest?.sources ?? {})) {
    const dbt = item.dbtModel;
    if (!dbt) continue;
    const columns = Object.values(dbt.columns ?? {}).map((column) => ({ name: column.name, ...(column.type ? { dataType: column.type } : {}), ...(column.description ? { description: column.description } : {}) }));
    addRelation({ ...(dbt.schema ? { schema: dbt.schema } : {}), name: item.name, ...(dbt.description ? { description: dbt.description } : {}), columns });
  }
  for (const relation of input.relations ?? []) addRelation(relation);

  const layer = input.semanticLayer;
  if (layer) {
    const cubes = layer.listCubes();
    const relationOfCube = new Map<string, string>();
    for (const cube of cubes) {
      const relation = normalizeRelationName(cube.table) ?? cube.name;
      relationOfCube.set(cube.name, relation);
      if (!relationSeen.has(relation)) {
        addRelation({ ...(relation.includes('.') ? { schema: relation.split('.')[0] } : {}), name: relation.split('.').pop()!, ...(cube.description ? { description: cube.description } : {}), columns: [...cube.dimensions.map((d) => ({ name: d.name, dataType: d.type })), ...cube.measures.map((m) => ({ name: m.name }))] });
      }
    }
    const columnsOf = (cubeName: string) => relationColumns.get(relationOfCube.get(cubeName) ?? '') ?? new Set<string>();
    // Reachability: which cubes can reach a given cube through the join graph (bounded for very large layers).
    const reach = new Map<string, string[]>();
    if (cubes.length <= 200) {
      for (const target of cubes) {
        reach.set(target.name, cubes.filter((from) => from.name === target.name || layer.findJoinPath(from.name, target.name).length > 0).map((from) => from.name));
      }
    }
    const measures = layer.listMeasures();
    const measureByKey = new Map(measures.map((measure) => [`${measure.cube ?? ''}:${measure.name}`, measure]));
    const cubeColumns = (cubeName: string) => new Set([...columnsOf(cubeName), ...(cubes.find((cube) => cube.name === cubeName)?.dimensions.map((d) => d.name) ?? []), ...(cubes.find((cube) => cube.name === cubeName)?.measures.map((m) => m.name) ?? [])]);
    for (const metric of layer.listMetrics()) {
      const model = metric.cube ?? metric.semanticModelIds?.[0];
      const measureName = (metric.typeParams?.measure as { name?: string } | undefined)?.name ?? metric.name;
      const measure = model ? (measureByKey.get(`${model}:${measureName}`) ?? measureByKey.get(`${model}:${metric.name}`)) : undefined;
      const relation = model ? relationOfCube.get(model) : undefined;
      const aggregate = (measure?.agg ?? metric.aggregation ?? metric.type)?.toLowerCase();
      const simple = !metric.metricType || metric.metricType === 'simple';
      const filters = parseMetricFilter(metric.filter);
      // A filtered simple metric binds physically only when every filter column lives on the metric's own model.
      const knownColumns = model ? cubeColumns(model) : new Set<string>();
      const localFilters = filters.every((filter) => knownColumns.has(filter.column));
      let physical: { relation: string; expr: string; aggregate: string } | undefined;
      if (relation && measure && aggregate && AGGREGATES.has(aggregate) && simple && localFilters) {
        const base = qualifyExpression(measure.expr ?? measure.name, relation, knownColumns);
        const expr = filters.length
          ? `CASE WHEN ${filters.map((filter) => `${qualifyExpression(filter.column, relation, knownColumns)} ${filter.condition}`).join(' AND ')} THEN ${base}${aggregate === 'sum' || aggregate === 'count' ? ' ELSE 0' : ''} END`
          : base;
        physical = { relation, expr, aggregate };
      }
      // A derived or ratio metric over simple metrics of one model binds as an expression of their aggregates.
      if (!physical && (metric.metricType === 'derived' || metric.metricType === 'ratio')) {
        const params = metric.typeParams as { expr?: string; metrics?: Array<{ name?: string; alias?: string }>; numerator?: { name?: string } | string; denominator?: { name?: string } | string } | undefined;
        const numerator = typeof params?.numerator === 'string' ? params.numerator : params?.numerator?.name;
        const denominator = typeof params?.denominator === 'string' ? params.denominator : params?.denominator?.name;
        const expression = metric.metricType === 'ratio' && numerator && denominator ? `${numerator} / NULLIF(${denominator}, 0)` : params?.expr;
        const inputs = metric.metricType === 'ratio'
          ? [numerator, denominator].filter((name): name is string => Boolean(name)).map((name) => ({ name, alias: name }))
          : (params?.metrics ?? []).map((item) => ({ name: item.name ?? '', alias: item.alias ?? item.name ?? '' })).filter((item) => item.name);
        const bound = inputs.map((item) => {
          const inputMetric = layer.listMetrics().find((candidate) => candidate.name === item.name);
          const inputModel = inputMetric?.cube ?? inputMetric?.semanticModelIds?.[0];
          const inputMeasureName = (inputMetric?.typeParams?.measure as { name?: string } | undefined)?.name ?? item.name;
          const inputMeasure = inputModel ? measureByKey.get(`${inputModel}:${inputMeasureName}`) : undefined;
          const agg = inputMeasure?.agg?.toLowerCase();
          if (!inputMetric || !inputModel || !inputMeasure || !agg || !AGGREGATES.has(agg) || (inputMetric.metricType && inputMetric.metricType !== 'simple')) return undefined;
          const inputRelation = relationOfCube.get(inputModel);
          if (!inputRelation) return undefined;
          const inner = qualifyExpression(inputMeasure.expr ?? inputMeasure.name, inputRelation, cubeColumns(inputModel));
          return { alias: item.alias, sql: agg === 'count_distinct' ? `COUNT(DISTINCT ${inner})` : `${agg.toUpperCase()}(${inner})`, relation: inputRelation };
        });
        if (expression && bound.length && bound.every(Boolean) && new Set(bound.map((item) => item!.relation)).size === 1) {
          let expr = expression;
          for (const item of bound) expr = expr.replace(new RegExp(`\\b${item!.alias}\\b`, 'g'), `(${item!.sql})`);
          physical = { relation: bound[0]!.relation, expr, aggregate: 'derived' };
        }
      }
      const scopeNote = filters.length ? ` Only where ${filters.map((filter) => `${filter.column} ${filter.condition}`).join(' and ')}.` : '';
      const kindNote = !simple ? ` (${metric.metricType} metric: semantic engine only)` : '';
      source.metrics!.push({
        name: metric.name, ...(model ? { model } : {}), label: metric.label, description: `${metric.description ?? ''}${scopeNote}${kindNote}`.trim(),
        ...(aggregate ? { aggregation: aggregate } : {}), ...(metric.metricType ? { type: metric.metricType } : {}), expr: metric.sql, sourceId: metric.name,
        ...(metric.status ? { status: metric.status } : {}), ...(physical ? { physical } : {}),
      });
    }
    const metricNames = new Set(layer.listMetrics().map((metric) => metric.name));
    for (const measure of measures) {
      if (!measure.cube || metricNames.has(measure.name)) continue;
      const relation = relationOfCube.get(measure.cube);
      const aggregate = measure.agg?.toLowerCase();
      source.measures!.push({
        name: measure.name, model: measure.cube, label: measure.label, description: measure.description, ...(aggregate ? { aggregation: aggregate } : {}),
        ...(measure.expr ? { expr: measure.expr } : {}), sourceId: measure.name,
        ...(relation && aggregate && AGGREGATES.has(aggregate) ? { physical: { relation, expr: qualifyExpression(measure.expr ?? measure.name, relation, cubeColumns(measure.cube)), aggregate } } : {}),
      });
    }
    const timeNames = new Set<string>();
    for (const dimension of layer.listTimeDimensions(undefined, { includeVariants: true })) {
      if (!dimension.cube) continue;
      timeNames.add(`${dimension.cube}:${dimension.name}`);
      const relation = relationOfCube.get(dimension.cube);
      const column = isIdentifier(dimension.expr ?? dimension.sql) ? (dimension.expr ?? dimension.sql) : undefined;
      source.dimensions!.push({
        name: dimension.name, model: dimension.cube, label: dimension.label, description: dimension.description, dataType: 'timestamp', isTime: true,
        ...(dimension.granularities?.length ? { timeGrains: dimension.granularities } : {}), sourceId: `${dimension.cube}.${dimension.name}`,
        ...(reach.get(dimension.cube)?.length ? { reachableFrom: reach.get(dimension.cube) } : {}),
        ...(relation && column ? { physical: { relation, column } } : {}),
      });
    }
    for (const dimension of layer.listDimensions(undefined, { includeVariants: true })) {
      if (!dimension.cube || timeNames.has(`${dimension.cube}:${dimension.name}`)) continue;
      const relation = relationOfCube.get(dimension.cube);
      const column = isIdentifier(dimension.expr ?? dimension.sql) ? (dimension.expr ?? dimension.sql) : undefined;
      source.dimensions!.push({
        name: dimension.name, model: dimension.cube, label: dimension.label, description: dimension.description, dataType: dimension.type,
        ...(dimension.isTimeDimension ? { isTime: true } : {}), sourceId: `${dimension.cube}.${dimension.name}`,
        ...(reach.get(dimension.cube)?.length ? { reachableFrom: reach.get(dimension.cube) } : {}),
        ...(relation && column ? { physical: { relation, column } } : {}),
      });
    }
    for (const entity of layer.listEntities()) {
      if (!entity.cube) continue;
      const relation = relationOfCube.get(entity.cube);
      const column = isIdentifier(entity.expr ?? entity.name) ? (entity.expr ?? entity.name) : undefined;
      source.entities!.push({
        name: entity.name, model: entity.cube, type: entity.type, label: entity.label, description: entity.description, sourceId: `${entity.cube}.${entity.name}`,
        ...(reach.get(entity.cube)?.length ? { reachableFrom: reach.get(entity.cube) } : {}),
        ...(relation && column ? { physical: { relation, column } } : {}),
      });
    }
    for (const model of layer.listSemanticModels()) {
      source.models!.push({ name: model.name, label: model.label, description: model.description, ...(relationOfCube.get(model.name) ? { relation: relationOfCube.get(model.name) } : {}) });
    }
  }

  for (const block of Object.values(input.manifest?.blocks ?? {})) {
    const certified = (block.status ?? '').toLowerCase() === 'certified';
    if (!certified) continue;
    source.blocks!.push({
      name: block.name, ...(block.domain ? { domain: block.domain } : {}), ...(block.description ? { description: block.description } : {}), certified, status: block.status,
      contract: extractBlockContract({
        name: block.name, domain: block.domain, sql: block.sql, declaredOutputs: block.declaredOutputs, dimensions: block.dimensions, allowedFilters: block.allowedFilters,
        parameters: block.parameters?.map((parameter) => parameter.name), grain: block.grain, entities: block.entities, tableDependencies: block.tableDependencies, rawTableRefs: block.rawTableRefs,
      }),
      ...(block.examples?.length ? { examples: block.examples.map((example) => example.question) } : {}),
      ...(block.tags?.length ? { tags: block.tags } : {}), sql: block.sql,
    });
  }
  for (const term of Object.values(input.manifest?.terms ?? {})) {
    if ((term.status ?? '').toLowerCase() === 'deprecated') continue;
    const rules = [...((term as { businessRules?: string[] }).businessRules ?? []), ...((term as { caveats?: string[] }).caveats ?? [])];
    const description = [term.description, rules.length ? `Rules: ${rules.join(' ')}` : ''].filter(Boolean).join(' ');
    source.terms!.push({ name: term.name, ...(term.synonyms?.length ? { synonyms: term.synonyms } : {}), ...(description ? { description } : {}), ...(term.metricRefs?.length ? { metricRefs: term.metricRefs } : {}) });
  }
  return source;
}

export function buildProjectVocabulary(input: VocabularySourceInput): VocabularyIndex {
  return buildVocabularyIndex(buildVocabularySource(input));
}

export type { VocabularyEntry };
