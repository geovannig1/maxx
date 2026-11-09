// Shared vocabulary of the setup checks. `npm run setup`, `npm run doctor` and the
// in-app checklist all run src/lib/setup/checks.ts and show these results, so the three agree.

export const INTEGRATIONS = [
  'runtime', 'supabase', 'owner', 'jobs', 'meta', 'business', 'outcomes', 'ai', 'ga4', 'email', 'monitoring',
] as const
export type IntegrationId = (typeof INTEGRATIONS)[number]

export const INTEGRATION_TITLES: Record<IntegrationId, string> = {
  runtime: 'Runtime',
  supabase: 'Database (Supabase)',
  owner: 'Owner account',
  jobs: 'Scheduled jobs',
  meta: 'Meta ad account',
  business: 'Business profile',
  outcomes: 'Outcome sources',
  ai: 'AI (optional)',
  ga4: 'Google Analytics 4 (optional)',
  email: 'Email (optional)',
  monitoring: 'Monitoring (optional)',
}

export type CheckLevel = 'ok' | 'warn' | 'fail' | 'skip'

export interface CheckResult {
  /** Stable id, e.g. `supabase.auth_settings`. */
  id: string
  integration: IntegrationId
  level: CheckLevel
  title: string
  /** What was found. Never contains a secret value (a final pass redacts any that slipped in). */
  detail: string
  /** The exact variable to set or step to take, when something is wrong. */
  fix?: string
  /** Shown instead of the level's name, for a row that is neither connected nor failing (demo sample data). */
  label?: string
}

/** The demo runs with Meta off by design: its Meta rows become one sample-data row, not a failure. */
export function demoSetupChecks(checks: readonly CheckResult[]): CheckResult[] {
  const meta: CheckResult = { id: 'meta.demo', integration: 'meta', level: 'skip', label: 'Sample data (no Meta connection in demo)',
    title: 'Meta ad account', detail: 'The demo shows fictional Meta delivery; run npm run setup to connect your own ad account.' }
  const index = checks.findIndex((c) => c.integration === 'meta')
  const rest = checks.filter((c) => c.integration !== 'meta')
  return index < 0 ? [...rest, meta] : [...rest.slice(0, index), meta, ...rest.slice(index)]
}

export interface CheckOptions {
  /** No network at all: configuration checks only. */
  offline?: boolean
  /** Also make one minimal AI call (costs a few tokens). */
  live?: boolean
  /** Run only these integrations. */
  only?: readonly IntegrationId[]
}

export interface CheckDeps {
  fetch: typeof fetch
  /** One minimal model call with the given environment; resolves to a short non-secret detail. */
  aiProbe?: (env: Record<string, string | undefined>) => Promise<string>
  nodeVersion?: string
  timeoutMs?: number
}

const ORDER: Record<CheckLevel, number> = { fail: 3, warn: 2, ok: 1, skip: 0 }

/** The worst level among results (fail > warn > ok > skip); `skip` for none. */
export function worstLevel(results: readonly CheckResult[]): CheckLevel {
  return results.reduce<CheckLevel>((worst, r) => (ORDER[r.level] > ORDER[worst] ? r.level : worst), 'skip')
}

export interface CheckSummary {
  ok: boolean
  fail: number
  warn: number
  checks: CheckResult[]
}

export function summarize(checks: CheckResult[]): CheckSummary {
  const fail = checks.filter((c) => c.level === 'fail').length
  return { ok: fail === 0, fail, warn: checks.filter((c) => c.level === 'warn').length, checks }
}

export interface IntegrationGroup {
  integration: IntegrationId
  title: string
  level: CheckLevel
  checks: CheckResult[]
}

/** Results grouped per integration, in checklist order, each with its worst level. */
export function groupByIntegration(checks: readonly CheckResult[]): IntegrationGroup[] {
  return INTEGRATIONS.flatMap((integration) => {
    const rows = checks.filter((c) => c.integration === integration)
    return rows.length === 0 ? [] : [{ integration, title: INTEGRATION_TITLES[integration], level: worstLevel(rows), checks: rows }]
  })
}
