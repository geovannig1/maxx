import { z } from 'zod'

const opaqueId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/)
const paths = z.array(z.string().startsWith('/')).refine(values => new Set(values).size === values.length)
const memberSchema = z.object({
  kind: z.enum(['video', 'image']), id: opaqueId, role: z.enum(['media', 'poster']),
  sourcePaths: paths.refine(values => values.length > 0),
}).strict()
export const ReportCreativeIdentitySchema = z.object({
  version: z.literal(1), basis: z.literal('current_meta_configuration'),
  observedAt: z.string().datetime({ offset: true }),
  structure: z.enum(['single', 'carousel', 'asset_feed', 'unknown']),
  members: z.array(memberSchema).refine(values => new Set(values.map(value => `${value.kind}:${value.role}:${value.id}`)).size === values.length),
  unresolvedSourcePaths: paths, completeness: z.literal('observed_fields_only'),
}).strict()
export type ReportCreativeIdentity = z.infer<typeof ReportCreativeIdentitySchema>
type Member = ReportCreativeIdentity['members'][number]
type Row = Record<string, unknown>
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
// These URLs can be the preview/poster for an identified video; other unreadable media slots are ambiguous.
const posterUrlPaths = new Set(['/image_url', '/object_story_spec/video_data/image_url'])
const hasUnresolvedMedia = (sourcePaths: readonly string[]) => sourcePaths.some(path => !posterUrlPaths.has(path))

/** Observed configuration membership only; URLs, names and ad results never establish asset identity. */
export function describeCreativeIdentity(row: Row, observedAt: string): ReportCreativeIdentity {
  const members = new Map<string, Member>()
  const unresolved = new Set<string>()
  const add = (kind: Member['kind'], role: Member['role'], value: unknown, path: string) => {
    if (!opaqueId.safeParse(value).success) { unresolved.add(path); return }
    const id = value as string
    const key = `${kind}:${role}:${id}`
    const old = members.get(key)
    members.set(key, { kind, role, id, sourcePaths: [...new Set([...(old?.sourcePaths ?? []), path])].sort() })
  }
  const media = (value: unknown, path: string, poster = false): void => {
    const item = record(value)
    let found = false
    for (const [field, kind] of [['video_id', 'video'], ['image_hash', 'image'], ['hash', 'image']] as const) {
      if (!(field in item)) continue
      found = true
      add(kind, kind === 'image' && (poster || 'video_id' in item) ? 'poster' : 'media', item[field], `${path}/${field}`)
    }
    if (!found) unresolved.add(path || '/')
  }
  const container = (value: unknown, path: string): Row => {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) unresolved.add(path)
    return record(value)
  }
  const story = container(row.object_story_spec, '/object_story_spec')
  const video = container(story.video_data, '/object_story_spec/video_data')
  const link = container(story.link_data, '/object_story_spec/link_data')
  const feed = container(row.asset_feed_spec, '/asset_feed_spec')
  const rootVideo = 'video_id' in row || 'video_id' in video
  for (const [item, path, poster] of [[row, '', rootVideo], [video, '/object_story_spec/video_data', true], [link, '/object_story_spec/link_data', false]] as const) {
    if (['video_id', 'image_hash', 'hash'].some(field => field in item)) media(item, path, poster)
    for (const field of ['image_url', 'picture']) {
      if (field in item && !('image_hash' in item) && !('hash' in item)) unresolved.add(`${path}/${field}`)
    }
  }
  let carousel = false
  let assetFeed = false
  const list = (value: unknown, path: string): void => {
    if (!Array.isArray(value)) { unresolved.add(path); return }
    value.forEach((item, index) => media(item, `${path}/${index}`))
  }
  for (const [item, path] of [[row, ''], [link, '/object_story_spec/link_data']] as const) {
    if (!('child_attachments' in item)) continue
    carousel = true
    list(item.child_attachments, `${path}/child_attachments`)
  }
  for (const field of ['videos', 'images']) {
    if (!(field in feed)) continue
    assetFeed = true
    list(feed[field], `/asset_feed_spec/${field}`)
  }
  const singletonVideos = [['/video_id', row.video_id], ['/object_story_spec/video_data/video_id', video.video_id]] as const
  const singletonImages = [['/image_hash', row.image_hash], ['/object_story_spec/link_data/image_hash', link.image_hash]] as const
  let conflict = false
  for (const fields of rootVideo ? [singletonVideos] : [singletonVideos, singletonImages]) {
    if (new Set(fields.filter(([, value]) => opaqueId.safeParse(value).success).map(([, value]) => value)).size <= 1) continue
    conflict = true
    fields.forEach(([path]) => unresolved.add(path))
  }
  const values = [...members.values()].sort((a, b) => `${a.kind}:${a.id}:${a.role}`.localeCompare(`${b.kind}:${b.id}:${b.role}`))
  return ReportCreativeIdentitySchema.parse({
    version: 1, basis: 'current_meta_configuration', observedAt,
    structure: conflict ? 'unknown' : assetFeed ? 'asset_feed' : carousel ? 'carousel'
      : values.filter(item => item.role === 'media').length === 1 && !hasUnresolvedMedia([...unresolved]) ? 'single' : 'unknown',
    members: values, unresolvedSourcePaths: [...unresolved].sort(), completeness: 'observed_fields_only',
  })
}

/** A multi-member creative has no single video whose duration can represent the creative. */
export function singleCreativeVideoId(identity: ReportCreativeIdentity): string | null {
  const media = identity.members.filter(member => member.role === 'media')
  return (identity.structure === 'single' || identity.structure === 'asset_feed')
    && !hasUnresolvedMedia(identity.unresolvedSourcePaths) && media.length === 1 && media[0].kind === 'video' ? media[0].id : null
}
