import { describe, expect, it } from 'vitest'
import type { PipelineStage } from '@/types/contact'
import { CRM_PIPELINE_UNASSIGNED_STAGE_ID } from './crmPipelineDrag'
import { leadStageSelectionMode, leadStageTargetId } from './leadStageSelection'

const stage = (id: string, stageType: PipelineStage['stage_type'] = 'active') => ({ id, stage_type: stageType })

describe('Lead detail stage intent', () => {
  it('reuses terminal confirmations and the reopen confirmation', () => {
    expect(leadStageSelectionMode('open', stage('won', 'won'))).toBe('won')
    expect(leadStageSelectionMode('open', stage('lost', 'lost'))).toBe('lost')
    expect(leadStageSelectionMode('won', stage('active'))).toBe('reopen')
    expect(leadStageSelectionMode('lost', stage(CRM_PIPELINE_UNASSIGNED_STAGE_ID))).toBe('reopen')
    expect(leadStageSelectionMode('open', stage('active'))).toBe('direct')
  })

  it('serializes Sin etapa as a real nullable stage', () => {
    expect(leadStageTargetId(stage(CRM_PIPELINE_UNASSIGNED_STAGE_ID))).toBeNull()
    expect(leadStageTargetId(stage('stage-1'))).toBe('stage-1')
  })
})
