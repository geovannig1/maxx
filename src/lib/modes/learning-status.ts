import { getAdminClient } from '@/lib/supabase/admin'
import { deriveExitedLearning } from '@/lib/recommendations/trend'

export type ActiveAdsetLearningRead =
  | { status: 'available'; exited: boolean }
  | { status: 'unavailable'; exited: false }

/** Strict read for decision surfaces that must distinguish a measured `false` from a failed query. */
export async function readActiveAdsetExitedLearning(adAccountDbId: string): Promise<ActiveAdsetLearningRead> {
  try {
    const db = getAdminClient()
    const { data, error } = await db
      .from('adsets')
      .select('learning_stage, effective_status')
      .eq('ad_account_id', adAccountDbId)
      .eq('effective_status', 'ACTIVE')
    if (error) return { status: 'unavailable', exited: false }
    return {
      status: 'available',
      exited: (data ?? []).some((a) => deriveExitedLearning((a as { learning_stage: string | null }).learning_stage) === true),
    }
  } catch {
    return { status: 'unavailable', exited: false }
  }
}

// Conservative convenience for display/report callers: unknown stays false, so no surface can
// over-claim that learning completed. Decision entry points should use the strict read above.
export async function anyActiveAdsetExitedLearning(adAccountDbId: string): Promise<boolean> {
  return (await readActiveAdsetExitedLearning(adAccountDbId)).exited
}
