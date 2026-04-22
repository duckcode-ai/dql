// v0.12 canonical `.dqlnb` serializer.
//
// `.dqlnb` files are JSON. Without a canonical form, key order in
// `JSON.stringify` tracks insertion order — so every write reshuffles
// fields and produces noisy git diffs. This module produces a
// deterministic, versioned on-disk representation:
//
//   {
//     "dqlnbVersion": 1,
//     "version": <legacy schema version>,
//     "title": "...",
//     "metadata": { ...sorted keys... },
//     "cells": [ { ...sorted keys... }, ... ]
//   }
//
// Idempotent: `canonicalizeNotebook(canonicalizeNotebook(x)) === canonicalizeNotebook(x)`.
// Preserves cell order (cells[] is array-ordered by authoring intent).
// Sorts object keys recursively at every depth.

export const NOTEBOOK_FORMAT_VERSION = 1;

/**
 * Return the declared notebook format version, or `0` if absent. Missing
 * headers are treated as v0 and upgraded on next write (see committed
 * trade-off #3 in the v0.12 plan: silent forward-upgrade, no rejection).
 */
export function readNotebookFormatVersion(source: string): number {
  try {
    const data = JSON.parse(source) as Record<string, unknown>;
    const v = data?.dqlnbVersion;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

export interface CanonicalizeNotebookOptions {
  /** Override the emitted notebook format version. Defaults to NOTEBOOK_FORMAT_VERSION. */
  version?: number;
}

/**
 * Produce the canonical on-disk JSON representation of a `.dqlnb` source.
 * Always emits `dqlnbVersion` as the first key, sorts object keys, and
 * trails with a single newline.
 *
 * Throws if the source is not valid JSON — callers should catch and fall
 * back to their legacy path during migration.
 */
export function canonicalizeNotebook(source: string, options: CanonicalizeNotebookOptions = {}): string {
  const version = options.version ?? NOTEBOOK_FORMAT_VERSION;
  const parsed = JSON.parse(source) as Record<string, unknown>;

  const { dqlnbVersion: _ignored, ...rest } = parsed;
  const withVersion: Record<string, unknown> = { dqlnbVersion: version, ...rest };

  return JSON.stringify(withVersion, keySortedReplacer(), 2) + '\n';
}

export function isNotebookCanonical(source: string): boolean {
  try {
    return canonicalizeNotebook(source) === source;
  } catch {
    return false;
  }
}

/**
 * Returns a `JSON.stringify` replacer that emits object keys in a stable
 * order: `dqlnbVersion` → `version` → `title` → `metadata` → `cells` at
 * the top level, alphabetical everywhere else. Arrays keep their order.
 */
function keySortedReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  return function replacer(_key, value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    keys.sort((a, b) => {
      const aRank = TOP_KEY_RANK[a];
      const bRank = TOP_KEY_RANK[b];
      if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
      if (aRank !== undefined) return -1;
      if (bRank !== undefined) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const sorted: Record<string, unknown> = {};
    for (const k of keys) sorted[k] = obj[k];
    return sorted;
  };
}

const TOP_KEY_RANK: Record<string, number> = {
  dqlnbVersion: 0,
  version: 1,
  title: 2,
  metadata: 3,
  cells: 4,
  id: 10,
  type: 11,
  name: 12,
  content: 13,
};
