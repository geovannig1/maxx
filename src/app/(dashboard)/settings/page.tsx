'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { DataSourceHealth } from '@/components/settings/DataSourceHealth'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/empty-state'
import { toast } from 'sonner'
import Link from 'next/link'
import { Settings, SlidersHorizontal, ChevronRight } from 'lucide-react'

interface AppSetting {
  id: string
  key: string
  value: string
  setting_type: string
  label: string | null
  description: string | null
}

const BOOLEAN_KEYS = new Set(['read_only_mode', 'weekly_auto_sync', 'competitor_tracking_enabled', 'expert_tracker_enabled'])

// Settings that must NOT be exposed as casual UI toggles. `approved_write_mode` was a decorative
// toggle that nothing honored (live writes are gated ONLY by the WRITE_MODE_ENABLED server env var),
// so showing it falsely implied writes were "armed." Hide it; the real state is shown read-only below.
const HIDDEN_KEYS = new Set([
  'target_cpa',
  'avg_order_value',
  'main_conversion_event',
  'pixel_id',
  'read_only_mode',
  'weekly_auto_sync',
  'brand_tone',
  'instagram_handle',
  'competitor_tracking_enabled',
  'expert_tracker_enabled',
  'approved_write_mode',
  'performance_targets',
  'economics_inputs',
  'appointment_conversion_id',
])

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <p className="section-label">{title}</p>
      {children}
    </section>
  )
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSetting[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [quarantinedCount, setQuarantinedCount] = useState(0)
  const [edits, setEdits] = useState<Record<string, string>>({})

  async function load() {
    const res = await fetch('/api/settings', { cache: 'no-store' })
    if (res.ok) {
      const data = await res.json() as { settings?: AppSetting[]; quarantined_settings?: unknown[] }
      setSettings(data.settings ?? [])
      setQuarantinedCount(data.quarantined_settings?.length ?? 0)
    }
    setLoading(false)
  }

  useEffect(() => {
    let active = true
    void (async () => {
      const res = await fetch('/api/settings', { cache: 'no-store' })
      if (!active) return
      if (res.ok) {
        const data = await res.json() as { settings?: AppSetting[]; quarantined_settings?: unknown[] }
        setSettings(data.settings ?? [])
        setQuarantinedCount(data.quarantined_settings?.length ?? 0)
      }
      setLoading(false)
    })()
    return () => { active = false }
  }, [])

  async function handleSave(key: string, value: string) {
    setSaving(key)
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    })
    if (res.ok) {
      toast.success('Saved')
      setEdits((e) => { const n = { ...e }; delete n[key]; return n })
      load()
    } else {
      const data = await res.json() as { error?: string }
      toast.error(data.error ?? 'Save failed')
    }
    setSaving(null)
  }

  const getValue = (s: AppSetting) => edits[s.key] ?? s.value

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Shared header — freshness + write-mode + Trust parity (audit #1/#2). */}
      <PageHeader
        title="Settings"
        icon={Settings}
        subtitle="Governed configuration, data connections, and safety for Example Studio."
      />

      <SettingsGroup title="Sources">
        {/* Data Sources / System Health — read-only snapshot of every connection. */}
        <DataSourceHealth />
        <p className="text-sm">
          <Link href="/settings/outcomes" className="underline">Outcome sources</Link> (enable or disable each one)
          {' · '}<Link href="/setup" className="underline">Setup checklist</Link> (what is missing, with a connection test)
        </p>
      </SettingsGroup>

      <SettingsGroup title="Safety">
        {/* Safety — write mode is a server-env switch, deliberately not editable in the UI. */}
        <div className="card-elevated p-4">
          <p className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Write mode is controlled by the <code>WRITE_MODE_ENABLED</code> server environment variable</strong> and cannot be toggled here. While it is off, Maxx can propose changes but nothing executes on Meta — approvals are recorded only. The live state is shown on the Dashboard and the Changes page.
          </p>
        </div>
      </SettingsGroup>

      {quarantinedCount > 0 && (
        <div className="card-elevated p-4">
          <p className="section-label mb-2">Legacy settings withheld</p>
          <p className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
            {quarantinedCount} unversioned policy, economics, tracking, or write-control setting{quarantinedCount === 1 ? ' is' : 's are'} preserved in storage but not editable here. Use the dedicated governed surfaces; Maxx must not treat these legacy rows as current authority.
          </p>
        </div>
      )}

      <SettingsGroup title="Targets">
        {/* Performance Targets editor — the configurable band thresholds + data gates. */}
        <Link
          href="/settings/targets"
          className="card-base flex items-center gap-3 p-4 transition-colors hover:bg-[var(--border)]"
        >
          <span className="flex items-center justify-center rounded-lg shrink-0" style={{ width: 36, height: 36, background: 'var(--accent-dim)', border: '1px solid var(--border-focus)' }}>
            <SlidersHorizontal className="w-4 h-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Performance Targets</p>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Edit the Healthy / Watch / Critical bands &amp; min-data gates for every metric.</p>
          </div>
          <ChevronRight className="w-4 h-4 shrink-0" style={{ color: 'var(--text-tertiary)' }} />
        </Link>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-lg" style={{ background: 'var(--bg-elevated)' }} />
            ))}
          </div>
        ) : settings.length === 0 ? (
          <div className="card-base">
            <EmptyState
              icon={Settings}
              title="No editable general settings"
              description="Commercial targets, economics, tracking, and write controls require their dedicated governed surfaces. Maxx will leave missing values unknown instead of seeding assumptions."
            />
          </div>
        ) : (
          <div className="space-y-1.5">
            {settings.filter((s) => !HIDDEN_KEYS.has(s.key)).map((s) => {
              const isBool = BOOLEAN_KEYS.has(s.key)
              const currentVal = getValue(s)
              const isDirty = edits[s.key] !== undefined

              return (
                <div key={s.key}
                  className="flex items-center gap-4 rounded-[var(--r-lg)] px-4 py-3"
                  style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{s.label ?? s.key}</p>
                    {s.description && (
                      <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{s.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {isBool ? (
                      <button
                        onClick={() => handleSave(s.key, currentVal === 'true' ? 'false' : 'true')}
                        disabled={saving === s.key}
                        className="w-10 h-5 rounded-full transition-colors relative"
                        style={{ background: currentVal === 'true' ? 'var(--accent)' : 'var(--bg-overlay)' }}
                      >
                        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${currentVal === 'true' ? 'left-5' : 'left-0.5'}`} />
                      </button>
                    ) : (
                      <>
                        <Input
                          value={currentVal}
                          onChange={(e) => setEdits((prev) => ({ ...prev, [s.key]: e.target.value }))}
                          className="w-40 h-8 text-xs"
                          style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                        />
                        {isDirty && (
                          <Button size="sm" onClick={() => handleSave(s.key, currentVal)}
                            disabled={saving === s.key}
                            className="h-8 text-xs" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
                            {saving === s.key ? '…' : 'Save'}
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="Admin">
        <details className="card-elevated p-4 space-y-1">
          <summary className="text-[12px] font-semibold cursor-pointer" style={{ color: 'var(--text-primary)' }}>
            Admin seed actions
          </summary>
          <p className="text-[12px] mt-2" style={{ color: 'var(--text-tertiary)' }}>These actions write setup data. Keep them collapsed so they stay out of the casual owner flow.</p>
          <div className="flex flex-wrap gap-2 mt-2">
            {[
              { label: 'Seed Competitors', url: '/api/competitors/seed' },
              { label: 'Seed Expert Sources', url: '/api/signals/seed' },
            ].map(({ label, url }) => (
              <Button key={url} size="sm" variant="outline"
                onClick={async () => {
                  const res = await fetch(url, { method: 'POST' })
                  const data = await res.json() as { message?: string; error?: string }
                  toast[res.ok ? 'success' : 'error'](data.message ?? data.error ?? 'Done')
                }}
                className="h-7 text-xs"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                {label}
              </Button>
            ))}
          </div>
        </details>
      </SettingsGroup>
    </div>
  )
}
