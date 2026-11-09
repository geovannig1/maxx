import Link from 'next/link'
import { getAdminClient } from '@/lib/supabase/admin'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { listOutcomeSources } from '@/lib/outcomes/source-admin'
import { businessLocaleFromAccount, configuredBusinessLocale, BusinessLocaleError } from '@/config/business-config'
import { businessDisplayName } from '@/config/business-display'
import { MAXX_OWNER_PROFIT_POLICY } from '@/lib/economics/profit-policy'

// Non-secret settings on the setup checklist (server component, owner-only page). Outcome sources are
// stored in the database and switched on the sources screen. Timezone, currency, budget ceiling and
// the business profile are read synchronously by the app and the browser bundle, so they live in
// environment variables; this panel shows their values, which variable holds each, and whether the
// ad account agrees (a mismatch is refused, never mixed: src/config/business-config.ts).

interface AccountState {
  sources: { total: number; enabled: number } | null
  /** The database answered but holds no ad account yet: the first Meta sync stores it. */
  noAccount: boolean
  localeError: string | null
}

async function readAccountState(): Promise<AccountState> {
  try {
    const db = getAdminClient()
    const active = await resolveOnlyActiveAccount(db)
    if (!active.ok) return { sources: null, noAccount: active.reason === 'not_found', localeError: null }
    const sources = await listOutcomeSources(db, active.account.id)
    const { data } = await db.from('ad_accounts').select('timezone_name, currency').eq('id', active.account.id).maybeSingle()
    let localeError: string | null = null
    try { businessLocaleFromAccount(data) } catch (error) { localeError = error instanceof BusinessLocaleError ? error.message : 'The ad account locale could not be checked.' }
    return { sources: { total: sources.length, enabled: sources.filter((s) => s.enabled).length }, noAccount: false, localeError }
  } catch {
    return { sources: null, noAccount: false, localeError: null }
  }
}

function Setting({ label, value, variable }: { label: string; value: string; variable: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 py-2 text-sm">
      <span className="font-medium">{label}</span>
      <span>{value} <span className="ml-2 font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>{variable}</span></span>
    </div>
  )
}

export async function SetupSettings() {
  const state = await readAccountState()
  let locale: { timezone: string; currency: string } | null = null
  try { locale = configuredBusinessLocale() } catch { locale = null }
  return (
    <section aria-labelledby="setup-settings" className="rounded-lg border p-4" style={{ borderColor: 'var(--border)' }}>
      <h2 id="setup-settings" className="text-base font-semibold">Settings</h2>
      <div className="mt-2 divide-y" style={{ borderColor: 'var(--border)' }}>
        <div className="flex flex-wrap justify-between gap-2 py-2 text-sm">
          <span className="font-medium">Outcome sources (saved in the database)</span>
          <span>
            {state.sources ? `${state.sources.enabled} of ${state.sources.total} enabled`
              : state.noAccount ? 'Available after the first Meta sync stores your ad account (npm run sync:manual)'
                : 'Unavailable until the database is connected'}
            {' · '}<Link className="underline" href="/settings/outcomes">Manage sources</Link>
            {' · '}<a className="underline" href="/settings/outcomes/import">Import a CSV</a>
          </span>
        </div>
        <Setting label="Business name" value={businessDisplayName()} variable="NEXT_PUBLIC_BUSINESS_NAME" />
        <Setting label="Timezone" value={locale?.timezone ?? 'invalid'} variable="NEXT_PUBLIC_ACCOUNT_TIMEZONE" />
        <Setting label="Currency" value={locale?.currency ?? 'invalid'} variable="NEXT_PUBLIC_ACCOUNT_CURRENCY" />
        <Setting label="Daily budget ceiling" value={String(MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling)} variable="DAILY_BUDGET_CEILING" />
      </div>
      {state.localeError ? <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>{state.localeError}</p> : null}
      <p className="mt-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
        Timezone, currency, budget ceiling and the business profile (BUSINESS_PROFILE_JSON) are environment variables because the
        app and the browser read them without a database call; change them in your host and redeploy. Public (NEXT_PUBLIC_) values need a rebuild.
      </p>
    </section>
  )
}
