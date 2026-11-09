'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Bookmark, Building2, Compass } from 'lucide-react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/ui/empty-state'
import { InspirationNote } from '@/components/ui/inspiration-note'
import { PageHeader } from '@/components/layout/PageHeader'
import { publicAdLibraryUrl } from '@/lib/competitors/snapshot-url'

interface CompetitorSource {
  id: string
  name: string
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
  ad_creative_bodies: string[] | null
  ad_snapshot_url: string | null
  page_name: string | null
  estimated_days_running: number | null
  impression_range: string | null
  is_active: boolean
  is_saved: boolean
  saved_at: string | null
  user_notes: string | null
  observed_attributes: ObservedAttributes | null
  created_at: string
  competitor_sources: CompetitorSource | null
}

function daysBadge(days: number | null) {
  if (days == null) return null
  if (days >= 30) {
    return (
      <span style={{
        background: 'var(--warning-bg)',
        border: '1px solid var(--warning-border)',
        color: 'var(--warning)',
        fontSize: '10px',
        fontWeight: 600,
        borderRadius: '4px',
        padding: '2px 6px',
        whiteSpace: 'nowrap',
      }}>
        🔥 30d+
      </span>
    )
  }
  if (days >= 14) {
    return (
      <span style={{
        background: 'var(--accent-dim)',
        border: '1px solid var(--border-focus)',
        color: 'var(--accent)',
        fontSize: '10px',
        fontWeight: 600,
        borderRadius: '4px',
        padding: '2px 6px',
        whiteSpace: 'nowrap',
      }}>
        Running {days}d
      </span>
    )
  }
  return (
    <span style={{
      background: 'var(--bg-subtle)',
      border: '1px solid var(--border)',
      color: 'var(--text-tertiary)',
      fontSize: '10px',
      fontWeight: 500,
      borderRadius: '4px',
      padding: '2px 6px',
      whiteSpace: 'nowrap',
    }}>
      New · {days}d
    </span>
  )
}

