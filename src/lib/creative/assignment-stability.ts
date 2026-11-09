export type CreativeAssignmentBlocker =
  | 'assignment_history_missing'
  | 'assignment_identity_missing'
  | 'assignment_changed'
  | 'ad_mutation_ambiguous'
  | 'assignment_evidence_invalid'

export interface CreativeAssignmentObservation {
  id: string
  metaAdId: string
  metaCreativeId: string | null
  observedAt: string
  metaUpdatedTime: string | null
}

export type CreativeAssignmentResolution =
  | { state: 'observed_stable'; metaCreativeId: string; boundaryObservationIds: [string, string] }
  | { state: 'blocked'; blockerCode: CreativeAssignmentBlocker }

interface DateParts {
  year: number
  month: number
  day: number
}

interface ValidatedObservation {
  observation: CreativeAssignmentObservation
  observedAt: ParsedInstant
  metaUpdatedTime: ParsedInstant | null
}

interface ParsedInstant {
  epochMs: number
  subMillisecondNanoseconds: number
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/
const META_ID_PATTERN = /^\d{1,32}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const blocked = (blockerCode: CreativeAssignmentBlocker): CreativeAssignmentResolution => ({
  state: 'blocked',
  blockerCode,
})

function isValidMetaId(value: unknown): value is string {
  return typeof value === 'string' && META_ID_PATTERN.test(value)
}

function isValidObservationId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function parseDateOnly(value: unknown): DateParts | null {
  if (typeof value !== 'string') return null
  const match = DATE_ONLY_PATTERN.exec(value)
  if (match === null) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null
  }
  return { year, month, day }
}

function nextDate(date: DateParts): DateParts {
  if (date.day < daysInMonth(date.year, date.month)) {
    return { ...date, day: date.day + 1 }
  }
  if (date.month < 12) return { year: date.year, month: date.month + 1, day: 1 }
  return { year: date.year + 1, month: 1, day: 1 }
}

function parseIsoInstant(value: unknown): ParsedInstant | null {
  if (typeof value !== 'string') return null
  const match = ISO_INSTANT_PATTERN.exec(value)
  if (match === null) return null

  const date = parseDateOnly(`${match[1]}-${match[2]}-${match[3]}`)
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (date === null || hour > 23 || minute > 59 || second > 59) return null

  const zone = match[8]
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3))
    const offsetMinute = Number(zone.slice(4, 6))
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null
  }

  const epochMs = Date.parse(value)
  if (!Number.isFinite(epochMs)) return null
  const nanoseconds = (match[7] ?? '').padEnd(9, '0')
  return {
    epochMs,
    subMillisecondNanoseconds: Number(nanoseconds.slice(3)),
  }
}

function compareInstants(left: ParsedInstant, right: ParsedInstant): number {
  return left.epochMs - right.epochMs || left.subMillisecondNanoseconds - right.subMillisecondNanoseconds
}

function compareInstantToMilliseconds(instant: ParsedInstant, milliseconds: number): number {
  return instant.epochMs - milliseconds || instant.subMillisecondNanoseconds
}

function instantKey(instant: ParsedInstant): string {
  return `${instant.epochMs}:${instant.subMillisecondNanoseconds}`
}

function utcEpoch(parts: DateParts, hour = 0, minute = 0, second = 0): number {
  const date = new Date(0)
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day)
  date.setUTCHours(hour, minute, second, 0)
  return date.getTime()
}

function localPartsAt(formatter: Intl.DateTimeFormat, instant: number): DateParts & {
  hour: number
  minute: number
  second: number
} {
  const values = new Map(
    formatter
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  )
  return {
    year: values.get('year') ?? Number.NaN,
    month: values.get('month') ?? Number.NaN,
    day: values.get('day') ?? Number.NaN,
    hour: values.get('hour') ?? Number.NaN,
    minute: values.get('minute') ?? Number.NaN,
    second: values.get('second') ?? Number.NaN,
  }
}

function localMidnightEpoch(date: DateParts, timezone: string): number | null {
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return null
  }

  const desiredUtc = utcEpoch(date)
  let candidate = desiredUtc
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const local = localPartsAt(formatter, candidate)
    if (Object.values(local).some((value) => !Number.isFinite(value))) return null
    const offset = utcEpoch(local, local.hour, local.minute, local.second) - candidate
    const nextCandidate = desiredUtc - offset
    if (nextCandidate === candidate) break
    candidate = nextCandidate
  }

  const local = localPartsAt(formatter, candidate)
  if (
    local.year !== date.year ||
    local.month !== date.month ||
    local.day !== date.day ||
    local.hour !== 0 ||
    local.minute !== 0 ||
    local.second !== 0
  ) {
    return null
  }
  return candidate
}

