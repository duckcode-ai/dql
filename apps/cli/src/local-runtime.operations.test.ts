import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from './local-runtime.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('local background operation API (PERF-001, API-001)', () => {
  it('acknowledges certification before execution finishes and executes the warehouse query once', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-operation-api-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'operation_api' }));

    let releaseQuery!: () => void;
    const queryGate = new Promise<void>((resolve) => { releaseQuery = resolve; });
    const executeQuery = vi.fn(async () => {
      await queryGate;
      return {
        columns: ['value'],
        rows: [{ value: 1 }],
        rowCount: 1,
        executionTime: 1,
      };
    });
    const executor = { executeQuery } as unknown as QueryExecutor;
    let server: Server | undefined;

    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const source = `block "Async Revenue" {
  status = "draft"
  domain = "finance"
  type = "custom"
  description = "Revenue certification operation."
  owner = "analytics"
  query = """SELECT 1 AS value"""
  tests {
    assert row_count > 0
  }
}`;
      const requestBody = {
        source,
        metadata: {
          name: 'Async Revenue',
          path: null,
          domain: 'finance',
          description: 'Revenue certification operation.',
          owner: 'analytics',
          tags: [],
          reviewStatus: 'draft',
        },
        clientRevision: 'revision-1',
      };
      const acceptedResponse = await fetch(`${base}/api/block-studio/certifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'certification-1' },
        body: JSON.stringify(requestBody),
      });
      const accepted = await acceptedResponse.json() as { operation: { id: string; status: string }; draft: { path: string } };

      expect(acceptedResponse.status).toBe(202);
      expect(accepted.operation.status).toBe('running');
      expect(accepted.draft.path).toContain('/_drafts/');
      expect(executeQuery).toHaveBeenCalledTimes(1);

      const duplicate = await fetch(`${base}/api/block-studio/certifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'certification-1' },
        body: JSON.stringify(requestBody),
      }).then((response) => response.json()) as { operation: { id: string }; deduplicated: boolean };
      expect(duplicate).toMatchObject({ operation: { id: accepted.operation.id }, deduplicated: true });
      expect(executeQuery).toHaveBeenCalledTimes(1);

      releaseQuery();
      const completed = await waitForOperation(base, accepted.operation.id);
      expect(completed).toMatchObject({
        status: 'succeeded',
        result: { outcome: 'certified' },
      });
      expect(executeQuery).toHaveBeenCalledTimes(1);
      const certifiedPath = String((completed.result as { newPath?: string }).newPath);
      expect(readFileSync(join(projectRoot, certifiedPath), 'utf-8')).toContain('status = "certified"');
    } finally {
      releaseQuery();
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    }
  });
});

async function waitForOperation(base: string, operationId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = await fetch(`${base}/api/operations/${encodeURIComponent(operationId)}`)
      .then((response) => response.json()) as Record<string, unknown>;
    if (!['queued', 'running'].includes(String(operation.status))) return operation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Operation ${operationId} did not finish.`);
}
