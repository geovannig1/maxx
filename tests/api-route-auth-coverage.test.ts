import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Every API handler must enforce its own authorization. src/proxy.ts gates /api/* as well, but a
 * proxy is one layer and Next.js middleware has had bypass bugs; a handler that only checks "signed in"
 * would expose the warehouse to any Supabase user the moment the proxy is skipped. Public and
 * machine-authenticated routes are listed explicitly so a new route cannot opt out by accident.
 */
const ROOT = join(process.cwd(), 'src/app/api')
const PUBLIC_ROUTES = new Set(['attribution/paid-touch'])
const MARKERS = [
  /ownerOnly\(/, /ownerGate\(/, /authenticateOwner\(/, /authorizeOwnerAndAccount\(/,
  /checkCronAuthorization\(/, /verifyAcuitySignature\(/, /savedReportingRoute\(/,
  /verifyOutcomeWebhookSignature\(/,
  // A push source's signature check through its registered adapter (the Acuity webhook route).
  /adapter\.verifyPush\(/,
]

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return routes(full)
    return name === 'route.ts' ? [full] : []
  })
}

describe('every API route enforces authorization in its own handler', () => {
  const files = routes(ROOT)
  it('finds the routes (guards this test against checking nothing)', () => {
    expect(files.length).toBeGreaterThan(40)
  })
  it.each(files.map((f) => [relative(ROOT, join(f, '..')).replace(/\\/g, '/'), f]))('%s', (key, file) => {
    if (PUBLIC_ROUTES.has(key)) return
    const source = readFileSync(file, 'utf8')
    expect(MARKERS.some((marker) => marker.test(source)), `${key} has no owner, cron or webhook authorization marker`).toBe(true)
  })
})
