import type { getAdminClient } from '@/lib/supabase/admin'

// Idempotent alert insert (audit finding 24G). The daily and midday syncs build alerts and plain-
// .insert() them, so re-running a sync (cron retry or a manual trigger) creates DUPLICATE rows for the
// same (account, date, type, entity). This dedupes against what's already stored for those days AND
// within the batch, then inserts only the fresh ones. No schema change required.

type AlertRow = Record<string, unknown>

const s = (v: unknown) => (v == null ? '' : String(v))
// severity is part of the key: a same-day re-run that ESCALATES warning->critical (e.g.
// after a restatement re-sync) must insert the escalated alert, not be skipped as a duplicate.
function keyOf(a: AlertRow): string {
  return [s(a.ad_account_id), s(a.alert_date), s(a.alert_type), s(a.severity), s(a.meta_campaign_id), s(a.meta_adset_id), s(a.meta_ad_id)].join('|')
}

export async function insertAlertsDeduped(
  db: ReturnType<typeof getAdminClient>,
  alerts: AlertRow[],
): Promise<{ inserted: number; skipped: number; error: string | null }> {
  if (alerts.length === 0) return { inserted: 0, skipped: 0, error: null }

  const accountIds = [...new Set(alerts.map((a) => s(a.ad_account_id)).filter(Boolean))]
  const dates = [...new Set(alerts.map((a) => s(a.alert_date)).filter(Boolean))]

  const seen = new Set<string>()
  if (accountIds.length && dates.length) {
    const { data: existing } = await db
      .from('alerts')
      .select('ad_account_id, alert_date, alert_type, severity, meta_campaign_id, meta_adset_id, meta_ad_id')
      .in('ad_account_id', accountIds)
      .in('alert_date', dates)
    for (const e of (existing ?? []) as AlertRow[]) seen.add(keyOf(e))
  }

  const fresh: AlertRow[] = []
  for (const a of alerts) {
    const k = keyOf(a)
    if (seen.has(k)) continue
    seen.add(k) // also collapse duplicates within this same batch
    fresh.push(a)
  }

  const skipped = alerts.length - fresh.length
  if (fresh.length === 0) return { inserted: 0, skipped, error: null }
  const { error } = await db.from('alerts').insert(fresh)
  return { inserted: error ? 0 : fresh.length, skipped, error: error?.message ?? null }
}
