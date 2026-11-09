import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanUiText, scanUiTextFile } from './_support/ui-text-scan'
import { CHAT_DIAGNOSTIC_NOTICE } from '@/lib/authority/diagnostic-surface'

// What Maxx can do now (ADR-059, ADR-062): it drafts copy, campaign plans and change proposals; only the
// owner approves; an approved change applies only with write mode on; campaigns are created paused.
// Screens written before that said Maxx is read-only and "never changes campaigns ... with write mode
// off", which is no longer true and contradicts the Changes page.

const ROOT = path.resolve(__dirname, '..')

const STALE = [
  /never changes campaigns/i,
  /It does not change campaigns/i,
  /Maxx (?:can['’]t|cannot) (?:execute|change)/i,
  /\(write mode off\)/i,
  /\bwith write mode off\b/i,
  /read-only chat|media buyer, read-only|account[^.]*data, read-only/i,
  /You apply it in Ads Manager/i,
]
const STALE_ANY = new RegExp(STALE.map((re) => re.source).join('|'), 'i')

describe('owner-visible text states what Maxx can change', () => {
  it('each stale pattern matches the sentence it was written for (control)', () => {
    expect(STALE_ANY.test('Read-only. Maxx reads your account and advises — it never changes campaigns.')).toBe(true)
    expect(STALE_ANY.test('Write mode off — Maxx can’t execute this; your decision is what counts.')).toBe(true)
    expect(STALE_ANY.test('This records intent only — Maxx executes nothing (write mode off).')).toBe(true)
    expect(STALE_ANY.test('Only you approve a change, and it applies only with write mode on.')).toBe(false)
  })

  it('no screen claims Maxx is read-only or can never change the account', () => {
    const hits = scanUiText(ROOT, ['src/app', 'src/components'], STALE_ANY)
    expect(hits.map((hit) => `${hit.file}:${hit.line} ${hit.text}`)).toEqual([])
  })

  it('the /maxx side panel states the current boundary', () => {
    const file = path.join(ROOT, 'src/app/(dashboard)/maxx/page.tsx')
    const panel = scanUiTextFile(file, 'maxx/page.tsx', /./).map((hit) => hit.text).join(' ')
    expect(panel).toMatch(/draft copy, campaign plans and change proposals/i)
    expect(panel).toMatch(/only you approve/i)
    expect(panel).toMatch(/only with write mode on/i)
    expect(panel).toMatch(/created paused/i)
  })

  it('the notice on every chat answer names drafting and owner approval, not a feed that cannot act', () => {
    expect(CHAT_DIAGNOSTIC_NOTICE).not.toMatch(/cannot create|Recommendations\/Approvals/i)
    expect(CHAT_DIAGNOSTIC_NOTICE).toMatch(/does not authorise/i)
    expect(CHAT_DIAGNOSTIC_NOTICE).toMatch(/only you approve/i)
  })
})
