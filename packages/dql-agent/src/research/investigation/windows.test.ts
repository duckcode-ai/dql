import { describe, expect, it } from 'vitest';
import {
  addMonths, bucketsIn, formatDay, grainOfWindow, lastDayBefore, latestCompleteWindow, parseDay, priorWindow, startOfGrain, windowLabel, yearAgoWindow,
} from './windows.js';

describe('investigation periods are calendar days', () => {
  it('the latest complete period ends on or before the day after the last day with data', () => {
    expect(latestCompleteWindow('2025-08-21', 'month')).toEqual({ start: '2025-07-01', end: '2025-08-01', label: 'July 2025' });
    expect(latestCompleteWindow('2025-09-01', 'month')).toEqual({ start: '2025-08-01', end: '2025-09-01', label: 'August 2025' });
    expect(latestCompleteWindow('2025-08-21', 'quarter')).toEqual({ start: '2025-04-01', end: '2025-07-01', label: 'Q2 2025' });
    expect(lastDayBefore('2025-08-21')).toBe('2025-08-20');
  });

  it('a year earlier keeps the days, and February 29 becomes February 28', () => {
    expect(yearAgoWindow({ start: '2024-02-29', end: '2024-03-01' }, 'day')).toMatchObject({ start: '2023-02-28', end: '2023-03-01' });
    expect(yearAgoWindow({ start: '2025-07-01', end: '2025-08-01' }, 'month')).toEqual({ start: '2024-07-01', end: '2024-08-01', label: 'July 2024' });
    expect(formatDay(addMonths(parseDay('2025-01-31')!, 1))).toBe('2025-02-28');
  });

  it('the period before is the same number of buckets, or the same number of days when the window is not whole buckets', () => {
    expect(priorWindow({ start: '2025-07-01', end: '2025-10-01' }, 'quarter')).toEqual({ start: '2025-04-01', end: '2025-07-01', label: 'Q2 2025' });
    expect(priorWindow({ start: '2025-03-01', end: '2025-05-01' }, 'month')).toEqual({ start: '2025-01-01', end: '2025-03-01', label: 'January 2025 to February 2025' });
    expect(priorWindow({ start: '2025-08-01', end: '2025-08-15' }, 'month')).toEqual({ start: '2025-07-18', end: '2025-08-01', label: '2025-07-18 to 2025-07-31' });
  });

  it('weeks start on Monday, and a window is whole buckets only when it starts and ends on bucket boundaries', () => {
    expect(formatDay(startOfGrain(parseDay('2025-08-20')!, 'week'))).toBe('2025-08-18');
    expect(bucketsIn({ start: '2025-01-01', end: '2025-07-01' }, 'month')).toBe(6);
    expect(bucketsIn({ start: '2025-01-15', end: '2025-07-01' }, 'month')).toBeUndefined();
    expect(grainOfWindow({ start: '2025-01-01', end: '2026-01-01' })).toBe('year');
    expect(grainOfWindow({ start: '2025-07-01', end: '2025-08-01' })).toBe('month');
    expect(windowLabel({ start: '2025-08-18', end: '2025-08-25' }, 'week')).toBe('the week of 2025-08-18');
  });

  it('reads a period cell in the forms warehouses return, and rejects days that do not exist', () => {
    expect(parseDay('2025-02-30')).toBeUndefined();
    expect(parseDay(new Date('2025-08-01T00:00:00Z'))).toEqual({ year: 2025, month: 8, day: 1 });
    expect(parseDay('2025-08-01 00:00:00')).toEqual({ year: 2025, month: 8, day: 1 });
    expect(parseDay(20250801)).toBeUndefined();
  });
});
