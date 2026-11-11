import { z } from 'zod'
import { isIanaTimeZone, isIsoCurrency } from './business-config'
import { parseCountryCodes } from './countries'
import { parseOutcomeNoun } from './outcome-nouns'
import { isPhoneCallingCode } from '../lib/capi/phone'
import { GA4_EVENT_NAME, parseGa4EventNames } from '../lib/ga4/event-names'

// Types and value formats for the environment schema. The variable
// list itself lives in env-vars-*.ts; validation in env.ts. Nothing here holds or prints a value.

export type EnvRecord = Record<string, string | undefined>

export type EnvGroup =
  | 'supabase' | 'owner' | 'jobs' | 'meta' | 'business' | 'outcomes' | 'paid_touch' | 'ga4' | 'ai'
  | 'email' | 'monitoring' | 'features' | 'platform' | 'tooling'

/**
 * When a variable must be set:
 * - `required`: the app cannot serve anything without it.
 * - `production`: required when NODE_ENV or VERCEL_ENV is production (the owner gate fails closed).
 * - `dashboard`: needed before the dashboard can show data; the setup checklist asks for it.
 * - `when`: required only when `test` holds (an all-or-nothing group, or a provider that needs it).
 * - `optional`: never required.
 */
export type Requirement =
  | { kind: 'required' }
  | { kind: 'production' }
  | { kind: 'dashboard' }
  | { kind: 'when'; text: string; test: (env: EnvRecord) => boolean }
  | { kind: 'optional' }

/** Where the value is read: the running app, the build, operator scripts, or set by the host. */
export type EnvScope = 'app' | 'build' | 'script' | 'platform'

/** What `npm run setup` does with the variable. */
export type SetupAction = 'generate' | 'ask' | 'derived' | 'none'

export interface EnvFormat {
  /** Human description of a valid value, used in messages and docs ("an https URL"). */
  hint: string
  schema: z.ZodType<string>
}

export interface EnvVarSpec {
  name: string
  group: EnvGroup
  description: string
  /** Never printed, logged, returned by an API or shown in the UI. */
  secret: boolean
  /** NEXT_PUBLIC_*: inlined into the browser bundle at build time. */
  public: boolean
  required: Requirement
  format: EnvFormat
  /** The value the code uses when unset (documentation; the reader owns the real default). */
  default?: string
  /** A non-secret illustration for the template. */
  example?: string
  scope: EnvScope
  setup: SetupAction
  /** Setup prompt text, for `setup: 'ask'`. */
  prompt?: string
  /** Replaced by another variable; still accepted. */
  deprecatedBy?: string
}

const text = (hint: string, schema: z.ZodType<string>): EnvFormat => ({ hint, schema })
const refine = (hint: string, test: (value: string) => boolean): EnvFormat =>
  text(hint, z.string().refine(test))

const LOCAL_HTTP = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/

function isUrl(value: string, protocols: string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol)
  } catch {
    return false
  }
}

