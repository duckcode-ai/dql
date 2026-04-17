import { describe, expect, it } from 'vitest';
import {
  PLUGIN_API_VERSION,
  type ChartRenderer,
  type Connector,
  type RulePack,
} from './index.js';

describe('plugin-api contracts', () => {
  it('version tag is 1.0', () => {
    expect(PLUGIN_API_VERSION).toBe('1.0');
  });

  it('a minimal Connector compiles against the contract', () => {
    const c: Connector = {
      metadata: {
        id: 'mock',
        displayName: 'Mock',
        supports: { streaming: false, introspection: false, transactions: false },
      },
      async connect() {},
      async close() {},
      async query() { return { columns: [], rows: [], rowCount: 0 }; },
    };
    expect(c.metadata.id).toBe('mock');
  });

  it('a minimal ChartRenderer compiles against the contract', () => {
    const r: ChartRenderer = {
      id: 'mock',
      displayName: 'Mock',
      configSchema: { type: 'object', properties: {} },
      validate(cfg) { return { ok: true, config: cfg }; },
      render(_r, _cfg) { return { kind: 'vega-lite', spec: {} }; },
    };
    expect(r.id).toBe('mock');
  });

  it('a minimal RulePack compiles against the contract', () => {
    const pack: RulePack = {
      id: 'mock',
      displayName: 'Mock',
      version: '0.0.1',
      rules: [
        {
          id: 'r',
          description: 'd',
          defaultSeverity: 'warning',
          check() { return []; },
        },
      ],
    };
    expect(pack.rules).toHaveLength(1);
  });
});
