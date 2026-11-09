import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {
  SIGNATURE_TOLERANCE_SECONDS, signOutcomeWebhook, verifyOutcomeWebhookSignature,
} from '@/lib/outcomes/adapters/webhook/signature'
import { parseOutcomeWebhookPayload } from '@/lib/outcomes/adapters/webhook/payload'
import { CSV_TEMPLATE } from '@/lib/outcomes/adapters/csv/contract'
import { readOutcomeCsv } from '@/lib/outcomes/adapters/csv/read'
import { extractCodeBlocks, type CodeBlock } from './helpers/doc-smoke'

// docs/outcomes.md promises that its three webhook signing examples (Node.js, Python, curl+openssl)
// produce a signature Maxx accepts. This runs the documented signing code itself, extracted from the
// document, against the real verifier: the Node function in a VM, the Python function with python3 and
// the openssl pipeline with bash. Python and openssl are skipped (not failed) where not installed;
// the Node check always runs. The documented JSON payload and CSV sample are parsed by the real
// parsers too.

const DOC = readFileSync(path.resolve(__dirname, '../docs/outcomes.md'), 'utf8')
const BLOCKS = extractCodeBlocks(DOC, 'docs/outcomes.md')
const only = (lang: string, needle: string): CodeBlock => {
  const found = BLOCKS.filter((b) => b.lang === lang && b.code.includes(needle))
  expect(found, `${lang} block containing ${needle}`).toHaveLength(1)
  return found[0]
}

// Fixed inputs. The body has non-ASCII text so a sender that signs characters instead of UTF-8 bytes
// would disagree with the verifier.
const KEY = 'a1'.repeat(32)
const T = 1_762_000_000
const BODY = JSON.stringify({ external_id: 'ORDER-1001', outcome_type: 'sale', status: 'confirmed', currency: 'EUR', gross_value: '120.50', occurred_at: '2025-11-01T12:00:00Z', origin: 'website', outcome_label: 'Café gift card' })

function nodeExample(): (key: string, body: string, t: number) => string {
  const code = only('js', 'function maxxSignature').code
  const fn = /function maxxSignature[\s\S]*?\n}/.exec(code)
  expect(fn, 'maxxSignature function in the Node example').not.toBeNull()
  const sandbox = { createHmac, result: undefined as unknown }
  vm.runInNewContext(`${fn![0]}\nresult = maxxSignature`, sandbox)
  return sandbox.result as (key: string, body: string, t: number) => string
}

/** Only PATH from this process, so nothing else in the test environment reaches the child. */
const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', PATH: process.env.PATH, ...extra })

const has = (command: string, args: string[]) => spawnSync(command, args, { encoding: 'utf8' }).status === 0

describe('docs/outcomes.md webhook signing examples', () => {
  it('the Node.js example signs exactly what the verifier accepts', () => {
    const header = nodeExample()(KEY, BODY, T)
    expect(header).toBe(signOutcomeWebhook(KEY, T, BODY))
    expect(verifyOutcomeWebhookSignature({ header, rawBody: BODY, secret: KEY, nowMs: T * 1000 })).toMatchObject({ ok: true })
  })

  it('controls: the verifier rejects a changed body, a wrong key and a stale timestamp from the same example', () => {
    const sign = nodeExample()
    const header = sign(KEY, BODY, T)
    expect(verifyOutcomeWebhookSignature({ header, rawBody: `${BODY} `, secret: KEY, nowMs: T * 1000 })).toEqual({ ok: false, reason: 'mismatch' })
    expect(verifyOutcomeWebhookSignature({ header, rawBody: BODY, secret: 'b2'.repeat(32), nowMs: T * 1000 })).toEqual({ ok: false, reason: 'mismatch' })
    // The documented tolerance is 5 minutes in either direction.
    expect(SIGNATURE_TOLERANCE_SECONDS).toBe(300)
    expect(verifyOutcomeWebhookSignature({ header, rawBody: BODY, secret: KEY, nowMs: (T + 300) * 1000 })).toMatchObject({ ok: true })
    expect(verifyOutcomeWebhookSignature({ header, rawBody: BODY, secret: KEY, nowMs: (T + 301) * 1000 })).toEqual({ ok: false, reason: 'stale' })
    expect(verifyOutcomeWebhookSignature({ header, rawBody: BODY, secret: KEY, nowMs: (T - 301) * 1000 })).toEqual({ ok: false, reason: 'stale' })
  })

  it.skipIf(!has('python3', ['--version']))('the Python example produces the same header as the Node example', () => {
    const code = only('python', 'def maxx_signature').code
    const fn = /def maxx_signature[\s\S]*?return f"t=\{t\},v1=\{v1\}"/.exec(code)
    expect(fn, 'maxx_signature function in the Python example').not.toBeNull()
    const program = [
      'import hashlib, hmac, os, sys, time',
      fn![0],
      "sys.stdout.write(maxx_signature(os.environ['DOC_KEY'], os.environ['DOC_BODY'].encode('utf-8'), int(os.environ['DOC_T'])))",
    ].join('\n')
    const run = spawnSync('python3', ['-I', '-c', program], {
      encoding: 'utf8', env: childEnv({ DOC_KEY: KEY, DOC_BODY: BODY, DOC_T: String(T) }),
    })
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(nodeExample()(KEY, BODY, T))
    expect(verifyOutcomeWebhookSignature({ header: run.stdout, rawBody: BODY, secret: KEY, nowMs: T * 1000 })).toMatchObject({ ok: true })
  })

  it.skipIf(!has('openssl', ['version']))('the curl + openssl example computes the same v1 digest', () => {
    const line = only('bash', 'openssl dgst').code.split('\n').find((l) => l.startsWith('V1=$('))
    expect(line, 'the V1= line of the shell example').toBeDefined()
    const run = spawnSync('bash', ['-c', `${line}\nprintf %s "$V1"`], {
      encoding: 'utf8', env: childEnv({ WEBHOOK_SECRET: KEY, BODY, T: String(T) }),
    })
    expect(run.stderr).toBe('')
    const expected = createHmac('sha256', KEY).update(`${T}.${BODY}`, 'utf8').digest('hex')
    expect(run.stdout).toBe(expected)
    expect(verifyOutcomeWebhookSignature({ header: `t=${T},v1=${run.stdout}`, rawBody: BODY, secret: KEY, nowMs: T * 1000 })).toMatchObject({ ok: true })
  })

  it('the documented example payload and the shell example body are valid deliveries', () => {
    const payload = only('json', '"external_id"').code
    expect(parseOutcomeWebhookPayload(payload)).toMatchObject({ ok: true })
    const body = /^BODY='(.*)'$/m.exec(only('bash', 'openssl dgst').code)
    expect(body).not.toBeNull()
    expect(parseOutcomeWebhookPayload(body![1])).toMatchObject({ ok: true })
  })

  it('control: a payload with an unknown key is refused by the same parser', () => {
    const payload = JSON.parse(only('json', '"external_id"').code) as Record<string, unknown>
    expect(parseOutcomeWebhookPayload(JSON.stringify({ ...payload, amount: '1.00' }))).toMatchObject({ ok: false, fields: [''] })
  })

  it('the CSV sample is the import template and reads without errors', () => {
    const sample = only('csv', 'external_id,outcome_type').code
    expect(`${sample.split('\n').join('\r\n')}\r\n`).toBe(CSV_TEMPLATE)
    const read = readOutcomeCsv(sample, { timezone: 'America/New_York', currency: 'USD' })
    expect(read).toMatchObject({ ok: true, errors: [], totalRows: 2, invalidRows: 0 })
  })
})
