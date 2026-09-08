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
const AGGREGATE_CALL = /^(sum|count|avg|min|max|median)\s*\(([\s\S]+)\)$/i;
const NESTED_AGGREGATE = /\b(sum|count|avg|min|max|median)\s*\(/i;

/**
 * A native DQL metric or dimension declares its own relation and expression
 * (`table`, `sql`, `type`) and carries no dbt cube or measure. Read the
 * aggregate out of the expression when the author wrote one ("SUM(points)"),
 * and take the declared type when they wrote the bare column ("points"). An
 * expression that mixes aggregates (a ratio of sums) is left to the semantic
 * engine: wrapping it in another aggregate would change its meaning.
 */
const SAFE_FORMULA = /^[\sA-Za-z0-9_."'(),+\-*\/]+$/;
/**
 * A native metric written as a formula of aggregates over its own columns.
 * Accepted when every function is an aggregate or NULLIF/COALESCE, the
 * arithmetic is + - * / and parentheses, and at least one aggregate is
 * present; anything else (a subquery, a window, a CASE the formula regex
 * cannot vouch for) stays with the semantic engine.
 */
export function nativeFormulaBinding(sql: string | undefined): string | undefined {
  const text = (sql ?? '').trim();
  if (!text || !SAFE_FORMULA.test(text) || !NESTED_AGGREGATE.test(text)) return undefined;
  if (/\b(select|from|where|over|partition|join|union|case|when|with|limit|order)\b/i.test(text)) return undefined;
  const functions = [...text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((match) => match[1]!.toLowerCase());
  if (!functions.every((name) => AGGREGATES.has(name) || name === 'nullif' || name === 'coalesce' || name === 'cast')) return undefined;
  // A single bare aggregate call is the simple path's job, not a formula.
  if (nativeAggregateBinding(text, undefined)) return undefined;
  return text;
}

export function nativeAggregateBinding(sql: string | undefined, declaredType: string | undefined): { expr: string; aggregate: string } | undefined {
  const text = (sql ?? '').trim();
  if (!text) return undefined;
  const call = AGGREGATE_CALL.exec(text);
  if (call) {
    // The outer parentheses must close the call, not two calls side by side.
    let depth = 0;
    for (let at = 0; at < call[2]!.length; at += 1) {
      const char = call[2]![at];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      if (depth < 0) return undefined;
    }
    if (depth !== 0) return undefined;
    let aggregate = call[1]!.toLowerCase();
    let inner = call[2]!.trim();
    if (aggregate === 'count' && /^distinct\s+/i.test(inner)) { aggregate = 'count_distinct'; inner = inner.replace(/^distinct\s+/i, ''); }
    if (NESTED_AGGREGATE.test(inner)) return undefined;
    return AGGREGATES.has(aggregate) && inner ? { expr: inner, aggregate } : undefined;
  }
  if (NESTED_AGGREGATE.test(text)) return undefined;
  const aggregate = (declaredType ?? '').toLowerCase();
  return AGGREGATES.has(aggregate) ? { expr: text, aggregate } : undefined;
}

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
  // dbt column descriptions: the fallback definition for a semantic dimension that declares none.
  const columnDescriptions = new Map<string, string>();
  const relationSeen = new Set<string>();

  // A relation may be described more than once: by a partial dbt manifest
  // (a few documented columns, no types) and by the warehouse itself (every
  // column, typed). The first description is not the last word: later ones
  // ADD the columns and types the earlier lacked, so a column the manifest
  // never mentioned is still a column, and a typed literal compiles by type.
  const addRelation = (relation: { schema?: string; name: string; description?: string; columns: Array<{ name: string; dataType?: string; description?: string }> }) => {
    const key = relation.schema ? `${relation.schema}.${relation.name}` : relation.name;
    if (relationSeen.has(key)) {
      const existing = source.relations!.find((item) => (item.schema ? `${item.schema}.${item.name}` : item.name) === key);
      const names = relationColumns.get(key) ?? new Set<string>();
      for (const column of relation.columns) {
        const known = existing?.columns.find((item) => item.name.toLowerCase() === column.name.toLowerCase());
        if (!known) { existing?.columns.push(column); names.add(column.name); }
        else if (!known.dataType && column.dataType) known.dataType = column.dataType;
        if (column.description && !columnDescriptions.has(`${key}.${column.name}`)) columnDescriptions.set(`${key}.${column.name}`, column.description);
      }
      relationColumns.set(key, names);
      if (existing && !existing.description && relation.description) existing.description = relation.description;
      return;
    }
    relationSeen.add(key);
    relationColumns.set(key, new Set(relation.columns.map((column) => column.name)));
    for (const column of relation.columns) if (column.description) columnDescriptions.set(`${key}.${column.name}`, column.description);
    source.relations!.push({ ...relation, columns: relation.columns.map((column) => ({ ...column })) });
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
        addRelation({ ...(relation.includes('.') ? { schema: relation.split('.')[0] } : {}), name: relation.split('.').pop()!, ...(cube.description ? { description: cube.description } : {}), columns: [...cube.dimensions.map((d) => ({ name: leafName(cube.name, d.name), dataType: d.type })), ...cube.measures.map((m) => ({ name: leafName(cube.name, m.name) }))] });
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
    // A model's default time role, for measures that do not name their own.
    const modelTime = new Map<string, string>();
    for (const model of layer.listSemanticModels()) {
      const declared = (model.defaults as { agg_time_dimension?: unknown } | undefined)?.agg_time_dimension;
      if (typeof declared === 'string' && declared) modelTime.set(model.name, declared);
    }
    const timeRoleOf = (model: string | undefined, measure: { aggTimeDimension?: string } | undefined, metric?: { aggTimeDimension?: string }): string | undefined =>
      metric?.aggTimeDimension ?? measure?.aggTimeDimension ?? (model ? modelTime.get(model) : undefined);
    const displayFormatOf = (name: string): { kind: 'currency' | 'percent' | 'number' | 'count' | 'duration'; currency?: string; decimals?: number } | undefined => {
      const format = layer.displayFormatFor(name);
      return format ? { kind: format.kind, ...(format.currency ? { currency: format.currency } : {}), ...(format.decimals !== undefined ? { decimals: format.decimals } : {}) } : undefined;
    };
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
      // A derived or ratio metric binds physically ONLY when plain SQL can
      // express it: every input a simple metric with no offset, window,
      // cumulative grain or input filter, and no two inputs the same metric
      // under different aliases (the prior-period trick). Anything with a
      // time feature is the semantic engine's alone; the relational tier
      // must refuse it rather than approximate it.
      let derived: { expr: string; inputs: Array<{ alias: string; ref: string }> } | undefined = undefined;
      let engineOnly: string | undefined;
      if (!physical && (metric.metricType === 'derived' || metric.metricType === 'ratio')) {
        type InputSpec = { name?: string; alias?: string; offset_window?: unknown; offset_to_grain?: unknown; filter?: unknown };
        const params = metric.typeParams as { expr?: string; metrics?: InputSpec[]; numerator?: InputSpec | string; denominator?: InputSpec | string; window?: unknown; grain_to_date?: unknown; cumulative_type_params?: unknown } | undefined;
        const spec = (value: InputSpec | string | undefined): InputSpec | undefined => typeof value === 'string' ? { name: value } : value;
        const numerator = spec(params?.numerator);
        const denominator = spec(params?.denominator);
        const expression = metric.metricType === 'ratio' && numerator?.name && denominator?.name ? `${numerator.name} / ${denominator.name}` : params?.expr;
        const inputs: InputSpec[] = metric.metricType === 'ratio' ? [numerator, denominator].filter((item): item is InputSpec => Boolean(item?.name)) : (params?.metrics ?? []).filter((item) => item.name);
        const timeFeature = inputs.find((item) => item.offset_window || item.offset_to_grain);
        const filtered = inputs.find((item) => item.filter);
        const names = inputs.map((item) => item.name);
        if (timeFeature) engineOnly = `a prior-period offset on ${timeFeature.name}`;
        else if (params?.window || params?.grain_to_date || params?.cumulative_type_params) engineOnly = 'a cumulative window';
        else if (filtered) engineOnly = `an input-level filter on ${filtered.name}`;
        else if (new Set(names).size !== names.length) engineOnly = 'the same input metric under several aliases';
        if (!engineOnly) {
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
            return { alias: item.alias ?? item.name!, ref: `metric:${inputModel}.${inputMetric.name}`, sql: agg === 'count_distinct' ? `COUNT(DISTINCT ${inner})` : `${agg.toUpperCase()}(${inner})`, relation: inputRelation };
          });
          if (expression && bound.length && bound.every(Boolean)) {
            const relations = new Set(bound.map((item) => item!.relation));
            if (relations.size === 1) {
              // One relation: the formula over the aggregates is one SELECT.
              let expr = metric.metricType === 'ratio' ? `${numerator!.name} / NULLIF(${denominator!.name}, 0)` : expression;
              for (const item of bound) expr = expr.replace(new RegExp(`\\b${item!.alias}\\b`, 'g'), `(${item!.sql})`);
              physical = { relation: bound[0]!.relation, expr, aggregate: 'derived' };
            } else {
              // Several relations: each input is aggregated on its own
              // relation and the formula is evaluated afterwards.
              derived = { expr: expression, inputs: bound.map((item) => ({ alias: item!.alias, ref: item!.ref })) };
            }
          }
        }
      }
      // A native DQL metric has no cube and no measure, only its own table,
      // expression and type. Without this binding the interpreter can name a
      // metric that discovery admitted and no governed tier can execute.
      if (!physical && !derived && !engineOnly && simple && filters.length === 0) {
        const nativeRelation = normalizeRelationName(metric.table);
        const native = nativeRelation && relationColumns.has(nativeRelation) ? nativeAggregateBinding(metric.sql, metric.type ?? metric.aggregation) : undefined;
        if (nativeRelation && native) {
          physical = { relation: nativeRelation, expr: qualifyExpression(native.expr, nativeRelation, relationColumns.get(nativeRelation) ?? []), aggregate: native.aggregate };
        }
      }
      // A native metric whose expression is a formula OF aggregates over its
      // own table (points per game = SUM(points) / NULLIF(SUM(games), 0))
      // binds as a derived aggregate: the formula is emitted as written inside
      // the grouped query, never wrapped in another SUM or AVG.
      if (!physical && !derived && !engineOnly && filters.length === 0) {
        const nativeRelation = normalizeRelationName(metric.table);
        const formula = nativeRelation && relationColumns.has(nativeRelation) ? nativeFormulaBinding(metric.sql) : undefined;
        if (nativeRelation && formula) physical = { relation: nativeRelation, expr: qualifyExpression(formula, nativeRelation, relationColumns.get(nativeRelation) ?? []), aggregate: 'derived' };
      }
      if (!physical && !derived && !engineOnly && metric.metricType && metric.metricType !== 'simple') engineOnly = `a ${metric.metricType} metric the relational tier cannot compose`;
      const scopeNote = filters.length ? ` Only where ${filters.map((filter) => `${filter.column} ${filter.condition}`).join(' and ')}.` : '';
      const kindNote = engineOnly ? ` (${metric.metricType} metric: semantic engine only, ${engineOnly})` : !simple && !physical && !derived ? ` (${metric.metricType} metric: semantic engine only)` : '';
      const timeRole = timeRoleOf(model, measure, metric);
      const displayFormat = displayFormatOf(metric.name);
      source.metrics!.push({
        name: metric.name, ...(model ? { model } : {}), label: metric.label, description: `${metric.description ?? ''}${scopeNote}${kindNote}`.trim(),
        ...(aggregate ? { aggregation: aggregate } : {}), ...(metric.metricType ? { type: metric.metricType } : {}), expr: metric.sql, sourceId: metric.name,
        ...(metric.status ? { status: metric.status } : {}), ...(physical ? { physical } : {}),
        ...(timeRole ? { aggTimeDimension: timeRole } : {}), ...(displayFormat ? { displayFormat } : {}),
        ...(derived ? { derived } : {}), ...(engineOnly ? { engineOnly } : {}),
      });
    }
    const metricNames = new Set(layer.listMetrics().map((metric) => metric.name));
    for (const measure of measures) {
      if (!measure.cube || metricNames.has(measure.name)) continue;
      const relation = relationOfCube.get(measure.cube);
      const aggregate = measure.agg?.toLowerCase();
      const timeRole = timeRoleOf(measure.cube, measure);
      const displayFormat = displayFormatOf(measure.name);
      source.measures!.push({
        name: measure.name, model: measure.cube, label: measure.label, description: measure.description, ...(aggregate ? { aggregation: aggregate } : {}),
        ...(measure.expr ? { expr: measure.expr } : {}), sourceId: measure.name,
        ...(relation && aggregate && AGGREGATES.has(aggregate) ? { physical: { relation, expr: qualifyExpression(measure.expr ?? measure.name, relation, cubeColumns(measure.cube)), aggregate } } : {}),
        ...(timeRole ? { aggTimeDimension: timeRole } : {}), ...(displayFormat ? { displayFormat } : {}),
      });
    }
    // A native DQL dimension names its own table instead of a cube. Its home
    // is that relation, and its model name is the relation's own leaf so the
    // ref stays stable (dimension:<table>.<name>).
    const dimensionHome = (dimension: { cube?: string; table?: string }): { model: string; relation?: string } | undefined => {
      if (dimension.cube) return { model: dimension.cube, ...(relationOfCube.get(dimension.cube) ? { relation: relationOfCube.get(dimension.cube) } : {}) };
      const relation = normalizeRelationName(dimension.table);
      if (!relation || !relationColumns.has(relation)) return undefined;
      return { model: relation.split('.').pop()!, relation };
    };
    const timeNames = new Set<string>();
    for (const dimension of layer.listTimeDimensions(undefined, { includeVariants: true })) {
      const home = dimensionHome(dimension);
      if (!home) continue;
      const name = leafName(home.model, dimension.name);
      timeNames.add(`${home.model}:${name}`);
      const relation = home.relation;
      const timeExpression = dimension.expr ?? dimension.sql;
      const column = timeExpression === undefined || timeExpression === '' ? name : isIdentifier(timeExpression) ? timeExpression : undefined;
      source.dimensions!.push({
        name, model: home.model, label: dimension.label, description: dimension.description || (relation && column ? columnDescriptions.get(`${relation}.${column}`) : undefined), dataType: 'timestamp', isTime: true,
        ...(dimension.granularities?.length ? { timeGrains: dimension.granularities } : {}), sourceId: `${home.model}.${dimension.name}`,
        ...(reach.get(home.model)?.length ? { reachableFrom: reach.get(home.model) } : {}),
        ...(relation && column ? { physical: { relation, column } } : {}),
      });
    }
    for (const dimension of layer.listDimensions(undefined, { includeVariants: true })) {
      const home = dimensionHome(dimension);
      if (!home) continue;
      const name = leafName(home.model, dimension.name);
      if (timeNames.has(`${home.model}:${name}`)) continue;
      const relation = home.relation;
      // A dimension with no expression IS its column; dbt names it once.
      const expression = dimension.expr ?? dimension.sql;
      const column = expression === undefined || expression === '' ? name : isIdentifier(expression) ? expression : undefined;
      source.dimensions!.push({
        name, model: home.model, label: dimension.label, description: dimension.description || (relation && column ? columnDescriptions.get(`${relation}.${column}`) : undefined), dataType: dimension.type,
        ...(dimension.isTimeDimension ? { isTime: true } : {}), sourceId: `${home.model}.${dimension.name}`,
        ...(reach.get(home.model)?.length ? { reachableFrom: reach.get(home.model) } : {}),
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
    // Certification is one state. A block whose status says certified while
    // its own description or tags say it still needs review is contradictory
    // metadata, and a contradiction is never served as certified evidence.
    const reviewRequired = /review[\s-]*required/i.test(block.description ?? '') || (block.tags ?? []).some((tag) => /review[\s-]*required/i.test(tag));
    if (reviewRequired) continue;
    source.blocks!.push({
      name: block.name, ...(block.domain ? { domain: block.domain } : {}), ...(block.description ? { description: block.description } : {}), certified, status: block.status,
      ...(block.filePath ? { sourcePath: block.filePath } : {}),
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

/**
 * The dbt model inventory names a column dimension `<model>.<column>`; the
 * vocabulary names the column once (`dimension:<model>.<column>`, physical
 * column `<column>`), never `<model>.<model>.<column>`.
 */
export function leafName(cube: string, name: string): string {
  return name.startsWith(`${cube}.`) ? name.slice(cube.length + 1) : name;
}

export function buildProjectVocabulary(input: VocabularySourceInput): VocabularyIndex {
  return buildVocabularyIndex(buildVocabularySource(input));
}

export type { VocabularyEntry };
