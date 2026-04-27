import {
  loadAppDocument,
  findAppDocuments,
  type AppDocument,
} from '@duckcodeailabs/dql-core';
import { PolicyEngine, type AccessLevel, type AccessPolicy, type DataClassification } from '@duckcodeailabs/dql-governance';
import {
  defaultPersonaRegistry,
  mergePersonaVariables,
} from '@duckcodeailabs/dql-project';

export class DQLAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DQLAccessDeniedError';
  }
}

export function runtimeVariables(base: Record<string, unknown> | undefined): Record<string, unknown> {
  return mergePersonaVariables(base ?? {}, defaultPersonaRegistry.active);
}

export function activePersonaAppId(): string | undefined {
  return defaultPersonaRegistry.active?.appId;
}

export function loadRuntimeApp(projectRoot: string, appId: string | undefined | null): AppDocument | null {
  if (!appId) return null;
  for (const p of findAppDocuments(projectRoot)) {
    const { document } = loadAppDocument(p);
    if (document?.id === appId) return document;
  }
  return null;
}

export function assertAppAccess(opts: {
  app: AppDocument | null;
  domain?: string | null;
  classification?: DataClassification | null;
  level?: AccessLevel;
}): void {
  const app = opts.app;
  if (!app) return;
  const user = defaultPersonaRegistry.toUserContext();
  const engine = new PolicyEngine(app.policies.map(toAccessPolicy));
  const result = engine.checkAccess(
    user,
    opts.domain ?? app.domain,
    opts.classification ?? 'internal',
    opts.level ?? 'execute',
  );
  if (!result.allowed) {
    throw new DQLAccessDeniedError(result.reason ?? 'Not authorized');
  }
}

function toAccessPolicy(policy: AppDocument['policies'][number]): AccessPolicy {
  return {
    id: policy.id,
    name: policy.id,
    description: policy.description ?? policy.id,
    domain: policy.domain,
    minClassification: policy.minClassification,
    allowedRoles: policy.allowedRoles,
    allowedUsers: policy.allowedUsers ?? [],
    accessLevel: policy.accessLevel,
    enabled: policy.enabled !== false,
  };
}
