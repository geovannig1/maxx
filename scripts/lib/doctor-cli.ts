import { parseDotenv } from '../../src/mcp/env'
import { INTEGRATIONS, type CheckResult, type IntegrationId } from '../../src/lib/setup/types'
import { formatChecks } from './check-output'

// `npm run doctor`: read-only diagnosis through the shared checks module (src/lib/setup/checks.ts).
// Everything external is injected so tests run offline.

export const DOCTOR_USAGE = `Usage: npm run doctor -- [options]
  --offline         configuration only, no network
  --live            also make one minimal AI call (a few tokens)
  --json            print one JSON document
  --only=a,b        limit to integrations: ${INTEGRATIONS.join(', ')}
Exit codes: 0 no failure, 1 a check failed, 2 usage error.`

export interface DoctorDeps {
  env: Record<string, string | undefined>
  readEnvFile: () => string | null
  envFilePath: string
  fetch: typeof fetch
  nodeVersion: string
  aiProbe?: (env: Record<string, string | undefined>) => Promise<string>
  stdout: (line: string) => void
  stderr: (line: string) => void
  colour?: boolean
}

interface DoctorArgs { offline: boolean; live: boolean; json: boolean; only?: IntegrationId[] }

function parseArgs(argv: string[]): DoctorArgs | string {
  const args: DoctorArgs = { offline: false, live: false, json: false }
  for (const arg of argv) {
    if (arg === '--offline') args.offline = true
    else if (arg === '--live') args.live = true
    else if (arg === '--json') args.json = true
    else if (arg.startsWith('--only=')) {
      const only = arg.slice('--only='.length).split(',').filter(Boolean)
      const bad = only.filter((i) => !(INTEGRATIONS as readonly string[]).includes(i))
      if (bad.length > 0 || only.length === 0) return `unknown integration: ${bad.join(', ') || '(none)'}`
      args.only = only as IntegrationId[]
    } else return `unknown option: ${arg}`
  }
  return args
}

/** Process environment over the env file (a value exported in the shell wins). */
export function mergeEnv(fileContent: string | null, processEnv: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...(fileContent === null ? {} : parseDotenv(fileContent)), ...processEnv }
}

export async function runDoctor(argv: string[], deps: DoctorDeps): Promise<number> {
  const args = parseArgs(argv)
  if (typeof args === 'string') {
    deps.stderr(`${args}\n${DOCTOR_USAGE}`)
    return 2
  }
  const file = deps.readEnvFile()
  const env = mergeEnv(file, deps.env)
  // Imported here: the Meta platform module reads META_API_VERSION when it loads.
  const { runChecks, summarize } = await import('../../src/lib/setup/checks')
  const summary = await runChecks(env, { fetch: deps.fetch, nodeVersion: deps.nodeVersion, aiProbe: deps.aiProbe }, args)
  const fileCheck: CheckResult[] = file === null
    ? [{ id: 'runtime.env_file', integration: 'runtime', level: 'warn', title: 'Env file', detail: `${deps.envFilePath} not found; checking the process environment only.`, fix: 'Run npm run setup.' }]
    : []
  const result = summarize([...fileCheck, ...summary.checks])
  if (args.json) {
    deps.stdout(JSON.stringify({ ...result, envFile: { path: deps.envFilePath, found: file !== null } }))
  } else {
    for (const line of formatChecks(result, deps.colour ?? false)) deps.stdout(line)
  }
  return result.ok ? 0 : 1
}
