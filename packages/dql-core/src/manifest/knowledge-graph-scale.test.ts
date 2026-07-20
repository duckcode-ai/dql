import { describe, expect, it } from 'vitest';
import { compactManifestKnowledgeGraph } from './knowledge-graph.js';
import type {
  ManifestKnowledgeEdge,
  ManifestKnowledgeGraph,
  ManifestKnowledgeObject,
} from './types.js';

function object(index: number, kind: 'dbt_model' | 'metric'): ManifestKnowledgeObject {
  const domainId = `domain_${index % 20}`;
  const localId = `${kind}_${index}`;
  return {
    id: `${domainId}::${kind}::${localId}`,
    kind,
    localId,
    domainId,
    aliases: [localId, `Friendly enterprise ${kind} ${index}`],
    owner: `${domainId}@example.test`,
    source: {
      system: kind === 'dbt_model' ? 'dbt' : 'semantic',
      path: `domains/${domainId}/${kind}/${localId}.yml`,
      nativeId: `${kind}.enterprise.${localId}`,
      fingerprint: `${index}`.padStart(64, '0'),
    },
    payload: {
      description: `Verbose governed description for ${localId} that belongs in the indexed snapshot, not the control-plane manifest.`,
      columns: Array.from({ length: 12 }, (_, column) => `column_${column}`),
    },
  };
}

describe('compact enterprise knowledge graph', () => {
  it('keeps 4,000 dbt models and 7,000 semantic metrics bounded and payload-free', () => {
    const objects = [
      ...Array.from({ length: 4_000 }, (_, index) => object(index, 'dbt_model')),
      ...Array.from({ length: 7_000 }, (_, index) => object(index + 4_000, 'metric')),
    ];
    const edges: ManifestKnowledgeEdge[] = objects.slice(1).map((item, index) => ({
      id: `edge::${index}`,
      kind: 'transforms',
      from: objects[index]!.id,
      to: item.id,
      fingerprint: `${index}`.padStart(64, 'e'),
    }));
    const graph: ManifestKnowledgeGraph = {
      schemaVersion: 1,
      storageMode: 'inline',
      sourceFingerprint: 'f'.repeat(64),
      objects: Object.fromEntries(objects.map((item) => [item.id, item])),
      edges,
      domainCapsules: {},
      crossDomainRoutes: [],
      diagnostics: [],
    };

    const compact = compactManifestKnowledgeGraph(graph);
    const serialized = JSON.stringify(compact);

    expect(compact).toMatchObject({
      schemaVersion: 2,
      storageMode: 'indexed',
      counts: { objects: 11_000, edges: 10_999 },
    });
    expect(compact.shards).toHaveLength(21);
    expect(compact.objects).toBeUndefined();
    expect(compact.edges).toBeUndefined();
    expect(serialized).not.toContain('Verbose governed description');
    expect(Buffer.byteLength(serialized)).toBeLessThan(5 * 1024 * 1024);
  });
});
