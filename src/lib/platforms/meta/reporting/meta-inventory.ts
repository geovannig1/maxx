import { resolveAudience, type AudienceRef } from '@/lib/audience/resolver'
import { metaGet } from '@/lib/platforms/meta/client'
import { fetchCustomAudiences } from '@/lib/platforms/meta/fetch-custom-audiences'
import { projectAudienceEvidence, projectAudienceInventory } from '@/lib/reporting/audience-projection'
import { audienceConfigurationState, type ReportingAudienceRef } from '@/lib/reporting/audience-evidence'
import type { ReportCreative, ReportEntity, ReportObservation, ReportingContext } from '@/lib/reporting/contracts'
import { metaNumber, type MetaRow } from '@/lib/reporting/meta-metrics'
import { describeCreativeIdentity, singleCreativeVideoId } from '@/lib/reporting/creative-identity'
import { metaReadFailureNote } from './meta-read-session'

export type ReadMetaPages = (path: string, params: Record<string, string>) => Promise<MetaRow[]>
export interface MetaInventory {
  campaigns: MetaRow[]; adsets: MetaRow[]; ads: MetaRow[]
  audiences: Record<string, ReportingAudienceRef>; creatives: Record<string, ReportCreative>
  notes: string[]; observedAt: string
}
const record = (value: unknown): MetaRow => value && typeof value === 'object' && !Array.isArray(value) ? value as MetaRow : {}
export const metaText = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null
function https(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null
  } catch { return null }
}
function onlyAsset(feed: MetaRow, field: string): MetaRow {
  const assets = feed[field]
  return Array.isArray(assets) && assets.length === 1 ? record(assets[0]) : {}
}
const STORY_VIDEO_PATH = '/object_story_spec/video_data/video_id'
type ReadMetaVideo = (id: string) => Promise<MetaRow>

function configuredStoryVideoId(identity: ReturnType<typeof describeCreativeIdentity>): string | null {
  const ids = new Set(identity.members.filter(member => member.kind === 'video' && member.role === 'media'
    && member.sourcePaths.includes(STORY_VIDEO_PATH)).map(member => member.id))
  return ids.size === 1 ? [...ids][0] : null
}

export function presentCreative(id: string, row: MetaRow, video?: MetaRow, observedAt?: string,
  storyVideoPreviewId?: string): ReportCreative | null {
  if (row.id !== id) return null
  const story = record(row.object_story_spec)
  const link = record(story.link_data)
  const videoData = record(story.video_data)
  const feed = record(row.asset_feed_spec)
  const childAttachments = link.child_attachments
  const identity = observedAt ? describeCreativeIdentity(row, observedAt) : undefined
  const verifiedStoryVideoId = identity && storyVideoPreviewId
    && identity.members.some(member => member.kind === 'video' && member.role === 'media'
      && member.id === storyVideoPreviewId && member.sourcePaths.includes(STORY_VIDEO_PATH)) ? storyVideoPreviewId : null
  const videoId = verifiedStoryVideoId ?? (identity ? singleCreativeVideoId(identity)
    : metaText(row.video_id) ?? metaText(videoData.video_id) ?? metaText(onlyAsset(feed, 'videos').video_id))
  const matchedVideo = videoId && video?.id === videoId ? video : null
  const ambiguousVideo = !videoId && identity?.members.some(member => member.kind === 'video' && member.role === 'media')
  const media = identity?.members.filter(member => member.role === 'media') ?? []
  const videoPaths = new Set(media.filter(member => member.kind === 'video').flatMap(member => member.sourcePaths))
  const observedVideoOnly = media.length > 0 && media.every(member => member.kind === 'video')
    && (identity?.unresolvedSourcePaths.every(path => videoPaths.has(path)
      || path === '/image_url' || path === '/object_story_spec/video_data/image_url') ?? false)
  const imageUrl = https(row.image_url) ?? https(link.picture) ?? https(onlyAsset(feed, 'images').url)
  const videoUrl = https(matchedVideo?.source)
  const destination = row.link_url ?? link.link ?? record(record(videoData.call_to_action).value).link ?? onlyAsset(feed, 'link_urls').website_url
  return {
    id, name: metaText(row.name),
    format: Array.isArray(childAttachments) && childAttachments.length > 1 ? 'carousel'
      : videoId || observedVideoOnly ? 'video' : ambiguousVideo ? 'unknown' : imageUrl ? 'image' : 'unknown',
    thumbnailUrl: https(row.thumbnail_url) ?? https(videoData.image_url), imageUrl,
    videoUrl, durationSeconds: metaNumber(matchedVideo?.length),
    body: metaText(row.body) ?? metaText(link.message) ?? metaText(videoData.message) ?? metaText(onlyAsset(feed, 'bodies').text),
    headline: metaText(row.title) ?? metaText(link.name) ?? metaText(videoData.title) ?? metaText(onlyAsset(feed, 'titles').text),
    destination: https(destination),
    ...(identity ? { identity } : {}),
    ...(verifiedStoryVideoId && videoUrl ? {
      videoPreviewEvidence: { videoId: verifiedStoryVideoId, basis: 'object_story_spec_video_id' as const },
    } : {}),
  }
}

