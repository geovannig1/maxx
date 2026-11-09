import 'server-only'
import { ENV_VARS, envValue, type EnvRecord } from '@/config/env'
import { configChecks } from './config-checks'
import {
  aiLiveChecks, authSettingsChecks, metaChecks, outcomeSourceChecks, ownerChecks, supabaseChecks,
} from './network-checks'
import { summarize, type CheckDeps, type CheckOptions, type CheckResult, type CheckSummary, type IntegrationId } from './types'

// THE setup checks. `npm run setup`, `npm run doctor` and the in-app checklist's
// "test connection" buttons all call runChecks, so they cannot disagree. Network checks run only when
// online and only through the injected fetch.

export * from './types'

const NETWORK: Array<{ integration: IntegrationId; run: (env: EnvRecord, deps: CheckDeps) => Promise<CheckResult[]> }> = [
  { integration: 'supabase', run: supabaseChecks },
  { integration: 'supabase', run: authSettingsChecks },
  { integration: 'owner', run: ownerChecks },
  { integration: 'meta', run: metaChecks },
  { integration: 'outcomes', run: outcomeSourceChecks },
]

const REDACTED = '[redacted]'
const MIN_REDACT_LENGTH = 6

/** Replace any secret value that appears in a result (defence in depth: checks never put one there). */
export function redactSecrets(results: CheckResult[], env: EnvRecord): CheckResult[] {
  const secrets = ENV_VARS.filter((spec) => spec.secret)
    .map((spec) => envValue(env, spec.name))
    .filter((value): value is string => value !== undefined && value.length >= MIN_REDACT_LENGTH)
    .sort((a, b) => b.length - a.length)
  if (secrets.length === 0) return results
  const scrub = (text: string) => secrets.reduce((out, secret) => out.split(secret).join(REDACTED), text)
  return results.map((r) => ({ ...r, title: scrub(r.title), detail: scrub(r.detail), ...(r.fix ? { fix: scrub(r.fix) } : {}) }))
}

function unexpected(integration: IntegrationId, error: unknown): CheckResult {
  return { id: `${integration}.error`, integration, level: 'fail', title: 'Check failed', detail: `The check could not run (${error instanceof Error ? error.name : 'error'}).` }
}

export async function runChecks(env: EnvRecord, deps: CheckDeps, options: CheckOptions = {}): Promise<CheckSummary> {
  const wanted = (integration: IntegrationId) => !options.only || options.only.includes(integration)
  const results = configChecks(env, deps.nodeVersion ?? process.versions.node).filter((r) => wanted(r.integration))
  if (!options.offline) {
    const network = await Promise.all(NETWORK.filter((n) => wanted(n.integration)).map(async (n) => {
      try { return await n.run(env, deps) } catch (error) { return [unexpected(n.integration, error)] }
    }))
    results.push(...network.flat())
    if (options.live && wanted('ai')) results.push(...await aiLiveChecks(env, deps))
  } else {
    results.push({ id: 'network.skipped', integration: 'runtime', level: 'skip', title: 'Connectivity checks', detail: 'Skipped (offline).' })
  }
  return summarize(redactSecrets(results, env))
}
