import type { ConnectionMetadataScopeV1 } from '../../api/client';

export function formatMetadataScopeEditor(scopes: ConnectionMetadataScopeV1['scopes']): string {
  return scopes
    .map((scope) => `${scope.catalogOrDatabase}: ${scope.schemas.join(', ')}`)
    .join('\n');
}

export function parseMetadataScopeEditor(value: string): ConnectionMetadataScopeV1['scopes'] {
  const grouped = new Map<string, { catalogOrDatabase: string; schemas: Set<string> }>();
  for (const line of value.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const catalogOrDatabase = line.slice(0, separator).trim();
    const schemas = line.slice(separator + 1).split(',').map((schema) => schema.trim()).filter(Boolean);
    if (!catalogOrDatabase || schemas.length === 0) continue;
    const key = catalogOrDatabase.toLowerCase();
    const current = grouped.get(key) ?? { catalogOrDatabase, schemas: new Set<string>() };
    for (const schema of schemas) current.schemas.add(schema);
    grouped.set(key, current);
  }
  return Array.from(grouped.values()).map((scope) => ({
    catalogOrDatabase: scope.catalogOrDatabase,
    schemas: Array.from(scope.schemas),
  }));
}
