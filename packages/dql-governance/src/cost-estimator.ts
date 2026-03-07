/**
 * CostEstimator provides heuristic query cost estimation.
 * In production, this would integrate with database EXPLAIN plans.
 * For now, it uses SQL analysis heuristics.
 */

export interface CostEstimate {
  score: number;
  factors: CostFactor[];
  recommendation?: string;
}

export interface CostFactor {
  name: string;
  impact: number;
  description: string;
}

export class CostEstimator {
  private maxScore: number;

  constructor(maxScore = 100) {
    this.maxScore = maxScore;
  }

  /**
   * Estimate the cost of a SQL query using heuristic analysis.
   */
  estimate(sql: string): CostEstimate {
    const normalized = sql.toUpperCase();
    const factors: CostFactor[] = [];
    let score = 10; // base cost

    // Full table scan indicator
    if (!normalized.includes('WHERE') && !normalized.includes('LIMIT')) {
      factors.push({ name: 'no-filter', impact: 20, description: 'No WHERE clause or LIMIT — potential full table scan' });
      score += 20;
    }

    // JOIN complexity
    const joinCount = (normalized.match(/\bJOIN\b/g) || []).length;
    if (joinCount > 0) {
      const impact = joinCount * 8;
      factors.push({ name: 'joins', impact, description: `${joinCount} JOIN(s) detected` });
      score += impact;
    }

    // Subquery complexity
    const subqueryCount = (normalized.match(/\bSELECT\b/g) || []).length - 1;
    if (subqueryCount > 0) {
      const impact = subqueryCount * 10;
      factors.push({ name: 'subqueries', impact, description: `${subqueryCount} subquery/subqueries detected` });
      score += impact;
    }

    // Window functions
    const windowCount = (normalized.match(/\bOVER\s*\(/g) || []).length;
    if (windowCount > 0) {
      const impact = windowCount * 5;
      factors.push({ name: 'window-functions', impact, description: `${windowCount} window function(s)` });
      score += impact;
    }

    // DISTINCT
    if (normalized.includes('DISTINCT')) {
      factors.push({ name: 'distinct', impact: 5, description: 'DISTINCT requires deduplication' });
      score += 5;
    }

    // GROUP BY with many columns
    const groupByMatch = normalized.match(/GROUP\s+BY\s+(.+?)(?:HAVING|ORDER|LIMIT|$)/);
    if (groupByMatch) {
      const groupCols = groupByMatch[1].split(',').length;
      if (groupCols > 3) {
        const impact = (groupCols - 3) * 3;
        factors.push({ name: 'high-cardinality-group', impact, description: `GROUP BY with ${groupCols} columns` });
        score += impact;
      }
    }

    // ORDER BY without LIMIT
    if (normalized.includes('ORDER BY') && !normalized.includes('LIMIT')) {
      factors.push({ name: 'unbounded-sort', impact: 8, description: 'ORDER BY without LIMIT — sorts entire result set' });
      score += 8;
    }

    // CROSS JOIN
    if (normalized.includes('CROSS JOIN')) {
      factors.push({ name: 'cross-join', impact: 30, description: 'CROSS JOIN produces cartesian product' });
      score += 30;
    }

    // LIKE with leading wildcard
    if (normalized.match(/LIKE\s+'%/)) {
      factors.push({ name: 'leading-wildcard', impact: 10, description: 'LIKE with leading wildcard prevents index usage' });
      score += 10;
    }

    score = Math.min(score, this.maxScore);

    let recommendation: string | undefined;
    if (score > 70) {
      recommendation = 'High cost query — consider adding filters, indexes, or materializing intermediate results.';
    } else if (score > 40) {
      recommendation = 'Moderate cost — review JOINs and subqueries for optimization opportunities.';
    }

    return { score, factors, recommendation };
  }
}
