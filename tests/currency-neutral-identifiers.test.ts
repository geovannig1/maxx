import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { scanSources } from './_support/source-scan'
import { LEGACY_MONEY_KEYS } from '@/lib/outcomes/legacy-money-keys'

// money is in the account currency, so no identifier, key or parameter in src or scripts is named
// after one currency (suffix Usd, _usd or _USD). The allowlist holds only deprecated, still-accepted names:
// the two renamed environment variables and the MCP write parameter kept as an alias for one release.

const ROOT = process.cwd()
const SCOPE = ['src', 'scripts']
const TOKEN = /\b[A-Za-z0-9_]*(?:[a-z0-9]Usd|_usd|_USD)\b/g
const ALLOWED = new Set([
  'DAILY_BUDGET_CEILING_USD', 'NEXT_PUBLIC_BUSINESS_HOURLY_RATE_USD',
  'new_daily_budget_usd',
])

// The map of renamed keys itself (and the stored-document migration it mirrors) necessarily names them.
const MAP_FILE = 'src/lib/outcomes/legacy-money-keys.ts'

function violations(base: string): string[] {
  return scanSources(base, SCOPE, /Usd|_usd|_USD/).filter((hit) => hit.file !== MAP_FILE).flatMap((hit) =>
    [...hit.text.matchAll(TOKEN)].map((m) => m[0]).filter((token) => !ALLOWED.has(token))
      .map((token) => `${hit.file}:${hit.line}: ${token}`))
    .sort()
}

const planted = mkdtempSync(path.join(os.tmpdir(), 'maxx-usd-names-'))
afterAll(() => rmSync(planted, { recursive: true, force: true }))

describe('currency-neutral identifiers', () => {
  it('reports planted currency-named identifiers and ignores the deprecated aliases (planted control)', () => {
    const files: Record<string, string> = {
      'src/lib/report/new.ts': 'export const x = { spendUsd: 1, total_usd: 2 }\n',
      'scripts/tool.ts': 'const CAP_USD = 3\nconst old = process.env.DAILY_BUDGET_CEILING_USD\n',
      'src/mcp/tools/w.ts': "const a = { new_daily_budget_usd: 1, new_daily_budget: 1, usd: 1, USD: 'USD' }\n",
    }
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.join(planted, path.dirname(file)), { recursive: true })
      writeFileSync(path.join(planted, file), text)
    }
    expect(violations(planted)).toEqual([
      'scripts/tool.ts:1: CAP_USD',
      'src/lib/report/new.ts:1: spendUsd',
      'src/lib/report/new.ts:1: total_usd',
    ])
  })

  it('names no identifier after one currency in src or scripts', () => {
    expect(violations(ROOT)).toEqual([])
  })

  it('upgrades every renamed persisted key to a currency-neutral name', () => {
    for (const [from, to] of Object.entries(LEGACY_MONEY_KEYS)) {
      expect(from).toMatch(/(Usd|_usd)$/)
      expect(to).not.toMatch(/usd/i)
    }
    expect(LEGACY_MONEY_KEYS.spendUsd).toBe('spendAmount')
  })
})
