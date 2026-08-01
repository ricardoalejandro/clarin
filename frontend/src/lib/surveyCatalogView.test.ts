import { describe, expect, it } from 'vitest';
import { parseSurveyCatalogView, resolveSurveyCatalogView } from './surveyCatalogView';

describe('survey catalog view', () => {
  it('restores only supported persisted values', () => {
    expect(parseSurveyCatalogView('compact')).toBe('compact');
    expect(parseSurveyCatalogView('table')).toBe('cards');
    expect(parseSurveyCatalogView(null)).toBe('cards');
  });

  it('uses cards when the measured content width cannot sustain dense views', () => {
    expect(resolveSurveyCatalogView('list', 680)).toBe('cards');
    expect(resolveSurveyCatalogView('compact', 1046)).toBe('compact');
  });
});
