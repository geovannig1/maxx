import 'server-only'
import type { getAdminClient } from '@/lib/supabase/admin'
import { getAdPlatform } from '@/lib/platforms/registry'
import type { CampaignCreator } from '@/lib/platforms/types'
import {
  adBody, adSetBody, campaignBody, creativeBody, hasExactMarker, markerSeed, objectMarker, type GraphBody,
} from '@/lib/platforms/meta/campaign-payloads'
import type { CampaignPlanSpec } from './plan-spec'

// ADR-062: the object-by-object creation of an approved plan, and its verification read-back. Each
// object's row in campaign_plan_objects is written BEFORE the Meta call (the intent) and gets its Meta
// id right after; a retry skips every object with an id, and for an object whose row has no id it first
// looks the object up by the marker in its name, so a crash between Meta's answer and the database
// write cannot produce a duplicate. Creatives are the one exception: an unrecorded creative is created
// again (a creative is inert: it spends nothing and shows nowhere until an ad uses it).
// A marker is bound to this one creation request (security review H1), and an object found by it is
// taken only when it reads back PAUSED with exactly that marker. Maxx never changes the status of an
// object it found rather than created: anything else stops the run as an integrity failure.

type Db = ReturnType<typeof getAdminClient>
export { markerSeed }
export type ObjectKind = 'campaign' | 'adset' | 'creative' | 'ad'

export interface ObjectRow {
  id: string
  local_key: string
  object_kind: ObjectKind
  marker: string
  meta_id: string | null
  parent_meta_id: string | null
  state: string
  /** created: Meta answered this request's create with the id; found: looked up by this request's marker. */
  origin: 'created' | 'found'
}

const ROW_COLUMNS = 'id, local_key, object_kind, marker, meta_id, parent_meta_id, state, origin'

export interface CreationContext {
  db: Db
  accountId: string
  /** Meta account digits (no act_ prefix). */
  metaAccount: string
  versionId: string
  changeRequestId: string
  /** markerSeed(versionId, changeRequestId): binds every marker to this creation request. */
  markerSeed: string
  timeZone: string
  pageId: string
  creator: CampaignCreator
  simulated: boolean
  rows: Map<string, ObjectRow>
}

export class CreationStepError extends Error {
  constructor(readonly code: string, readonly key: string, readonly detail?: { message?: string; meta_code?: number }) {
    super(code)
  }
}

/** A stand-in for Meta in the demo: fake ids, nothing leaves the process. */
export function simulatedCreator(changeRequestId: string): CampaignCreator {
  const store = new Map<string, Record<string, string>>()
  let n = 0
  const short = changeRequestId.replace(/-/g, '').slice(0, 8)
  return {
    isConfigured: () => true,
    async create(edge, body) {
      n += 1
      const kind = edge.split('/')[1].replace(/s$/, '').replace('adcreative', 'creative')
      const id = `demo-${kind}-${short}-${n}`
      store.set(id, body)
      return { ok: true, id }
    },
    findMarked: async () => ({ ok: true, id: null }),
    read: async (id) => { const b = store.get(id); return b ? { id, name: b.name, status: b.status ?? null, daily_budget: b.daily_budget ?? null } : null },
    setStatus: async () => ({ ok: true }),
  }
}

export function liveCreator(): CampaignCreator | null {
  const creator = getAdPlatform('meta').campaignCreation
  return creator && creator.isConfigured() ? creator : null
}

export async function loadObjectRows(db: Db, versionId: string, accountId: string): Promise<Map<string, ObjectRow> | null> {
  const { data, error } = await db.from('campaign_plan_objects').select(ROW_COLUMNS)
    .eq('plan_version_id', versionId).eq('ad_account_id', accountId)
  if (error) return null
  return new Map(((data ?? []) as ObjectRow[]).map((row) => [row.local_key, row]))
}

async function recordIntent(ctx: CreationContext, kind: ObjectKind, key: string, marker: string): Promise<ObjectRow> {
  const { data, error } = await ctx.db.from('campaign_plan_objects').insert({
    plan_version_id: ctx.versionId, ad_account_id: ctx.accountId, change_request_id: ctx.changeRequestId,
    object_kind: kind, local_key: key, marker, simulated: ctx.simulated,
  }).select(ROW_COLUMNS).single()
  if (error || !data) throw new CreationStepError('OBJECT_RECORD_FAILED', key)
  const row = data as ObjectRow
  ctx.rows.set(key, row)
  return row
}

