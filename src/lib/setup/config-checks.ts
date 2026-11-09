import 'server-only'
import { ENV_VARS, envSpec, envValue, validateEnv, type EnvGroup, type EnvRecord } from '@/config/env'
import { readAiConfig } from '@/lib/ai/config'
import { loadBusinessProfile } from '@/config/business-profile'
import type { CheckResult, IntegrationId } from './types'

// Configuration checks: no network. Every value is judged by the schema in src/config/env.ts; the AI
// provider rules by src/lib/ai/config.ts (the validator the app runs at startup).

const GROUP_INTEGRATION: Partial<Record<EnvGroup, IntegrationId>> = {
  supabase: 'supabase', owner: 'owner', jobs: 'jobs', meta: 'meta', business: 'business', outcomes: 'outcomes',
  paid_touch: 'outcomes', ga4: 'ga4', ai: 'ai', email: 'email', monitoring: 'monitoring',
}

export const MIN_NODE_MAJOR = 24

export function runtimeChecks(nodeVersion: string): CheckResult[] {
  const major = Number(nodeVersion.split('.')[0])
  return [{
    id: 'runtime.node', integration: 'runtime', level: major >= MIN_NODE_MAJOR ? 'ok' : 'fail', title: 'Node.js version',
    detail: `${nodeVersion} (${MIN_NODE_MAJOR} or newer required)`, ...(major >= MIN_NODE_MAJOR ? {} : { fix: 'Install Node.js 24 or newer.' }),
  }]
}

/** One result per schema problem, plus one OK per integration whose values all validate. */
export function schemaChecks(env: EnvRecord): CheckResult[] {
  const issues = validateEnv(env)
  const results: CheckResult[] = []
  const troubled = new Set<IntegrationId>()
  for (const issue of issues) {
    const spec = envSpec(issue.name)
    const integration = spec ? GROUP_INTEGRATION[spec.group] : undefined
    if (!integration) continue
    // src/lib/ai/config.ts owns which AI value a provider needs (advisoryChecks reports it once).
    if (integration === 'ai' && issue.code === 'missing') continue
    troubled.add(integration)
    const fix = issue.code === 'deprecated' ? issue.message
      : spec?.setup === 'generate' ? `Run npm run setup to generate ${issue.name}, or set it to ${spec.format.hint}.`
        : `Set ${issue.name} to ${spec?.format.hint ?? 'a valid value'} (docs/configuration.md).`
    results.push({
      id: `${integration}.env.${issue.name}`, integration, level: issue.severity === 'error' ? 'fail' : 'warn',
      title: issue.name, detail: issue.message, fix,
    })
  }
  for (const integration of ['supabase', 'owner', 'jobs', 'meta', 'business'] as const) {
    if (!troubled.has(integration)) {
      const named = ENV_VARS.filter((spec) => GROUP_INTEGRATION[spec.group] === integration && !spec.deprecatedBy && envValue(env, spec.name) !== undefined)
        .map((spec) => spec.name)
      const detail = named.length > 0 ? `${named.join(', ')}: set and valid.` : 'Nothing required here is missing.'
      results.push({ id: `${integration}.env`, integration, level: 'ok', title: 'Configuration values', detail })
    }
  }
  return results
}

/** Advisory checks: values that validate but deserve a warning. */
export function advisoryChecks(env: EnvRecord): CheckResult[] {
  const results: CheckResult[] = []
  const add = (r: CheckResult) => results.push(r)
  if (envValue(env, 'OWNER_EMAIL') && !envValue(env, 'OWNER_USER_ID')) {
    add({ id: 'owner.pin', integration: 'owner', level: 'warn', title: 'Owner user id pinned',
      detail: 'OWNER_USER_ID is not set, so any confirmed account holding the owner email passes the owner gate.',
      fix: 'Run npm run setup (it records OWNER_USER_ID), or set OWNER_USER_ID to the owner\'s Supabase user id.' })
  }
  if (envValue(env, 'WRITE_MODE_ENABLED') === 'true') {
    add({ id: 'meta.write_mode', integration: 'meta', level: 'warn', title: 'Live writes', detail: 'WRITE_MODE_ENABLED=true: approved changes can reach the ad account.',
      fix: 'Unset WRITE_MODE_ENABLED unless you need live writes (docs/security-model.md).' })
  }
  if (envValue(env, 'META_ACCESS_TOKEN') && envValue(env, 'META_APPSECRET_PROOF_ENABLED') !== 'true') {
    add({ id: 'meta.appsecret_proof', integration: 'meta', level: 'warn', title: 'App secret proof',
      detail: 'Off: a leaked token works without the app secret.',
      fix: 'Set META_APPSECRET_PROOF_ENABLED=true and META_APP_SECRET, and turn on "Require App Secret" in the Meta app.' })
  }
  if (envValue(env, 'BUSINESS_PROFILE_JSON')) {
    try {
      const profile = loadBusinessProfile(env)
      add({ id: 'business.profile', integration: 'business', level: 'ok', title: 'Business profile', detail: `${profile.name}, ${profile.city}.` })
    } catch (error) {
      add({ id: 'business.profile', integration: 'business', level: 'fail', title: 'Business profile',
        detail: error instanceof Error ? error.message : 'BUSINESS_PROFILE_JSON is invalid.', fix: 'Fix BUSINESS_PROFILE_JSON (src/config/business-profile.ts lists the fields).' })
    }
  } else {
    add({ id: 'business.profile', integration: 'business', level: 'warn', title: 'Business profile',
      detail: 'Using the fictional example profile.', fix: 'Set BUSINESS_PROFILE_JSON with your business facts (docs/configuration.md).' })
  }
  const ai = readAiConfig(env)
  if (!ai.ok) {
    for (const [i, error] of ai.errors.entries()) {
      add({ id: `ai.config.${i}`, integration: 'ai', level: 'fail', title: 'AI configuration', detail: error, fix: error })
    }
  } else if (ai.config.provider === 'none') {
    add({ id: 'ai.provider', integration: 'ai', level: 'warn', title: 'AI provider',
      detail: 'Off: chat, vision, competitor and signal analysis are disabled; every report still works.',
      fix: 'Optional: set AI_PROVIDER and its key (docs/configuration.md, section AI).' })
  } else {
    add({ id: 'ai.provider', integration: 'ai', level: 'ok', title: 'AI provider', detail: `${ai.config.provider}, model ${ai.config.model}` })
  }
  const optional: Array<[IntegrationId, string, string[]]> = [
    ['ga4', 'GA4', ['GA4_PROPERTY_ID']],
    ['email', 'Email delivery', ['DAILY_DIGEST_EMAIL_PROVIDER', 'WEEKLY_EXECUTIVE_EMAIL_PROVIDER']],
    ['monitoring', 'Sentry', ['SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN']],
  ]
  for (const [integration, title, names] of optional) {
    const set = names.some((name) => envValue(env, name))
    add({ id: `${integration}.configured`, integration, level: set ? 'ok' : 'skip', title,
      detail: set ? 'Configured.' : 'Not configured (optional).' })
  }
  return results
}

export function configChecks(env: EnvRecord, nodeVersion: string): CheckResult[] {
  return [...runtimeChecks(nodeVersion), ...schemaChecks(env), ...advisoryChecks(env)]
}
