'use client'

import { BRIEF_LIMITS, MAX_VARIANTS, type CopyBriefInput } from '@/lib/creative/copy-brief'
import {
  AUDIENCE_TEMPERATURES, COPY_GOALS, COPY_PLACEMENTS, type AudienceTemperature, type CopyGoal, type CopyPlacement,
} from '@/lib/creative/copy-rules'

// The generation brief. Every field is labelled for screen readers and bounded with the same limits
// the API enforces (src/lib/creative/copy-brief.ts), so the form cannot submit what the server refuses.

export interface BriefState {
  goal: CopyGoal
  product: string
  offer: string
  temperature: AudienceTemperature
  audience: string
  tone: string
  constraints: string
  variants: number
  placements: CopyPlacement[]
}

export const INITIAL_BRIEF: BriefState = {
  goal: 'bookings', product: '', offer: '', temperature: 'cold', audience: '', tone: '', constraints: '', variants: 4, placements: ['feed'],
}

export function briefPayload(b: BriefState): CopyBriefInput {
  return {
    goal: b.goal, product: b.product.trim(), offer: b.offer.trim(), tone: b.tone.trim(), constraints: b.constraints.trim(),
    audience: { temperature: b.temperature, description: b.audience.trim() }, variants: b.variants,
    placements: b.placements.length ? b.placements : ['feed'],
  }
}

const inputStyle = { width: '100%', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 13, background: 'var(--bg-surface)', color: 'var(--text-primary)' }
const labelClass = 'block text-[12.5px] font-medium mb-1'

export function BriefForm({ brief, onChange, onSubmit, disabled, busy, disabledReason }: {
  brief: BriefState
  onChange: (next: BriefState) => void
  onSubmit: () => void
  disabled: boolean
  busy: boolean
  disabledReason: string | null
}) {
  const set = <K extends keyof BriefState>(key: K, value: BriefState[K]) => onChange({ ...brief, [key]: value })
  return (
    <form className="card-base p-4 space-y-3" aria-label="Copy brief" onSubmit={(e) => { e.preventDefault(); onSubmit() }}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label htmlFor="copy-goal" className={labelClass}>Goal</label>
          <select id="copy-goal" value={brief.goal} onChange={(e) => set('goal', e.target.value as CopyGoal)} style={inputStyle}>
            {COPY_GOALS.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="copy-temperature" className={labelClass}>Audience</label>
          <select id="copy-temperature" value={brief.temperature} onChange={(e) => set('temperature', e.target.value as AudienceTemperature)} style={inputStyle}>
            {AUDIENCE_TEMPERATURES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="md:col-span-2">
          <label htmlFor="copy-product" className={labelClass}>Product or service (required)</label>
          <input id="copy-product" required minLength={2} maxLength={BRIEF_LIMITS.product} value={brief.product} onChange={(e) => set('product', e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label htmlFor="copy-offer" className={labelClass}>Offer</label>
          <input id="copy-offer" maxLength={BRIEF_LIMITS.offer} value={brief.offer} onChange={(e) => set('offer', e.target.value)} style={inputStyle} placeholder="Only a real, current offer" />
        </div>
        <div>
          <label htmlFor="copy-audience" className={labelClass}>Who they are</label>
          <input id="copy-audience" maxLength={BRIEF_LIMITS.audience} value={brief.audience} onChange={(e) => set('audience', e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label htmlFor="copy-tone" className={labelClass}>Tone</label>
          <input id="copy-tone" maxLength={BRIEF_LIMITS.tone} value={brief.tone} onChange={(e) => set('tone', e.target.value)} style={inputStyle} placeholder="plain, warm, direct" />
        </div>
        <div>
          <label htmlFor="copy-variants" className={labelClass}>Variants</label>
          <input id="copy-variants" type="number" min={1} max={MAX_VARIANTS} value={brief.variants}
            onChange={(e) => set('variants', Math.min(MAX_VARIANTS, Math.max(1, Number(e.target.value) || 1)))} style={inputStyle} />
        </div>
        <div className="md:col-span-2">
          <label htmlFor="copy-constraints" className={labelClass}>Constraints</label>
          <textarea id="copy-constraints" rows={2} maxLength={BRIEF_LIMITS.constraints} value={brief.constraints} onChange={(e) => set('constraints', e.target.value)} style={inputStyle} />
        </div>
      </div>
      <fieldset>
        <legend className={labelClass}>Placements</legend>
        <div className="flex gap-4 flex-wrap text-[13px]">
          {COPY_PLACEMENTS.map((p) => (
            <label key={p} className="flex items-center gap-1.5">
              <input type="checkbox" checked={brief.placements.includes(p)}
                onChange={(e) => set('placements', e.target.checked ? [...brief.placements, p] : brief.placements.filter((x) => x !== p))} />
              {p}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex items-center gap-3 flex-wrap">
        <button type="submit" className="owner-button" disabled={disabled || busy} aria-describedby={disabledReason ? 'copy-generate-reason' : undefined}
          style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, opacity: disabled ? 0.55 : 1 }}>
          {busy ? 'Writing…' : 'Generate variants'}
        </button>
        {disabledReason && <p id="copy-generate-reason" className="text-[12.5px]" style={{ color: 'var(--text-tertiary)' }}>{disabledReason}</p>}
      </div>
    </form>
  )
}
