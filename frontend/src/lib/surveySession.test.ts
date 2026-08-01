import { describe, expect, it } from 'vitest';
import { buildSurveySessionEvent, surveySessionStorageKey } from './surveySession';

describe('survey session telemetry helpers', () => {
  it('keeps public and recipient sessions independent', () => {
    expect(surveySessionStorageKey('seguimiento', '')).toContain(':public');
    expect(surveySessionStorageKey('seguimiento', 'recipient-a')).not.toBe(surveySessionStorageKey('seguimiento', 'recipient-b'));
  });

  it('adds question identity only to question events', () => {
    expect(buildSurveySessionEvent('respondent', '', 'opened')).not.toHaveProperty('question_id');
    expect(buildSurveySessionEvent('respondent', 'recipient', 'answered', 'question')).toMatchObject({ phase: 'answered', question_id: 'question' });
  });
});

