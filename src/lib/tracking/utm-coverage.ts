import { getAdminClient } from '@/lib/supabase/admin'
import { validateUrlTags, computeCoverageStats, CANONICAL_UTM_STRING, type UtmDefect, type UtmVerdict, type UtmCoverageStats } from './utm-validator'
import { resolveEffectiveUtms, type UtmSource } from './effective-utms'

// UTM coverage loader — turns the synced warehouse rows into per-ad verdicts + a coverage number.
//
// Reads the EFFECTIVE UTMs Meta actually delivers (resolveEffectiveUtms): ad url_tags → creative
// url_tags → object_story_spec → the query string baked into the destination LINK (incl. video-ad CTA
// links) → asset_feed_spec. If nothing was synced to judge, the verdict is 'unverified' (NOT 'missing').
// Read-only: audits what the sync captured; the fix is copy-paste text the owner applies in Ads Manager.

export interface AdUtmHealth {
  meta_ad_id: string
  ad_name: string | null
  campaign_name: string | null
  effective_status: string | null
  /** The effective UTM string that was judged (from url_tags or the destination link). */
  url_tags: string | null
  tags_source: UtmSource
  verdict: UtmVerdict
  defects: UtmDefect[]
  corrected: string
}

/** PURE: UTM offenders (verdict ≠ correct), deduped by ad, split into ACTIVE (actionable — scoped to what
 *  the coverage headline measures) vs paused/historical (cleanup only, so they never contradict a "100% of
 *  active ads correct" headline). A to-many creative join fanned out duplicate rows; dedup on meta_ad_id. */
export function splitUtmOffenders(ads: AdUtmHealth[]): { active: AdUtmHealth[]; historicalCount: number } {
  const seen = new Set<string>()
  const deduped = ads
    .filter((a) => a.verdict !== 'correct')
    .filter((a) => (seen.has(a.meta_ad_id) ? false : (seen.add(a.meta_ad_id), true)))
  return {
    active: deduped.filter((a) => a.effective_status === 'ACTIVE'),
    historicalCount: deduped.filter((a) => a.effective_status !== 'ACTIVE').length,
  }
}

export interface UtmCoverageResult extends UtmCoverageStats {
  /** What the headline coverage was computed over. `launch_cohort` when a cohort is passed; else active
   *  ads, falling back to all non-archived ads pre-launch. */
  scope: 'launch_cohort' | 'active_ads' | 'all_non_archived_ads'
  /** ALL non-archived ads (per-row status included) so paused ads can be fixed before re-enabling. */
  ads: AdUtmHealth[]
  source_label: string
}

const SOURCE_LABEL = 'Synced Meta creative spec — ad/creative url_tags + destination link (incl. video CTA link)'

/** Compute UTM coverage for the account. `adAccountDbId` optional — resolves the active account when
 *  omitted (MCP-tool convenience). Pass `opts.cohortMetaAdIds` to scope the headline coverage to a launch
 *  cohort (the staged ads may be PAUSED, so the default "active ads" scope would measure stale ads). */
export async function computeUtmCoverage(
  adAccountDbId?: string,
  opts?: { cohortMetaAdIds?: string[] },
): Promise<UtmCoverageResult> {
  const db = getAdminClient()

  let accountId = adAccountDbId ?? null
  if (!accountId) {
    const { data: account } = await db.from('ad_accounts').select('id').eq('is_active', true).limit(1).maybeSingle()
    accountId = (account?.id as string | undefined) ?? null
  }
  if (!accountId) throw new Error('No active ad account — run a sync first.')

  const { data, error } = await db
    .from('ads')
    .select('ad_id, ad_name, effective_status, url_tags, creatives(url_tags, link_url, object_story_spec, asset_feed_spec), campaigns(campaign_name)')
    .eq('ad_account_id', accountId)
    .not('effective_status', 'in', '("ARCHIVED","DELETED")')
  if (error) throw new Error(`Could not load ads for UTM audit: ${error.message}`)

  const ads: AdUtmHealth[] = (data ?? []).map((row) => {
    const r = row as unknown as {
      ad_id: string
      ad_name: string | null
      effective_status: string | null
      url_tags: string | null
      creatives: { url_tags: string | null; link_url: string | null; object_story_spec: unknown; asset_feed_spec: unknown } | null
      campaigns: { campaign_name: string | null } | null
    }
    const eff = resolveEffectiveUtms({
      adUrlTags: r.url_tags,
      creativeUrlTags: r.creatives?.url_tags,
      creativeLinkUrl: r.creatives?.link_url,
      objectStorySpec: r.creatives?.object_story_spec,
      assetFeedSpec: r.creatives?.asset_feed_spec,
    })
    // Nothing synced to judge ⇒ UNVERIFIED (not a confident "missing"). Otherwise validate the effective UTMs.
    const v = eff.captured
      ? validateUrlTags(eff.utms)
      : {
          verdict: 'unverified' as UtmVerdict,
          defects: [{ code: 'no_url_tags' as const, detail: 'Tracking could not be read from any synced source (no url_tags and no destination link captured) — re-sync to confirm. This is NOT evidence that UTMs are missing.' }],
          corrected: CANONICAL_UTM_STRING,
        }
    return {
      meta_ad_id: r.ad_id,
      ad_name: r.ad_name,
      campaign_name: r.campaigns?.campaign_name ?? null,
      effective_status: r.effective_status,
      url_tags: eff.utms,
      tags_source: eff.source,
      verdict: v.verdict,
      defects: v.defects,
      corrected: v.corrected,
    }
  })

  // Headline coverage scope (audit Bug 2 / cohort scoping): if a launch cohort is supplied, measure THAT
  // — the new staged ads may be PAUSED, so an "active ads" filter would wrongly measure stale old ads and
  // report a false 0%. Otherwise: active ads (what's spending), falling back to all non-archived pre-launch.
  let scoped: AdUtmHealth[]
  let scope: UtmCoverageResult['scope']
  if (opts?.cohortMetaAdIds && opts.cohortMetaAdIds.length > 0) {
    const cohort = new Set(opts.cohortMetaAdIds)
    scoped = ads.filter((a) => cohort.has(a.meta_ad_id))
    scope = 'launch_cohort'
  } else {
    const active = ads.filter((a) => a.effective_status === 'ACTIVE')
    scoped = active.length > 0 ? active : ads
    scope = active.length > 0 ? 'active_ads' : 'all_non_archived_ads'
  }
  const stats = computeCoverageStats(scoped.map((a) => a.verdict))

  return {
    ...stats,
    scope,
    ads,
    source_label: SOURCE_LABEL,
  }
}
