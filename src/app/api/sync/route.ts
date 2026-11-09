import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { runDailySync } from '@/lib/sync/orchestrator'
import { isDateWindow, resolveDateWindow } from '@/lib/utils/date-windows'
import { ownerOnly } from '@/lib/auth/require-owner'
import { enforceApiRateLimit } from '@/lib/security/api-rate-limit'
import { z } from 'zod'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'
export const maxDuration = 300

const MAX_EXPLICIT_SYNC_DAYS = 90
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const syncBodySchema = z.object({
  sync_type: z.enum(['full', 'incremental', 'insights_only']).optional(),
  date_window: z.string().optional(),
  date_range_start: z.string().max(10).optional(),
  date_range_end: z.string().max(10).optional(),
}).strict()

function parseIsoDate(value: string): number | null {
  if (!ISO_DATE.test(value)) return null
  const timestamp = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(timestamp)) return null
  return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null
}

function explicitRangeError(start?: string, end?: string): Response | null {
  if (!start && !end) return null
  if (!start || !end) {
    return Response.json(
      { error: 'Both date_range_start and date_range_end are required.', code: 'INVALID_SYNC_RANGE' },
      { status: 400 },
    )
  }

  const startMs = parseIsoDate(start)
  const endMs = parseIsoDate(end)
  if (startMs === null || endMs === null || startMs > endMs) {
    return Response.json(
      { error: 'Sync dates must be valid YYYY-MM-DD values in ascending order.', code: 'INVALID_SYNC_RANGE' },
      { status: 400 },
    )
  }

  const inclusiveDays = Math.floor((endMs - startMs) / 86_400_000) + 1
  if (inclusiveDays > MAX_EXPLICIT_SYNC_DAYS) {
    return Response.json(
      { error: `Explicit sync ranges are limited to ${MAX_EXPLICIT_SYNC_DAYS} days.`, code: 'SYNC_RANGE_TOO_LARGE' },
      { status: 400 },
    )
  }
  return null
}

// POST /api/sync — manual sync trigger
export async function POST(req: Request) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  let body: z.infer<typeof syncBodySchema> = {}
  try {
    const raw = await req.json().catch(() => ({}))
    body = syncBodySchema.parse(raw)
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const accountId = process.env.META_AD_ACCOUNT_ID
  if (!accountId) {
    return Response.json(
      { error: 'META_AD_ACCOUNT_ID not configured' },
      { status: 500 }
    )
  }

  // Resolve date window → absolute range (date_window takes priority over explicit range)
  let dateRangeStart = body.date_range_start
  let dateRangeEnd = body.date_range_end

  if (body.date_window) {
    if (!isDateWindow(body.date_window)) {
      return Response.json(
        { error: `Invalid date_window. Valid values: yesterday, last_3_days, last_7_days, previous_7_days, last_30_days, month_to_date` },
        { status: 400 }
      )
    }
    const resolved = resolveDateWindow(body.date_window)
    dateRangeStart = resolved.since
    dateRangeEnd = resolved.until
  } else {
    const invalidRange = explicitRangeError(dateRangeStart, dateRangeEnd)
    if (invalidRange) return invalidRange
  }

  const limited = await enforceApiRateLimit({
    bucket: 'manual_sync', actorKey: user.id, limit: 1, windowSeconds: 300,
  })
  if (limited) return limited

  try {
    const result = await runDailySync({
      adAccountId: accountId,
      triggeredBy: 'manual',
      dateRangeStart,
      dateRangeEnd,
    })

    if (result.error === 'sync_already_running') {
      return Response.json(
        { error: 'A sync is already running.', code: 'SYNC_ALREADY_RUNNING' },
        { status: 409 },
      )
    }

    return Response.json({
      log_id: result.logId,
      status: result.success ? 'success' : 'failed',
      message: result.success
        ? 'Sync completed successfully'
        : 'Sync completed with errors',
    })
  } catch (error) {
    return apiErrorResponse('POST /api/sync', 'SYNC_FAILED', error, 500)
  }
}

// GET /api/sync — recent sync logs
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const adminClient = getAdminClient()

  const { data, error } = await adminClient
    .from('api_sync_logs')
    .select('id, status, triggered_by, started_at, completed_at, duration_ms, campaigns_fetched, adsets_fetched, ads_fetched, insights_fetched, error_message, created_at')
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) {
    return apiErrorResponse('GET /api/sync', 'SYNC_LOG_READ_FAILED', error, 500)
  }

  const logs = data ?? []
  const latest = logs[0]

  // "synced Xm ago" is a last-sync-ATTEMPT clock, not the age of the data pages show —
  // a page can render week-old rows under a green "10m ago". dataThrough = the newest insight day
  // actually in the warehouse, so the Topbar can say "Data through <day> · synced Xm ago".
  // date_start is DESC-indexed (0001_baseline.sql) and equals date_stop on daily rows — same answer, no seq scan.
  const { data: newest } = await adminClient
    .from('daily_insights')
    .select('date_start')
    .order('date_start', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Shape that the Topbar component expects: { lastSync, status }
  return Response.json({
    lastSync: latest?.completed_at ?? latest?.started_at ?? null,
    dataThrough: (newest?.date_start as string | null) ?? null,
    status: latest?.status === 'running' ? 'running' : latest?.status === 'failed' ? 'error' : 'idle',
    campaigns: latest?.campaigns_fetched ?? 0,
    adsets: latest?.adsets_fetched ?? 0,
    ads: latest?.ads_fetched ?? 0,
    insights: latest?.insights_fetched ?? 0,
    logs,
  })
}
