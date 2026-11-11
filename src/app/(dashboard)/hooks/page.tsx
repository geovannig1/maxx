'use client'

import { useState, useEffect, useCallback } from 'react'
import { Zap, Copy, Check, Quote } from 'lucide-react'
import { toast } from 'sonner'
import { SlidePanel } from '@/components/ui/slide-panel'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/layout/PageHeader'
import { outcomeWords } from '@/config/outcome-nouns'
import { formatMoney } from '@/lib/utils/format-currency'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

type CopyVariation = {
  id: string
  copy_type: string
  audience_type: string
  copy_text: string
  angle: string | null
  char_count: number | null
  is_approved: boolean
  is_used: boolean
  performance_notes: string | null
  created_at: string
}

// What actually RAN — measured delivery per hook (the real performance behind "Approved").
type RanGroup = {
  hook: string
  headline: string | null
  ads: number
  spend: number
  impressions: number
  link_ctr: number | null
  cpc: number | null
  meta_bookings_estimate: number
  avg_hook_strength: number | null
  verdict: 'ranked' | 'insufficient'
}

const TABS = [
  { label: 'Hooks', value: 'hook' },
  { label: 'Headlines', value: 'headline' },
  { label: 'Body Copy', value: 'primary_text' },
  { label: 'CTAs', value: 'cta' },
] as const

type TabValue = typeof TABS[number]['value']

const COPY_TYPE_LABELS: Record<string, string> = {
  hook: 'Hook',
  headline: 'Headline',
  primary_text: 'Body Copy',
  cta: 'CTA',
}

const AUDIENCE_TYPE_LABELS: Record<string, string> = {
  professional: 'Professional',
  consumer: 'Consumer',
  mixed: 'Mixed',
  unknown: 'Unknown',
}

function CopiedIcon() {
  return <Check style={{ width: '12px', height: '12px' }} />
}

function CopyIcon() {
  return <Copy style={{ width: '12px', height: '12px' }} />
}

