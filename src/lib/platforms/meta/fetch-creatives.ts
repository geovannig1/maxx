import 'server-only'
import type { MetaCreative } from '@/types/meta-api'
import { META_GRAPH_BASE } from '@/lib/platforms/meta/api-version'

const META_BASE_URL = META_GRAPH_BASE
const BATCH_SIZE = 50

const CREATIVE_FIELDS = [
  'id',
  'name',
  'status',
  'object_type',
  'body',
  'title',
  'call_to_action_type',
  'link_url',
  'url_tags',
  'instagram_permalink_url',
  'image_url',
  'image_hash',
  'video_id',
  'thumbnail_url',
  'object_story_spec',
  'asset_feed_spec',
].join(',')

interface BatchResponseItem {
  code: number
  body: string
}

/**
 * Batch-fetch creatives by ID using the Graph API batch endpoint.
 * Processes up to 50 IDs per batch request.
 */
export async function fetchCreatives(creativeIds: string[]): Promise<MetaCreative[]> {
  if (creativeIds.length === 0) return []

  const accessToken = process.env.META_ACCESS_TOKEN ?? ''
  const results: MetaCreative[] = []

  // Process in chunks of BATCH_SIZE
  for (let i = 0; i < creativeIds.length; i += BATCH_SIZE) {
    const chunk = creativeIds.slice(i, i + BATCH_SIZE)

    const batch = chunk.map((id) => ({
      method: 'GET',
      relative_url: `${id}?fields=${CREATIVE_FIELDS}`,
    }))

    const formData = new URLSearchParams()
    formData.set('access_token', accessToken)
    formData.set('batch', JSON.stringify(batch))

    const response = await fetch(META_BASE_URL, {
      method: 'POST',
      body: formData,
    })

    const items = (await response.json()) as BatchResponseItem[]

    for (const item of items) {
      if (item.code !== 200) {
        console.warn(`[fetchCreatives] Non-200 batch item: ${item.code}`, item.body)
        continue
      }
      try {
        const creative = JSON.parse(item.body) as MetaCreative & { error?: { message: string } }
        if (creative.error) {
          console.warn('[fetchCreatives] Creative error:', creative.error.message)
          continue
        }
        results.push(creative)
      } catch {
        console.warn('[fetchCreatives] Failed to parse batch item body')
      }
    }
  }

  return results
}
