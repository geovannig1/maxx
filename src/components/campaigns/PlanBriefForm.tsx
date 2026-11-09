'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Sparkles } from 'lucide-react'
import { PLAN_GOALS, PLAN_GOAL_LABEL, type PlanGoal } from '@/lib/campaigns/plan-brief'

// ADR-062: the brief that starts a campaign plan. Maxx drafts a complete plan from it (the model when
// AI is on and "Draft with AI" is ticked; the template planner otherwise) and stores it as a draft.

export const fieldStyle: React.CSSProperties = { minHeight: 44, background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text-primary)' }
export const labelClass = 'text-[12px] flex flex-col gap-1'

export function PlanBriefForm({ aiOn, today }: { aiOn: boolean; today: string }) {
  const router = useRouter()
  const [goal, setGoal] = useState<PlanGoal>('sales')
  const [product, setProduct] = useState('')
  const [offer, setOffer] = useState('')
  const [budget, setBudget] = useState('')
  const [countries, setCountries] = useState('US')
  const [start, setStart] = useState(today)
  const [end, setEnd] = useState('')
  const [audience, setAudience] = useState('')
  const [destination, setDestination] = useState('')
  const [useAi, setUseAi] = useState(aiOn)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/campaigns/plans', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal, product, offer, daily_budget: Number(budget), audience_description: audience,
          countries: countries.split(/[\s,]+/).filter(Boolean), start_date: start, end_date: end || null,
          destination_url: destination || null, use_ai: useAi && aiOn,
        }),
      })
      const body = (await response.json().catch(() => ({}))) as { plan_id?: string; error?: string; fields?: string[] }
      if (response.ok && body.plan_id) { router.push(`/campaigns/plans/${body.plan_id}`); return }
      setError(body.fields?.length ? `Check: ${body.fields.join(', ')}.` : body.error ?? 'The plan could not be drafted.')
    } catch {
      setError('The plan could not be drafted (network error).')
    } finally {
      setBusy(false)
    }
  }

  const input = (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} className="rounded-lg px-3 text-[13px]" style={fieldStyle} />
  return (
    <form onSubmit={submit} data-plan-brief className="card-base p-4 space-y-4" aria-describedby="plan-brief-note">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
          Goal
          <select value={goal} onChange={(e) => setGoal(e.target.value as PlanGoal)} className="rounded-lg px-3 text-[13px]" style={fieldStyle}>
            {PLAN_GOALS.map((g) => <option key={g} value={g}>{PLAN_GOAL_LABEL[g]}</option>)}
          </select>
        </label>
        <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
          Daily budget (account currency)
          {input({ required: true, inputMode: 'decimal', value: budget, onChange: (e) => setBudget(e.target.value), placeholder: 'e.g. 30' })}
        </label>
        <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
          Product or service
          {input({ required: true, minLength: 2, maxLength: 200, value: product, onChange: (e) => setProduct(e.target.value) })}
        </label>
        <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
          Offer (optional)
          {input({ maxLength: 300, value: offer, onChange: (e) => setOffer(e.target.value) })}
        </label>
        <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
          Countries (two-letter codes)
          {input({ required: true, value: countries, onChange: (e) => setCountries(e.target.value.toUpperCase()), placeholder: 'US, CA' })}
        </label>
        <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
          Who it is for (optional)
          {input({ maxLength: 300, value: audience, onChange: (e) => setAudience(e.target.value) })}
        </label>
        <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
          Start date
          {input({ required: true, type: 'date', min: today, value: start, onChange: (e) => setStart(e.target.value) })}
        </label>
        <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
          End date (optional)
          {input({ type: 'date', min: start, value: end, onChange: (e) => setEnd(e.target.value) })}
        </label>
        <label className={`${labelClass} sm:col-span-2`} style={{ color: 'var(--text-secondary)' }}>
          Landing page (optional; defaults to the page set in your business profile)
          {input({ type: 'url', maxLength: 2048, value: destination, onChange: (e) => setDestination(e.target.value), placeholder: 'https://' })}
        </label>
      </div>
      <label className="flex items-center gap-2 text-[13px]" style={{ color: aiOn ? 'var(--text-secondary)' : 'var(--text-disabled)', minHeight: 44 }}>
        <input type="checkbox" checked={useAi && aiOn} disabled={!aiOn} onChange={(e) => setUseAi(e.target.checked)} style={{ width: 18, height: 18 }} />
        Draft with AI {aiOn ? '(one planning call and one copy call)' : '(AI is off: the template planner drafts it, with copy from your Copy studio bank)'}
      </label>
      <button type="submit" disabled={busy} className="flex items-center gap-1.5 rounded-lg px-4 text-[13px] font-semibold disabled:opacity-60"
        style={{ minHeight: 44, color: 'var(--on-accent)', background: 'var(--accent)', border: 'none' }}>
        <Sparkles size={14} aria-hidden /> {busy ? 'Drafting…' : 'Draft the plan'}
      </button>
      <p id="plan-brief-note" className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
        Drafting stores a plan you can edit. Nothing is sent to Meta until you submit it, approve it on Changes and write mode is on, and then everything is created paused.
      </p>
      {error && <p role="alert" className="text-[12px]" style={{ color: 'var(--danger)' }}>{error}</p>}
    </form>
  )
}
