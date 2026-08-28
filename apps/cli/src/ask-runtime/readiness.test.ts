import { describe, expect, it } from 'vitest';
import { probeAskTierReadinessV1 } from './readiness.js';

describe('probeAskTierReadinessV1', () => {
  it('AGT-037 advances an unavailable MetricFlow target without treating semantic metadata as readiness', () => {
    const readiness = probeAskTierReadinessV1({
      targetConfigured: true,
      connectorInstalled: true,
      physicalSchemaAvailable: true,
      semanticCandidatesPresent: true,
      requiredSemanticAdapters: ['metricflow'],
      adapters: [{ id: 'metricflow-cli', ready: false, targetBound: false }],
      targetFingerprint: 'sha256:target',
    });
    expect(readiness).toMatchObject({
      connector: 'ready',
      activeTarget: 'ready',
      semanticCompiler: 'unavailable',
      physicalSchema: 'ready',
    });
  });

  it('requires both a ready adapter and a target binding for full semantic execution', () => {
    expect(probeAskTierReadinessV1({
      targetConfigured: true,
      connectorInstalled: true,
      physicalSchemaAvailable: false,
      semanticCandidatesPresent: true,
      requiredSemanticAdapters: ['metricflow-cli'],
      adapters: [{ id: 'metricflow-cli', ready: true, targetBound: true }],
    }).semanticCompiler).toBe('ready');
  });

  it('keeps a native semantic compiler available before a connection is configured', () => {
    expect(probeAskTierReadinessV1({
      targetConfigured: false,
      connectorInstalled: false,
      physicalSchemaAvailable: true,
      semanticCandidatesPresent: true,
      requiredSemanticAdapters: ['native'],
      adapters: [],
    })).toMatchObject({
      connector: 'unavailable',
      activeTarget: 'unavailable',
      semanticCompiler: 'ready',
      physicalSchema: 'ready',
    });
  });

  it('does not report an unready external semantic adapter as compiler-ready without a target', () => {
    expect(probeAskTierReadinessV1({
      targetConfigured: false,
      connectorInstalled: false,
      physicalSchemaAvailable: true,
      semanticCandidatesPresent: true,
      requiredSemanticAdapters: ['metricflow-cli'],
      adapters: [{ id: 'metricflow-cli', ready: false, targetBound: false }],
    }).semanticCompiler).toBe('unavailable');
  });

  it('accepts a proven native compiler alternative without relabeling an unready external adapter', () => {
    expect(probeAskTierReadinessV1({
      targetConfigured: false,
      connectorInstalled: false,
      physicalSchemaAvailable: true,
      semanticCandidatesPresent: true,
      // local-runtime adds native only after semanticLayer.canComposeMetric
      // proves the selected snapshot has this in-process compiler option.
      requiredSemanticAdapters: ['metricflow-cli', 'native'],
      adapters: [{ id: 'metricflow-cli', ready: false, targetBound: false }],
    })).toMatchObject({
      connector: 'unavailable',
      activeTarget: 'unavailable',
      semanticCompiler: 'ready',
    });
  });

  it('keeps a ready external semantic compiler available before a target is selected', () => {
    expect(probeAskTierReadinessV1({
      targetConfigured: false,
      connectorInstalled: false,
      physicalSchemaAvailable: true,
      semanticCandidatesPresent: true,
      requiredSemanticAdapters: ['metricflow-cli'],
      adapters: [{ id: 'metricflow-cli', ready: true, targetBound: false }],
    }).semanticCompiler).toBe('ready');
  });
});
