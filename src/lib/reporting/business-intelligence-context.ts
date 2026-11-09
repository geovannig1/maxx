import { etDateOf } from '@/lib/utils/date-utils'
import { previousReportingRange } from './range'
import type { ReportingContext } from './contracts'

/** A labeled reporting horizon, independent of the selected booking-created window. */
export function upcomingBusinessContext(context: ReportingContext, observedAt: string): ReportingContext {
  const date = etDateOf(observedAt)
  if (!date) throw new Error('business_observation_time_invalid')
  const day = Date.parse(`${date}T00:00:00Z`)
  const range = {
    from: new Date(day + 86_400_000).toISOString().slice(0, 10),
    to: new Date(day + 28 * 86_400_000).toISOString().slice(0, 10),
  }
  return { ...context, range, comparison: previousReportingRange(range), asOf: observedAt }
}
