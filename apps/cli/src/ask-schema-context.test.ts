import { describe, expect, it } from 'vitest';
import {
  AGENT_SCHEMA_CONTEXT_COLUMN_LIMIT,
  boundAgentSchemaColumns,
  mergeAgentSchemaCompleteness,
} from './ask-schema-context.js';

const identity = <T>(value: T): T => value;
const columns = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `column_${index}` }));

/**
 * The enterprise-only false rejection: DQL admitted `stage_name` to the analyst
 * from a 436-column mart, composed a correct query with it, and then its own
 * closure gate refused the query because the 80-column PROMPT projection did
 * not mention that column and never said it was a projection.
 */
describe('agent schema context column budget', () => {
  it('marks a truncated relation partial so a bounded projection is not read as proof', () => {
    const bounded = boundAgentSchemaColumns(columns(436), undefined, identity);
    expect(bounded.columns).toHaveLength(AGENT_SCHEMA_CONTEXT_COLUMN_LIMIT);
    expect(bounded.columnCompleteness).toBe('partial');
  });

  it('leaves a relation that fits within the budget exactly as the catalog declared it', () => {
    expect(boundAgentSchemaColumns(columns(31), 'complete', identity).columnCompleteness).toBe('complete');
    expect(boundAgentSchemaColumns(columns(31), undefined, identity).columnCompleteness).toBeUndefined();
    expect(boundAgentSchemaColumns(columns(31), 'partial', identity).columnCompleteness).toBe('partial');
  });

  it('never lets two partial views of one relation merge into a complete one', () => {
    expect(mergeAgentSchemaCompleteness('partial', 'complete')).toBe('partial');
    expect(mergeAgentSchemaCompleteness('complete', 'partial')).toBe('partial');
    expect(mergeAgentSchemaCompleteness('complete', 'complete')).toBe('complete');
    expect(mergeAgentSchemaCompleteness(undefined, 'partial')).toBe('partial');
  });
});
