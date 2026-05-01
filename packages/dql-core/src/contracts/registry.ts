/**
 * DataLex contract registry — the consumer side of the manifest-spec
 * `datalex_contract` interop pattern.
 *
 * Reads a DataLex manifest (JSON file) and indexes its contracts by id so
 * the DQL compiler can resolve `datalex_contract = "domain.Entity.name@1"`
 * references at compile time. Resolution failures are returned as
 * structured `ContractResolution` values; they become DQL compiler
 * diagnostics in the analyzer wiring (Phase 2.1 follow-up).
 *
 * See:
 *   - manifest-spec/docs/interop.md (resolution rules)
 *   - manifest-spec/schemas/v1/datalex-manifest.schema.json (source of truth)
 */

import { existsSync, readFileSync } from 'node:fs';

import {
  type ContractId,
  type ContractRef,
  type ContractResolution,
  type DataLexContract,
  type DataLexManifest,
  parseContractRef,
} from './types.js';

interface IndexedContract {
  contract: DataLexContract;
  domain: string;
  entity: string;
}

/**
 * Loads a DataLex manifest into an indexed contract lookup. One registry
 * instance per DQL project. Re-create or call `reload()` between
 * compilation runs if the manifest changes on disk.
 */
export class DataLexContractRegistry {
  private readonly byId = new Map<ContractId, IndexedContract[]>();
  private readonly diagnostics: string[] = [];

  constructor(private readonly source: { manifestPath?: string; manifest?: DataLexManifest } = {}) {
    this.reload();
  }

  /** Reload from the configured source. Useful when the manifest is regenerated mid-session. */
  reload(): void {
    this.byId.clear();
    this.diagnostics.length = 0;

    let manifest: DataLexManifest | null = null;
    if (this.source.manifest) {
      manifest = this.source.manifest;
    } else if (this.source.manifestPath) {
      manifest = this.loadFromDisk(this.source.manifestPath);
    }
    if (!manifest) return;
    this.indexManifest(manifest);
  }

  /**
   * Resolve a `datalex_contract` reference from a DQL block.
   *
   * The resolution rules match `manifest-spec/docs/interop.md`:
   *   - The ref MUST parse as `<domain>.<Entity>.<contract_name>` with an
   *     optional `@<version>` suffix. Otherwise: `malformed_ref`.
   *   - The id MUST exist in the registry. Otherwise: `not_found`.
   *   - If a version is pinned, a contract with that version MUST exist
   *     under the id. Otherwise: `version_mismatch`.
   *   - If no version is pinned, the highest version wins; the caller may
   *     emit a "version-pinning recommended" warning separately.
   */
  resolve(ref: ContractRef): ContractResolution {
    const parsed = parseContractRef(ref);
    if (!parsed.ok || !parsed.id) {
      return {
        ok: false,
        reason: 'malformed_ref',
        message: parsed.reason ?? 'invalid contract reference',
        requestedRef: ref,
      };
    }
    const indexed = this.byId.get(parsed.id);
    if (!indexed || indexed.length === 0) {
      return {
        ok: false,
        reason: 'not_found',
        message: `No DataLex contract with id "${parsed.id}" found in the loaded manifest.`,
        requestedRef: ref,
        requestedVersion: parsed.version,
      };
    }
    if (parsed.version === undefined) {
      const winner = indexed.reduce((best, candidate) =>
        candidate.contract.version > best.contract.version ? candidate : best,
      );
      return {
        ok: true,
        contract: winner.contract,
        domain: winner.domain,
        entity: winner.entity,
      };
    }
    const match = indexed.find((c) => c.contract.version === parsed.version);
    if (!match) {
      return {
        ok: false,
        reason: 'version_mismatch',
        message: `DataLex contract "${parsed.id}" has no version ${parsed.version} in the loaded manifest.`,
        requestedRef: ref,
        requestedVersion: parsed.version,
        availableVersions: indexed.map((c) => c.contract.version).sort((a, b) => a - b),
      };
    }
    return { ok: true, contract: match.contract, domain: match.domain, entity: match.entity };
  }

  /** All contracts known to this registry, in stable id-then-version order. */
  list(): IndexedContract[] {
    const out: IndexedContract[] = [];
    for (const id of Array.from(this.byId.keys()).sort()) {
      const versions = this.byId.get(id) ?? [];
      out.push(
        ...[...versions].sort((a, b) => a.contract.version - b.contract.version),
      );
    }
    return out;
  }

  /** True when the registry was constructed from a real source. */
  isLoaded(): boolean {
    return this.byId.size > 0;
  }

  /** Diagnostics emitted while loading the manifest (parse errors, schema drift, etc.). */
  loadDiagnostics(): string[] {
    return [...this.diagnostics];
  }

  private loadFromDisk(path: string): DataLexManifest | null {
    if (!existsSync(path)) {
      this.diagnostics.push(`DataLex manifest not found at ${path}.`);
      return null;
    }
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch (err) {
      this.diagnostics.push(
        `Failed to read DataLex manifest at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        this.diagnostics.push(`DataLex manifest at ${path} is not a JSON object.`);
        return null;
      }
      return parsed as DataLexManifest;
    } catch (err) {
      this.diagnostics.push(
        `Failed to parse DataLex manifest at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private indexManifest(manifest: DataLexManifest): void {
    if (!Array.isArray(manifest.domains)) return;
    for (const domain of manifest.domains) {
      if (!domain || !Array.isArray(domain.entities)) continue;
      for (const entity of domain.entities) {
        if (!entity || !Array.isArray(entity.contracts)) continue;
        for (const contract of entity.contracts) {
          if (!contract || typeof contract.id !== 'string') continue;
          const list = this.byId.get(contract.id) ?? [];
          list.push({ contract, domain: domain.name, entity: entity.name });
          this.byId.set(contract.id, list);
        }
      }
    }
  }
}