export function resolveInventoryAudience(
  context: ReportingContext, adset: MetaRow | undefined, audiences: Record<string, AudienceRef>, observedAt: string | null,
): Pick<ReportEntity, 'audience' | 'audienceLabel' | 'audienceEvidence'> {
  const resolution = resolveAudience({
    adsetName: metaText(adset?.name), targeting: adset?.targeting && typeof adset.targeting === 'object' ? record(adset.targeting) : null,
    targetingSyncedAt: observedAt, accountId: context.account.id, audiencesById: audiences,
  }, Date.parse(context.asOf))
  const composition = resolution.composition
  const audienceEvidence = projectAudienceEvidence(context, adset, audiences, observedAt, resolution.expansion)
  if (!observedAt || !Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt) > Date.parse(context.asOf)
    || (audienceEvidence && audienceConfigurationState(audienceEvidence, context.asOf) !== 'observed')) {
    return { audience: 'unknown', audienceLabel: 'Audience configuration unavailable or stale; historical performance remains separately reported.',
      ...(observedAt && Date.parse(observedAt) <= Date.parse(context.asOf) ? { audienceEvidence } : {}) }
  }
  const audience = composition === 'retargeting_only' ? 'warm' : ['broad_advantage', 'lookalike'].includes(composition) ? 'cold' : composition === 'mixed' ? 'mixed' : 'unknown'
  return { audience, audienceEvidence, audienceLabel: resolution.unknownReason ? 'Audience composition could not be established from the current references; inspect member evidence.' : ({ warm: 'Retargeting-only configuration', cold: composition === 'lookalike' ? 'Lookalike configuration' : 'No custom-audience inclusion; other targeting restrictions may apply', mixed: 'Mixed audience configuration', unknown: 'Audience configuration unavailable' }[audience]) }
}

async function readCreative(id: string, observedAt: string, get: typeof metaGet,
  readVideo: ReadMetaVideo): Promise<{ creative: ReportCreative | null; notes: string[] }> {
  const row = await get<MetaRow>(`/${encodeURIComponent(id)}`, {
    fields: 'id,name,body,title,link_url,image_url,image_hash,video_id,thumbnail_url,object_story_spec,asset_feed_spec',
  })
  const identity = describeCreativeIdentity(row, observedAt)
  const exactVideoId = singleCreativeVideoId(identity)
  const storyVideoPreviewId = exactVideoId ? null : configuredStoryVideoId(identity)
  const videoId = exactVideoId ?? storyVideoPreviewId
  let video: MetaRow | undefined
  const notes: string[] = []
  if (videoId) {
    try { video = await readVideo(videoId) }
    catch (error) { notes.push([`Video playback or duration unavailable for creative ${id}; its thumbnail and metrics remain available.`, metaReadFailureNote(error)].filter(Boolean).join(' ')) }
  }
  const creative = presentCreative(id, row, video, observedAt, storyVideoPreviewId ?? undefined)
  if (!creative) notes.push(`Creative identity could not be confirmed for ${id}.`)
  if (creative?.videoPreviewEvidence) {
    notes.push(`Creative ${id} configured story-video preview uses exact readable member ${creative.videoPreviewEvidence.videoId}; alternate video identities remain preserved, ad results are not assigned to this member, and placement-specific rendering may differ.`)
  }
  const feed = record(row.asset_feed_spec)
  if (Object.values(feed).some(value => Array.isArray(value) && value.length > 1)) {
    notes.push(`Creative ${id} has multiple dynamic assets; a single asset's performance cannot be identified from ad totals.`)
  }
  return { creative, notes }
}

const BUDGET_FIELDS = {
  campaigns: ['account_id', 'daily_budget', 'lifetime_budget', 'start_time', 'stop_time', 'is_adset_budget_sharing_enabled', 'is_budget_schedule_enabled'],
  adsets: ['account_id', 'daily_budget', 'lifetime_budget', 'start_time', 'end_time', 'is_budget_schedule_enabled'],
} as const

async function readConfiguration(path: string, core: string, optional: readonly string[], pages: ReadMetaPages) {
  let fields = [...core.split(','), ...optional]
  const notes: string[] = []
  for (;;) {
    try {
      const rows = await pages(path, { fields: fields.join(','), limit: '200' })
      return { rows: rows.map(row => Object.fromEntries(Object.entries(row)
        .filter(([key]) => !optional.includes(key) || fields.includes(key)))), notes }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 100) throw error
      const remaining = fields.filter(field => optional.includes(field))
      const named = remaining.filter(field => error.message.includes(field))
      const rejected = named.length ? named : /field|parameter/i.test(error.message) ? remaining : []
      if (!rejected.length) throw error
      fields = fields.filter(field => !rejected.includes(field))
      notes.push(`Meta configuration rejected optional field(s): ${rejected.join(', ')}. Those settings remain unavailable; supported configuration is retained.`)
    }
  }
}

