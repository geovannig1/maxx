'use client'

import { businessDisplayName, businessHourlyRate } from '@/config/business-display'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { safeHref } from '@/lib/ui/safe-href'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { InspirationNote } from '@/components/ui/inspiration-note'
import { PageHeader } from '@/components/layout/PageHeader'
import { toast } from 'sonner'
import { Building2, ExternalLink, Plus, Clock, TrendingUp } from 'lucide-react'
import { SlidePanel, PanelSection } from '@/components/ui/slide-panel'
import { formatMoney, formatMoneyAmount } from '@/lib/utils/format-currency'

// ─── Types ────────────────────────────────────────────────────

interface Competitor {
  id: string
  name: string
  location: string | null
  website_url: string | null
  instagram_url: string | null
  hourly_rate_low: number | null
  hourly_rate_high: number | null
  size_sqft: number | null
  notes: string | null
  facebook_page_id: string | null
}

interface Observation {
  id: string
  competitor_id: string
  observed_at: string
  source: string | null
  observation_type: string | null
  summary: string
}

interface ObservedAttributes {
  angle?: string
  hook_type?: string
  format_guess?: string
  has_price?: boolean
  has_social_proof?: boolean
  observed_cta_type?: string
  tone?: string
}

interface CompetitorAd {
  id: string
  competitor_id: string
  ad_archive_id: string
  page_name: string | null
  ad_creative_bodies: string[] | null
  impression_range: string | null
  spend_range: string | null
  estimated_days_running: number | null
  is_active: boolean
  observed_attributes: ObservedAttributes | null
}

// ─── Helpers ──────────────────────────────────────────────────

function rateLabel(low: number | null, high: number | null): string {
  if (!low) return '—'
  if (!high || high === low) return `${formatMoneyAmount(low)}/hr`
  return `${formatMoneyAmount(low)}–${formatMoneyAmount(high)}/hr`
}

function getPriceTier(low: number | null): 'cheap' | 'mid' | 'expensive' {
  if (!low) return 'expensive'
  if (low < 75) return 'cheap'
  if (low < 125) return 'mid'
  return 'expensive'
}

function priceBadgeStyle(tier: 'cheap' | 'mid' | 'expensive'): React.CSSProperties {
  if (tier === 'cheap') return { background: 'var(--success-bg)', color: 'var(--success)', border: '1px solid var(--success-border)' }
  if (tier === 'mid') return { background: 'var(--warning-bg)', color: 'var(--warning)', border: '1px solid var(--warning-border)' }
  return { background: 'var(--accent-dim)', color: 'var(--accent-hover)', border: '1px solid var(--border-focus)' }
}

function cardBorderStyle(tier: 'cheap' | 'mid' | 'expensive'): React.CSSProperties {
  if (tier === 'cheap') return { borderColor: 'var(--success-bg)' }
  if (tier === 'mid') return { borderColor: 'var(--warning-bg)' }
  return {}
}

// ─── Competitor Form ──────────────────────────────────────────

interface CompetitorFormState {
  name: string
  location: string
  website_url: string
  instagram_url: string
  hourly_rate_low: string
  hourly_rate_high: string
  size_sqft: string
  notes: string
  facebook_page_id: string
}

function emptyForm(): CompetitorFormState {
  return {
    name: '',
    location: '',
    website_url: '',
    instagram_url: '',
    hourly_rate_low: '',
    hourly_rate_high: '',
    size_sqft: '',
    notes: '',
    facebook_page_id: '',
  }
}

function competitorToForm(c: Competitor): CompetitorFormState {
  return {
    name: c.name,
    location: c.location ?? '',
    website_url: c.website_url ?? '',
    instagram_url: c.instagram_url ?? '',
    hourly_rate_low: c.hourly_rate_low != null ? String(c.hourly_rate_low) : '',
    hourly_rate_high: c.hourly_rate_high != null ? String(c.hourly_rate_high) : '',
    size_sqft: c.size_sqft != null ? String(c.size_sqft) : '',
    notes: c.notes ?? '',
    facebook_page_id: c.facebook_page_id ?? '',
  }
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md px-3 py-2 text-sm focus:outline-none"
        style={{
          background: 'var(--bg-input)',
          border: '1px solid var(--border)',
          color: 'var(--text-primary)',
        }}
      />
    </div>
  )
}

// ─── Running Ads Column ───────────────────────────────────────

