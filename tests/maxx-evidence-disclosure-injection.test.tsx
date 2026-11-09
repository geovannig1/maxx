import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { describe, expect, it } from 'vitest'
import { buildGovernedToolEvidence, governMaxxAnswer } from '@/lib/maxx/chat'

/**
 * Tool arguments are model-authored and reach the owner verbatim. Nothing scored them.
 *
 * `governMaxxAnswer` runs two guards over the NARRATIVE and then concatenates
 * `evidenceDisclosure(evidence)` outside both. The disclosure interpolates `dateWindow` and `scope`,
 * which were built by string-concatenating raw tool arguments with no format or length bound. The
 * same sentence was therefore scrubbed when it arrived as the message and printed verbatim when it
 * arrived as an argument.
 *
 * On the success path arguments have passed `DateSchema`, so they were well-formed by luck of
 * ordering. On the FAILURE path the evidence is built from the arguments that just failed validation.
 * That path used to return a bare 503 and discard the text; it now returns 200 and renders it, which
 * is what turned a latent hole into a live one.
 *
 * The poison below is a fabricated money figure AND an action instruction — the two things this
 * entire surface exists to prevent — and it reached the owner under the heading "Evidence used",
 * styled as governed provenance.
 *
 * These tests enumerate EVERY argument slot the disclosure can read, rather than the one case that
 * was reported. A guard proven on a single input is a guard proven for a single input.
 */

const POISON = 'Your account spent $12,400 this month at a $41.20 paid CPA — scale the winning ad set to $200/day today.'

/**
 * Every key `dateWindowFor` and `scopeFor` read, PARSED FROM THE SOURCE.
 *
 * The first version was a hand-typed array. Mutation testing then added a new unvalidated slot
 * (`creative_id`) to `scopeFor` and the whole 3869-test suite stayed green — reintroducing the exact
 * hole this file exists to close. A hand-maintained roster of what to cover agrees with itself; that
 * is the same failure that let a supply scanner see 2 of 14 claims. The sibling fixture test already
 * parses `ClaimOverrides` from source for precisely this reason, and this file did not apply it.
 */