function AdCard({ ad, onSaveToggle }: { ad: CompetitorAd; onSaveToggle: (id: string, saved: boolean) => void }) {
  const [toggling, setToggling] = useState(false)
  const competitorName = ad.competitor_sources?.name ?? ad.page_name ?? 'Unknown'
  const body = ad.ad_creative_bodies?.[0]
  const adLibraryUrl = publicAdLibraryUrl(ad.ad_archive_id)

  async function handleSaveToggle() {
    setToggling(true)
    const nextSaved = !ad.is_saved
    onSaveToggle(ad.id, nextSaved)
    try {
      const res = await fetch(`/api/discovery/${ad.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_saved: nextSaved }),
      })
      if (!res.ok) {
        onSaveToggle(ad.id, ad.is_saved)
        toast.error('Failed to update saved state')
      } else {
        toast.success(nextSaved ? 'Ad saved to swipe file' : 'Removed from swipe file')
      }
    } catch {
      onSaveToggle(ad.id, ad.is_saved)
      toast.error('Network error')
    } finally {
      setToggling(false)
    }
  }

  return (
    <div className="owner-surface" style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: '10px',
      padding: '16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {competitorName}
        </span>
        {daysBadge(ad.estimated_days_running)}
      </div>

      {/* The snapshot URL is an HTML page that needs an access token, so it is never loaded here.
          The public Ad Library page needs no token. */}
      {adLibraryUrl && (
        <a href={adLibraryUrl} target="_blank" rel="noopener noreferrer"
          style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
          View in Meta Ad Library
        </a>
      )}

      {/* Ad body text */}
      {body && (
        <p style={{
          fontSize: '13px',
          color: 'var(--text-secondary)',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          lineHeight: '1.5',
          margin: 0,
        }}>
          {body}
        </p>
      )}

      {ad.observed_attributes?.angle && (
        <p style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', lineHeight: '1.5', margin: 0 }}>
          Observed angle: {ad.observed_attributes.angle}
        </p>
      )}

      {/* Metrics row */}
      {ad.impression_range && (
        <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', margin: 0 }}>
          {ad.impression_range} impressions
        </p>
      )}

      {/* Bottom actions */}
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 'auto' }}>
        <button
          onClick={handleSaveToggle}
          disabled={toggling}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            minHeight: '44px',
            padding: '0 10px',
            fontSize: '12px',
            fontWeight: 500,
            borderRadius: '6px',
            border: ad.is_saved
              ? '1px solid var(--border-focus)'
              : '1px solid var(--border)',
            background: ad.is_saved
              ? 'var(--accent-dim)'
              : 'var(--border)',
            color: ad.is_saved ? 'var(--accent)' : 'var(--text-secondary)',
            cursor: 'pointer',
          }}
        >
          <Bookmark
            style={{
              width: '12px',
              height: '12px',
              fill: ad.is_saved ? 'var(--accent)' : 'none',
            }}
          />
          {ad.is_saved ? 'Saved' : 'Save'}
        </button>

      </div>
    </div>
  )
}

function SkeletonGrid() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px' }}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: '10px',
            height: '220px',
            animation: 'pulse 1.5s ease-in-out infinite',
          }}
        />
      ))}
    </div>
  )
}

type Tab = 'feed' | 'saved'

export default function DiscoveryPage() {
  const [tab, setTab] = useState<Tab>('feed')
  const [feedAds, setFeedAds] = useState<CompetitorAd[]>([])
  const [savedAds, setSavedAds] = useState<CompetitorAd[]>([])
  const [feedLoading, setFeedLoading] = useState(true)
  const [savedLoading, setSavedLoading] = useState(true)

  const fetchFeed = useCallback(async () => {
    setFeedLoading(true)
    try {
      const res = await fetch('/api/discovery?limit=50', { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setFeedAds(data.ads ?? [])
      }
    } catch {
      // silent
    } finally {
      setFeedLoading(false)
    }
  }, [])

  const fetchSaved = useCallback(async () => {
    setSavedLoading(true)
    try {
      const res = await fetch('/api/discovery?saved=true&limit=200', { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setSavedAds(data.ads ?? [])
      }
    } catch {
      // silent
    } finally {
      setSavedLoading(false)
    }
  }, [])

  // Defer past the synchronous effect tick so the fetches' setState isn't synchronous-in-effect.
  useEffect(() => {
    let active = true
    void (async () => { await Promise.resolve(); if (active) await fetchFeed() })()
    return () => { active = false }
  }, [fetchFeed])
  useEffect(() => {
    let active = true
    void (async () => { await Promise.resolve(); if (active) await fetchSaved() })()
    return () => { active = false }
  }, [fetchSaved])

  function handleSaveToggle(adId: string, nextSaved: boolean) {
    // Optimistic update on both lists
    setFeedAds((prev) => prev.map((a) => a.id === adId ? { ...a, is_saved: nextSaved } : a))
    if (nextSaved) {
      const ad = feedAds.find((a) => a.id === adId)
      if (ad) {
        setSavedAds((prev) => {
          const exists = prev.some((a) => a.id === adId)
          return exists ? prev : [{ ...ad, is_saved: true }, ...prev]
        })
      }
    } else {
      setSavedAds((prev) => prev.filter((a) => a.id !== adId))
    }
  }

  const activeAds = tab === 'feed' ? feedAds : savedAds
  const isLoading = tab === 'feed' ? feedLoading : savedLoading

  return (
    <div className="owner-page">
      {/* Shared header — freshness + write-mode + Trust parity (audit #1/#2). */}
      <div className="owner-surface owner-surface-section">
        <PageHeader
          title="Intelligence workspace"
          icon={Compass}
          subtitle="Observed competitor ads and saved examples. Longevity and format frequency are context, not proof of performance."
        />
      </div>

      <div className="owner-tabs" aria-label="Intelligence workspace">
        <Link className="owner-tab" href="/competitors">Competitors</Link>
        <span className="owner-tab owner-tab-active">Ad discovery</span>
        <Link className="owner-tab" href="/signals">Expert signals</Link>
      </div>

      <InspirationNote />

      {/* Tab switcher */}
      <div className="owner-tabs">
        <button
          onClick={() => setTab('feed')}
          className={tab === 'feed' ? 'owner-tab owner-tab-active' : 'owner-tab'}
          style={{
            padding: '0 14px',
            fontSize: '13px',
            fontWeight: 500,
            borderRadius: '6px',
            border: 'none',
            cursor: 'pointer',
            background: tab === 'feed' ? 'var(--bg-surface)' : 'transparent',
            color: tab === 'feed' ? 'var(--text-primary)' : 'var(--text-secondary)',
            transition: 'all 0.15s',
          }}
        >
          Market Feed
        </button>
        <button
          onClick={() => setTab('saved')}
          className={tab === 'saved' ? 'owner-tab owner-tab-active' : 'owner-tab'}
          style={{
            padding: '0 14px',
            fontSize: '13px',
            fontWeight: 500,
            borderRadius: '6px',
            border: 'none',
            cursor: 'pointer',
            background: tab === 'saved' ? 'var(--bg-surface)' : 'transparent',
            color: tab === 'saved' ? 'var(--text-primary)' : 'var(--text-secondary)',
            transition: 'all 0.15s',
          }}
        >
          Saved Ads
          {savedAds.length > 0 && (
            <span style={{
              marginLeft: '6px',
              background: 'var(--accent-dim)',
              color: 'var(--accent)',
              fontSize: '10px',
              fontWeight: 600,
              borderRadius: '10px',
              padding: '1px 6px',
            }}>
              {savedAds.length}
            </span>
          )}
        </button>
      </div>

      {/* Content */}
      {isLoading ? (
        <SkeletonGrid />
      ) : activeAds.length === 0 ? (
        tab === 'feed' ? (
          <EmptyState
            icon={Building2}
            title="No competitor ads tracked yet"
            description="Add competitor Facebook Page IDs in Competitors to start tracking"
          />
        ) : (
          <EmptyState
            icon={Bookmark}
            title="No saved ads"
            description="Save ads from the Market Feed to build your swipe file"
          />
        )
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px' }}>
          {activeAds.map((ad) => (
            <AdCard key={ad.id} ad={ad} onSaveToggle={handleSaveToggle} />
          ))}
        </div>
      )}
    </div>
  )
}
