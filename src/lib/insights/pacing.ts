// Per-entity budget pacing: how much of an entity's own budget it actually spent over the window.
// Expected spend = daily_budget × days it ACTUALLY DELIVERED (not days-in-range). Pacing over days the
// entity didn't exist/deliver understates it — an ad set launched Jul 6 and viewed on Jul 12 with an
// MTD (Jul 1) range would read "under-pacing" purely because Jul 1–5 count zero (the phantom "63% Under"
// that also fed a false "room to scale" opportunity signal). pace% = actual ÷ expected.
//   under  (<80%)   — under-delivering; the budget isn't being spent (delivery/bid/audience issue)
//   on     (80–110%)— spending roughly to budget
//   over   (>110%)  — outspending the implied daily cap (common with CBO / accelerated delivery)
//   none            — no usable budget on this entity (budget lives at another level)

export type PacingStatus = 'under' | 'on' | 'over' | 'none'

export interface PacingResult {
  status: PacingStatus
  pct: number // percent of expected spend (0 when none)
  expected: number // daily_budget × effective days
}

/** `daysDelivering` (days with spend > 0) is preferred as the denominator; `days` (days-in-range) is the
 *  fallback when the caller can't supply it. */
export function computePacing(
  spend: number,
  dailyBudget: number | null | undefined,
  days: number,
  daysDelivering?: number | null,
): PacingResult {
  const effectiveDays = daysDelivering != null && daysDelivering > 0 ? daysDelivering : days
  if (!dailyBudget || dailyBudget <= 0 || effectiveDays <= 0) return { status: 'none', pct: 0, expected: 0 }
  // Zero spend has no pace to judge — a PAUSED row rendered "0% Under" as if it had an active
  // under-delivery problem. Silent-but-active entities are the delivery diagnostics' job, not a pace pill.
  if (spend <= 0) return { status: 'none', pct: 0, expected: dailyBudget * effectiveDays }
  const expected = dailyBudget * effectiveDays
  const pct = expected > 0 ? (spend / expected) * 100 : 0
  // Epsilon-tolerant boundaries so exact 80% / 110% land 'on' despite float artifacts (e.g. 770/700).
  const EPS = 1e-9
  const status: PacingStatus = pct < 80 - EPS ? 'under' : pct <= 110 + EPS ? 'on' : 'over'
  return { status, pct, expected }
}
