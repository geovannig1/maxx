import { formats, hasEnv, v, when, type EnvVarSpec } from './env-spec'

// The reference outcome adapter's own environment variables (its external configuration contract). The
// only src/config file allowed to name that adapter (tests/acuity-vocabulary-boundary.test.ts); the core
// registry splices these in at their documented positions.

export const REFERENCE_ADAPTER_PAID_TOUCH_FIELD = 'ACUITY_PAID_TOUCH_FIELD_ID'

export const REFERENCE_ADAPTER_ENV_VARS: EnvVarSpec[] = [
  v('ACUITY_USER_ID', 'outcomes', 'Acuity Scheduling user id for the optional Acuity example adapter. Needs ACUITY_API_KEY.', {
    format: formats.digits, required: when('when ACUITY_API_KEY is set', (env) => hasEnv(env, 'ACUITY_API_KEY')),
  }),
  v('ACUITY_API_KEY', 'outcomes', 'Acuity API key; also the HMAC key Acuity signs its webhooks with.', {
    secret: true, format: formats.nonEmpty, required: when('when ACUITY_USER_ID is set', (env) => hasEnv(env, 'ACUITY_USER_ID')),
  }),
  v('ACUITY_WEBHOOK_SECRET', 'outcomes', 'Optional extra `?secret=` the Acuity webhook URL must carry.', { secret: true, format: formats.nonEmpty }),
  v('ACUITY_CAPI_SEND', 'outcomes', 'Conversions API sends for Acuity outcomes: off, test (Test Events only) or live.', { format: formats.oneOf(['off', 'test', 'live']), default: 'off' }),
  v('ACUITY_BACKFILL_START', 'outcomes', 'First date scripts/backfill-acuity.ts pulls.', { format: formats.date, scope: 'script' }),
]

export function referenceAdapterPaidTouchFieldVar(started: (env: Record<string, string | undefined>) => boolean): EnvVarSpec {
  return v('ACUITY_PAID_TOUCH_FIELD_ID', 'paid_touch', 'Id of the hidden Acuity intake field that carries the paid-touch token.', {
    format: formats.digits, required: when('when paid-touch capture is configured', started),
  })
}
