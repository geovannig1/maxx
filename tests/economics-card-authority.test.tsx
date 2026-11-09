import './_support/outcome-noun-booking'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const state = vi.hoisted(() => ({
  read: {
    status: 'unavailable',
    inputs: null,
    reason_code: 'not_configured',
    unavailable_reason: 'Economics inputs have not been configured.',
    provenance: null,
  } as Record<string, unknown>,
}))

vi.mock('@/lib/economics/settings', () => ({
  loadEconomicsInputs: vi.fn(async () => state.read),
}))

describe('EconomicsCard evidence separation', () => {
  beforeEach(() => {
    state.read = {
      status: 'unavailable',
      inputs: null,
      reason_code: 'not_configured',
      unavailable_reason: 'Economics inputs have not been configured.',
      provenance: null,
    }
  })

  it('keeps ledger business value and Meta modelled delivery in separate labelled planes', async () => {
    const { EconomicsCard } = await import('@/components/dashboard/EconomicsCard')
    const html = renderToStaticMarkup(await EconomicsCard({
      business: { available: true, bookedValue: 1000, valueBearingBookings: 4, blendedMer: 2 },
      metaDelivery: { available: true, spend: 500, modelledResults: 9 },
    }))

    expect(html).toMatch(/outcome ledger · all sources/)
    expect(html).toMatch(/\$1,?000\.00/)
    expect(html).toMatch(/Meta modelled events/)
    expect(html).toMatch(/>9</)
    expect(html).toMatch(/Active bookings only; not paid attribution/)
    expect(html).not.toMatch(/refund|cancell/i)
    expect(html).not.toMatch(/Current CPA|Target CPA|Beating the champion|raise-budget/i)
  })

  it('keeps missing economics inputs unknown instead of fabricating the old default', async () => {
    const { EconomicsCard } = await import('@/components/dashboard/EconomicsCard')
    const html = renderToStaticMarkup(await EconomicsCard({
      business: { available: false, bookedValue: 0, valueBearingBookings: 0, blendedMer: null },
      metaDelivery: { available: true, spend: 72, modelledResults: 0 },
    }))

    expect(html).toMatch(/Planning economics unavailable/)
    expect(html).toMatch(/Unknown is not replaced with a default/)
    expect(html).not.toContain('$275.00')
  })

  it('does not turn an unavailable Meta insight read into zero delivery', async () => {
    const { EconomicsCard } = await import('@/components/dashboard/EconomicsCard')
    const html = renderToStaticMarkup(await EconomicsCard({
      business: { available: true, bookedValue: 1000, valueBearingBookings: 4, blendedMer: null },
      metaDelivery: { available: false, unavailableReason: 'Account-level Meta insight data could not be read.' },
    }))

    expect(html).toMatch(/Meta spend/)
    expect(html).toMatch(/Account-level Meta insight data could not be read/)
    expect(html).toMatch(/No zero or status inferred/)
    expect(html).not.toMatch(/\$0\.00/)
  })

  it('labels stored economics as unversioned planning context rather than owner-approved fact', async () => {
    state.read = {
      status: 'available',
      inputs: { aov: 300, gross_margin_rate: 0.5, repeat_rate: null, source_note: 'Manual input' },
      reason_code: null,
      unavailable_reason: null,
      provenance: {
        source: 'app_settings.economics_inputs',
        status: 'unversioned_app_setting',
        updated_at: null,
        owner_approval_recorded: false,
        version_recorded: false,
      },
    }
    const { EconomicsCard } = await import('@/components/dashboard/EconomicsCard')
    const html = renderToStaticMarkup(await EconomicsCard({
      business: { available: true, bookedValue: 1200, valueBearingBookings: 4, blendedMer: 3 },
      metaDelivery: { available: true, spend: 400, modelledResults: 5 },
    }))

    expect(html).toMatch(/Manual AOV input \$300\.00/)
    expect(html).toMatch(/modeled gross-margin scenario \$150\.00/)
    expect(html).toMatch(/Not settled cash or incremental contribution/)
    expect(html).not.toMatch(/contribution estimate/i)
    expect(html).toMatch(/unversioned/)
    expect(html).toMatch(/immutable owner approval is not recorded/)
  })
})
