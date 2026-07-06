import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiRoute } from '../../store/types';
import type * as AiBuildResultModule from './AiBuildResult';

let defaultRouteLabel: typeof AiBuildResultModule.defaultRouteLabel;
let resolveCellResultCopy: typeof AiBuildResultModule.resolveCellResultCopy;

describe('AiBuildResult DQL-first copy', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    const module = await import('./AiBuildResult');
    defaultRouteLabel = module.defaultRouteLabel;
    resolveCellResultCopy = module.resolveCellResultCopy;
  });

  it('labels cell builds as SQL previews with DQL promotion guidance', () => {
    expect(resolveCellResultCopy()).toMatchObject({
      heading: 'SQL preview',
      badge: 'Review-required',
      insertLabel: 'Insert preview',
      insertedLabel: 'Preview inserted',
      guidance: expect.stringContaining('promote the reviewed logic into a DQL draft'),
    });
  });

  it('uses preview language for generated SQL route fallback labels', () => {
    const route: AiRoute = { tier: 'generated_sql', label: '' };

    expect(defaultRouteLabel(route)).toBe('Generated SQL preview');
  });
});
