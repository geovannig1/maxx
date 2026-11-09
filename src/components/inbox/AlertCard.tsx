'use client'

// Extracted VERBATIM from the old Alerts page (src/app/(dashboard)/alerts/page.tsx) so the Action Inbox
// renders alerts with identical markup, severity config, and the same PATCH /api/alerts/[id] resolve verb.
// Only the row type changed (AlertData → InboxAlert, defined in @/lib/inbox/group).

import { useState } from 'react'
import {
  AlertTriangle,
  XCircle,
  Info,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Coins,
} from 'lucide-react'
import { PROPOSED_ACTIONS_LABEL, READ_ONLY_APPLY_NOTE } from '@/lib/ui/proposal'
import { alertMetricLabel } from '@/lib/conversions/labels'
import { format, parseISO } from 'date-fns'
import type { InboxAlert } from '@/lib/inbox/group'
import { safeHref } from '@/lib/ui/safe-href'
import { formatMoney } from '@/lib/utils/format-currency'

const SEVERITY = {
  critical: {
    Icon: XCircle,
    label: 'Critical',
    borderLeft: '3px solid var(--danger)',
    bg: 'var(--danger-bg)',
    border: 'var(--danger-border)',
    iconColor: 'var(--danger)',
    pillStyle: {
      background: 'var(--danger-bg)',
      color: 'var(--danger)',
      border: '1px solid var(--danger-border)',
    },
  },
  warning: {
    Icon: AlertTriangle,
    label: 'Warning',
    borderLeft: '3px solid var(--warning)',
    bg: 'var(--warning-bg)',
    border: 'var(--warning-border)',
    iconColor: 'var(--warning)',
    pillStyle: {
      background: 'var(--warning-bg)',
      color: 'var(--warning)',
      border: '1px solid var(--warning-border)',
    },
  },
  info: {
    Icon: Info,
    label: 'Info',
    borderLeft: '3px solid var(--info)',
    bg: 'var(--info-bg)',
    border: 'var(--info-border)',
    iconColor: 'var(--info)',
    pillStyle: {
      background: 'var(--info-bg)',
      color: 'var(--info)',
      border: '1px solid var(--info-border)',
    },
  },
}

const TYPE_LABELS: Record<string, string> = {
  delivery_signal: 'Delivery Signal',
  auction_delivery_signal: 'Auction / Delivery Signal',
  modelled_outcome_signal: 'Modelled Outcome Signal',
  configuration_observation: 'Configuration Observation',
  measurement_health_signal: 'Measurement Health Signal',
  account_signal: 'Account Signal',
  spend_spike: 'Spend Spike',
  spend_drop: 'Spend Drop',
  ctr_drop: 'CTR Drop',
  cpa_spike: 'CPL Spike',
  cpm_spike: 'CPM Spike',
  frequency_high: 'High Frequency',
  zero_leads: 'Zero Leads',
  creative_fatigue: 'Creative Fatigue',
  budget_exhausted: 'Budget Exhausted',
  campaign_paused: 'Campaign Paused',
  wrong_optimization_event: 'Wrong Optimization Event',
  pixel_health: 'Pixel Health',
  champion_candidate: 'Champion Candidate',
  data_drift: 'Data Drift',
}

function formatDate(d: string | null): string {
  if (!d) return ''
  try {
    return format(parseISO(d), 'MMM d')
  } catch {
    return d
  }
}

