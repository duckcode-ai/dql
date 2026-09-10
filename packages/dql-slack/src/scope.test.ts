import { describe, expect, it } from 'vitest';
import { parseSlackAskScope, slackDomainDefaults, slackThreadId } from './scope.js';

describe('a Slack question names its scope, or its channel does', () => {
  it('reads "in <domain>:" and --domain/--purpose flags out of the text', () => {
    expect(parseSlackAskScope('in growth: how many qualified leads this month')).toEqual({ question: 'how many qualified leads this month', domain: 'growth' });
    expect(parseSlackAskScope('how many leads --domain growth --purpose growth_attribution')).toEqual({ question: 'how many leads', domain: 'growth', purpose: 'growth_attribution' });
    expect(parseSlackAskScope('--domain=commerce revenue by month')).toEqual({ question: 'revenue by month', domain: 'commerce' });
  });
  it('a channel default applies only when the question named none, and the thread is the channel', () => {
    const defaults = slackDomainDefaults('{"C123": "growth", "C9": 7}');
    expect(defaults).toEqual({ C123: 'growth' });
    expect(parseSlackAskScope('how many leads', { channelId: 'C123', defaults })).toEqual({ question: 'how many leads', domain: 'growth' });
    expect(parseSlackAskScope('in commerce: revenue', { channelId: 'C123', defaults })).toEqual({ question: 'revenue', domain: 'commerce' });
    expect(parseSlackAskScope('revenue', { channelId: 'C777', defaults })).toEqual({ question: 'revenue' });
    expect(slackDomainDefaults('not json')).toEqual({});
    expect(slackThreadId('C123')).toBe('slack:C123');
    expect(slackThreadId(undefined)).toBeUndefined();
  });
});
