import { resolveDatePreset } from '@/lib/date-range'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

export interface ClosedDateRange {
  start: string
  end: string
  requested_start_date: string | null
  requested_end_date: string | null
  effective_start_date: string
  effective_end_date: string
  clamped_to_closed_day: boolean
  last_closed_date: string
}

function assertDateOnly(value: string, label: string): void {
  if (!ISO_DATE.test(value)) throw new Error(`${label} must use YYYY-MM-DD`)
  const [year, month, day] = value.split('-').map(Number)
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a real calendar date`)
  }
}

function addDays(value: string, days: number): string {
  assertDateOnly(value, 'date')
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10)
}

export function resolveClosedDateRange(
  startDate?: string,
  endDate?: string,
  now: Date = new Date(),
): ClosedDateRange {
  const lastClosedDate = resolveDatePreset('1d', now).to
  const requestedStart = startDate ?? null
  const requestedEnd = endDate ?? null
  if (requestedStart) assertDateOnly(requestedStart, 'start_date')
  if (requestedEnd) assertDateOnly(requestedEnd, 'end_date')

  let end = requestedEnd ?? lastClosedDate
  let start = requestedStart ?? end
  let clamped = false

  if (end > lastClosedDate) {
    end = lastClosedDate
    clamped = true
  }
  if (start > lastClosedDate) {
    start = lastClosedDate
    clamped = true
  }

  const earliestAllowed = addDays(lastClosedDate, -89)
  if (start < earliestAllowed) throw new Error('start_date cannot be older than 90 days')
  if (start > end) throw new Error('start_date must be before or equal to end_date')

  return {
    start,
    end,
    requested_start_date: requestedStart,
    requested_end_date: requestedEnd,
    effective_start_date: start,
    effective_end_date: end,
    clamped_to_closed_day: clamped,
    last_closed_date: lastClosedDate,
  }
}
