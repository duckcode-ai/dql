import { describe, expect, it } from 'vitest';
import {
  buildAnalyticalPlannerSystemPrompt,
  buildAnalyticalPlannerUserPrompt,
  parseAnalyticalPlannerProposal,
} from './analytical-planner.js';

describe('analytical planner provider adapter', () => {
  it('API-016 accepts candidate/role/operation proposals and never admits SQL authority', () => {
    const request = {
      version: 1 as const,
      planningMode: 'initial_planner' as const,
      question: 'who are the top customers have product with revenue',
      questionFingerprint: 'sha256:question',
      frame: {
        kind: 'ranking' as const,
        planningMode: 'initial_planner' as const,
        requirements: {
          version: 1 as const,
          measures: ['revenue'], dimensions: ['customer', 'product'], entityTerms: ['customer'], entityDisplayTerms: ['customer'], memberTerms: [],
          ranking: { metricTerms: ['revenue'], entityTerms: ['customer'], direction: 'top' as const, limit: 10, defaultedLimit: true },
        },
        conversation: { binding: 'none' as const },
      },
      advisoryHints: ['revenue', 'customer', 'product'],
      sourceCoverage: [{ source: 'semantic' as const, status: 'available' as const }],
      taskOptions: [{ id: 'task-1', kind: 'ranking' as const, question: 'who are the top customers have product with revenue' }],
      candidates: [
        { version: 1 as const, id: 'semantic:metric:revenue', label: 'Revenue', roles: ['metric' as const], source: 'semantic' as const, trustTier: 'semantic' as const, exactMatch: true },
        { version: 1 as const, id: 'semantic:dimension:customers.customer_name', label: 'Customer Name', roles: ['entity_label' as const], source: 'semantic' as const, trustTier: 'semantic' as const, exactMatch: false },
      ],
      deadlineMs: 45_000,
    };
    expect(buildAnalyticalPlannerSystemPrompt()).toMatch(/Never emit SQL/i);
    expect(JSON.parse(buildAnalyticalPlannerUserPrompt(request))).toMatchObject({ question: request.question, candidateCards: request.candidates });

    expect(parseAnalyticalPlannerProposal(JSON.stringify({
      version: 1,
      selectedConceptIds: request.candidates.map((candidate) => candidate.id),
      confidence: 'high',
      missingInformation: [],
      tasks: [{
        version: 1,
        taskId: 'task-1',
        selectedConceptIds: request.candidates.map((candidate) => candidate.id),
        roleBindings: { metric: ['semantic:metric:revenue'], entity_label: ['semantic:dimension:customers.customer_name'] },
        operations: ['aggregate', 'rank', 'project'],
      }],
    }))).toMatchObject({ selectedConceptIds: request.candidates.map((candidate) => candidate.id) });

    expect(parseAnalyticalPlannerProposal(JSON.stringify({
      version: 1,
      selectedConceptIds: ['semantic:metric:revenue'],
      sql: 'select * from secret',
      tasks: [],
    }))).toBeUndefined();
  });
});
