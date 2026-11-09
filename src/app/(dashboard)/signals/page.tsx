'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { InspirationNote } from '@/components/ui/inspiration-note'
import { PageHeader } from '@/components/layout/PageHeader'
import { toast } from 'sonner'
import { safeHref } from '@/lib/ui/safe-href'
import { Rss, ExternalLink } from 'lucide-react'

interface ExpertSource {
  id: string
  name: string
  platform: string | null
  url: string | null
  description: string | null
  relevance_notes: string | null
}

interface ExpertInsight {
  id: string
  source_id: string | null
  published_at: string | null
  title: string
  summary: string
  applies_to_account: boolean
  why_it_applies: string | null
  review_status?: 'pending' | 'approved' | 'rejected' | null
  // N5 governance metadata — shown so the owner reviews with the context that decides how it's matched.
  applicable_area?: string | null
  confidence?: string | null
  expires_at?: string | null
  expert_sources?: { name: string; platform: string | null } | null
}

const AREA_LABELS: Record<string, string> = { creative: 'Creative', budget: 'Budget' }

// 035 review gate: only APPROVED insights are citable in recommendations / surfaced on the dashboard.
const REVIEW_CHIP: Record<string, { label: string; color: string }> = {
  approved: { label: 'Approved — Maxx can cite this', color: 'var(--success)' },
  rejected: { label: 'Rejected', color: 'var(--trust-low)' },
  pending: { label: 'Pending your review', color: 'var(--warning)' },
}

const PLATFORM_LABELS: Record<string, string> = {
  meta_official: 'Meta Official',
  blog: 'Blog',
  newsletter: 'Newsletter',
  twitter: 'X/Twitter',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
}

