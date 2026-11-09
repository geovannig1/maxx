import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AlertCard } from '@/components/inbox/AlertCard'
import { AdDetail } from '@/components/reporting/AdDetail'
import { OverviewCreativeDetails } from '@/components/reporting/OverviewCreativeDetails'
import { OVERVIEW_EVENTS } from '@/lib/reporting/overview-model'
import type { InboxAlert } from '@/lib/inbox/group'
import type { ReportEntity } from '@/lib/reporting/contracts'
import { creativeAd, creativeContext, creativeData } from './fixtures/reporting-creative'

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''), usePathname: () => '/creative',
}))

/**
 * Hrefs built from stored data (alert rows, Meta creative destinations) are untrusted: a `javascript:`
 * or `data:` value would run in the owner's console on click. Each such anchor must go through
 * safeHref and render without an href when it is rejected; an https URL must still link.
 */
const HOSTILE = ['javascript:alert(document.cookie)', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==']
const SAFE = 'https://example.test/book?utm_source=meta'

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map(m => m[1])
}

function expectNoHostileHref(html: string) {
  for (const href of hrefs(html)) {
    expect(href).not.toMatch(/^\s*(javascript|data):/i)
  }
}

function alert(action_url: string | null): InboxAlert {
  return {
    id: 'a1', alert_type: 'tracking', severity: 'warning', title: 'Pixel quiet', message: 'No events in 24h',
    alert_date: null, detected_at: '2026-11-01T00:00:00.000Z', is_resolved: false, entity_level: null,
    meta_campaign_id: null, meta_adset_id: null, meta_ad_id: null, metric_name: null, metric_value: null,
    baseline_value: null, why_it_matters: null, recommended_actions: null, amount_at_risk: null,
    action_label: 'Open Events Manager', action_url,
  }
}

function withDestination(destination: string): ReportEntity {
  const ad = creativeAd('301')
  return { ...ad, creative: { ...ad.creative!, destination } }
}

describe('AlertCard action link', () => {
  it.each(HOSTILE)('renders no href for %s', (url) => {
    const html = renderToStaticMarkup(<AlertCard alert={alert(url)} onResolve={() => {}} resolving={false} />)
    expectNoHostileHref(html)
    expect(html).toContain('Open Events Manager')
  })

  it('links an https action_url and keeps the Ads Manager default for a missing one', () => {
    expect(hrefs(renderToStaticMarkup(<AlertCard alert={alert(SAFE)} onResolve={() => {}} resolving={false} />))).toContain(SAFE)
    expect(hrefs(renderToStaticMarkup(<AlertCard alert={alert(null)} onResolve={() => {}} resolving={false} />))).toContain('https://adsmanager.facebook.com')
  })
})

describe('creative destination links', () => {
  it.each(HOSTILE)('AdDetail renders no href for %s', (url) => {
    const ad = withDestination(url)
    const html = renderToStaticMarkup(<AdDetail entity={ad} context={creativeContext} meta={creativeData([ad]).meta.data!} />)
    expectNoHostileHref(html)
  })

  it.each(HOSTILE)('OverviewCreativeDetails renders no href for %s', (url) => {
    const html = renderToStaticMarkup(<OverviewCreativeDetails entity={withDestination(url)} context={creativeContext} event={OVERVIEW_EVENTS.appointment_confirmed} />)
    expectNoHostileHref(html)
  })

  it('both surfaces link an https destination', () => {
    const ad = withDestination(SAFE)
    expect(hrefs(renderToStaticMarkup(<AdDetail entity={ad} context={creativeContext} meta={creativeData([ad]).meta.data!} />))).toContain(SAFE)
    expect(hrefs(renderToStaticMarkup(<OverviewCreativeDetails entity={ad} context={creativeContext} event={OVERVIEW_EVENTS.appointment_confirmed} />))).toContain(SAFE)
  })
})
