import type { OwnerDiagnostics } from '@/lib/diagnostics/owner-surface'
import { blockerLabels, cohortKindLabel } from '@/lib/diagnostics/blocker-labels'
import type { DeliverySubStatusEvidence } from '@/lib/platforms/meta/delivery-sub-status'
import type {
  PaidCreativeDirection,
  PaidCreativeEvidence,
} from '@/lib/creative/paid-outcomes'
import type { VisionPaidAttributeDirection } from '@/lib/creative/vision-paid-attribute-outcomes'
import { outcomeNoun } from '@/config/outcome-nouns'
import { formatMoney } from '@/lib/utils/format-currency'

function Unavailable({ reason }: { reason: string }) {
  return (
    <p className="text-xs" style={{ color: 'var(--warning)' }}>
      Unavailable — {reason}
    </p>
  )
}

function DeliverySubStatus({ evidence }: { evidence: DeliverySubStatusEvidence }) {
  if (!evidence.read_available) {
    return (
      <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
        Meta delivery sub-status unavailable
      </p>
    )
  }
  if (evidence.payload === null) {
    return (
      <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
        Meta reported no delivery sub-status
      </p>
    )
  }

  const status = evidence.payload.status ?? 'status unspecified'
  const substatuses = evidence.payload.substatuses
  return (
    <p className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--warning)' }}>
      <strong>Meta delivery sub-status: {status}</strong>
      {substatuses.length > 0 ? ` · ${substatuses.join(', ')}` : ''}
    </p>
  )
}