async function recordId(ctx: CreationContext, row: ObjectRow, metaId: string, parent: string | null, origin: ObjectRow['origin'] = 'created'): Promise<void> {
  const { error } = await ctx.db.from('campaign_plan_objects').update({ meta_id: metaId, parent_meta_id: parent, state: 'created', error_code: null, origin })
    .eq('id', row.id).eq('ad_account_id', ctx.accountId)
  // The object exists in Meta; failing to record it is reported, and the marker finds it on a retry.
  if (error) throw new CreationStepError('OBJECT_ID_RECORD_FAILED', row.local_key)
  ctx.rows.set(row.local_key, { ...row, meta_id: metaId, parent_meta_id: parent, state: 'created', origin })
}

async function recordError(ctx: CreationContext, row: ObjectRow, code: string): Promise<void> {
  await ctx.db.from('campaign_plan_objects').update({ error_code: code.replace(/[^A-Z0-9_]/g, '_').slice(0, 64) }).eq('id', row.id).eq('ad_account_id', ctx.accountId)
}

const READ_FIELDS: Record<Exclude<ObjectKind, 'creative'>, string> = {
  campaign: 'id,name,status,daily_budget', adset: 'id,name,status,daily_budget,campaign_id', ad: 'id,name,status,adset_id',
}

const FOUND_OBJECT_MESSAGE = 'Meta answered the lookup for this step with an object that is not this request\'s paused object. Nothing was recorded or changed; check it in Ads Manager.'

/** Take an object found by this request's marker only when it reads back PAUSED with exactly that marker.
 *  Its status is never changed: a mismatch is an integrity failure that stops the run. */
async function adoptFound(ctx: CreationContext, row: ObjectRow, kind: Exclude<ObjectKind, 'creative'>, marker: string, metaId: string, parent: string | null): Promise<void> {
  const read = row.marker === marker ? await ctx.creator.read(metaId, READ_FIELDS[kind]) : null
  if (!read || read.status !== 'PAUSED' || !hasExactMarker(read.name, marker)) {
    await recordError(ctx, row, 'FOUND_OBJECT_INTEGRITY')
    throw new CreationStepError('FOUND_OBJECT_INTEGRITY', row.local_key, { message: FOUND_OBJECT_MESSAGE })
  }
  await recordId(ctx, row, metaId, parent, 'found')
}

/** The Meta id of one object: recorded, found by this request's marker, or created now. */
async function ensure(ctx: CreationContext, kind: ObjectKind, key: string, input: { createEdge: string; findEdge: string | null; parent: string | null; body: () => GraphBody }): Promise<string> {
  const marker = objectMarker(ctx.markerSeed, key)
  let row = ctx.rows.get(key)
  if (row?.meta_id) return row.meta_id
  if (row && input.findEdge && kind !== 'creative') {
    const found = await ctx.creator.findMarked(input.findEdge, marker)
    if (!found.ok) throw new CreationStepError('MARKER_LOOKUP_FAILED', key)
    if (found.id) { await adoptFound(ctx, row, kind, marker, found.id, input.parent); return found.id }
  }
  row ??= await recordIntent(ctx, kind, key, marker)
  const created = await ctx.creator.create(input.createEdge, input.body())
  if (!created.ok) {
    await recordError(ctx, row, created.error.code)
    throw new CreationStepError(created.error.code, key, created.error)
  }
  await recordId(ctx, row, created.id, input.parent)
  return created.id
}

