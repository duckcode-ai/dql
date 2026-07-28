import { describe, expect, it } from 'vitest';
import { parseCommaList } from './CommaListInput';

/**
 * These reproduce, at the data level, why the old inline pattern made the
 * fields untypeable. The component's fix is to keep the TYPED TEXT in local
 * state; parsing stays lossy on purpose, because a list genuinely has no empty
 * members — it just must never be fed back into the input mid-typing.
 */
describe('comma-separated list fields', () => {
  it('parses a finished list', () => {
    expect(parseCommaList('revenue, kpi')).toEqual(['revenue', 'kpi']);
    expect(parseCommaList('')).toEqual([]);
  });

  it('shows why re-rendering the parsed value ate the keystrokes', () => {
    // The old binding was value={list.join(', ')} with this parse on every
    // keystroke. Replay what the user typed after "revenue":
    const afterComma = parseCommaList('revenue,').join(', ');
    // The comma is gone the instant it is typed...
    expect(afterComma).toBe('revenue');
    const afterSpace = parseCommaList('revenue, ').join(', ');
    // ...and so is the space, so a second item can never be started.
    expect(afterSpace).toBe('revenue');
    // Mid-word typing survived, which is why the field looked partly working.
    expect(parseCommaList('revenue, k').join(', ')).toBe('revenue, k');
  });

  it('keeps interior spaces inside a single item', () => {
    expect(parseCommaList('gross margin, net revenue')).toEqual(['gross margin', 'net revenue']);
  });
});
