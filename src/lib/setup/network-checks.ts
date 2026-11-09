import 'server-only'
import { envValue, type EnvRecord } from '@/config/env'
import { DEFAULT_BUSINESS_CURRENCY, DEFAULT_BUSINESS_TIMEZONE } from '@/config/business-config'
import { getAdPlatform } from '@/lib/platforms/registry'
import { getOutcomeAdapter } from '@/lib/outcomes/registry'
import { missingMarkers } from './schema-markers'
import type { CheckDeps, CheckResult } from './types'

// Read-only network checks against the configured services. Every call goes through the injected
// fetch, so tests run offline. Results carry names, counts and statuses, never a credential.

const SIGNUP_STEPS = 'Supabase dashboard → Authentication → Sign In / Providers → turn off "Allow new users to sign up".'
const CONFIRM_STEPS = 'Supabase dashboard → Authentication → Sign In / Providers → Email → turn on "Confirm email".'

interface JsonReply { status: number; body: unknown }

async function getJson(deps: CheckDeps, url: string, headers: Record<string, string>): Promise<JsonReply> {
  const response = await deps.fetch(url, { headers, signal: AbortSignal.timeout(deps.timeoutMs ?? 8_000) })
  let body: unknown = null
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body }
}

const reason = (error: unknown) => (error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'could not be reached')

function supabaseBase(env: EnvRecord): string | null {
  const url = envValue(env, 'NEXT_PUBLIC_SUPABASE_URL')
  return url ? url.replace(/\/+$/, '') : null
}

function serviceHeaders(env: EnvRecord): Record<string, string> {
  const key = envValue(env, 'SUPABASE_SERVICE_ROLE_KEY') ?? ''
  return { apikey: key, Authorization: `Bearer ${key}` }
}

/** Reachable, service key accepted, and every schema marker present (migrations applied). */
export async function supabaseChecks(env: EnvRecord, deps: CheckDeps): Promise<CheckResult[]> {
  const base = supabaseBase(env)
  if (!base || !envValue(env, 'SUPABASE_SERVICE_ROLE_KEY')) return []
  let reply: JsonReply
  try {
    reply = await getJson(deps, `${base}/rest/v1/`, { ...serviceHeaders(env), Accept: 'application/openapi+json' })
  } catch (error) {
    return [{ id: 'supabase.reachable', integration: 'supabase', level: 'fail', title: 'Supabase reachable', detail: `The project ${reason(error)}.`, fix: 'Check NEXT_PUBLIC_SUPABASE_URL and that the project is not paused.' }]
  }
  if (reply.status === 401 || reply.status === 403) {
    return [{ id: 'supabase.reachable', integration: 'supabase', level: 'fail', title: 'Supabase service-role key', detail: `Rejected (HTTP ${reply.status}).`, fix: 'Set SUPABASE_SERVICE_ROLE_KEY to the project\'s service_role key (Project Settings → API).' }]
  }
  if (reply.status !== 200) {
    return [{ id: 'supabase.reachable', integration: 'supabase', level: 'fail', title: 'Supabase reachable', detail: `HTTP ${reply.status}.`, fix: 'Check NEXT_PUBLIC_SUPABASE_URL.' }]
  }
  const missing = missingMarkers(reply.body)
  return [
    { id: 'supabase.reachable', integration: 'supabase', level: 'ok', title: 'Supabase reachable', detail: 'Service-role key accepted.' },
    missing.length === 0
      ? { id: 'supabase.schema', integration: 'supabase', level: 'ok', title: 'Database schema', detail: 'Every schema marker table is present.' }
      : { id: 'supabase.schema', integration: 'supabase', level: 'fail', title: 'Database schema',
        detail: `The schema is not applied or is out of date (table ${missing[0]} is missing).`,
        fix: 'Apply the schema: npm run setup -- --apply-schema, or supabase link --project-ref <ref> && supabase db push.' },
  ]
}

