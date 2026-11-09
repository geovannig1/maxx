'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Send } from 'lucide-react'
import { formatMoney } from '@/lib/utils/format-currency'

// ADR-059: the owner turns one of Maxx's decisions into a concrete change proposal. The server
// re-checks every rule; this form only collects the amount or name the decision leaves open and the
// explicit override confirmation for a budget step above the per-change limit.

export interface ProposableDecisionView {
  id: string
  action_kind: string
  action_type: 'pause_ad' | 'activate_ad' | 'adjust_budget' | 'duplicate_adset'
  target_level: 'ad' | 'adset'
  target_id: string
  target_name: string | null
  authority_tier: 'execution_eligible' | 'owner_review'
  owner_copy: string
  synced_daily_budget: number | null
}

const TITLE: Record<ProposableDecisionView['action_type'], string> = {
  pause_ad: 'Pause ad', activate_ad: 'Activate ad', adjust_budget: 'Set daily budget', duplicate_adset: 'Duplicate ad set as paused',
}

interface ProposeResponse { status?: string; message?: string; error?: string; step_percent?: number; max_step_percent?: number; preview?: string }

export function ProposeChangeForm({ decision, highlighted = false }: { decision: ProposableDecisionView; highlighted?: boolean }) {
  const router = useRouter()
  const [amount, setAmount] = useState('')
  const [name, setName] = useState(decision.target_name ? `${decision.target_name} (copy)` : '')
  const [busy, setBusy] = useState(false)
  const [needsOverride, setNeedsOverride] = useState<{ step: number; cap: number } | null>(null)
  const [outcome, setOutcome] = useState<{ text: string; ok: boolean } | null>(null)
  const direction = decision.action_kind === 'budget_scale' ? 'Raise' : decision.action_kind === 'budget_cut' ? 'Lower' : null

  async function propose(confirmOverride: boolean) {
    setBusy(true)
    setOutcome(null)
    const params = decision.action_type === 'adjust_budget'
      ? { new_daily_budget: amount }
      : decision.action_type === 'duplicate_adset' ? { new_name: name, new_daily_budget: amount || null } : {}
    try {
      const response = await fetch('/api/changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action_decision_id: decision.id, params, confirm_override: confirmOverride }),
      })
      const body = (await response.json().catch(() => ({}))) as ProposeResponse
      if (body.status === 'STEP_LIMIT_EXCEEDED' && typeof body.step_percent === 'number') {
        setNeedsOverride({ step: body.step_percent, cap: body.max_step_percent ?? 50 })
        setOutcome({ text: body.message ?? 'This step is above the per-change limit.', ok: false })
      } else if (response.ok) {
        setNeedsOverride(null)
        setOutcome({ text: `${body.status === 'ALREADY_REQUESTED' ? 'Already waiting for your review' : 'Proposed'}: ${body.preview ?? ''} Review it above.`, ok: true })
        router.refresh()
      } else {
        setOutcome({ text: body.message ?? body.error ?? 'The change could not be proposed.', ok: false })
      }
    } catch {
      setOutcome({ text: 'The change could not be proposed (network error).', ok: false })
    } finally {
      setBusy(false)
    }
  }

  return (
    <article id={`propose-${decision.id}`} data-proposable-decision={decision.id} className="card-base p-4 space-y-3"
      style={highlighted ? { boxShadow: '0 0 0 2px var(--accent)' } : undefined}>
      <div>
        <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {direction && decision.action_type === 'adjust_budget' ? `${direction} daily budget` : TITLE[decision.action_type]}
          <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}> · {decision.target_name ?? decision.target_id}</span>
        </p>
        <p className="text-[12px] mt-1" style={{ color: 'var(--text-secondary)' }}>{decision.owner_copy}</p>
        <p className="text-[11.5px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
          Maxx authority: {decision.authority_tier === 'owner_review' ? 'owner review (your call, not execution-eligible on its own)' : 'execution-eligible'}
        </p>
      </div>

      {(decision.action_type === 'adjust_budget' || decision.action_type === 'duplicate_adset') && (
        <div className="flex gap-3 flex-wrap items-end">
          {decision.action_type === 'duplicate_adset' && (
            <label className="text-[12px] flex flex-col gap-1" style={{ color: 'var(--text-secondary)' }}>
              Name of the copy
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} className="rounded-lg px-3 text-[13px]"
                style={{ minHeight: 44, background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
            </label>
          )}
          <label className="text-[12px] flex flex-col gap-1" style={{ color: 'var(--text-secondary)' }}>
            {decision.action_type === 'adjust_budget' ? 'New daily budget' : 'Daily budget of the copy (optional)'}
            <input inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setNeedsOverride(null) }} className="rounded-lg px-3 text-[13px]"
              placeholder={decision.synced_daily_budget !== null ? `now ${formatMoney(decision.synced_daily_budget)}` : 'amount per day'}
              style={{ minHeight: 44, width: 180, background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
          </label>
        </div>
      )}
      {decision.synced_daily_budget !== null && decision.action_type === 'adjust_budget' && (
        <p className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
          Last synced budget {formatMoney(decision.synced_daily_budget)}/day. The live budget is read again when you propose.
        </p>
      )}

      <div className="flex gap-2 flex-wrap">
        <button type="button" disabled={busy || (decision.action_type === 'adjust_budget' && !amount.trim())} onClick={() => propose(false)}
          className="flex items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-semibold disabled:opacity-60"
          style={{ minHeight: 44, color: 'var(--on-accent)', background: 'var(--accent)', border: 'none' }}>
          <Send size={14} /> {busy ? 'Working…' : 'Propose this change'}
        </button>
        {needsOverride && (
          <button type="button" disabled={busy} onClick={() => propose(true)}
            className="flex items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-semibold disabled:opacity-60"
            style={{ minHeight: 44, color: 'var(--on-accent)', background: 'var(--danger)', border: 'none' }}>
            <AlertTriangle size={14} /> Propose anyway: {needsOverride.step > 0 ? '+' : ''}{needsOverride.step}% is above the {needsOverride.cap}% limit
          </button>
        )}
      </div>
      <p className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>Proposing changes nothing. You approve it on its own card.</p>
      {outcome && <p role="status" className="text-[12px]" style={{ color: outcome.ok ? 'var(--success)' : 'var(--danger)' }}>{outcome.text}</p>}
    </article>
  )
}
