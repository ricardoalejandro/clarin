import { describe, expect, it } from 'vitest';
import { formatObservedRate, formatSurveyDuration } from './surveyAnalytics';

describe('survey analytics presentation', () => {
  it('keeps unavailable rates explicit instead of displaying a fabricated zero', () => {
    expect(formatObservedRate(undefined)).toBe('Sin base suficiente');
    expect(formatObservedRate(0)).toBe('0.0%');
  });

  it('formats observed durations without losing minute boundaries', () => {
    expect(formatSurveyDuration(59.6)).toBe('60s');
    expect(formatSurveyDuration(125)).toBe('2m 5s');
  });
});