export async function readMetaInventory(context: ReportingContext, pages: ReadMetaPages, get: typeof metaGet = metaGet): Promise<MetaInventory> {
  const path = `/act_${context.account.metaAccountId.replace(/^act_/, '')}`
  const definitions = [
    ['campaigns', 'id,name,status,effective_status,objective,updated_time'],
    ['adsets', 'id,name,status,effective_status,campaign_id,targeting,optimization_goal,promoted_object,learning_stage_info,attribution_spec,updated_time'],
    ['ads', 'id,name,status,effective_status,campaign_id,adset_id,creative{id},updated_time'],
    ['customaudiences', 'id,name,subtype,account_id,operation_status,delivery_status'],
  ] as const
  const results = await Promise.allSettled(definitions.map(([edge, fields]) => edge === 'customaudiences'
    ? fetchCustomAudiences(context.account.metaAccountId, pages).then(rows => ({ rows, notes: [] as string[] }))
    : readConfiguration(`${path}/${edge}`, fields, edge === 'ads' ? [] : BUDGET_FIELDS[edge], pages)))
  const notes = results.flatMap((result, index) => result.status === 'rejected'
    ? [[`Meta ${definitions[index][0]} configuration unavailable; delivery metrics are independent.`, metaReadFailureNote(result.reason)].filter(Boolean).join(' ')] : result.value.notes)
  const rows = (index: number) => results[index].status === 'fulfilled' ? results[index].value.rows.filter(row => {
    if (index === 3 || row.account_id === undefined) return true
    return typeof row.account_id === 'string' && row.account_id.replace(/^act_/, '') === context.account.metaAccountId.replace(/^act_/, '')
  }) : []
  if (results.some((result, index) => result.status === 'fulfilled' && result.value.rows.length !== rows(index).length))
    notes.push('Meta configuration with a mismatched account identity was withheld; native performance remains independent.')
  const audiences = projectAudienceInventory(context, rows(3))
  const creativeIds = [...new Set(rows(2).map(row => metaText(record(row.creative).id)).filter((id): id is string => id !== null))].sort()
  const videoReads = new Map<string, Promise<MetaRow>>()
  const readVideo: ReadMetaVideo = videoId => {
    const cached = videoReads.get(videoId)
    if (cached) return cached
    const request = Promise.resolve().then(() => get<MetaRow>(`/${encodeURIComponent(videoId)}`, { fields: 'id,source,length' }))
    videoReads.set(videoId, request)
    return request
  }
  let creatives: Record<string, ReportCreative> = {}
  let creativeNotes: string[] = []
  // Bounded fan-out; no POST/batch endpoint, so every native request remains GET-only.
  for (let offset = 0; offset < creativeIds.length; offset += 8) {
    const ids = creativeIds.slice(offset, offset + 8)
    const batch = await Promise.allSettled(ids.map(id => readCreative(id, context.asOf, get, readVideo)))
    creatives = { ...creatives, ...Object.fromEntries(batch.flatMap(result => result.status === 'fulfilled' && result.value.creative ? [[result.value.creative.id, result.value.creative]] : [])) }
    creativeNotes = [...creativeNotes, ...batch.flatMap((result, index) => result.status === 'fulfilled' ? result.value.notes : [[`Creative preview unavailable for ${ids[index]}.`, metaReadFailureNote(result.reason)].filter(Boolean).join(' ')])]
  }
  return { campaigns: rows(0), adsets: rows(1), ads: rows(2), audiences, creatives,
    notes: [...notes, ...creativeNotes], observedAt: context.asOf }
}

export function inventoryObservations(context: ReportingContext, inventory: MetaInventory): ReportObservation[] {
  return inventory.adsets.flatMap(row => {
    const id = metaText(row.id)
    if (!id) return []
    const learning = record(row.learning_stage_info)
    const goal = metaText(row.optimization_goal)
    const promoted = record(row.promoted_object)
    const event = metaText(promoted.custom_event_type) ?? metaText(promoted.custom_conversion_id)
    const audience = resolveInventoryAudience(context, row, inventory.audiences, inventory.observedAt)
    const attribution = Array.isArray(row.attribution_spec) ? row.attribution_spec.map(item => {
      const spec = record(item)
      return `${metaText(spec.event_type) ?? 'unknown'} ${metaNumber(spec.window_days) ?? '?'} days`
    }).join(', ') : 'unavailable'
    return [{
      id: `setup:${id}`, title: `${metaText(row.name) ?? id}: observed configuration`, entityId: id,
      kind: 'delivery' as const, observedAt: inventory.observedAt,
      detail: `Current delivery: ${metaText(row.effective_status) ?? 'unknown'}. Optimization: ${goal ?? 'unavailable'}; event: ${event ?? 'unavailable'}. Learning: ${metaText(learning.status) ?? 'unavailable'}; learning conversions: ${metaNumber(learning.conversions) ?? 'unavailable'}. Attribution settings: ${attribution}. Configuration was read at ${inventory.observedAt}; it does not establish the setup in the selected historical period.`,
    }, { id: `audience:${id}`, title: `${metaText(row.name) ?? id}: audience evidence`, entityId: id,
      kind: 'audience' as const, observedAt: inventory.observedAt, detail: audience.audienceLabel }]
  })
}
