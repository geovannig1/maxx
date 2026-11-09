import { getAdminClient } from '@/lib/supabase/admin'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { aiStatus } from '@/lib/ai'
import { getOutcomeAdapter } from '@/lib/outcomes/registry'

export const runtime = 'nodejs'

// Read-only system-health snapshot for the Settings → Data Sources panel. Returns booleans +
// timestamps ONLY — never secret values. Auth-gated like the other dashboard APIs.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const db = getAdminClient()

  // Sync health (Meta + cron freshness) from the sync log.
  let lastSuccessAt: string | null = null
  let latestStatus: string | null = null
  let latestError: string | null = null
  try {
    const { data: lastOk } = await db
      .from('api_sync_logs').select('completed_at').eq('status', 'success')
      .order('completed_at', { ascending: false }).limit(1).maybeSingle()
    lastSuccessAt = (lastOk?.completed_at as string | null) ?? null
    const { data: latest } = await db
      .from('api_sync_logs').select('status, error_message')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    latestStatus = (latest?.status as string | null) ?? null
    latestError = (latest?.error_message as string | null) ?? null
  } catch { /* log table unavailable */ }

  const hoursSinceSync = lastSuccessAt ? (Date.now() - new Date(lastSuccessAt).getTime()) / 3_600_000 : null

  // GA4 is "configured" when both env pieces exist and the JSON parses (we do NOT make a live GA4
  // call here — that would be slow and burn quota; the daily job verifies the actual fetch).
  let ga4Configured = false
  try {
    ga4Configured = !!process.env.GA4_PROPERTY_ID && !!process.env.GA4_SERVICE_ACCOUNT_JSON &&
      !!JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON).private_key
  } catch { ga4Configured = false }

  // Provider and model names only; the configuration reader never exposes a credential.
  const ai = aiStatus()

  // Enabled outcome sources (every account), each described by its adapter's own health check.
  let outcomeSources: Array<{ kind: string; configured: boolean; detail: string }> = []
  try {
    const { data } = await db.from('outcome_sources').select('kind').eq('enabled', true)
    const kinds = [...new Set((data ?? []).map((row) => String(row.kind)))].sort()
    outcomeSources = await Promise.all(kinds.map(async (kind) => {
      const adapter = getOutcomeAdapter(kind)
      if (!adapter) return { kind, configured: false, detail: 'no adapter for this source kind' }
      const health = await adapter.health()
      return { kind, configured: health.configured, detail: health.detail }
    }))
  } catch { outcomeSources = [] }

  const sources = [
    {
      key: 'meta', name: 'Meta Marketing API', role: 'Delivery (spend, impressions, clicks, CTR)',
      status: process.env.META_ACCESS_TOKEN ? (latestStatus === 'failed' ? 'error' : 'connected') : 'disconnected',
      detail: lastSuccessAt ? `Last sync ${hoursSinceSync !== null ? Math.round(hoursSinceSync) + 'h ago' : '—'}` : 'No successful sync yet',
      error: latestStatus === 'failed' ? (latestError ?? 'Last sync attempt failed') : null,
      confidenceImpact: 'Without it, no delivery data at all.',
    },
    {
      key: 'outcomes', name: 'Outcome sources (ledger)', role: 'Business outcomes and their value — BUSINESS TRUTH',
      status: outcomeSources.some((source) => source.configured) ? 'configured' : 'disconnected',
      detail: outcomeSources.length
        ? outcomeSources.map((source) => `${source.kind}: ${source.detail}`).join(' · ')
        : 'No outcome source enabled',
      error: null,
      confidenceImpact: 'Without it, business outcomes and their value are unavailable; GA telemetry is never a fallback.',
    },
    {
      key: 'ga4', name: 'GA4 (website → GA4)', role: 'Session-channel and campaign confirmation telemetry',
      status: ga4Configured ? 'configured' : 'disconnected',
      detail: ga4Configured ? `Property ${process.env.GA4_PROPERTY_ID}` : 'Service account / property not configured',
      error: null,
      confidenceImpact: 'Without it, session-channel diagnostics are unavailable. Paid ROAS independently requires the complete exact appointment join and authoritative spend.',
    },
    {
      key: 'supabase', name: 'Supabase (warehouse)', role: 'System store',
      status: 'connected', detail: 'Queried successfully for this request', error: null,
      confidenceImpact: 'Without it, the app cannot read any data.',
    },
    {
      key: 'llm', name: 'AI provider', role: 'Maxx chat, creative vision, competitor and signal analysis (optional)',
      status: ai.state === 'on' ? 'configured' : ai.state === 'misconfigured' ? 'error' : 'not_configured',
      detail: ai.state === 'on'
        ? `Provider: ${ai.provider}, model: ${ai.model}`
        : ai.state === 'misconfigured' ? 'AI configuration is invalid — run npm run doctor' : 'AI is off (AI_PROVIDER=none or not set)',
      error: ai.state === 'misconfigured' ? ai.errors.join(' ') : null,
      confidenceImpact: 'Optional. Every report, diagnostic and data page works without AI; only AI features are off.',
    },
    {
      key: 'sentry', name: 'Sentry (monitoring)', role: 'Alerting',
      status: (process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN) ? 'configured' : 'not_configured',
      detail: (process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN) ? 'DSN set — alerts will emit' : 'No DSN — alerts are silent',
      error: null,
      confidenceImpact: 'Without it, failures are logged but no one is paged.',
    },
    {
      key: 'cron', name: 'Scheduled sync (cron)', role: 'Freshness',
      status: lastSuccessAt && hoursSinceSync !== null && hoursSinceSync <= REC_THRESHOLDS.MAX_DATA_AGE_HOURS ? 'connected' : (lastSuccessAt ? 'stale' : 'disconnected'),
      detail: 'Daily 10:00 + midday 17:00 (Hobby timing approximate)',
      error: null,
      confidenceImpact: 'Without it, data goes stale and recommendations weaken.',
    },
  ]

  return Response.json({
    sources,
    write_mode_enabled: process.env.WRITE_MODE_ENABLED === 'true',
    owner_email_set: !!process.env.OWNER_EMAIL,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
    // Freshness for the persistent PageHeader chip.
    last_success_at: lastSuccessAt,
    hours_since_sync: hoursSinceSync,
    latest_sync_failed: latestStatus === 'failed',
  })
}
