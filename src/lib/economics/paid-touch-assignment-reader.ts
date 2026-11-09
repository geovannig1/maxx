import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { PaidTouchAdAssignment } from './observed-contribution'

const PAGE_SIZE = 1_000
const ID_CHUNK_SIZE = 200
const MAX_OUTCOMES = 10_000
const iso = z.string().datetime({ offset: true })
const outcomeUuid = z.string().uuid()
const metaId = z.string().regex(/^\d{1,32}$/)

const linkSchema = z.object({
  id: z.string().uuid(),
  outcome_id: z.string().uuid(),
  last_touch_id: z.string().uuid(),
  last_interaction_at: iso,
  outcome_created_at: iso,
  linked_at: iso,
  policy_version: z.literal(1),
}).strict()

const touchSchema = z.object({
  id: z.string().uuid(),
  observed_at: iso,
  created_at: iso,
  identity_complete: z.boolean(),
  meta_campaign_id: metaId.nullable(),
  meta_adset_id: metaId.nullable(),
  meta_ad_id: metaId.nullable(),
}).strict().superRefine((row, context) => {
  const complete = row.meta_campaign_id !== null
    && row.meta_adset_id !== null
    && row.meta_ad_id !== null
  if (complete !== row.identity_complete) {
    context.addIssue({ code: 'custom', message: 'identity_complete contradicts the Meta ID trio' })
  }
})

type PaidTouchLinkRow = z.infer<typeof linkSchema>
type PaidTouchRow = z.infer<typeof touchSchema>

interface ParsedInstant { epochNs: bigint }
const isoInstantPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/

function parseInstant(value: string): ParsedInstant {
  const match = isoInstantPattern.exec(iso.parse(value))
  if (match === null) throw new Error('Paid-touch assignment timestamp is invalid.')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    throw new Error('Paid-touch assignment timestamp is invalid.')
  }
  const utcSecondMs = Date.UTC(year, month - 1, day, hour, minute, second, 0)
  if (!Number.isFinite(utcSecondMs)) throw new Error('Paid-touch assignment timestamp is invalid.')
  const check = new Date(utcSecondMs)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
      || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) {
    throw new Error('Paid-touch assignment timestamp is invalid.')
  }
  const zone = match[8]
  const offsetHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3))
  const offsetMinute = zone === 'Z' ? 0 : Number(zone.slice(4, 6))
  if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
    throw new Error('Paid-touch assignment timestamp is invalid.')
  }
  const offsetMinutes = zone === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute)
  const fractionNs = BigInt((match[7] ?? '').padEnd(9, '0'))
  return { epochNs: BigInt(utcSecondMs) * BigInt(1000000) + fractionNs - BigInt(offsetMinutes) * BigInt(60000000000) }
}

function compareInstants(left: string, right: string): number {
  const leftNs = parseInstant(left).epochNs
  const rightNs = parseInstant(right).epochNs
  return leftNs < rightNs ? -1 : leftNs > rightNs ? 1 : 0
}

