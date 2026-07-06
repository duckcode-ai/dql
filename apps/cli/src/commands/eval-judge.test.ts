import { describe, expect, it } from 'vitest';
import { judgeAnswer, parseJudgeVerdict, summarizeJudgeVerdicts } from './eval-judge.js';

describe('eval judge (R3.2)', () => {
  it('parses a well-formed verdict and clamps the score', () => {
    expect(parseJudgeVerdict('{"score": 0.9, "pass": true, "rationale": "correct join"}'))
      .toEqual({ score: 0.9, pass: true, rationale: 'correct join' });
    expect(parseJudgeVerdict('```json\n{"score": 1.4, "pass": true}\n```')?.score).toBe(1);
  });

  it('returns undefined for unparseable / score-less output', () => {
    expect(parseJudgeVerdict('the answer looks fine')).toBeUndefined();
    expect(parseJudgeVerdict('{"pass": true}')).toBeUndefined();
  });

  it('derives pass from the score when the model omits it', () => {
    expect(parseJudgeVerdict('{"score": 0.8, "rationale": "ok"}')?.pass).toBe(true);
    expect(parseJudgeVerdict('{"score": 0.5, "rationale": "weak"}')?.pass).toBe(false);
  });

  it('calls the injected completion and returns the verdict', async () => {
    const verdict = await judgeAnswer(
      { question: 'total revenue', sql: 'SELECT SUM(amount) FROM orders', trustLabel: 'reviewed' },
      async () => '{"score": 0.95, "pass": true, "rationale": "correct aggregate"}',
    );
    expect(verdict).toMatchObject({ score: 0.95, pass: true });
  });

  it('returns undefined when the completion throws (offline-safe)', async () => {
    const verdict = await judgeAnswer({ question: 'q' }, async () => { throw new Error('no key'); });
    expect(verdict).toBeUndefined();
  });

  it('summarizes verdicts into mean score and pass rate', () => {
    expect(summarizeJudgeVerdicts([
      { score: 1, pass: true, rationale: '' },
      { score: 0.5, pass: false, rationale: '' },
      undefined,
    ])).toEqual({ judged: 2, meanScore: 0.75, passRate: 0.5 });
    expect(summarizeJudgeVerdicts([undefined])).toEqual({ judged: 0, meanScore: null, passRate: null });
  });
});
