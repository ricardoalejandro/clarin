import type { SurveyInstanceSummary, SurveyTemplate } from '@/types/survey-template';

export function replaceSurveyInstance(instances: SurveyInstanceSummary[], updated: SurveyInstanceSummary): SurveyInstanceSummary[] {
  return instances.map(instance => instance.id === updated.id ? updated : instance);
}

export function removeSurveyInstance(instances: SurveyInstanceSummary[], id: string): SurveyInstanceSummary[] {
  return instances.filter(instance => instance.id !== id);
}

export function partitionSurveyInstances(instances: SurveyInstanceSummary[]) {
  return {
    active: instances.filter(instance => !instance.archived_at),
    archived: instances.filter(instance => Boolean(instance.archived_at)),
  };
}

export function reconcileTemplateInstanceCounts(template: SurveyTemplate, previous: SurveyInstanceSummary, next: SurveyInstanceSummary | null): SurveyTemplate {
  let activeDelta = previous.archived_at ? 0 : -1;
  let archivedDelta = previous.archived_at ? -1 : 0;
  if (next) {
    activeDelta += next.archived_at ? 0 : 1;
    archivedDelta += next.archived_at ? 1 : 0;
  }
  return {
    ...template,
    instance_count: Math.max(0, template.instance_count + activeDelta),
    archived_instance_count: Math.max(0, (template.archived_instance_count || 0) + archivedDelta),
  };
}
