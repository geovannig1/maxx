// Resolve the EFFECTIVE UTMs Meta actually delivers for an ad — from wherever it stores them.
//
// The launch verdict kept saying "no UTMs" because it read one field (ads.url_tags / creatives.url_tags),
// but Meta stores tracking parameters in several places depending on creative type:
//   - the ad/creative `url_tags` field ("URL parameters" appended at delivery),
//   - `object_story_spec.link_data.url_tags` (link ads),
//   - the query string already baked into the destination LINK — `link_data.link` (link ads) or
//     `video_data.call_to_action.value.link` (VIDEO ads — the Example Studio launch case),
//   - `asset_feed_spec.link_urls[]` (Advantage+ / dynamic creatives).
// This resolves them in priority order and reports WHERE it found them, plus `captured` — whether we had
// anything at all to judge. `captured=false` ⇒ the caller must say "unverified", never "missing".

export type UtmSource = 'ad' | 'creative' | 'link' | 'asset_feed' | 'none'

export interface EffectiveUtms {
  /** The UTM query string to validate (no leading '?'), or null if none found. */
  utms: string | null
  /** The effective destination link, if one was synced. */
  link: string | null
  source: UtmSource
  /** Did we sync ANY url_tags or destination link to judge? false ⇒ unverified (not "missing"). */
  captured: boolean
}

export interface UtmSourceInputs {
  adUrlTags?: string | null
  creativeUrlTags?: string | null
  creativeLinkUrl?: string | null
  objectStorySpec?: unknown
  assetFeedSpec?: unknown
}

function clean(s: unknown): string | null {
  const t = typeof s === 'string' ? s.trim() : ''
  return t === '' ? null : t
}

/** The raw query string of a URL (the part after the first '?'), kept verbatim so Meta placeholders like
 *  {{campaign.name}} and any %3F corruption survive for the validator. Null if there's no query. */
export function queryStringOf(link: string | null | undefined): string | null {
  if (!link) return null
  const q = link.indexOf('?')
  if (q === -1) return null
  const raw = link.slice(q + 1).trim()
  return raw === '' ? null : raw
}

// Narrow, defensive readers over the jsonb blobs (shapes are `unknown` — never trust them structurally).
function get(obj: unknown, ...path: string[]): unknown {
  let cur = obj
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** The effective destination link, checking every place Meta puts it for the different creative types. */
export function effectiveLink(inputs: UtmSourceInputs): string | null {
  const oss = inputs.objectStorySpec
  const afs = inputs.assetFeedSpec
  const candidates = [
    get(oss, 'link_data', 'link'),
    get(oss, 'video_data', 'call_to_action', 'value', 'link'),
    // asset_feed_spec.link_urls is an array of { website_url, display_url }
    Array.isArray(get(afs, 'link_urls')) ? get((get(afs, 'link_urls') as unknown[])[0], 'website_url') : undefined,
    inputs.creativeLinkUrl,
  ]
  for (const c of candidates) {
    const v = clean(c)
    if (v) return v
  }
  return null
}

export function resolveEffectiveUtms(inputs: UtmSourceInputs): EffectiveUtms {
  const adTags = clean(inputs.adUrlTags)
  const creativeTags = clean(inputs.creativeUrlTags)
  const ossLinkDataTags = clean(get(inputs.objectStorySpec, 'link_data', 'url_tags'))
  const afsTags = Array.isArray(get(inputs.assetFeedSpec, 'link_urls'))
    ? clean(get((get(inputs.assetFeedSpec, 'link_urls') as unknown[])[0], 'url_tags'))
    : null
  const link = effectiveLink(inputs)
  const linkQuery = queryStringOf(link)

  // Priority: an explicit url_tags field wins; otherwise the UTMs baked into the destination link.
  let utms: string | null = null
  let source: UtmSource = 'none'
  if (adTags) { utms = adTags; source = 'ad' }
  else if (creativeTags) { utms = creativeTags; source = 'creative' }
  else if (ossLinkDataTags) { utms = ossLinkDataTags; source = 'creative' }
  else if (afsTags) { utms = afsTags; source = 'asset_feed' }
  else if (linkQuery) { utms = linkQuery; source = 'link' }

  // `captured` is true if we synced ANYTHING to judge (a url_tags field OR a destination link). If we
  // synced nothing (no url_tags and no link at all), we can't tell — the caller must say "unverified".
  const captured = Boolean(adTags || creativeTags || ossLinkDataTags || afsTags || link)

  return { utms, link, source, captured }
}
