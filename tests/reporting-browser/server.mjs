import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fixtureToken, fixtureUser } from './auth-fixture.mjs'

const appPort = Number(process.env.MAXX_TEST_APP_PORT ?? 3147)
const authPort = Number(process.env.MAXX_TEST_AUTH_PORT ?? 3148)
const auth = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json')
  if (request.url === '/auth/v1/user' && request.headers.authorization === `Bearer ${fixtureToken}`) {
    response.end(JSON.stringify(fixtureUser))
  } else { response.statusCode = 401; response.end(JSON.stringify({ message: 'Invalid local test session' })) }
})
await new Promise(resolve => auth.listen(authPort, '127.0.0.1', resolve))
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(appPort)], {
  stdio: 'inherit', env: { ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${authPort}`, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'local-reporting-test',
    SUPABASE_SERVICE_ROLE_KEY: 'local-reporting-test', OWNER_EMAIL: fixtureUser.email,
    SENTRY_DSN: '', NEXT_PUBLIC_SENTRY_DSN: '', SENTRY_AUTH_TOKEN: '', NEXT_TELEMETRY_DISABLED: '1',
    // Synthetic placeholders: the dashboard hides behind "Finish setup" while either is unset. Reporting
    // data comes from the test gateways and the auth stub refuses every data request, so no Graph call
    // is made with these values.
    META_ACCESS_TOKEN: 'local-reporting-test', META_AD_ACCOUNT_ID: 'act_1234567890',
    GA4_SERVICE_ACCOUNT_JSON: '', MAXX_CHAT_ENABLED: 'false',
    // The preview runs with AI off: every page it checks must render with no model configured.
    AI_PROVIDER: 'none', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
  },
})
const preview = process.argv.includes('--preview')
  ? spawn(process.execPath, ['--import', 'tsx', 'tests/reporting-browser/interactive-preview.ts'], {
    // Fixtures reach `import 'server-only'` modules; this config maps the marker to Next's no-op.
    stdio: 'inherit', env: { ...process.env, TSX_TSCONFIG_PATH: 'tsconfig.scripts.json' } })
  : null
let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  child.kill('SIGTERM')
  preview?.kill('SIGTERM')
  auth.close()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
child.on('exit', code => { stop(); process.exitCode = code ?? 0 })
preview?.on('exit', code => { if (!stopping) { stop(); process.exitCode = code ?? 1 } })