function validateObservations(
  observations: CreativeAssignmentObservation[],
  metaAdId: string,
): ValidatedObservation[] | null {
  if (!Array.isArray(observations)) return null

  const ids = new Set<string>()
  const observedInstants = new Set<string>()
  const validated: ValidatedObservation[] = []
  for (const observation of observations) {
    if (typeof observation !== 'object' || observation === null || Array.isArray(observation)) return null
    if (!isValidObservationId(observation.id) || ids.has(observation.id)) return null
    if (!isValidMetaId(observation.metaAdId) || observation.metaAdId !== metaAdId) return null
    if (observation.metaCreativeId !== null && !isValidMetaId(observation.metaCreativeId)) return null

    const observedAt = parseIsoInstant(observation.observedAt)
    if (observedAt === null || observedInstants.has(instantKey(observedAt))) return null

    const metaUpdatedTime = observation.metaUpdatedTime === null
      ? null
      : parseIsoInstant(observation.metaUpdatedTime)
    if (observation.metaUpdatedTime !== null && metaUpdatedTime === null) return null

    ids.add(observation.id)
    observedInstants.add(instantKey(observedAt))
    validated.push({ observation, observedAt, metaUpdatedTime })
  }
  return validated
}

export function resolveCreativeAssignment(input: {
  timezone: string
  metaAdId: string
  windowStart: string
  windowEnd: string
  observations: CreativeAssignmentObservation[]
}): CreativeAssignmentResolution {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof input.timezone !== 'string' ||
    input.timezone.length === 0 ||
    input.timezone !== input.timezone.trim() ||
    !isValidMetaId(input.metaAdId)
  ) {
    return blocked('assignment_evidence_invalid')
  }

  const startDate = parseDateOnly(input.windowStart)
  const endDate = parseDateOnly(input.windowEnd)
  if (startDate === null || endDate === null || input.windowStart > input.windowEnd) {
    return blocked('assignment_evidence_invalid')
  }

  const startMs = localMidnightEpoch(startDate, input.timezone)
  const exclusiveEndMs = localMidnightEpoch(nextDate(endDate), input.timezone)
  const validated = validateObservations(input.observations, input.metaAdId)
  if (startMs === null || exclusiveEndMs === null || validated === null) {
    return blocked('assignment_evidence_invalid')
  }

  const ordered = [...validated].sort((left, right) => compareInstants(left.observedAt, right.observedAt))
  let startBoundary: ValidatedObservation | undefined
  let endBoundary: ValidatedObservation | undefined
  for (const candidate of ordered) {
    if (compareInstantToMilliseconds(candidate.observedAt, startMs) <= 0) startBoundary = candidate
    if (endBoundary === undefined && compareInstantToMilliseconds(candidate.observedAt, exclusiveEndMs) >= 0) {
      endBoundary = candidate
    }
  }
  if (startBoundary === undefined || endBoundary === undefined) {
    return blocked('assignment_history_missing')
  }

  const evidence = ordered.filter(
    (candidate) =>
      compareInstants(candidate.observedAt, startBoundary.observedAt) >= 0 &&
      compareInstants(candidate.observedAt, endBoundary.observedAt) <= 0,
  )
  if (evidence.some(({ observation }) => observation.metaCreativeId === null)) {
    return blocked('assignment_identity_missing')
  }

  const metaCreativeId = evidence[0].observation.metaCreativeId as string
  if (evidence.some(({ observation }) => observation.metaCreativeId !== metaCreativeId)) {
    return blocked('assignment_changed')
  }
  if (evidence.some(({ metaUpdatedTime }) => metaUpdatedTime === null)) {
    return blocked('ad_mutation_ambiguous')
  }

  const metaUpdatedTime = evidence[0].metaUpdatedTime as ParsedInstant
  if (evidence.some((candidate) =>
    candidate.metaUpdatedTime === null || compareInstants(candidate.metaUpdatedTime, metaUpdatedTime) !== 0
  )) {
    return blocked('ad_mutation_ambiguous')
  }

  return {
    state: 'observed_stable',
    metaCreativeId,
    boundaryObservationIds: [startBoundary.observation.id, endBoundary.observation.id],
  }
}
