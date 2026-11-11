/**
 * `npm run demo`: the full product on sample data, with no accounts and no secrets.
 *
 *   npm run demo                 # http://127.0.0.1:3000 (uses ports 3000 to 3002)
 *   npm run demo -- --port 4000  # another port (the app and the sample backend use the next two)
 *
 * Loopback servers on three ports: a sample backend (Supabase Auth + REST over an in-memory PGlite with
 * the shipped schema and a fictional seed), the app (`next dev` with MAXX_DEMO=1, Meta off, AI off), and
 * a gateway that signs you in as the fictional owner and serves sample reports and the sample creatives'
 * images. A busy port stops it before anything starts (./ports.ts). Every variable the
 * schema knows is set explicitly, so a real .env.local in the clone is never read by the demo app.
 * MAXX_DEMO=1 is refused in production and on Vercel. Ctrl-C stops them all.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { Server } from 'node:http'
import { ENV_VARS } from '../../src/config/env'
import { DEMO_USER, demoSessionCookie, startBackend } from './backend'
import { startGateway } from './gateway'
import { sampleImageFor } from './media'
import { DEMO_META_ACCOUNT, createSampleDb } from './sample-db'
import { demoCalendar, type DemoCalendar } from './sample/demo-account'
import { assertDemoPortsFree, demoPorts } from './ports'

export interface DemoHandle {
  url: string
  /** The day the sample data is anchored to, and its default report range. */
  calendar: DemoCalendar
  /** The generated creative image of the first sample ad, on the gateway's origin. */
  sampleImageUrl: string
  stop: () => Promise<void>
}

/** The app's environment: every schema variable and every secret (cloud SDK credentials too) blanked, then the demo values.
 *  `gatewayUrl` is the origin the browser uses: the app sees only its own port, so its same-origin check
 *  needs APP_URL, exactly as a self-hosted deployment behind a proxy does. */
export function demoAppEnv(base: NodeJS.ProcessEnv, backendUrl: string, gatewayUrl: string): NodeJS.ProcessEnv {
  const blank = Object.fromEntries(ENV_VARS.filter((s) => s.secret || s.scope !== 'platform').map((s) => [s.name, '']))
  return {
    ...base, ...blank,
    NODE_ENV: 'development',
    VERCEL: '', VERCEL_ENV: '',
    MAXX_DEMO: '1',
    APP_URL: gatewayUrl,
    NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_SUPABASE_URL: backendUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'demo-anon-key-not-a-credential',
    SUPABASE_SERVICE_ROLE_KEY: 'demo-service-key-not-a-credential',
    OWNER_EMAIL: DEMO_USER.email,
    OWNER_USER_ID: DEMO_USER.id,
    META_AD_ACCOUNT_ID: DEMO_META_ACCOUNT,
    NEXT_PUBLIC_BUSINESS_NAME: 'Example Studio (sample data)',
    NEXT_PUBLIC_ACCOUNT_TIMEZONE: 'America/New_York',
    NEXT_PUBLIC_ACCOUNT_CURRENCY: 'USD',
    AI_PROVIDER: 'none',
    MAXX_CHAT_ENABLED: 'false',
  }
}

export async function startDemo(port = 3000, log: (line: string) => void = console.log): Promise<DemoHandle> {
  await assertDemoPortsFree(port)
  const { app: appPort, backend: backendPort } = demoPorts(port)
  const calendar = demoCalendar()
  log('Maxx demo: building the sample database (shipped schema + fictional seed)…')
  const db = await createSampleDb(calendar)
  const backendUrl = `http://127.0.0.1:${backendPort}`
  const url = `http://127.0.0.1:${port}`
  const backend = await startBackend(db, backendPort)
  const app: ChildProcess = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(appPort)], {
    stdio: ['ignore', 'inherit', 'inherit'], env: demoAppEnv(process.env, backendUrl, url),
  })
  const gateway = await startGateway({ port, appPort, sessionCookie: demoSessionCookie(backendUrl), calendar })
  const close = (server: Server) => new Promise<void>((done) => server.close(() => done()))
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    const exited = new Promise<void>((done) => { if (app.exitCode !== null) done(); else app.once('exit', () => done()) })
    app.kill('SIGTERM')
    await Promise.all([exited, close(gateway), close(backend)])
    await db.close()
  }
  log(`Maxx demo on sample data: ${url}  (no accounts, no secrets; Ctrl-C to stop)`)
  return { url, calendar, sampleImageUrl: `${url}${sampleImageFor(0)}`, stop }
}

function parsePort(argv: string[]): number {
  const index = argv.indexOf('--port')
  const port = index >= 0 ? Number(argv[index + 1]) : 3000
  if (!Number.isInteger(port) || port < 1024 || port > 65_530) throw new Error('--port must be an integer from 1024 to 65530')
  return port
}

const isMain = process.argv[1]?.endsWith('scripts/demo/start.ts')
if (isMain) {
  startDemo(parsePort(process.argv.slice(2))).then((demo) => {
    const shutdown = () => { void demo.stop().then(() => process.exit(0)) }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
