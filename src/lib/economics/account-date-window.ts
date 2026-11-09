import { accountTimezone } from '@/config/business-config'

const ACCOUNT_TIME_ZONE = accountTimezone()
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

function dateParts(value: string): { year: number; month: number; day: number } {
  if (!DATE.test(value)) throw new Error(`Invalid account date: ${value}`)
  const [year, month, day] = value.split('-').map(Number)
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid account date: ${value}`)
  }
  return { year, month, day }
}

function localParts(instant: Date): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ACCOUNT_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return {
    year: Number(values.year), month: Number(values.month),
    day: Number(values.day), hour: Number(values.hour),
  }
}

export function accountDateStartInstant(value: string): string {
  const target = dateParts(value)
  const targetAsUtc = Date.UTC(target.year, target.month - 1, target.day)
  let candidate = targetAsUtc
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = localParts(new Date(candidate))
    const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour)
    const correction = targetAsUtc - observedAsUtc
    if (correction === 0) break
    candidate += correction
  }
  const resolved = localParts(new Date(candidate))
  if (resolved.year !== target.year || resolved.month !== target.month
      || resolved.day !== target.day || resolved.hour !== 0) {
    throw new Error(`Could not resolve account-date midnight: ${value}`)
  }
  return new Date(candidate).toISOString()
}

function addDays(value: string, days: number): string {
  const { year, month, day } = dateParts(value)
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10)
}

export function inclusiveAccountDates(start: string, end: string): string[] {
  const startMs = new Date(`${start}T00:00:00.000Z`).getTime()
  const endMs = new Date(`${end}T00:00:00.000Z`).getTime()
  dateParts(start); dateParts(end)
  if (startMs > endMs) throw new Error('Account-date window start follows end.')
  const dayCount = Math.round((endMs - startMs) / DAY_MS) + 1
  if (dayCount > 366) throw new Error('Account-date window exceeds the audited 366-day bound.')
  return Array.from({ length: dayCount }, (_, index) => addDays(start, index))
}

export function accountDateRangeToHalfOpenInstants(window: {
  start: string
  end: string
}): { start: string; end: string } {
  inclusiveAccountDates(window.start, window.end)
  return {
    start: accountDateStartInstant(window.start),
    end: accountDateStartInstant(addDays(window.end, 1)),
  }
}