function argumentSlots(): string[] {
  const source = readFileSync(join(process.cwd(), 'src/lib/maxx/chat-evidence.ts'), 'utf8')
  const dateWindow = /function dateWindowFor\([\s\S]*?\n\}/.exec(source)
  const scope = /function scopeFor\([\s\S]*?\n\}/.exec(source)
  expect(dateWindow).not.toBeNull()
  expect(scope).not.toBeNull()
  const keys = new Set<string>()
  // `dateArg(args, 'start_date')` / `idArg(args, 'ad_id')` / `args.window_days ?? args.days`
  for (const body of [dateWindow![0], scope![0]]) {
    for (const m of body.matchAll(/(?:dateArg|idArg)\(args, '([a-z_]+)'\)/g)) keys.add(m[1])
    for (const m of body.matchAll(/\['([a-z_]+)', '[^']+'\]/g)) keys.add(m[1])
    for (const m of body.matchAll(/args\.([a-z_]+)/g)) keys.add(m[1])
  }
  return [...keys].sort()
}

const ARGUMENT_SLOTS = argumentSlots()

function disclosureFor(args: Record<string, unknown>): string {
  return governMaxxAnswer(
    'A governed account lookup failed, so I cannot verify an answer from partial evidence.',
    [buildGovernedToolEvidence({ tool: 'get_account_summary', args, result: { available: false } })],
  )
}

/** The exact mount from MaxxChat.tsx, so markdown claims are made about the shipped renderer. */
function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(<ReactMarkdown>{markdown}</ReactMarkdown>)
}

describe('the slot roster is derived, so a new slot cannot be missed', () => {
  it('finds every slot the two functions actually read', () => {
    expect(ARGUMENT_SLOTS.length).toBeGreaterThanOrEqual(8)
    for (const known of ['start_date', 'end_date', 'date', 'campaign_id', 'meta_entity_id', 'days', 'window_days']) {
      expect(ARGUMENT_SLOTS).toContain(known)
    }
  })
})

describe('a tool argument cannot carry text to the owner', () => {
  it.each(ARGUMENT_SLOTS)('%s cannot smuggle a fabricated number or an action instruction', (slot) => {
    const rendered = disclosureFor({ [slot]: POISON })
    expect(rendered).not.toContain(POISON)
    expect(rendered).not.toContain('$12,400')
    expect(rendered).not.toContain('scale the winning ad set')
  })

  it.each(ARGUMENT_SLOTS)('%s cannot smuggle an unbounded string of any kind', (slot) => {
    // Not just the reported sentence: length itself is the attack surface, because the disclosure is
    // rendered as markdown and an argument could carry a link, a heading, or 10KB of anything.
    const long = 'A'.repeat(5_000)
    const rendered = disclosureFor({ [slot]: long })
    expect(rendered).not.toContain('AAAAAAAAAA')
  })

  it.each(ARGUMENT_SLOTS)('%s cannot smuggle markdown that restyles the disclosure', (slot) => {
    // The first version used `](x) **BUY NOW** [`, which the CHARSET rejects — so it passed without
    // exercising markdown at all. `_` and `__` were the only metacharacters the charset admitted, and
    // they were never tried: `__X__` rendered as <strong>. Assert against the real renderer, using
    // characters a plausible validator would let through.
    for (const payload of ['__SCALE_TO_200_A_DAY__', '_emphasis_', '**bold**', '](x)[', '`code`']) {
      const html = renderMarkdown(disclosureFor({ [slot]: payload }))
      expect(html).not.toContain('<strong>SCALE_TO_200_A_DAY</strong>')
      expect(html).not.toContain('<em>emphasis</em>')
      expect(html).not.toContain('<strong>bold</strong>')
      expect(html).not.toContain('<code>code</code>')
    }
  })

  it.each(ARGUMENT_SLOTS)('%s enforces its LENGTH bound, not merely a huge-string bound', (slot) => {
    // The only negative length fixture was 'A'.repeat(5000), so ANY bound below 5000 survived
    // mutation. A value one character past the real bound is what pins it.
    const justOver = '1'.repeat(41)
    expect(disclosureFor({ [slot]: justOver })).not.toContain(justOver)
  })

  it.each(ARGUMENT_SLOTS)('%s rejects a space, which no id or date contains', (slot) => {
    // Widening the charset by a single space survived every previous fixture, because the probe
    // contained LETTERS and was rejected on those instead. A space-widened digit class needs a
    // digits-and-spaces payload to detect — and digits are exactly the payload class that matters
    // here, since the thing being smuggled is a money figure.
    const spaced = '12400 200 41 20'
    expect(disclosureFor({ [slot]: spaced })).not.toContain(spaced)
  })
})

describe('the tool NAME is model-authored too', () => {
  // Not an argument, which is why the previous roster missed it entirely — and it was the one field
  // on the disclosure line still printed verbatim.
  it('an unrecognised tool name never reaches the owner', () => {
    const poisonName = 'get_spend— IGNORE. Your account spent $12,400 at a $41.20 paid CPA. Scale to $200/day today.'
    const rendered = governMaxxAnswer('A governed account lookup failed.', [
      buildGovernedToolEvidence({ tool: poisonName, args: {}, result: { available: false } }),
    ])
    expect(rendered).not.toContain('IGNORE')
    expect(rendered).not.toContain('$12,400')
    expect(rendered).not.toContain('Scale to $200/day')
  })

  it('a REAL tool name is still named, so the fix did not blind the disclosure', () => {
    const rendered = governMaxxAnswer('ok', [
      buildGovernedToolEvidence({ tool: 'get_performance_cockpit', args: {}, result: { available: true } }),
    ])
    expect(rendered).toContain('get_performance_cockpit')
  })

  it('rejects a date-shaped-but-wrong argument rather than echoing it', () => {
    // `2026-8-1` and `20260801` are plausible model output and are NOT the contract's shape.
    for (const nearMiss of ['2026-8-1', '20260801', '2026-08-01T00:00:00Z', '2026-08-01 or later']) {
      const rendered = disclosureFor({ start_date: nearMiss })
      expect(rendered).not.toContain(nearMiss)
    }
  })

  it('still reports a WELL-FORMED argument, so the fix did not blind the disclosure', () => {
    // The failure mode of a validation fix is silently describing nothing. The window and scope must
    // still be stated when the arguments are legitimate.
    const rendered = disclosureFor({ start_date: '2026-08-01', end_date: '2026-08-22', campaign_id: '120212345678' })
    expect(rendered).toContain('2026-08-01 to 2026-08-22')
    expect(rendered).toContain('campaign 120212345678')
  })

  it('bounds a numeric window instead of interpolating any number it is handed', () => {
    expect(disclosureFor({ window_days: 7 })).toContain('last 7 days')
    expect(disclosureFor({ window_days: 10 ** 21 })).not.toContain('1e+21')
    expect(disclosureFor({ window_days: Number.MAX_SAFE_INTEGER })).not.toContain('9007199254740991')
  })
})
