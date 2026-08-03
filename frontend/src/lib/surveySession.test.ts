import { describe, expect, it } from 'vitest';
import { buildSurveySessionEvent, surveySessionRequestHeaders, surveySessionStorageKey } from './surveySession';

describe('survey session telemetry helpers', () => {
  it('keeps public and recipient sessions independent', () => {
    expect(surveySessionStorageKey('seguimiento', '')).toContain(':public');
    expect(surveySessionStorageKey('seguimiento', 'recipient-a')).not.toBe(surveySessionStorageKey('seguimiento', 'recipient-b'));
  });

  it('adds question identity only to question events', () => {
    expect(buildSurveySessionEvent('respondent', '', 'opened')).not.toHaveProperty('question_id');
    expect(buildSurveySessionEvent('respondent', 'recipient', 'answered', 'question')).toMatchObject({ phase: 'answered', question_id: 'question' });
  });

  it('sends the stable respondent token while the opening document is loaded', () => {
    expect(surveySessionRequestHeaders('respondent-1')).toEqual({ 'X-Survey-Session-Token': 'respondent-1' });
  });
});
