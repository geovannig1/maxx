import { describe, expect, it } from 'vitest'
import {
  PAID_TOUCH_PREVIOUS_SECRET_MAX_GRACE_MS, issuePaidTouchToken, paidTouchPreviousSecret, verifyPaidTouchToken,
} from '@/lib/attribution/paid-touch-contract'
import { ENV_VARS, validateEnv } from '@/config/env'

// Rotating PAID_TOUCH_TOKEN_SECRET used to orphan every token already handed to visitors. The replaced
// secret may now keep VERIFYING (never signing) for a bounded window: PAID_TOUCH_TOKEN_PREVIOUS_SECRET
// until PAID_TOUCH_TOKEN_PREVIOUS_SECRET_UNTIL, at most 7 days ahead. Anything else fails closed.

const TOKEN_ID = '00000000-0000-4000-8000-000000000069'
const OLD = 'o'.repeat(64)
const NEW = 'n'.repeat(64)
const NOW = Date.parse('2026-11-10T12:00:00Z')
const at = (ms: number) => new Date(NOW + ms).toISOString()
const env = (until: string | undefined, previous: string | undefined = OLD) => ({
  PAID_TOUCH_TOKEN_PREVIOUS_SECRET: previous, PAID_TOUCH_TOKEN_PREVIOUS_SECRET_UNTIL: until,
})

describe('paid-touch secret rotation grace', () => {
  const oldToken = issuePaidTouchToken(TOKEN_ID, OLD)

  it('verifies a token signed with the replaced secret while the window is open', () => {
    const previous = paidTouchPreviousSecret(env(at(3_600_000)), NOW)
    expect(previous).toBe(OLD)
    expect(verifyPaidTouchToken(oldToken, NEW, previous)).toEqual({ ok: true, tokenId: TOKEN_ID })
    // The current secret still verifies its own tokens; minting never uses the previous one.
    expect(verifyPaidTouchToken(issuePaidTouchToken(TOKEN_ID, NEW), NEW, previous)).toEqual({ ok: true, tokenId: TOKEN_ID })
  })

  it('fails closed outside a valid, bounded window', () => {
    for (const [name, vars] of [
      ['window over', env(at(-1))],
      ['window beyond the 7-day cap', env(at(PAID_TOUCH_PREVIOUS_SECRET_MAX_GRACE_MS + 60_000))],
      ['no end', env(undefined)],
      ['unparseable end', env('next tuesday')],
      ['date without a time', env('2026-11-11')],
      ['short previous secret', env(at(3_600_000), 'short')],
      ['no previous secret', { PAID_TOUCH_TOKEN_PREVIOUS_SECRET_UNTIL: at(3_600_000) }],
    ] as const) {
      const previous = paidTouchPreviousSecret(vars, NOW)
      expect(previous, name).toBeNull()
      expect(verifyPaidTouchToken(oldToken, NEW, previous), name).toEqual({ ok: false, reason: 'invalid_signature' })
    }
    // Exactly at the cap is still inside it (control).
    expect(paidTouchPreviousSecret(env(at(PAID_TOUCH_PREVIOUS_SECRET_MAX_GRACE_MS)), NOW)).toBe(OLD)
  })

  it('a forged token verifies with neither secret', () => {
    const forged = issuePaidTouchToken(TOKEN_ID, 'f'.repeat(64))
    expect(verifyPaidTouchToken(forged, NEW, OLD)).toEqual({ ok: false, reason: 'invalid_signature' })
  })

  it('both settings are registered, secret, and documented', () => {
    const previous = ENV_VARS.find((v) => v.name === 'PAID_TOUCH_TOKEN_PREVIOUS_SECRET')
    const until = ENV_VARS.find((v) => v.name === 'PAID_TOUCH_TOKEN_PREVIOUS_SECRET_UNTIL')
    expect(previous).toMatchObject({ secret: true })
    expect(until).toBeDefined()
    expect(until?.format.schema.safeParse('2026-11-10T12:00:00Z').success).toBe(true)
    expect(until?.format.schema.safeParse('2026-11-10').success).toBe(false)
  })

  it('reports an end more than 7 days ahead as a configuration error, not a silent "off"', () => {
    // A far end is off today but opens by itself once it is within 7 days; the operator must hear about
    // it where configuration is checked (startup log, npm run doctor, /setup), not discover it later.
    const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString()
    const issue = (value: string) => validateEnv({ PAID_TOUCH_TOKEN_PREVIOUS_SECRET: OLD, PAID_TOUCH_TOKEN_PREVIOUS_SECRET_UNTIL: value })
      .find((i) => i.name === 'PAID_TOUCH_TOKEN_PREVIOUS_SECRET_UNTIL')
    expect(issue(days(30))).toMatchObject({ severity: 'error' })
    expect(issue(days(2))).toBeUndefined()
    expect(issue(days(-1))).toBeUndefined()
  })
})
