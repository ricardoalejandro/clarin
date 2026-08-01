export type SurveySessionPhase = 'opened' | 'started' | 'reached' | 'answered';

export function surveySessionStorageKey(slug: string, recipientToken: string): string {
  return `clarin:survey-session:${slug}:${recipientToken || 'public'}`;
}

export function buildSurveySessionEvent(respondentToken: string, recipientToken: string, phase: SurveySessionPhase, questionId?: string) {
  return {
    respondent_token: respondentToken,
    recipient_token: recipientToken,
    source: 'direct',
    phase,
    ...(questionId ? { question_id: questionId } : {}),
  };
}

