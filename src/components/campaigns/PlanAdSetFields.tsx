'use client'

import { Trash2 } from 'lucide-react'
import { META_CTAS } from '@/lib/creative/copy-rules'
import type { CampaignPlanSpec, PlanAdSet } from '@/lib/campaigns/plan-spec'
import type { PlanIssue } from '@/lib/campaigns/plan-validation'
import { FieldIssues } from './PlanChecklist'
import { fieldStyle, labelClass } from './PlanBriefForm'

// ADR-062: one ad set of a plan and its ads, editable. Changes go back to the editor, which saves them
// as a new version; the server re-validates everything.

export interface AudienceOption { id: string; name: string | null; approximateCount: number | null }

type Edit = (change: (spec: CampaignPlanSpec) => void) => void

const text = (value: string, onChange: (v: string) => void, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
  <input {...props} value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg px-3 text-[13px]" style={fieldStyle} disabled={props.disabled} />
)

function AudienceSelect({ label, ids, options, onChange, disabled }: { label: string; ids: string[]; options: readonly AudienceOption[]; onChange: (ids: string[]) => void; disabled: boolean }) {
  return (
    <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>
      {label}
      <select multiple value={ids} disabled={disabled || options.length === 0} onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}
        className="rounded-lg px-2 py-1 text-[13px]" style={{ ...fieldStyle, minHeight: 88 }}>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name ?? o.id}{o.approximateCount ? ` (~${o.approximateCount.toLocaleString('en-US')})` : ''}</option>)}
      </select>
    </label>
  )
}

