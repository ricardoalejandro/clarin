import { describe, expect, it } from 'vitest';
import { partitionSurveyInstances, reconcileTemplateInstanceCounts } from './surveyInstanceLifecycle';
import type { SurveyInstanceSummary, SurveyTemplate } from '@/types/survey-template';

const instance = { id: 'i', archived_at: undefined } as SurveyInstanceSummary;
const template = { instance_count: 3, archived_instance_count: 1 } as SurveyTemplate;

describe('survey application lifecycle reconciliation', () => {
  it('moves an application between active and archived counters exactly once', () => {
    const archived = { ...instance, archived_at: '2026-08-01T00:00:00Z' };
    expect(reconcileTemplateInstanceCounts(template, instance, archived)).toMatchObject({ instance_count: 2, archived_instance_count: 2 });
    expect(reconcileTemplateInstanceCounts({ ...template, instance_count: 2, archived_instance_count: 2 }, archived, { ...instance, status: 'closed' })).toMatchObject({ instance_count: 3, archived_instance_count: 1 });
  });

  it('partitions without losing stable application identities', () => {
    const archived = { ...instance, id: 'archived', archived_at: '2026-08-01T00:00:00Z' };
    const result = partitionSurveyInstances([instance, archived]);
    expect(result.active.map(item => item.id)).toEqual(['i']);
    expect(result.archived.map(item => item.id)).toEqual(['archived']);
  });
});