export interface PaidTouchAdAssignmentRead {
  assignments: PaidTouchAdAssignment[]
  requestedOutcomeCount: number
  /** Outcome uuids with no paid-touch link as of the cut. */
  unassignedOutcomeIds: string[]
  /** Outcome uuids linked to a touch whose Meta campaign/ad set/ad identity is incomplete. */
  incompleteIdentityOutcomeIds: string[]
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

async function readExactChunk(args: {
  db: SupabaseClient
  table: 'outcome_touch_links' | 'paid_touch_observations'
  columns: string
  adAccountId: string
  identityColumn: 'outcome_id' | 'id'
  identities: Array<number | string>
  asOfColumn: 'linked_at' | 'created_at'
  asOf: string
}): Promise<unknown[]> {
  const countResult = await args.db.from(args.table)
    .select('id', { count: 'exact', head: true })
    .eq('ad_account_id', args.adAccountId)
    .in(args.identityColumn, args.identities)
    .lte(args.asOfColumn, args.asOf)
  if (countResult.error) {
    throw new Error(`Paid-touch ${args.table} count failed: ${countResult.error.message}`)
  }
  if (countResult.count === null || !Number.isSafeInteger(countResult.count)
      || countResult.count < 0 || countResult.count > args.identities.length) {
    throw new Error(`Paid-touch ${args.table} count was unavailable or contradictory.`)
  }

  const rows: unknown[] = []
  while (rows.length < countResult.count) {
    const from = rows.length
    const to = Math.min(from + PAGE_SIZE, countResult.count) - 1
    const result = await args.db.from(args.table)
      .select(args.columns)
      .eq('ad_account_id', args.adAccountId)
      .in(args.identityColumn, args.identities)
      .lte(args.asOfColumn, args.asOf)
      .order('id', { ascending: true })
      .range(from, to)
    if (result.error) {
      throw new Error(`Paid-touch ${args.table} read failed: ${result.error.message}`)
    }
    if (!Array.isArray(result.data) || result.data.length === 0) {
      throw new Error(`Paid-touch ${args.table} pages did not match the exact source count.`)
    }
    rows.push(...result.data)
    if (rows.length > countResult.count) {
      throw new Error(`Paid-touch ${args.table} pages exceeded the exact source count.`)
    }
  }
  return rows
}

function parseRows<T>(rows: unknown[], schema: z.ZodType<T>, label: string): T[] {
  try {
    return rows.map((row) => schema.parse(row))
  } catch (error) {
    throw new Error(`Malformed ${label} row: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Paid-touch ad assignments for outcomes of ANY source, keyed by outcome uuid (`outcomeId`). */
export async function readPaidTouchAdAssignments(
  db: SupabaseClient,
  adAccountId: string,
  rawOutcomeIds: string[],
  asOf: string,
): Promise<PaidTouchAdAssignmentRead> {
  if (!z.string().uuid().safeParse(adAccountId).success) {
    throw new Error('Paid-touch assignment account ID must be a UUID.')
  }
  const asOfInstant = iso.parse(asOf)
  const outcomeIds = [...new Set(rawOutcomeIds.map((value) => outcomeUuid.parse(value).toLowerCase()))].sort()
  if (outcomeIds.length > MAX_OUTCOMES) {
    throw new Error(`Paid-touch assignment exceeds the audited ${MAX_OUTCOMES}-outcome bound.`)
  }
  if (outcomeIds.length === 0) {
    return {
      assignments: [], requestedOutcomeCount: 0,
      unassignedOutcomeIds: [], incompleteIdentityOutcomeIds: [],
    }
  }

  const requested = new Set(outcomeIds)
  const rawLinks = (await Promise.all(chunks(outcomeIds, ID_CHUNK_SIZE).map((identities) => (
    readExactChunk({
      db, table: 'outcome_touch_links',
      columns: 'id,outcome_id,last_touch_id,last_interaction_at,outcome_created_at,linked_at,policy_version',
      adAccountId, identityColumn: 'outcome_id', identities, asOfColumn: 'linked_at', asOf,
    })
  )))).flat()
  const links = parseRows<PaidTouchLinkRow>(rawLinks, linkSchema, 'paid-touch link')
  const linksByOutcome = new Map<string, PaidTouchLinkRow>()
  for (const link of links) {
    if (!requested.has(link.outcome_id)) {
      throw new Error('Paid-touch assignment returned an unrequested outcome.')
    }
    if (compareInstants(link.linked_at, asOfInstant) > 0) {
      throw new Error('Paid-touch assignment was linked after the as-of cut.')
    }
    if (compareInstants(link.last_interaction_at, link.outcome_created_at) > 0
        || compareInstants(link.outcome_created_at, link.linked_at) > 0) {
      throw new Error('Paid-touch link recording chronology is invalid.')
    }
    if (linksByOutcome.has(link.outcome_id)) {
      throw new Error(`Duplicate paid-touch assignment for outcome ${link.outcome_id}.`)
    }
    linksByOutcome.set(link.outcome_id, link)
  }

  const touchIds = [...new Set(links.map((row) => row.last_touch_id))].sort()
  const rawTouches = (await Promise.all(chunks(touchIds, ID_CHUNK_SIZE).map((identities) => (
    readExactChunk({
      db, table: 'paid_touch_observations',
      columns: 'id,observed_at,created_at,identity_complete,meta_campaign_id,meta_adset_id,meta_ad_id',
      adAccountId, identityColumn: 'id', identities, asOfColumn: 'created_at', asOf,
    })
  )))).flat()
  const touches = parseRows<PaidTouchRow>(rawTouches, touchSchema, 'paid-touch observation')
  const touchesById = new Map<string, PaidTouchRow>()
  const requestedTouchIds = new Set(touchIds)
  for (const touch of touches) {
    if (!requestedTouchIds.has(touch.id)) {
      throw new Error('Paid-touch assignment returned an unrequested observation.')
    }
    if (touchesById.has(touch.id)) throw new Error(`Duplicate paid-touch observation ${touch.id}.`)
    if (compareInstants(touch.created_at, asOfInstant) > 0) {
      throw new Error('Paid-touch observation was recorded after the as-of cut.')
    }
    if (compareInstants(touch.created_at, touch.observed_at) < 0) {
      throw new Error('Paid-touch observation recording chronology is invalid.')
    }
    touchesById.set(touch.id, touch)
  }
  if (touchesById.size !== touchIds.length) {
    throw new Error('Paid-touch assignment source omitted an observation referenced by a link.')
  }

  const assignments: PaidTouchAdAssignment[] = []
  const incompleteIdentityOutcomeIds: string[] = []
  for (const outcomeId of outcomeIds) {
    const link = linksByOutcome.get(outcomeId)
    if (!link) continue
    const touch = touchesById.get(link.last_touch_id)
    if (!touch) throw new Error('Paid-touch link observation is unavailable.')
    if (compareInstants(touch.observed_at, link.last_interaction_at) !== 0) {
      throw new Error('Paid-touch link timestamp contradicts its immutable observation.')
    }
    if (!touch.identity_complete) {
      incompleteIdentityOutcomeIds.push(outcomeId)
      continue
    }
    assignments.push({
      outcomeId,
      linkId: link.id,
      touchId: touch.id,
      metaCampaignId: touch.meta_campaign_id!,
      metaAdsetId: touch.meta_adset_id!,
      metaAdId: touch.meta_ad_id!,
      observedAt: touch.observed_at,
      outcomeCreatedAt: link.outcome_created_at,
      linkedAt: link.linked_at,
      policyVersion: link.policy_version,
    })
  }
  const assigned = new Set(assignments.map((row) => row.outcomeId))
  return {
    assignments,
    requestedOutcomeCount: outcomeIds.length,
    unassignedOutcomeIds: outcomeIds.filter((id) => !assigned.has(id)),
    incompleteIdentityOutcomeIds,
  }
}
