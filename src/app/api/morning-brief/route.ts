import { ownerOnly } from '@/lib/auth/require-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { nyDaysAgo } from '@/lib/utils/date-utils'
import {
  containsUngovernedActionLanguage,
  DIAGNOSTIC_ONLY_COPY,
  projectCurrentActionableTasks,
} from '@/lib/authority/diagnostic-surface'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'

export const runtime = 'nodejs'

type DailyDeliveryRow = {
  total_spend: number | string | null
  total_bookings: number | string | null
}

export type MorningMetaDelivery =
  | {
      available: true
      spend: number
      modelled_results: number
      evidence_basis: 'meta_modelled'
      action_authority: 'diagnostic_only'
    }
  | {
      available: false
      spend: null
      modelled_results: null
      evidence_basis: 'meta_modelled'
      action_authority: 'diagnostic_only'
      unavailable_reason: 'no_committed_daily_report' | 'incomplete_committed_daily_report'
    }

function finiteNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/**
 * Project yesterday's Meta report as raw delivery context only. `total_bookings` is Meta's modelled
 * result count; it is not joined to the outcome ledger and therefore cannot produce CPA/ROAS or status.
 */
export function projectMorningMetaDelivery(row: DailyDeliveryRow | null): MorningMetaDelivery {
  if (!row) {
    return {
      available: false,
      spend: null,
      modelled_results: null,
      evidence_basis: 'meta_modelled',
      action_authority: 'diagnostic_only',
      unavailable_reason: 'no_committed_daily_report',
    }
  }
  const spend = finiteNumber(row.total_spend)
  const modelledResults = finiteNumber(row.total_bookings)
  if (spend === null || modelledResults === null) {
    return {
      available: false,
      spend: null,
      modelled_results: null,
      evidence_basis: 'meta_modelled',
      action_authority: 'diagnostic_only',
      unavailable_reason: 'incomplete_committed_daily_report',
    }
  }
  return {
    available: true,
    spend,
    modelled_results: modelledResults,
    evidence_basis: 'meta_modelled',
    action_authority: 'diagnostic_only',
  }
}

function accountResolutionFailure(reason: 'not_found' | 'ambiguous' | 'unavailable'): Response {
  const status = reason === 'not_found' ? 404 : reason === 'ambiguous' ? 409 : 503
  return Response.json({
    error: reason === 'ambiguous'
      ? 'More than one active ad account is configured'
      : reason === 'not_found'
        ? 'No active ad account found'
        : 'The active ad account could not be resolved',
    code: activeAccountErrorCode(reason),
  }, { status })
}

function readFailure(section: string): Response {
  return Response.json({
    error: 'Morning brief data is temporarily unavailable',
    code: 'MORNING_BRIEF_READ_FAILED',
    section,
  }, { status: 503 })
}

