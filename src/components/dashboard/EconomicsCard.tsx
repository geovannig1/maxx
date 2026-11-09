import { loadEconomicsInputs } from '@/lib/economics/settings'
import { CHAMPION_BENCHMARK } from '@/lib/economics/champion'
import { outcomeNoun } from '@/config/outcome-nouns'
import { formatMoney } from '@/lib/utils/format-currency'

interface EconomicsCardProps {
  business: {
    available: boolean
    bookedValue: number
    valueBearingBookings: number
    blendedMer: number | null
  }
  metaDelivery:
    | { available: true; spend: number; modelledResults: number }
    | { available: false; unavailableReason: string }
}

function money(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${formatMoney(value)}`
}

/**
 * Business truth and platform delivery are rendered as separate planes. This card never divides the
 * Meta modelled result count into spend, compares current delivery to a target/champion, or emits a
 * money action. Historical Meta records remain collapsed audit context only.
 */
export async function EconomicsCard({ business, metaDelivery }: EconomicsCardProps) {
  const economicsRead = await loadEconomicsInputs()
  const inputs = economicsRead.status === 'available' ? economicsRead.inputs : null
  const repeatRate = inputs?.repeat_rate ?? 0
  const manualGrossMarginScenario = inputs?.gross_margin_rate == null
    ? null
    : inputs.aov * inputs.gross_margin_rate * (1 + repeatRate)

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '20px', height: '100%', boxShadow: '0 1px 3px rgba(16,24,40,0.08)' }}>
      <div className="flex items-center justify-between mb-4">
        <p className="section-label">Business economics &amp; Meta delivery</p>
        <span style={{ fontSize: '10px', fontWeight: 650, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>No action authority</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 24px', marginBottom: '16px' }}>
        <div>
          <p style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>Booked value <span style={{ fontSize: '9px' }}>(outcome ledger · all sources)</span></p>
          <p style={{ fontSize: '20px', fontWeight: 700, color: business.available ? 'var(--text-primary)' : 'var(--text-tertiary)', letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>
            {business.available ? money(business.bookedValue) : 'Unavailable'}
          </p>
          {business.available && <p style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{business.valueBearingBookings} value-bearing {outcomeNoun({ count: business.valueBearingBookings })}</p>}
        </div>
        <div>
          <p style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>Active amount / Meta spend <span style={{ fontSize: '9px' }}>(all-source active amount_paid ÷ complete spend)</span></p>
          <p style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>
            {business.available && business.blendedMer !== null ? `${business.blendedMer.toFixed(2)}x` : '—'}
          </p>
          <p style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginTop: '2px' }}>Active {outcomeNoun()} only; not paid attribution</p>
        </div>
        <div>
          <p style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>Meta spend</p>
          <p style={{ fontSize: '20px', fontWeight: 700, color: metaDelivery.available ? 'var(--text-primary)' : 'var(--text-tertiary)', letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>
            {metaDelivery.available ? money(metaDelivery.spend) : 'Unavailable'}
          </p>
          <p style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{metaDelivery.available ? 'Raw platform delivery' : metaDelivery.unavailableReason}</p>
        </div>
        <div>
          <p style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>Meta modelled events</p>
          <p style={{ fontSize: '20px', fontWeight: 700, color: metaDelivery.available ? 'var(--text-primary)' : 'var(--text-tertiary)', letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>
            {metaDelivery.available ? metaDelivery.modelledResults : 'Unavailable'}
          </p>
          <p style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{metaDelivery.available ? 'Not exact source-linked outcomes' : 'No zero or status inferred'}</p>
        </div>
      </div>

      <div style={{ paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
        <p style={{ fontSize: '11px', fontWeight: 650, color: 'var(--text-secondary)' }}>Planning inputs</p>
        {inputs ? (
          <>
            <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', lineHeight: 1.45, marginTop: '4px' }}>
              Manual AOV input {money(inputs.aov)} · modeled gross-margin scenario {money(manualGrossMarginScenario)} per assumed {outcomeNoun({ plural: false })}
              {inputs.gross_margin_rate === null ? ' (gross margin unavailable)' : ''}.
              {/* economics/model.ts:46 pushes this exact assumption into its output when the rate is
                  null. The card ran the same `?? 0` and said nothing, so the scenario silently
                  assumed no repeat business — which understates LTV and the breakeven CPA. */}
              {inputs.repeat_rate === null
                ? ' Repeat rate unknown — this scenario assumes no repeat business.'
                : ''}
            </p>
            <p style={{ fontSize: '10px', color: 'var(--warning)', lineHeight: 1.45, marginTop: '4px' }}>
              Not settled cash or incremental contribution. This stored setting is unversioned; immutable owner approval is not recorded. Planning context only.
            </p>
          </>
        ) : (
          <p style={{ fontSize: '11px', color: 'var(--warning)', lineHeight: 1.45, marginTop: '4px' }}>
            Planning economics unavailable — {economicsRead.unavailable_reason} Unknown is not replaced with a default.
          </p>
        )}
      </div>

      <details style={{ marginTop: '12px' }}>
        <summary style={{ fontSize: '11px', fontWeight: 650, color: 'var(--text-tertiary)', cursor: 'pointer' }}>Historical Meta record — audit context only</summary>
        <p style={{ fontSize: '10.5px', color: 'var(--text-tertiary)', lineHeight: 1.5, marginTop: '6px' }}>
          {CHAMPION_BENCHMARK.adset_name}: {formatMoney(CHAMPION_BENCHMARK.lifetime_cpa)} historical Meta-attributed result cost across {CHAMPION_BENCHMARK.bookings} modelled results ({CHAMPION_BENCHMARK.period.start}–{CHAMPION_BENCHMARK.period.end}). It used a different measurement era and is not a current target, status, or instruction.
        </p>
      </details>
    </div>
  )
}
