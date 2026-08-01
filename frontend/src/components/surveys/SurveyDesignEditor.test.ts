import { describe, expect, it } from 'vitest';
import { automaticButtonForeground, contrastRatio } from './SurveyDesignEditor';

describe('survey design contrast', () => {
  it('chooses the strongest readable foreground for configured buttons', () => {
    expect(automaticButtonForeground('#047857')).toBe('#FFFFFF');
    expect(automaticButtonForeground('#FDE68A')).toBe('#0F172A');
  });

  it('reports WCAG-style contrast ratios', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 1);
    expect(contrastRatio('invalid', '#000000')).toBe(0);
  });
});
