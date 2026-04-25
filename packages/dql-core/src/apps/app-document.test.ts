import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAppDocument,
  resolveRlsContext,
  findAppDocuments,
  suggestAppId,
  type AppDocument,
} from './app-document.js';

const minimalApp: AppDocument = {
  version: 1,
  id: 'growth-cxo',
  name: 'Growth — CXO',
  domain: 'growth',
  owners: ['alice@acme.com'],
  members: [
    { userId: 'alice@acme.com', roles: ['owner'], attributes: { region: 'NA' } },
    { userId: 'bob@acme.com', roles: ['viewer'], attributes: { region: 'EU' } },
  ],
  roles: [
    { id: 'owner' },
    { id: 'viewer' },
  ],
  policies: [
    {
      id: 'viewers-read',
      domain: 'growth',
      minClassification: 'internal',
      allowedRoles: ['viewer', 'owner'],
      accessLevel: 'read',
    },
  ],
};

describe('parseAppDocument', () => {
  it('parses a minimal valid App', () => {
    const { document, errors } = parseAppDocument(JSON.stringify(minimalApp));
    expect(errors).toEqual([]);
    expect(document?.id).toBe('growth-cxo');
    expect(document?.members).toHaveLength(2);
    // enabled defaults to true when omitted
    expect(document?.policies[0].enabled).toBe(true);
  });

  it('rejects invalid JSON', () => {
    const { document, errors } = parseAppDocument('{ not json');
    expect(document).toBeNull();
    expect(errors[0].message).toMatch(/invalid JSON/);
  });

  it('errors when required fields are missing', () => {
    const { document, errors } = parseAppDocument('{}');
    expect(document).toBeNull();
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.some((e) => e.message.includes('"id"'))).toBe(true);
  });

  it('errors on undeclared role references', () => {
    const bad = {
      ...minimalApp,
      members: [{ userId: 'eve@acme.com', roles: ['ghost'] }],
    };
    const { document, errors } = parseAppDocument(JSON.stringify(bad));
    expect(document).toBeNull();
    expect(errors.some((e) => e.message.includes('undeclared role "ghost"'))).toBe(true);
  });

  it('rejects ids with unsafe folder characters', () => {
    const bad = { ...minimalApp, id: 'has spaces and / slash' };
    const { document, errors } = parseAppDocument(JSON.stringify(bad));
    expect(document).toBeNull();
    expect(errors.some((e) => e.message.includes('folder-safe'))).toBe(true);
  });

  it('round-trips schedules with slack delivery', () => {
    const app = {
      ...minimalApp,
      schedules: [
        {
          id: 'weekly',
          cron: '0 9 * * 1',
          dashboard: 'overview',
          deliver: [{ kind: 'slack', channel: '#growth' }],
        },
      ],
    };
    const { document, errors } = parseAppDocument(JSON.stringify(app));
    expect(errors).toEqual([]);
    expect(document?.schedules?.[0].deliver[0]).toEqual({ kind: 'slack', channel: '#growth' });
    expect(document?.schedules?.[0].enabled).toBe(true);
  });
});

describe('resolveRlsContext', () => {
  it('substitutes member attributes for matching role bindings', () => {
    const app: AppDocument = {
      ...minimalApp,
      rlsBindings: [
        { role: 'viewer', variable: 'user.region', from: 'region' },
      ],
    };
    const bob = app.members.find((m) => m.userId === 'bob@acme.com')!;
    expect(resolveRlsContext(app, bob)).toEqual({ 'user.region': 'EU' });
  });

  it('returns empty for owners with no matching bindings', () => {
    const app: AppDocument = {
      ...minimalApp,
      rlsBindings: [
        { role: 'viewer', variable: 'user.region', from: 'region' },
      ],
    };
    const alice = app.members.find((m) => m.userId === 'alice@acme.com')!;
    // owner has no viewer-bound RLS — context should be empty.
    expect(resolveRlsContext(app, alice)).toEqual({});
  });
});

describe('findAppDocuments', () => {
  it('discovers manifest files under apps/<id>/', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-apps-'));
    try {
      mkdirSync(join(root, 'apps', 'one'), { recursive: true });
      mkdirSync(join(root, 'apps', 'two'), { recursive: true });
      writeFileSync(join(root, 'apps', 'one', 'dql.app.json'), '{}');
      writeFileSync(join(root, 'apps', 'two', 'dql.app.json'), '{}');
      const found = findAppDocuments(root);
      expect(found).toHaveLength(2);
      expect(found[0].endsWith('one/dql.app.json')).toBe(true);
      expect(found[1].endsWith('two/dql.app.json')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty when no apps/ exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-apps-'));
    try {
      expect(findAppDocuments(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('suggestAppId', () => {
  it('lowercases and strips unsafe characters', () => {
    expect(suggestAppId('Growth — CXO View')).toBe('growth-cxo-view');
  });
  it('returns "app" for an empty input', () => {
    expect(suggestAppId('   ')).toBe('app');
  });
});
