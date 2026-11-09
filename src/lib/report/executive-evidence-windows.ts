import type { ExecutiveEvidenceWindowsV1, ExecutiveSetupChangeProjectionV1 } from './executive-evidence.types'

const DAY_MS = 86_400_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isExecutiveEvidenceDateV1(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function shiftDate(value: string, days: number): string {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return new Date(parsed.valueOf() + days * DAY_MS).toISOString().slice(0, 10)
}

export function dateInTimezone(timestamp: string, timezone: string): string | null {
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) return null
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(parsed))
    const part = (type: string) => parts.find((item) => item.type === type)?.value
    const date = `${part('year')}-${part('month')}-${part('day')}`
    return isExecutiveEvidenceDateV1(date) ? date : null
  } catch {
    return null
  }
}

function baseWindows(lastCompleteDate: string): ExecutiveEvidenceWindowsV1 {
  const available = (startDate: string, endDate: string): ExecutiveEvidenceWindowsV1['lastDay'] => ({
    startDate,
    endDate,
    availability: 'available',
    blockerCodes: [],
  })
  return {
    lastDay: available(lastCompleteDate, lastCompleteDate),
    trailing7: available(shiftDate(lastCompleteDate, -6), lastCompleteDate),
    prior7: available(shiftDate(lastCompleteDate, -13), shiftDate(lastCompleteDate, -7)),
    monthToDate: available(`${lastCompleteDate.slice(0, 7)}-01`, lastCompleteDate),
    postChange: {
      startDate: null,
      endDate: lastCompleteDate,
      availability: 'unavailable',
      changeId: null,
      blockerCodes: ['material_change_not_available'],
    },
  }
}

export function buildExecutiveEvidenceWindowsV1(
  lastCompleteDate: string,
  timezone: string,
  setup: ExecutiveSetupChangeProjectionV1 | null,
): ExecutiveEvidenceWindowsV1 {
  const windows = baseWindows(lastCompleteDate)
  const change = setup?.latest_material_change
  if (!change) return windows
  if (change.status === 'unknown') {
    return {
      ...windows,
      postChange: {
        ...windows.postChange,
        blockerCodes: ['material_change_reason_unknown'],
      },
    }
  }
  if (change.status === 'none_observed') return windows
  if (!change.reason.trim()) {
    return {
      ...windows,
      postChange: {
        ...windows.postChange,
        blockerCodes: ['material_change_reason_unknown'],
      },
    }
  }
  const effectiveDate = dateInTimezone(change.occurredAt, timezone)
  if (!effectiveDate || effectiveDate > lastCompleteDate) {
    return {
      ...windows,
      postChange: {
        ...windows.postChange,
        blockerCodes: ['material_change_date_invalid'],
      },
    }
  }
  if (!UUID_PATTERN.test(change.materialChangeId)) {
    return {
      ...windows,
      postChange: {
        ...windows.postChange,
        blockerCodes: ['material_change_id_unavailable'],
      },
    }
  }
  return {
    ...windows,
    postChange: {
      startDate: effectiveDate,
      endDate: lastCompleteDate,
      availability: 'available',
      changeId: change.materialChangeId,
      blockerCodes: [],
    },
  }
}
