/**
 * Output-contract drift detection.
 *
 * DQL composition is intentionally unbounded freeform `ref()` between blocks.
 * The cost of that freedom: when a child block changes its output columns, a
 * parent that `ref()`s it can break *silently*. We do not restrict composition
 * — instead we make drift *visible*.
 *
 * This pass compares the columns a parent block references on a `ref()`'d child
 * (extracted from the parent's SQL) against the child's current `outputContract`
 * (its actual output schema). A referenced column that is missing/renamed
 * produces a `kind: 'drift'`, `severity: 'warning'` diagnostic naming the
 * parent, the child, and the drifted column. It never fails the build, and
 * additive changes (the child gaining new columns) produce no warning.
 *
 * Non-goals (explicitly rejected — see the feature spec):
 *   - Hard compile-time parent→child binding / failing the build.
 *   - Runtime enforcement.
 */

import { extractRefColumnUsage } from '../lineage/column-lineage.js';
import type { ManifestBlock, ManifestDiagnostic } from './types.js';

/** Case-insensitive column-name key for comparing referenced vs. declared columns. */
function columnKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The set of columns a child block guarantees, derived from its
 * `outputContract`. Returns `null` when the child's output schema is unknown
 * (no contract, or a contract that includes a star/unresolved entry) — in that
 * case we cannot tell a real rename from an unparsed projection, so we stay
 * silent rather than emit a false positive.
 */
function knownChildColumns(child: ManifestBlock): Set<string> | null {
  const contract = child.outputContract;
  if (!contract || contract.length === 0) return null;
  const names = new Set<string>();
  for (const entry of contract) {
    const name = entry.name?.trim();
    // A `*` / wildcard contract entry means the schema is open — we can't
    // distinguish a renamed column from a still-present one.
    if (!name || name === '*' || name.endsWith('.*')) return null;
    names.add(columnKey(name));
  }
  return names;
}

/**
 * Detect output-contract drift across all blocks. For each parent block that
 * `ref()`s a child block and references one of its columns, warn when that
 * column is no longer in the child's `outputContract`.
 *
 * Conservative on every axis: unknown child schemas, unparseable parent SQL,
 * and ambiguous (multi-source, unqualified) column references all yield no
 * warning rather than a false positive — see `extractRefColumnUsage`.
 */
export function detectOutputDrift(blocks: Record<string, ManifestBlock>): ManifestDiagnostic[] {
  const diagnostics: ManifestDiagnostic[] = [];

  for (const parent of Object.values(blocks)) {
    if (!parent.sql || !(parent.refDependencies?.length)) continue;

    const usages = extractRefColumnUsage(parent.sql);
    if (usages.length === 0) continue;

    for (const usage of usages) {
      const child = blocks[usage.block];
      if (!child) continue; // unresolved ref — handled elsewhere as a resolve diagnostic
      if (child.name === parent.name) continue; // self-reference, ignore

      const childColumns = knownChildColumns(child);
      if (!childColumns) continue; // child schema unknown — cannot judge drift

      const available = (child.outputContract ?? []).map((c) => c.name);

      for (const referenced of usage.columns) {
        if (childColumns.has(columnKey(referenced))) continue;
        diagnostics.push({
          kind: 'drift',
          filePath: parent.filePath,
          severity: 'warning',
          message:
            `block "${parent.name}" references column "${referenced}" on ref("${child.name}"), ` +
            `but "${child.name}" no longer outputs it` +
            (available.length > 0 ? ` (current outputs: ${available.join(', ')})` : '') +
            `. The child's output contract drifted — update the reference or restore the column.`,
          drift: {
            parentBlock: parent.name,
            childBlock: child.name,
            column: referenced,
            availableColumns: available,
          },
        });
      }
    }
  }

  return diagnostics;
}