function RunningAdsPanel({ competitor }: { competitor: Competitor }) {
  const [ads, setAds] = useState<CompetitorAd[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Defer past the synchronous effect tick so the fetch's setState isn't synchronous-in-effect.
    let active = true
    void (async () => {
      await Promise.resolve()
      if (!active) return
      setLoading(true)
      try {
        const r = await fetch(`/api/competitor-ads?competitor_id=${competitor.id}&active_only=true`)
        const data = (await r.json()) as { ads?: CompetitorAd[] }
        if (active) setAds(data.ads ?? [])
      } catch {
        if (active) setAds([])
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [competitor.id])

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
    )
  }

  if (ads.length === 0) {
    return (
      <div className="py-8 text-center">
        <TrendingUp className="w-6 h-6 mx-auto mb-2" style={{ color: 'var(--text-tertiary)' }} />
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>No active ads found</p>
        {!competitor.facebook_page_id && (
          <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>Add a Facebook Page ID to fetch ads</p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {ads.length > 0 && <InspirationNote />}
      {ads.map((ad) => {
        const body = ad.ad_creative_bodies?.[0]
        const hasContinuedDelivery = (ad.estimated_days_running ?? 0) >= 14

        return (
          <div key={ad.id} className="owner-surface p-4 space-y-3">
            {/* Header row */}
            <div className="flex items-center gap-2 flex-wrap">
              {hasContinuedDelivery && (
                <Badge
                  className="text-[10px]"
                  style={{ background: 'var(--warning-bg)', color: 'var(--warning)', border: '1px solid var(--warning-border)' }}
                >
                  Observed 14d+
                </Badge>
              )}
              {ad.estimated_days_running != null && (
                <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  <Clock className="w-3 h-3" />
                  {ad.estimated_days_running}d running
                </span>
              )}
              {ad.impression_range && (
                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{ad.impression_range} impressions</span>
              )}
              {ad.spend_range && (
                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>${ad.spend_range} spent</span>
              )}
            </div>

            {/* Body text */}
            {body && (
              <p className="text-xs line-clamp-3 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{body}</p>
            )}

            {/* Descriptive AI classifications; causal/account-fit guidance is withheld. */}
            {ad.observed_attributes && (
              <div
                className="rounded-md p-3 space-y-2"
                style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)' }}
              >
                {ad.observed_attributes.angle && (
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>Observed angle:</span> {ad.observed_attributes.angle}
                  </p>
                )}
                {ad.observed_attributes.hook_type && (
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>Observed hook:</span> {ad.observed_attributes.hook_type}
                  </p>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────

export default function CompetitorsPage() {
  const [competitors, setCompetitors] = useState<Competitor[]>([])
  const [observations, setObservations] = useState<Observation[]>([])
  const [loading, setLoading] = useState(true)
  const [seeding, setSeeding] = useState(false)

  // Panel state
  const [panelOpen, setPanelOpen] = useState(false)
  const [editingCompetitor, setEditingCompetitor] = useState<Competitor | null>(null)
  const [form, setForm] = useState<CompetitorFormState>(emptyForm())
  const [saving, setSaving] = useState(false)

  // Lookup state (Add flow only)

  // Selected competitor for ads view
  const [selectedCompetitor, setSelectedCompetitor] = useState<Competitor | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/competitors', { cache: 'no-store' })
    if (res.ok) {
      const data = await res.json() as { sources?: Competitor[]; observations?: Observation[] }
      setCompetitors(data.sources ?? [])
      setObservations(data.observations ?? [])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    // Defer past the synchronous effect tick so load's setState isn't synchronous-in-effect.
    let active = true
    void (async () => { await Promise.resolve(); if (active) await load() })()
    return () => { active = false }
  }, [load])

  async function handleSeed() {
    setSeeding(true)
    const res = await fetch('/api/competitors/seed', { method: 'POST' })
    const data = await res.json() as { message?: string; seeded?: boolean; error?: string }
    if (res.ok) {
      toast.success(data.message)
      if (data.seeded) load()
    } else {
      toast.error(data.error ?? 'Seed failed')
    }
    setSeeding(false)
  }

  function openAddPanel() {
    setEditingCompetitor(null)
    setForm(emptyForm())
    setPanelOpen(true)
  }

  function openEditPanel(c: Competitor, e: React.MouseEvent) {
    e.stopPropagation()
    setEditingCompetitor(c)
    setForm(competitorToForm(c))
    setPanelOpen(true)
  }

  function selectCompetitor(c: Competitor) {
    setSelectedCompetitor((prev) => prev?.id === c.id ? null : c)
  }

  function updateField(field: keyof CompetitorFormState) {
    return (v: string) => setForm((f) => ({ ...f, [field]: v }))
  }

  async function handleSave() {
    if (!form.name.trim()) {
      toast.error('Name is required')
      return
    }
    setSaving(true)

    const payload = {
      name: form.name.trim(),
      location: form.location || null,
      website_url: form.website_url || null,
      instagram_url: form.instagram_url || null,
      hourly_rate_low: form.hourly_rate_low ? Number(form.hourly_rate_low) : null,
      hourly_rate_high: form.hourly_rate_high ? Number(form.hourly_rate_high) : null,
      size_sqft: form.size_sqft ? Number(form.size_sqft) : null,
      notes: form.notes || null,
      facebook_page_id: form.facebook_page_id || null,
    }

    const url = editingCompetitor
      ? `/api/competitors/${editingCompetitor.id}`
      : '/api/competitors'
    const method = editingCompetitor ? 'PATCH' : 'POST'

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const data = await res.json() as { source?: Competitor; error?: string }

    if (!res.ok) {
      toast.error(data.error ?? 'Save failed')
      setSaving(false)
      return
    }

    toast.success(editingCompetitor ? 'Competitor updated' : 'Competitor added')
    setPanelOpen(false)
    load()
    setSaving(false)
  }

  return (
    <div className="owner-page">
      {/* Shared header — freshness + write-mode + Trust parity (audit #1/#2). */}
      <div className="owner-surface owner-surface-section">
        <PageHeader
          title="Intelligence workspace"
          icon={Building2}
          subtitle="Competitor profiles and observed ads in one place. These are outside signals for test ideas, not proof of what will work for your business."
          controls={
            <div className="flex flex-wrap items-center gap-2">
              {competitors.length === 0 && !loading && (
                <Button
                  size="sm"
                  onClick={handleSeed}
                  disabled={seeding}
                  variant="outline"
                  className="owner-button text-xs"
                >
                  {seeding ? 'Seeding…' : 'Seed competitors from config'}
                </Button>
              )}
              <Button
                size="sm"
                onClick={openAddPanel}
                className="owner-button bg-indigo-600 hover:bg-indigo-500 text-white text-xs gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Competitor
              </Button>
            </div>
          }
        />
      </div>

      <div className="owner-tabs" aria-label="Intelligence workspace">
        <span className="owner-tab owner-tab-active">Competitors</span>
        <Link className="owner-tab" href="/discovery">Ad discovery</Link>
        <Link className="owner-tab" href="/signals">Expert signals</Link>
      </div>

      <InspirationNote />

      {/* Market insights */}
      {observations.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Market Insights</h2>
          {observations.map((obs) => (
            <div key={obs.id} className="owner-surface p-4 space-y-2">
              <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{obs.summary}</p>
            </div>
          ))}
        </div>
      )}

      {/* Main content — two-column when a competitor is selected */}
      <div className={selectedCompetitor ? 'grid gap-6 items-start lg:grid-cols-[420px_1fr]' : ''}>
        {/* Competitor grid */}
        <div className={selectedCompetitor ? 'min-w-0' : ''}>
          <h2 className="text-xs font-medium uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>
            Studio Market — Sorted by Price
          </h2>

          {loading ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-28 rounded-lg" />
              ))}
            </div>
          ) : competitors.length === 0 ? (
            <div className="owner-surface">
              <EmptyState
                icon={Building2}
                title="No competitors tracked"
                description="Add competitors and connect their Facebook pages to start tracking their ads"
              />
            </div>
          ) : (
            <div className={`grid gap-2 ${selectedCompetitor ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2'}`}>
              {competitors.map((c) => {
                const isSelected = selectedCompetitor?.id === c.id
                const tier = getPriceTier(c.hourly_rate_low)
                return (
                  <div
                    key={c.id}
                    onClick={() => selectCompetitor(c)}
                    className="owner-surface p-4 space-y-2 cursor-pointer transition-all"
                    style={{
                      ...(isSelected
                        ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 1px var(--accent)' }
                        : cardBorderStyle(tier)
                      ),
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{c.name}</p>
                        {c.location && (
                          <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{c.location}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Badge
                          variant="outline"
                          className="text-xs"
                          style={priceBadgeStyle(tier)}
                        >
                          {rateLabel(c.hourly_rate_low, c.hourly_rate_high)}
                        </Badge>
                        {/* website_url is stored data; a non-http(s) value gets no link. */}
                        {safeHref(c.website_url) && (
                          <a
                            href={safeHref(c.website_url) ?? undefined}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="owner-button"
                            aria-label={`Open ${c.name} website`}
                          >
                            <ExternalLink className="w-3.5 h-3.5 transition-colors" style={{ color: 'var(--text-tertiary)' }} />
                          </a>
                        )}
                        <button
                          onClick={(e) => openEditPanel(c, e)}
                          className="owner-button text-[10px] transition-colors"
                          style={{ color: 'var(--text-tertiary)' }}
                        >
                          Edit
                        </button>
                      </div>
                    </div>
                    {c.size_sqft && (
                      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{c.size_sqft.toLocaleString()} sq ft</p>
                    )}
                    {c.notes && (
                      <p className="text-xs line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{c.notes}</p>
                    )}
                    {c.facebook_page_id && (
                      <p className="text-[10px]" style={{ color: 'var(--accent-hover)' }}>FB Page: {c.facebook_page_id}</p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Running Ads column */}
        {selectedCompetitor && (
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                Running Ads — {selectedCompetitor.name}
              </h2>
              <button
                onClick={() => setSelectedCompetitor(null)}
                className="owner-button text-xs transition-colors"
                style={{ color: 'var(--text-tertiary)' }}
              >
                Close
              </button>
            </div>
            <RunningAdsPanel competitor={selectedCompetitor} />
          </div>
        )}
      </div>

      {/* Your-position note — pricing and size come from the business profile */}
      {competitors.length > 0 && (
        <div
          className="owner-surface"
          style={{
            background: 'var(--accent-dim)',
            border: '1px solid var(--accent-dim)',
            borderRadius: 'var(--r-lg)',
            padding: '16px',
          }}
        >
          <p className="text-xs font-medium mb-1" style={{ color: 'var(--accent-hover)' }}>{businessDisplayName()} — Your Position</p>
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>Your rate: {formatMoney(businessHourlyRate())}/hr (NEXT_PUBLIC_BUSINESS_HOURLY_RATE)</p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
            More expensive than {competitors.filter((c) => (c.hourly_rate_low ?? 0) < businessHourlyRate()).length} of{' '}
            {competitors.length} competitors tracked.
          </p>
        </div>
      )}

      {/* Add / Edit SlidePanel */}
      <SlidePanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        title={editingCompetitor ? `Edit — ${editingCompetitor.name}` : 'Add Competitor'}
        subtitle={editingCompetitor ? 'Update competitor details' : 'Add a new competitor'}
      >
        {/* Automatic lookup is quarantined until the outbound fetch boundary is hardened. */}
        {!editingCompetitor && (
          <PanelSection title="Verified facts only">
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Enter facts you verified directly. Automatic website lookup is disabled while its network and untrusted-content boundary is being rebuilt.
            </p>
          </PanelSection>
        )}

        <PanelSection title="Basic Info">
          <div className="space-y-3">
            <LabeledInput
              label="Studio Name *"
              value={form.name}
              onChange={updateField('name')}
              placeholder="e.g. KANVAS Studio"
            />
            <LabeledInput
              label="Location"
              value={form.location}
              onChange={updateField('location')}
              placeholder="e.g. Neighborhood, City, ST"
            />
            <LabeledInput
              label="Notes"
              value={form.notes}
              onChange={updateField('notes')}
              placeholder="Key differentiators, equipment, observations…"
            />
          </div>
        </PanelSection>

        <PanelSection title="Pricing & Size">
          <div className="grid grid-cols-2 gap-3">
            <LabeledInput
              label="Rate Low ($/hr)"
              value={form.hourly_rate_low}
              onChange={updateField('hourly_rate_low')}
              type="number"
              placeholder="85"
            />
            <LabeledInput
              label="Rate High ($/hr)"
              value={form.hourly_rate_high}
              onChange={updateField('hourly_rate_high')}
              type="number"
              placeholder="125"
            />
            <div className="col-span-2">
              <LabeledInput
                label="Size (sq ft)"
                value={form.size_sqft}
                onChange={updateField('size_sqft')}
                type="number"
                placeholder="1200"
              />
            </div>
          </div>
        </PanelSection>

        <PanelSection title="Links & Social">
          <div className="space-y-3">
            <LabeledInput
              label="Website URL"
              value={form.website_url}
              onChange={updateField('website_url')}
              placeholder="https://example.com"
            />
            <LabeledInput
              label="Instagram URL"
              value={form.instagram_url}
              onChange={updateField('instagram_url')}
              placeholder="https://instagram.com/handle"
            />
            <LabeledInput
              label="Facebook Page ID"
              value={form.facebook_page_id}
              onChange={updateField('facebook_page_id')}
              placeholder="1234567890"
            />
            <p className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              The Facebook Page ID is used to fetch competitor ads from the Meta Ad Library.
            </p>
          </div>
        </PanelSection>

        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPanelOpen(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving}
            className="bg-indigo-600 hover:bg-indigo-500 text-white"
          >
            {saving ? 'Saving…' : editingCompetitor ? 'Save Changes' : 'Add Competitor'}
          </Button>
        </div>
      </SlidePanel>
    </div>
  )
}