function CopyCard({ item, onCopy }: { item: CopyVariation; onCopy: (text: string) => void }) {
  const audienceBg = item.audience_type === 'professional'
    ? 'var(--accent-dim)'
    : item.audience_type === 'consumer'
    ? 'var(--success-bg)'
    : 'var(--border)'

  const audienceColor = item.audience_type === 'professional'
    ? 'var(--accent)'
    : item.audience_type === 'consumer'
    ? 'var(--success)'
    : 'var(--text-secondary)'

  const audienceBorder = item.audience_type === 'professional'
    ? 'var(--border-focus)'
    : item.audience_type === 'consumer'
    ? 'var(--success-border)'
    : 'var(--border)'

  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        position: 'relative',
      }}
    >
      {/* Copy text */}
      <p style={{ fontSize: '14px', color: 'var(--text-primary)', lineHeight: 1.5, margin: 0 }}>
        {item.copy_text}
      </p>

      {/* Performance notes */}
      {item.performance_notes && (
        <p style={{ fontSize: '12px', fontStyle: 'italic', color: 'var(--text-secondary)', margin: 0 }}>
          {item.performance_notes}
        </p>
      )}

      {/* Metadata row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        {/* Audience badge */}
        <span
          style={{
            fontSize: '11px',
            fontWeight: 500,
            padding: '2px 8px',
            borderRadius: '4px',
            background: audienceBg,
            color: audienceColor,
            border: `1px solid ${audienceBorder}`,
          }}
        >
          {AUDIENCE_TYPE_LABELS[item.audience_type] ?? item.audience_type}
        </span>

        {/* Angle tag */}
        {item.angle && (
          <span
            style={{
              fontSize: '11px',
              color: 'var(--text-secondary)',
              padding: '2px 8px',
              borderRadius: '4px',
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border)',
            }}
          >
            {item.angle}
          </span>
        )}

        {/* Provenance — `is_approved` is a MANUAL toggle (someone marked it good), tied to nothing
            measured. Label it honestly as "Approved", not "Performance-backed": ran performance lives
            in ran_copy_performance / hook_strength_score, which this card does not (yet) show. */}
        <span
          style={{
            fontSize: '11px',
            fontWeight: 500,
            color: item.is_approved ? 'var(--success)' : 'var(--text-secondary)',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
          title={item.is_approved ? 'Manually approved — not performance-measured' : 'Not reviewed'}
        >
          <span style={{ fontSize: '12px' }}>{item.is_approved ? '✓' : '○'}</span>
          {item.is_approved ? 'Manual library item' : 'Not reviewed'}
        </span>
      </div>

      {/* Footer row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '4px' }}>
        <span style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>
          {item.char_count ?? item.copy_text.length} chars
        </span>
        <button
          onClick={() => onCopy(item.copy_text)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '12px',
            fontWeight: 500,
            color: 'var(--accent)',
            background: 'var(--accent-dim)',
            border: '1px solid var(--accent-dim)',
            borderRadius: '4px',
            minHeight: 44,
            padding: '0 12px',
            cursor: 'pointer',
          }}
        >
          <CopyIcon /> Copy
        </button>
      </div>
    </div>
  )
}

type AddFormData = {
  copy_text: string
  copy_type: TabValue
  audience_type: string
  angle: string
}

function AddNewForm({
  defaultType,
  onSuccess,
}: {
  defaultType: TabValue
  onSuccess: () => void
}) {
  const [form, setForm] = useState<AddFormData>({
    copy_text: '',
    copy_type: defaultType,
    audience_type: 'professional',
    angle: '',
  })
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.copy_text.trim()) return
    setSubmitting(true)
    try {
      const res = await fetch('/api/hooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          copy_text: form.copy_text,
          copy_type: form.copy_type,
          audience_type: form.audience_type,
          angle: form.angle || undefined,
        }),
      })
      if (!res.ok) throw new Error('Failed to save')
      toast.success('Copy added to library')
      onSuccess()
    } catch {
      toast.error('Failed to add copy')
    } finally {
      setSubmitting(false)
    }
  }

  const labelStyle = { fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }
  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    padding: '8px 12px',
    fontSize: '13px',
    color: 'var(--text-primary)',
    outline: 'none',
    boxSizing: 'border-box',
  }
  const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div>
        <label style={labelStyle}>Copy text</label>
        <textarea
          value={form.copy_text}
          onChange={e => setForm(f => ({ ...f, copy_text: e.target.value }))}
          rows={5}
          placeholder="Enter your copy..."
          style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
          required
        />
      </div>

      <div>
        <label style={labelStyle}>Type</label>
        <select
          value={form.copy_type}
          onChange={e => setForm(f => ({ ...f, copy_type: e.target.value as TabValue }))}
          style={selectStyle}
        >
          <option value="hook">Hook</option>
          <option value="headline">Headline</option>
          <option value="primary_text">Body Copy</option>
          <option value="cta">CTA</option>
        </select>
      </div>

      <div>
        <label style={labelStyle}>Audience</label>
        <select
          value={form.audience_type}
          onChange={e => setForm(f => ({ ...f, audience_type: e.target.value }))}
          style={selectStyle}
        >
          <option value="professional">Professional</option>
          <option value="consumer">Consumer</option>
          <option value="mixed">Mixed</option>
        </select>
      </div>

      <div>
        <label style={labelStyle}>Angle (optional)</label>
        <input
          type="text"
          value={form.angle}
          onChange={e => setForm(f => ({ ...f, angle: e.target.value }))}
          placeholder="e.g. social proof, urgency, benefit..."
          style={inputStyle}
        />
      </div>

      <button
        type="submit"
        disabled={submitting || !form.copy_text.trim()}
        style={{
          background: 'var(--accent)',
          color: 'var(--on-accent)',
          border: 'none',
          borderRadius: '6px',
          minHeight: 44,
          padding: '0 16px',
          fontSize: '13px',
          fontWeight: 600,
          cursor: submitting ? 'not-allowed' : 'pointer',
          opacity: submitting ? 0.7 : 1,
        }}
      >
        {submitting ? 'Adding...' : 'Add to Library'}
      </button>
    </form>
  )
}

export default function HooksPage() {
  const [activeTab, setActiveTab] = useState<TabValue>('hook')
  const [copies, setCopies] = useState<CopyVariation[]>([])
  const [ranGroups, setRanGroups] = useState<RanGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const fetchCopy = useCallback(async (type: TabValue) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/hooks?copy_type=${type}`)
      if (res.ok) {
        const json = await res.json() as { copy: CopyVariation[]; ran_copy_performance?: { groups: RanGroup[] } }
        setCopies(json.copy ?? [])
        setRanGroups(json.ran_copy_performance?.groups ?? [])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Defer past the synchronous effect tick so fetchCopy's setState isn't synchronous-in-effect.
    let active = true
    void (async () => { await Promise.resolve(); if (active) await fetchCopy(activeTab) })()
    return () => { active = false }
  }, [activeTab, fetchCopy])

  function handleCopy(text: string, id: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id)
      toast.success('Copied!')
      setTimeout(() => setCopiedId(null), 2000)
    })
  }

  function handleTabChange(tab: TabValue) {
    setActiveTab(tab)
  }

  return (
    <div className="owner-page owner-page-narrow">
      {/* Shared header — freshness + write-mode + Trust parity (audit #1/#2). */}
      <div className="owner-surface owner-surface-section">
        <PageHeader
          title="Read-only copy library"
          icon={Quote}
          subtitle="Saved hooks, headlines, body copy, and CTAs. Copying is allowed; launching or claiming performance is governed elsewhere."
          controls={
            <button
              onClick={() => setPanelOpen(true)}
              className="owner-button"
              style={{
                background: 'var(--accent)',
                color: 'var(--on-accent)',
                border: 'none',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              + Add New
            </button>
          }
        />
      </div>

      <div className="owner-notice">
        <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Governed read-only status.</span>
        Items marked as a manual library item were saved by an operator. They are not performance-backed and do not create Meta changes.
      </div>

      {/* Tabs */}
      <div
        className="owner-tabs"
        style={{
          display: 'flex',
          gap: '2px',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '4px',
          marginBottom: '20px',
        }}
      >
        {TABS.map(tab => (
          <button
            key={tab.value}
            onClick={() => handleTabChange(tab.value)}
            className={activeTab === tab.value ? 'owner-tab owner-tab-active' : 'owner-tab'}
            style={{
              flex: 1,
              padding: '0 12px',
              borderRadius: '6px',
              border: 'none',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              background: activeTab === tab.value ? 'var(--bg-elevated)' : 'transparent',
              color: activeTab === tab.value ? 'var(--text-primary)' : 'var(--text-secondary)',
              transition: 'all 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* What actually RAN — measured performance behind the honest "Approved" label (Hooks tab only). */}
      {activeTab === 'hook' && !loading && ranGroups.some(g => g.verdict === 'ranked') && (
        <div className="owner-surface" style={{ marginBottom: '20px', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: '8px', padding: '16px' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
            What actually ran (last 30 days)
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '12px' }}>
            Grouped by hook, from live delivery. CTR / CPC / spend are Meta facts; Meta {OW.one} events are a pixel ESTIMATE (not revenue); vision is a Claude 1–5 hook-strength read.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {ranGroups.filter(g => g.verdict === 'ranked').slice(0, 8).map((g, i) => (
              <div key={i} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)', paddingTop: i === 0 ? 0 : '8px' }}>
                <p style={{ fontSize: '13px', color: 'var(--text-primary)', margin: 0, lineHeight: 1.4 }}>{g.hook}</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  <span>Link CTR {g.link_ctr != null ? (g.link_ctr * 100).toFixed(2) + '%' : '—'}</span>
                  <span>CPC {g.cpc != null ? formatMoney(g.cpc) : '—'}</span>
                  <span>{formatMoney(g.spend, { maximumFractionDigits: 0 })} · {g.impressions.toLocaleString()} impr · {g.ads} ad{g.ads === 1 ? '' : 's'}</span>
                  {g.avg_hook_strength != null && <span>vision {g.avg_hook_strength}/5</span>}
                  <span style={{ color: 'var(--text-tertiary)' }}>~{g.meta_bookings_estimate} Meta {OW.one} events (pixel est.)</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {[1, 2, 3].map(i => (
            <div
              key={i}
              style={{
                height: '100px',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                opacity: 0.5,
              }}
            />
          ))}
        </div>
      ) : copies.length === 0 ? (
        <div
          className="owner-surface"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
          }}
        >
          <EmptyState
            icon={Zap}
            title={`No ${COPY_TYPE_LABELS[activeTab] ?? activeTab}s yet`}
            description="Add copy to your library or ask Maxx to generate some from your winning ads"
            action={{ label: '+ Add New', onClick: () => setPanelOpen(true) }}
          />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {copies.map(item => (
            <div key={item.id} style={{ position: 'relative' }}>
              <CopyCard
                item={item}
                onCopy={text => handleCopy(text, item.id)}
              />
              {copiedId === item.id && (
                <div
                  style={{
                    position: 'absolute',
                    top: '12px',
                    right: '12px',
                    background: 'var(--success)',
                    color: 'var(--bg-base)',
                    borderRadius: '4px',
                    padding: '3px 8px',
                    fontSize: '11px',
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  <CopiedIcon /> Copied
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add New slide panel */}
      <SlidePanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        title="Add to Hook Library"
        subtitle="Save copy to reuse in future campaigns"
      >
        <AddNewForm
          defaultType={activeTab}
          onSuccess={() => {
            setPanelOpen(false)
            void fetchCopy(activeTab)
          }}
        />
      </SlidePanel>
    </div>
  )
}