function observationCopy(flagType: string): string {
  return flagType === 'creative_refresh'
    ? 'A creative-delivery diagnostic was recorded for this entity. Review its current evidence before considering a change.'
    : 'A delivery diagnostic was recorded for this entity. Review its current evidence before considering a change.'
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) return accountResolutionFailure(activeAccount.reason)
  const adAccountId = activeAccount.account.id
  const yesterday = nyDaysAgo(1)
  const yesterday24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const { data: report, error: reportError } = await db
    .from('daily_reports')
    .select('total_spend, total_bookings')
    .eq('ad_account_id', adAccountId)
    .eq('report_date', yesterday)
    .maybeSingle()
  if (reportError) return readFailure('daily_reports')
  const meta_delivery = projectMorningMetaDelivery(report as DailyDeliveryRow | null)

  const { data: flagsRaw, error: flagsError } = await db
    .from('flags')
    .select('flag_type, meta_adset_id, meta_ad_id, adset_id, ad_id')
    .eq('ad_account_id', adAccountId)
    .eq('is_active', true)
    .order('flag_date', { ascending: false })
    .limit(1)
  if (flagsError) return readFailure('flags')

  const flag = (flagsRaw?.[0] ?? null) as {
    flag_type: string
    meta_adset_id: string | null
    meta_ad_id: string | null
    adset_id: string | null
    ad_id: string | null
  } | null
  let top_observation: {
    entity_name: string
    observation: string
    evidence_basis: 'meta_modelled'
    action_authority: 'diagnostic_only'
  } | null = null

  if (flag) {
    let entityName = flag.meta_adset_id ?? flag.meta_ad_id ?? 'Unknown entity'
    if (flag.adset_id) {
      const { data: adset, error } = await db
        .from('adsets')
        .select('adset_name')
        .eq('ad_account_id', adAccountId)
        .eq('id', flag.adset_id)
        .maybeSingle()
      if (error) return readFailure('adsets')
      entityName = (adset as { adset_name: string | null } | null)?.adset_name ?? entityName
    } else if (flag.ad_id) {
      const { data: ad, error } = await db
        .from('ads')
        .select('ad_name')
        .eq('ad_account_id', adAccountId)
        .eq('id', flag.ad_id)
        .maybeSingle()
      if (error) return readFailure('ads')
      entityName = (ad as { ad_name: string | null } | null)?.ad_name ?? entityName
    }
    top_observation = {
      entity_name: entityName,
      observation: observationCopy(flag.flag_type),
      evidence_basis: 'meta_modelled',
      action_authority: 'diagnostic_only',
    }
  }

  const { data: taskRows, error: taskError } = await db
    .from('audit_tasks')
    .select('id, title, description, recommendation, priority, action_decision:action_decisions(authority_tier, policy_version, authority_reason, owner_copy)')
    .eq('ad_account_id', adAccountId)
    .in('status', ['open', 'in_progress'])
    .in('priority', ['urgent', 'high'])
    .order('priority', { ascending: true })
    .limit(100)
  if (taskError) return readFailure('audit_tasks')
  const projectedTask = projectCurrentActionableTasks((taskRows ?? []) as Array<Record<string, unknown>>)[0] ?? null
  const action_today = projectedTask
    ? {
        copy: String(projectedTask.recommendation ?? projectedTask.description ?? ''),
        tier: projectedTask.action_authority_tier,
      }
    : null

  // Competitor ads inherit account ownership through competitor_sources; competitor_ads itself has no
  // ad_account_id column. Resolve the owned source IDs first so another account's rows cannot leak in.
  const { data: competitorSources, error: competitorSourceError } = await db
    .from('competitor_sources')
    .select('id')
    .eq('ad_account_id', adAccountId)
  if (competitorSourceError) return readFailure('competitor_sources')
  const competitorIds = (competitorSources ?? []).map((row) => String((row as { id: string }).id))

  let new_competitor_ads = 0
  let competitor_alert: string | null = null
  if (competitorIds.length > 0) {
    const { count: newAdsCount, error: competitorCountError } = await db
      .from('competitor_ads')
      .select('id', { count: 'exact', head: true })
      .in('competitor_id', competitorIds)
      .gte('created_at', yesterday24h)
    if (competitorCountError) return readFailure('competitor_ads')
    new_competitor_ads = newAdsCount ?? 0

    if (new_competitor_ads > 0) {
      const { data: newAds, error: competitorReadError } = await db
        .from('competitor_ads')
        .select('page_name')
        .in('competitor_id', competitorIds)
        .gte('created_at', yesterday24h)
        .limit(5)
      if (competitorReadError) return readFailure('competitor_ads')
      const names = [...new Set((newAds ?? []).map((row) => (row as { page_name: string | null }).page_name).filter(Boolean))]
      if (names.length === 1) competitor_alert = `${names[0]} published ${new_competitor_ads} new ad${new_competitor_ads !== 1 ? 's' : ''}`
      else if (names.length > 1) competitor_alert = `${names[0]} and ${names.length - 1} others published ${new_competitor_ads} new ads`
    }
  }

  // Owner-approved external research remains diagnostic context; approval is not an ActionDecision.
  const { data: insightRaw, error: insightError } = await db
    .from('expert_insights')
    .select('title, why_it_applies, expert_sources(name)')
    .eq('ad_account_id', adAccountId)
    .eq('applies_to_account', true)
    .eq('review_status', 'approved')
    .order('published_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (insightError) return readFailure('expert_insights')

  let trend_signal: {
    title: string
    context: string
    source: string
    evidence_basis: 'external_research'
    action_authority: 'diagnostic_only'
  } | null = null
  if (insightRaw) {
    const insight = insightRaw as unknown as {
      title: string
      why_it_applies: string | null
      expert_sources: { name: string } | { name: string }[] | null
    }
    const sourceName = Array.isArray(insight.expert_sources)
      ? (insight.expert_sources[0]?.name ?? 'Unknown')
      : (insight.expert_sources?.name ?? 'Unknown')
    const unsafe = containsUngovernedActionLanguage(`${insight.title}\n${insight.why_it_applies ?? ''}`)
    trend_signal = {
      title: unsafe ? 'Owner-approved external trend observation' : insight.title,
      context: unsafe ? DIAGNOSTIC_ONLY_COPY : (insight.why_it_applies ?? 'No account-specific context was recorded.'),
      source: sourceName,
      evidence_basis: 'external_research',
      action_authority: 'diagnostic_only',
    }
  }

  const { data: campaigns, error: campaignsError } = await db
    .from('campaigns')
    .select('status')
    .eq('ad_account_id', adAccountId)
    .limit(20)
  if (campaignsError) return readFailure('campaigns')
  let campaigns_status: 'active' | 'all_paused' | 'no_data' = 'no_data'
  if (campaigns && campaigns.length > 0) {
    const allPaused = (campaigns as Array<{ status: string }>).every((campaign) => campaign.status === 'PAUSED' || campaign.status === 'ARCHIVED')
    campaigns_status = allPaused ? 'all_paused' : 'active'
  }

  return Response.json({
    account: { id: adAccountId, name: activeAccount.account.accountName },
    meta_delivery,
    top_observation,
    action_today,
    new_competitor_ads,
    competitor_alert,
    trend_signal,
    campaigns_status,
    generated_at: new Date().toISOString(),
  })
}
