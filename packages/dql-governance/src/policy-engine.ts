/**
 * PolicyEngine enforces access policies and data classification rules.
 */

export type DataClassification = 'public' | 'internal' | 'confidential' | 'restricted';

export type AccessLevel = 'read' | 'write' | 'execute' | 'admin';

export interface AccessPolicy {
  id: string;
  name: string;
  description: string;
  /** Domain this policy applies to, or '*' for all */
  domain: string;
  /** Minimum data classification level required */
  minClassification: DataClassification;
  /** Roles that are granted access */
  allowedRoles: string[];
  /** Specific users granted access (overrides roles) */
  allowedUsers: string[];
  /** Access level granted */
  accessLevel: AccessLevel;
  enabled: boolean;
}

export interface AccessCheckResult {
  allowed: boolean;
  reason?: string;
  matchedPolicy?: string;
}

export interface UserContext {
  userId: string;
  roles: string[];
  department?: string;
}

const CLASSIFICATION_RANK: Record<DataClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export class PolicyEngine {
  private policies: AccessPolicy[] = [];

  constructor(policies?: AccessPolicy[]) {
    if (policies) this.policies = [...policies];
  }

  addPolicy(policy: AccessPolicy): void {
    this.policies.push(policy);
  }

  removePolicy(id: string): void {
    this.policies = this.policies.filter((p) => p.id !== id);
  }

  listPolicies(): AccessPolicy[] {
    return [...this.policies];
  }

  /**
   * Check if a user can access a block in a given domain with a given classification.
   */
  checkAccess(
    user: UserContext,
    domain: string,
    classification: DataClassification,
    requiredLevel: AccessLevel = 'read',
  ): AccessCheckResult {
    // Find applicable policies (domain match or wildcard)
    const applicable = this.policies.filter(
      (p) => p.enabled && (p.domain === '*' || p.domain === domain),
    );

    if (applicable.length === 0) {
      // No policies = default allow (open by default)
      return { allowed: true, reason: 'No policies restrict this domain' };
    }

    // Check each policy
    for (const policy of applicable) {
      // Check classification level
      if (CLASSIFICATION_RANK[classification] < CLASSIFICATION_RANK[policy.minClassification]) {
        continue; // This policy doesn't apply to this classification level
      }

      // Check if user is explicitly allowed
      if (policy.allowedUsers.includes(user.userId)) {
        if (accessLevelSufficient(policy.accessLevel, requiredLevel)) {
          return { allowed: true, matchedPolicy: policy.id };
        }
      }

      // Check if user has an allowed role
      const hasRole = user.roles.some((r) => policy.allowedRoles.includes(r));
      if (hasRole) {
        if (accessLevelSufficient(policy.accessLevel, requiredLevel)) {
          return { allowed: true, matchedPolicy: policy.id };
        }
      }
    }

    // If we have policies but none matched, deny
    return {
      allowed: false,
      reason: `No policy grants ${requiredLevel} access to domain "${domain}" with classification "${classification}" for user "${user.userId}"`,
    };
  }

  /**
   * Get the effective classification for a set of table/column references.
   * In production, this would query a data catalog.
   */
  classifyData(tables: string[], classificationMap: Record<string, DataClassification>): DataClassification {
    let highest: DataClassification = 'public';
    for (const table of tables) {
      const cls = classificationMap[table];
      if (cls && CLASSIFICATION_RANK[cls] > CLASSIFICATION_RANK[highest]) {
        highest = cls;
      }
    }
    return highest;
  }
}

const ACCESS_LEVEL_RANK: Record<AccessLevel, number> = {
  read: 0,
  write: 1,
  execute: 2,
  admin: 3,
};

function accessLevelSufficient(granted: AccessLevel, required: AccessLevel): boolean {
  return ACCESS_LEVEL_RANK[granted] >= ACCESS_LEVEL_RANK[required];
}
