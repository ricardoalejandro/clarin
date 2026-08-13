import type { PipelineStage, PipelineStageType } from '@/types/contact'
import { CRM_PIPELINE_UNASSIGNED_STAGE_ID } from './crmPipelineDrag'

export type LeadStageSelectionMode = 'direct' | 'won' | 'lost' | 'reopen'

export function leadStageSelectionMode(currentStatus: string, target: Pick<PipelineStage, 'stage_type'>): LeadStageSelectionMode {
  const targetType = target.stage_type as PipelineStageType | undefined
  if (targetType === 'won' || targetType === 'lost') return targetType
  if (currentStatus === 'won' || currentStatus === 'lost') return 'reopen'
  return 'direct'
}

export function leadStageTargetId(target: Pick<PipelineStage, 'id'>): string | null {
  return target.id === CRM_PIPELINE_UNASSIGNED_STAGE_ID ? null : target.id
}
