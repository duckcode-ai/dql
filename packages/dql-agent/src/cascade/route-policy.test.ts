import { describe, expect, it } from 'vitest';
import {
  routeForCascadeAnswerTier,
  selectCascadeRunRoute,
  type CascadeRouteDecision,
} from './route-policy.js';

const answerDecision: CascadeRouteDecision = { action: 'answer' };

describe('selectCascadeRunRoute', () => {
  it('honors explicit requested modes before inferred routing', () => {
    expect(selectCascadeRunRoute({
      question: 'what is total revenue?',
      requestedMode: 'research',
    }, answerDecision)).toBe('research');

    expect(selectCascadeRunRoute({
      question: 'what is total revenue?',
      requestedMode: 'sql',
    }, answerDecision)).toBe('sql_cell');

    expect(selectCascadeRunRoute({
      question: 'what is total revenue?',
      requestedMode: 'block',
    }, answerDecision)).toBe('dql_block_draft');
  });

  it('routes conversational decisions before authoring phrase matches', () => {
    expect(selectCascadeRunRoute({
      question: 'hi, can you write a sql query later?',
    }, { action: 'converse' })).toBe('conversation');
  });

  it('routes authoring and app-building requests from question shape', () => {
    expect(selectCascadeRunRoute({
      question: 'create a SQL notebook cell for orders by week',
    }, answerDecision)).toBe('sql_cell');

    expect(selectCascadeRunRoute({
      question: 'turn this result into a dql block',
    }, answerDecision)).toBe('dql_block_draft');

    expect(selectCascadeRunRoute({
      question: 'create a cockpit for sales leaders',
    }, answerDecision)).toBe('app_build');
  });

  it('uses decision actions after question-shape authoring checks', () => {
    expect(selectCascadeRunRoute({
      question: 'what changed in revenue?',
    }, { action: 'investigate' })).toBe('research');

    expect(selectCascadeRunRoute({
      question: 'what is revenue?',
    }, { action: 'clarify' })).toBe('clarify');

    expect(selectCascadeRunRoute({
      question: 'build an executive view',
    }, { action: 'compose_app' })).toBe('app_build');
  });

  it('keeps direct answer routing thin until the answer loop resolves the tier', () => {
    expect(selectCascadeRunRoute({
      question: 'what is total revenue?',
    }, answerDecision)).toBe('generated_answer');
  });

  it('maps answer-loop tiers back to engine routes', () => {
    expect(routeForCascadeAnswerTier('certified_block')).toBe('certified_answer');
    expect(routeForCascadeAnswerTier('business_context')).toBe('certified_answer');
    expect(routeForCascadeAnswerTier('semantic_metric')).toBe('generated_answer');
    expect(routeForCascadeAnswerTier('generated_sql')).toBe('generated_answer');
    expect(routeForCascadeAnswerTier('no_answer')).toBe('generated_answer');
    expect(routeForCascadeAnswerTier(undefined)).toBeUndefined();
  });
});
