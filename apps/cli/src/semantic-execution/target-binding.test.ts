import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWarehouseTargetIdentity } from '@duckcodeailabs/dql-core';
import { saveTestedSemanticRuntimeSettings } from '../semantic-runtime-settings.js';
import {
  SemanticExecutionTargetMismatchError,
  assertSemanticExecutionTarget,
  buildSemanticTargetBinding,
} from './target-binding.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dql-target-binding-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function target(database: string, schema = 'semantic') {
  return createWarehouseTargetIdentity({
    connectionRef: `connection:${database}`,
    driver: 'snowflake',
    redactedContext: {
      account: 'acme',
      database,
      schema,
      role: 'analyst',
      warehouse: 'reporting',
    },
  });
}

describe('semantic target binding', () => {
  it('blocks dbt Cloud SQL before compilation when the active database differs', () => {
    saveTestedSemanticRuntimeSettings(root, {
      preference: 'dbt-cloud',
      dbtCloud: {
        host: 'semantic-layer.cloud.getdbt.com',
        environmentId: '99',
        serviceToken: 'secret',
      },
    }, { ok: true, message: 'ok', dialect: 'snowflake' }, target('PROD'));

    expect(() => assertSemanticExecutionTarget({
      projectRoot: root,
      adapterId: 'dbt-cloud',
      executionTarget: target('DEV'),
    })).toThrow(SemanticExecutionTargetMismatchError);
  });

  it('records redacted target and adapter evidence without credentials', () => {
    const executionTarget = target('PROD');
    const binding = buildSemanticTargetBinding({
      projectRoot: root,
      adapterId: 'native',
      executionTarget,
    });

    expect(binding.executionTarget.redactedContext.database).toBe('PROD');
    expect(binding.proof.checks.map((check) => check.kind)).toContain('warehouse_context');
    expect(JSON.stringify(binding)).not.toContain('password');
  });
});
