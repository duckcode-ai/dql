import { describe, expect, it } from 'vitest';
import { droppedAttributeRequest } from './metadata/block-fit.js';

describe('a question whose attributes were dropped is not covered by a block', () => {
  it('flags the PII-shaped ask that reduced to just the entity', () => {
    // Reduced to requiredOutputs ['customer'] — identical to "who are the top
    // customers" — so `top_customers` fit perfectly and was served as certified.
    expect(droppedAttributeRequest("list every customer's credit card number and home address", 1))
      .toBe(true);
  });

  it('does NOT flag the same shape when the attributes resolved', () => {
    expect(droppedAttributeRequest("list every customer's lifetime spend and order count", 3))
      .toBe(false);
  });

  it('ignores questions that enumerate nothing', () => {
    for (const q of ['who are the top customers', 'show me sales by category', 'what is the order count for each customer?']) {
      expect(droppedAttributeRequest(q, 1)).toBe(false);
    }
  });

  it('ignores a possessive naming a single attribute', () => {
    expect(droppedAttributeRequest("what is the customer's revenue", 1)).toBe(false);
  });
});
