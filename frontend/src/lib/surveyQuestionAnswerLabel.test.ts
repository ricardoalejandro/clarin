import { describe, expect, it } from 'vitest';
import { surveyNonChartAnswerLabel } from './surveyQuestionAnswerLabel';

describe('survey non-chart answer labels', () => {
  it.each([
    ['date', 2, '2 respuestas con fecha'],
    ['email', 1, '1 dirección de correo'],
    ['phone', 2, '2 números de teléfono'],
    ['file_upload', 1, '1 archivo adjunto'],
  ])('keeps %s results semantically distinct from free text', (type, count, expected) => {
    expect(surveyNonChartAnswerLabel(type, count)).toBe(expected);
    expect(surveyNonChartAnswerLabel(type, count)).not.toContain('texto libre');
  });
});