export const formats = {
  any: text('any text', z.string()),
  nonEmpty: text('a non-empty value', z.string().min(1)),
  key: text('a key of at least 20 characters', z.string().min(20).regex(/^\S+$/)),
  /** Long random secret; 32 characters is the floor `src/lib/auth/cron-secret.ts` accepts. */
  secret32: refine('at least 32 characters (setup generates 64 hex characters)', (v) => v.length >= 32 && !/\s/.test(v)),
  secret32Bytes: refine('at least 32 bytes (setup generates 64 hex characters)', (v) => Buffer.byteLength(v, 'utf8') >= 32),
  httpsUrl: refine('an https URL (http://127.0.0.1 or http://localhost for a local stack)',
    (v) => isUrl(v, ['https:']) || LOCAL_HTTP.test(v)),
  httpUrl: refine('an http or https URL', (v) => isUrl(v, ['http:', 'https:'])),
  postgresUrl: refine('a postgres:// or postgresql:// connection string', (v) => isUrl(v, ['postgres:', 'postgresql:'])),
  email: text('an email address', z.email()),
  uuid: text('a uuid such as 0d6f…-…', z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)),
  digits: text('digits only', z.string().regex(/^\d{1,32}$/)),
  metaAccount: text('act_ followed by digits, e.g. act_1234567890', z.string().regex(/^act_\d{1,32}$/)),
  graphVersion: text('a Graph API version such as v25.0', z.string().regex(/^v\d{1,3}\.\d$/)),
  bool: text('true or false', z.enum(['true', 'false'])),
  trueOnly: text('true to enable; anything else is off', z.string()),
  positiveNumber: refine('a positive number', (v) => Number.isFinite(Number(v)) && Number(v) > 0),
  positiveInteger: refine('a positive whole number', (v) => /^[1-9]\d{0,8}$/.test(v)),
  isoInstant: text('an ISO 8601 date and time with a zone, such as 2026-11-10T18:00:00Z', z.iso.datetime({ offset: true })),
  // Checked against the clock when the configuration is validated (startup, doctor, /setup): a later end
  // is off today but would open by itself once within 7 days, so it is reported rather than ignored.
  graceWindowEnd: refine('an ISO 8601 date and time with a zone, at most 7 days ahead', (v) =>
    z.iso.datetime({ offset: true }).safeParse(v).success && Date.parse(v) - Date.now() <= 7 * 86_400_000),
  positiveDecimal: refine('a positive decimal amount such as 3000 or 12.5', (v) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0),
  hops: refine('an integer from 0 to 5', (v) => /^[0-5]$/.test(v)),
  date: text('a date YYYY-MM-DD', z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  timezone: refine('an IANA timezone such as Europe/Berlin', (v) => isIanaTimeZone(v)),
  currency: refine('an upper-case ISO 4217 code such as EUR', (v) => isIsoCurrency(v)),
  phoneCallingCode: refine('a country calling code of 1 to 3 digits without +, such as 44', (v) => isPhoneCallingCode(v)),
  countryCodes: refine('comma-separated ISO 3166-1 alpha-2 country codes, e.g. DE,AT', (v) => parseCountryCodes(v).ok),
  outcomeNoun: refine('singular/plural, such as booking/bookings or order/orders', (v) => parseOutcomeNoun(v) !== null),
  locale: refine('a BCP 47 locale such as de-DE', (v) => { try { return Intl.NumberFormat.supportedLocalesOf(v).length > 0 } catch { return false } }),
  jsonObject: refine('a JSON object on one line', (v) => {
    try {
      const parsed: unknown = JSON.parse(v)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    } catch {
      return false
    }
  }),
  serviceAccountJson: refine('the full Google service-account JSON on one line, with a private_key', (v) => {
    try {
      return typeof (JSON.parse(v) as { private_key?: unknown }).private_key === 'string'
    } catch {
      return false
    }
  }),
  httpsOrigins: refine('comma-separated exact https origins, e.g. https://www.example.com', (v) =>
    v.split(',').map((o) => o.trim()).filter(Boolean).every((o) => isUrl(o, ['https:']) && new URL(o).origin === o)),
  hosts: refine('comma-separated host names, e.g. www.example.com', (v) =>
    v.split(',').map((h) => h.trim()).filter(Boolean).every((h) => /^[a-z0-9.-]+$/i.test(h))),
  eventName: text('an event name of letters, digits and underscores', z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)),
  ga4EventName: text('a GA4 event name: a letter, then letters, digits or underscores, at most 40 characters', z.string().regex(GA4_EVENT_NAME)),
  ga4EventNames: refine('comma-separated GA4 event names (each a letter, then letters, digits or underscores, at most 40 characters)',
    (v) => parseGa4EventNames(v) !== null),
  modelId: text('a model id with no spaces', z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/)),
  oneOf: (values: readonly string[]): EnvFormat => text(`one of ${values.join(', ')}`, z.enum(values as [string, ...string[]])),
} as const

export const ALWAYS: Requirement = { kind: 'required' }
export const PRODUCTION: Requirement = { kind: 'production' }
export const DASHBOARD: Requirement = { kind: 'dashboard' }
export const OPTIONAL: Requirement = { kind: 'optional' }
export const when = (textValue: string, test: (env: EnvRecord) => boolean): Requirement =>
  ({ kind: 'when', text: textValue, test })

/** A trimmed, non-empty value or undefined. */
export function envValue(env: EnvRecord, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

export const hasEnv = (env: EnvRecord, name: string) => envValue(env, name) !== undefined

/** Shorthand for the common spec shape; `public` follows the NEXT_PUBLIC_ prefix. */
export function v(
  name: string,
  group: EnvGroup,
  description: string,
  options: Partial<Omit<EnvVarSpec, 'name' | 'group' | 'description' | 'public'>> = {},
): EnvVarSpec {
  return {
    name,
    group,
    description,
    secret: options.secret ?? false,
    public: name.startsWith('NEXT_PUBLIC_'),
    required: options.required ?? OPTIONAL,
    format: options.format ?? formats.any,
    scope: options.scope ?? 'app',
    setup: options.setup ?? 'none',
    ...(options.default !== undefined ? { default: options.default } : {}),
    ...(options.example !== undefined ? { example: options.example } : {}),
    ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
    ...(options.deprecatedBy !== undefined ? { deprecatedBy: options.deprecatedBy } : {}),
  }
}
