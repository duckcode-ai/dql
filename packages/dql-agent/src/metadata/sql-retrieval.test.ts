import { describe, expect, it } from 'vitest';
import { selectRelevantModels } from './sql-retrieval.js';
import type { DbtArtifacts, DbtModelNode } from '../propose/dbt-artifacts.js';

function model(name: string): DbtModelNode {
  return {
    uniqueId: `model.jaffle.${name}`,
    name,
    resourceType: 'model',
    qualifiedRelation: `analytics.${name}`,
    refForm: `{{ ref('${name}') }}`,
    tags: [],
    dependsOn: [],
    columns: [],
    meta: {},
    config: {},
  };
}

function artifacts(models: DbtModelNode[], runCounts: Record<string, number>): DbtArtifacts {
  return {
    models,
    sources: [],
    exposures: [],
    catalogColumns: new Map(),
    runCounts: new Map(Object.entries(runCounts).map(([name, count]) => [`model.jaffle.${name}`, count])),
    hasSemantic: false,
    semanticMetrics: [],
    semanticModels: new Map(),
  };
}

describe('selectRelevantModels no-signal fallback (W3.5)', () => {
  it('orders by dbt run frequency when the question shares no tokens with any model', async () => {
    const models = [model('alpha_widget'), model('beta_gadget'), model('gamma_sprocket')];
    // beta is run most often, gamma next, alpha least.
    const result = await selectRelevantModels(
      artifacts(models, { alpha_widget: 1, beta_gadget: 9, gamma_sprocket: 4 }),
      'zzz nonexistent qqq', // no lexical overlap with any model name/text
      { topK: 3 },
    );
    expect(result).toEqual(['beta_gadget', 'gamma_sprocket', 'alpha_widget']);
  });

  it('breaks run-count ties alphabetically for stable ordering', async () => {
    const models = [model('zebra'), model('apple'), model('mango')];
    const result = await selectRelevantModels(
      artifacts(models, {}), // no run data at all → all zero → alphabetical
      'zzz nonexistent qqq',
      { topK: 3 },
    );
    expect(result).toEqual(['apple', 'mango', 'zebra']);
  });
});
