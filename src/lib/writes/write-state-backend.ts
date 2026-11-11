import 'server-only'
import type { getAdminClient } from '@/lib/supabase/admin'
import { isDemoMode } from '@/config/demo'
import { roundMoney } from '@/lib/utils/format-currency'
import { activeAccountConfiguredDailyBudget, captureState, type WriteActionType } from './executor'
import { fromMetaMinorUnits, toMetaMinorUnits } from './write-preconditions'
import { META_SNAPSHOT_CONTRACT_VERSION, normalizeMetaAccountId, projectWriteSnapshot } from './meta-live-state'

// ADR-059: where an owner proposal reads the target's current state. Normally Meta (the same reads the
// executor re-runs before any mutation). In demo mode (`npm run demo`, refused in production and on
// Vercel) there is no Meta: the sample database stands in, in the same snapshot shape.

type Db = ReturnType<typeof getAdminClient>

export interface WriteStateBackend {
  kind: 'meta' | 'demo'
  readSnapshot(actionType: WriteActionType, entityId: string): Promise<Record<string, unknown> | null>
  accountDailyBudgetTotal(metaAccountId: string, currency: string): Promise<number | null>
}

// Budget units of the governed write path's platform (see write-preconditions.ts).
const toMinor = (major: number, currency: string) => toMetaMinorUnits(major, currency)
const fromMinor = (minor: number, currency: string) => fromMetaMinorUnits(minor, currency)

export function writeStateBackend(db: Db, accountId: string, currency: string): WriteStateBackend {
  if (isDemoMode()) return demoBackend(db, accountId, currency)
  return {
    kind: 'meta',
    readSnapshot: async (actionType, entityId) => {
      try { return await captureState(actionType, entityId) } catch { return null }
    },
    accountDailyBudgetTotal: (metaAccountId, accountCurrencyCode) => activeAccountConfiguredDailyBudget(metaAccountId, accountCurrencyCode),
  }
}

/** Meta's minor-unit budget in major units of the account currency. */
export function snapshotBudgetToMajor(currency: string) {
  return (minor: unknown) => (minor == null || minor === '' ? Number.NaN : fromMinor(Number(minor), currency))
}

export function majorToMinor(currency: string) {
  return (major: number) => toMinor(major, currency)
}

interface LocalRow { id: string; status: string | null; daily_budget: number | null; lifetime_budget?: number | null }

function demoBackend(db: Db, accountId: string, currency: string): WriteStateBackend {
  const metaAccount = async () => {
    const { data } = await db.from('ad_accounts').select('account_id').eq('id', accountId).maybeSingle()
    return normalizeMetaAccountId((data as { account_id?: string } | null)?.account_id)
  }
  return {
    kind: 'demo',
    async readSnapshot(actionType, entityId) {
      const account = await metaAccount()
      if (!account) return null
      if (actionType === 'pause_ad' || actionType === 'activate_ad') {
        const { data: ad } = await db.from('ads').select('ad_id, ad_name, status, adset_id, campaign_id')
          .eq('ad_account_id', accountId).eq('ad_id', entityId).maybeSingle()
        const row = ad as { ad_name: string | null; status: string | null; adset_id: string; campaign_id: string } | null
        if (!row) return null
        const [{ data: adset }, { data: campaign }] = await Promise.all([
          db.from('adsets').select('adset_id').eq('id', row.adset_id).maybeSingle(),
          db.from('campaigns').select('campaign_id').eq('id', row.campaign_id).maybeSingle(),
        ])
        return projectWriteSnapshot(actionType, entityId, {
          id: entityId, account_id: account, name: row.ad_name, status: row.status,
          adset_id: (adset as { adset_id?: string } | null)?.adset_id, campaign_id: (campaign as { campaign_id?: string } | null)?.campaign_id,
        })
      }
      const { data: adset } = await db.from('adsets').select('adset_id, adset_name, status, daily_budget, lifetime_budget, campaign_id')
        .eq('ad_account_id', accountId).eq('adset_id', entityId).maybeSingle()
      const row = adset as { adset_name: string | null; status: string | null; daily_budget: number | null; lifetime_budget: number | null; campaign_id: string } | null
      if (!row) return null
      const { data: campaign } = await db.from('campaigns').select('campaign_id').eq('id', row.campaign_id).maybeSingle()
      const snapshot = projectWriteSnapshot(actionType, entityId, {
        id: entityId, account_id: account, campaign_id: (campaign as { campaign_id?: string } | null)?.campaign_id,
        name: row.adset_name, status: row.status,
        daily_budget: row.daily_budget == null ? null : String(toMinor(Number(row.daily_budget), currency)),
        lifetime_budget: row.lifetime_budget == null ? null : String(toMinor(Number(row.lifetime_budget), currency)),
      })
      return snapshot && snapshot.snapshot_contract_version === META_SNAPSHOT_CONTRACT_VERSION ? snapshot : null
    },
    async accountDailyBudgetTotal() {
      // Same rule as the live total: active daily-CBO campaigns, plus active ad sets outside them.
      const [{ data: campaigns, error: campaignError }, { data: adsets, error: adsetError }] = await Promise.all([
        db.from('campaigns').select('id, status, daily_budget').eq('ad_account_id', accountId),
        db.from('adsets').select('id, status, daily_budget, campaign_id').eq('ad_account_id', accountId),
      ])
      if (campaignError || adsetError || !campaigns || !adsets) return null
      const cbo = new Set<string>()
      let total = 0
      for (const campaign of campaigns as LocalRow[]) {
        if (campaign.status !== 'ACTIVE' || campaign.daily_budget == null) continue
        cbo.add(campaign.id)
        total += Number(campaign.daily_budget)
      }
      for (const adset of adsets as Array<LocalRow & { campaign_id: string }>) {
        if (adset.status !== 'ACTIVE' || cbo.has(adset.campaign_id)) continue
        if (adset.daily_budget == null) return null
        total += Number(adset.daily_budget)
      }
      return Number.isFinite(total) ? roundMoney(total, currency) : null
    },
  }
}
