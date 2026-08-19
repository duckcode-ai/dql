import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_ITERATIONS,
  LEGACY_ORCHESTRATOR_POLICY,
  laneRunsShadowComparison,
  laneUsesAgenticOrchestrator,
  resolveOrchestratorPolicy,
} from './orchestrator-policy.js';

describe('resolveOrchestratorPolicy', () => {
  it('defaults to legacy with no lanes — a migration control must not default on', () => {
    const policy = resolveOrchestratorPolicy();
    expect(policy).toMatchObject({ mode: 'legacy', maxIterations: DEFAULT_MAX_ITERATIONS, fallbackOnError: true });
    expect(policy.lanes.size).toBe(0);
    expect(LEGACY_ORCHESTRATOR_POLICY.mode).toBe('legacy');
  });

  it('reads mode and lanes from project config', () => {
    const policy = resolveOrchestratorPolicy({ config: { mode: 'agentic', lanes: ['certified', 'semantic'] } });
    expect(policy.mode).toBe('agentic');
    expect([...policy.lanes].sort()).toEqual(['certified', 'semantic']);
  });

  it('falls back to legacy on a malformed mode instead of a partial agentic policy', () => {
    // A typo in dql.config.json must not silently route real questions through
    // an unproven path.
    expect(resolveOrchestratorPolicy({ config: { mode: 'agentik', lanes: ['certified'] } }).mode).toBe('legacy');
  });

  it('drops unknown lane names rather than accepting them', () => {
    const policy = resolveOrchestratorPolicy({ config: { mode: 'agentic', lanes: ['certified', 'nonsense'] } });
    expect([...policy.lanes]).toEqual(['certified']);
  });

  it('lets a host override the config, and never the reverse', () => {
    const policy = resolveOrchestratorPolicy({
      config: { mode: 'legacy', lanes: [] },
      override: { mode: 'agentic', lanes: ['generated'] },
    });
    expect(policy.mode).toBe('agentic');
    expect([...policy.lanes]).toEqual(['generated']);
  });

  it('bounds iterations — an unbounded loop is an outage waiting to happen', () => {
    expect(resolveOrchestratorPolicy({ config: { maxIterations: 9999 } }).maxIterations).toBe(40);
    expect(resolveOrchestratorPolicy({ config: { maxIterations: -1 } }).maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
    expect(resolveOrchestratorPolicy({ config: { maxIterations: 'six' } }).maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
  });

  it('routes only enabled lanes, and shadow never serves the user', () => {
    const agentic = resolveOrchestratorPolicy({ config: { mode: 'agentic', lanes: ['certified'] } });
    expect(laneUsesAgenticOrchestrator(agentic, 'certified')).toBe(true);
    expect(laneUsesAgenticOrchestrator(agentic, 'generated')).toBe(false);

    const shadow = resolveOrchestratorPolicy({ config: { mode: 'shadow', lanes: ['certified'] } });
    // Shadow compares; it must not answer, or "observe before switching" is moot.
    expect(laneUsesAgenticOrchestrator(shadow, 'certified')).toBe(false);
    expect(laneRunsShadowComparison(shadow, 'certified')).toBe(true);
    expect(laneRunsShadowComparison(agentic, 'certified')).toBe(false);
  });
});
