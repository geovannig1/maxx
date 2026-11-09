import 'server-only'
import { CORE_ENV_VARS } from './env-vars-core'
import { EXTRA_ENV_VARS } from './env-vars-extra'
import { envValue, type EnvGroup, type EnvRecord, type EnvVarSpec } from './env-spec'

// THE environment schema: every variable the app, scripts and MCP server read,
// with its description, when it is required, whether it is secret or public, its format and default.
// tests/env-schema-population.test.ts fails when code reads a name that is not listed here.
// Messages name variables, never values.

export type { EnvGroup, EnvRecord, EnvVarSpec } from './env-spec'
export { envValue, hasEnv } from './env-spec'

export const ENV_VARS: readonly EnvVarSpec[] = [...CORE_ENV_VARS, ...EXTRA_ENV_VARS]

const BY_NAME = new Map(ENV_VARS.map((spec) => [spec.name, spec]))

export function envSpec(name: string): EnvVarSpec | undefined {
  return BY_NAME.get(name)
}

export const ENV_GROUPS: ReadonlyArray<{ id: EnvGroup; title: string; intro: string }> = [
  { id: 'supabase', title: 'Database (Supabase)', intro: 'The warehouse, sign-in and Row Level Security. Required.' },
  { id: 'owner', title: 'Owner', intro: 'One owner per install. Only this account can sign in.' },
  { id: 'jobs', title: 'Scheduled jobs', intro: 'The daily and midday syncs authenticate with this secret.' },
  { id: 'meta', title: 'Meta', intro: 'Read access to one ad account. Live writes stay off unless you enable them.' },
  { id: 'business', title: 'Business profile', intro: 'Facts about the business. Timezone and currency must equal the ad account\'s own.' },
  { id: 'outcomes', title: 'Outcome sources and conversions', intro: 'Business results come from outcome sources (CSV, signed webhook, or the optional reference scheduling adapter). Enable or disable each one on the Outcome sources screen; these variables configure the reference adapter and conversions sending.' },
  { id: 'paid_touch', title: 'Paid-touch capture', intro: 'Exact ad-click to outcome linking (ADR-056). Inert unless all four values are set.' },
  { id: 'ga4', title: 'Google Analytics 4', intro: 'Optional web telemetry.' },
  { id: 'ai', title: 'AI', intro: 'Optional. Every core page and report works with AI off. Provider rules are validated by src/lib/ai/config.ts.' },
  { id: 'email', title: 'Email', intro: 'Optional daily digest and weekly executive email.' },
  { id: 'monitoring', title: 'Monitoring', intro: 'Optional Sentry error reporting.' },
  { id: 'features', title: 'Feature switches', intro: 'Off unless set.' },
  { id: 'platform', title: 'Set by the host', intro: 'You do not set these; Next.js, Vercel, CI or a cloud SDK does. Listed because the code reads them.' },
  { id: 'tooling', title: 'Operator tooling', intro: 'Read only by scripts (setup, demo, evaluations). Do not add them to a deployment.' },
]

export type EnvIssueCode = 'missing' | 'invalid' | 'deprecated'

export interface EnvIssue {
  name: string
  severity: 'error' | 'warning'
  code: EnvIssueCode
  /** Names the variable and the expected format; never contains a value. */
  message: string
  /** Missing values block the dashboard (setup checklist) rather than the whole app. */
  blocks: 'app' | 'dashboard' | 'feature'
}

export interface ValidateOptions {
  /** Treat as production: `production` requirements become errors. Defaults from the env itself. */
  production?: boolean
}

export function isProductionEnv(env: EnvRecord): boolean {
  return env.VERCEL_ENV?.trim() === 'production' || env.NODE_ENV?.trim() === 'production'
}

function requirementOf(spec: EnvVarSpec, env: EnvRecord, production: boolean): EnvIssue['blocks'] | null {
  const rule = spec.required
  switch (rule.kind) {
    case 'required': return 'app'
    case 'production': return production ? 'app' : null
    case 'dashboard': return 'dashboard'
    case 'when': return rule.test(env) ? 'feature' : null
    case 'optional': return null
  }
}

/** Validate an environment record against the schema. Pure; never echoes a value. */
export function validateEnv(env: EnvRecord, options: ValidateOptions = {}): EnvIssue[] {
  const production = options.production ?? isProductionEnv(env)
  const issues: EnvIssue[] = []
  for (const spec of ENV_VARS) {
    if (spec.scope === 'platform') continue
    const value = envValue(env, spec.name)
    const blocks = requirementOf(spec, env, production)
    if (value === undefined) {
      if (blocks !== null) {
        const when = spec.required.kind === 'when' ? ` (required ${spec.required.text})` : ''
        issues.push({ name: spec.name, severity: 'error', code: 'missing', blocks, message: `${spec.name} is not set${when}.` })
      }
      continue
    }
    if (!spec.format.schema.safeParse(value).success) {
      issues.push({ name: spec.name, severity: 'error', code: 'invalid', blocks: blocks ?? 'feature', message: `${spec.name} must be ${spec.format.hint}.` })
    }
    if (spec.deprecatedBy) {
      issues.push({ name: spec.name, severity: 'warning', code: 'deprecated', blocks: 'feature', message: `${spec.name} is deprecated; set ${spec.deprecatedBy} instead.` })
    }
  }
  return issues
}

/** Variables the dashboard needs before it can show data (the setup checklist's "incomplete"). */
const DASHBOARD_GROUPS: ReadonlySet<EnvGroup> = new Set(['supabase', 'owner', 'meta'])

export function dashboardBlockers(env: EnvRecord, options: ValidateOptions = {}): EnvIssue[] {
  // Scheduled jobs and optional integrations never hide the dashboard; the checklist reports them.
  return validateEnv(env, options).filter((issue) => issue.severity === 'error' && issue.blocks !== 'feature'
    && DASHBOARD_GROUPS.has(envSpec(issue.name)?.group ?? 'tooling'))
}

/** The startup report: one block for the server log, naming variables only. */
export function describeEnvIssues(issues: EnvIssue[]): string {
  if (issues.length === 0) return '[config] environment valid.'
  const lines = issues.map((issue) => `  - ${issue.severity === 'error' ? 'error' : 'warning'}: ${issue.message}`)
  return `[config] ${issues.length} configuration problem(s). Run \`npm run doctor\` or open /setup:\n${lines.join('\n')}`
}
