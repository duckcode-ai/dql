export function buildNotebookSemanticBlock(metrics: string[], dimensions: string[]): string {
  const uniqueMetrics = Array.from(new Set(metrics.filter(Boolean)));
  const uniqueDimensions = Array.from(new Set(dimensions.filter(Boolean)));
  const stem = [...uniqueMetrics.slice(0, 2), ...uniqueDimensions.slice(0, 1)].join('_by_') || 'semantic_query';
  const name = stem.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'semantic_query';
  const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
  return [
    `block "${name}" {`,
    '  type = "semantic"',
    `  metrics = [${uniqueMetrics.map(quote).join(', ')}]`,
    `  dimensions = [${uniqueDimensions.map(quote).join(', ')}]`,
    '}',
  ].join('\n');
}
