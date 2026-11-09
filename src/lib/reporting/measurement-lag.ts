import type { PaidTouchAdAssignment } from '@/lib/economics/observed-contribution'
import { accountTimezone } from '@/config/business-config'

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/
const DAY_NS = BigInt('86400000000000')
const ET_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: accountTimezone(), year: 'numeric', month: '2-digit', day: '2-digit',
})

export interface PaidTouchBookingLagSummary {
  sampleCount: number
  linkedCount: number
  medianDays: number | null
  p90Days: number | null
  longestDays: number | null
  blocker: string
}

type LagAssignment = PaidTouchAdAssignment & { outcomeCreatedAt?: unknown }

interface ParsedInstant {
  epochNs: bigint
  epochMs: number
}

function parseInstant(value: unknown): ParsedInstant | null {
  if (typeof value !== 'string') return null
  const match = ISO_INSTANT.exec(value)
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null
  const utcSecondMs = Date.UTC(year, month - 1, day, hour, minute, second, 0)
  if (!Number.isFinite(utcSecondMs)) return null
  const check = new Date(utcSecondMs)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
      || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) return null
  const zone = match[8]
  const offsetHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3))
  const offsetMinute = zone === 'Z' ? 0 : Number(zone.slice(4, 6))
  if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
    return null
  }
  const offsetMinutes = zone === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute)
  const fractionNs = BigInt((match[7] ?? '').padEnd(9, '0'))
  const epochNs = BigInt(utcSecondMs) * BigInt(1000000) + fractionNs - BigInt(offsetMinutes) * BigInt(60000000000)
  return { epochNs, epochMs: Number(epochNs / BigInt(1000000)) }
}

function roundDays(ns: bigint): number {
  const scaledTenths = (ns * BigInt(10) + DAY_NS / BigInt(2)) / DAY_NS
  return Number(scaledTenths) / 10
}

function median(values: readonly bigint[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return roundDays(sorted[middle])
  return roundDays((sorted[middle - 1] + sorted[middle]) / BigInt(2))
}

function empiricalP90(values: readonly bigint[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  const rank = Math.ceil(0.9 * sorted.length) - 1
  return roundDays(sorted[Math.max(0, Math.min(rank, sorted.length - 1))])
}

function etDate(instant: ParsedInstant): string {
  const parts = new Map(ET_DATE_FORMATTER.formatToParts(new Date(instant.epochMs))
    .map(part => [part.type, part.value]))
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`
}

export function summarizePaidTouchBookingLag(args: {
  assignments: readonly PaidTouchAdAssignment[]
  linkedCount: number
  asOf: string
  expectedBookingDateByOutcomeId?: ReadonlyMap<string, string>
}): PaidTouchBookingLagSummary {
  if (!Number.isSafeInteger(args.linkedCount) || args.linkedCount < 0) {
    return { sampleCount: 0, linkedCount: args.linkedCount, medianDays: null, p90Days: null, longestDays: null,
      blocker: 'paid_touch_booking_lag_population_invalid' }
  }
  const outcomeIds = new Set<string>()
  for (const assignment of args.assignments) {
    if (outcomeIds.has(assignment.outcomeId)) {
      return { sampleCount: 0, linkedCount: args.linkedCount, medianDays: null, p90Days: null, longestDays: null,
        blocker: 'paid_touch_booking_lag_sample_count_invalid' }
    }
    outcomeIds.add(assignment.outcomeId)
  }
  if (args.assignments.length > args.linkedCount) {
    return { sampleCount: 0, linkedCount: args.linkedCount, medianDays: null, p90Days: null, longestDays: null,
      blocker: 'paid_touch_booking_lag_sample_count_invalid' }
  }
  if (args.linkedCount === 0) {
    return { sampleCount: 0, linkedCount: args.linkedCount, medianDays: null, p90Days: null, longestDays: null,
      blocker: 'paid_touch_booking_lag_no_linked_bookings' }
  }
  const asOf = parseInstant(args.asOf)
  if (asOf === null) {
    return { sampleCount: 0, linkedCount: args.linkedCount, medianDays: null, p90Days: null, longestDays: null,
      blocker: 'paid_touch_booking_lag_chronology_invalid' }
  }

  const samplesNs: bigint[] = []
  for (const assignment of args.assignments) {
    const observed = parseInstant(assignment.observedAt)
    const created = parseInstant((assignment as LagAssignment).outcomeCreatedAt)
    const linked = parseInstant(assignment.linkedAt)
    if (created === null) continue
    if (observed === null || linked === null || created.epochNs < observed.epochNs || linked.epochNs < created.epochNs
        || created.epochNs > asOf.epochNs || linked.epochNs > asOf.epochNs) {
      return { sampleCount: 0, linkedCount: args.linkedCount, medianDays: null, p90Days: null, longestDays: null,
        blocker: 'paid_touch_booking_lag_chronology_invalid' }
    }
    const expectedDate = args.expectedBookingDateByOutcomeId?.get(assignment.outcomeId)
    if (expectedDate !== undefined && etDate(created) !== expectedDate) {
      return { sampleCount: 0, linkedCount: args.linkedCount, medianDays: null, p90Days: null, longestDays: null,
        blocker: 'paid_touch_booking_lag_booking_date_mismatch' }
    }
    samplesNs.push(created.epochNs - observed.epochNs)
  }

  if (samplesNs.length === 0) {
    return { sampleCount: 0, linkedCount: args.linkedCount, medianDays: null, p90Days: null, longestDays: null,
      blocker: 'paid_touch_booking_lag_sample_unavailable' }
  }

  return {
    sampleCount: samplesNs.length,
    linkedCount: args.linkedCount,
    medianDays: median(samplesNs),
    p90Days: empiricalP90(samplesNs),
    longestDays: roundDays(samplesNs.reduce((max, value) => value > max ? value : max, BigInt(0))),
    blocker: 'paid_touch_booking_lag_sample_limited',
  }
}
