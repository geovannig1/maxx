import 'server-only'
import type { getAdminClient } from '@/lib/supabase/admin'
import { accountTimezone, businessDateOf, metaOutcomeEventName } from '@/config/business-config'
import { BUSINESS_PROFILE, EXAMPLE_BUSINESS_PROFILE, type BusinessProfile } from '@/config/business-profile'
import { isDemoMode } from '@/config/demo'
import { SPEND_FLOORS } from '@/config/spend-floors'
import { getAdPlatform } from '@/lib/platforms/registry'
import { BUDGET_HARD_CAP } from '@/lib/writes/executor'
import { maxBudgetChangePercent } from '@/lib/writes/owner-change-policy'
import { writeStateBackend } from '@/lib/writes/write-state-backend'
import { currencyMismatch } from '@/lib/writes/write-currency'
import { normalizeMetaAccountId } from '@/lib/writes/meta-live-state'
import { readBank, scoreCopy } from '@/lib/creative/copy-studio'
import { META_CTAS, type CopyAngle } from '@/lib/creative/copy-rules'
import type { PlanCopy, OptimizationGoal } from './plan-spec'
import type { PlanAsset, PlanAudienceOption, PlanDraftContext } from './plan-template'
import type { PlanValidationContext } from './plan-validation'
import type { ReadinessContext } from './plan-readiness'

// ADR-062: everything the planner, the validator and the readiness checklist need from the account,
// read once per request from the synced warehouse (audiences, creatives, the copy bank) and, for the
// active budget total, from Meta (or the sample database in demo mode). A failed read is reported,
// never treated as an empty account.

type Db = ReturnType<typeof getAdminClient>

export interface PlanAccount {
  id: string
  metaAccountId: string
  currency: string
  timezone: string
  pixelId: string | null
  pageId: string | null
}

export interface LoadedPlanContext {
  account: PlanAccount
  draft: PlanDraftContext
  validation: PlanValidationContext
  readiness: ReadinessContext
}

export type PlanContextResult = { ok: true; context: LoadedPlanContext } | { ok: false; code: string }

const AUDIENCE_LIMIT = 200
const CREATIVE_LIMIT = 100

/** Meta's daily minimum per ad set, as a multiple of the account's smallest daily budget unit. */
export function metaMinimumMultiple(goal: OptimizationGoal): number {
  return goal === 'OFFSITE_CONVERSIONS' ? 5 : 1
}

/** Hosts an ad may send people to: the configured landing hosts, plus the business profile's website
 *  once the profile is your own (the fictional example profile counts only in the demo). */
