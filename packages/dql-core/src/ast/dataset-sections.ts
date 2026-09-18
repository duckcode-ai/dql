import type { BlockDeclNode } from './nodes.js';

/**
 * The `grain`, `fields { }`, and `measures { }` sections of a dataset block,
 * one line per entry, in the grammar the parser reads. Shared by the
 * formatter and the AST printer so neither can drift into DQL that does not
 * parse. `pad(depth)` returns the indentation for a nesting depth relative to
 * the block body.
 */
export function datasetBlockSectionLines(
  node: Pick<BlockDeclNode, 'datasetGrain' | 'datasetFields' | 'datasetMeasures'>,
  pad: (depth: 1 | 2) => string,
  quote: (value: string) => string,
): string[] {
  const lines: string[] = [];
  const grain = node.datasetGrain;
  if (grain) {
    lines.push(`${pad(1)}grain = {`);
    lines.push(`${pad(2)}entities = [${grain.entities.map(quote).join(', ')}]`);
    lines.push(`${pad(2)}keys = [${grain.keys.map(quote).join(', ')}]`);
    if (grain.keyEvidence) lines.push(`${pad(2)}keyEvidence = ${quote(grain.keyEvidence)}`);
    if (grain.description) lines.push(`${pad(2)}description = ${quote(grain.description)}`);
    if (grain.timeGrain) lines.push(`${pad(2)}timeGrain = ${quote(grain.timeGrain)}`);
    if (grain.timeBucketBy) lines.push(`${pad(2)}timeBucketBy = ${quote(grain.timeBucketBy)}`);
    if (grain.aggregate !== undefined) lines.push(`${pad(2)}aggregate = ${grain.aggregate ? 'true' : 'false'}`);
    lines.push(`${pad(1)}}`);
  }
  if (node.datasetFields && node.datasetFields.length > 0) {
    lines.push(`${pad(1)}fields {`);
    for (const field of [...node.datasetFields].sort((left, right) => left.name.localeCompare(right.name))) {
      const properties = [`role = ${quote(field.role)}`];
      if (field.type) properties.push(`type = ${quote(field.type)}`);
      if (field.grains?.length) properties.push(`grains = [${field.grains.map(quote).join(', ')}]`);
      if (field.primary !== undefined) properties.push(`primary = ${field.primary ? 'true' : 'false'}`);
      if (field.hierarchy) properties.push(`hierarchy = ${quote(field.hierarchy)}`);
      if (field.level !== undefined) properties.push(`level = ${field.level}`);
      if (field.status) properties.push(`status = ${quote(field.status)}`);
      lines.push(`${pad(2)}${field.name} { ${properties.join(', ')} }`);
    }
    lines.push(`${pad(1)}}`);
  }
  if (node.datasetMeasures && node.datasetMeasures.length > 0) {
    lines.push(`${pad(1)}measures {`);
    for (const measure of [...node.datasetMeasures].sort((left, right) => left.name.localeCompare(right.name))) {
      const properties = [`agg = ${quote(measure.aggregation)}`];
      if (measure.from) properties.push(`from = ${quote(measure.from)}`);
      if (measure.numerator) properties.push(`numerator = ${quote(measure.numerator)}`);
      if (measure.denominator) properties.push(`denominator = ${quote(measure.denominator)}`);
      if (measure.expression) properties.push(`expression = ${quote(measure.expression)}`);
      if (measure.timeBucketBy) properties.push(`timeBucketBy = ${quote(measure.timeBucketBy)}`);
      properties.push(`additive = ${quote(measure.additive)}`);
      if (measure.entityAdditive) properties.push(`entityAdditive = ${quote(measure.entityAdditive)}`);
      if (measure.allowedAggs?.length) properties.push(`allowedAggs = [${measure.allowedAggs.map(quote).join(', ')}]`);
      if (measure.format) properties.push(`format = ${quote(measure.format)}`);
      if (measure.currency) properties.push(`currency = ${quote(measure.currency)}`);
      if (measure.status) properties.push(`status = ${quote(measure.status)}`);
      lines.push(`${pad(2)}${measure.name} { ${properties.join(', ')} }`);
    }
    lines.push(`${pad(1)}}`);
  }
  return lines;
}
