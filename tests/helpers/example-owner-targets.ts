import type { TargetOverrides } from '@/lib/targets/target-ranges'

// Since the v1 release the money metrics (CPA, CPL, CPC, CPM) have NO built-in target: each is judged only once
// the owner sets one. These are the example studio's owner-set targets (invented example values), for
// suites that test behaviour WITH a target. Applying them is the suite's stated
// precondition, not a default. Vitest-free, so tsx integration proofs can use it too.
export const EXAMPLE_OWNER_TARGETS: TargetOverrides = {
  cpa: { excellent: 44, healthy: 64, watch: 98 },
  cpl: { excellent: 23, healthy: 37, watch: 53 },
  cpc: { excellent: 1, healthy: 2.5, watch: 5 },
  cpm: { excellent: 15, healthy: 30, watch: 50 },
}