export function PlanAdSetFields({ spec, index, edit, issues, audiences, readOnly, toMinor, fromMinor }: {
  spec: CampaignPlanSpec; index: number; edit: Edit; issues: readonly PlanIssue[]; audiences: readonly AudienceOption[]; readOnly: boolean
  toMinor: (major: number) => number; fromMinor: (minor: number) => number
}) {
  const adSet: PlanAdSet = spec.ad_sets[index]
  const path = `ad_sets.${index}`
  const a = adSet.audience
  return (
    <fieldset className="card-base p-4 space-y-3" data-plan-adset={adSet.key} disabled={readOnly}>
      <legend className="text-[13px] font-semibold px-1" style={{ color: 'var(--text-primary)' }}>Ad set {index + 1} · optimises for {adSet.optimization_goal.replace(/_/g, ' ').toLowerCase()}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>Name{text(adSet.name, (v) => edit((s) => { s.ad_sets[index].name = v }), { maxLength: 200 })}<FieldIssues issues={issues} path={`${path}.name`} /></label>
        {spec.campaign.budget_mode === 'ABO' && (
          <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>Daily budget
            {text(adSet.daily_budget_minor === null ? '' : String(fromMinor(adSet.daily_budget_minor)), (v) => edit((s) => { s.ad_sets[index].daily_budget_minor = v ? toMinor(Number(v)) : null }), { inputMode: 'decimal' })}
            <FieldIssues issues={issues} path={`${path}.daily_budget_minor`} />
          </label>
        )}
        <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>Audience
          <select value={a.mode} onChange={(e) => edit((s) => { s.ad_sets[index].audience.mode = e.target.value as PlanAdSet['audience']['mode']; if (e.target.value !== 'custom') s.ad_sets[index].audience.custom_audience_ids = [] })}
            className="rounded-lg px-3 text-[13px]" style={fieldStyle}>
            <option value="advantage_plus">Advantage+ audience</option>
            <option value="broad">Broad</option>
            <option value="custom">Your custom audiences</option>
          </select>
          <FieldIssues issues={issues} path={`${path}.audience`} exact />
        </label>
        <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>Countries
          {text(a.countries.join(', '), (v) => edit((s) => { s.ad_sets[index].audience.countries = v.toUpperCase().split(/[\s,]+/).filter(Boolean) }))}
        </label>
        <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>Ages
          <span className="flex gap-2">
            {text(String(a.age_min), (v) => edit((s) => { s.ad_sets[index].audience.age_min = Number(v) || 18 }), { inputMode: 'numeric', 'aria-label': 'Minimum age' })}
            {text(String(a.age_max), (v) => edit((s) => { s.ad_sets[index].audience.age_max = Number(v) || 65 }), { inputMode: 'numeric', 'aria-label': 'Maximum age' })}
          </span>
        </label>
        {a.mode === 'custom' && <AudienceSelect label="Include" ids={a.custom_audience_ids} options={audiences} disabled={readOnly} onChange={(ids) => edit((s) => { s.ad_sets[index].audience.custom_audience_ids = ids })} />}
        <AudienceSelect label="Exclude" ids={a.excluded_audience_ids} options={audiences} disabled={readOnly} onChange={(ids) => edit((s) => { s.ad_sets[index].audience.excluded_audience_ids = ids })} />
      </div>
      <ol className="space-y-3">
        {adSet.ads.map((ad, j) => {
          const adPath = `${path}.ads.${j}`
          return (
            <li key={ad.key} data-plan-ad={ad.key} className="rounded-lg p-3 space-y-2" style={{ border: '1px solid var(--border)' }}>
              <div className="flex items-start justify-between gap-2">
                <label className={`${labelClass} flex-1`} style={{ color: 'var(--text-secondary)' }}>Ad name{text(ad.name, (v) => edit((s) => { s.ad_sets[index].ads[j].name = v }), { maxLength: 200 })}</label>
                {!readOnly && (
                  <button type="button" onClick={() => edit((s) => { s.ad_sets[index].ads.splice(j, 1) })} aria-label={`Remove ${ad.name}`}
                    className="rounded-lg px-3 text-[12px]" style={{ minHeight: 44, color: 'var(--text-secondary)', background: 'var(--bg-subtle)', border: '1px solid var(--border-hover)' }}>
                    <Trash2 size={14} aria-hidden />
                  </button>
                )}
              </div>
              <p className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
                {ad.creative.mode === 'existing_creative' ? `Reuses creative ${ad.creative.creative_id} with its own copy and link.` : `New creative from ${ad.creative.mode === 'image' ? 'an image' : 'a video'} already in your account.`}
              </p>
              {ad.copy && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className={`${labelClass} sm:col-span-2`} style={{ color: 'var(--text-secondary)' }}>Primary text
                    <textarea value={ad.copy.primary_text} maxLength={3000} rows={3} onChange={(e) => edit((s) => { s.ad_sets[index].ads[j].copy!.primary_text = e.target.value })}
                      className="rounded-lg px-3 py-2 text-[13px]" style={fieldStyle} />
                  </label>
                  <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>Headline{text(ad.copy.headline, (v) => edit((s) => { s.ad_sets[index].ads[j].copy!.headline = v }), { maxLength: 400 })}</label>
                  <label className={labelClass} style={{ color: 'var(--text-secondary)' }}>Call to action
                    <select value={ad.copy.cta} onChange={(e) => edit((s) => { s.ad_sets[index].ads[j].copy!.cta = e.target.value as typeof META_CTAS[number] })} className="rounded-lg px-3 text-[13px]" style={fieldStyle}>
                      {META_CTAS.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ').toLowerCase()}</option>)}
                    </select>
                  </label>
                  <label className={`${labelClass} sm:col-span-2`} style={{ color: 'var(--text-secondary)' }}>Destination URL{text(ad.destination_url ?? '', (v) => edit((s) => { s.ad_sets[index].ads[j].destination_url = v || null }), { type: 'url' })}</label>
                  <label className={`${labelClass} sm:col-span-2`} style={{ color: 'var(--text-secondary)' }}>URL parameters{text(ad.url_tags, (v) => edit((s) => { s.ad_sets[index].ads[j].url_tags = v }))}</label>
                </div>
              )}
              <FieldIssues issues={issues} path={adPath} />
            </li>
          )
        })}
      </ol>
      <FieldIssues issues={issues} path={`${path}.ads`} exact />
    </fieldset>
  )
}
