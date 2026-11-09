import React from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AttributionSection,
  type AttributionUtm,
} from '@/components/diagnostics/AttributionSection'
import { explainQuiet } from '@/lib/recommendations/quiet'
import { computeStatusCards } from '@/lib/trust/status-cards'

const legacyCanonical =
  'utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}'

describe('legacy readable-name UTM guidance stays diagnostic-only', () => {
  it('does not expose a paste-ready tracking setup from reconciliation or the diagnostics UI', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/lib/diagnostics/reconciliation-report.ts'),
      'utf8',
    )

    expect(source).not.toMatch(/CANONICAL_UTM_STRING|canonical_string/)
    expect(source).toContain(
      "tracking_contract_status: 'unavailable_until_campaign_plan'",
    )
    expect(source).toContain(
      "verification_status: 'unavailable_until_campaign_plan'",
    )
    expect(source).not.toMatch(/booking_linkage:\s*assessBookingLinkage/)

    const legacyPayload = {
      coverage: 1,
      scope: 'active_ads',
      ads_total: 1,
      ads_correct: 1,
      ads_missing: 0,
      ads_misconfigured: 0,
      offenders: [],
      canonical_string: legacyCanonical,
      tracking_contract_status: 'unavailable_until_campaign_plan',
      booking_linkage: {
        suspected: false,
        label: 'ASSUMPTION',
        rationale: 'No contradiction observed.',
        verification_status: 'unavailable_until_campaign_plan',
      },
      source_label: 'Observed Meta delivery fields',
    } as unknown as AttributionUtm

    const html = renderToStaticMarkup(<AttributionSection utm={legacyPayload} />)

    expect(html).toMatch(/unavailable until a CampaignPlan/i)
    expect(html).toMatch(/diagnostic/i)
    expect(html).toMatch(/never unlocks paid ROAS/i)
    expect(html).not.toMatch(/Paste into Ads Manager|>Copy<|Copied|utm_source=meta/)
  })

  it('does not describe readable UTM coverage as a launch or paid-ROAS unlock', () => {
    const quiet = explainQuiet({
      dataMode: 'pre_launch',
      attributionCoverage: 0.2,
    })
    const copy = [...quiet.reasons, ...quiet.unlocks].join(' ')

    expect(copy).toMatch(/CampaignPlan/i)
    expect(copy).toMatch(/immutable Meta IDs/i)
    expect(copy).toMatch(/UTM coverage alone never unlocks paid ROAS/i)
    expect(copy).not.toMatch(/Launch campaigns with the corrected UTM string/i)
    expect(copy).not.toMatch(/Fix UTMs so .* bookings attribute/i)

    const attribution = computeStatusCards({
      attributedShare: 0.8,
    }).find((card) => card.key === 'attribution')

    expect(`${attribution?.headline} ${attribution?.detail ?? ''}`).toMatch(
      /never unlocks paid ROAS/i,
    )
  })
})
