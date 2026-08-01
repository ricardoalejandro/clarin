import { describe, expect, it } from 'vitest';
import { buildDuplicateTemplateName } from './duplicateSurveyTemplate';

describe('buildDuplicateTemplateName', () => {
  it('normalizes the source and respects the backend limit', () => {
    expect(buildDuplicateTemplateName('  Seguimiento  ')).toBe('Copia de Seguimiento');
    expect(buildDuplicateTemplateName('x'.repeat(300))).toHaveLength(180);
  });

  it('keeps a useful fallback for blank names', () => {
    expect(buildDuplicateTemplateName('   ')).toBe('Copia de Plantilla');
  });
});