/** Create every object of the plan that has no recorded id yet, in dependency order. */
export async function createPlanObjects(ctx: CreationContext, spec: CampaignPlanSpec): Promise<void> {
  const act = `act_${ctx.metaAccount}`
  const campaignId = await ensure(ctx, 'campaign', 'campaign', {
    createEdge: `${act}/campaigns`, findEdge: `${act}/campaigns`, parent: null, body: () => campaignBody(spec, objectMarker(ctx.markerSeed, 'campaign')),
  })
  for (const adSet of spec.ad_sets) {
    const adSetKey = `adset:${adSet.key}`
    const adSetId = await ensure(ctx, 'adset', adSetKey, {
      createEdge: `${act}/adsets`, findEdge: ctx.simulated ? null : `${campaignId}/adsets`, parent: campaignId,
      body: () => adSetBody(spec, adSet, campaignId, objectMarker(ctx.markerSeed, adSetKey), ctx.timeZone),
    })
    for (const ad of adSet.ads) {
      const creativeKey = `creative:${adSet.key}:${ad.key}`
      const creativeId = ad.creative.mode === 'existing_creative' ? ad.creative.creative_id : await ensure(ctx, 'creative', creativeKey, {
        createEdge: `${act}/adcreatives`, findEdge: null, parent: null,
        body: () => {
          const body = creativeBody(ad, ctx.pageId, objectMarker(ctx.markerSeed, creativeKey))
          if (!body) throw new CreationStepError('CREATIVE_INCOMPLETE', creativeKey)
          return body
        },
      })
      const adKey = `ad:${adSet.key}:${ad.key}`
      await ensure(ctx, 'ad', adKey, {
        createEdge: `${act}/ads`, findEdge: ctx.simulated ? null : `${adSetId}/ads`, parent: adSetId,
        body: () => adBody(ad, adSetId, creativeId, objectMarker(ctx.markerSeed, adKey)),
      })
    }
  }
}

export interface VerificationOutcome { verified: number; unverified: Array<{ key: string; reason: string }> }

/** Read every recorded object back: PAUSED, exactly its marker in the name, the planned budget. An object
 *  this request created that reads as active is paused again; one it found by marker is never touched. */
export async function verifyPlanObjects(ctx: CreationContext, spec: CampaignPlanSpec): Promise<VerificationOutcome> {
  const expectedBudget = (row: ObjectRow): string | null => {
    if (row.object_kind === 'campaign') return spec.campaign.budget_mode === 'CBO' ? String(spec.campaign.daily_budget_minor) : null
    if (row.object_kind === 'adset') { const s = spec.ad_sets.find((a) => `adset:${a.key}` === row.local_key); return spec.campaign.budget_mode === 'ABO' && s ? String(s.daily_budget_minor) : null }
    return null
  }
  const outcome: VerificationOutcome = { verified: 0, unverified: [] }
  for (const row of ctx.rows.values()) {
    if (!row.meta_id) continue
    let reason: string | null = null
    if (row.object_kind !== 'creative') {
      const read = await ctx.creator.read(row.meta_id, READ_FIELDS[row.object_kind])
      if (!read) reason = 'READ_FAILED'
      else if (read.status !== 'PAUSED') {
        reason = row.origin === 'found' ? 'FOUND_OBJECT_NOT_PAUSED' : 'STATUS_NOT_PAUSED'
        if (row.origin === 'created') await ctx.creator.setStatus(row.meta_id, 'PAUSED')
      } else if (!hasExactMarker(read.name, row.marker)) reason = 'NAME_MISMATCH'
      else if (expectedBudget(row) !== null && String(read.daily_budget ?? '') !== expectedBudget(row)) reason = 'BUDGET_MISMATCH'
    }
    const state = reason ? 'unverified' : 'verified'
    await ctx.db.from('campaign_plan_objects').update({ state, error_code: reason }).eq('id', row.id).eq('ad_account_id', ctx.accountId)
    ctx.rows.set(row.local_key, { ...row, state })
    if (reason) outcome.unverified.push({ key: row.local_key, reason })
    else outcome.verified += 1
  }
  return outcome
}

/** The objects a creation request recorded under its own request-bound markers (security review H1):
 *  the only ones its rollback may archive. */
export function createdByRequest<T extends { meta_id: string | null; marker: string; local_key: string }>(rows: T[], versionId: string, changeRequestId: string): T[] {
  const seed = markerSeed(versionId, changeRequestId)
  return rows.filter((o) => o.meta_id && o.marker === objectMarker(seed, o.local_key))
}

export function objectSummary(rows: Map<string, ObjectRow>): Array<{ key: string; kind: ObjectKind; meta_id: string | null; state: string }> {
  return [...rows.values()].map((r) => ({ key: r.local_key, kind: r.object_kind, meta_id: r.meta_id, state: r.state }))
}