export function planLandingHosts(env: Record<string, string | undefined> = process.env, profile: BusinessProfile = BUSINESS_PROFILE, demo = isDemoMode()): string[] {
  const configured = (env.PAID_TOUCH_ALLOWED_LANDING_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
  const ownProfile = demo || profile.websiteUrl !== EXAMPLE_BUSINESS_PROFILE.websiteUrl
  const profileHosts = ownProfile ? [profile.websiteUrl, profile.bookingPageUrl].map((url) => { try { return new URL(url).hostname.toLowerCase() } catch { return '' } }) : []
  return [...new Set([...configured, ...profileHosts].filter(Boolean))]
}

export function defaultDestination(hosts: readonly string[], profile: BusinessProfile = BUSINESS_PROFILE): string | null {
  return [profile.bookingPageUrl, profile.websiteUrl].find((url) => {
    try { return hosts.includes(new URL(url).hostname.toLowerCase()) && url.startsWith('https://') } catch { return false }
  }) ?? null
}

async function readAccount(db: Db, accountId: string): Promise<PlanAccount | null> {
  const { data, error } = await db.from('ad_accounts').select('id, account_id, currency, timezone_name, pixel_id, facebook_page_id').eq('id', accountId).maybeSingle()
  if (error || !data) return null
  const row = data as { id: string; account_id: string; currency: string; timezone_name: string | null; pixel_id: string | null; facebook_page_id: string | null }
  return {
    id: row.id, metaAccountId: row.account_id, currency: row.currency, timezone: row.timezone_name ?? accountTimezone(),
    pixelId: row.pixel_id && /^\d{1,32}$/.test(row.pixel_id) ? row.pixel_id : null,
    pageId: row.facebook_page_id && /^\d{1,32}$/.test(row.facebook_page_id) ? row.facebook_page_id : null,
  }
}

async function readAudiences(db: Db, accountId: string): Promise<PlanAudienceOption[] | null> {
  const { data, error } = await db.from('custom_audiences')
    .select('audience_id, name, subtype, approximate_count, approximate_count_lower_bound, meta_account_id')
    .eq('ad_account_id', accountId).order('name', { ascending: true }).limit(AUDIENCE_LIMIT)
  if (error) return null
  return ((data ?? []) as Array<Record<string, unknown>>).filter((r) => /^\d{1,32}$/.test(String(r.audience_id))).map((r) => {
    const lower = r.approximate_count_lower_bound == null ? null : Number(r.approximate_count_lower_bound)
    const count = r.approximate_count == null ? null : Number(r.approximate_count)
    // Meta's "20" (or a withheld size) is a placeholder, not a count: report it as unknown.
    const size = lower !== null && lower > 1000 ? lower : count !== null && count > 1000 ? count : null
    return { id: String(r.audience_id), name: (r.name as string | null) ?? null, subtype: (r.subtype as string | null) ?? null, approximateCount: size, metaAccountId: normalizeMetaAccountId(r.meta_account_id) }
  })
}

async function readAssets(db: Db, accountId: string): Promise<PlanAsset[] | null> {
  const { data, error } = await db.from('creatives')
    .select('creative_id, creative_name, image_hash, video_id, thumbnail_url, link_url, url_tags')
    .eq('ad_account_id', accountId).order('last_synced_at', { ascending: false }).limit(CREATIVE_LIMIT)
  if (error) return null
  return ((data ?? []) as Array<Record<string, string | null>>).filter((r) => /^\d{1,32}$/.test(String(r.creative_id))).map((r, i) => ({
    ref: `A${i + 1}`, creativeId: String(r.creative_id), name: r.creative_name,
    imageHash: r.image_hash && /^[A-Za-z0-9_-]{6,64}$/.test(r.image_hash) ? r.image_hash : null,
    videoId: r.video_id && /^\d{1,32}$/.test(r.video_id) ? r.video_id : null,
    thumbnailUrl: r.thumbnail_url && r.thumbnail_url.startsWith('https://') ? r.thumbnail_url : null,
    linkUrl: r.link_url, urlTags: r.url_tags,
  }))
}

async function readCopy(db: Db, accountId: string): Promise<PlanCopy[]> {
  const bank = await readBank(db, accountId)
  return (bank ?? []).filter((v) => v.score.publishable && v.primary_text && v.headline && v.cta && (META_CTAS as readonly string[]).includes(v.cta))
    .sort((a, b) => b.score.score - a.score.score)
    .map((v) => ({ primary_text: v.primary_text as string, headline: v.headline as string, description: v.description ?? '', cta: v.cta as PlanCopy['cta'], angle: (v.angle as CopyAngle | null) ?? null }))
}

/** Read the plan context for one account. */
export async function loadPlanContext(db: Db, accountId: string): Promise<PlanContextResult> {
  const account = await readAccount(db, accountId)
  if (!account) return { ok: false, code: 'ACCOUNT_UNAVAILABLE' }
  const [audiences, assets, copyBank] = await Promise.all([readAudiences(db, accountId), readAssets(db, accountId), readCopy(db, accountId)])
  if (audiences === null || assets === null) return { ok: false, code: 'PLAN_CONTEXT_UNAVAILABLE' }
  const units = getAdPlatform('meta').budgetUnits
  const currency = account.currency
  const toMinor = (major: number) => Math.round(units.toMinor(major, currency))
  const minDailyMinor = (goal: OptimizationGoal) => toMinor(SPEND_FLOORS.minDailyBudget * metaMinimumMultiple(goal))
  const activeMajor = await writeStateBackend(db, accountId, currency).accountDailyBudgetTotal(account.metaAccountId, currency).catch(() => null)
  const landingHosts = planLandingHosts()
  const today = businessDateOf(new Date(), account.timezone)
  const outcomeEvent = metaOutcomeEventName()
  return {
    ok: true,
    context: {
      account,
      draft: {
        currency, today, pixelId: account.pixelId, pageId: account.pageId, outcomeEvent, landingHosts,
        defaultDestination: defaultDestination(landingHosts), audiences, assets, copyBank, toMinor, minDailyMinor,
      },
      validation: {
        accountCurrency: currency, metaAccountId: normalizeMetaAccountId(account.metaAccountId) ?? account.metaAccountId, currencySupported: units.supports(currency), today,
        // The same guard as every ADR-059 money write (security review M2); re-run at execution.
        configuredCurrencyProblem: currencyMismatch(currency),
        minDailyBudgetMinor: minDailyMinor, ceilingMinor: toMinor(BUDGET_HARD_CAP),
        accountActiveDailyMinor: activeMajor === null ? null : toMinor(activeMajor), maxStepPercent: maxBudgetChangePercent(),
        pageId: account.pageId, pixelId: account.pixelId,
        audiences: new Map(audiences.map((a) => [a.id, { name: a.name, approximateCount: a.approximateCount, metaAccountId: a.metaAccountId }])),
        creativeIds: new Set(assets.map((a) => a.creativeId)),
        imageHashes: new Set(assets.flatMap((a) => (a.imageHash ? [a.imageHash] : []))),
        videoIds: new Set(assets.flatMap((a) => (a.videoId ? [a.videoId] : []))),
        thumbnailUrls: new Set(assets.flatMap((a) => (a.thumbnailUrl ? [a.thumbnailUrl] : []))),
        landingHosts, scoreCopy: (copy) => scoreCopy({ ...copy, hook: null }),
      },
      readiness: {
        landingHosts, outcomeEvent,
        creativeLinks: new Map(assets.map((a) => [a.creativeId, { linkUrl: a.linkUrl, urlTags: a.urlTags }])),
        audienceSizes: new Map(audiences.map((a) => [a.id, a.approximateCount])),
      },
    },
  }
}
