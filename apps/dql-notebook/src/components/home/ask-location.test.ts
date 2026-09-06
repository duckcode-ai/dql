import { describe, expect, it } from 'vitest';
import { askLocationHref, askThreadIdFromLocation, withoutAskLocationHref } from './ask-location';

describe('UI-026 the Ask thread lives in the tab URL', () => {
  it('writes and reads the thread', () => {
    expect(askLocationHref('thr_1')).toBe('/ask?thread=thr_1');
    expect(askLocationHref(undefined)).toBe('/ask');
    expect(askLocationHref('a b', '#x')).toBe('/ask?thread=a%20b#x');
    expect(askThreadIdFromLocation({ pathname: '/ask', search: '?thread=thr_1' })).toBe('thr_1');
    expect(askThreadIdFromLocation({ pathname: '/ask', search: '' })).toBeUndefined();
    expect(askThreadIdFromLocation({ pathname: '/', search: '?thread=thr_1' })).toBeUndefined();
  });
  it('leaving Ask drops the thread from the URL and keeps every other location', () => {
    expect(withoutAskLocationHref('http://localhost/ask?thread=thr_1')).toBe('/');
    expect(withoutAskLocationHref('http://localhost/ask?thread=thr_1&domain=d#h')).toBe('/?domain=d#h');
    expect(withoutAskLocationHref('http://localhost/ask/traces/r1')).toBe('/ask/traces/r1');
  });
});
