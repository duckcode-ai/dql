import { describe, expect, it } from 'vitest';
import { evaluateMonitors, readAppMonitors, type AppMonitor } from './monitors.js';
import type { StoryBindingCatalog } from './story-bindings.js';

const catalog: StoryBindingCatalog = {
  'kpi.revenue': { key: 'kpi.revenue', tileId: 'kpi', label: 'Revenue', kind: 'number', value: 85, unit: { kind: 'currency', currency: 'USD' }, display: '$85' },
  'kpi.margin_rate': { key: 'kpi.margin_rate', tileId: 'kpi', label: 'Margin rate', kind: 'number', value: 0.42, unit: { kind: 'percent' }, display: '42%' },
  'by_region.leader': { key: 'by_region.leader', tileId: 'by_region', label: 'Top region', kind: 'text', value: 'US', display: 'US' },
};

const monitor = (id: string, binding: string, when: AppMonitor['when'], label?: string): AppMonitor => ({ id, binding, when, ...(label ? { label } : {}) });

describe('App monitors (RFC 0008 step 10)', () => {
  it('parses valid monitors and reports each bad one', () => {
    const errors: string[] = [];
    const parsed = readAppMonitors([
      { id: 'low-revenue', binding: 'kpi.revenue', when: { kind: 'threshold', op: '<', value: 100 }, label: 'Revenue below plan' },
      { id: 'swing', binding: 'kpi.revenue', when: { kind: 'change', direction: 'either', percent: 20 } },
      { id: 'low-revenue', binding: 'kpi.revenue', when: { kind: 'threshold', op: '<', value: 1 } },
      { id: 'bad op', binding: 'kpi.revenue', when: { kind: 'threshold', op: '!=', value: 1 } },
      { id: 'no-dot', binding: 'revenue', when: { kind: 'threshold', op: '<', value: 1 } },
      { id: 'zero', binding: 'kpi.revenue', when: { kind: 'change', direction: 'up', percent: 0 } },
    ], 'schedules[daily]', (message) => errors.push(message));
    expect(parsed.map((entry) => entry.id)).toEqual(['low-revenue', 'swing']);
    expect(parsed[0]).toEqual({ id: 'low-revenue', binding: 'kpi.revenue', when: { kind: 'threshold', op: '<', value: 100 }, label: 'Revenue below plan' });
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain('used twice');
  });

  it('fires a threshold on the figure the page shows, in the unit people read', () => {
    const [below, above, rate] = evaluateMonitors([
      monitor('a', 'kpi.revenue', { kind: 'threshold', op: '<', value: 100 }, 'Revenue'),
      monitor('b', 'kpi.revenue', { kind: 'threshold', op: '>', value: 100 }),
      monitor('c', 'kpi.margin_rate', { kind: 'threshold', op: '<', value: 45 }),
    ], catalog);
    expect(below).toMatchObject({ status: 'breached', current: '$85', message: 'Revenue is $85, below $100.' });
    expect(above).toMatchObject({ status: 'ok', message: 'Revenue is $85; the alert is for above $100.' });
    // 42% against a 45 threshold: percent figures compare in percent.
    expect(rate).toMatchObject({ status: 'breached', message: 'Margin rate is 42%, below 45%.' });
  });

  it('fires on a change since the last run, and says when there is no baseline yet', () => {
    const monitors = [
      monitor('fall', 'kpi.revenue', { kind: 'change', direction: 'down', percent: 20 }),
      monitor('rise', 'kpi.revenue', { kind: 'change', direction: 'up', percent: 20 }),
    ];
    const [fall, rise] = evaluateMonitors(monitors, catalog, { 'kpi.revenue': { value: 125, display: '$125' } });
    expect(fall).toMatchObject({ status: 'breached', previous: '$125', message: 'Revenue fell 32% since the last run ($125 → $85).' });
    expect(fall.changePercent).toBeCloseTo(-32);
    expect(rise).toMatchObject({ status: 'ok', message: 'Revenue fell 32% since the last run ($125 → $85); the alert is for a rise of 20% or more.' });
    expect(evaluateMonitors(monitors, catalog)[0]).toMatchObject({ status: 'no_baseline' });
  });

  it('never guesses: a missing or non-numeric figure is reported, not treated as zero', () => {
    const [missing, text] = evaluateMonitors([
      monitor('m', 'gone.revenue', { kind: 'threshold', op: '<', value: 1 }),
      monitor('t', 'by_region.leader', { kind: 'threshold', op: '<', value: 1 }),
    ], catalog);
    expect(missing).toMatchObject({ status: 'missing', message: 'gone.revenue did not return a value this run, so it could not be checked.' });
    expect(text.status).toBe('not_numeric');
  });
});
