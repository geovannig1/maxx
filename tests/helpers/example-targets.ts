import { afterEach, beforeEach } from 'vitest'
import { applyTargetOverrides, type TargetOverrides } from '@/lib/targets/target-ranges'
import { EXAMPLE_OWNER_TARGETS } from './example-owner-targets'

export { EXAMPLE_OWNER_TARGETS }

/** Merge extra overrides over the example owner targets (per metric, field by field). */
export function withExampleTargets(extra: TargetOverrides = {}): TargetOverrides {
  const merged: TargetOverrides = { ...EXAMPLE_OWNER_TARGETS }
  for (const [metric, fields] of Object.entries(extra) as [keyof TargetOverrides, TargetOverrides[keyof TargetOverrides]][]) {
    merged[metric] = { ...(merged[metric] ?? {}), ...fields }
  }
  return merged
}

/** Apply the example owner targets around every test of the calling suite, then clear them. */
export function applyExampleOwnerTargetsPerTest(): void {
  beforeEach(() => applyTargetOverrides(EXAMPLE_OWNER_TARGETS))
  afterEach(() => applyTargetOverrides(null))
}