function countLabel(value: number, singular: string, plural = `${singular}s`) {
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`
}

function PaidCreativeRow({ creative }: { creative: PaidCreativeEvidence }) {
  const name = creative.creative_name ?? `Meta creative ${creative.meta_creative_id}`
  if (creative.status === 'blocked') {
    return (
      <div className="rounded-lg p-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{name}</p>
          <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {countLabel(creative.contributing_meta_ad_ids.length, 'contributing ad')}
          </p>
        </div>
        <p className="text-[11px] mt-1" style={{ color: 'var(--warning)' }}>
          Blocked — {blockerLabels(creative.blocker_codes) ?? 'reason unavailable'}
        </p>
      </div>
    )
  }

  const outcomes = creative.outcomes
  return (
    <div className="rounded-lg p-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{name}</p>
        <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          {countLabel(creative.contributing_meta_ad_ids.length, 'contributing ad')}
        </p>
      </div>
      <p className="text-[11px] mt-1 leading-relaxed tabular-nums" style={{ color: 'var(--text-secondary)' }}>
        ${outcomes.spend.toFixed(2)} spend · {countLabel(outcomes.captured_touches, 'captured touch', 'captured touches')} ·{' '}
        {countLabel(outcomes.value_bearing_bookings, `value-bearing ${outcomeNoun({ plural: false })}`)} · {formatMoney(outcomes.booked_value)} booked value ·{' '}
        {countLabel(outcomes.zero_value_bookings, `zero-value ${outcomeNoun({ plural: false })}`)} · {countLabel(outcomes.canceled_links, 'canceled link')}
      </p>
    </div>
  )
}

function PaidDirection({
  direction,
  heading,
}: {
  direction: PaidCreativeDirection
  heading: string
}) {
  const blockers = [...new Set([
    ...direction.blocker_codes,
    ...direction.creatives.flatMap((creative) => creative.blocker_codes),
  ])]
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{heading}</p>
      <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
        Source: governed last-paid-touch · Status: {direction.status} · Window {direction.window_start}–{direction.window_end}
      </p>
      {direction.status === 'blocked' ? (
        <>
          <p className="text-[11px]" style={{ color: 'var(--warning)' }}>
            Blocked — {blockerLabels(blockers) ?? 'reason unavailable'}
          </p>
          {direction.creatives.length > 0 && (
            <div className="space-y-2">
              {direction.creatives.map((creative) => (
                <PaidCreativeRow
                  key={`${creative.generation_id}:${creative.meta_creative_id}`}
                  creative={creative}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="space-y-2">
          {direction.creatives.map((creative) => (
            <PaidCreativeRow
              key={`${creative.generation_id}:${creative.meta_creative_id}`}
              creative={creative}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function PaidAttributeDirection({ direction }: { direction: VisionPaidAttributeDirection }) {
  if (direction.status === 'blocked') {
    return (
      <p className="text-[11px]" style={{ color: 'var(--warning)' }}>
        {cohortKindLabel(direction.cohort_kind)} blocked — {blockerLabels(direction.blocker_codes) ?? 'evidence unavailable'}
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
        {cohortKindLabel(direction.cohort_kind)}
      </p>
      {direction.blocker_codes.length > 0 && (
        <p className="text-[11px]" style={{ color: 'var(--warning)' }}>
          Partial governed evidence — {blockerLabels(direction.blocker_codes)}; affected creatives are omitted from numeric groups
        </p>
      )}
      {direction.missing_versioned_vision_count > 0 && (
        <p className="text-[11px]" style={{ color: 'var(--warning)' }}>
          {countLabel(direction.missing_versioned_vision_count, 'creative')} omitted without current versioned vision evidence
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {direction.groups.map((group) => (
          <div
            key={`${direction.generation_id}:${group.attribute}:${group.value}`}
            className="rounded-lg p-3"
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}
          >
            <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
              {group.attribute}: {group.value}
            </p>
            <p className="text-[11px] mt-1 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
              {countLabel(group.creative_count, 'creative')} · ${group.outcomes.spend.toFixed(2)} spend ·{' '}
              {countLabel(group.outcomes.value_bearing_bookings, `value-bearing ${outcomeNoun({ plural: false })}`)} ·{' '}
              ${group.outcomes.booked_value.toFixed(2)} booked value
            </p>
            {group.sparse && (
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                Sparse descriptive group
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export function OwnerDiagnosticsPanel({ diagnostics }: { diagnostics: OwnerDiagnostics | null }) {
  return (
    <div className="card-base overflow-hidden">
      <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="section-label">Maxx diagnostic read</p>
          <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            Diagnostic only · no recommendation authority
          </p>
        </div>
        {diagnostics && (
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
            Evidence window {diagnostics.window.from}–{diagnostics.window.to}
          </p>
        )}
      </div>

      {!diagnostics ? (
        <div className="px-5 py-4">
          <Unavailable reason="this report predates the structured diagnostic snapshot" />
        </div>
      ) : (
        <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
          <section className="px-5 py-4 space-y-3">
            <p className="section-label">Delivery &amp; learning</p>
            {!diagnostics.delivery.available ? (
              <Unavailable reason={diagnostics.delivery.reason} />
            ) : (
              <>
                <div>
                  <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {diagnostics.delivery.data.headline}
                  </p>
                  <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    {diagnostics.delivery.data.read}
                  </p>
                </div>

                {diagnostics.delivery.data.window_settle && (
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    <strong style={{ color: 'var(--text-primary)' }}>
                      {diagnostics.delivery.data.window_settle.state === 'settled' ? 'Settled window.' : 'Provisional window.'}
                    </strong>{' '}
                    {diagnostics.delivery.data.window_settle.detail}
                  </p>
                )}

                <div className="space-y-2">
                  {diagnostics.delivery.data.adsets_detail.map((adset) => (
                    <div key={adset.name} className="rounded-lg p-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{adset.name}</p>
                        <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                          {adset.learning_phase ?? 'learning phase unavailable'}
                        </p>
                      </div>
                      <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                        {adset.results_to_exit === null
                          ? 'Learning exit count unavailable'
                          : `${adset.results_to_exit} results to exit`}
                        {adset.last_sig_edit ? ` · last significant edit ${adset.last_sig_edit}` : ''}
                      </p>
                      <p className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                        {adset.learning_exit_feasibility.basis}
                      </p>
                      <DeliverySubStatus evidence={adset.delivery_sub_status} />
                      {adset.cause_hints.length > 0 && (
                        <ul className="mt-2 pl-4 list-disc space-y-1">
                          {adset.cause_hints.map((hint) => (
                            <li key={hint} className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{hint}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>

                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  {diagnostics.delivery.data.structure.spend_concentration.detail}
                </p>
              </>
            )}
          </section>

          <section className="px-5 py-4 space-y-3">
            <p className="section-label">Creative delivery observations</p>
            {!diagnostics.creative.available ? (
              <Unavailable reason={diagnostics.creative.reason} />
            ) : diagnostics.creative.data.observations.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>No ad delivery was observed in this window.</p>
            ) : (
              <>
                <div className="space-y-2">
                  {diagnostics.creative.data.observations.map((observation) => (
                    <div key={observation.ad_id} className="rounded-lg p-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{observation.ad_name}</p>
                        <p className="text-[11px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
                          ${observation.metrics.spend.toFixed(2)} spend · {observation.metrics.impressions.toLocaleString()} impressions
                        </p>
                      </div>
                      <DeliverySubStatus evidence={observation.delivery_sub_status} />
                      <ul className="mt-2 space-y-1">
                        {observation.diagnostic.signals.map((signal) => (
                          <li key={signal.label} className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                            <strong style={{ color: 'var(--text-primary)' }}>{signal.label}:</strong> {signal.detail}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                  {diagnostics.creative.data.note}
                </p>
              </>
            )}
          </section>

          <section className="px-5 py-4 space-y-3">
            <p className="section-label">Paid creative outcomes</p>
            {!diagnostics.creative_paid_outcomes.available ? (
              <p className="text-xs" style={{ color: 'var(--warning)' }}>
                Read unavailable — {diagnostics.creative_paid_outcomes.reason}
              </p>
            ) : (
              <>
                {diagnostics.creative_paid_outcomes.data.status === 'not_published' ? (
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    Source: governed last-paid-touch · Status: not published
                  </p>
                ) : (
                  <div className="space-y-4">
                    {diagnostics.creative_paid_outcomes.data.recent_scale && (
                      <PaidDirection
                        direction={diagnostics.creative_paid_outcomes.data.recent_scale}
                        heading="Recent paid cohort"
                      />
                    )}
                    {diagnostics.creative_paid_outcomes.data.matured_cut && (
                      <PaidDirection
                        direction={diagnostics.creative_paid_outcomes.data.matured_cut}
                        heading="Matured paid cohort"
                      />
                    )}
                  </div>
                )}
                <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                  {diagnostics.creative_paid_outcomes.data.note}
                </p>
              </>
            )}
          </section>

          <section className="px-5 py-4 space-y-3">
            <p className="section-label">Paid outcomes by versioned vision attribute</p>
            {!diagnostics.creative_paid_attribute_distributions.available ? (
              <p className="text-xs" style={{ color: 'var(--warning)' }}>
                Read unavailable — {diagnostics.creative_paid_attribute_distributions.reason}
              </p>
            ) : diagnostics.creative_paid_attribute_distributions.data.status === 'not_published' ? (
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                Status: not published
              </p>
            ) : (
              <>
                <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                  Non-additive · diagnostic only · totals across attributes must not be summed
                </p>
                <div className="space-y-4">
                  {diagnostics.creative_paid_attribute_distributions.data.recent_scale && (
                    <PaidAttributeDirection
                      direction={diagnostics.creative_paid_attribute_distributions.data.recent_scale}
                    />
                  )}
                  {diagnostics.creative_paid_attribute_distributions.data.matured_cut && (
                    <PaidAttributeDirection
                      direction={diagnostics.creative_paid_attribute_distributions.data.matured_cut}
                    />
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
