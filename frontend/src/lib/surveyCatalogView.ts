export type SurveyCatalogView = 'cards' | 'list' | 'compact';

export function parseSurveyCatalogView(value: string | null): SurveyCatalogView {
  return value === 'list' || value === 'compact' || value === 'cards' ? value : 'cards';
}

export function resolveSurveyCatalogView(preferred: SurveyCatalogView, availableWidth: number): SurveyCatalogView {
  return availableWidth > 0 && availableWidth < 720 ? 'cards' : preferred;
}
