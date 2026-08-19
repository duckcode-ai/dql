import { describe, it, expect } from 'vitest';
import {
  ASSUMPTION_DOMINANCE_RATIO,
  assumeDominantCandidate,
  renderAssumptionPreamble,
} from './assumptions.js';

const because = () => 'it is the highest-ranked governed measure for this entity.';

describe('assumeDominantCandidate', () => {
  it('binds a clearly dominant leader and offers the alternatives', () => {
    const assumption = assumeDominantCandidate({
      about: 'metric',
      because,
      candidates: [
        { id: 'semantic:metric:revenue', label: 'Revenue', score: 1 },
        { id: 'semantic:metric:orders', label: 'Orders', score: 0.4 },
        { id: 'semantic:metric:units', label: 'Units', score: 0.2 },
      ],
    });
    expect(assumption).toMatchObject({ about: 'metric', chose: 'semantic:metric:revenue', choseLabel: 'Revenue' });
    expect(assumption?.alternatives.map((a) => a.label)).toEqual(['Orders', 'Units']);
  });

  it('refuses to assume a near-tie, so an ambiguous field still asks', () => {
    // The failure this prevents: two plausible measures, one silently chosen,
    // producing a confidently wrong number the user cannot see was a guess.
    expect(assumeDominantCandidate({
      about: 'metric',
      because,
      candidates: [
        { id: 'semantic:metric:revenue', label: 'Revenue', score: 1 },
        { id: 'semantic:metric:gross_revenue', label: 'Gross revenue', score: 0.95 },
      ],
    })).toBeUndefined();
  });

  it('assumes a lone candidate — there is nothing to confuse it with', () => {
    expect(assumeDominantCandidate({
      about: 'metric', because,
      candidates: [{ id: 'semantic:metric:revenue', label: 'Revenue', score: 0.3 }],
    })).toMatchObject({ chose: 'semantic:metric:revenue' });
  });

  it('assumes when the runners-up carry no signal at all', () => {
    expect(assumeDominantCandidate({
      about: 'metric', because,
      candidates: [
        { id: 'a', label: 'A', score: 0.2 },
        { id: 'b', label: 'B', score: 0 },
      ],
    })).toMatchObject({ chose: 'a' });
  });

  it('returns nothing when there are no candidates', () => {
    expect(assumeDominantCandidate({ about: 'metric', because, candidates: [] })).toBeUndefined();
  });

  it('holds the dominance bar where a near-tie is still a question', () => {
    expect(ASSUMPTION_DOMINANCE_RATIO).toBeGreaterThan(1);
    const justUnder = assumeDominantCandidate({
      about: 'metric', because,
      candidates: [{ id: 'a', label: 'A', score: 1.2 }, { id: 'b', label: 'B', score: 1 }],
    });
    expect(justUnder).toBeUndefined();
  });

  it('renders a preamble the user can check at a glance', () => {
    const text = renderAssumptionPreamble([{
      about: 'metric', chose: 'semantic:metric:revenue', choseLabel: 'Revenue',
      because: 'it is the only certified measure at customer grain.',
      alternatives: [{ id: 'semantic:metric:orders', label: 'Orders' }],
    }]);
    expect(text).toContain('Assumed metric: **Revenue**');
    expect(text).toContain('Other options: Orders.');
    expect(renderAssumptionPreamble([])).toBeUndefined();
  });
});