export default function SignalsPage() {
  const [sources, setSources] = useState<ExpertSource[]>([])
  const [insights, setInsights] = useState<ExpertInsight[]>([])
  const [loading, setLoading] = useState(true)
  const [seeding, setSeeding] = useState(false)
  const [tab, setTab] = useState<'insights' | 'sources'>('insights')

  async function load() {
    setLoading(true)
    const res = await fetch('/api/signals', { cache: 'no-store' })
    if (res.ok) {
      const data = await res.json()
      setSources(data.sources ?? [])
      setInsights(data.insights ?? [])
    }
    setLoading(false)
  }

  useEffect(() => {
    // Defer past the synchronous effect tick so the fetch's setState isn't synchronous-in-effect.
    let active = true
    void (async () => {
      const res = await fetch('/api/signals', { cache: 'no-store' })
      if (!active) return
      if (res.ok) {
        const data = await res.json()
        setSources(data.sources ?? [])
        setInsights(data.insights ?? [])
      }
      setLoading(false)
    })()
    return () => { active = false }
  }, [])

  async function handleSeed() {
    setSeeding(true)
    const res = await fetch('/api/signals/seed', { method: 'POST' })
    const data = await res.json()
    if (res.ok) { toast.success(data.message); if (data.seeded) load() }
    else toast.error(data.error ?? 'Seed failed')
    setSeeding(false)
  }

  // manual owner entry — paste an insight from anywhere (YouTube, newsletter, podcast). Owner
  // authorship IS the review, so it lands approved with provenance recorded.
  const [showAdd, setShowAdd] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addForm, setAddForm] = useState({ title: '', summary: '', source_name: '', source_url: '', applicable_area: '', confidence: 'medium' })

  async function handleAddInsight() {
    setAdding(true)
    const payload: Record<string, unknown> = {
      title: addForm.title.trim(),
      summary: addForm.summary.trim(),
      source_name: addForm.source_name.trim(),
      confidence: addForm.confidence,
      applicable_area: addForm.applicable_area || null,
    }
    if (addForm.source_url.trim()) payload.source_url = addForm.source_url.trim()
    const res = await fetch('/api/signals/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (res.ok) {
      toast.success('Insight added — approved and citable.')
      setAddForm({ title: '', summary: '', source_name: '', source_url: '', applicable_area: '', confidence: 'medium' })
      setShowAdd(false)
      load()
    } else {
      toast.error(data.error ?? 'Could not add the insight')
    }
    setAdding(false)
  }

  // 035 review gate: approve/reject an insight. Only approved insights become citable.
  async function handleReview(id: string, review_status: 'approved' | 'rejected') {
    const res = await fetch(`/api/signals/${id}/review`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review_status }),
    })
    if (res.ok) {
      setInsights((prev) => prev.map((i) => (i.id === id ? { ...i, review_status } : i)))
      toast.success(review_status === 'approved' ? 'Approved — now citable as test-inspiration.' : 'Rejected — will not be cited.')
    } else {
      const d = await res.json().catch(() => ({}))
      toast.error(d.error ?? "Couldn't save your review — try again.")
    }
  }

  return (
    <div className="owner-page owner-page-narrow">
      {/* Shared header — freshness + write-mode + Trust parity (audit #1/#2). */}
      <div className="owner-surface owner-surface-section">
        <PageHeader
          title="Outside-account inspiration only"
          icon={Rss}
          subtitle="Expert signals are outside opinions for future tests, not account facts and not evidence that Example Studio should act now."
          controls={sources.length === 0 && !loading ? (
            <Button
              size="sm"
              onClick={handleSeed}
              disabled={seeding}
              className="owner-button bg-indigo-600 hover:bg-indigo-500 text-white text-xs"
            >
              {seeding ? 'Adding…' : 'Add Expert Sources'}
            </Button>
          ) : undefined}
        />
      </div>

      <InspirationNote>
        <strong style={{ color: 'var(--text-primary)' }}>Inspiration, not proven strategy.</strong>{' '}
        Expert signals are outside opinions to turn into <strong>tests</strong> — not facts about your account. Validate against your own data before acting.
      </InspirationNote>

      {/* manual owner entry — a path in for feedless sources (YouTube, newsletters, podcasts). */}
      <div className="owner-surface owner-surface-section">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Found a tip elsewhere? Add it yourself — your entry is approved immediately (you are the reviewer).
          </div>
          <Button size="sm" variant="outline" className="owner-button text-xs" onClick={() => setShowAdd((v) => !v)}>
            {showAdd ? 'Close' : 'Add insight'}
          </Button>
        </div>
        {showAdd && (
          <div className="mt-3 grid gap-2">
            <input className="w-full rounded-md px-3 py-2 text-sm" style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              placeholder="Title (what's the tip?)" value={addForm.title} onChange={(e) => setAddForm((f) => ({ ...f, title: e.target.value }))} />
            <textarea className="w-full rounded-md px-3 py-2 text-sm min-h-20" style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              placeholder="The insight itself — what to know or try (be specific)" value={addForm.summary} onChange={(e) => setAddForm((f) => ({ ...f, summary: e.target.value }))} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input className="rounded-md px-3 py-2 text-sm" style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                placeholder="Source name (who said it — required)" value={addForm.source_name} onChange={(e) => setAddForm((f) => ({ ...f, source_name: e.target.value }))} />
              <input className="rounded-md px-3 py-2 text-sm" style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                placeholder="Source URL (optional)" value={addForm.source_url} onChange={(e) => setAddForm((f) => ({ ...f, source_url: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <select className="rounded-md px-2 py-2 text-sm" style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                value={addForm.applicable_area} onChange={(e) => setAddForm((f) => ({ ...f, applicable_area: e.target.value }))}>
                <option value="">Area: general</option>
                {['creative', 'budget', 'bidding', 'measurement', 'structure', 'audience', 'landing'].map((a) => (
                  <option key={a} value={a}>Area: {a}</option>
                ))}
              </select>
              <select className="rounded-md px-2 py-2 text-sm" style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                value={addForm.confidence} onChange={(e) => setAddForm((f) => ({ ...f, confidence: e.target.value }))}>
                {['high', 'medium', 'low'].map((c) => (
                  <option key={c} value={c}>Confidence: {c}</option>
                ))}
              </select>
              <Button size="sm" className="owner-button bg-indigo-600 hover:bg-indigo-500 text-white text-xs sm:ml-auto"
                disabled={adding || addForm.title.trim().length < 8 || addForm.summary.trim().length < 20 || addForm.source_name.trim().length < 3}
                onClick={handleAddInsight}>
                {adding ? 'Adding…' : 'Save insight'}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="owner-tabs">
        {(['insights', 'sources'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={tab === t ? 'owner-tab owner-tab-active' : 'owner-tab'}
            style={tab === t
              ? { background: 'var(--accent-dim)', border: '1px solid var(--accent)', color: 'var(--accent-hover)' }
              : { background: 'transparent', border: '1px solid transparent', color: 'var(--text-tertiary)' }
            }
          >
            {t === 'insights' ? `Insights (${insights.length})` : `Sources (${sources.length})`}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
        </div>
      ) : tab === 'sources' ? (
        <div className="space-y-2">
          {sources.length === 0 ? (
          <div className="owner-surface">
              <EmptyState
                icon={Rss}
                title="No sources yet"
                description="Add expert sources and Maxx will surface relevant insights every Monday"
              />
            </div>
          ) : sources.map((s) => (
            <div key={s.id} className="owner-surface p-4 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{s.name}</p>
                <div className="flex items-center gap-2 shrink-0">
                  {s.platform && (
                    <Badge
                      variant="outline"
                      className="text-xs"
                      style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                    >
                      {PLATFORM_LABELS[s.platform] ?? s.platform}
                    </Badge>
                  )}
                  {/* s.url is stored data; a non-http(s) value gets no link. */}
                  {safeHref(s.url) && (
                    <a href={safeHref(s.url) ?? undefined} target="_blank" rel="noopener noreferrer" className="owner-button" aria-label={`Open ${s.name} source`}>
                      <ExternalLink className="w-3.5 h-3.5 transition-colors" style={{ color: 'var(--text-tertiary)' }} />
                    </a>
                  )}
                </div>
              </div>
              {s.description && <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{s.description}</p>}
              {s.relevance_notes && <p className="text-xs" style={{ color: 'var(--accent-hover)', opacity: 0.8 }}>{s.relevance_notes}</p>}
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {insights.length === 0 ? (
            <div className="owner-surface">
              <EmptyState
                icon={Rss}
                title="No insights yet"
                description="Once sources are added, Maxx surfaces relevant ones for your review."
              />
            </div>
          ) : insights.map((insight) => (
            <div key={insight.id} className="owner-surface p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{insight.title}</p>
                  {insight.expert_sources && (
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{insight.expert_sources.name}</p>
                  )}
                </div>
                {insight.published_at && (
                  <span className="text-xs shrink-0" style={{ color: 'var(--text-tertiary)' }}>{insight.published_at}</span>
                )}
              </div>
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{insight.summary}</p>
              {insight.why_it_applies && (
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  <span className="font-medium">Applies because:</span> {insight.why_it_applies}
                </p>
              )}
              {/* N5 governance metadata — what decides how this insight is matched + when it lapses. */}
              {(insight.applicable_area || insight.confidence || insight.expires_at) && (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                  <span style={{ fontWeight: 500 }}>Used for:</span>
                  <span>{insight.applicable_area ? (AREA_LABELS[insight.applicable_area] ?? insight.applicable_area) + ' recommendations' : 'any recommendation'}</span>
                  {insight.confidence && <span>· confidence {insight.confidence}</span>}
                  {insight.expires_at && <span>· expires {insight.expires_at}</span>}
                </div>
              )}
              {/* 035 review gate — approve to make citable, reject to bury. */}
              <div className="flex items-center justify-between gap-2 pt-1">
                {(() => {
                  const chip = REVIEW_CHIP[insight.review_status ?? 'pending']
                  return (
                    <span className="inline-flex items-center rounded-full text-[11px] font-semibold" style={{ height: 20, padding: '0 8px', background: `color-mix(in srgb, ${chip.color} 12%, transparent)`, border: `1px solid ${chip.color}`, color: chip.color }}>
                      {chip.label}
                    </span>
                  )
                })()}
                <div className="flex items-center gap-1.5">
                  {insight.review_status !== 'approved' && (
                    <Button size="sm" variant="outline" className="owner-button text-[11px]" onClick={() => handleReview(insight.id, 'approved')}>
                      Approve
                    </Button>
                  )}
                  {insight.review_status !== 'rejected' && (
                    <Button size="sm" variant="outline" className="owner-button text-[11px]" onClick={() => handleReview(insight.id, 'rejected')}>
                      Reject
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