export function AlertCard({
  alert,
  onResolve,
  resolving,
}: {
  alert: InboxAlert
  onResolve: (id: string) => void
  resolving: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const cfg = SEVERITY[alert.severity] ?? SEVERITY.info
  const Icon = cfg.Icon
  // action_url is stored data; a non-http(s) value renders the label as plain text, never as a link.
  const actionHref = alert.action_url == null ? 'https://adsmanager.facebook.com' : safeHref(alert.action_url)

  const resolvedStyle: React.CSSProperties = {
    borderLeft: '3px solid var(--border)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-lg)',
    opacity: 0.6,
  }

  const activeStyle: React.CSSProperties = {
    borderLeft: cfg.borderLeft,
    background: cfg.bg,
    border: `1px solid ${cfg.border}`,
    borderRadius: 'var(--r-lg)',
  }

  return (
    <div style={alert.is_resolved ? resolvedStyle : activeStyle}>
      {/* Header row */}
      <div className="px-5 pt-4 pb-3">
        <div className="flex items-start gap-3">
          <Icon
            className="w-4 h-4 mt-0.5 shrink-0"
            style={{ color: alert.is_resolved ? 'var(--text-tertiary)' : cfg.iconColor }}
          />

          <div className="flex-1 min-w-0">
            {/* Top meta row */}
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span
                className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full"
                style={
                  alert.is_resolved
                    ? {
                        background: 'var(--bg-elevated)',
                        color: 'var(--text-tertiary)',
                        border: '1px solid var(--border)',
                      }
                    : cfg.pillStyle
                }
              >
                {cfg.label}
              </span>
              {alert.alert_type && (
                <span
                  className="text-[10px] font-medium uppercase tracking-wide"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  {TYPE_LABELS[alert.alert_type] ?? alert.alert_type}
                </span>
              )}
              {alert.amount_at_risk !== null && !alert.is_resolved && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ml-auto"
                  style={{
                    background: 'var(--danger-bg)',
                    color: 'var(--danger)',
                    border: '1px solid var(--danger-border)',
                  }}
                >
                  <Coins className="w-2.5 h-2.5" />
                  {formatMoney(alert.amount_at_risk, { maximumFractionDigits: 0 })} at risk
                </span>
              )}
              {alert.is_resolved && (
                <span className="ml-auto text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                  Resolved
                </span>
              )}
            </div>

            {/* Title */}
            <p
              className="text-sm font-semibold leading-snug"
              style={{ color: 'var(--text-primary)' }}
            >
              {alert.title}
            </p>

            {/* Situation — the what */}
            <p
              className="text-xs mt-1 leading-relaxed"
              style={{ color: 'var(--text-secondary)' }}
            >
              {alert.message}
            </p>

            {/* Date + entity context */}
            <div
              className="flex items-center gap-3 mt-1.5 text-[10px]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {alert.alert_date && <span>{formatDate(alert.alert_date)}</span>}
              {alert.entity_level && (
                <span className="capitalize">{alert.entity_level} level</span>
              )}
              {/* metric_name is also required: without it this read ": 1.00 vs baseline 6.00",
                  a pair of numbers with nothing saying what they measure. */}
              {alert.metric_name !== null && alert.metric_value !== null && alert.baseline_value !== null && (
                <span>
                  {alertMetricLabel(alert.metric_name)}: {alert.metric_value?.toFixed(2)} vs baseline{' '}
                  {alert.baseline_value?.toFixed(2)}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Why it matters + actions — expandable */}
      {(alert.why_it_matters || alert.recommended_actions?.length) && !alert.is_resolved && (
        <>
          <div
            className="mx-5"
            style={{ borderTop: '1px solid var(--border)', opacity: 0.5 }}
          />
          <div className="px-5 py-2">
            <button
              onClick={() => setExpanded((e) => !e)}
              className="flex items-center gap-1 rounded-lg text-xs font-medium transition-colors"
              style={{ color: 'var(--accent-hover)', minHeight: 44, padding: '0 4px' }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLElement).style.color = 'var(--accent)')
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLElement).style.color = 'var(--accent-hover)')
              }
            >
              {expanded ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
              {expanded ? 'Hide details' : 'Why this matters & what to do'}
            </button>

            {expanded && (
              <div className="mt-3 space-y-3">
                {alert.why_it_matters && (
                  <div>
                    <p
                      className="text-[10px] font-semibold uppercase tracking-wider mb-1"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      Why it matters
                    </p>
                    <p
                      className="text-xs leading-relaxed"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {alert.why_it_matters}
                    </p>
                  </div>
                )}

                {alert.recommended_actions && alert.recommended_actions.length > 0 && (
                  <div>
                    <p
                      className="text-[10px] font-semibold uppercase tracking-wider mb-1"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {PROPOSED_ACTIONS_LABEL}
                    </p>
                    <p className="text-[11px] leading-relaxed mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
                      {READ_ONLY_APPLY_NOTE}
                    </p>
                    <ol className="space-y-1.5">
                      {alert.recommended_actions.map((action, i) => (
                        <li
                          key={i}
                          className="flex gap-2 text-xs leading-relaxed"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          <span
                            className="shrink-0 w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center mt-0.5"
                            style={{
                              background: 'var(--accent-dim)',
                              color: 'var(--accent-hover)',
                            }}
                          >
                            {i + 1}
                          </span>
                          {action}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* CTA row */}
      {!alert.is_resolved && (
        <div className="px-5 pb-4 pt-1 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
          {alert.action_label && !actionHref && (
            <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{alert.action_label}</span>
          )}
          {alert.action_label && actionHref && (
            <a
              href={actionHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1.5 text-xs font-semibold px-3 rounded-lg transition-colors"
              style={{
                background: 'var(--accent)',
                color: 'var(--on-accent)',
                minHeight: 44,
              }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLElement).style.background = 'var(--accent-hover)')
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLElement).style.background = 'var(--accent)')
              }
            >
              {alert.action_label}
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
          <button
            onClick={() => onResolve(alert.id)}
            disabled={resolving}
            className="text-xs font-medium transition-colors disabled:opacity-50"
            style={{
              minHeight: 44,
              padding: '0 10px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              borderRadius: 'var(--r-sm)',
              fontSize: '12px',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLElement
              el.style.borderColor = 'var(--success)'
              el.style.color = 'var(--success)'
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLElement
              el.style.borderColor = 'var(--border)'
              el.style.color = 'var(--text-secondary)'
            }}
          >
            {resolving ? 'Marking done…' : 'Mark as resolved'}
          </button>
        </div>
      )}
    </div>
  )
}
