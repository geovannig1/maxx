import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantTurn, turnFromResponse } from '@/components/maxx/MaxxChat'

/**
 * The withheld answer has to reach the owner's SCREEN, not just the return value.
 *
 * `route.ts` used to discard `result.text` on `availability === 'unavailable'` and return a bare 503,
 * so every one of the nine composed refusal strings was dead on the product surface: the client
 * throws on `!res.ok` and paints one generic red banner. The refusals were observable only by calling
 * `runMaxxChat` directly from a script — which is exactly how they came to be believed working.
 *
 * Mutation testing then found the fix itself unguarded: reverting `route.ts` to the bare 503 left
 * the whole suite green, and `MaxxChat.tsx` had no test at all. So the honesty work in this area was
 * verifiable only the same way the original bug was — by not looking at the surface.
 *
 * Both halves are covered here: the route returns the text, and the client renders it as a withheld
 * turn rather than an error or an authoritative answer.
 */

const state = vi.hoisted(() => ({ runMaxxChat: vi.fn(), enforceApiRateLimit: vi.fn() }))

vi.mock('@/lib/maxx/chat', () => ({
  runMaxxChat: state.runMaxxChat,
  maxxChatEnabled: () => true,
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'owner-id', email: 'owner@example.com' } } }) } }),
}))
vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: () => null }))
vi.mock('@/lib/security/api-rate-limit', () => ({ enforceApiRateLimit: state.enforceApiRateLimit }))

const WITHHELD_TEXT = 'I checked get acuity bookings, and none of those publish a citable governed claim.'

async function post() {
  const { POST } = await import('@/app/api/maxx/chat/route')
  const { NextRequest } = await import('next/server')
  return POST(new NextRequest('http://localhost/api/maxx/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'How many bookings?' }] }),
  }))
}

describe('the route returns the withheld explanation instead of discarding it', () => {
  beforeEach(() => {
    vi.resetModules()
    state.enforceApiRateLimit.mockResolvedValue(null)
    state.runMaxxChat.mockResolvedValue({
      text: WITHHELD_TEXT,
      toolsUsed: ['get_outcome_bookings'],
      evidence: [],
      availability: 'unavailable',
      brief: null,
      claims: new Map(),
    })
  })
  afterEach(() => vi.clearAllMocks())

  it('sends the composed text to the client, not a bare error', async () => {
    const response = await post()
    const body = await response.json()
    expect(body.text).toBe(WITHHELD_TEXT)
    expect(body.availability).toBe('unavailable')
  })

  it('uses a success status, because the request succeeded and the ANSWER is the refusal', async () => {
    const response = await post()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('still returns 503 with no detail when the call THROWS', async () => {
    // The distinction the change rests on: a thrown provider or tool error has no composed text and
    // must not leak. Losing this would turn the fix into an information leak.
    state.runMaxxChat.mockRejectedValueOnce(new Error('Anthropic 401: secret provider detail'))
    const response = await post()
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(JSON.stringify(body)).not.toContain('secret provider detail')
    expect(body.text).toBeUndefined()
  })
})

describe('the client renders a withheld answer as withheld', () => {
  // These import the REAL exports from MaxxChat.tsx. The first version of this block defined a local
  // `turnFrom()` that re-implemented the component's mapping and asserted on that — so setting the
  // component's `withheld` to a constant `false`, removing the badge from every withheld answer, left
  // all 3869 tests green. The file's own doc block named that failure mode three paragraphs above
  // committing it.

  it('maps an unavailable response to a withheld turn, not an error', () => {
    const turn = turnFromResponse({ text: WITHHELD_TEXT, availability: 'unavailable' })
    expect(turn.withheld).toBe(true)
    expect(turn.content).toBe(WITHHELD_TEXT)
  })

  it('does not flag a normal answer as withheld', () => {
    expect(turnFromResponse({ text: 'Governed evidence is shown below.', availability: 'available' }).withheld).toBe(false)
  })

  it('renders the withheld badge, so the reader can see the answer is not an answer', () => {
    const html = renderToStaticMarkup(
      <AssistantTurn turn={turnFromResponse({ text: WITHHELD_TEXT, availability: 'unavailable' })} />,
    )
    expect(html).toContain('Answer withheld')
    expect(html).toContain('var(--warning-border)')
  })

  it('does NOT render the badge on a normal answer', () => {
    const html = renderToStaticMarkup(
      <AssistantTurn turn={turnFromResponse({ text: 'Governed evidence is shown below.', availability: 'available' })} />,
    )
    expect(html).not.toContain('Answer withheld')
    expect(html).not.toContain('var(--warning-border)')
  })

  it('renders the explanation as readable prose, so the reason is actually legible', () => {
    const html = renderToStaticMarkup(
      <AssistantTurn turn={turnFromResponse({ text: WITHHELD_TEXT, availability: 'unavailable' })} />,
    )
    expect(html).toContain('none of those publish a citable governed claim')
    expect(html).toContain('<p')
  })

  it('names the tools it checked, sanitised', () => {
    const html = renderToStaticMarkup(
      <AssistantTurn turn={turnFromResponse({
        text: WITHHELD_TEXT, availability: 'unavailable', toolsUsed: ['get_outcome_bookings'],
      })} />,
    )
    expect(html).toContain('acuity bookings')
  })
})
