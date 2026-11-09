import 'server-only'
import { getAdminClient } from '@/lib/supabase/admin'
import { META_GRAPH_BASE } from '@/lib/platforms/meta/api-version'
import { fetchMetaGraph } from '@/lib/platforms/meta/client'

const GRAPH_BASE = META_GRAPH_BASE

interface PageSearchResult {
  id: string
  name: string
  instagram_business_account?: { id: string; username?: string }
}

interface PageSearchResponse {
  data: PageSearchResult[]
  error?: { message: string; code: number }
}

export async function lookupFacebookPageId(
  instagramHandle: string
): Promise<string | null> {
  const accessToken = process.env.META_ACCESS_TOKEN
  if (!accessToken) {
    console.warn('[PageLookup] META_ACCESS_TOKEN not set')
    return null
  }

  const url = new URL(`${GRAPH_BASE}/pages/search`)
  url.searchParams.set('q', instagramHandle)
  url.searchParams.set('fields', 'id,name,instagram_business_account')

  let resp: Response
  try {
    resp = await fetchMetaGraph(url, {}, accessToken)
  } catch (err) {
    console.warn(`[PageLookup] Network error for handle "${instagramHandle}"`, err)
    return null
  }

  let json: PageSearchResponse
  try {
    json = (await resp.json()) as PageSearchResponse
  } catch {
    console.warn(`[PageLookup] Failed to parse response for "${instagramHandle}"`)
    return null
  }

  if (json.error) {
    console.warn(`[PageLookup] API error for "${instagramHandle}"`, json.error)
    return null
  }

  if (!Array.isArray(json.data) || json.data.length === 0) {
    console.warn(`[PageLookup] No pages found for handle "${instagramHandle}"`)
    return null
  }

  // Prefer a page whose Instagram account username matches the handle
  const normalised = instagramHandle.toLowerCase().replace(/^@/, '')

  for (const page of json.data) {
    const igUsername = page.instagram_business_account?.username?.toLowerCase()
    if (igUsername && igUsername === normalised) {
      return page.id
    }
  }

  // Fall back: return the first result's ID as best-effort
  const fallback = json.data[0]
  console.warn(
    `[PageLookup] No exact Instagram match for "${instagramHandle}" — using first result: ${fallback.name} (${fallback.id})`
  )
  return fallback.id
}

// Instagram handle → substring to match in competitor_sources.instagram_url, for competitors whose
// Facebook page id should be resolved automatically. Ships empty; add your own market's handles here
// (or set facebook_page_id on the competitor directly in the app).
const COMPETITOR_HANDLES: Record<string, string> = {}

export async function seedCompetitorPageIds(): Promise<void> {
  const db = getAdminClient()

  const { data: sources, error } = await db
    .from('competitor_sources')
    .select('id, name, instagram_url, facebook_page_id')
    .is('facebook_page_id', null)

  if (error) {
    console.error('[PageLookup] Failed to fetch competitor sources', error)
    return
  }

  if (!sources || sources.length === 0) {
    console.log('[PageLookup] No competitors without facebook_page_id')
    return
  }

  for (const [handle, urlFragment] of Object.entries(COMPETITOR_HANDLES)) {
    const matching = (sources as Array<{
      id: string
      name: string
      instagram_url: string | null
      facebook_page_id: string | null
    }>).filter(
      (s) => s.instagram_url && s.instagram_url.includes(urlFragment)
    )

    for (const source of matching) {
      const pageId = await lookupFacebookPageId(handle)
      if (pageId) {
        const { error: updateErr } = await db
          .from('competitor_sources')
          .update({ facebook_page_id: pageId })
          .eq('id', source.id)

        if (updateErr) {
          console.warn(`[PageLookup] Failed to update ${source.name}`, updateErr)
        } else {
          console.log(`[PageLookup] Updated ${source.name} → page_id ${pageId}`)
        }
      }
    }
  }
}
