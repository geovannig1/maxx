'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Save, Send } from 'lucide-react'
import type { CampaignPlanSpec, PlanStatus } from '@/lib/campaigns/plan-spec'
import type { PlanIssue } from '@/lib/campaigns/plan-validation'
import { FieldIssues, PlanIssueList } from './PlanChecklist'
import { PlanAdSetFields, type AudienceOption } from './PlanAdSetFields'
import { fieldStyle, labelClass } from './PlanBriefForm'

// ADR-062: review and edit one plan version. "Save as new version" stores the edit (the server
// re-validates it); "Submit for approval" turns the current draft into a change request on /changes.
// Nothing here approves, creates or activates anything.

const EDITABLE: readonly PlanStatus[] = ['draft', 'rejected', 'failed', 'created_paused', 'archived', 'superseded']

export function PlanEditor({ planId, versionId, status, spec: initial, issues, audiences, minorPerMajor, writeMode }: {
  planId: string; versionId: string; status: PlanStatus; spec: CampaignPlanSpec; issues: readonly PlanIssue[]
  audiences: readonly AudienceOption[]; minorPerMajor: number; writeMode: 'on' | 'off' | 'demo'
}) {
  const router = useRouter()
  const [spec, setSpec] = useState<CampaignPlanSpec>(initial)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean; changes?: boolean } | null>(null)
  const [stepConfirm, setStepConfirm] = useState<string | null>(null)
  const readOnly = !EDITABLE.includes(status)
  const toMinor = (major: number) => Math.round(major * minorPerMajor)
  const fromMinor = (minor: number) => minor / minorPerMajor
  const edit = (change: (draft: CampaignPlanSpec) => void) => {
    const next = structuredClone(spec)
    change(next)
    setSpec(next)
    setDirty(true)
  }
  const blockers = issues.filter((i) => i.severity === 'blocker').length

  async function call(url: string, body: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { ok: response.ok, body: (await response.json().catch(() => ({}))) as Record<string, unknown> }
  }

  async function save() {
    setBusy(true)
    setMessage(null)
    try {
      const result = await call(`/api/campaigns/plans/${planId}/versions`, { spec })
      setMessage(result.ok ? { text: 'Saved as a new version and validated again.', ok: true } : { text: String(result.body.error ?? 'The edit could not be saved.'), ok: false })
      if (result.ok) { setDirty(false); router.refresh() }
    } catch { setMessage({ text: 'The edit could not be saved (network error).', ok: false }) } finally { setBusy(false) }
  }

  async function submit(confirm: boolean) {
    setBusy(true)
    setMessage(null)
    try {
      const result = await call(`/api/campaigns/plans/${planId}/submit`, { version_id: versionId, confirm_budget_step: confirm })
      if (result.body.code === 'STEP_LIMIT_EXCEEDED') { setStepConfirm(String(result.body.error)); return }
      setStepConfirm(null)
      setMessage(result.ok ? { text: 'Submitted. Approve it on Changes: it creates everything PAUSED.', ok: true, changes: true } : { text: String(result.body.error ?? 'The plan could not be submitted.'), ok: false })
      if (result.ok) router.refresh()
    } catch { setMessage({ text: 'The plan could not be submitted (network error).', ok: false }) } finally { setBusy(false) }
  }

  const c = spec.campaign
  return (
    <div className="space-y-4" data-plan-editor>
      <section className="card-base p-4 space-y-3" aria-labelledby="plan-campaign-title">
        <h2 id="plan-campaign-title" className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          Campaign · {c.objective.replace('OUTCOME_', '').toLowerCase()} · {c.budget_mode === 'CBO' ? 'campaign budget' : 'ad set budgets'} · {c.bid_strategy === 'COST_CAP' ? 'cost cap' : 'lowest cost'}
        </h2>
        <fieldset disabled={readOnly} className="grid gap-3 sm:grid-cols-2">
          <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>Name
            <input value={c.name} maxLength={200} onChange={(e) => edit((s) => { s.campaign.name = e.target.value })} className="rounded-lg px-3 text-[13px]" style={fieldStyle} />
          </label>
          {c.budget_mode === 'CBO' && (
            <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>Daily budget ({spec.currency})
              <input inputMode="decimal" value={c.daily_budget_minor === null ? '' : String(fromMinor(c.daily_budget_minor))}
                onChange={(e) => edit((s) => { s.campaign.daily_budget_minor = e.target.value ? toMinor(Number(e.target.value)) : null })} className="rounded-lg px-3 text-[13px]" style={fieldStyle} />
              <FieldIssues issues={issues} path="campaign.daily_budget_minor" />
            </label>
          )}
          <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>Start date
            <input type="date" value={spec.schedule.start_date} onChange={(e) => edit((s) => { s.schedule.start_date = e.target.value })} className="rounded-lg px-3 text-[13px]" style={fieldStyle} />
            <FieldIssues issues={issues} path="schedule.start_date" />
          </label>
          <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>End date (optional)
            <input type="date" value={spec.schedule.end_date ?? ''} onChange={(e) => edit((s) => { s.schedule.end_date = e.target.value || null })} className="rounded-lg px-3 text-[13px]" style={fieldStyle} />
          </label>
          <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>Bidding
            <select value={c.bid_strategy} onChange={(e) => edit((s) => { s.campaign.bid_strategy = e.target.value as typeof c.bid_strategy; if (e.target.value !== 'COST_CAP') s.campaign.bid_amount_minor = null })}
              className="rounded-lg px-3 text-[13px]" style={fieldStyle}>
              <option value="LOWEST_COST_WITHOUT_CAP">Lowest cost (recommended)</option>
              <option value="COST_CAP">Cost cap (you set the cap)</option>
            </select>
          </label>
          {c.bid_strategy === 'COST_CAP' && (
            <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>Cost cap per result
              <input inputMode="decimal" value={c.bid_amount_minor === null ? '' : String(fromMinor(c.bid_amount_minor))}
                onChange={(e) => edit((s) => { s.campaign.bid_amount_minor = e.target.value ? toMinor(Number(e.target.value)) : null })} className="rounded-lg px-3 text-[13px]" style={fieldStyle} />
              <FieldIssues issues={issues} path="campaign.bid_amount_minor" />
            </label>
          )}
        </fieldset>
        <FieldIssues issues={issues} path="campaign" exact />
        <FieldIssues issues={issues} path="conversion" />
      </section>

      {spec.ad_sets.map((_, i) => (
        <PlanAdSetFields key={spec.ad_sets[i].key} spec={spec} index={i} edit={edit} issues={issues} audiences={audiences} readOnly={readOnly} toMinor={toMinor} fromMinor={fromMinor} />
      ))}

      <section className="card-base p-4 space-y-3" aria-labelledby="plan-validation-title">
        <h2 id="plan-validation-title" className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Validation of this version</h2>
        {dirty && <p className="text-[12px]" style={{ color: 'var(--warning)' }}>You have unsaved edits. Save them to validate them.</p>}
        <PlanIssueList issues={issues} />
        <div className="flex gap-2 flex-wrap">
          {!readOnly && (
            <button type="button" onClick={save} disabled={busy || !dirty} className="flex items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-semibold disabled:opacity-60"
              style={{ minHeight: 44, color: 'var(--text-primary)', background: 'var(--bg-subtle)', border: '1px solid var(--border-hover)' }}>
              <Save size={14} aria-hidden /> {busy ? 'Working…' : 'Save as new version'}
            </button>
          )}
          {status === 'draft' && (
            <button type="button" onClick={() => submit(false)} disabled={busy || dirty || blockers > 0} data-plan-submit
              className="flex items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-semibold disabled:opacity-60"
              style={{ minHeight: 44, color: 'var(--on-accent)', background: 'var(--accent)', border: 'none' }}>
              <Send size={14} aria-hidden /> Submit for approval
            </button>
          )}
          {stepConfirm && (
            <button type="button" onClick={() => submit(true)} disabled={busy} className="flex items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-semibold"
              style={{ minHeight: 44, color: 'var(--on-accent)', background: 'var(--danger)', border: 'none' }}>
              <AlertTriangle size={14} aria-hidden /> Submit anyway: {stepConfirm}
            </button>
          )}
        </div>
        <p className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
          {writeMode === 'demo' ? 'Demo: approving simulates the creation on the sample data.' : writeMode === 'on' ? 'Write mode is on: once approved on Changes, every object is created in Meta, PAUSED.' : 'Write mode is off: you can submit and approve, and the objects are created once write mode is on.'}
        </p>
        {message && (
          <p role="status" className="text-[12px]" style={{ color: message.ok ? 'var(--success)' : 'var(--danger)' }}>
            {message.text} {message.changes && <Link href="/changes" style={{ color: 'var(--accent)' }}>Open Changes</Link>}
          </p>
        )}
      </section>
    </div>
  )
}
