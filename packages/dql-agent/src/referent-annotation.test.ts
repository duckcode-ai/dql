import { describe, expect, it } from 'vitest';
import { splitAnalyticalTasks } from './analytical-orchestration.js';

describe('a referent annotation is context, not a task', () => {
  it('does not turn the composer\'s Regarding line into a second task', () => {
    // Verbatim from a live run. The composer appends the quoted row when the
    // reader follows up on something they clicked; splitting on the `?` made
    // it a task titled `Regarding: "Mr. Matthew Meyer`, which then answered by
    // computing an unrelated maximum over the rows still on screen.
    const tasks = splitAnalyticalTasks('why he is top most in the list?\n\nRegarding: "Mr. Matthew Meyer"');
    expect(tasks).toEqual(['why he is top most in the list']);
  });

  it('handles curly quotes the same way', () => {
    expect(splitAnalyticalTasks('which region?\n\nRegarding: “Wesley Jenkins”'))
      .toEqual(['which region']);
  });

  it('keeps the annotation when it is the ONLY thing said', () => {
    // Dropping every clause would leave no task at all.
    expect(splitAnalyticalTasks('Regarding: "Mr. Matthew Meyer"').length).toBe(1);
  });

  it('still splits a genuinely compound question', () => {
    expect(splitAnalyticalTasks('who are the top customers? what is total revenue?'))
      .toEqual(['who are the top customers', 'what is total revenue']);
  });

  it('leaves an ordinary question containing a colon alone', () => {
    const tasks = splitAnalyticalTasks('show revenue by segment: enterprise and mid-market');
    expect(tasks[0]).toContain('revenue by segment');
  });
});