/** `GET /auth/v1/settings` must show sign-ups disabled and email confirmation on. */
export async function authSettingsChecks(env: EnvRecord, deps: CheckDeps): Promise<CheckResult[]> {
  const base = supabaseBase(env)
  const anon = envValue(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY')
  if (!base || !anon) return []
  let reply: JsonReply
  try {
    reply = await getJson(deps, `${base}/auth/v1/settings`, { apikey: anon })
  } catch (error) {
    return [{ id: 'supabase.auth_settings', integration: 'supabase', level: 'fail', title: 'Supabase Auth settings', detail: `Auth ${reason(error)}.` }]
  }
  const body = reply.body as { disable_signup?: unknown; mailer_autoconfirm?: unknown } | null
  if (reply.status !== 200 || !body) {
    return [{ id: 'supabase.auth_settings', integration: 'supabase', level: 'fail', title: 'Supabase Auth settings', detail: `HTTP ${reply.status}.`, fix: 'Check NEXT_PUBLIC_SUPABASE_ANON_KEY.' }]
  }
  return [
    body.disable_signup === true
      ? { id: 'supabase.signup_disabled', integration: 'supabase', level: 'ok', title: 'Public sign-ups disabled', detail: 'disable_signup is true.' }
      : { id: 'supabase.signup_disabled', integration: 'supabase', level: 'warn', title: 'Public sign-ups disabled', detail: 'Sign-ups are open: anyone can register an account on your project.', fix: SIGNUP_STEPS },
    body.mailer_autoconfirm === false
      ? { id: 'supabase.email_confirmation', integration: 'supabase', level: 'ok', title: 'Email confirmation required', detail: 'mailer_autoconfirm is false.' }
      : { id: 'supabase.email_confirmation', integration: 'supabase', level: 'warn', title: 'Email confirmation required', detail: 'Emails are auto-confirmed, so the confirmed-email owner check cannot stop a squatter.', fix: CONFIRM_STEPS },
  ]
}

interface AuthUser { id?: string; email?: string; email_confirmed_at?: string | null }

/** The owner user exists, is confirmed, and matches the pinned id. */
export async function ownerChecks(env: EnvRecord, deps: CheckDeps): Promise<CheckResult[]> {
  const base = supabaseBase(env)
  const email = envValue(env, 'OWNER_EMAIL')?.toLowerCase()
  if (!base || !email || !envValue(env, 'SUPABASE_SERVICE_ROLE_KEY')) return []
  let reply: JsonReply
  try {
    reply = await getJson(deps, `${base}/auth/v1/admin/users?page=1&per_page=1000`, serviceHeaders(env))
  } catch (error) {
    return [{ id: 'owner.user', integration: 'owner', level: 'fail', title: 'Owner user', detail: `Auth ${reason(error)}.` }]
  }
  const users = (reply.body as { users?: AuthUser[] } | null)?.users
  if (reply.status !== 200 || !Array.isArray(users)) {
    return [{ id: 'owner.user', integration: 'owner', level: 'fail', title: 'Owner user', detail: `Could not list users (HTTP ${reply.status}).` }]
  }
  const owner = users.find((u) => u.email?.trim().toLowerCase() === email)
  if (!owner?.id) {
    return [{ id: 'owner.user', integration: 'owner', level: 'fail', title: 'Owner user', detail: 'No Supabase Auth user has OWNER_EMAIL.', fix: 'Run npm run setup (it creates the owner), or add the user in Supabase → Authentication → Users.' }]
  }
  const results: CheckResult[] = [owner.email_confirmed_at
    ? { id: 'owner.user', integration: 'owner', level: 'ok', title: 'Owner user', detail: 'Exists with a confirmed email.' }
    : { id: 'owner.user', integration: 'owner', level: 'fail', title: 'Owner user', detail: 'Exists but the email is not confirmed, so the owner gate refuses it.', fix: 'Confirm the user in Supabase → Authentication → Users, or re-run npm run setup.' }]
  const pinned = envValue(env, 'OWNER_USER_ID')?.toLowerCase()
  if (pinned && pinned !== owner.id.toLowerCase()) {
    results.push({ id: 'owner.pin_match', integration: 'owner', level: 'fail', title: 'Pinned owner id', detail: 'OWNER_USER_ID is not the id of the user holding OWNER_EMAIL; production will refuse the owner.', fix: `Set OWNER_USER_ID=${owner.id}.` })
  }
  if (users.length > 1) {
    results.push({ id: 'owner.other_users', integration: 'owner', level: 'warn', title: 'Other users', detail: `${users.length - 1} other user(s) exist; only the owner can sign in.`, fix: 'Remove users you do not recognise in Supabase → Authentication → Users.' })
  }
  return results
}

/** Token valid, permissions, ad account readable, and its timezone and currency equal configuration. */
export async function metaChecks(env: EnvRecord, deps: CheckDeps): Promise<CheckResult[]> {
  const accessToken = envValue(env, 'META_ACCESS_TOKEN')
  const accountId = envValue(env, 'META_AD_ACCOUNT_ID')
  const check = getAdPlatform('meta').connectionCheck
  if (!accessToken || !accountId || !check) return []
  const result = await check.check({
    accessToken, accountId, fetch: deps.fetch, timeoutMs: deps.timeoutMs,
    appSecret: envValue(env, 'META_APP_SECRET'), appSecretProof: envValue(env, 'META_APPSECRET_PROOF_ENABLED') === 'true',
  })
  const version = `Graph ${result.apiVersion}`
  if (!result.tokenValid) {
    return [{ id: 'meta.token', integration: 'meta', level: 'fail', title: 'Meta token', detail: `${version}: ${result.error ?? 'rejected'}`, fix: 'Generate a System User token with ads_read and set META_ACCESS_TOKEN.' }]
  }
  const scopes = result.scopes ?? []
  const results: CheckResult[] = [scopes.includes('ads_read') || scopes.includes('ads_management')
    ? { id: 'meta.token', integration: 'meta', level: 'ok', title: 'Meta token', detail: `${version}: valid; permissions ${scopes.join(', ') || 'none'}.` }
    : { id: 'meta.token', integration: 'meta', level: 'fail', title: 'Meta token', detail: `${version}: the token lacks ads_read.`, fix: 'Regenerate the System User token with ads_read.' }]
  if (scopes.includes('ads_management') && envValue(env, 'WRITE_MODE_ENABLED') !== 'true') {
    results.push({ id: 'meta.least_privilege', integration: 'meta', level: 'warn', title: 'Token permissions', detail: 'The token holds ads_management but live writes are off.', fix: 'Use an ads_read-only token unless you enable live writes.' })
  }
  if (!result.account) {
    results.push({ id: 'meta.account', integration: 'meta', level: 'fail', title: 'Ad account readable', detail: result.error ?? 'Not readable.', fix: 'Check META_AD_ACCOUNT_ID and assign the account to the System User.' })
    return results
  }
  results.push({ id: 'meta.account', integration: 'meta', level: result.account.status === 1 || result.account.status === null ? 'ok' : 'warn', title: 'Ad account readable',
    detail: `${result.account.name ?? 'Unnamed'}; currency ${result.account.currency ?? '?'}, timezone ${result.account.timezone ?? '?'}${result.account.status !== null && result.account.status !== 1 ? `; account_status ${result.account.status}` : ''}.` })
  const tz = envValue(env, 'NEXT_PUBLIC_ACCOUNT_TIMEZONE') ?? DEFAULT_BUSINESS_TIMEZONE
  const currency = envValue(env, 'NEXT_PUBLIC_ACCOUNT_CURRENCY') ?? DEFAULT_BUSINESS_CURRENCY
  if (result.account.timezone && result.account.timezone !== tz) {
    results.push({ id: 'meta.timezone', integration: 'business', level: 'fail', title: 'Timezone matches the ad account', detail: `Configured ${tz}, ad account ${result.account.timezone}: reports refuse a mismatch.`, fix: `Set NEXT_PUBLIC_ACCOUNT_TIMEZONE=${result.account.timezone} and rebuild.` })
  }
  if (result.account.currency && result.account.currency.toUpperCase() !== currency) {
    results.push({ id: 'meta.currency', integration: 'business', level: 'fail', title: 'Currency matches the ad account', detail: `Configured ${currency}, ad account ${result.account.currency}: reports refuse a mismatch.`, fix: `Set NEXT_PUBLIC_ACCOUNT_CURRENCY=${result.account.currency.toUpperCase()} and rebuild.` })
  }
  return results
}

/** Which outcome sources exist and are enabled. None enabled: reports say "no outcome source". */
export async function outcomeSourceChecks(env: EnvRecord, deps: CheckDeps): Promise<CheckResult[]> {
  const base = supabaseBase(env)
  if (!base || !envValue(env, 'SUPABASE_SERVICE_ROLE_KEY')) return []
  let reply: JsonReply
  try {
    reply = await getJson(deps, `${base}/rest/v1/outcome_sources?select=kind,enabled`, serviceHeaders(env))
  } catch (error) {
    return [{ id: 'outcomes.sources', integration: 'outcomes', level: 'fail', title: 'Outcome sources', detail: `The database ${reason(error)}.` }]
  }
  if (reply.status !== 200 || !Array.isArray(reply.body)) {
    return [{ id: 'outcomes.sources', integration: 'outcomes', level: 'fail', title: 'Outcome sources', detail: `Could not read outcome_sources (HTTP ${reply.status}).`, fix: 'Apply the database schema (supabase db push).' }]
  }
  const rows = reply.body as Array<{ kind?: string; enabled?: boolean }>
  const enabled = rows.filter((r) => r.enabled === true)
  // Outcome sources belong to the ad account the first Meta sync stores; their pages wait for it.
  const metaFirst = envValue(env, 'META_ACCESS_TOKEN') && envValue(env, 'META_AD_ACCOUNT_ID') ? ''
    : 'Connect Meta first (outcome sources belong to the ad account the first sync stores: npm run sync:manual), then: '
  const results: CheckResult[] = [enabled.length > 0
    ? { id: 'outcomes.sources', integration: 'outcomes', level: 'ok', title: 'Outcome sources', detail: `${enabled.length} of ${rows.length} enabled (${[...new Set(enabled.map((r) => r.kind))].join(', ')}).` }
    : { id: 'outcomes.sources', integration: 'outcomes', level: 'warn', title: 'Outcome sources', detail: `${rows.length} source(s), none enabled: reports say "no outcome source" instead of a number.`, fix: `${metaFirst}${metaFirst ? 'enable' : 'Enable'} a source at /settings/outcomes, import a CSV at /settings/outcomes/import, or create a signed webhook source.` }]
  // Each enabled kind's own adapter says whether what it needs is configured (names, never values).
  for (const kind of [...new Set(enabled.map((r) => r.kind ?? ''))]) {
    const adapter = getOutcomeAdapter(kind)
    if (!adapter) {
      results.push({ id: `outcomes.adapter.${kind}`, integration: 'outcomes', level: 'fail', title: `Outcome source kind ${kind}`, detail: 'No adapter handles this kind.', fix: 'Disable the source at /settings/outcomes.' })
      continue
    }
    const health = await adapter.health(env)
    if (!health.configured) {
      results.push({ id: `outcomes.adapter.${kind}`, integration: 'outcomes', level: 'fail', title: `Outcome source kind ${kind}`, detail: health.detail, fix: 'Set the values it names, or disable the source at /settings/outcomes.' })
    }
  }
  return results
}

/** One minimal model call, only when asked (`--live`, or the checklist's AI test button). */
export async function aiLiveChecks(env: EnvRecord, deps: CheckDeps): Promise<CheckResult[]> {
  if (!deps.aiProbe) return []
  try {
    const detail = await deps.aiProbe(env)
    return [{ id: 'ai.live', integration: 'ai', level: 'ok', title: 'AI live call', detail }]
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error'
    const off = name === 'AiDisabledError'
    return [{ id: 'ai.live', integration: 'ai', level: off ? 'skip' : 'fail', title: 'AI live call',
      detail: off ? 'AI is off; nothing to call.' : `The provider call failed (${name}).`,
      ...(off ? {} : { fix: 'Check the AI key, model and provider settings (npm run doctor shows which).' }) }]
  }
}
