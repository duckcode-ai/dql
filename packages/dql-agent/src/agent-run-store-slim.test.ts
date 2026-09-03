import { describe, expect, it } from 'vitest';
import { slimRunForPersistence } from './agent-run-store.js';

/**
 * A finished run carried its context pack and artifacts four to five times —
 * 4.2 MB per run on a 13-model project — and the server reached its heap limit
 * after half an hour of questions. These pin what a persisted run may weigh and
 * what it must still keep.
 */
const heavy = { contextPack: { objects: Array.from({ length: 200 }, (_, i) => ({ id: `o${i}`, blob: 'x'.repeat(2_000) })) } };

function run() {
  const artifact = { id: 'a1', kind: 'answer', title: 'Answer', trustState: 'governed', payload: { ...heavy, result: { rows: [[1]] } } };
  const step = { id: 's1', artifacts: [artifact] };
  const taskStep = { id: 's2', askAnalystTaskId: 'task-1', artifacts: [artifact] };
  const receipt = { version: 1, runId: 'r1', steps: [step, taskStep], artifacts: [artifact], evaluations: [] };
  return {
    id: 'r1',
    artifacts: [{ ...artifact, payload: { ...artifact.payload, diagnosticReceipt: receipt, diagnosticReceiptV8: { version: 8, mode: 'authoritative_v2' } } }],
    steps: [step, taskStep],
    events: [
      { type: 'run.started', payload: { question: 'q' } },
      { type: 'artifact.created', payload: artifact },
    ],
    diagnosticReceipt: receipt,
  };
}

describe('what a persisted run weighs', () => {
  it('keeps every artifact payload exactly once', () => {
    const before = JSON.stringify(run()).length;
    const slim = slimRunForPersistence(run());
    const after = JSON.stringify(slim).length;
    // Five carriers collapse to one: the payload survives on run.artifacts only.
    expect(after).toBeLessThan(before / 3);
    expect(JSON.stringify(slim.artifacts[0]!.payload)).toContain('"blob"');
    expect(JSON.stringify(slim.diagnosticReceipt)).not.toContain('"blob"');
    expect(JSON.stringify(slim.steps[0])).not.toContain('"blob"');
    expect(JSON.stringify(slim.events)).not.toContain('"blob"');
    expect(JSON.stringify((slim.artifacts[0]!.payload as { diagnosticReceipt: unknown }).diagnosticReceipt)).not.toContain('"blob"');
  });

  it('keeps identity where it drops weight, so nothing can no longer be named', () => {
    const slim = slimRunForPersistence(run());
    expect(slim.steps[0]!.artifacts[0]).toMatchObject({ id: 'a1', kind: 'answer', title: 'Answer', trustState: 'governed' });
    expect(slim.events[1]!.payload).toEqual({ artifactId: 'a1', kind: 'answer', title: 'Answer', trustState: 'governed' });
    expect(slim.events[0]!.payload).toEqual({ question: 'q' });
  });

  it('leaves a Research task step whole, because reload rebuilds task trust from it', () => {
    const slim = slimRunForPersistence(run());
    expect(JSON.stringify(slim.steps[1])).toContain('"blob"');
  });

  it('touches no other receipt version and no other field', () => {
    const slim = slimRunForPersistence(run());
    const payload = slim.artifacts[0]!.payload as Record<string, unknown>;
    expect(payload.diagnosticReceiptV8).toEqual({ version: 8, mode: 'authoritative_v2' });
    expect(payload.result).toEqual({ rows: [[1]] });
    expect(slim.id).toBe('r1');
  });
});
