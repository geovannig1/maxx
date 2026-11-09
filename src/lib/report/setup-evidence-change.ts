import type { LatestSetupMaterialChangeV1 } from '@/lib/setup-history'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function governedMaterialChange(
  change: LatestSetupMaterialChangeV1,
): LatestSetupMaterialChangeV1 {
  if (change.status !== 'known') return change
  const sourceMatches =
    (change.source === 'meta_observation' && change.governanceBasis === 'matched_approved_plan')
    || (change.source === 'ad_setup_decisions'
      && change.governanceBasis === 'confirmed_executed_decision')
  if (!sourceMatches) {
    return {
      status: 'unknown',
      occurredAt: change.occurredAt,
      reasonCode: 'setup_change_reason_not_matched',
    }
  }
  if (!UUID_PATTERN.test(change.materialChangeId)
    || change.materialChangeIds.length === 0
    || change.materialChangeIds.some((id) => !UUID_PATTERN.test(id))
    || !Number.isFinite(Date.parse(change.occurredAt))
    || !change.reason.trim()) {
    return {
      status: 'unknown',
      occurredAt: change.occurredAt,
      reasonCode: 'setup_change_evidence_invalid',
    }
  }
  return change
}
