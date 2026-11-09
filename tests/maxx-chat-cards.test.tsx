import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AssistantTurn, turnFromResponse } from '@/components/maxx/MaxxChat'
import type { ChatCard } from '@/lib/maxx/chat-cards'

// ADR-062: an Ask Maxx action answers with a card under the governed lead. The card shows what was
// produced and where the owner reviews it; it has no approve or apply control of its own.

const render = (cards: ChatCard[]) => renderToStaticMarkup(
  <AssistantTurn turn={turnFromResponse({ text: 'I drafted a campaign plan.', availability: 'available', cards })} />)

describe('Ask Maxx action cards', () => {
  it('renders copy variants with their scores and a link to the Copy studio', () => {
    const html = render([{ kind: 'copy', withheld: 1, href: '/creative/copy', variants: [
      { angle: 'offer', primary_text: 'Book a bright studio by the hour.', headline: 'Studio by the hour', description: '', cta: 'BOOK_NOW', score: 92, status: 'ready', warnings: [] },
    ] }])
    expect(html).toContain('data-chat-card="copy"')
    expect(html).toContain('Book a bright studio by the hour.')
    expect(html).toMatch(/92\/100/)
    expect(html).toMatch(/1 variant withheld by the copy scorer/)
    expect(html).toContain('href="/creative/copy"')
  })

  it('renders a plan summary with its readiness and a review link, and no approve control', () => {
    const html = render([{ kind: 'plan', plan_id: 'p1', version_id: 'v1', href: '/campaigns/plans/p1', source: 'template', name: 'Spring', objective: 'OUTCOME_SALES',
      daily_budget: '$40.00', ad_sets: 1, ads: 3, new_creatives: 3, blockers: 1, warnings: 0, readiness: [{ label: 'Budget sanity', status: 'ok' }], notes: [] }])
    expect(html).toContain('data-chat-card="plan"')
    expect(html).toContain('href="/campaigns/plans/p1"')
    expect(html).toContain('$40.00')
    expect(html).toMatch(/1 blocker/)
    expect(html).not.toMatch(/Approve/)
  })

  it('renders a pending proposal that links to Changes, and a refusal', () => {
    const html = render([{ kind: 'approval', change_request_id: 'cr1', href: '/changes', preview: 'Raise ad set "Warm" daily budget.', risk_level: 'high', status: 'PENDING_APPROVAL' }])
    expect(html).toContain('data-chat-card="approval"')
    expect(html).toContain('href="/changes"')
    expect(html).toMatch(/Waiting for your approval/)
    const refusal = render([{ kind: 'refusal', action: 'draft_campaign_plan', code: 'NEEDS_DAILY_BUDGET', message: 'Tell me the daily budget.' }])
    expect(refusal).toContain('data-chat-card="refusal"')
    expect(refusal).toContain('Tell me the daily budget.')
  })

  it('keeps a turn without cards exactly as before', () => {
    expect(renderToStaticMarkup(<AssistantTurn turn={turnFromResponse({ text: 'Governed evidence is shown below.', availability: 'available' })} />)).not.toContain('data-chat-card')
  })
})
