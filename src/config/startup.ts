import 'server-only'
import { assertDemoAllowed, isDemoMode } from './demo'
import { describeEnvIssues, validateEnv, type EnvRecord } from './env'

export interface StartupLog {
  error: (message: string) => void
  info: (message: string) => void
}

/**
 * Validate the environment once when the server starts (src/instrumentation.ts). A missing or invalid
 * value is logged by variable name and the app keeps serving, so the owner reaches the setup
 * checklist instead of a crash. The only fatal case is demo mode where it is never allowed.
 */
export function reportStartupConfiguration(env: EnvRecord, log: StartupLog): void {
  assertDemoAllowed(env)
  if (isDemoMode(env)) {
    log.info('[config] sample-data demo mode (MAXX_DEMO=1): no accounts, fictional data.')
    return
  }
  const issues = validateEnv(env)
  const errors = issues.filter((issue) => issue.severity === 'error')
  if (errors.length > 0) log.error(describeEnvIssues(issues))
  else log.info(describeEnvIssues(issues))
}
