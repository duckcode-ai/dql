import { describe, expect, it } from 'vitest';
import { alertCondition, alertFigures, describeCondition, describeCron, describeDelivery } from './page-alerts';

describe('page alert wording (RFC 0008 step 10)', () => {
  it('turns a rule into a monitor condition and back into words', () => {
    expect(alertCondition('below', 100)).toEqual({ kind: 'threshold', op: '<', value: 100 });
    expect(alertCondition('changes', 20)).toEqual({ kind: 'change', direction: 'either', percent: 20 });
    expect(describeCondition(alertCondition('below', 100), '$85')).toBe('falls below $100');
    expect(describeCondition(alertCondition('above', 45), '52.4%')).toBe('rises above 45%');
    expect(describeCondition(alertCondition('above', 12000), '9,000')).toBe('rises above 12,000');
    expect(describeCondition(alertCondition('falls', 20))).toBe('falls by 20% since the last run');
  });

  it('describes schedules and delivery people can read', () => {
    expect(describeCron('0 8 * * *')).toBe('daily at 08:00');
    expect(describeCron('30 7 * * 1')).toBe('Mondays at 07:30');
    expect(describeCron('0 9 * * 1-5')).toBe('weekdays at 09:00');
    expect(describeCron('0 * * * *')).toBe('every hour');
    expect(describeCron('*/5 * * * *')).toBe('on cron */5 * * * *');
    expect(describeDelivery([])).toBe('recorded in the run log only');
    expect(describeDelivery([{ kind: 'webhook', url: 'https://hooks.example.test/a?token=secret' }, { kind: 'slack', channel: '#sales' }])).toBe('webhook hooks.example.test, Slack #sales');
  });

  it('offers numeric figures, single values first, and leaves out derived ones', () => {
    const figures = alertFigures({
      'r.revenue[US]': { key: 'r.revenue[US]', tileId: 'r', label: 'Revenue by region — revenue for US', kind: 'number', value: 85, display: '$85' },
      'k.revenue': { key: 'k.revenue', tileId: 'k', label: 'Revenue — revenue', kind: 'number', value: 145, display: '$145' },
      'r.leader_value': { key: 'r.leader_value', tileId: 'r', label: 'leader', kind: 'number', value: 85, display: '$85' },
      'r.leader': { key: 'r.leader', tileId: 'r', label: 'leader', kind: 'text', value: 'US', display: 'US' },
      'w.change': { key: 'w.change', tileId: 'w', label: 'change', kind: 'number', value: 25, display: '+$25' },
    });
    expect(figures.map((figure) => figure.key)).toEqual(['k.revenue', 'r.revenue[US]']);
  });
});
