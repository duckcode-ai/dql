import { describe, it, expect } from 'vitest';
import { predictDispatchMs } from './local-runtime.js';

describe('predictDispatchMs — admission control', () => {
  it('uses the assumed cost before anything is observed', () => {
    expect(predictDispatchMs([], 9_000)).toBe(9_000);
  });

  it('uses the MAX with fewer than three samples', () => {
    // No distribution yet, and admitting a call the deadline then kills wastes
    // the whole remaining budget.
    expect(predictDispatchMs([2_000])).toBe(2_000);
    expect(predictDispatchMs([2_000, 8_000])).toBe(8_000);
  });

  it('stops one slow outlier from poisoning the rest of the run', () => {
    // The reported failure: RUN_DEADLINE_INSUFFICIENT 6.4s into a 45s budget,
    // because a single cold-start response became the predictor for every later
    // call. p75 discounts it once there is a real sample.
    const withOutlier = [1_000, 1_100, 1_200, 1_300, 30_000];
    expect(predictDispatchMs(withOutlier)).toBeLessThan(30_000);
    expect(predictDispatchMs(withOutlier)).toBeGreaterThanOrEqual(1_300);
  });

  it('still respects a provider that is genuinely slow throughout', () => {
    // p75 errs slow on purpose: if every call is slow, admission must believe it.
    expect(predictDispatchMs([20_000, 21_000, 22_000, 23_000])).toBeGreaterThanOrEqual(22_000);
  });

  it('is order-independent', () => {
    const a = predictDispatchMs([5_000, 1_000, 3_000, 2_000]);
    const b = predictDispatchMs([1_000, 2_000, 3_000, 5_000]);
    expect(a).toBe(b);
  });

  it('never returns a value outside the observed range', () => {
    const observed = [1_000, 2_000, 3_000, 4_000, 5_000];
    const predicted = predictDispatchMs(observed);
    expect(predicted).toBeGreaterThanOrEqual(Math.min(...observed));
    expect(predicted).toBeLessThanOrEqual(Math.max(...observed));
  });
});
