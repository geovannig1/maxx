import { META_GRAPH_BASE } from './api-version'
import { fetchMetaGraph } from './client'

// Pixel status read for the tracking health monitor, moved unchanged from
// src/lib/tracking/health-monitor.ts. The credential is resolved by fetchMetaGraph
// from META_ACCESS_TOKEN (trimmed), exactly as the monitor resolved it before.

/** The pixel's JSON body (`name`, `last_fired_time`, `event_stats`, or a Graph `error`). Throws when
 * the endpoint returns no JSON-readable response. */
export async function fetchPixelStatus(pixelId: string): Promise<unknown> {
  const pixelUrl = new URL(`${META_GRAPH_BASE}/${pixelId}`)
  pixelUrl.searchParams.set('fields', 'name,last_fired_time,event_stats')

  const pixelRes = await fetchMetaGraph(pixelUrl, {})
  if (!pixelRes || typeof pixelRes !== 'object' || typeof (pixelRes as { json?: unknown }).json !== 'function') {
    throw new Error('Meta pixel endpoint returned no JSON response')
  }
  return pixelRes.json()
}
