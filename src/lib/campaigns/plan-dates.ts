import { accountTimezone, businessDateOf } from '@/config/business-config'

// ADR-062: the default start of a new plan: tomorrow in the account timezone (a plan never starts in
// the past, and a same-day start would leave no time to review and approve it).
export function firstPlannableDate(timeZone: string = accountTimezone(), now: number = Date.now()): string {
  return businessDateOf(new Date(now + 86_400_000), timeZone)
}
