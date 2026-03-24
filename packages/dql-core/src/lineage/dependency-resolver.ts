/**
 * Dependency resolver for DQL blocks.
 *
 * Performs topological sorting of blocks based on ref() calls and
 * SQL-extracted table dependencies. Detects circular dependencies.
 */

import { extractTablesFromSql } from './sql-parser.js';

/** Minimal block info needed for dependency resolution */
export interface BlockDependencyInfo {
  /** Block name (unique identifier) */
  name: string;
  /** Raw SQL query for the block */
  sql: string;
  /** Domain the block belongs to */
  domain?: string;
  /** Materialized table/view name (defaults to block name) */
  materializedAs?: string;
}

/** Result of dependency resolution */
export interface DependencyResolutionResult {
  /** Blocks in execution order (dependencies first) */
  executionOrder: string[];
  /** Map of block name → its direct dependencies */
  dependencyMap: Map<string, string[]>;
  /** Map of block name → blocks that depend on it */
  dependentsMap: Map<string, string[]>;
  /** Circular dependency chains detected (empty if none) */
  cycles: string[][];
}

/**
 * Resolve dependencies among a set of blocks and return execution order.
 *
 * Uses both explicit ref() calls and implicit SQL table references to
 * build the dependency graph. Returns a topological sort or reports cycles.
 */
export function resolveDependencies(blocks: BlockDependencyInfo[]): DependencyResolutionResult {
  const blockNames = new Set(blocks.map((b) => b.name));
  const materializedNames = new Map<string, string>();

  // Map materialized names back to block names
  for (const block of blocks) {
    const matName = block.materializedAs ?? block.name;
    materializedNames.set(matName.toLowerCase(), block.name);
  }

  // Build dependency map
  const dependencyMap = new Map<string, string[]>();
  const dependentsMap = new Map<string, string[]>();

  for (const block of blocks) {
    dependencyMap.set(block.name, []);
    dependentsMap.set(block.name, []);
  }

  for (const block of blocks) {
    const parseResult = extractTablesFromSql(block.sql);
    const deps = new Set<string>();

    // Explicit ref() calls → direct dependencies
    for (const ref of parseResult.refs) {
      if (blockNames.has(ref)) {
        deps.add(ref);
      }
    }

    // Implicit SQL table references → check if they match a block name
    for (const table of parseResult.tables) {
      const resolved = materializedNames.get(table.toLowerCase());
      if (resolved && resolved !== block.name) {
        deps.add(resolved);
      }
    }

    const depArray = [...deps];
    dependencyMap.set(block.name, depArray);

    // Build reverse map
    for (const dep of depArray) {
      const existing = dependentsMap.get(dep) ?? [];
      existing.push(block.name);
      dependentsMap.set(dep, existing);
    }
  }

  // Topological sort (Kahn's algorithm): inDeg[node] = number of unresolved deps
  const inDeg = new Map<string, number>();
  for (const block of blocks) {
    const deps = dependencyMap.get(block.name) ?? [];
    inDeg.set(block.name, deps.length);
  }

  const queue: string[] = [];
  for (const [name, deg] of inDeg) {
    if (deg === 0) queue.push(name);
  }

  const executionOrder: string[] = [];
  while (queue.length > 0) {
    // Sort queue for deterministic output
    queue.sort();
    const current = queue.shift()!;
    executionOrder.push(current);

    // For each block that depends on current, reduce its in-degree
    const dependents = dependentsMap.get(current) ?? [];
    for (const dep of dependents) {
      const newDeg = (inDeg.get(dep) ?? 1) - 1;
      inDeg.set(dep, newDeg);
      if (newDeg === 0) {
        queue.push(dep);
      }
    }
  }

  // Detect cycles — any block not in executionOrder is part of a cycle
  const cycles: string[][] = [];
  if (executionOrder.length < blocks.length) {
    const inOrder = new Set(executionOrder);
    const remaining = blocks.filter((b) => !inOrder.has(b.name)).map((b) => b.name);
    // Find cycles via DFS
    const visited = new Set<string>();
    for (const start of remaining) {
      if (visited.has(start)) continue;
      const cycle = findCycle(start, dependencyMap, visited);
      if (cycle.length > 0) {
        cycles.push(cycle);
      }
    }
  }

  return { executionOrder, dependencyMap, dependentsMap, cycles };
}

/** DFS cycle finder starting from a given node */
function findCycle(
  start: string,
  dependencyMap: Map<string, string[]>,
  globalVisited: Set<string>,
): string[] {
  const path: string[] = [];
  const pathSet = new Set<string>();
  const stack: Array<{ node: string; depIdx: number }> = [{ node: start, depIdx: 0 }];
  pathSet.add(start);
  path.push(start);
  globalVisited.add(start);

  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const deps = dependencyMap.get(top.node) ?? [];

    if (top.depIdx >= deps.length) {
      stack.pop();
      path.pop();
      pathSet.delete(top.node);
      continue;
    }

    const nextDep = deps[top.depIdx];
    top.depIdx++;

    if (pathSet.has(nextDep)) {
      // Found cycle — extract from nextDep's position to end of path
      const cycleStart = path.indexOf(nextDep);
      return [...path.slice(cycleStart), nextDep];
    }

    if (!globalVisited.has(nextDep)) {
      globalVisited.add(nextDep);
      path.push(nextDep);
      pathSet.add(nextDep);
      stack.push({ node: nextDep, depIdx: 0 });
    }
  }

  return [];
}

/**
 * Get all upstream dependencies (transitive) for a given block.
 */
export function getUpstream(blockName: string, dependencyMap: Map<string, string[]>): string[] {
  const visited = new Set<string>();
  const queue = [blockName];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const deps = dependencyMap.get(current) ?? [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        visited.add(dep);
        queue.push(dep);
      }
    }
  }

  return [...visited];
}

/**
 * Get all downstream dependents (transitive) for a given block.
 */
export function getDownstream(blockName: string, dependentsMap: Map<string, string[]>): string[] {
  const visited = new Set<string>();
  const queue = [blockName];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const deps = dependentsMap.get(current) ?? [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        visited.add(dep);
        queue.push(dep);
      }
    }
  }

  return [...visited];
}
