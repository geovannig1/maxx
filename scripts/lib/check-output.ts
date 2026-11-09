import { INTEGRATIONS, INTEGRATION_TITLES, type CheckResult, type CheckSummary } from '../../src/lib/setup/types'

// Terminal rendering of check results, shared by doctor and setup. Plain text with ANSI colour only
// when the output is a terminal.

const MARK = { ok: ' OK ', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' } as const
const COLOR = { ok: 32, warn: 33, fail: 31, skip: 90 } as const

export function formatChecks(summary: CheckSummary, colour: boolean): string[] {
  const paint = (r: CheckResult) => (colour ? `\x1b[${COLOR[r.level]}m${MARK[r.level]}\x1b[0m` : MARK[r.level])
  const lines: string[] = []
  for (const integration of INTEGRATIONS) {
    const rows = summary.checks.filter((c) => c.integration === integration)
    if (rows.length === 0) continue
    lines.push(INTEGRATION_TITLES[integration])
    for (const r of rows) {
      lines.push(`  ${paint(r)}  ${r.title}: ${r.detail}`)
      if (r.fix && (r.level === 'fail' || r.level === 'warn')) lines.push(`        → ${r.fix}`)
    }
  }
  lines.push('', `${summary.fail === 0 ? 'No failures.' : `${summary.fail} failure(s).`} ${summary.warn} warning(s).`)
  return lines
}
