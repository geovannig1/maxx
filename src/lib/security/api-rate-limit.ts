import { getAdminClient } from '@/lib/supabase/admin'

interface ApiRateLimitOptions {
  bucket: string
  actorKey: string
  limit: number
  windowSeconds: number
}

interface ApiRateLimitRow {
  allowed: boolean
  retry_after_seconds: number
}

function unavailableResponse(): Response {
  return Response.json(
    { error: 'Request limit is temporarily unavailable.', code: 'RATE_LIMIT_UNAVAILABLE' },
    { status: 503 },
  )
}

export async function enforceApiRateLimit(options: ApiRateLimitOptions): Promise<Response | null> {
  if (
    !options.bucket.trim()
    || !options.actorKey.trim()
    || !Number.isSafeInteger(options.limit)
    || options.limit < 1
    || !Number.isSafeInteger(options.windowSeconds)
    || options.windowSeconds < 1
  ) {
    return unavailableResponse()
  }

  const { data, error } = await getAdminClient().rpc('consume_api_rate_limit', {
    p_actor_key: options.actorKey,
    p_bucket: options.bucket,
    p_limit: options.limit,
    p_window_seconds: options.windowSeconds,
  })

  const row = (Array.isArray(data) ? data[0] : data) as Partial<ApiRateLimitRow> | null
  if (
    error
    || typeof row?.allowed !== 'boolean'
    || typeof row.retry_after_seconds !== 'number'
    || !Number.isFinite(row.retry_after_seconds)
  ) {
    return unavailableResponse()
  }

  if (row.allowed) return null

  const retryAfter = Math.max(1, Math.ceil(row.retry_after_seconds))
  return Response.json(
    { error: 'Too many requests. Try again later.', code: 'RATE_LIMITED' },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  )
}
