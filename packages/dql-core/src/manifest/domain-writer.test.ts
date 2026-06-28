import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from './builder.js';
import {
  writeDomainDeclaration,
  deleteDomainDeclaration,
  renderDomainDeclaration,
  resolveDomainDeclPath,
  domainFolderSlug,
} from './domain-writer.js';

describe('domain declaration writer (spec 17, part B)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-domain-writer-'));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'p' }), 'utf-8');
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** A block that references a domain but has no first-class domain declaration. */
  function writeBlockInDomain(domain: string): void {
    mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'blocks', 'orders.dql'),
      `block "orders" {
  type = "custom"
  domain = "${domain}"
  status = "draft"
  query = """
    SELECT 1 AS x
  """
}
`,
      'utf-8',
    );
  }

  function domainWarnings(root: string): string[] {
    return buildManifest({ projectRoot: root, dqlVersion: 'test' })
      .diagnostics.filter((d) => d.message.includes('first-class domain declaration'))
      .map((d) => d.message);
  }

  it('renders a parseable declaration that scanDomains reads back', () => {
    const written = writeDomainDeclaration(projectRoot, {
      name: 'Sales',
      owner: 'sales-analytics',
      boundedContext: 'Order lifecycle',
      sourceSystems: ['orders', 'crm'],
      description: 'Everything order + revenue.',
    });
    expect(written.path).toBe('domains/sales/domain.dql');

    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(manifest.domains?.Sales).toMatchObject({
      name: 'Sales',
      owner: 'sales-analytics',
      boundedContext: 'Order lifecycle',
      sourceSystems: ['orders', 'crm'],
      description: 'Everything order + revenue.',
    });
    // No parse diagnostics from the authored file.
    expect(manifest.diagnostics.filter((d) => d.kind === 'parse')).toEqual([]);
  });

  it("satisfies doctor's missing-domain-declaration warning after authoring", () => {
    writeBlockInDomain('Sales');
    // Before: the used domain has no declaration → warned.
    expect(domainWarnings(projectRoot).some((m) => m.includes('Sales'))).toBe(true);

    writeDomainDeclaration(projectRoot, { name: 'Sales', owner: 'sales-analytics' });

    // After: the warning is gone.
    expect(domainWarnings(projectRoot).some((m) => m.includes('Sales'))).toBe(false);
  });

  it('PUT-style overwrite updates the same file (no orphan)', () => {
    writeDomainDeclaration(projectRoot, { name: 'Sales', owner: 'a@x.com' });
    writeDomainDeclaration(projectRoot, { name: 'Sales', owner: 'b@x.com', description: 'Updated.' });
    const manifest = buildManifest({ projectRoot, dqlVersion: 'test' });
    expect(Object.keys(manifest.domains ?? {})).toEqual(['Sales']);
    expect(manifest.domains?.Sales.owner).toBe('b@x.com');
    expect(manifest.domains?.Sales.description).toBe('Updated.');
  });

  it('deletes a declaration and the domain disappears from the manifest', () => {
    writeDomainDeclaration(projectRoot, { name: 'Sales', owner: 'a@x.com' });
    expect(buildManifest({ projectRoot, dqlVersion: 'test' }).domains?.Sales).toBeDefined();

    expect(deleteDomainDeclaration(projectRoot, 'Sales')).toBe(true);
    expect(buildManifest({ projectRoot, dqlVersion: 'test' }).domains?.Sales).toBeUndefined();
    // Deleting a missing domain is a no-op.
    expect(deleteDomainDeclaration(projectRoot, 'Sales')).toBe(false);
  });

  it('resolves an existing differently-named declaration file (domain.dql vs other)', () => {
    mkdirSync(join(projectRoot, 'domains', 'sales'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'domains', 'sales', 'sales.dql'),
      'domain "Sales" {\n  owner = "old"\n}\n',
      'utf-8',
    );
    const resolved = resolveDomainDeclPath(projectRoot, 'Sales');
    expect(resolved.relativePath).toBe('domains/sales/sales.dql');
    // Overwrite hits the SAME file, not a new domain.dql.
    writeDomainDeclaration(projectRoot, { name: 'Sales', owner: 'new' });
    expect(readFileSync(join(projectRoot, 'domains', 'sales', 'sales.dql'), 'utf-8')).toContain('"new"');
  });

  it('renders deterministic DQL and a stable folder slug', () => {
    const dql = renderDomainDeclaration({ name: 'Customer Success', owner: 'cs' });
    expect(dql).toContain('domain "Customer Success" {');
    expect(dql).toContain('reviewCadence');
    expect(domainFolderSlug('Customer Success')).toBe('customer-success');
  });
});
