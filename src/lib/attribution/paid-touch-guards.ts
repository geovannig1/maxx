import type { SupabaseClient } from '@supabase/supabase-js'

// Abuse bounds for the public paid-touch endpoint. Client addresses: src/lib/security/client-address.ts.

type Env = Record<string, string | undefined>

const DEFAULT_GLOBAL_CAPTURES_PER_HOUR = 2_000
const DEFAULT_GLOBAL_ACKS_PER_HOUR = 4_000
// Captures naming an ad that has not been synced yet (a new launch, or a forged id). Kept, not refused,
// so a new ad's first landings are not lost; a separate smaller bucket bounds forged ids.
const DEFAULT_UNKNOWN_AD_CAPTURES_PER_HOUR = 200

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim())
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Site-wide hourly ceilings; PAID_TOUCH_GLOBAL_CAPTURES_PER_HOUR / _ACKS_PER_HOUR /
 * PAID_TOUCH_UNKNOWN_AD_CAPTURES_PER_HOUR override them.
 */
export function paidTouchGlobalLimits(
  env: Env = process.env,
): { captures: number; acks: number; unknownAdCaptures: number } {
  return {
    captures: positiveInteger(env.PAID_TOUCH_GLOBAL_CAPTURES_PER_HOUR, DEFAULT_GLOBAL_CAPTURES_PER_HOUR),
    acks: positiveInteger(env.PAID_TOUCH_GLOBAL_ACKS_PER_HOUR, DEFAULT_GLOBAL_ACKS_PER_HOUR),
    unknownAdCaptures: positiveInteger(
      env.PAID_TOUCH_UNKNOWN_AD_CAPTURES_PER_HOUR, DEFAULT_UNKNOWN_AD_CAPTURES_PER_HOUR,
    ),
  }
}

/** true when `adId` is an ad the account has synced. A read failure throws (the caller fails closed). */
export async function isKnownAccountAd(db: SupabaseClient, adAccountId: string, adId: string): Promise<boolean> {
  const { data, error } = await db.from('ads').select('id').eq('ad_account_id', adAccountId).eq('ad_id', adId).limit(1).maybeSingle()
  if (error) throw new Error(`paid-touch known-ad lookup failed: ${error.message}`)
  return data != null
}
