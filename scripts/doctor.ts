/**
 * Maxx doctor: read-only validation of the configuration and the services it points at.
 *
 *   npm run doctor               # .env.local + read-only connectivity checks
 *   npm run doctor -- --offline  # no network
 *   npm run doctor -- --live     # also one minimal AI call
 *   npm run doctor -- --json     # machine-readable
 *
 * The same checks run in `npm run setup` and on the in-app setup checklist (src/lib/setup/checks.ts).
 * Never prints a secret value. Exit codes: 0 no failure, 1 a failure, 2 usage error.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mergeEnv, runDoctor } from './lib/doctor-cli'

async function main(): Promise<number> {
  const envFilePath = resolve(process.cwd(), process.env.MAXX_ENV_FILE || '.env.local')
  const readEnvFile = () => {
    try { return readFileSync(envFilePath, 'utf8') } catch { return null }
  }
  // The AI gateway and the Meta platform module read process.env; give them the file's values too.
  Object.assign(process.env, mergeEnv(readEnvFile(), process.env))
  const { liveAiProbe } = await import('../src/lib/setup/ai-probe')
  return runDoctor(process.argv.slice(2), {
    env: process.env,
    readEnvFile,
    envFilePath,
    fetch,
    nodeVersion: process.versions.node,
    aiProbe: liveAiProbe,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    colour: process.stdout.isTTY === true,
  })
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
