import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { listSourceFiles } from './_support/source-scan'

// knowledge entries, playbooks, benchmarks and MCP text are read by the model for any business in
// any currency. A fixed currency amount there ("$64 target") was one business's figure or a USD example
// presented as a rule. Every amount must be explicitly marked as a USD example or benchmark, or
// be rewritten currency-neutrally (percentages, multiples, "the configured ceiling").

const SCOPE = ['src/lib/knowledge', 'src/lib/playbooks', 'src/lib/targets/vertical-benchmarks.ts', 'src/mcp']
const STRING = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g
const AMOUNT = /[$€£¥]\s?\d|\b\d[\d,.]*\s?(?:USD|EUR|GBP|JPY|dollars?|euros?)\b/
const MARKER = /USD (?:example|benchmark)/
// Explicit allowlist: vertical benchmark insight titles are approval keys stored in the database
// (approvedVerticalBenchmarks matches them exactly); each record carries `unit: '$'` (USD medians) and is
// formatted as USD, so renaming a title would silently drop an owner approval.
const ALLOWED = [/^'Vertical benchmark: Meta /]

function files(base: string): string[] {
  return SCOPE.flatMap((entry) => {
    const full = path.join(base, entry)
    try { return entry.endsWith('.ts') ? [full] : listSourceFiles(full) } catch { return [] }
  }).map((file) => path.relative(base, file).split(path.sep).join('/'))
}

function unmarkedAmounts(base: string): string[] {
  return files(base).flatMap((file) => {
    const text = readFileSync(path.join(base, file), 'utf8').split('\n')
      .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line)).join('\n')
    return (text.match(STRING) ?? [])
      .filter((literal) => AMOUNT.test(literal) && !MARKER.test(literal) && !ALLOWED.some((rule) => rule.test(literal)))
      .map((literal) => `${file}: ${literal.slice(0, 80)}`)
  })
}

const planted = mkdtempSync(path.join(os.tmpdir(), 'maxx-static-amounts-'))
afterAll(() => rmSync(planted, { recursive: true, force: true }))

describe('fixed currency amounts in model-facing guidance', () => {
  it('reports a planted unmarked amount and accepts a marked one and a comment (planted control)', () => {
    const plant = (file: string, text: string) => {
      mkdirSync(path.join(planted, path.dirname(file)), { recursive: true })
      writeFileSync(path.join(planted, file), text)
    }
    plant('src/lib/knowledge/entries/a.ts', "export const a = { claim: 'Hold a $64 target CPA.' }\n// $100/day in a comment\n")
    plant('src/lib/playbooks/b.ts', "export const b = 'Official example (USD example): a $5 goal needs $25/day.'\n")
    plant('src/mcp/c.ts', 'export const c = `Spend at least 20 EUR before judging`\n')
    plant('src/lib/targets/vertical-benchmarks.ts', "export const t = 'Vertical benchmark: Meta CPM ~$13.48'\n")
    expect(unmarkedAmounts(planted).sort()).toEqual([
      "src/lib/knowledge/entries/a.ts: 'Hold a $64 target CPA.'",
      'src/mcp/c.ts: `Spend at least 20 EUR before judging`',
    ])
  })

  it('names no fixed currency amount in knowledge, playbook, benchmark or MCP text without a USD marker', () => {
    expect(unmarkedAmounts(process.cwd())).toEqual([])
  })
})
