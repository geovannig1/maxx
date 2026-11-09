import 'server-only'
import { createHash, timingSafeEqual } from 'node:crypto'

export const CRON_SECRET_MIN_LENGTH = 32

export type CronAuthorization = 'authorized' | 'unauthorized' | 'misconfigured'

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export function checkCronAuthorization(
  authorizationHeader: string | null,
  configuredSecret = process.env.CRON_SECRET,
): CronAuthorization {
  const secret = configuredSecret?.trim()
  // A short shared secret is treated as unset: the endpoints answer 503 rather than accept a guessable value.
  if (!secret || secret.length < CRON_SECRET_MIN_LENGTH) return 'misconfigured'

  const bearerPrefix = 'Bearer '
  if (!authorizationHeader?.startsWith(bearerPrefix)) return 'unauthorized'

  const suppliedSecret = authorizationHeader.slice(bearerPrefix.length)
  return timingSafeEqual(digest(suppliedSecret), digest(secret))
    ? 'authorized'
    : 'unauthorized'
}
